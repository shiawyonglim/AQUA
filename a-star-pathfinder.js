class MinHeap {
    // MinHeap implementation remains the same...
    constructor() { this.heap = []; }
    push(node) { this.heap.push(node); this.bubbleUp(); }
    pop() {
        const min = this.heap[0];
        const end = this.heap.pop();
        if (this.heap.length > 0) { this.heap[0] = end; this.sinkDown(0); }
        return min;
    }
    size() { return this.heap.length; }
    bubbleUp() {
        let index = this.heap.length - 1;
        const node = this.heap[index];
        while (index > 0) {
            let parentIndex = Math.floor((index - 1) / 2);
            let parent = this.heap[parentIndex];
            if (node.f >= parent.f) break;
            this.heap[parentIndex] = node;
            this.heap[index] = parent;
            index = parentIndex;
        }
    }
    sinkDown(index) {
        const length = this.heap.length;
        const node = this.heap[index];
        while (true) {
            let leftChildIdx = 2 * index + 1, rightChildIdx = 2 * index + 2, swap = null;
            if (leftChildIdx < length) {
                let leftChild = this.heap[leftChildIdx];
                if (leftChild.f < node.f) swap = leftChildIdx;
            }
            if (rightChildIdx < length) {
                let rightChild = this.heap[rightChildIdx];
                if ((swap === null && rightChild.f < node.f) || (swap !== null && rightChild.f < this.heap[swap].f)) {
                    swap = rightChildIdx;
                }
            }
            if (swap === null) break;
            this.heap[index] = this.heap[swap];
            this.heap[swap] = node;
            index = swap;
        }
    }
}



class AStarPathfinder {
    /**
     * Finds the most fuel-efficient path, handling land-to-water transitions.
     * @param {NavigationGrid} landGrid - The grid defining land (1) and water (0).
     * @param {object} startLatLng - The starting coordinates { lat, lng }.
     * @param {object} endLatLng - The ending coordinates { lat, lng }.
     * @param {object} params - All vessel and environmental parameters.
     * @returns {Array<object>|null} The path with fuel info, or null.
     */
    findPath(landGrid, startLatLng, endLatLng, params, envCache) {
        const strategies = ['balanced', 'fastest', 'safest'];
        const allPaths = {};

        for (const strategy of strategies) {
            const originalStartNode = landGrid.latLngToGrid(startLatLng);
            const originalEndNode = landGrid.latLngToGrid(endLatLng);

            if (originalStartNode.x < 0 || originalStartNode.x >= landGrid.cols || originalStartNode.y < 0 || originalStartNode.y >= landGrid.rows ||
                originalEndNode.x < 0 || originalEndNode.x >= landGrid.cols || originalEndNode.y < 0 || originalEndNode.y >= landGrid.rows) {
                console.error("Start or end node is out of grid bounds.");
                allPaths[strategy] = []; // Return empty path for this strategy
                continue;
            }

            const isStartOnLand = landGrid.grid[originalStartNode.x][originalStartNode.y] === 1;
            const isEndOnLand = landGrid.grid[originalEndNode.x][originalEndNode.y] === 1;

            let pathFromStart = [];
            let pathToEnd = [];
            let aStarStartNode = originalStartNode;
            let aStarEndNode = originalEndNode;

            if (isStartOnLand) {
                const startWaterInfo = this.findPathToNearestWater(originalStartNode, landGrid);
                if (!startWaterInfo) {
                    allPaths[strategy] = []; continue;
                }
                pathFromStart = startWaterInfo.path;
                aStarStartNode = startWaterInfo.waterNode;
            }

            if (isEndOnLand) {
                const endWaterInfo = this.findPathToNearestWater(originalEndNode, landGrid);
                if (!endWaterInfo) {
                    allPaths[strategy] = []; continue;
                }
                pathToEnd = endWaterInfo.path;
                aStarEndNode = endWaterInfo.waterNode;
            }

            const waterPathResult = this.runAStar(aStarStartNode, aStarEndNode, landGrid, params, envCache, strategy);

            if (!waterPathResult) {
                 allPaths[strategy] = []; continue;
            }
            
            const waterPath = this.reconstructAndFormatPath(waterPathResult, landGrid, 0);
            let finalPath = [];
            if (pathFromStart.length > 0) {
                finalPath = finalPath.concat(pathFromStart);
                if (waterPath.length > 0) finalPath.pop();
            }
            finalPath = finalPath.concat(waterPath);
            if (pathToEnd.length > 0) {
                if (finalPath.length > 0) pathToEnd.shift();
                finalPath = finalPath.concat(pathToEnd.reverse());
            }

            allPaths[strategy] = this.recalculateTotalFuel(finalPath, landGrid, params, envCache, strategy);
        }

        return allPaths;
    }

