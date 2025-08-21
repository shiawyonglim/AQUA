// ============================================================
// Express.js Pathfinding Server (server.js)
// with Fuel-Aware Pathfinding, Depth Data & Port Search
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser'); // CSV parsing library

const NavigationGrid = require('./navigation-grid.js');
const AStarPathfinder = require('./a-star-pathfinder.js');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

let landGrid = null;
let depthGrid = null;   // now will hold raw JSON object, not NavigationGrid
let portData = [];      // cache for port data

function initializeServer() {
    console.log('Server starting up...');
    const landCachePath = path.join(__dirname, 'grid-cache.json');
    const depthCachePath = path.join(__dirname, 'depth-cache.json');

    // --- Load Land Grid ---
    if (fs.existsSync(landCachePath)) {
        console.log('Loading land navigation grid from cache...');
        landGrid = new NavigationGrid(JSON.parse(fs.readFileSync(landCachePath)));
        console.log('Land grid loaded.');
    } else {
        console.error('CRITICAL: grid-cache.json not found. Please generate it.');
    }

    // --- Load Depth Grid (raw JSON, not NavigationGrid) ---
    if (fs.existsSync(depthCachePath)) {
        console.log('Loading depth grid from cache...');
        depthGrid = JSON.parse(fs.readFileSync(depthCachePath));
        console.log('Depth grid loaded.');
    } else {
        console.warn('WARNING: depth-cache.json not found. Heatmap will not be available.');
    }

    // --- Load Port Data from CSV ---
    const portFilePath = path.join(__dirname, 'WorldPort_2025.csv');
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
                    portData.push({
                        name: `${portName}, ${country}`,
                        lat: lat,
                        lng: lng
                    });
                }
            })
            .on('end', () => {
                console.log(`Successfully loaded ${portData.length} ports.`);
                console.log('Server is ready.');
            });
    } else {
        console.error('CRITICAL: WorldPort_2025.csv not found.');
        console.log('Server is ready (but port search will not work).');
    }
}

// ============================================================
// API ENDPOINTS
// ============================================================

// --- Serve Port Data ---
app.get('/api/ports', (req, res) => {
    if (portData.length > 0) {
        res.json(portData);
    } else {
        res.status(503).json({ error: 'Port data is not ready or failed to load.' });
    }
});

// --- Fuel-aware Route (A* pathfinding) ---
app.get('/api/route', (req, res) => {
    if (!landGrid) {
        return res.status(503).json({ error: 'Pathfinder is not ready yet.' });
    }
    
    const { start, end, speed, hpReq, fuelRate, k, baseWeight, load, F, S } = req.query;

    if (!start || !end || !speed || !hpReq || !fuelRate || !k || !baseWeight || !load || !F || !S) {
        return res.status(400).json({ error: 'Missing required fuel calculation parameters.' });
    }

    try {
        const startCoords = start.split(',').map(Number);
        const endCoords = end.split(',').map(Number);
        
        const pathfinder = new AStarPathfinder();

        const params = {
            speed: parseFloat(speed),
            hpReq: parseFloat(hpReq),
            fuelRate: parseFloat(fuelRate),
            k: parseFloat(k),
            baseWeight: parseFloat(baseWeight),
            load: parseFloat(load),
            F: parseFloat(F),
            S: parseFloat(S)
        };

        const path = pathfinder.findPath(
            landGrid,
            { lat: startCoords[0], lng: startCoords[1] },
            { lat: endCoords[0], lng: endCoords[1] },
            params
        );
        
        res.json(path || []);
    } catch (error) {
        console.error("Error during pathfinding:", error);
        res.status(500).json({ error: "An error occurred during pathfinding." });
    }
});

// --- Land Grid ---
app.get('/api/grid', (req, res) => {
    if (!landGrid) return res.status(503).json({ error: 'Grid data is not ready.' });
    res.json({
        grid: landGrid.grid,
        bounds: landGrid.bounds,
        resolution: landGrid.resolution
    });
});

// --- Depth Grid (raw JSON from Python) ---
app.get('/api/depth', (req, res) => {
    if (!depthGrid) return res.status(404).json({ error: 'Depth data not found.' });
    res.json(depthGrid);
});

// --- Save Updated Grid (land) ---
app.post('/api/grid/update', (req, res) => {
    const newGridData = req.body;
    if (!newGridData || !newGridData.grid) {
        return res.status(400).json({ error: 'Invalid grid data.' });
    }
    try {
        const timestamp = Date.now();
        const newCacheFilename = `grid-cache-${timestamp}.json`;
        const newCachePath = path.join(__dirname, newCacheFilename);
        fs.writeFileSync(newCachePath, JSON.stringify(newGridData, null, 2));
        console.log(`New grid cache saved to: ${newCacheFilename}`);
        res.status(200).json({ message: 'New grid copy saved!', filename: newCacheFilename });
    } catch (error) {
        console.error('Error saving new grid cache:', error);
        res.status(500).json({ error: 'Failed to save grid updates.' });
    }
});

// ============================================================
// START SERVER
// ============================================================
app.listen(port, () => {
    initializeServer();
    console.log(`Pathfinding server listening at http://localhost:${port}`);
});
