// ============================================================
// Express.js Pathfinding Server (server.js)
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const fetch = require('node-fetch');

const NavigationGrid = require('./navigation-grid.js');
const AStarPathfinder = require('./a-star-pathfinder.js');
const EnvironmentalDataCache = require('./environmental-data-cache.js');


const app = express();
const port = 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

let landGrid = null;
let temporaryGrid = null; // To hold user-uploaded grids in memory
let portData = [];
const ENV_HISTORY_FILE = path.join(__dirname, 'cache', 'environmental_history.json');

// Ensure cache directory exists for history log
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}


function initializeServer() {
    console.log('Server starting up...');
    const landCachePath = path.join(__dirname, './cache/grid-cache.json');

    if (fs.existsSync(landCachePath)) {
        console.log('Loading land navigation grid from cache...');
        landGrid = new NavigationGrid(JSON.parse(fs.readFileSync(landCachePath)));
        console.log('Land grid loaded.');
    } else {
        console.error('CRITICAL: grid-cache.json not found. Please generate it.');
    }

    const portFilePath = path.join(__dirname, './cache/ports.csv');
    if (fs.existsSync(portFilePath)) {
        console.log('Loading port data from CSV...');
        fs.createReadStream(portFilePath)
            .pipe(csv())
            .on('data', (row) => {
                const lat = parseFloat(row['Latitude']);
                const lng = parseFloat(row['Longitude']);
                const portName = row['Main Port Name'];
                const country = row['Country Code'];

                if (portName && country && !isNaN(lat) && !isNaN(lng)) {
                    portData.push({ name: `${portName}, ${country}`, lat: lat, lng: lng });
                }
            })
            .on('end', () => {
                console.log(`Successfully loaded ${portData.length} ports.`);
                console.log('Server is ready.');
            });
    } else {
        console.error('CRITICAL: ports.csv not found.');
        console.log('Server is ready (but port search will not work).');
    }
}


app.get('/api/ports', (req, res) => {
    if (portData.length > 0) res.json(portData);
    else res.status(503).json({ error: 'Port data is not ready or failed to load.' });
});

// NEW ENDPOINT: Log current environmental data point to history file
app.post('/api/log_env_data', (req, res) => {
    const newLogEntry = req.body;
    
    if (!newLogEntry || !newLogEntry.timestamp) {
        return res.status(400).json({ error: 'Invalid log entry received.' });
    }

    try {
        let history = [];
        if (fs.existsSync(ENV_HISTORY_FILE)) {
            const rawData = fs.readFileSync(ENV_HISTORY_FILE, 'utf8');
            history = JSON.parse(rawData);
        }
        
        history.push(newLogEntry);
        fs.writeFileSync(ENV_HISTORY_FILE, JSON.stringify(history, null, 2));
        
        res.status(200).json({ message: 'Log appended.' });
    } catch (error) {
        console.error("Error logging environmental data:", error);
        res.status(500).json({ error: 'Failed to write to history log.' });
    }
});

// NEW ENDPOINT: Clear the history log at the start of a new animation
app.post('/api/reset_env_log', (req, res) => {
    try {
        fs.writeFileSync(ENV_HISTORY_FILE, JSON.stringify([], null, 2));
        console.log("Environmental history log reset.");
        res.status(200).json({ message: 'History log reset.' });
    } catch (error) {
        console.error("Error resetting environmental data log:", error);
        res.status(500).json({ error: 'Failed to clear history log.' });
    }
});

// ENDPOINT: Trigger the GA Prediction in the Python data server
app.post('/api/predict', async (req, res) => {
    // This endpoint receives data via POST body
    const { lat, lon, date, current_conditions } = req.body;

    if (!lat || !lon || !date || !current_conditions) {
        return res.status(400).json({ error: 'Missing required parameters: lat, lon, date, or current_conditions.' });
    }

    const PYTHON_PREDICTOR_URL = "http://127.0.0.1:8000/api/predict_next_step";
    
    // Construct the payload for the Python server
    const payload = {
        lat: parseFloat(lat),
        lon: parseFloat(lon),
        date: date,
        current_conditions: current_conditions // Pass the captured HUD data
    };

    try {
        console.log(`Requesting GA prediction from Python server at ${PYTHON_PREDICTOR_URL}...`);
        
        const response = await fetch(PYTHON_PREDICTOR_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("Python Prediction Error:", data.error);
            return res.status(response.status).json({ error: data.error || 'Prediction service failed on the Python server.' });
        }
        
        console.log("Prediction successful. Data written to historical_data.json.");
        return res.json({ message: 'Prediction successful and data saved.', forecast: data });

    } catch (error) {
        console.error("Error communicating with Python prediction server:", error);
        res.status(500).json({ error: 'Failed to connect to the prediction server. Is data_server.py running?' });
    }
});