    /**
     * MODIFIED: The core A* algorithm now accepts a strategy.
     */
    runAStar(startNode, endNode, landGrid, params, envCache, strategy) { 
        const openSet = new MinHeap();
        const closedSet = new Set();
        const gScores = new Map();

        const startKey = `${startNode.x},${startNode.y}`;
        gScores.set(startKey, 0);

        const initialHeuristic = this.heuristic(startNode, endNode, landGrid, params, strategy);
        openSet.push({ ...startNode, g: 0, h: initialHeuristic, f: initialHeuristic, parent: null });

        while (openSet.size() > 0) {
            let currentNode = openSet.pop();
            const currentKey = `${currentNode.x},${currentNode.y}`;
            if (closedSet.has(currentKey)) continue;
            if (currentNode.x === endNode.x && currentNode.y === endNode.y) {
                return currentNode;
            }

            closedSet.add(currentKey);

            const neighbors = this.getNeighbors(currentNode, landGrid);
            for (const neighbor of neighbors) {
                const neighborKey = `${neighbor.x},${neighbor.y}`;
                if (closedSet.has(neighborKey)) continue;

                const isNeighborLand = landGrid.grid[neighbor.x][neighbor.y] === 1;
                const isNeighborDestination = neighbor.x === endNode.x && neighbor.y === endNode.y;
                if (isNeighborLand && !isNeighborDestination) continue;

                // MODIFIED: Pass strategy to cost calculation
                const fuelForSegment = this.calculateSegmentCost(currentNode, neighbor, landGrid, params, envCache, strategy);
                const gScore = currentNode.g + fuelForSegment;

                if (!gScores.has(neighborKey) || gScore < gScores.get(neighborKey)) {
                    gScores.set(neighborKey, gScore);
                    neighbor.parent = currentNode;
                    neighbor.g = gScore;
                    neighbor.h = this.heuristic(neighbor, endNode, landGrid, params, strategy);
                    neighbor.f = neighbor.g + neighbor.h;
                    openSet.push(neighbor);
                }
            }
        }
        return null;
    }

    /**
     * Finds the shortest path from a land node to the nearest water node using BFS.
     * @param {object} startNode - The starting land node.
     * @param {NavigationGrid} landGrid - The grid.
     * @returns {{path: Array<object>, waterNode: object}|null}
     */
    findPathToNearestWater(startNode, landGrid) {
        const queue = [{ ...startNode, parent: null }];
        const visited = new Set([`${startNode.x},${startNode.y}`]);

        while (queue.length > 0) {
            const currentNode = queue.shift();

            // Check if the current node is water
            if (landGrid.grid[currentNode.x][currentNode.y] === 0) {
                // Found water, reconstruct the path back to the start
                const path = [];
                let temp = currentNode;
                while (temp) {
                    path.push({
                        ...landGrid.gridToLatLng(temp.x, temp.y),
                        onLand: landGrid.grid[temp.x][temp.y] === 1,
                        totalFuel: 0 // Fuel is not calculated for this part
                    });
                    temp = temp.parent;
                }
                return { path: path.reverse(), waterNode: currentNode };
            }

            // Explore neighbors
            const neighbors = this.getNeighbors(currentNode, landGrid);
            for (const neighbor of neighbors) {
                const neighborKey = `${neighbor.x},${neighbor.y}`;
                if (!visited.has(neighborKey)) {
                    visited.add(neighborKey);
                    neighbor.parent = currentNode;
                    queue.push(neighbor);
                }
            }
        }
        return null; // No path to water found
    }

