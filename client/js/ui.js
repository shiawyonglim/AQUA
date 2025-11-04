// ui.js
import { state } from './state.js';
import { shipTypeDefaults } from './config.js';
import * as App from './app.js';
import * as API from './api.js';
import { analyzePathForRisks } from './risk.js';

// --- DOM Element Selectors ---
const messageBox = document.getElementById('messageBox');
const loadingOverlay = document.getElementById('loading-overlay');

// --- UI Initialization ---
/**
 * Sets up all event listeners for UI elements.
 */
export async function initializeUI() {
    // Buttons
    document.getElementById('demo-route-button').addEventListener('click', App.setDemoRoute);
    document.getElementById('compare-routes-button').addEventListener('click', showComparisonModal);
    document.getElementById('profile-route-button').addEventListener('click', showProfileModal);
    
    // Modals
    document.getElementById('close-comparison-modal-button').addEventListener('click', hideComparisonModal);
    document.getElementById('close-profile-modal-button').addEventListener('click', hideProfileModal);

    // Inputs
    document.getElementById('routingStrategy').addEventListener('change', updateMetricsForSelectedStrategy);
    
    // MERGED: Add listeners for both ship type changes and individual parameter changes
    document.getElementById('shipType').addEventListener('change', () => {
        updateShipParameters();
        // If a route is already displayed, trigger a full recalculation from the server
        if (state.navigationState === 'ROUTE_DISPLAYED') {
            App.calculateAndFetchRoute(state.startPoint, state.endPoint);
        }
    });

    const recalcInputs = ['shipLength', 'beam', 'baseWeight', 'load', 'shipSpeed', 'shipDraft', 'hpReq', 'fuelRate'];
    recalcInputs.forEach(id => {
        document.getElementById(id).addEventListener('change', App.recalculateAllPathsWithNewParams);
    });

    // Search
    setupSearchListeners();
    state.portData = await API.fetchPorts();
    populatePortDatalist();

    // Other UI
    initializeTooltips();
    updateShipParameters(); // Load initial defaults
    setVoyageDateToToday();
    
    showMessage('Map ready. Use the search or double-click to set a route.', 'green');
}


// --- Core UI Functions ---
export const showMessage = (text, color = 'blue') => {
    messageBox.textContent = text;
    messageBox.className = `fixed top-5 left-1/2 -translate-x-1/2 bg-${color}-600 text-white py-3 px-6 rounded-lg shadow-lg z-[1000] text-center transition-opacity duration-300`;
    messageBox.style.opacity = 1;
    setTimeout(() => { messageBox.style.opacity = 0 }, 5000);
};

export const showLoadingIndicator = () => loadingOverlay.classList.remove('hidden');
export const hideLoadingIndicator = () => loadingOverlay.classList.add('hidden');


// --- Sidebar and Metrics ---

function updateShipParameters() {
    const selectedType = document.getElementById('shipType').value;
    const defaults = shipTypeDefaults[selectedType];
    if (defaults) {
        document.getElementById('shipLength').value = defaults.shipLength;
        document.getElementById('beam').value = defaults.beam;
        document.getElementById('baseWeight').value = defaults.baseWeight;
        document.getElementById('load').value = defaults.load;
        document.getElementById('shipSpeed').value = defaults.speed;
        document.getElementById('shipDraft').value = defaults.draft;
        document.getElementById('hpReq').value = defaults.hpReq;
        document.getElementById('fuelRate').value = defaults.fuelRate;
    }
}

export function updateMetricsForSelectedStrategy() {
    const selectedStrategy = document.getElementById('routingStrategy').value;
    const path = state.allCalculatedPaths[selectedStrategy];
    
    state.currentPath = path || [];
    state.animationPath = path ? JSON.parse(JSON.stringify(path)) : null;
    if (state.boatAnimator) state.boatAnimator.path = state.animationPath;
    
    // MERGED: Includes risk analysis from Version 2
    if (path && path.length > 0) {
        const riskyZones = analyzePathForRisks(path);
        drawRiskZones(path, riskyZones); 

        calculateAndDisplayMetrics(path); // MERGED: No longer needs speed/distance passed in
        analyzeAndDisplayCriticalPoints(path, parseFloat(document.getElementById('shipDraft').value));
        document.getElementById('metrics-display').classList.remove('hidden');
    } else {
        document.getElementById('metrics-display').classList.add('hidden');
        state.criticalPointsLayer.clearLayers();
        if (state.riskyZonesLayer) state.riskyZonesLayer.clearLayers();
    }

    // Highlight the selected path
    for (const strategy in state.routePolylines) {
        const polyline = state.routePolylines[strategy];
        if (polyline) {
             if (strategy === selectedStrategy) {
                polyline.setStyle({ weight: 6, opacity: 1 });
                polyline.bringToFront();
            } else {
                polyline.setStyle({ weight: 3, opacity: 0.7 });
            }
        }
    }
}

