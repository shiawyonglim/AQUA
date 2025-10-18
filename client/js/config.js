// config.js

// Ship Type Presets for easy selection in the UI
export const shipTypeDefaults = {
    fishing_trawler: { shipLength:35 ,beam:8 , baseWeight: 1500, load: 500, speed: 10, draft: 5, hpReq: 2000, fuelRate: 0.22 },
    handysize_bulk: { shipLength:130 ,beam:20 , baseWeight: 20000, load: 35000, speed: 14, draft: 10, hpReq: 8000, fuelRate: 0.20 },
    panamax_container: { shipLength:280 ,beam:30 ,baseWeight: 40000, load: 50000, speed: 20, draft: 12, hpReq: 40000, fuelRate: 0.19 },
    aframax_tanker: { shipLength:200 ,beam:30 , baseWeight: 55000, load: 100000, speed: 15, draft: 14, hpReq: 18000, fuelRate: 0.18 },
    vlcc_tanker: { shipLength:300 ,beam:58 ,baseWeight: 120000, load: 300000, speed: 16, draft: 20, hpReq: 30000, fuelRate: 0.18 },
    cruise_ship: { shipLength:365 ,beam:65 , baseWeight: 100000, load: 20000, speed: 22, draft: 8, hpReq: 90000, fuelRate: 0.21 }
};

// Interval for triggering the GA prediction during animation
export const GA_PREDICTION_INTERVAL_MS = 10000;