    /**
     * Reconstructs a path from the final A* node and formats it.
     * @param {object} endNode - The final node from the A* search.
     * @param {NavigationGrid} landGrid - The grid.
     * @param {number} initialFuel - The starting fuel value for this path segment.
     * @returns {Array<object>} The formatted path.
     */
    reconstructAndFormatPath(endNode, landGrid, initialFuel = 0) {
        let path = [];
        let temp = endNode;
        while (temp) {
            path.push({
                ...landGrid.gridToLatLng(temp.x, temp.y),
                onLand: landGrid.grid[temp.x][temp.y] === 1,
                totalFuel: initialFuel + temp.g // Add initial fuel to segment's gScore
            });
            temp = temp.parent;
        }
        return path.reverse();
    }


    /**
     * Recalculates the total fuel consumption for the final combined path.
     * @param {Array<object>} path - The complete path from start to end.
     * @param {NavigationGrid} landGrid - The grid.
     * @param {object} params - Vessel and environmental parameters.
     * @returns {Array<object>} The path with updated totalFuel values.
     */
    recalculateTotalFuel(path, landGrid, params, envCache, strategy) {
        if (path.length < 2) return path;
        let cumulativeFuel = 0;
        path[0].totalFuel = 0;
        for (let i = 1; i < path.length; i++) {
            const fromNode = landGrid.latLngToGrid(path[i - 1]);
            const toNode = landGrid.latLngToGrid(path[i]);
            const segmentFuel = this.calculateSegmentCost(fromNode, toNode, landGrid, params, envCache, strategy);
            cumulativeFuel += segmentFuel;
            path[i].totalFuel = cumulativeFuel;
        }
        return path;
    }


    // The core function for calculating fuel cost with environmental factors
    calculateSegmentCost(fromNode, toNode, grid, params, envCache, strategy = 'balanced') {
        const baseFuelPerKm = this.calculateFuelPerKm(params);
        const distanceKm = this.calculateDistance(fromNode, toNode, grid);
        if (distanceKm === 0) return 0;
        
        // --- Strategy-based multiplier weights ---
        let weatherPenaltyWeight = 1.0;
        let fuelWeight = 1.0;

        if (strategy === 'fastest') {
            // For the fastest route, minimize the impact of weather penalties
            weatherPenaltyWeight = 0.2; 
        } else if (strategy === 'safest') {
            // For the safest route, amplify the impact of weather penalties
            weatherPenaltyWeight = 5.0; 
        }

        const { lat, lng } = grid.gridToLatLng(fromNode.x, fromNode.y);
        const envData = envCache.getData(lat, lng);

        if (envData.depth === null) {
            return baseFuelPerKm * distanceKm * 5;
        }

        let costMultiplier = 1.0;
        const boatBearing = this.calculateBearing(fromNode, toNode, grid);
        const P_req_kW = params.hpReq * 0.745699872;
        const SFOC = (params.fuelRate * 0.86) / 0.745699872;

        costMultiplier += weatherPenaltyWeight * this.windCostMultiplier(boatBearing, baseFuelPerKm, SFOC, params, envData);
        costMultiplier += weatherPenaltyWeight * this.currentCostMutiplier(boatBearing, params, envData);
        costMultiplier += weatherPenaltyWeight * this.waveCostMutiplier(boatBearing, params, envData);
        costMultiplier += weatherPenaltyWeight * this.rainCostMutiplier(params, envData);
        costMultiplier += weatherPenaltyWeight * this.iceCostMutiplier(params, envData);
        costMultiplier += this.depthCostMutiplier(params, envData); // Depth is always a critical safety factor

        const currentLatLng = grid.gridToLatLng(fromNode.x, fromNode.y);
        const southernLimit = -40.0, maxPenaltyLatSouth = -60.0;
        const northernLimit = 75.0, maxPenaltyLatNorth = 85.0;
        const maxLatitudePenalty = 10.0;
        if (currentLatLng.lat < southernLimit) {
            const penaltyFactor = (southernLimit - currentLatLng.lat) / (southernLimit - maxPenaltyLatSouth);
            costMultiplier += Math.min(penaltyFactor * maxLatitudePenalty, maxLatitudePenalty);
        } else if (currentLatLng.lat > northernLimit) {
            const penaltyFactor = (currentLatLng.lat - northernLimit) / (maxPenaltyLatNorth - northernLimit);
            costMultiplier += Math.min(penaltyFactor * maxLatitudePenalty, maxLatitudePenalty);
        }
        if (grid.grid[toNode.x][toNode.y] === 1) {
            costMultiplier *= 10;
        }

        const finalCost = baseFuelPerKm * distanceKm * fuelWeight * Math.max(0.1, costMultiplier);
        return finalCost;
    }

