// ============================================================
// MAIN APPLICATION SCRIPT (main.js) - SERVER VERSION
// ============================================================

// --- INITIALIZATION ---
const messageBox = document.getElementById('messageBox');
let allCalculatedPaths = {};
let currentPath = [];
let animationPath = null;
let currentLiveEnvData = null;
let gaPredictionTimer = null;
let currentGridInfo = null;
const GA_PREDICTION_INTERVAL_MS = 10000;

// --- STATE MANAGEMENT ---
let navigationState = 'SET_START';
let startPoint = null;
let endPoint = null;
let startMarker = null;
let endMarker = null;
let boatAnimator = null;
let gridLayer = L.layerGroup();
let isGridVisible = false;
let gridDataCache = null;
let editMode = false;
let isDrawing = false;
let drawMode = 'draw';
let routeLayer = L.layerGroup();
let criticalPointsLayer = L.layerGroup();
let heatLayer = null;
let isHeatmapVisible = false;
let portData = [];
let useCustomGrid = false;
let temporaryGrid = null;

let pathTooltip = null;
let routePolylines = {}; // Object to hold references to the route polylines

const loadingOverlay = document.getElementById('loading-overlay');
function showLoadingIndicator() { if (loadingOverlay) loadingOverlay.classList.remove('hidden'); }
function hideLoadingIndicator() { if (loadingOverlay) loadingOverlay.classList.add('hidden'); }

function sanitizePath(path) {
    if (!Array.isArray(path)) return [];
    const reconstructedPath = [];
    for (const p of path) {
        if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
            reconstructedPath.push({
                lat: p.lat,
                lng: p.lng,
                onLand: p.onLand,
                totalFuel: p.totalFuel,
                env: p.env
            });
        }
    }
    if (reconstructedPath.length < path.length) {
        console.warn(`CLIENT SANITIZER: Rebuilt path and removed ${path.length - reconstructedPath.length} invalid point(s).`);
    }
    return reconstructedPath;
}


// --- Ship Type Presets ---
const shipTypeDefaults = {
    fishing_trawler: { shipLength:35 ,beam:8 , baseWeight: 1500, load: 500, speed: 10, draft: 5, hpReq: 2000, fuelRate: 0.22 },
    handysize_bulk: { shipLength:130 ,beam:20 , baseWeight: 20000, load: 35000, speed: 14, draft: 10, hpReq: 8000, fuelRate: 0.20 },
    panamax_container: { shipLength:280 ,beam:30 ,baseWeight: 40000, load: 50000, speed: 20, draft: 12, hpReq: 40000, fuelRate: 0.19 },
    aframax_tanker: { shipLength:200 ,beam:30 , baseWeight: 55000, load: 100000, speed: 15, draft: 14, hpReq: 18000, fuelRate: 0.18 },
    vlcc_tanker: { shipLength:300 ,beam:58 ,baseWeight: 120000, load: 300000, speed: 16, draft: 20, hpReq: 30000, fuelRate: 0.18 },
    cruise_ship: { shipLength:365 ,beam:65 , baseWeight: 100000, load: 20000, speed: 22, draft: 8, hpReq: 90000, fuelRate: 0.21 }
};

// --- MAP SETUP ---
const map = L.map('map', { center: [1.3521, 103.8198], zoom: 7, zoomControl: false, doubleClickZoom: false });
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd', maxZoom: 20
}).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

// --- APPLICATION INITIALIZATION ---
function initializeApp() {
    showMessage('Map ready. Use the search or double-click to set a route.', 'green');
    routeLayer.addTo(map);
    criticalPointsLayer.addTo(map);
    boatAnimator = new BoatAnimator(map);

    // --- Event Listeners ---
    map.on('dblclick', onMapClick);
    document.getElementById('demo-route-button').addEventListener('click', setDemoRoute);
    document.getElementById('routingStrategy').addEventListener('change', updateMetricsForSelectedStrategy);
    document.getElementById('shipType').addEventListener('change', updateShipParameters);

    // RESTORED: Grid editing event listeners
    map.on('moveend zoomend', () => { if (isGridVisible) drawGrid(); });
    map.on('mousedown', (e) => { if (editMode) { isDrawing = true; drawMode = (e.originalEvent.button === 0) ? 'draw' : 'erase'; editGridCell(e); } });
    map.on('mousemove', (e) => { if (editMode && isDrawing) editGridCell(e); });
    window.addEventListener('mouseup', () => { isDrawing = false; });
    map.on('contextmenu', (e) => { if (editMode) L.DomEvent.preventDefault(e); });
    document.addEventListener('keydown', (e) => { if (e.code === 'Space' && editMode) { map.dragging.enable(); L.DomUtil.addClass(map._container, 'pan-cursor'); } });
    document.addEventListener('keyup', (e) => { if (e.code === 'Space' && editMode) { map.dragging.disable(); L.DomUtil.removeClass(map._container, 'pan-cursor'); } });


    // --- Other Initializations ---
    updateShipParameters();
    loadPortData();
    setupSearchListeners();
    initializeTooltips();

    // Set today's date
    const voyageDateInput = document.getElementById('voyageDate');
    if (voyageDateInput) {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        voyageDateInput.value = `${yyyy}-${mm}-${dd}`;
    }
}

