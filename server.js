// ============================================================
// Express.js Pathfinding Server (server.js)
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

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

app.get('/api/route', async (req, res) => {
    const gridToUse = temporaryGrid || landGrid; // Prioritize temporary grid if it exists
    if (!gridToUse) {
        return res.status(503).json({ error: 'Pathfinder is not ready yet.' });
    }
    
    const { 
        start, end, shipLength,beam, speed, draft, hpReq, fuelRate, k, baseWeight, load, F, S, voyageDate
    } = req.query;

    const requiredParams = { start, end, shipLength,beam,speed, draft, hpReq, fuelRate, k, baseWeight, load, F, S, voyageDate };
    for (const param in requiredParams) {
        if (!requiredParams[param]) {
            return res.status(400).json({ error: `Missing required parameter: ${param}.` });
        }
    }

    try {
        const startCoords = start.split(',').map(Number);
        const endCoords = end.split(',').map(Number);
        const envCache = new EnvironmentalDataCache(
            { lat: startCoords[0], lng: startCoords[1] },
            { lat: endCoords[0], lng: endCoords[1] },
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
            
        const path = pathfinder.findPath(
            gridToUse,
            { lat: startCoords[0], lng: startCoords[1] },
            { lat: endCoords[0], lng: endCoords[1] },
            params,
            envCache
        );
        
        

        // --- ENRICH AND SANITIZE THE PATH ---
        if (!path || path.length === 0) {
            return res.json({ path: [] });
        }

        const enrichedPath = path.map(point => {
            const envDataAtPoint = envCache.getData(point.lat, point.lng);
            return {
                ...point,
                env: envDataAtPoint
            };
        });

        // Sanitize the final path to remove any invalid coordinates
        const sanitizedPath = enrichedPath.filter(point => 
            Number.isFinite(point.lat) && Number.isFinite(point.lng)
        );

        if (sanitizedPath.length < enrichedPath.length) {
            console.warn('WARNING: Invalid coordinate(s) found and removed from path.');
        }

        res.json({ path: sanitizedPath });

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