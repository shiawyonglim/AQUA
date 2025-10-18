// app.js
import { state } from './state.js';
import { initializeMap, initializeDrawControls } from './map.js';
import * as UI from './ui.js';
import * as API from './api.js';
import { GA_PREDICTION_INTERVAL_MS } from './config.js';
import { BoatAnimator } from './boat.js';


let map; // Local reference to the map instance

/**
 * Main initialization function for the entire application.
 */
export function initializeApp() {
    map = initializeMap();
    state.boatAnimator = new BoatAnimator(map);
    UI.initializeUI();
    initializeDrawControls();
    
    // Add dummy inputs for factors not in the UI
    document.body.insertAdjacentHTML('beforeend', '<input type="hidden" id="hullFactor" value="0.005"><input type="hidden" id="foulingFactor" value="1.0"><input type="hidden" id="seaStateFactor" value="1.0">');
}

// Simple getter to provide the map instance to other modules if needed
export const getMap = () => map;


/**
 * Handles clicks on the map to set start/end points.
 * @param {object} e - The Leaflet map click event.
 */
export function onMapClick(e) {
    if (state.navigationState === 'CALCULATING') return;
    
    if (state.navigationState === 'ROUTE_DISPLAYED') {
        resetNavigation(false);
        document.getElementById('startPort').value = '';
        document.getElementById('endPort').value = '';
    }

    if (state.navigationState === 'SET_START') {
        state.startPoint = e.latlng;
        if (state.startMarker) state.startMarker.remove();
        state.startMarker = L.circleMarker(state.startPoint, { color: '#10b981', radius: 8, fillOpacity: 0.8 }).addTo(map);
        state.navigationState = 'SET_END';
        UI.showMessage('Start point set. Double-click to set destination.', 'blue');
    } else if (state.navigationState === 'SET_END') {
        state.endPoint = e.latlng;
        if (state.endMarker) state.endMarker.remove();
        state.endMarker = L.circleMarker(state.endPoint, { color: '#ef4444', radius: 8, fillOpacity: 0.8 }).addTo(map);
        calculateAndFetchRoute(state.startPoint, state.endPoint);
    }
}

/**
 * Resets the application to its initial state.
 * @param {boolean} showMsg - Whether to show a confirmation message.
 */
export function resetNavigation(showMsg = true) {
    if (state.boatAnimator) state.boatAnimator.stopAnimation();
    if (state.gaPredictionTimer) clearInterval(state.gaPredictionTimer);

    // MERGED: Reset the new risk and anchor states
    state.isAnchored = false; 
    state.riskyZones = [];
    state.notifiedRiskZones.clear();
    if (state.riskyZonesLayer) state.riskyZonesLayer.clearLayers();
    const anchorButtonContainer = document.getElementById('anchor-button-container');
    if (anchorButtonContainer) {
        anchorButtonContainer.querySelector('a').classList.remove('toggled-on');
    }

    state.allCalculatedPaths = {};
    state.currentPath = [];
    state.animationPath = null;
    state.currentGridInfo = null;
    state.navigationState = 'SET_START';
    state.startPoint = null;
    state.endPoint = null;

    state.routeLayer.clearLayers();
    state.criticalPointsLayer.clearLayers();

    if (state.startMarker) state.startMarker.remove();
    if (state.endMarker) state.endMarker.remove();
    state.startMarker = null;
    state.endMarker = null;

    document.getElementById('metrics-display').classList.add('hidden');
    document.getElementById('compare-routes-button').classList.add('hidden');
    document.getElementById('profile-route-button').classList.add('hidden');
    UI.hideHud();

    if (showMsg) UI.showMessage('Route cleared. Ready for new route.', 'blue');
}

/**
 * Gathers parameters and calls the API to calculate routes.
 * @param {L.LatLng} start - The starting coordinates.
 * @param {L.LatLng} end - The ending coordinates.
 */