// MERGED: This is the more advanced function from File #1, which uses realistic time calculations
function calculateAndDisplayMetrics(path) {
    const metricsDetails = document.getElementById('metrics-details');
    const finalPoint = path[path.length - 1];

    if (!finalPoint || typeof finalPoint.totalFuel === 'undefined') {
        metricsDetails.innerHTML = `<p class="text-red-400">Error: Incomplete path data.</p>`;
        return;
    }

    const totalDistanceKm = App.calculateTotalDistance(path);
    const totalFuelLiters = finalPoint.totalFuel;
    const totalHours = finalPoint.totalTime || (totalDistanceKm / (parseFloat(document.getElementById('shipSpeed').value) * 1.852));
    const days = Math.floor(totalHours / 24);
    const remainingHours = Math.round(totalHours % 24);
    const carbonTons = totalFuelLiters * 0.0028;

    metricsDetails.innerHTML = `
        <div class="flex justify-between items-center"><span class="text-gray-400">Travel Time:</span><span class="font-bold text-blue-400">${days}d ${remainingHours}h</span></div>
        <div class="flex justify-between items-center"><span class="text-gray-400">Total Distance:</span><span class="font-bold text-blue-400">${totalDistanceKm.toFixed(0)} km</span></div>
        <div class="flex justify-between items-center"><span class="text-gray-400">Fuel Consumed:</span><span class="font-bold text-blue-400">${totalFuelLiters.toFixed(0)} L</span></div>
        <div class="flex justify-between items-center"><span class="text-gray-400">CO₂ Emissions:</span><span class="font-bold text-blue-400">${carbonTons.toFixed(2)} tons</span></div>
    `;
}

function analyzeAndDisplayCriticalPoints(path, shipDraft) {
    state.criticalPointsLayer.clearLayers();
    if (!path || path.length < 10) return;

    let maxWaves = { val: -1, point: null }, maxWind = { val: -1, point: null }, minDepth = { val: Infinity, point: null };
    for (const p of path) {
        if (p.env) {
            if (p.env.waves_height_m !== null && p.env.waves_height_m > maxWaves.val) {
            maxWaves = { val: p.env.waves_height_m, point: p };
            }
            if (p.env.wind_speed_mps !== null && p.env.wind_speed_mps > maxWind.val) {
            maxWind = { val: p.env.wind_speed_mps, point: p };
            }
            if (p.env.depth !== null && p.env.depth < minDepth.val) minDepth = { val: p.env.depth, point: p };
        }
    }

    const createIcon = (svg, color) => L.divIcon({
        html: svg.replace('{color}', color),
        className: 'custom-poi-icon',
        iconSize: [24, 24], iconAnchor: [12, 24], popupAnchor: [0, -24]
    });

    const waveSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="{color}" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14c2.9-5.9 4.5-5.9 7.4 0 2.9 5.9 4.5 5.9 7.4 0 2.9-5.9 4.5-5.9 7.4 0"/></svg>`;
    const windSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="{color}" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/></svg>`;
    const depthSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="{color}" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/><path d="M12 12l-2-2.5 2-2.5 2 2.5z"/></svg>`;

    if (maxWaves.point) L.marker([maxWaves.point.lat, maxWaves.point.lng], { icon: createIcon(waveSVG, '#3b82f6') }).addTo(state.criticalPointsLayer).bindPopup(`<b>Highest Waves</b><br>${maxWaves.val.toFixed(1)} meters`);
    if (maxWind.point) L.marker([maxWind.point.lat, maxWind.point.lng], { icon: createIcon(windSVG, '#10b981') }).addTo(state.criticalPointsLayer).bindPopup(`<b>Strongest Wind</b><br>${(maxWind.val * 1.94384).toFixed(0)} knots`);
    if (minDepth.point) {
        const clearance = minDepth.val - shipDraft;
        const color = clearance < 5 ? '#ef4444' : '#f59e0b';
        L.marker([minDepth.point.lat, minDepth.point.lng], { icon: createIcon(depthSVG, color) }).addTo(state.criticalPointsLayer).bindPopup(`<b>Shallowest Point</b><br>Depth: ${minDepth.val.toFixed(0)}m<br>Clearance: ${clearance.toFixed(1)}m`);
    }
}