    calculateFuelPerKm(params) {
        const { speed, hpReq, fuelRate, k, baseWeight, load, F, S } = params;
        const speedKmh = speed * 1.852;


        if (speedKmh <= 0) return Infinity;
        const fuelPerKm = (((hpReq * 0.62) * fuelRate * (1 + k * (load / baseWeight)) * F * S) / speedKmh);
        return fuelPerKm;
    }

    heuristic(a, b, grid, params, strategy) {
        const distanceKm = this.calculateDistance(a, b, grid);
        let baseCost = this.calculateFuelPerKm(params) * distanceKm;

        // For the fastest route, the heuristic should favor pure distance.
        if (strategy === 'fastest') {
            baseCost = distanceKm;
        }
        return baseCost;
    }

    calculateDistance(a, b, grid) {
        const R = 6371; // Earth's radius in km
        const p1 = grid.gridToLatLng(a.x, a.y);
        const p2 = grid.gridToLatLng(b.x, b.y);

        const radLat1 = p1.lat * Math.PI / 180;
        const radLat2 = p2.lat * Math.PI / 180;
        const dLat = (p2.lat - p1.lat) * Math.PI / 180;
        const dLon = (p2.lng - p1.lng) * Math.PI / 180;

        const val = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(radLat1) * Math.cos(radLat2) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(val), Math.sqrt(1 - val));
        return R * c;
    }

    calculateBearing(a, b, grid) {
        const p1 = grid.gridToLatLng(a.x, a.y);
        const p2 = grid.gridToLatLng(b.x, b.y);

        const lat1 = p1.lat * Math.PI / 180;
        const lng1 = p1.lng * Math.PI / 180;
        const lat2 = p2.lat * Math.PI / 180;
        const lng2 = p2.lng * Math.PI / 180;

        const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
        let brng = Math.atan2(y, x) * 180 / Math.PI;
        return (brng + 360) % 360;
    }

    getNeighbors(node, grid) {
        const neighbors = [];
        const { x, y } = node;
        const { cols, rows } = grid;

        for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
                if (i === 0 && j === 0) continue;
                const newY = y + j;
                if (newY < 0 || newY >= rows) continue;
                const newX = (x + i + cols) % cols;
                if (i !== 0 && j !== 0) {
                    const adjacentX1 = (x + i + cols) % cols;
                    const adjacentX2 = x;
                    const adjacentY1 = y;
                    const adjacentY2 = y + j;
                    if (grid.grid[adjacentX1][adjacentY1] === 1 && grid.grid[adjacentX2][adjacentY2] === 1) {
                        continue;
                    }
                }
                neighbors.push({ x: newX, y: newY });
            }
        }
        return neighbors;
    }
    windCostMultiplier(
        boatBearing,    
        baseFuelPerKm,  
        SFOC,           // Specific Fuel Oil Consumption (kg/kWh)
        params,
        envData


    ) {
        // coefficients
        const rho = 1.225; // air density (kg/m³) at sea level
        const Cd_front = 0.4; //Drag Coefficient
        const Cd_side = 0.6; //Drag Coefficient 



        //  ship speed (kn to km/h)
        const Vship = params.speed * 0.514444;   // ship speed（kn to m/s）
        const speed_kmh = Vship * 1.852;  // km/h


        // Area 
        const A_front = 0.08 * params.beam * params.shipLength;
        const A_side = 0.25 * params.beam * params.shipLength;

        if (envData.wind_speed_mps === null || envData.wind_speed_mps <= 0) {
            return 0;
        }
        else {

            // wind direction relative to ship heading
            const delta = (envData.wind_direction_deg - boatBearing + 360) % 360;

            let A, Cd, Vrel;
            if (delta <= 45 || delta >= 315) { // headwind
                A = A_front;
                Cd = Cd_front;
                Vrel = Vship + envData.wind_speed_mps;

            } else if (delta >= 135 && delta <= 225) { // tailwind
                A = A_front;
                Cd = Cd_front;
                Vrel = Math.max(0, Math.abs(Vship - envData.wind_speed_mps));

            } else { // crosswind
                A = A_side;
                Cd = Cd_side;
                Vrel = Math.sqrt(Vship * Vship + envData.wind_speed_mps * envData.wind_speed_mps);
            }

            // wind resistance force (N)
            const Fwind = 0.5 * rho * Cd * A * Vrel * Vrel;
            const Padded_kW = (Fwind * Vship) / 1000.0;

            
            // Baseline propulsion power
            const baseFuelPerKm_kg = baseFuelPerKm * 1000;
            const baseFuelPerHour_kg = baseFuelPerKm_kg * speed_kmh;
            const Pbase_kW = baseFuelPerHour_kg / Math.max(SFOC, 1e-9);

           
            const windCostMultiplier = Padded_kW / Math.max(Pbase_kW, 1e-6);
            return windCostMultiplier;

        }



    }

    currentCostMutiplier(
        boatBearing,    
        params,
        envData
    ) {

        if (envData.current_speed_mps === null || envData.current_speed_mps <= 0) {
            return 0;
        }
        else {

            
            const deg2rad = d => (d * Math.PI) / 180.0; //convert degree to radian

            const Vship = params.speed * 0.514444; // ship speed（kn to m/s）
            const shipRad = deg2rad(boatBearing); // ship direction in radians

            const ship_x = Vship * Math.sin(shipRad);
            const ship_y = Vship * Math.cos(shipRad);
            //0° = 向北（正Y方向）  90° = 向东（正X方向） 180° = 向南（负Y方向） 270° = 向西（负X方向）

            
            
            // current vector (set to the direction the current is flowing to)
            const curRad = deg2rad(envData.current_direction_deg); // current direction in radians

            const cur_x = envData.current_speed_mps * Math.sin(curRad);
            const cur_y = envData.current_speed_mps * Math.cos(curRad);

            
            //(SOG)Speed Over Ground
            const sog_x = ship_x + cur_x;
            const sog_y = ship_y + cur_y;

            const SOG_mps = Math.sqrt(sog_x * sog_x + sog_y * sog_y); //sqrt = square root
            const SOG_kmh = SOG_mps * 3.6; // m/s to km/h


            // normal ship speed
            const speed_kmh = Vship * 1.852; // ship speed kn to km/h

            if (SOG_kmh < 0.0001)
                return Infinity; // effectively stopped by strong opposing current
            
            //k is coefficient for sensitivity
            const k = 0.35
            const currentCostMultiplier = ((speed_kmh / SOG_kmh) - 1) * k;

            return currentCostMultiplier;

        }

    }

    waveCostMutiplier(boatBearing, params, envData) {

        if (envData.waves_height_m === null || envData.waves_height_m <= 0) {
            return 0;
        }
        else {

            const waveDirection = envData.wind_direction_deg; // wave direction in radians(using wind_direction_deg, since wind is the primary forcce cause wave)
            const displacement = (params.baseWeight + params.load) || 1; 

            //let k = 0.2; // coefficient for sensitivity 
            // 1m wave height causes about 2% increase in fuel consumption for a 100,000-ton ship
            const k = 0.2 * (params.beam / params.shipLength) * (displacement) / 100000; // adjust k based on ship size and load
            const waveHeight = envData.waves_height_m; 

            //let sensitivity = displacement > 0 ? k / Math.sqrt(displacement) : 1.0;

            const delta = Math.abs((waveDirection - boatBearing + 360) % 360);

            let factor = 0;
            if (delta <= 45 || delta >= 315) {
               
                // head seas cause the most resistance
                factor = 1.0;
            } else if (delta >= 135 && delta <= 225) {
                
                // following seas can sometimes help, so we use a negative factor
                factor = -0.3;
            } else {

                // cross seas can be more challenging, so we use a moderate factor
                factor = 0.4;
            }

            const Vship = params.speed * 0.514444; // ship speed（kn to m/s）
            const Vref = 10 * 0.514444; //  reference speed（kn to m/s）
            const speedFactor = (Vship / Vref) ** 2; // quadratic correction factor for resistance


            const waveCostMultiplier = k * waveHeight * factor * speedFactor;

            return waveCostMultiplier;



        }



    }

    rainCostMutiplier(params, envData) {

        if (envData.weekly_precip_mean === null || envData.weekly_precip_mean <= 0) {

            return 0; // No rain, no effect

        } else {

            const displacement = (params.baseWeight + params.load) || 1; 
            const k = 0.5
            const sensitivity = k / Math.sqrt(displacement); // dimension: (multiplier per mm/week)

            // small boat (500t) ~ 0.30, medium(5000t) ~0.20, large(50000t) ~0.10
            let maxIncrease = 0.30 * Math.pow(500 / displacement, 0.2);

            if (maxIncrease > 0.50) {

                return 5; // not suitable continue sailing in heavy rain
            }
            else {

                maxIncrease = Math.min(0.30, Math.max(0.05, maxIncrease));
                // limit between 5% and 30%

                const rainCostMultiplier = Math.min((sensitivity * envData.weekly_precip_mean), maxIncrease);

                return rainCostMultiplier;


            }



        }
    }

    iceCostMutiplier(params, envData) {

        if (envData.ice_conc === null || envData.ice_conc <= 0) {
            return 0;
        }
        else {


            const refDisp = 10000; // reference displacement (t)

            const displacement = (params.baseWeight + params.load) || 1; 


            // --- WMO-like ice bands (normalized 0–1)
            const bands = [
                { max: 0.10, base: 0.0, navigable: true }, // open water
                { max: 0.30, base: 0.05, navigable: true }, // very open drift
                { max: 0.60, base: 0.15, navigable: true }, // open drift
                { max: 0.80, base: 0.50, navigable: false }, // close pack
                { max: 1.00, base: 1.00, navigable: false }  // consolidated
            ];

            // --- find matching band
            let band = bands[bands.length - 1];

            let lowerBound = 0;
            for (const b of bands) {
                if (envData.ice_conc <= b.max) {

                    band = b;
                    break;
                }
                lowerBound = b.max;
            }

            // --- scale inside band
            const bandFraction = (envData.ice_conc - lowerBound) / Math.max(band.max - lowerBound, 1e-6); // 1e-6 to avoid div by zero
            const concentrationIncrease = band.base * (0.5 + 0.5 * bandFraction);

            // --- scale by ship displacement
            const displacementScaling = Math.sqrt(refDisp / displacement);
            let iceCostMultiplier = concentrationIncrease * displacementScaling;

            // --- clamp
            iceCostMultiplier = Math.max(0, Math.min(iceCostMultiplier, 3.0));

            return iceCostMultiplier;

        }

    }

    depthCostMutiplier(params, envData) {
        const seaDepth = envData.depth
        const depthToDraftRatio = seaDepth / params.draft;

        if (depthToDraftRatio > 5) {
            return 0; // no additional cost
        }
        // too shallow, not navigable
        if (depthToDraftRatio < 1.2) {
            return 5; 
        }

        // Typical effect range: 1.2 ≤ h/T ≤ 5
        // // Formula idea: as h/T approaches 1, resistance rises sharply.
        // // Here we approximate with: Multiplier ~ 1 / (h/T - 1)
        const shallowEffect = 1 / Math.max(depthToDraftRatio - 1, 0.1);

        // --- max effect capped at 1.0 
        const depthCostMultiplier = Math.min(shallowEffect, 1.0);

        return depthCostMultiplier;
    }




}

module.exports = AStarPathfinder;