export async function calculateAndFetchRoute(start, end) {
    state.navigationState = 'CALCULATING';
    
    const payload = {
        start: { lat: start.lat, lng: start.lng },
        end: { lat: end.lat, lng: end.lng },
        shipLength: document.getElementById('shipLength').value, beam: document.getElementById('beam').value,
        speed: document.getElementById('shipSpeed').value, draft: document.getElementById('shipDraft').value,
        hpReq: document.getElementById('hpReq').value, fuelRate: document.getElementById('fuelRate').value,
        k: document.getElementById('hullFactor').value, baseWeight: document.getElementById('baseWeight').value,
        load: document.getElementById('load').value, F: document.getElementById('foulingFactor').value,
        S: document.getElementById('seaStateFactor').value,
        voyageDate: document.getElementById('voyageDate').value,
        noGoZones: state.noGoZones
    };

    const data = await API.fetchRoute(payload);

    if (data && Object.values(data.paths).some(p => p && p.length > 0)) {
        state.allCalculatedPaths = data.paths;
        state.currentGridInfo = { bounds: data.bounds, resolution: data.resolution };

        UI.drawAllPathsAndTooltips(map);
        
        document.getElementById('compare-routes-button').classList.remove('hidden');
        document.getElementById('profile-route-button').classList.remove('hidden');
        document.getElementById('routingStrategy').value = 'balanced';
        
        UI.updateMetricsForSelectedStrategy();

        state.navigationState = 'ROUTE_DISPLAYED';
        UI.showMessage('Routes found. Click a route or use analysis tools.', 'green');
    } else {
        resetNavigation(true);
        if (data) UI.showMessage('No valid route found for any strategy.', 'red');
    }
}
/**
 * Sets a pre-defined demo route.
 */
export function setDemoRoute() {
    resetNavigation(false);
    const demoStart = { lat: 1.290270, lng: 103.851959 };
    const demoEnd = { lat: -6.208763, lng: 106.845599 };
    state.startPoint = L.latLng(demoStart.lat, demoStart.lng);
    state.endPoint = L.latLng(demoEnd.lat, demoEnd.lng);
    state.startMarker = L.circleMarker(state.startPoint, { color: '#10b981', radius: 8, fillOpacity: 0.8 }).addTo(map);
    state.endMarker = L.circleMarker(state.endPoint, { color: '#ef4444', radius: 8, fillOpacity: 0.8 }).addTo(map);
    document.getElementById('startPort').value = 'Singapore';
    document.getElementById('endPort').value = 'Jakarta, Indonesia';
    map.fitBounds(L.latLngBounds([state.startPoint, state.endPoint]).pad(0.2));
    calculateAndFetchRoute(state.startPoint, state.endPoint);
}

/**
 * Calculates the total distance of a path.
 * @param {Array<object>} path - An array of path points.
 * @returns {number} The total distance in kilometers.
 */
export function calculateTotalDistance(path) {
    if (!path || path.length < 2) return 0;
    return turf.length(turf.lineString(path.map(p => [p.lng, p.lat])), { units: 'kilometers' });
}

/**
 * Starts or stops the boat animation.
 * @param {MouseEvent} event - The click event from the control button.
 */
export function toggleBoatAnimation(event) {
    const animButton = event.currentTarget.querySelector('a');
    if (!animButton) return;

    const isNowToggledOn = animButton.classList.toggle('toggled-on');

    if (isNowToggledOn) {
        if (state.animationPath && state.animationPath.length > 0) {
            playAnimation();
        } else {
            UI.showMessage('No route available to animate.', 'yellow');
            animButton.classList.remove('toggled-on');
        }
    } else {
        if (state.boatAnimator) state.boatAnimator.stopAnimation();
        if (state.gaPredictionTimer) clearInterval(state.gaPredictionTimer);
        UI.showMessage('Animation Paused.', 'blue');
        UI.hideHud();
        UI.updateMetricsForSelectedStrategy(); // Restore visibility of all routes
    }
}

/**
 * MERGED: Toggles the anchor status of the vessel.
 */