// --- Drawing and Tooltips ---
function drawRiskZones(path, riskyZones) {
    state.riskyZonesLayer.clearLayers();
    if (!riskyZones || riskyZones.length === 0) return;

    riskyZones.forEach(zone => {
        const zoneLatLngs = path.slice(zone.startIndex, zone.endIndex + 1).map(p => [p.lat, p.lng]);
        if (zoneLatLngs.length > 1) {
            L.polyline(zoneLatLngs, {
                color: '#ef4444',
                weight: 15,
                opacity: 0.5
            }).addTo(state.riskyZonesLayer);
        }
    });
}

export function drawAllPathsAndTooltips(map) {
    state.routeLayer.clearLayers();
    if (state.riskyZonesLayer) state.riskyZonesLayer.clearLayers();

    state.routePolylines = {};
    if (state.pathTooltip) {
        map.removeLayer(state.pathTooltip);
        state.pathTooltip = null;
    }

    const strategyStyles = {
        balanced: { color: '#3b82f6', weight: 5, opacity: 0.8 },
        fastest: { color: '#22c55e', weight: 3, opacity: 0.7 },
        safest: { color: '#f97316', weight: 3, opacity: 0.7 }
    };

    let firstPath = null;

    for (const strategy in state.allCalculatedPaths) {
        const path = state.allCalculatedPaths[strategy];
        if (!firstPath && path && path.length > 1) {
            firstPath = path;
        }
        if (path && path.length > 1) {
            const smoothedLatLngs = turf.bezierSpline(turf.lineString(path.map(p => [p.lng, p.lat]))).geometry.coordinates.map(coords => [coords[1], coords[0]]);
            const polyline = L.polyline(smoothedLatLngs, strategyStyles[strategy]).addTo(state.routeLayer);

            polyline.on('mousemove', (e) => onPathMouseOver(e, path, map));
            polyline.on('mouseout', () => onPathMouseOut(map));
            polyline.on('click', () => {
                document.getElementById('routingStrategy').value = strategy;
                updateMetricsForSelectedStrategy();
            });
            state.routePolylines[strategy] = polyline;
        }
    }
    
    if (firstPath) {
        const balancedPath = state.allCalculatedPaths['balanced'] || firstPath;
        const riskyZones = analyzePathForRisks(balancedPath);
        drawRiskZones(balancedPath, riskyZones);
    }
}


function onPathMouseOver(e, pathData, map) {
    const mouseLatLng = e.latlng;
    let closestPoint = turf.nearestPointOnLine(turf.lineString(pathData.map(p => [p.lng, p.lat])), turf.point([mouseLatLng.lng, mouseLatLng.lat]));
    const index = closestPoint.properties.index;
    const env = pathData[index]?.env;

    if (env) {
        const content = `<b>Conditions at Point</b><br>
            Wind: ${env.wind_speed_mps !== null ? `${(env.wind_speed_mps * 1.94384).toFixed(1)} kts` : 'N/A'}<br>
            Waves: ${env.waves_height_m !== null ? `${env.waves_height_m.toFixed(1)} m` : 'N/A'}<br>
            Depth: ${env.depth !== null ? `${env.depth.toFixed(0)} m` : 'N/A'}`;
        if (!state.pathTooltip) {
            state.pathTooltip = L.popup({ closeButton: false, offset: L.point(0, -15) });
        }
        state.pathTooltip.setLatLng(mouseLatLng).setContent(content).openOn(map);
    }
}

function onPathMouseOut(map) {
    if (state.pathTooltip) map.closePopup(state.pathTooltip);
}

// --- Modals and Charts ---