function loadPortData(){fetch('/api/ports').then(response=>{if(!response.ok)throw new Error('Failed to load port data');return response.json()}).then(data=>{portData=data;const portsList=document.getElementById('ports-list');if(portsList){portsList.innerHTML=portData.map(port=>`<option value="${port.name}"></option>`).join('')}showMessage('Port data loaded.','green')}).catch(error=>{console.error('Error fetching port data:',error);showMessage('Could not load port data from server.','red')})}
function setupSearchListeners(){const startInput=document.getElementById('startPort');const endInput=document.getElementById('endPort');const handleSelection=()=>{resetNavigation(false);const startValue=startInput.value;const endValue=endInput.value;const startPort=portData.find(p=>p.name===startValue);const endPort=portData.find(p=>p.name===endValue);if(startMarker)map.removeLayer(startMarker);if(endMarker)map.removeLayer(endMarker);if(startPort){startPoint=L.latLng(startPort.lat,startPort.lng);startMarker=L.circleMarker(startPoint,{color:'#10b981',radius:8,fillOpacity:0.8}).addTo(map)}if(endPort){endPoint=L.latLng(endPort.lat,endPort.lng);endMarker=L.circleMarker(endPoint,{color:'#ef4444',radius:8,fillOpacity:0.8}).addTo(map)}if(startPort&&endPort){const bounds=L.latLngBounds([startPoint,endPoint]);map.fitBounds(bounds.pad(0.2));calculateAndFetchRoute(startPoint,endPoint)}};startInput.addEventListener('change',handleSelection);endInput.addEventListener('change',handleSelection)}
function updateShipParameters(){const selectedType=document.getElementById('shipType').value;const defaults=shipTypeDefaults[selectedType];if(defaults){document.getElementById('shipLength').value=defaults.shipLength; document.getElementById('beam').value=defaults.beam;document.getElementById('baseWeight').value=defaults.baseWeight;document.getElementById('load').value=defaults.load;document.getElementById('shipSpeed').value=defaults.speed;document.getElementById('shipDraft').value=defaults.draft;document.getElementById('hpReq').value=defaults.hpReq;document.getElementById('fuelRate').value=defaults.fuelRate}}

function setDemoRoute() {
    resetNavigation(false);
    const demoStart = { lat: 1.290270, lng: 103.851959 };
    const demoEnd = { lat: -6.208763, lng: 106.845599 };
    startPoint = L.latLng(demoStart.lat, demoStart.lng);
    endPoint = L.latLng(demoEnd.lat, demoEnd.lng);
    startMarker = L.circleMarker(startPoint, { color: '#10b981', radius: 8, fillOpacity: 0.8 }).addTo(map);
    endMarker = L.circleMarker(endPoint, { color: '#ef4444', radius: 8, fillOpacity: 0.8 }).addTo(map);
    document.getElementById('startPort').value = 'Singapore';
    document.getElementById('endPort').value = 'Jakarta, Indonesia';
    const bounds = L.latLngBounds([startPoint, endPoint]);
    map.fitBounds(bounds.pad(0.2));
    calculateAndFetchRoute(startPoint, endPoint);
}

