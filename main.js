import './style.css';
import L from 'leaflet';
window.L = L;
import 'leaflet-velocity/dist/leaflet-velocity.css';
import 'leaflet-velocity/dist/leaflet-velocity.js';
import { jsPDF } from 'jspdf';

// === CONFIGURATION ===
const MAP_CENTER = [22.0, 79.0]; // Center of India
const MAP_ZOOM = 5;
const MAX_FORECAST_HOURS = 72;

// India bounds (+ adjacent seas)
const bounds = L.latLngBounds(
  L.latLng(5.0, 65.0),
  L.latLng(38.0, 100.0)
);

// State
let weatherData = null; // Holds the fetched grid data
let currentParam = 'wind'; // wind, rain, temperature
let currentWindLevel = '10m'; // 10m, 925hPa, 850hPa, 700hPa, 500hPa, 200hPa
let currentModel = 'best_match';
let currentHourOffset = 0;
let userLocation = null;
let selectedLocation = null;

let markersLayer = L.layerGroup();
let velocityLayer = null;
let map;

// Generate ~100 grid points for visualization (within Open-Meteo limits)
const gridPoints = [];
const lats = [35, 32, 29, 26, 23, 20, 17, 14, 11, 8];
const lons = [68, 71, 74, 77, 80, 83, 86, 89, 92, 95];

for (let lat of lats) {
  for (let lon of lons) {
    gridPoints.push({ lat, lon });
  }
}

// === INITIALIZATION ===
document.addEventListener('DOMContentLoaded', () => {
  addLoader();
  initMap();
  setupEventListeners();
  fetchWeatherData().then(() => {
    updateMap();
    removeLoader();
    requestUserLocation();
  });
});

function addLoader() {
  const loader = document.createElement('div');
  loader.className = 'loader-overlay';
  loader.id = 'loader';
  loader.innerHTML = `
    <div class="spinner"></div>
    <p>Fetching Meteorological Data...</p>
  `;
  document.body.appendChild(loader);
}

function removeLoader() {
  const loader = document.getElementById('loader');
  if (loader) {
    loader.classList.add('hidden');
    setTimeout(() => loader.remove(), 500);
  }
}

function initMap() {
  map = L.map('map', {
    center: MAP_CENTER,
    zoom: MAP_ZOOM,
    maxBounds: bounds,
    maxBoundsViscosity: 1.0,
    minZoom: 4
  });

  // OpenStreetMap Base Layer
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  markersLayer.addTo(map);
}

// Helper to get correct API endpoint
function getApiUrl(lats, lons, model) {
  const params = `latitude=${lats}&longitude=${lons}&hourly=temperature_2m,precipitation,windspeed_10m,windspeed_925hPa,windspeed_850hPa,windspeed_700hPa,windspeed_500hPa,windspeed_200hPa,winddirection_10m,winddirection_925hPa,winddirection_850hPa,winddirection_700hPa,winddirection_500hPa,winddirection_200hPa&forecast_days=4&timezone=Asia%2FKolkata`;
  
  if (model === 'ecmwf_ifs04') {
    return `https://api.open-meteo.com/v1/ecmwf?${params}`;
  }
  return `https://api.open-meteo.com/v1/forecast?${params}&models=${model}`;
}

// === DATA FETCHING ===
async function fetchWeatherData() {
  const lats = gridPoints.map(p => p.lat).join(',');
  const lons = gridPoints.map(p => p.lon).join(',');
  
  const url = getApiUrl(lats, lons, currentModel);
  
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("API Error");
    weatherData = await response.json();
    
    // Some responses might return a single object if only 1 coordinate was asked,
    // but with multiple, it returns an array.
    if (!Array.isArray(weatherData)) {
       weatherData = [weatherData];
    }
  } catch (error) {
    console.error("Failed to fetch weather data:", error);
    alert("Failed to load weather data. Please try again later.");
  }
}

