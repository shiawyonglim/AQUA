// state.js
import { BoatAnimator } from './boat.js';

// This object holds the shared state for the entire application.
// Other modules can import and modify this state as needed.
export const state = {
    // Navigation and Map State
    navigationState: 'SET_START',
    startPoint: null,
    endPoint: null,
    startMarker: null,
    endMarker: null,
    noGoZones: [],
    drawnItems: null,
    routeLayer: null,
    criticalPointsLayer: null,
    routePolylines: {},
    pathTooltip: null,
    
    // Data State
    allCalculatedPaths: {},
    currentPath: [],
    animationPath: null,
    portData: [],
    currentGridInfo: null,
    currentLiveEnvData: null,

    // Animation and Timers
    boatAnimator: null, // will be initialized in app.js
    gaPredictionTimer: null,

    // Chart instances
    comparisonChart: null,
    profileChart: null,
    
    // Risk and Anchoring State
    isAnchored: false,
    riskyZones: [], // Holds the identified dangerous segments of the path
    notifiedRiskZones: new Set(), // Tracks zone IDs for which alerts have been shown
    riskyZonesLayer: null, // A new layer group for the red risk zones
};