function calculateAndFetchRoute(start, end) {
    if (boatAnimator) boatAnimator.stopAnimation();
    showLoadingIndicator();
    navigationState = 'CALCULATING';

    const paramsForServer = {
        shipLength: document.getElementById('shipLength').value, beam: document.getElementById('beam').value,
        speed: document.getElementById('shipSpeed').value, draft: document.getElementById('shipDraft').value,
        hpReq: document.getElementById('hpReq').value, fuelRate: document.getElementById('fuelRate').value,
        k: document.getElementById('hullFactor').value, baseWeight: document.getElementById('baseWeight').value,
        load: document.getElementById('load').value, F: document.getElementById('foulingFactor').value,
        S: document.getElementById('seaStateFactor').value,
        voyageDate: document.getElementById('voyageDate').value
    };

    if (!paramsForServer.voyageDate) {
        hideLoadingIndicator();
        showMessage(`Error: Voyage Start Date is missing.`, 'red');
        navigationState = 'SET_END';
        return;
    }

    const startCoords = `${start.lat},${start.lng}`;
    const endCoords = `${end.lat},${end.lng}`;
    const vesselQuery = Object.entries(paramsForServer).map(([key, value]) => `${key}=${value}`).join('&');
    const queryString = `start=${startCoords}&end=${endCoords}&${vesselQuery}`;

    fetch(`/api/route?${queryString}`)
        .then(response => {
            if (!response.ok) throw new Error(`Server error: ${response.statusText}`);
            return response.json();
        })
        .then(data => {
            hideLoadingIndicator();
            allCalculatedPaths = {};
            for (const strategy in data.paths) {
                allCalculatedPaths[strategy] = sanitizePath(data.paths[strategy]);
            }
            if (data.bounds && data.resolution) {
                currentGridInfo = { bounds: data.bounds, resolution: data.resolution };
            }
            if (Object.values(allCalculatedPaths).some(p => p.length > 0)) {
                drawAllPathsAndTooltips();
                updateMetricsForSelectedStrategy();
                navigationState = 'ROUTE_DISPLAYED';
                showMessage('Routes found. Click a route to select it.', 'green');
            } else {
                resetNavigation(true);
                showMessage('No valid route found for any strategy.', 'red');
            }
        })
        .catch(error => {
            hideLoadingIndicator();
            resetNavigation(true);
            console.error('Error fetching route:', error);
            showMessage('Could not connect to the routing server.', 'red');
        });
}

function drawAllPathsAndTooltips() {
    routeLayer.clearLayers();
    routePolylines = {}; // Clear previous references
    if (pathTooltip) {
        map.removeLayer(pathTooltip);
        pathTooltip = null;
    }

    const strategyStyles = {
        balanced: { color: '#3b82f6', weight: 5, opacity: 0.8 },
        fastest: { color: '#22c55e', weight: 3, opacity: 0.7 },
        safest: { color: '#f97316', weight: 3, opacity: 0.7 }
    };

    const onPathMouseOver = (e, pathData) => {
        const mouseLatLng = e.latlng;
        let closestPoint = null;
        let minDistance = Infinity;
        pathData.forEach(p => {
            const dist = mouseLatLng.distanceTo(L.latLng(p.lat, p.lng));
            if (dist < minDistance) {
                minDistance = dist;
                closestPoint = p;
            }
        });
        if (closestPoint && closestPoint.env) {
            const env = closestPoint.env;

            // FIX: Safely handle potentially null values before calling toFixed()
            const windKtsText = env.wind_speed_mps !== null ? `${(env.wind_speed_mps * 1.94384).toFixed(1)} kts` : 'N/A';
            const windDirText = env.wind_direction_deg !== null ? `@ ${env.wind_direction_deg.toFixed(0)}°` : '';
            const waveHeightText = env.waves_height_m !== null ? `${env.waves_height_m.toFixed(1)} m` : 'N/A';
            const depthText = env.depth !== null ? `${env.depth.toFixed(0)} m` : 'N/A';

            const content = `
                <b>Conditions at Point</b><br>
                Wind: ${windKtsText} ${windDirText}<br>
                Waves: ${waveHeightText}<br>
                Depth: ${depthText}<br>
            `;
            if (!pathTooltip) {
                pathTooltip = L.popup({ closeButton: false, offset: L.point(0, -15) });
            }
            pathTooltip.setLatLng(mouseLatLng).setContent(content).openOn(map);
        }
    };

    const onPathMouseOut = () => {
        if (pathTooltip) map.closePopup(pathTooltip);
    };

    for (const strategy in allCalculatedPaths) {
        const path = allCalculatedPaths[strategy];
        if (path && path.length > 1) {
            const turfLine = turf.lineString(path.map(p => [p.lng, p.lat]));
            const smoothedLine = turf.bezierSpline(turfLine);
            const smoothedLatLngs = smoothedLine.geometry.coordinates.map(coords => [coords[1], coords[0]]);

            const polyline = L.polyline(smoothedLatLngs, strategyStyles[strategy]).addTo(routeLayer);
            
            polyline.on('mousemove', (e) => onPathMouseOver(e, path));
            polyline.on('mouseout', onPathMouseOut);
            
            polyline.on('click', () => {
                const dropdown = document.getElementById('routingStrategy');
                dropdown.value = strategy;
                dropdown.dispatchEvent(new Event('change'));
            });

            routePolylines[strategy] = polyline;
        }
    }
}

