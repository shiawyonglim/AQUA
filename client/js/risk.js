// js/risk.js
import { state } from './state.js';

// --- Physics-based Constants ---
const RHO_AIR = 1.225; // Density of air
const RHO_WATER = 1025.0; // Density of water

// --- Research-based Drag Coefficients ---
const DRAG_COEFFICIENTS = {
    panamax_container: { Cd_air: 1.25, Cd_wet: 1.1 },
    vlcc_tanker:       { Cd_air: 1.0,  Cd_wet: 1.2 },
    aframax_tanker:    { Cd_air: 1.0,  Cd_wet: 1.15 },
    handysize_bulk:    { Cd_air: 0.9,  Cd_wet: 1.0 },
    fishing_trawler:   { Cd_air: 1.3,  Cd_wet: 1.25 },
    cruise_ship:       { Cd_air: 0.75, Cd_wet: 0.8 },
    default:           { Cd_air: 1.0,  Cd_wet: 1.0 }
};

// --- Fine-tuning & Thresholds ---
export const RISK_THRESHOLDS = {
    environmentalRatio: 1.2, 
};
const INERTIA_CALIBRATION_FACTOR = 0.1;


function isPointDangerous(point, shipParams) {
    if (!point || !point.env) return false;

    const { shipLength, beam, draft, hpReq, shipSpeed, baseWeight, shipType } = shipParams;
    
    const coefficients = DRAG_COEFFICIENTS[shipType] || DRAG_COEFFICIENTS.default;
    const CD_AIR = coefficients.Cd_air;
    const CD_WET = coefficients.Cd_wet;

    const powerInWatts = Math.max(hpReq, 0) * 745.7;
    const speedInMps = Math.max(shipSpeed, 0) * 0.514444;
    const vesselResistance_N =
        speedInMps > 0 ? powerInWatts / speedInMps : Math.max(baseWeight * 1000 * 9.81 * 0.05, 1e-3);

    const freeboard_m = Math.max(draft * 0.7, shipLength * 0.05, 1);
    const Aproj_m2 = Math.max(shipLength * (beam + freeboard_m) * 0.35, 1);
    const Awet_m2 = Math.max(shipLength * draft * 0.85, 1);

    const windSpeed = Math.max(point.env.wind_speed_mps || 0, 0);
    const currentSpeed = Math.max(point.env.current_speed_mps || 0, 0);
    const waveHeight = Math.max(point.env.waves_height_m || 0, 0);

    const gustMultiplier = windSpeed > 15 ? 1 + Math.min((windSpeed - 15) * 0.02, 0.35) : 1;
    const displacementKg = Math.max(baseWeight * 1000, 1e4);
    const waveForce_N = 0.65 * displacementKg * 9.81 * (waveHeight / shipLength);

    const windForce_N = 0.5 * RHO_AIR * CD_AIR * Aproj_m2 * (windSpeed ** 2) * gustMultiplier;
    const currentForce_N = 0.5 * RHO_WATER * CD_WET * Awet_m2 * (currentSpeed ** 2);
    const totalEnvironmentalForce_N = windForce_N + currentForce_N + waveForce_N;

    const inertialMargin_N = (displacementKg * 9.81 * 0.08) * INERTIA_CALIBRATION_FACTOR;
    const thrustRatio = totalEnvironmentalForce_N / Math.max(vesselResistance_N, 1e-6);
    const inertiaRatio = totalEnvironmentalForce_N / Math.max(inertialMargin_N, 1e-6);
    const blendedRiskRatio = 0.6 * thrustRatio + 0.4 * inertiaRatio;

    if (point?.env) {
        point.env.riskScore = blendedRiskRatio;
    }

    return blendedRiskRatio > RISK_THRESHOLDS.environmentalRatio;
}

/**
 * --- CORRECTED & IMPROVED FUNCTION ---
 * This version now correctly finds and stores the MAXIMUM risk score and environmental
 * conditions for each identified peak danger zone.
 */
