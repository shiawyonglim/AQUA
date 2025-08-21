// ============================================================
// Express.js Pathfinding Server (server.js)
// with Fuel-Aware Pathfinding & Depth Data
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const NavigationGrid = require('./navigation-grid.js');
const AStarPathfinder = require('./a-star-pathfinder.js');
const DepthGrid = require('./depth-grid.js');

const app = express();
// IMPROVEMENT: Use the port from environment variables or default to 3001.
// This allows you to run `node server.js` (uses 3001) or `PORT=5000 node server.js` (uses 5000).
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

// Variable to hold the depth data
let landGrid = null;
let depthGrid = null;

function initializeServer() {
    console.log('Server starting up...');
    const landCachePath = path.join(__dirname, 'grid-cache.json');
    
    // Path for the depth cache file
    const depthCachePath = path.join(__dirname, 'depth-cache.json');

    if (fs.existsSync(landCachePath)) {
        console.log('Loading land navigation grid from cache...');
        landGrid = new NavigationGrid(JSON.parse(fs.readFileSync(landCachePath)));
        console.log('Land grid loaded.');
    } else {
        console.error('CRITICAL: grid-cache.json not found. Please generate it.');
    }

    // Logic to load the depth grid from cache
    if (fs.existsSync(depthCachePath)) {
        console.log('Loading depth grid from cache...');
        depthGrid = new DepthGrid(JSON.parse(fs.readFileSync(depthCachePath)));
        console.log('Depth grid loaded.');
    } else {
        console.warn('WARNING: depth-cache.json not found. Heatmap will not be available.');
    }

    console.log('Server is ready.');
}

// --- API ENDPOINTS ---

// Fuel-aware route endpoint
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
        
        // The depthGrid object is now passed to the AStarPathfinder constructor
        const pathfinder = new AStarPathfinder(depthGrid);

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

        const path = pathfinder.findPath(landGrid, { lat: startCoords[0], lng: startCoords[1] }, { lat: endCoords[0], lng: endCoords[1] }, params);
        
        res.json(path || []);
    } catch (error) {
        console.error("Error during pathfinding:", error);
        res.status(500).json({ error: "An error occurred during pathfinding." });
    }
});

// Land grid endpoint
app.get('/api/grid', (req, res) => {
    if (!landGrid) return res.status(503).json({ error: 'Grid data is not ready.' });
    res.json({ grid: landGrid.grid, bounds: landGrid.bounds, resolution: landGrid.resolution });
});

// Depth data endpoint for the heatmap
app.get('/api/depth', (req, res) => {
    if (!depthGrid) return res.status(404).json({ error: 'Depth data not found.' });
    res.json({ grid: depthGrid.grid, bounds: depthGrid.bounds, resolution: depthGrid.resolution });
});

// Endpoint to save a new copy of the grid data
app.post('/api/grid/update', (req, res) => {
    const newGridData = req.body;
    if (!newGridData || !newGridData.grid) return res.status(400).json({ error: 'Invalid grid data.' });
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

// --- START THE SERVER ---
app.listen(port, () => {
    initializeServer();
    console.log(`Pathfinding server listening at http://localhost:${port}`);
});