function updateMetricsForSelectedStrategy() {
    const selectedStrategy = document.getElementById('routingStrategy').value;
    const path = allCalculatedPaths[selectedStrategy];
    
    currentPath = path || [];
    animationPath = path ? JSON.parse(JSON.stringify(path)) : null;
    if (boatAnimator) boatAnimator.path = animationPath;
    
    if (path && path.length > 0) {
        const speed = parseFloat(document.getElementById('shipSpeed').value);
        const totalDistanceKm = calculateTotalDistance(path);
        calculateAndDisplayMetrics(path, speed, totalDistanceKm);
        analyzeAndDisplayCriticalPoints(path, parseFloat(document.getElementById('shipDraft').value));
    } else {
        document.getElementById('metrics-display').classList.add('hidden');
        criticalPointsLayer.clearLayers();
    }

    for (const strategy in routePolylines) {
        const polyline = routePolylines[strategy];
        if (strategy === selectedStrategy) {
            polyline.setStyle({ weight: 5, opacity: 1 });
            polyline.bringToFront();
        } else {
            polyline.setStyle({ opacity: 0 });
        }
    }
}


function analyzeAndDisplayCriticalPoints(path, shipDraft) {
    criticalPointsLayer.clearLayers();
    if (!path || path.length < 10) return;
    let maxWaves = { val: -1, point: null }, maxWind = { val: -1, point: null }, minDepth = { val: Infinity, point: null };
    for (const p of path) {
        if (p.env) {
            if (p.env.waves_height_m > maxWaves.val) maxWaves = { val: p.env.waves_height_m, point: p };
            if (p.env.wind_speed_mps > maxWind.val) maxWind = { val: p.env.wind_speed_mps, point: p };
            if (p.env.depth !== null && p.env.depth < minDepth.val) minDepth = { val: p.env.depth, point: p };
        }
    }
    const createIcon = (svg, color) => L.divIcon({
        html: svg.replace('{color}', color),
        className: 'custom-poi-icon',
        iconSize: [24, 24],
        iconAnchor: [12, 24],
        popupAnchor: [0, -24]
    });
    const waveSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="{color}" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14c2.9-5.9 4.5-5.9 7.4 0 2.9 5.9 4.5 5.9 7.4 0 2.9-5.9 4.5-5.9 7.4 0"/></svg>`;
    const windSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="{color}" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/></svg>`;
    const depthSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="{color}" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/><path d="M12 12l-2-2.5 2-2.5 2 2.5z"/></svg>`;
    if (maxWaves.point) L.marker([maxWaves.point.lat, maxWaves.point.lng], { icon: createIcon(waveSVG, '#3b82f6') }).addTo(criticalPointsLayer).bindPopup(`<b>Highest Waves</b><br>${maxWaves.val.toFixed(1)} meters`);
    if (maxWind.point) {
        const windKts = (maxWind.val * 1.94384).toFixed(0);
        L.marker([maxWind.point.lat, maxWind.point.lng], { icon: createIcon(windSVG, '#10b981') }).addTo(criticalPointsLayer).bindPopup(`<b>Strongest Wind</b><br>${windKts} knots`);
    }
    if (minDepth.point) {
        const clearance = minDepth.val - shipDraft;
        const color = clearance < 5 ? '#ef4444' : '#f59e0b';
        L.marker([minDepth.point.lat, minDepth.point.lng], { icon: createIcon(depthSVG, color) }).addTo(criticalPointsLayer).bindPopup(`<b>Shallowest Point</b><br>Depth: ${minDepth.val.toFixed(0)}m<br>Clearance: ${clearance.toFixed(1)}m`);
    }
}


function onMapClick(e){if(editMode||navigationState==='CALCULATING')return;if(navigationState==='ROUTE_DISPLAYED'){resetNavigation(false);document.getElementById('startPort').value='';document.getElementById('endPort').value=''}if(navigationState==='SET_START'){startPoint=e.latlng;if(startMarker)map.removeLayer(startMarker);startMarker=L.circleMarker(startPoint,{color:'#10b981',radius:8,fillOpacity:0.8}).addTo(map);navigationState='SET_END';showMessage('Start point set. Double-click to set destination.','blue')}else if(navigationState==='SET_END'){endPoint=e.latlng;if(endMarker)map.removeLayer(endMarker);endMarker=L.circleMarker(endPoint,{color:'#ef4444',radius:8,fillOpacity:0.8}).addTo(map);calculateAndFetchRoute(startPoint,endPoint)}}

function calculateTotalDistance(path) {
    let totalDistance = 0;
    for (let i = 1; i < path.length; i++) {
        const from = turf.point([path[i-1].lng, path[i-1].lat]);
        const to = turf.point([path[i].lng, path[i].lat]);
        totalDistance += turf.distance(from, to, { units: 'kilometers' });
    }
    return totalDistance;
}