export function showProximityAlert(zone) {
    const modal = document.getElementById('risk-alert-modal');
    document.getElementById('risk-title').textContent = "Upcoming Hazard Zone!";

    const detailsContainer = document.getElementById('risk-details');
    
    const maxWaves = zone.details.waves_height_m;
    const maxWind = zone.details.wind_speed_mps;
    const maxCurrent = zone.details.current_speed_mps || 0; 
    const riskPercentage = ((zone.details.maxRiskScore || 0) * 100).toFixed(0);

    const safeThresholds = {
        waveHeight: 2.0,
        windSpeed: 10.0,
        currentSpeed: 1.5
    };

    const windKnots = (maxWind * 1.94384).toFixed(1);
    const currentKnots = (maxCurrent * 1.94384).toFixed(1);

    const windColor = maxWind > safeThresholds.windSpeed ? 'text-yellow-300' : 'text-green-400';
    const waveColor = maxWaves > safeThresholds.waveHeight ? 'text-yellow-300' : 'text-green-400';
    const currentColor = maxCurrent > safeThresholds.currentSpeed ? 'text-yellow-300' : 'text-green-400';

    detailsContainer.innerHTML = `
        <div class="text-center mb-4">
            <span class="text-gray-400">Maximum Risk Score:</span>
            <span class="font-bold text-3xl text-red-500">${riskPercentage}%</span>
        </div>
        <p class="text-lg">Conditions in the upcoming zone include:</p>
        <div class="mt-2 space-y-2 text-sm bg-gray-900 p-3 rounded-lg">
            <div class="flex justify-between items-center">
                <span class="${windColor}">Max Wind:</span>
                <span class="font-semibold ${windColor}">${windKnots} kts</span>
            </div>
            <div class="flex justify-between items-center">
                <span class="${waveColor}">Max Waves:</span>
                <span class="font-semibold ${waveColor}">${maxWaves.toFixed(1)} m</span>
            </div>
            <div class="flex justify-between items-center">
                <span class="${currentColor}">Max Current:</span>
                <span class="font-semibold ${currentColor}">${currentKnots} kts</span>
            </div>
        </div>
    `;

    document.getElementById('risk-advice').textContent = "It is recommended to ANCHOR the vessel before entering this zone.";
    modal.classList.remove('hidden');

    const okButton = document.getElementById('risk-ok-button');
    const newOkButton = okButton.cloneNode(true);
    okButton.parentNode.replaceChild(newOkButton, okButton);
    newOkButton.addEventListener('click', () => modal.classList.add('hidden'), { once: true });
}

// MERGED: This is the more advanced function from File #1, which uses realistic time calculations
function showComparisonModal() {
    document.getElementById('comparison-modal').classList.remove('hidden');
    
    const labels = ['Balanced', 'Fastest', 'Safest'];
    const datasets = { 'Travel Time (hours)': [], 'Fuel Consumed (L)': [], 'Total Distance (km)': [] };
    
    labels.forEach(strategyLabel => {
        const path = state.allCalculatedPaths[strategyLabel.toLowerCase()];
        if (path && path.length > 0) {
            const distance = App.calculateTotalDistance(path);
            const finalNode = path[path.length - 1];
            const travelTime = finalNode.totalTime || (distance / (parseFloat(document.getElementById('shipSpeed').value) * 1.852));
            const totalFuel = finalNode.totalFuel || 0;
            
            datasets['Total Distance (km)'].push(distance.toFixed(0));
            datasets['Fuel Consumed (L)'].push(totalFuel.toFixed(0));
            datasets['Travel Time (hours)'].push(travelTime.toFixed(1));
        } else {
            Object.values(datasets).forEach(d => d.push(0));
        }
    });

    const ctx = document.getElementById('comparison-chart').getContext('2d');
    if (state.comparisonChart) state.comparisonChart.destroy();
    
    state.comparisonChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Travel Time (hours)',
                    data: datasets['Travel Time (hours)'],
                    backgroundColor: 'rgba(59, 130, 246, 0.7)',
                    yAxisID: 'yTime',
                },
                {
                    label: 'Fuel Consumed (L)',
                    data: datasets['Fuel Consumed (L)'],
                    backgroundColor: 'rgba(249, 115, 22, 0.7)',
                    yAxisID: 'yFuel',
                },
                {
                    label: 'Total Distance (km)',
                    data: datasets['Total Distance (km)'],
                    backgroundColor: 'rgba(34, 197, 94, 0.7)',
                    yAxisID: 'yDistance',
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: 'Route Strategy Performance Metrics', color: '#FFF', font: { size: 16 } },
                legend: { labels: { color: '#FFF' } }
            },
            scales: {
                x: { ticks: { color: '#d1d5db' }, grid: { color: 'rgba(255, 255, 255, 0.1)' } },
                yTime: { type: 'linear', position: 'left', title: { display: true, text: 'Time (hours)', color: '#d1d5db' }, ticks: { color: '#d1d5db' }, grid: { color: 'rgba(255, 255, 255, 0.1)' } },
                yFuel: { type: 'linear', position: 'right', title: { display: true, text: 'Fuel (L)', color: '#d1d5db' }, ticks: { color: '#d1d5db' }, grid: { drawOnChartArea: false } },
                yDistance: { type: 'linear', position: 'right', title: { display: true, text: 'Distance (km)', color: '#d1d5db' }, ticks: { color: '#d1d5db' }, grid: { drawOnChartArea: false }, offset: true }
            }
        }
    });
}