export function toggleAnchor() {
    state.isAnchored = !state.isAnchored; // Flip the state

    const anchorButton = document.getElementById('anchor-button');
    if (anchorButton) {
        anchorButton.classList.toggle('toggled-on', state.isAnchored);
    }

    if (state.isAnchored) {
        UI.showMessage('Vessel Anchored. All progress is paused.', 'yellow');
    } else {
        UI.showMessage('Anchors aweigh! Resuming voyage.', 'green');
    }
}


/**
 * Plays the boat animation and starts the AI prediction loop.
 */
function playAnimation() {
    // Hide non-selected routes
    const selectedStrategy = document.getElementById('routingStrategy').value;
    for (const strategy in state.routePolylines) {
        if (strategy !== selectedStrategy) {
            state.routePolylines[strategy]?.setStyle({ opacity: 0 });
        }
    }

    API.resetEnvLog();

    if (state.currentPath.length > 0) {
        const startPoint = state.currentPath[0];
        const startEnv = startPoint.env;

        startEnv.lat = startPoint.lat;
        startEnv.lon = startPoint.lng;

        UI.updateHudWithLiveData(startEnv);
        API.logEnvData(startEnv);

        const voyageDate = document.getElementById('voyageDate').value;
        const startPayload = { 
            lat: startPoint.lat, 
            lon: startPoint.lng, 
            date: voyageDate, 
            current_conditions: startEnv 
        };

        API.triggerPrediction(startPayload).then(data => UI.updatePredictionHud(data));

        if (state.gaPredictionTimer) clearInterval(state.gaPredictionTimer);
        state.gaPredictionTimer = setInterval(async () => {
            if (state.boatAnimator?.boatMarker) {
                const pos = state.boatAnimator.boatMarker.getLatLng();
                const payload = { 
                    lat: pos.lat, 
                    lon: pos.lng, 
                    date: voyageDate, 
                    current_conditions: state.currentLiveEnvData 
                };
                const data = await API.triggerPrediction(payload);
                UI.updatePredictionHud(data);
            }
        }, GA_PREDICTION_INTERVAL_MS);
    }

    UI.showMessage('Animation Playing...', 'green');
    const params = { speed: document.getElementById('shipSpeed').value, draft: document.getElementById('shipDraft').value };
    const totalDistanceKm = calculateTotalDistance(state.animationPath);

    state.boatAnimator.startAnimation(state.animationPath, params, totalDistanceKm, state.currentGridInfo);
    document.getElementById('navigation-hud').style.display = 'block';
}


// --- MERGED: Client-side recalculation logic ---

/**
 * Recalculates all stored paths with new vessel parameters from the UI.
 * This is triggered when the user changes a parameter like speed.
 */
export function recalculateAllPathsWithNewParams() {
    if (!state.allCalculatedPaths || Object.keys(state.allCalculatedPaths).length === 0) {
        return;
    }

    // Gather current parameters from all relevant UI inputs
    const params = {
        shipLength: parseFloat(document.getElementById('shipLength').value),
        beam: parseFloat(document.getElementById('beam').value),
        speed: parseFloat(document.getElementById('shipSpeed').value),
        draft: parseFloat(document.getElementById('shipDraft').value),
        hpReq: parseFloat(document.getElementById('hpReq').value),
        fuelRate: parseFloat(document.getElementById('fuelRate').value),
        k: parseFloat(document.getElementById('hullFactor').value),
        baseWeight: parseFloat(document.getElementById('baseWeight').value),
        load: parseFloat(document.getElementById('load').value),
        F: parseFloat(document.getElementById('foulingFactor').value),
        S: parseFloat(document.getElementById('seaStateFactor').value),
    };

    // Recalculate each path (balanced, fastest, safest)
    for (const strategy in state.allCalculatedPaths) {
        const originalPath = state.allCalculatedPaths[strategy];
        if (originalPath && originalPath.length > 0) {
            state.allCalculatedPaths[strategy] = _recalculateSinglePath(originalPath, params, strategy);
        }
    }

    // Trigger a UI update to show the new metrics
    UI.updateMetricsForSelectedStrategy();
}