function calculateAndDisplayMetrics(path, speed, totalDistanceKm){
    const totalFuelLiters=path[path.length-1].totalFuel;
    if(totalFuelLiters===undefined){console.error("Path data does not include totalFuel.");return}
    const speedKmh=speed*1.852;
    const totalHours=speedKmh>0?totalDistanceKm/speedKmh:0;
    const days=Math.floor(totalHours/24);
    const remainingHours=Math.round(totalHours%24);
    const carbonTons=totalFuelLiters*0.0028 ;
    const metricsDisplay=document.getElementById('metrics-display');
    metricsDisplay.innerHTML=`
        <div class="flex justify-between items-center mb-2"><span class="text-gray-400">Travel Time:</span><span class="font-bold text-blue-400">${days}d ${remainingHours}h</span></div>
        <div class="flex justify-between items-center mb-2"><span class="text-gray-400">Total Distance:</span><span class="font-bold text-blue-400">${totalDistanceKm.toFixed(0)} km</span></div>
        <div class="flex justify-between items-center mb-2"><span class="text-gray-400">Fuel Consumed:</span><span class="font-bold text-blue-400">${totalFuelLiters.toFixed(0)} L</span></div>
        <div class="flex justify-between items-center"><span class="text-gray-400">CO₂ Emissions:</span><span class="font-bold text-blue-400">${carbonTons.toFixed(2)} tons</span></div>`;
    metricsDisplay.classList.remove('hidden');
}

function resetNavigation(showMsg = true){
    if(boatAnimator) boatAnimator.stopAnimation();
    if (gaPredictionTimer) clearInterval(gaPredictionTimer);
    allCalculatedPaths = {};
    currentPath = [];
    animationPath = null;
    currentGridInfo = null;
    navigationState = 'SET_START';
    startPoint = null;
    endPoint = null;
    routeLayer.clearLayers();
    criticalPointsLayer.clearLayers();
    if(startMarker) map.removeLayer(startMarker);
    if(endMarker) map.removeLayer(endMarker);
    startMarker = null;
    endMarker = null;
    document.getElementById('metrics-display').classList.add('hidden');
    hideHud();
    if(showMsg) showMessage('Route cleared. Ready for new route.','blue');
}

function logCurrentEnvData(envData) {
    if (!envData) return;
    const logEntry = {
        timestamp: new Date().toISOString(),
        wind_speed_mps: envData.wind_speed_mps, wind_direction_deg: envData.wind_direction_deg,
        current_speed_mps: envData.current_speed_mps, current_direction_deg: envData.current_direction_deg,
        waves_height_m: envData.waves_height_m, weekly_precip_mean: envData.weekly_precip_mean,
        ice_conc: envData.ice_conc, lat: envData.lat, lon: envData.lon
    };
    fetch('/api/log_env_data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(logEntry)
    }).catch(error => console.error("Failed to log environmental data:", error));
}

function resetEnvLog() {
    fetch('/api/reset_env_log', { method: 'POST' })
    .catch(error => console.error("Failed to reset history log:", error));
}

function updateHudWithLiveData(envData) {
    if (!envData) return;
    currentLiveEnvData = envData;
    const windSpeedKts = ((envData.wind_speed_mps || 0) * 1.94384).toFixed(1);
    const windDir = (envData.wind_direction_deg === null) ? 0 : envData.wind_direction_deg.toFixed(0);
    const currentSpeedKts = ((envData.current_speed_mps || 0) * 1.94384).toFixed(1);
    const currentDir = (envData.current_direction_deg === null) ? 0 : envData.current_direction_deg.toFixed(0);
    const wavesHeight = (envData.waves_height_m === null) ? '0.0' : envData.waves_height_m.toFixed(1);
    const depth = (envData.depth === null) ? 'N/A' : `${envData.depth.toFixed(0)} m`;
    const rain = (envData.weekly_precip_mean === null) ? '0.00' : envData.weekly_precip_mean.toFixed(2);
    const icePercent = ((envData.ice_conc || 0) * 100).toFixed(0);

    document.getElementById('hud-wind').textContent = `${windSpeedKts} kts @ ${windDir}°`;
    document.getElementById('hud-current').textContent = `${currentSpeedKts} kts @ ${currentDir}°`;
    document.getElementById('hud-waves').textContent = `${wavesHeight} m`;
    document.getElementById('hud-depth').textContent = depth;
    document.getElementById('hud-rain').textContent = `${rain} mm/wk`;
    document.getElementById('hud-ice').textContent = `${icePercent}%`;
    document.getElementById('hud-environmental-conditions').classList.remove('hidden');
    document.getElementById('navigation-hud').style.display = 'block';
}

function hideHud() {
    document.getElementById('navigation-hud').style.display = 'none';
    document.getElementById('hud-prediction-forecast').classList.add('hidden');
}