function hideComparisonModal() {
    document.getElementById('comparison-modal').classList.add('hidden');
}

function showProfileModal() {
    if (!state.currentPath || state.currentPath.length === 0) {
        showMessage('Please select a valid route first.', 'yellow');
        return;
    }
    document.getElementById('profile-modal').classList.remove('hidden');
    
    const labels = [], waveData = [], windData = [], depthData = [];
    let cumulativeDistance = 0;

    for (let i = 0; i < state.currentPath.length; i++) {
        const point = state.currentPath[i];
        if (i > 0) {
            cumulativeDistance += turf.distance(turf.point([state.currentPath[i-1].lng, state.currentPath[i-1].lat]), turf.point([point.lng, point.lat]));
        }
        if (i % Math.floor(state.currentPath.length / 50) === 0 || i === state.currentPath.length - 1) {
            labels.push(cumulativeDistance.toFixed(0));
            const env = point.env;
            waveData.push(env?.waves_height_m);
            windData.push(env?.wind_speed_mps);
            depthData.push(env?.depth !== null ? -env.depth : null);
        }
    }
    
    const ctx = document.getElementById('profile-chart').getContext('2d');
    if (state.profileChart) state.profileChart.destroy();

    state.profileChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Sea Depth (m)',
                    data: depthData,
                    borderColor: 'rgba(59, 130, 246, 0.8)',
                    backgroundColor: 'rgba(59, 130, 246, 0.2)',
                    yAxisID: 'yDepth',
                    tension: 0.3,
                    fill: true,
                },
                {
                    label: 'Wave Height (m)',
                    data: waveData,
                    borderColor: 'rgba(34, 197, 94, 0.8)',
                    yAxisID: 'yConditions',
                    tension: 0.3,
                },
                {
                    label: 'Wind Speed (m/s)',
                    data: windData,
                    borderColor: 'rgba(239, 68, 68, 0.8)',
                    yAxisID: 'yConditions',
                    tension: 0.3,
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                title: { display: true, text: 'Conditions Along Voyage', color: '#FFF', font: { size: 16 } },
                legend: { labels: { color: '#FFF' } },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) { label += ': '; }
                            if (context.parsed.y !== null) {
                                const value = context.dataset.label === 'Sea Depth (m)' ? -context.parsed.y : context.parsed.y;
                                label += value.toFixed(1);
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: { 
                    title: { display: true, text: 'Distance from Start (km)', color: '#d1d5db' },
                    ticks: { color: '#d1d5db' }, 
                    grid: { color: 'rgba(255, 255, 255, 0.1)' } 
                },
                yDepth: { 
                    type: 'linear', 
                    position: 'left', 
                    title: { display: true, text: 'Sea Depth (m)', color: '#d1d5db' },
                    ticks: { color: '#d1d5db', callback: value => -value }, 
                    grid: { color: 'rgba(255, 255, 255, 0.1)' } 
                },
                yConditions: {
                    type: 'linear', 
                    position: 'right', 
                    title: { display: true, text: 'Meters or m/s', color: '#d1d5db' },
                    ticks: { color: '#d1d5db' },
                    grid: { drawOnChartArea: false }
                },
            }
        }
    });
}

function hideProfileModal() {
    document.getElementById('profile-modal').classList.add('hidden');
}

// --- HUD ---
export function updateHudWithLiveData(envData) {
    if (!envData) return;
    state.currentLiveEnvData = envData;
    document.getElementById('hud-wind').textContent = `${((envData.wind_speed_mps || 0) * 1.94384).toFixed(1)} kts @ ${(envData.wind_direction_deg ?? 0).toFixed(0)}°`;
    document.getElementById('hud-current').textContent = `${((envData.current_speed_mps || 0) * 1.94384).toFixed(1)} kts @ ${(envData.current_direction_deg ?? 0).toFixed(0)}°`;
    document.getElementById('hud-waves').textContent = `${(envData.waves_height_m ?? 0).toFixed(1)} m`;
    document.getElementById('hud-depth').textContent = envData.depth !== null ? `${envData.depth.toFixed(0)} m` : 'N/A';
    document.getElementById('hud-rain').textContent = `${(envData.weekly_precip_mean ?? 0).toFixed(2)} mm/wk`;
    document.getElementById('hud-ice').textContent = `${((envData.ice_conc || 0) * 100).toFixed(0)}%`;
    document.getElementById('hud-environmental-conditions').classList.remove('hidden');
    document.getElementById('navigation-hud').style.display = 'block';
}

