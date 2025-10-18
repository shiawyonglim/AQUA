// api.js
import { showLoadingIndicator, hideLoadingIndicator, showMessage } from './ui.js';

/**
 * Fetches the list of ports from the server.
 */
export async function fetchPorts() {
    try {
        const response = await fetch('/api/ports');
        if (!response.ok) throw new Error('Failed to load port data');
        return await response.json();
    } catch (error) {
        console.error('Error fetching port data:', error);
        showMessage('Could not load port data from server.', 'red');
        return [];
    }
}

/**
 * Sends route calculation request to the server.
 * @param {object} payload - The route request data.
 * @returns {Promise<object|null>} The server response or null on failure.
 */
export async function fetchRoute(payload) {
    showLoadingIndicator();
    try {
        const response = await fetch('/api/route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`Server error: ${response.statusText}`);
        return await response.json();
    } catch (error) {
        console.error('Error fetching route:', error);
        showMessage('Could not connect to the routing server.', 'red');
        return null;
    } finally {
        hideLoadingIndicator();
    }
}

/**
 * Triggers the AI prediction model on the Python server.
 * @param {object} payload - The data needed for prediction.
 */
export async function triggerPrediction(payload) {
    document.getElementById('prediction-status').textContent = `Running prediction...`;
    try {
        if (!payload || !payload.lat || !payload.lon || !payload.date || !payload.current_conditions) {
            throw new Error("Missing required parameters: lat, lon, date, or current_conditions.");
        }
        
        const response = await fetch(`/api/predict`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Unknown prediction error on server');
        }
        return await response.json();
    } catch (error) {
        console.error("Prediction failed:", error);
        showMessage(`Prediction Error: ${error.message}`, 'red');
        return null;
    }
}

/**
 * FIXED: Adds a timestamp and logs environmental data to the server's history file.
 * @param {object} envData - The environmental data point (must have lat/lon).
 */
export function logEnvData(envData) {
    if (!envData || typeof envData.lat === 'undefined' || typeof envData.lon === 'undefined') {
        console.error("Failed to log env data: Missing lat/lon.");
        return;
    }

    // Create the final log entry with a new timestamp
    const logEntry = {
        ...envData,
        timestamp: new Date().toISOString(),
    };

    fetch('/api/log_env_data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(logEntry)
    }).catch(error => console.error("Failed to log environmental data:", error));
}

/**
 * Resets the environmental log file on the server.
 */
export function resetEnvLog() {
    fetch('/api/reset_env_log', { method: 'POST' })
    .catch(error => console.error("Failed to reset history log:", error));
}