function updatePredictionHud(forecastData) {
    const predPanel = document.getElementById('hud-prediction-forecast');
    predPanel.classList.remove('hidden');
    document.getElementById('prediction-status').textContent = `Last run: ${new Date().toLocaleTimeString()}`;

    if (!forecastData || forecastData.length === 0) {
        document.getElementById('pred-wind').textContent = 'N/A';
        document.getElementById('pred-current').textContent = 'N/A';
        document.getElementById('pred-waves').textContent = 'N/A';
        document.getElementById('pred-rain').textContent = 'N/A';
        document.getElementById('pred-ice').textContent = 'N/A';
        document.getElementById('pred-timestamp').textContent = 'N/A';
        return;
    }

    const nextForecast = forecastData[0];
    const windSpeedKts = (nextForecast.predicted_wind_speed_mps * 1.94384).toFixed(1);
    const windDir = (nextForecast.predicted_wind_direction_deg).toFixed(0);
    const currentSpeedKts = (nextForecast.predicted_current_speed_mps * 1.94384).toFixed(1);
    const currentDir = (nextForecast.predicted_current_direction_deg).toFixed(0);
    const wavesHeight = nextForecast.predicted_waves_height_m.toFixed(1);
    const rain = nextForecast.predicted_weekly_precip_mean.toFixed(2);
    const icePercent = (nextForecast.predicted_ice_conc * 100).toFixed(0);
    const timestamp = new Date(nextForecast.timestamp);
    const formattedTime = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const formattedDate = timestamp.toLocaleDateString([], { month: 'short', day: 'numeric' });

    document.getElementById('pred-wind').textContent = `${windSpeedKts} kts @ ${windDir}°`;
    document.getElementById('pred-current').textContent = `${currentSpeedKts} kts @ ${currentDir}°`;
    document.getElementById('pred-waves').textContent = `${wavesHeight} m`;
    document.getElementById('pred-rain').textContent = `${rain} mm/wk`;
    document.getElementById('pred-ice').textContent = `${icePercent}%`;
    document.getElementById('pred-timestamp').textContent = `${formattedDate} ${formattedTime}`;
}