/**
 * Recalculates metrics for a single path. Mimics server-side logic.
 */
function _recalculateSinglePath(path, params, strategy) {
    if (!path || path.length < 2) return path;

    const newPath = JSON.parse(JSON.stringify(path)); // Deep copy to avoid modifying original
    let cumulativeFuel = 0;
    let cumulativeTime = 0;

    newPath[0].totalFuel = 0;
    newPath[0].totalTime = 0;

    for (let i = 1; i < newPath.length; i++) {
        const fromPoint = newPath[i - 1];
        const toPoint = newPath[i];

        const segObj = _calculateSegmentCostClient(fromPoint, toPoint, params, strategy);

        const fuelCost = segObj.fuelCost || 0;
        const timeHours = segObj.timeHours || 0;

        cumulativeFuel += fuelCost;
        cumulativeTime += timeHours;

        newPath[i].totalFuel = cumulativeFuel;
        newPath[i].totalTime = cumulativeTime;
        newPath[i].segmentSpeed = segObj.effectiveSpeedKmh;
        newPath[i].segmentDistance = segObj.distanceKm;
        newPath[i].segmentTime = timeHours;
        newPath[i].segmentFuel = fuelCost;
    }
    return newPath;
}

/**
 * Client-side version of the segment cost calculation.
 */
function _calculateSegmentCostClient(fromPoint, toPoint, params, strategy = 'balanced') {
    const baseFuelPerKm = _calculateFuelPerKm(params);
    const distanceKm = turf.distance(turf.point([fromPoint.lng, fromPoint.lat]), turf.point([toPoint.lng, toPoint.lat]));

    if (distanceKm === 0) return { fuelCost: 0, distanceKm, effectiveSpeedKmh: params.speed * 1.852, timeHours: 0 };

    let weatherPenaltyWeight = 1.0, fuelWeight = 1.0;
    if (strategy === 'fastest') weatherPenaltyWeight = 0.2;
    else if (strategy === 'safest') weatherPenaltyWeight = 5.0;

    const envData = fromPoint.env || {};
    if (envData.depth === null || typeof envData.depth === 'undefined') {
        const penaltyFuel = baseFuelPerKm * distanceKm * 5;
        return {
            distanceKm,
            effectiveSpeedKmh: params.speed * 1.852,
            timeHours: distanceKm / Math.max(0.0001, params.speed * 1.852),
            fuelCost: penaltyFuel,
        };
    }

    let costMultiplier = 1.0;
    const boatBearing = turf.bearing(turf.point([fromPoint.lng, fromPoint.lat]), turf.point([toPoint.lng, toPoint.lat]));

    costMultiplier += weatherPenaltyWeight * _windCostMultiplier(boatBearing, baseFuelPerKm, 1, params, envData);
    costMultiplier += weatherPenaltyWeight * _currentCostMutiplier(boatBearing, params, envData);
    costMultiplier += weatherPenaltyWeight * _waveCostMutiplier(boatBearing, params, envData);
    costMultiplier += weatherPenaltyWeight * _rainCostMutiplier(params, envData);
    costMultiplier += weatherPenaltyWeight * _iceCostMutiplier(params, envData);
    costMultiplier += _depthCostMutiplier(params, envData);

    const baseSpeedKmh = params.speed * 1.852;
    const effectiveSpeedKmh = getEffectiveSpeed(baseSpeedKmh, envData, boatBearing, params);
    const timeHours = effectiveSpeedKmh > 0 ? (distanceKm / effectiveSpeedKmh) : Infinity;
    const fuelMultiplier = Math.max(0.5, 1.0 + (baseSpeedKmh - effectiveSpeedKmh) / Math.max(1e-6, baseSpeedKmh));
    const finalCost = baseFuelPerKm * distanceKm * fuelWeight * Math.max(0.1, costMultiplier) * fuelMultiplier;

    return {
        distanceKm,
        effectiveSpeedKmh,
        timeHours,
        fuelCost: finalCost,
    };
}