export function analyzePathForRisks(path) {
    if (!path || path.length === 0) return [];

    const shipParams = {
        shipLength: parseFloat(document.getElementById('shipLength').value) || 150,
        beam: parseFloat(document.getElementById('beam').value) || 20,
        draft: parseFloat(document.getElementById('shipDraft').value) || 10,
        baseWeight: parseFloat(document.getElementById('baseWeight').value) || 20000,
        hpReq: parseFloat(document.getElementById('hpReq').value) || 8000,
        shipSpeed: parseFloat(document.getElementById('shipSpeed').value) || 14,
        shipType: document.getElementById('shipType').value,
    };

    // Stage 1: Identify all dangerous points.
    const allDangerousPoints = [];
    path.forEach((point, index) => {
        if (isPointDangerous(point, shipParams)) {
            allDangerousPoints.push({ ...point, originalIndex: index });
        }
    });

    if (allDangerousPoints.length === 0) {
        state.riskyZones = [];
        return [];
    }
    
    // Stage 2: Filter for the top 30% "peak" points.
    allDangerousPoints.sort((a, b) => (b.env.riskScore || 0) - (a.env.riskScore || 0));
    const top30PercentCount = Math.ceil(allDangerousPoints.length * 0.3);
    const peakDangerPoints = allDangerousPoints.slice(0, top30PercentCount);
    peakDangerPoints.sort((a, b) => a.originalIndex - b.originalIndex);

    // Stage 3: Group the peak points and find the MAX values for each zone.
    const peakZones = [];
    let currentZone = null;
    peakDangerPoints.forEach((point, i) => {
        const currentRiskScore = point.env.riskScore || 0;

        if (!currentZone) {
            // Start a new zone, initializing details correctly.
            currentZone = {
                id: `peakzone-${Date.now()}-${peakZones.length}`,
                startIndex: point.originalIndex,
                endIndex: point.originalIndex,
                details: {
                    waves_height_m: point.env.waves_height_m,
                    wind_speed_mps: point.env.wind_speed_mps,
                    current_speed_mps: point.env.current_speed_mps,
                    maxRiskScore: currentRiskScore
                }
            };
        } else {
            const previousPoint = peakDangerPoints[i - 1];
            if (point.originalIndex === previousPoint.originalIndex + 1) {
                // The zone is continuous. Extend it and update the MAX values.
                currentZone.endIndex = point.originalIndex;
                currentZone.details.waves_height_m = Math.max(currentZone.details.waves_height_m, point.env.waves_height_m);
                currentZone.details.wind_speed_mps = Math.max(currentZone.details.wind_speed_mps, point.env.wind_speed_mps);
                currentZone.details.current_speed_mps = Math.max(currentZone.details.current_speed_mps || 0, point.env.current_speed_mps || 0);
                currentZone.details.maxRiskScore = Math.max(currentZone.details.maxRiskScore, currentRiskScore);
            } else {
                // There's a gap. Save the old zone and start a new one.
                peakZones.push(currentZone);
                currentZone = {
                    id: `peakzone-${Date.now()}-${peakZones.length}`,
                    startIndex: point.originalIndex,
                    endIndex: point.originalIndex,
                    details: {
                        waves_height_m: point.env.waves_height_m,
                        wind_speed_mps: point.env.wind_speed_mps,
                        current_speed_mps: point.env.current_speed_mps,
                        maxRiskScore: currentRiskScore
                    }
                };
            }
        }
    });
    if (currentZone) {
        peakZones.push(currentZone);
    }
    
    // Stage 4: Filter out single-point "phantom" zones.
    const finalDrawableZones = peakZones.filter(zone => zone.startIndex !== zone.endIndex);
    
    console.log(`Risk analysis found ${finalDrawableZones.length} peak dangerous zones.`);
    state.riskyZones = finalDrawableZones;
    return finalDrawableZones;
}

/**
 * --- REVISED & CORRECTED FUNCTION ---
 * Checks if the boat is near OR inside a risky zone that hasn't been notified yet.
 */
export function checkProximityToRisk(currentBoatIndex) {
    for (const zone of state.riskyZones) {
        const distanceToZone = zone.startIndex - currentBoatIndex;
        // Trigger if the boat is within 15 grid points of the zone OR is already inside it.
        if (distanceToZone <= 15) { 
            if (!state.notifiedRiskZones.has(zone.id)) {
                return zone; // Return the zone to trigger an alert.
            }
        }
    }
    return null; // No new alerts needed.
}