function triggerPrediction(lat, lon, date) {
    if (!currentPath || currentPath.length === 0) return;
    const envDataToPredict = currentLiveEnvData || currentPath[0].env;
    if (!envDataToPredict) return;

    document.getElementById('prediction-status').textContent = `Running prediction...`;

    const payload = { lat, lon, date, current_conditions: envDataToPredict };
    fetch(`/api/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    .then(response => {
        if (!response.ok) return response.json().then(err => Promise.reject(err));
        return response.json();
    })
    .then(data => {
        if (data.forecast && data.forecast.forecast_data.length > 0) {
            updatePredictionHud(data.forecast.forecast_data);
        } else {
            updatePredictionHud(null);
        }
    })
    .catch(error => {
        console.error("Prediction failed:", error);
        showMessage(`Prediction Error: ${error.error || 'Unknown error'}`, 'red');
        updatePredictionHud(null);
    });
}

function playAnimation() {
    if (!animationPath || animationPath.length < 2) return;

    if (boatAnimator) boatAnimator.stopAnimation();

    resetEnvLog();

    if (currentPath && currentPath.length > 0) {
        // FIX: Update the HUD with the starting point data immediately
        updateHudWithLiveData(currentPath[0].env);

        const startPointLat = currentPath[0].lat;
        const startPointLon = currentPath[0].lng;
        const voyageDate = document.getElementById('voyageDate').value;

        logCurrentEnvData(currentPath[0].env);
        triggerPrediction(startPointLat, startPointLon, voyageDate);

        if (gaPredictionTimer) clearInterval(gaPredictionTimer);
        gaPredictionTimer = setInterval(() => {
            if (boatAnimator) {
                const currentPosition = boatAnimator.boatMarker.getLatLng();
                triggerPrediction(currentPosition.lat, currentPosition.lng, voyageDate);
            }
        }, GA_PREDICTION_INTERVAL_MS);
    }

    showMessage('Animation Playing...', 'green');
    const params = {
        speed: document.getElementById('shipSpeed').value,
        draft: document.getElementById('shipDraft').value,
        hpReq: document.getElementById('hpReq').value,
        fuelRate: document.getElementById('fuelRate').value,
        k: document.getElementById('hullFactor').value,
        baseWeight: document.getElementById('baseWeight').value,
        load: document.getElementById('load').value,
        F: document.getElementById('foulingFactor').value,
        S: document.getElementById('seaStateFactor').value,
    };
    const totalDistanceKm = calculateTotalDistance(animationPath);

    boatAnimator.startAnimation(animationPath, params, totalDistanceKm, currentGridInfo);
    document.getElementById('navigation-hud').style.display = 'block';
}

function showMessage(text,color='blue'){messageBox.textContent=text;messageBox.className=`fixed top-5 left-1/2 -translate-x-1/2 bg-${color}-600 text-white py-3 px-6 rounded-lg shadow-lg z-[1000] text-center transition-opacity duration-300`;messageBox.style.opacity=1;setTimeout(()=>{messageBox.style.opacity=0},5000)}

// RESTORED: Grid and animation functions that were missing
function initializeTooltips(){const labels=document.querySelectorAll('.info-label');const tooltip=document.getElementById('tooltip');labels.forEach(label=>{label.addEventListener('mouseenter',e=>{tooltip.textContent=e.target.dataset.tooltip;tooltip.style.opacity='1';tooltip.style.display='block'});label.addEventListener('mousemove',e=>{tooltip.style.left=`${e.clientX+15}px`;tooltip.style.top=`${e.clientY+15}px`});label.addEventListener('mouseleave',()=>{tooltip.style.opacity='0';setTimeout(()=>{if(tooltip.style.opacity==='0')tooltip.style.display='none'},200)})})}

function toggleBoatAnimation() {
    const animButton = document.getElementById('toggle-animation-button').parentElement;
    const isToggledOn = animButton.classList.contains('toggled-on');

    if (isToggledOn) {
        animButton.classList.remove('toggled-on');
        if (boatAnimator) boatAnimator.stopAnimation();
        if (gaPredictionTimer) {
            clearInterval(gaPredictionTimer);
            gaPredictionTimer = null;
        }
        showMessage('Animation Paused.', 'blue');
        hideHud();
    } else {
        animButton.classList.add('toggled-on');
        if (animationPath && animationPath.length > 0) {
            playAnimation();
        } else {
            showMessage('No route available to animate.', 'yellow');
        }
    }
}

function toggleGrid(){if(isGridVisible){map.removeLayer(gridLayer);isGridVisible=false;showMessage("Grid hidden.","blue")}else{if(gridDataCache){drawGrid();map.addLayer(gridLayer);isGridVisible=true}else{showMessage("Fetching grid data...","yellow");fetch("/api/grid").then(response=>response.json()).then(data=>{gridDataCache=data;drawGrid();map.addLayer(gridLayer);isGridVisible=true;showMessage("Grid displayed.","green")}).catch(error=>{console.error("Error fetching grid:",error);showMessage("Failed to load grid data.","red")})}}}
function drawGrid(){if(!gridDataCache)return;gridLayer.clearLayers();const{grid,bounds,resolution}=gridDataCache;const mapBounds=map.getBounds();const iMin=Math.max(0,Math.floor((mapBounds.getWest()-bounds.west)/resolution));const iMax=Math.min(grid.length-1,Math.ceil((mapBounds.getEast()-bounds.west)/resolution));const jMin=Math.max(0,Math.floor((mapBounds.getSouth()-bounds.south)/resolution));const jMax=Math.min(grid[0].length-1,Math.ceil((mapBounds.getNorth()-bounds.south)/resolution));const landStyle={color:"rgba(239, 68, 68, 0.5)",weight:1,fillOpacity:0.2};for(let i=iMin;i<=iMax;i++){for(let j=jMin;j<=jMax;j++){if(grid[i]&&grid[i][j]===1){const west=bounds.west+i*resolution;const south=bounds.south+j*resolution;const east=west+resolution;const north=south+resolution;L.rectangle([[south,west],[north,east]],landStyle).addTo(gridLayer)}}}}
function toggleEditMode(){editMode=!editMode;const editButton=document.getElementById("edit-grid-button");const saveButton=document.getElementById("save-grid-button");if(editMode){if(!isGridVisible)toggleGrid();showMessage("Edit Mode ON. Left-drag to draw, Right-drag to erase.","purple");L.DomUtil.addClass(map._container,"edit-cursor");editButton.classList.add("bg-blue-500");saveButton.classList.remove("hidden");map.dragging.disable()}else{showMessage("Edit Mode OFF.","blue");L.DomUtil.removeClass(map._container,"edit-cursor");editButton.classList.remove("bg-blue-500");saveButton.classList.add("hidden");map.dragging.enable()}}
function editGridCell(e){if(!gridDataCache)return;const{grid,bounds,resolution}=gridDataCache;const i=Math.floor((e.latlng.lng-bounds.west)/resolution);const j=Math.floor((e.latlng.lat-bounds.south)/resolution);if(grid[i]&&grid[i][j]!==undefined){const targetValue=drawMode==="draw"?1:0;if(grid[i][j]!==targetValue){grid[i][j]=targetValue;drawGrid()}}}
function saveGrid(){if(!gridDataCache){showMessage("No grid data to save.","red");return}showMessage("Saving a new copy of the grid to the server...","yellow");fetch("/api/grid/update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(gridDataCache)}).then(response=>response.json()).then(data=>{showMessage(`${data.message} Filename: ${data.filename}`,"green")}).catch(error=>{console.error("Error saving grid:",error);showMessage("Failed to save grid.","red")})}
function downloadGrid(){if(!gridDataCache){showMessage("No grid data to download.","red");return}showMessage("Preparing download...","blue");const dataStr="data:text/json;charset=utf-8,"+encodeURIComponent(JSON.stringify(gridDataCache));const downloadAnchorNode=document.createElement("a");downloadAnchorNode.setAttribute("href",dataStr);downloadAnchorNode.setAttribute("download",`edited-grid-cache-${Date.now()}.json`);document.body.appendChild(downloadAnchorNode);downloadAnchorNode.click();downloadAnchorNode.remove();showMessage("Download started.","green")}
function uploadGrid() {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json";

    fileInput.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;

        showMessage(`Reading ${file.name}...`, "blue");
        const reader = new FileReader;

        reader.onload = event => {
            try {
                const uploadedData = JSON.parse(event.target.result);
                if (uploadedData.grid && uploadedData.bounds && uploadedData.hasOwnProperty("resolution")) {
                    gridDataCache = uploadedData;
                    showMessage("Custom grid loaded locally! Sending to server...", "yellow");
                    if (isGridVisible) drawGrid();
                    fetch('/api/grid/temporary-upload', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(uploadedData)
                    })
                    .then(response => {
                        if (!response.ok) throw new Error('Server rejected the grid.');
                        return response.json();
                    })
                    .then(data => {
                        useCustomGrid = true;
                        showMessage('Custom grid will be used for the next route calculation.', 'green');
                    })
                    .catch(error => {
                        console.error('Error sending grid to server:', error);
                        showMessage('Failed to send custom grid to server.', 'red');
                    });
                } else {
                    showMessage("Invalid grid file format.", "red")
                }
            } catch (error) {
                console.error("Error parsing JSON file:", error);
                showMessage("Could not read the uploaded file.", "red")
            }
        };
        reader.readAsText(file)
    };
    fileInput.click()
}


const CustomControl=L.Control.extend({options:{position:'bottomright',icon:'',title:'',action:()=>{},id:''},onAdd:function(){const container=L.DomUtil.create('div','leaflet-bar leaflet-control');container.innerHTML=`<a href="#" id="${this.options.id}" title="${this.options.title}" role="button" class="custom-control bg-gray-700 hover:bg-gray-600 flex items-center justify-center w-9 h-9 rounded-md shadow-md">${this.options.icon}</a>`;L.DomEvent.on(container,'click',e=>{L.DomEvent.stopPropagation(e);L.DomEvent.preventDefault(e);this.options.action()});return container}});
const resetIcon=`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-refresh-cw"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
const gridIcon=`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-grid"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`;
const editIcon=`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-edit"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
const saveIcon=`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-save"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`;
const downloadIcon=`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-download"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
const uploadIcon=`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-upload"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
const heatIcon=`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-thermometer"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"></path></svg>`;
const boatIcon=`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-send"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
new CustomControl({icon:resetIcon,title:'Reset Route',action:resetNavigation}).addTo(map);
new CustomControl({icon:gridIcon,title:'Toggle Grid',action:toggleGrid}).addTo(map);
new CustomControl({id:'edit-grid-button',icon:editIcon,title:'Toggle Edit Mode',action:toggleEditMode}).addTo(map);
const saveButtonControl=new CustomControl({id:'save-grid-button',icon:saveIcon,title:'Save Grid Changes',action:saveGrid});
saveButtonControl.addTo(map);
document.getElementById('save-grid-button').parentElement.classList.add('hidden');
new CustomControl({icon:downloadIcon,title:'Download Grid',action:downloadGrid}).addTo(map);
new CustomControl({icon:uploadIcon,title:'Upload Grid',action:uploadGrid}).addTo(map);
new CustomControl({id:'toggle-animation-button',icon:boatIcon,title:'Toggle Boat Animation',action:toggleBoatAnimation}).addTo(map);
const style=document.createElement('style');
style.innerHTML=`
    .edit-cursor { cursor: cell !important; }
    .pan-cursor { cursor: grab !important; }
    .pan-cursor:active { cursor: grabbing !important; }
    .leaflet-control.toggled-on a { background-color: #3b82f6 !important; }
    .boat-icon-wrapper { transition: transform 0.1s linear; }
`;
document.head.appendChild(style);


// --- Let's ensure initializeApp is called at the end ---
initializeApp();

