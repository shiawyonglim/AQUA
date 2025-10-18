// ===================================================================================
// environmental-data-cache.js (MODIFIED FOR BOUNDED BOX REQUESTS)
// -----------------------------------------------------------------------------------
// This version has been updated to request a smaller, more efficient "bounding box"
// of data from the Python server instead of the entire global dataset.
// ===================================================================================

const fetch = require('node-fetch');

/**
 * A robust binary-search-based function to find the closest index for a target value
 * in an array that can be sorted in either ascending or descending order.
 * @param {Array<number>} arr The sorted array of numbers (lats or lons).
 * @param {number} target The target value (a specific lat or lon).
 * @returns {number} The closest index in the array, or -1 if the array is invalid.
 */
function findClosestIndex(arr, target) {
    if (!arr || arr.length === 0) {
        return -1;
    }

    let low = 0;
    let high = arr.length - 1;
    const isAscending = arr[low] < arr[high];

    if (isAscending) {
        if (target <= arr[low]) return low;
        if (target >= arr[high]) return high;
    } else { // Descending
        if (target >= arr[low]) return low;
        if (target <= arr[high]) return high;
    }

    while (low <= high) {
        const mid = Math.floor(low + (high - low) / 2);
        const midVal = arr[mid];
        if (midVal === target) return mid;
        if (isAscending) {
            if (midVal < target) low = mid + 1;
            else high = mid - 1;
        } else { // Descending
            if (midVal > target) low = mid + 1;
            else high = mid - 1;
        }
    }

    if (low >= arr.length) low = arr.length - 1;
    if (high < 0) high = 0;
    const distLow = Math.abs(arr[low] - target);
    const distHigh = Math.abs(arr[high] - target);
    return distLow <= distHigh ? low : high;
}


 //A class to manage fetching, caching, and accessing environmental data for a voyage.
 
class EnvironmentalDataCache {
    constructor(startLatLng, endLatLng, landGrid, voyageDate) {
        this.voyageDate = voyageDate;
        this.data = null;
        this.FASTAPI_URL = "http://127.0.0.1:8000/get-data-grid-hybrid/";
        this.debugCounter = 0;
        this.debugLogInterval = 500;
        
        // --- MODIFIED: Calculate a bounding box instead of using the full map ---
        const PADDING = 5; // Add 5 degrees of padding around the route for flexibility
        this.bounds = {
            min_lat: Math.max(-90, Math.min(startLatLng.lat, endLatLng.lat) - PADDING),
            max_lat: Math.min(90, Math.max(startLatLng.lat, endLatLng.lat) + PADDING),
            min_lon: Math.max(-180, Math.min(startLatLng.lng, endLatLng.lng) - PADDING),
            max_lon: Math.min(180, Math.max(startLatLng.lng, endLatLng.lng) + PADDING),
        };
    }