// Fetch for a specific point (Search or Geolocation)
async function fetchPointData(lat, lon, name = "Selected Location") {
  const url = getApiUrl(lat, lon, currentModel);
  try {
    const response = await fetch(url);
    const data = await response.json();
    
    selectedLocation = { lat, lon, name, data };
    
    updateSnapshotPanel();
    document.getElementById('get-report-btn').disabled = false;
    
    // Add marker
    L.marker([lat, lon]).addTo(map)
      .bindPopup(`<b>${name}</b><br>Click 'Get 3-Day Report' for details.`)
      .openPopup();
      
    map.flyTo([lat, lon], 8);
  } catch (err) {
    console.error("Point fetch error:", err);
  }
}

// === MAP VISUALIZATION ===
function updateMap() {
  markersLayer.clearLayers();
  if (velocityLayer) {
    map.removeLayer(velocityLayer);
    velocityLayer = null;
  }
  
  if (!weatherData) return;
  
  updateTimelineLabel();
  updateLegend();

  if (currentParam === 'wind') {
    const uData = [];
    const vData = [];

    weatherData.forEach((pointData) => {
      if(!pointData || !pointData.hourly) {
        uData.push(0);
        vData.push(0);
        return;
      }
      const speedKey = `windspeed_${currentWindLevel}`;
      const dirKey = `winddirection_${currentWindLevel}`;
      
      let speedMs = 0;
      let dirDeg = 0;
      if (pointData.hourly[speedKey] && pointData.hourly[speedKey][currentHourOffset] != null) {
        speedMs = pointData.hourly[speedKey][currentHourOffset] / 3.6;
      }
      if (pointData.hourly[dirKey] && pointData.hourly[dirKey][currentHourOffset] != null) {
        dirDeg = pointData.hourly[dirKey][currentHourOffset];
      }
      
      const rad = (dirDeg * Math.PI) / 180;
      uData.push(-speedMs * Math.sin(rad));
      vData.push(-speedMs * Math.cos(rad));
    });
    
    // Check if we have valid wind data (to avoid Leaflet-Velocity crashing on all-zeros)
    const hasValidWind = uData.some(val => val !== 0) || vData.some(val => val !== 0);
    if (!hasValidWind) {
      document.getElementById('legend').innerHTML = `<div class="legend-title" style="color: #fca5a5;">Wind data not available for ${currentWindLevel} in selected model</div>`;
      return;
    }

    const windData = [
      {
        header: {
          parameterCategory: 2, parameterNumber: 2,
          nx: 10, ny: 10,
          lo1: 68, la1: 35,
          lo2: 95, la2: 8,
          dx: 3, dy: 3
        },
        data: uData
      },
      {
        header: {
          parameterCategory: 2, parameterNumber: 3,
          nx: 10, ny: 10,
          lo1: 68, la1: 35,
          lo2: 95, la2: 8,
          dx: 3, dy: 3
        },
        data: vData
      }
    ];

    const currentZoom = map.getZoom();
    let pMultiplier, vScale, pAge;

    if (currentZoom <= 5) {
      // Zoomed out (country level): very sparse, longer trails
      pMultiplier = 1 / 8000;
      vScale = 0.015;
      pAge = 40;
    } else if (currentZoom <= 7) {
      // Mid zoom (state level): medium density
      pMultiplier = 1 / 4000;
      vScale = 0.01;
      pAge = 60;
    } else {
      // Zoomed in (city level): high density, shorter trails
      pMultiplier = 1 / 2000;
      vScale = 0.008;
      pAge = 80;
    }

    velocityLayer = L.velocityLayer({
      displayValues: true,
      displayOptions: {
        velocityType: 'Wind',
        displayPosition: 'bottomleft',
        displayEmptyString: 'No wind data'
      },
      data: windData,
      maxVelocity: 15,
      velocityScale: vScale,
      particleMultiplier: pMultiplier,
      lineWidth: 3, // Thicker lines for maximum visibility
      particleAge: pAge,
      // Pure white color for maximum visibility as requested
      colorScale: ['#ffffff']
    });
    
    velocityLayer.addTo(map);
  } else {
    weatherData.forEach((pointData, i) => {
      // If API failed for a specific point, it might be null
      if(!pointData || !pointData.hourly) return;
      
      const lat = gridPoints[i].lat;
      const lon = gridPoints[i].lon;
      
      const valTemp = pointData.hourly.temperature_2m[currentHourOffset];
      const valRain = pointData.hourly.precipitation[currentHourOffset];
      
      let html = '';
      let color = '';
      
      if (currentParam === 'temperature') {
        color = getTempColor(valTemp);
        html = `<div class="weather-marker temp-marker" style="width: 34px; height: 34px; background: linear-gradient(135deg, ${color}, #00000066); --glow-color: ${color}; box-shadow: 0 0 15px ${color}">
                  <span style="z-index: 2; position: relative; text-shadow: 0 1px 2px rgba(0,0,0,0.8);">${Math.round(valTemp)}°</span>
                  <div class="temp-pulse"></div>
                </div>`;
      } else if (currentParam === 'rain') {
        if (valRain > 0) {
          color = getRainColor(valRain);
          const size = Math.min(30 + valRain * 2, 50);
          const rainDur = Math.max(0.4, 2 / (valRain + 0.1)).toFixed(2);
          html = `<div class="weather-marker rain-marker" style="width: ${size}px; height: ${size}px; border-color: ${color}; --drop-color: ${color}; box-shadow: 0 0 15px ${color}">
                    <div class="rain-drop" style="left: 30%; --duration: ${rainDur}s; animation-delay: 0s;"></div>
                    <div class="rain-drop" style="left: 50%; --duration: ${rainDur}s; animation-delay: ${rainDur * 0.3}s;"></div>
                    <div class="rain-drop" style="left: 70%; --duration: ${rainDur}s; animation-delay: ${rainDur * 0.6}s;"></div>
                    <span style="z-index: 2; position: relative; text-shadow: 0 1px 3px #000;">${valRain.toFixed(1)}</span>
                  </div>`;
        }
      }
      
      if (html) {
        // Determine size for anchoring
        let markerWidth = 30;
        let markerHeight = 30;
        
        if (currentParam === 'rain') {
          markerWidth = Math.min(30 + valRain * 2, 50);
          markerHeight = markerWidth;
        } else if (currentParam === 'temperature') {
          markerWidth = 34; markerHeight = 34;
        }

        const icon = L.divIcon({
          className: 'custom-div-icon',
          html: html,
          iconSize: [markerWidth, markerHeight],
          iconAnchor: [markerWidth / 2, markerHeight / 2]
        });
        
        const marker = L.marker([lat, lon], { icon }).addTo(markersLayer);
        
        // Tooltip
        marker.bindTooltip(`
          <div class="custom-tooltip">
            <h4>Coordinates: ${lat}°, ${lon}°</h4>
            <p>🌡️ Temp: ${valTemp}°C</p>
            <p>🌧️ Rain: ${valRain} mm</p>
          </div>
        `);
      }
    });
  }
}