// MODIFIED: Changed from app.get to app.post to handle no-go zones in the body
app.post('/api/route', async (req, res) => {
    const gridToUse = temporaryGrid || landGrid;
    if (!gridToUse) {
        return res.status(503).json({ error: 'Pathfinder is not ready yet.' });
    }
    
    // MODIFIED: Read parameters from req.body
    const { 
        start, end, shipLength, beam, speed, draft, hpReq, fuelRate, 
        k, baseWeight, load, F, S, voyageDate, noGoZones 
    } = req.body;

    const requiredParams = { start, end, shipLength, beam, speed, draft, hpReq, fuelRate, k, baseWeight, load, F, S, voyageDate };
    for (const param in requiredParams) {
        if (!requiredParams[param]) {
            return res.status(400).json({ error: `Missing required parameter: ${param}.` });
        }
    }

    try {
        const startCoords = start; // Already an object {lat, lng}
        const endCoords = end;     // Already an object {lat, lng}
        const envCache = new EnvironmentalDataCache(
            { lat: startCoords.lat, lng: startCoords.lng },
            { lat: endCoords.lat, lng: endCoords.lng },
            gridToUse,
            voyageDate
        );

        let cacheInitialized = false;
        const maxRetries = 3;
        const retryDelay = 2000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            console.log(`Attempt ${attempt} to fetch environmental data...`);
            cacheInitialized = await envCache.initialize();
            if (cacheInitialized) {
                console.log('Successfully fetched data.');
                break; 
            }
            if (attempt < maxRetries) {
                console.log(`Failed. Retrying in ${retryDelay / 1000} seconds...`);
                await new Promise(res => setTimeout(res, retryDelay));
            }
        }

        if (!cacheInitialized) {
            return res.status(500).json({ error: "Failed to initialize environmental data cache after multiple attempts. The Python server might be down or busy." });
        }

        const pathfinder = new AStarPathfinder();
        const params = {
            shipLength: parseFloat(shipLength), beam: parseFloat(beam),
            speed: parseFloat(speed), draft: parseFloat(draft), hpReq: parseFloat(hpReq),
            fuelRate: parseFloat(fuelRate), k: parseFloat(k), baseWeight: parseFloat(baseWeight),
            load: parseFloat(load), F: parseFloat(F), S: parseFloat(S)
        };
            
        // MODIFIED: Call pathfinder to get all strategy paths, now including noGoZones
        const allPaths = pathfinder.findPath(
            gridToUse,
            { lat: startCoords.lat, lng: startCoords.lng },
            { lat: endCoords.lat, lng: endCoords.lng },
            params,
            envCache,
            noGoZones // NEW: Pass zones to pathfinder
        );
        
        // --- ENRICH AND SANITIZE ALL PATHS ---
        const sanitizedPaths = {};
        for (const strategy in allPaths) {
            const path = allPaths[strategy];
            if (!path || path.length === 0) {
                sanitizedPaths[strategy] = [];
                continue;
            }

            const enrichedPath = path.map(point => {
                const envDataAtPoint = envCache.getData(point.lat, point.lng);
                return { ...point, env: envDataAtPoint };
            });
            
            sanitizedPaths[strategy] = enrichedPath.filter(point => 
                Number.isFinite(point.lat) && Number.isFinite(point.lng)
            );
        }

        res.json({ paths: sanitizedPaths, bounds: gridToUse.bounds, resolution: gridToUse.resolution });

    } catch (error) {
        console.error("Error during pathfinding:", error);
        res.status(500).json({ error: "An error occurred during pathfinding." });
    }
});


app.get('/api/grid', (req, res) => {
    if (!landGrid) return res.status(503).json({ error: 'Grid data is not ready.' });
    res.json({ grid: landGrid.grid, bounds: landGrid.bounds, resolution: landGrid.resolution });
});

app.post('/api/grid/update', (req, res) => {
    const newGridData = req.body;
    if (!newGridData || !newGridData.grid) return res.status(400).json({ error: 'Invalid grid data.' });
    try {
        const timestamp = Date.now();
        const newCacheFilename = `grid-cache-${timestamp}.json`;
        const newCachePath = path.join(__dirname, 'cache', newCacheFilename);
        fs.writeFileSync(newCachePath, JSON.stringify(newGridData, null, 2));
        console.log(`New grid cache saved to: ${newCacheFilename}`);
        res.status(200).json({ message: 'New grid copy saved!', filename: newCacheFilename });
    } catch (error) {
        console.error('Error saving new grid cache:', error);
        res.status(500).json({ error: 'Failed to save grid updates.' });
    }
});

app.post('/api/grid/temporary-upload', (req, res) => {
    const newGridData = req.body;
    if (!newGridData || !newGridData.grid || !newGridData.bounds) {
        return res.status(400).json({ error: 'Invalid grid data.' });
    }
    try {
        temporaryGrid = new NavigationGrid(newGridData);
        console.log('Temporary grid received and loaded into memory.');
        res.status(200).json({ message: 'Temporary grid loaded successfully.' });
    } catch (error) {
        console.error('Error loading temporary grid:', error);
        temporaryGrid = null; // Clear on error
        res.status(500).json({ error: 'Failed to process temporary grid.' });
    }
});

app.listen(port, () => {
    initializeServer();
    console.log(`Pathfinding server listening at http://localhost:${port}`);
});