// --- Calculation Helpers (ported from a-star-pathfinder.js) ---

function _calculateFuelPerKm(params) {
    const { speed, hpReq, fuelRate, k = 0.005, baseWeight, load, F = 1, S = 1 } = params;
    const speedKmh = speed * 1.852;
    if (speedKmh <= 0) return Infinity;
    const totalWeight = (baseWeight || 0) + (load || 0);
    const weightFactor = totalWeight > 0 ? (1 + k * (load / baseWeight)) : 1;
    const fuelPerKm = (((hpReq * 0.62) * fuelRate * weightFactor * F * S) / speedKmh);
    return fuelPerKm || 0.1;
}

export function getEffectiveSpeed(baseSpeedKmh, envData, headingDeg, params) {
    let speedThroughWaterKmh = baseSpeedKmh;

    const waveHeight = envData.waves_height_m || 0;
    const waveDir = envData.wind_direction_deg || 0;
    const iceConc = envData.ice_conc || 0;
    const depth = envData.depth || Infinity;

    if (waveHeight > 0.1) {
        const relWaveAngle = Math.abs((waveDir - headingDeg + 360) % 360);
        let waveResistanceFactor = (relWaveAngle <= 60 || relWaveAngle >= 300) ? 1.0 : (relWaveAngle > 60 && relWaveAngle < 120) ? 0.4 : 0;
        const waveSpeedPenalty = (waveHeight * waveResistanceFactor * 0.10);
        speedThroughWaterKmh *= (1 - Math.min(0.75, waveSpeedPenalty));
    }

    if (iceConc > 0.05) {
        speedThroughWaterKmh *= (1 - Math.pow(iceConc, 2));
    }

    if (depth !== Infinity) {
        const depthToDraftRatio = depth / Math.max(0.1, params.draft);
        if (depthToDraftRatio < 1.2) speedThroughWaterKmh *= 0.2;
        else if (depthToDraftRatio < 1.5) speedThroughWaterKmh *= 0.6;
        else if (depthToDraftRatio < 3.0) speedThroughWaterKmh *= 0.9;
    }

    const currentSpeedMps = envData.current_speed_mps || 0;
    const currentDir = envData.current_direction_deg || 0;

    if (currentSpeedMps > 0.05) {
        const deg2rad = d => (d * Math.PI) / 180.0;
        const ship_x = speedThroughWaterKmh * Math.sin(deg2rad(headingDeg));
        const ship_y = speedThroughWaterKmh * Math.cos(deg2rad(headingDeg));
        const currentSpeedKmh = currentSpeedMps * 3.6;
        const cur_x = currentSpeedKmh * Math.sin(deg2rad(currentDir));
        const cur_y = currentSpeedKmh * Math.cos(deg2rad(currentDir));
        const effectiveSpeedKmh = Math.sqrt((ship_x + cur_x) ** 2 + (ship_y + cur_y) ** 2);
        return Math.max(0.5, effectiveSpeedKmh);
    }

    return Math.max(0.5, speedThroughWaterKmh);
}