    async initialize() {
        console.log(`Fetching environmental data for bounding box:`, this.bounds);
        try {
            const response = await fetch(this.FASTAPI_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...this.bounds, date: this.voyageDate }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`FastAPI server error: ${response.statusText}. Details: ${errorText}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            console.log(`Received hybrid response of size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

            const metaSize = buffer.readUInt32BE(0);
            const metaJSON = buffer.slice(4, 4 + metaSize).toString('utf-8');
            const metadata = JSON.parse(metaJSON);

            this.data = { lats: metadata.lats, lons: metadata.lons };
            let currentOffset = 4 + metaSize;

            for (const varInfo of metadata.variables) {
                const chunk = buffer.slice(currentOffset, currentOffset + varInfo.byte_length);
                let typedArray;
                if (varInfo.dtype === 'float64') {
                    const alignedBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length);
                    typedArray = new Float64Array(alignedBuffer);
                } else {
                    console.warn(`Unsupported dtype '${varInfo.dtype}'. Skipping.`);
                    currentOffset += varInfo.byte_length;
                    continue;
                }
                const grid = [];
                const [rows, cols] = varInfo.shape;
                for (let i = 0; i < rows; i++) {
                    grid.push(Array.from(typedArray.slice(i * cols, (i * cols) + cols)));
                }
                this.data[varInfo.name] = grid;
                currentOffset += varInfo.byte_length;
            }
            console.log(`Successfully cached environmental data grid (${this.data.lats.length}x${this.data.lons.length}).`);
            return true;
        } catch (error) {
            console.error("--- ENVIRONMENTAL CACHE ERROR ---", error);
            this.data = null;
            return false;
        }
    }

    getData(lat, lon) {
        if (!this.data) {
            return { depth: null, wind_speed_mps: 0, wind_direction_deg: 0, current_speed_mps: 0, current_direction_deg: 0, waves_height_m: 0, weekly_precip_mean: 0, ice_conc: 0 };
        }

        const lat_idx = findClosestIndex(this.data.lats, lat);
        const lon_idx = findClosestIndex(this.data.lons, lon);

        const getValue = (gridName, defaultVal = -9999) => {
            const grid = this.data[gridName];
            return (grid?.[lat_idx]?.[lon_idx] !== undefined) ? grid[lat_idx][lon_idx] : defaultVal;
        };

        // --- Wind Vector Averaging ---
        const speed_asc = getValue('wind_speed_mps_asc');
        const card_asc = getValue('wind_cardinal_asc');
        const speed_dsc = getValue('wind_speed_mps_dsc');
        const card_dsc = getValue('wind_cardinal_dsc');
        
        let final_wind_speed = 0;
        let final_wind_cardinal = 0;

        if (speed_asc > -9999 && speed_dsc > -9999 && (speed_asc > 0 || speed_dsc > 0)) {
            const angle_asc_rad = (90 - (card_asc * 45)) * (Math.PI / 180);
            const angle_dsc_rad = (90 - (card_dsc * 45)) * (Math.PI / 180);
            const x_asc = speed_asc * Math.cos(angle_asc_rad);
            const y_asc = speed_asc * Math.sin(angle_asc_rad);
            const x_dsc = speed_dsc * Math.cos(angle_dsc_rad);
            const y_dsc = speed_dsc * Math.sin(angle_dsc_rad);
            
            const x_avg = (x_asc + x_dsc) / 2;
            const y_avg = (y_asc + y_dsc) / 2;
            
            final_wind_speed = Math.sqrt(x_avg**2 + y_avg**2);
            const final_angle_rad = Math.atan2(y_avg, x_avg);
            const final_angle_deg = (final_angle_rad * (180 / Math.PI));
            
            const cardinal_float = (90 - final_angle_deg) / 45.0;
            final_wind_cardinal = Math.round((cardinal_float % 8 + 8) % 8);
        }

        const depth = getValue('depth');
        const current_speed_mps = getValue('current_speed_mps');
        const current_cardinal = Math.round(getValue('current_cardinal'));
        const waves_height_m = getValue('waves_height');
        const weekly_precip_mean = getValue('precipitation');
        const ice_conc = getValue('ice_conc');
        
        return {
            depth: (depth > -9999) ? depth : null,
            wind_speed_mps: (final_wind_speed > -9999) ? final_wind_speed : null,
            wind_direction_deg: (final_wind_cardinal > -9999) ? (final_wind_cardinal * 45) : null,
            current_speed_mps: (current_speed_mps > -9999) ? current_speed_mps : null,
            current_direction_deg: (current_cardinal > -9999) ? (current_cardinal * 45) : null,
            waves_height_m: (waves_height_m > -9999) ? waves_height_m : null,
            weekly_precip_mean: (weekly_precip_mean > -9999) ? weekly_precip_mean : null,
            ice_conc: (ice_conc > -9999) ? ice_conc : null
        };
    }
}

module.exports = EnvironmentalDataCache;