// === COLOR SCALES ===
function getTempColor(temp) {
  if (temp < 10) return '#3b82f6'; // Blue
  if (temp < 20) return '#10b981'; // Green
  if (temp < 30) return '#f59e0b'; // Orange
  return '#ef4444'; // Red
}

function getRainColor(rain) {
  if (rain < 1) return '#93c5fd';
  if (rain < 5) return '#3b82f6';
  if (rain < 10) return '#2563eb';
  return '#1e3a8a';
}

function getWindColor(speed) {
  if (speed < 2) return '#a7f3d0';
  if (speed < 5) return '#34d399';
  if (speed < 10) return '#fbbf24';
  if (speed < 15) return '#f87171';
  return '#b91c1c';
}

function updateLegend() {
  const legend = document.getElementById('legend');
  if (currentParam === 'temperature') {
    legend.innerHTML = `
      <div class="legend-title">Temperature (°C)</div>
      <div class="legend-bar" style="background: linear-gradient(to right, #3b82f6, #10b981, #f59e0b, #ef4444)"></div>
      <div class="legend-labels"><span>< 10°</span><span>20°</span><span>30°</span><span>40°+</span></div>
    `;
  } else if (currentParam === 'rain') {
    legend.innerHTML = `
      <div class="legend-title">Rainfall (mm)</div>
      <div class="legend-bar" style="background: linear-gradient(to right, #93c5fd, #3b82f6, #2563eb, #1e3a8a)"></div>
      <div class="legend-labels"><span>Light</span><span>Moderate</span><span>Heavy</span></div>
    `;
  } else if (currentParam === 'wind') {
    legend.innerHTML = `
      <div class="legend-title">Wind Speed (m/s)</div>
      <div class="legend-bar" style="background: linear-gradient(to right, #a7f3d0, #34d399, #fbbf24, #f87171, #b91c1c)"></div>
      <div class="legend-labels"><span>Calm</span><span>Breeze</span><span>Strong</span><span>Gale</span></div>
    `;
  }
}