export function updatePredictionHud(data) {
    const predPanel = document.getElementById('hud-prediction-forecast');
    predPanel.classList.remove('hidden');
    document.getElementById('prediction-status').textContent = `Last run: ${new Date().toLocaleTimeString()}`;
    
    const forecast = data?.forecast?.forecast_data?.[0];
    if (!forecast) {
        ['wind', 'current', 'waves', 'rain', 'ice', 'timestamp'].forEach(id => document.getElementById(`pred-${id}`).textContent = 'N/A');
        return;
    }

    document.getElementById('pred-wind').textContent = `${(forecast.predicted_wind_speed_mps * 1.94384).toFixed(1)} kts @ ${forecast.predicted_wind_direction_deg.toFixed(0)}°`;
    document.getElementById('pred-current').textContent = `${(forecast.predicted_current_speed_mps * 1.94384).toFixed(1)} kts @ ${forecast.predicted_current_direction_deg.toFixed(0)}°`;
    document.getElementById('pred-waves').textContent = `${forecast.predicted_waves_height_m.toFixed(1)} m`;
    document.getElementById('pred-rain').textContent = `${forecast.predicted_weekly_precip_mean.toFixed(2)} mm/wk`;
    document.getElementById('pred-ice').textContent = `${(forecast.predicted_ice_conc * 100).toFixed(0)}%`;
    const ts = new Date(forecast.timestamp);
    document.getElementById('pred-timestamp').textContent = `${ts.toLocaleDateString([], {month:'short', day:'numeric'})} ${ts.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;
}

export function hideHud() {
    document.getElementById('navigation-hud').style.display = 'none';
    document.getElementById('hud-prediction-forecast').classList.add('hidden');
}


// --- Helper Functions ---
function setVoyageDateToToday() {
    const voyageDateInput = document.getElementById('voyageDate');
    const today = new Date();
    voyageDateInput.value = today.toISOString().split('T')[0];
}

function initializeTooltips() {
    const labels = document.querySelectorAll('.info-label');
    const tooltip = document.getElementById('tooltip');
    labels.forEach(label => {
        label.addEventListener('mouseenter', e => {
            tooltip.textContent = e.target.dataset.tooltip;
            tooltip.style.opacity = '1';
            tooltip.style.display = 'block';
        });
        label.addEventListener('mousemove', e => {
            tooltip.style.left = `${e.clientX + 15}px`;
            tooltip.style.top = `${e.clientY + 15}px`;
        });
        label.addEventListener('mouseleave', () => {
            tooltip.style.opacity = '0';
        });
    });
}

function populatePortDatalist() {
    const portsList = document.getElementById('ports-list');
    if (portsList) {
        portsList.innerHTML = state.portData.map(port => `<option value="${port.name}"></option>`).join('');
    }
}

function setupSearchListeners() {
    const startInput = document.getElementById('startPort');
    const endInput = document.getElementById('endPort');
    const handleSelection = () => {
        App.resetNavigation(false);
        const startPort = state.portData.find(p => p.name === startInput.value);
        const endPort = state.portData.find(p => p.name === endInput.value);

        if (state.startMarker) state.startMarker.remove();
        if (state.endMarker) state.endMarker.remove();

        if (startPort) {
            state.startPoint = L.latLng(startPort.lat, startPort.lng);
            state.startMarker = L.circleMarker(state.startPoint, { color: '#10b981', radius: 8, fillOpacity: 0.8 }).addTo(App.getMap());
        }
        if (endPort) {
            state.endPoint = L.latLng(endPort.lat, endPort.lng);
            state.endMarker = L.circleMarker(state.endPoint, { color: '#ef4444', radius: 8, fillOpacity: 0.8 }).addTo(App.getMap());
        }
        if (startPort && endPort) {
            const bounds = L.latLngBounds([state.startPoint, state.endPoint]);
            App.getMap().fitBounds(bounds.pad(0.2));
            App.calculateAndFetchRoute(state.startPoint, state.endPoint);
        }
    };
    startInput.addEventListener('change', handleSelection);
    endInput.addEventListener('change', handleSelection);
}