function _windCostMultiplier(boatBearing, baseFuelPerKm, SFOC, params, envData) {
    if (!envData.wind_speed_mps) return 0;
    const Vship = params.speed * 0.514444, speed_kmh = Vship * 3.6;
    const A_front = 0.08 * params.beam * params.shipLength, A_side = 0.25 * params.beam * params.shipLength;
    const delta = (envData.wind_direction_deg - boatBearing + 360) % 360;
    let A, Cd, Vrel;
    if (delta <= 45 || delta >= 315) { A = A_front; Cd = 0.4; Vrel = Vship + envData.wind_speed_mps; }
    else if (delta >= 135 && delta <= 225) { A = A_front; Cd = 0.4; Vrel = Math.max(0, Math.abs(Vship - envData.wind_speed_mps)); }
    else { A = A_side; Cd = 0.6; Vrel = Math.sqrt(Vship * Vship + envData.wind_speed_mps * envData.wind_speed_mps); }
    const Fwind = 0.5 * 1.225 * Cd * A * Vrel * Vrel;
    const Padded_kW = (Fwind * Vship) / 1000.0, baseFuelPerHour_kg = (baseFuelPerKm * 1000) * speed_kmh;
    const Pbase_kW = baseFuelPerHour_kg / Math.max(SFOC, 1e-9);
    return Padded_kW / Math.max(Pbase_kW, 1e-6);
}
function _currentCostMutiplier(boatBearing, params, envData) {
    if (!envData.current_speed_mps) return 0;
    const deg2rad = d => (d * Math.PI) / 180.0, Vship = params.speed * 0.514444;
    const ship_x = Vship * Math.sin(deg2rad(boatBearing)), ship_y = Vship * Math.cos(deg2rad(boatBearing));
    const cur_x = envData.current_speed_mps * Math.sin(deg2rad(envData.current_direction_deg)), cur_y = envData.current_speed_mps * Math.cos(deg2rad(envData.current_direction_deg));
    const SOG_mps = Math.sqrt((ship_x + cur_x) ** 2 + (ship_y + cur_y) ** 2), SOG_kmh = SOG_mps * 3.6;
    if (SOG_kmh < 0.0001) return Infinity;
    return (((Vship * 3.6) / SOG_kmh) - 1) * 0.35;
}
function _waveCostMutiplier(boatBearing, params, envData) {
    if (!envData.waves_height_m) return 0;
    const displacement = (params.baseWeight + params.load) || 1;
    const k = 0.2 * (params.beam / params.shipLength) * (displacement) / 100000;
    const delta = Math.abs((envData.wind_direction_deg - boatBearing + 360) % 360);
    let factor = (delta <= 45 || delta >= 315) ? 1.0 : (delta >= 135 && delta <= 225) ? -0.3 : 0.4;
    return k * envData.waves_height_m * factor * ((params.speed * 0.514444) / (10 * 0.514444)) ** 2;
}
function _rainCostMutiplier(params, envData) {
    if (!envData.weekly_precip_mean) return 0;
    const displacement = (params.baseWeight + params.load) || 1;
    const sensitivity = 0.5 / Math.sqrt(displacement);
    let maxIncrease = 0.30 * Math.pow(500 / displacement, 0.2);
    if (maxIncrease > 0.50) return 5;
    maxIncrease = Math.min(0.30, Math.max(0.05, maxIncrease));
    return Math.min((sensitivity * envData.weekly_precip_mean), maxIncrease);
}
function _iceCostMutiplier(params, envData) {
    if (!envData.ice_conc) return 0;
    const displacement = (params.baseWeight + params.load) || 1;
    const bands = [{ max: 0.1, base: 0.0 }, { max: 0.3, base: 0.05 }, { max: 0.6, base: 0.15 }, { max: 0.8, base: 0.5 }, { max: 1.0, base: 1.0 }];
    let band = bands[bands.length - 1], lowerBound = 0;
    for (const b of bands) { if (envData.ice_conc <= b.max) { band = b; break; } lowerBound = b.max; }
    const concentrationIncrease = band.base * (0.5 + 0.5 * (envData.ice_conc - lowerBound) / Math.max(band.max - lowerBound, 1e-6));
    const iceCost = concentrationIncrease * Math.sqrt(10000 / displacement);
    return Math.max(0, Math.min(iceCost, 3.0));
}
function _depthCostMutiplier(params, envData) {
    if (!envData.depth) return 0;
    const depthToDraftRatio = envData.depth / params.draft;
    if (depthToDraftRatio > 5) return 0;
    if (depthToDraftRatio < 1.2) return 5;
    return Math.min(1 / Math.max(depthToDraftRatio - 1, 0.1), 1.0);
}