// === INTERACTIVITY ===
function setupEventListeners() {
  // Parameters
  document.querySelectorAll('.radio-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.radio-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentParam = e.target.dataset.param;
      
      const windLevelGroup = document.getElementById('wind-level-group');
      if (currentParam === 'wind') {
        windLevelGroup.style.display = 'block';
      } else {
        windLevelGroup.style.display = 'none';
      }
      
      updateMap();
    });
  });

  // Wind Level Selector
  document.getElementById('wind-level-selector').addEventListener('change', (e) => {
    currentWindLevel = e.target.value;
    if (currentParam === 'wind') {
      updateMap();
    }
    if (selectedLocation) updateSnapshotPanel();
  });

  // Model Selector
  document.getElementById('model-selector').addEventListener('change', (e) => {
    currentModel = e.target.value;
    addLoader();
    fetchWeatherData().then(() => {
      if(selectedLocation) {
        fetchPointData(selectedLocation.lat, selectedLocation.lon, selectedLocation.name).then(() => {
          updateMap();
          removeLoader();
        });
      } else {
        updateMap();
        removeLoader();
      }
    });
  });

  // Timeline Slider
  const slider = document.getElementById('time-slider');
  slider.addEventListener('input', (e) => {
    currentHourOffset = parseInt(e.target.value);
    updateMap();
    if(selectedLocation) updateSnapshotPanel();
  });

  // Search
  const searchInput = document.getElementById('location-search');
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();
    if (query.length < 3) {
      document.getElementById('search-results').classList.add('hidden');
      return;
    }
    
    // Debounce nominatim
    searchTimeout = setTimeout(() => {
      fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=in&limit=5`)
        .then(res => res.json())
        .then(data => {
          const ul = document.getElementById('search-results');
          ul.innerHTML = '';
          if (data.length > 0) {
            data.forEach(item => {
              const li = document.createElement('li');
              li.textContent = item.display_name;
              li.addEventListener('click', () => {
                searchInput.value = item.display_name.split(',')[0];
                ul.classList.add('hidden');
                fetchPointData(item.lat, item.lon, searchInput.value);
              });
              ul.appendChild(li);
            });
            ul.classList.remove('hidden');
          } else {
            ul.classList.add('hidden');
          }
        });
    }, 500);
  });
  
  // Close dropdown on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
      document.getElementById('search-results').classList.add('hidden');
    }
  });

  // Generate Report
  document.getElementById('get-report-btn').addEventListener('click', generateReport);

  // Redraw wind layer on zoom to dynamically adjust density
  map.on('zoomend', () => {
    if (currentParam === 'wind') {
      updateMap();
    }
  });
}

function updateTimelineLabel() {
  if (!weatherData || !weatherData[0] || !weatherData[0].hourly) return;
  const timeStr = weatherData[0].hourly.time[currentHourOffset];
  const date = new Date(timeStr);
  const options = { weekday: 'long', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  document.getElementById('current-time-display').textContent = date.toLocaleDateString('en-IN', options);
}

// === GEOLOCATION & SNAPSHOT ===
function requestUserLocation() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        fetchPointData(lat, lon, "Your Location");
      },
      (error) => {
        console.warn("Geolocation denied or failed.", error);
        // Default fallback provided by bounds/center
      }
    );
  }
}

function updateSnapshotPanel() {
  if (!selectedLocation) return;
  const panel = document.getElementById('snapshot-panel');
  const d = selectedLocation.data;
  if (!d || !d.hourly) return;
  
  const valTemp = d.hourly.temperature_2m[currentHourOffset];
  const valRain = d.hourly.precipitation[currentHourOffset];
  const speedKey = `windspeed_${currentWindLevel}`;
  let valWind = "--";
  if (d.hourly[speedKey] && d.hourly[speedKey][currentHourOffset] != null) {
    valWind = (d.hourly[speedKey][currentHourOffset] / 3.6).toFixed(1);
  }
  
  document.getElementById('snapshot-location').textContent = selectedLocation.name;
  document.getElementById('snap-temp').textContent = Math.round(valTemp) + '°C';
  document.getElementById('snap-wind').textContent = valWind !== "--" ? valWind + ' m/s' : '-- m/s';
  document.getElementById('snap-rain').textContent = valRain.toFixed(1) + ' mm';
  
  panel.classList.remove('hidden');
}

// === 3-DAY REPORT GENERATION ===
function generateReport() {
  if (!selectedLocation || !selectedLocation.data) return;
  
  const d = selectedLocation.data.hourly;
  const doc = new jsPDF();
  
  doc.setFontSize(22);
  doc.setTextColor(30, 64, 175);
  doc.text("IndiaWx - 3-Day Forecast Report", 20, 20);
  
  doc.setFontSize(14);
  doc.setTextColor(0, 0, 0);
  doc.text(`Location: ${selectedLocation.name}`, 20, 30);
  doc.text(`Coordinates: ${parseFloat(selectedLocation.lat).toFixed(4)}°, ${parseFloat(selectedLocation.lon).toFixed(4)}°`, 20, 38);
  doc.text(`Generated on: ${new Date().toLocaleString('en-IN')}`, 20, 46);
  doc.text(`Model Used: ${currentModel.toUpperCase()}`, 20, 54);
  
  doc.line(20, 60, 190, 60);
  
  let y = 70;
  
  // Generate 3 days of summary
  for(let day=0; day<3; day++) {
    const baseIndex = day * 24;
    
    // We sample morning (08:00), afternoon (14:00), night (20:00)
    // Assuming data starts at 00:00 of current day. We find the index for 08:00.
    const timeStr = d.time[baseIndex];
    const dateObj = new Date(timeStr);
    const dayName = dateObj.toLocaleDateString('en-IN', { weekday: 'long', month: 'short', day: 'numeric' });
    
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(dayName, 20, y);
    y += 8;
    
    doc.setFontSize(11);
    doc.setFont("helvetica", "normal");
    
    const times = [
      { label: 'Morning', offset: 8 },
      { label: 'Afternoon', offset: 14 },
      { label: 'Night', offset: 20 }
    ];
    
    times.forEach(t => {
      const idx = baseIndex + t.offset;
      if(idx >= d.temperature_2m.length) return;
      
      const temp = Math.round(d.temperature_2m[idx]);
      const rain = d.precipitation[idx];
      const speedKey = `windspeed_${currentWindLevel}`;
      
      let windText = "Wind data N/A.";
      if (d[speedKey] && d[speedKey][idx] != null) {
        const wind = (d[speedKey][idx] / 3.6).toFixed(1);
        windText = `Winds around ${wind} m/s at ${currentWindLevel}.`;
      }
      
      let rainText = rain > 0 ? `Expect ${rain} mm of rain.` : "Dry conditions.";
      
      doc.text(`${t.label}: Temp ${temp}°C. ${rainText} ${windText}`, 25, y);
      y += 7;
    });
    
    y += 5; // spacing between days
  }
  
  // Footer
  doc.setFontSize(9);
  doc.setTextColor(150, 150, 150);
  doc.text("Data provided by Open-Meteo | IndiaWx v1", 20, 280);
  
  doc.save(`IndiaWx_Forecast_${selectedLocation.name.replace(/\s+/g, '_')}.pdf`);
}
