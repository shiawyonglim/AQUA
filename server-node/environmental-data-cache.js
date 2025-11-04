// ===================================================================================
// environmental-data-cache.js (MODIFIED FOR SINGLE WIND FILE)
// -----------------------------------------------------------------------------------
// This version has been updated to read final wind data directly, removing the
// vector averaging logic for ascending and descending passes.
// ===================================================================================

const fetch = require('node-fetch');

function findClosestIndex(arr, target) {
    if (!arr || arr.length === 0) return -1;
    let low = 0, high = arr.length - 1;
    const isAscending = arr[low] < arr[high];
    if (isAscending) {
        if (target <= arr[low]) return low;
        if (target >= arr[high]) return high;
    } else {
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
        } else {
            if (midVal > target) low = mid + 1;
            else high = mid - 1;
        }
    }
    if (low >= arr.length) low = arr.length - 1;
    if (high < 0) high = 0;
    return Math.abs(arr[low] - target) <= Math.abs(arr[high] - target) ? low : high;
}

class EnvironmentalDataCache {
    constructor(startLatLng, endLatLng, landGrid, voyageDate) {
        this.voyageDate = voyageDate;
        this.data = null;
        this.FASTAPI_URL = "http://127.0.0.1:8000/get-data-grid-hybrid/";
        
        const PADDING = 5;
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
            
            const metaSize = buffer.readUInt32BE(0);
            const metaJSON = buffer.slice(4, 4 + metaSize).toString('utf-8');
            const metadata = JSON.parse(metaJSON);

            this.data = { lats: metadata.lats, lons: metadata.lons };
            let currentOffset = 4 + metaSize;

            for (const varInfo of metadata.variables) {
                const chunk = buffer.slice(currentOffset, currentOffset + varInfo.byte_length);
                const alignedBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length);
                const typedArray = new Float64Array(alignedBuffer);

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

        // --- MODIFIED: Read wind data directly, removing vector averaging ---
        const wind_speed_mps = getValue('wind_speed_mps');
        const wind_cardinal = Math.round(getValue('wind_cardinal'));
        
        // --- Read all other variables directly ---
        const depth = getValue('depth');
        const current_speed_mps = getValue('current_speed_mps');
        const current_cardinal = Math.round(getValue('current_cardinal'));
        const waves_height_m = getValue('waves_height');
        const weekly_precip_mean = getValue('precipitation');
        const ice_conc = getValue('ice_conc');
        
        return {
            depth: (depth > -9999) ? depth : null,
            // --- MODIFIED: Use the new direct wind variables ---
            wind_speed_mps: (wind_speed_mps > -9999) ? wind_speed_mps : null,
            wind_direction_deg: (wind_cardinal > -9999) ? (wind_cardinal * 45) : null,
            
            current_speed_mps: (current_speed_mps > -9999) ? current_speed_mps : null,
            current_direction_deg: (current_cardinal > -9999) ? (current_cardinal * 45) : null,
            waves_height_m: (waves_height_m > -9999) ? waves_height_m : null,
            weekly_precip_mean: (weekly_precip_mean > -9999) ? weekly_precip_mean : null,
            ice_conc: (ice_conc > -9999) ? ice_conc : null
        };
    }
}

module.exports = EnvironmentalDataCache;