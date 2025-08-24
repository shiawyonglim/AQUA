// ============================================================
// Express.js Pathfinding Server (server.js) - CORRECTED
// ============================================================

// --- MODULE IMPORTS ---
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const geotiff = require('geotiff'); // Library to read GeoTIFF files

// --- CUSTOM MODULE IMPORTS ---
const NavigationGrid = require('./navigation-grid.js');
const AStarPathfinder = require('./a-star-pathfinder.js');

// --- EXPRESS APP SETUP ---
const app = express();
const port = 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

// --- GLOBAL STATE VARIABLES ---
let landGrid = null;
let depthImage = null; // This will hold the loaded TIF image data
let portData = [];

/**
 * Asynchronously retrieves the depth value for a given longitude and latitude
 * from the loaded GeoTIFF file.
 * @param {number} lon The longitude.
 * @param {number} lat The latitude.
 * @returns {Promise<number>} A promise that resolves to the depth value.
 */
async function getDepthFromTif(lon, lat) {
    if (!depthImage) {
        return 100; // Return safe depth if TIF not loaded
    }

    const bbox = depthImage.getBoundingBox();
    if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) {
        return 100; // Return safe depth for out-of-bounds coordinates
    }

    const [originX, originY] = depthImage.getOrigin();
    const [resX, resY] = depthImage.getResolution();
    const pixelX = Math.floor((lon - originX) / resX);
    const pixelY = Math.floor((lat - originY) / resY);

    if (pixelX < 0 || pixelX >= depthImage.getWidth() || pixelY < 0 || pixelY >= depthImage.getHeight()) {
        return 100;
    }

    try {
        const data = await depthImage.readRasters({
            window: [pixelX, pixelY, pixelX + 1, pixelY + 1],
        });
        const depth = data[0][0];
        // Handle "no data" values, often represented by a large negative number
        if (depth < -30000) {
            return 100;
        }
        return depth;
    } catch (error) {
        console.error(`Error reading raster data for ${lon}, ${lat}:`, error);
        return 100; // Return safe depth on error
    }
}


/**
 * Initializes server data by loading all necessary files into memory.
 * This function is now async to handle loading the TIF file.
 */
async function initializeServer() {
    console.log('Server starting up...');
    const landCachePath = path.join(__dirname, './cache/grid-cache.json');
    const depthTifPath = path.join(__dirname, './cache/depth-cache.tif'); // Path to TIF file
    const portFilePath = path.join(__dirname, './cache/ports.csv'); // Make sure this path is correct

    // 1. Load land grid
    if (fs.existsSync(landCachePath)) {
        console.log('Loading land navigation grid from cache...');
        landGrid = new NavigationGrid(JSON.parse(fs.readFileSync(landCachePath)));
        console.log('Land grid loaded.');
    } else {
        console.error('CRITICAL: grid-cache.json not found. Please generate it.');
    }

    // 2. Load depth data from GeoTIFF
    if (fs.existsSync(depthTifPath)) {
        try {
            console.log('Loading depth data from depth-cache.tif...');
            const tif = await geotiff.fromFile(depthTifPath);
            depthImage = await tif.getImage();
            console.log('Depth TIF data loaded successfully.');
        } catch (error) {
            console.error('CRITICAL: Failed to load or parse depth-cache.tif.', error);
        }
    } else {
        console.warn('WARN: depth-cache.tif not found. Depth checks will be skipped.');
    }

    // 3. Load port data
    if (fs.existsSync(portFilePath)) {
        console.log('Loading port data from CSV...');
        fs.createReadStream(portFilePath)
            .pipe(csv())
            .on('data', (row) => {
                 // Assuming CSV has 'Main Port Name', 'Country Code', 'Latitude', 'Longitude'
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
            });
    } else {
        console.warn('WARNING: ports.csv not found.');
    }
}

// --- API ENDPOINTS ---

app.get('/api/ports', (req, res) => {
    res.json(portData);
});

// MODIFIED: This endpoint is now async to handle the async pathfinder
app.get('/api/route', async (req, res) => {
    if (!landGrid) {
        return res.status(503).json({ error: 'Pathfinder is not ready yet.' });
    }
    
    // Extract parameters from query string
    const { start, end, draft } = req.query;

    if (!start || !end || !draft) {
        return res.status(400).json({ error: 'Missing required parameters: start, end, and draft.' });
    }

    try {
        const startCoords = { lat: parseFloat(start.split(',')[0]), lon: parseFloat(start.split(',')[1]) };
        const endCoords = { lat: parseFloat(end.split(',')[0]), lon: parseFloat(end.split(',')[1]) };
        
        // CRITICAL FIX: Initialize AStarPathfinder with the required parameters
        const pathfinder = new AStarPathfinder(landGrid, {
            draft: parseFloat(draft),
            getDepthFunction: getDepthFromTif // Pass the async function to get depth
        });

        // The findPath method is now async and must be awaited
        const result = await pathfinder.findPath(startCoords, endCoords);
        
        if (result.path && result.path.length > 0) {
            res.json(result.path);
        } else {
            res.status(404).json({ error: "No path could be found." });
        }

    } catch (error) {
        console.error("Error during pathfinding:", error);
        res.status(500).json({ error: "An error occurred during pathfinding." });
    }
});

app.get('/api/grid', (req, res) => {
    if (!landGrid) return res.status(503).json({ error: 'Grid data is not ready.' });
    res.json({ grid: landGrid.grid, bounds: landGrid.bounds, resolution: landGrid.resolution });
});

// REMOVED: The old /api/depth endpoint is no longer needed as depth is handled internally
// app.get('/api/depth', ...);

app.post('/api/grid/update', (req, res) => {
    const newGridData = req.body;
    if (!newGridData || !newGridData.grid) return res.status(400).json({ error: 'Invalid grid data.' });
    try {
        const timestamp = Date.now();
        const newCacheFilename = `grid-cache-${timestamp}.json`;
        const newCachePath = path.join(__dirname, 'cache', newCacheFilename); // Save in cache folder
        fs.writeFileSync(newCachePath, JSON.stringify(newGridData, null, 2));
        console.log(`New grid cache saved to: ${newCacheFilename}`);
        res.status(200).json({ message: 'New grid copy saved!', filename: newCacheFilename });
    } catch (error) {
        console.error('Error saving new grid cache:', error);
        res.status(500).json({ error: 'Failed to save grid updates.' });
    }
});

// --- SERVER INITIALIZATION ---
// Initialize data first, then start listening for requests.
initializeServer().then(() => {
    app.listen(port, () => {
        console.log(`Pathfinding server listening at http://localhost:${port}`);
        console.log('Server is ready.');
    });
}).catch(error => {
    console.error("FATAL: Server failed to initialize.", error);
    process.exit(1);
});
