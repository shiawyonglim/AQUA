class MinHeap {
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
     * Finds the most fuel-efficient path, now handling No-Go zones.
     * @param {Array<object>} noGoZones - An array of GeoJSON polygons to avoid.
     */
    findPath(landGrid, startLatLng, endLatLng, params, envCache, noGoZones = []) {
        const strategies = ['balanced', 'fastest', 'safest'];
        const allPaths = {};

        for (const strategy of strategies) {
            const originalStartNode = landGrid.latLngToGrid(startLatLng);
            const originalEndNode = landGrid.latLngToGrid(endLatLng);

            if (originalStartNode.x < 0 || originalStartNode.x >= landGrid.cols || originalStartNode.y < 0 || originalStartNode.y >= landGrid.rows ||
                originalEndNode.x < 0 || originalEndNode.x >= landGrid.cols || originalEndNode.y < 0 || originalEndNode.y >= landGrid.rows) {
                console.error("Start or end node is out of grid bounds.");
                allPaths[strategy] = [];
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
            
            const waterPathResult = this.runAStar(aStarStartNode, aStarEndNode, landGrid, params, envCache, strategy, noGoZones);

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

            allPaths[strategy] = this.recalculateTotalFuel(finalPath, landGrid, params, envCache, strategy, noGoZones);
        }

        return allPaths;
    }

    /**
     * The core A* algorithm now accepts noGoZones.
     */
    runAStar(startNode, endNode, landGrid, params, envCache, strategy, noGoZones) { 
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

                // CORRECTED: Add a hard block to prevent pathing onto land tiles,
                // unless the land tile is the final destination.
                const isNeighborLand = landGrid.grid[neighbor.x][neighbor.y] === 1;
                const isNeighborDestination = neighbor.x === endNode.x && neighbor.y === endNode.y;
                if (isNeighborLand && !isNeighborDestination) {
                    continue; // Skip this neighbor entirely if it's land (and not the goal)
                }

                const segRes = this.calculateSegmentCost(currentNode, neighbor, landGrid, params, envCache, strategy, noGoZones);
                const fuelForSegment = (typeof segRes === 'object')
                    ? (segRes.fuelCost ?? segRes.finalCost ?? 0)
                    : segRes;
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
     */
    findPathToNearestWater(startNode, landGrid) {
        const queue = [{ ...startNode, parent: null }];
        const visited = new Set([`${startNode.x},${startNode.y}`]);

        while (queue.length > 0) {
            const currentNode = queue.shift();

            if (landGrid.grid[currentNode.x][currentNode.y] === 0) {
                const path = [];
                let temp = currentNode;
                while (temp) {
                    path.push({
                        ...landGrid.gridToLatLng(temp.x, temp.y),
                        onLand: landGrid.grid[temp.x][temp.y] === 1,
                        totalFuel: 0
                    });
                    temp = temp.parent;
                }
                return { path: path.reverse(), waterNode: currentNode };
            }

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
     */
    reconstructAndFormatPath(endNode, landGrid, initialFuel = 0) {
        let path = [];
        let temp = endNode;
        while (temp) {
            path.push({
                ...landGrid.gridToLatLng(temp.x, temp.y),
                onLand: landGrid.grid[temp.x][temp.y] === 1,
                totalFuel: initialFuel + temp.g
            });
            temp = temp.parent;
        }
        return path.reverse();
    }


    /**
     * Recalculates the total fuel consumption for the final combined path.
     * This function sets fuel cost to 0 for any segments on land.
     */
    recalculateTotalFuel(path, landGrid, params, envCache, strategy, noGoZones = []) {
        if (!path || path.length < 2) return path;

        let cumulativeFuel = 0;
        let cumulativeTime = 0;
        const allSegmentData = [];

        path[0].totalFuel = 0;
        path[0].totalTime = 0;

        for (let i = 1; i < path.length; i++) {
            const fromLatLng = path[i - 1];
            const toLatLng = path[i];
            const fromNode = landGrid.latLngToGrid(fromLatLng);
            const toNode = landGrid.latLngToGrid(toLatLng);

            let fuelCost = 0;
            let timeHours = 0;
            let effectiveSpeedKmh = 0;
            const distanceKm = this.calculateDistance(fromNode, toNode, landGrid);

            // Only calculate fuel cost if the segment is purely over water.
            if (!path[i].onLand && !path[i-1].onLand) {
                const segRes = this.calculateSegmentCost(fromNode, toNode, landGrid, params, envCache, strategy, noGoZones);
                const segObj = (typeof segRes === 'object') ? segRes : { fuelCost: segRes };

                fuelCost = segObj.fuelCost ?? segObj.finalCost ?? 0;
                effectiveSpeedKmh = segObj.effectiveSpeedKmh;
                timeHours = segObj.timeHours ?? (effectiveSpeedKmh > 0 ? distanceKm / effectiveSpeedKmh : Infinity);
            }
            // For any segment touching land, fuel cost is explicitly zero.

            cumulativeFuel += fuelCost;
            cumulativeTime += timeHours;

            path[i].totalFuel = cumulativeFuel;
            path[i].totalTime = cumulativeTime;
            path[i].segmentSpeed = effectiveSpeedKmh;
            path[i].segmentDistance = distanceKm;
            path[i].segmentTime = timeHours;
            path[i].segmentFuel = fuelCost;

            allSegmentData.push({
                index: i,
                from: { ...fromLatLng },
                to: { ...toLatLng },
                distanceKm,
                effectiveSpeedKmh,
                timeHours,
                fuelCost,
                cumulativeFuel,
                cumulativeTime
            });
        }

        this.allSegmentData = allSegmentData;
        return path;
    }


    /**
     * Checks if a point is inside any of the No-Go Zone polygons.
     */
    isPointInNoGoZone(point, noGoZones) {
        if (!noGoZones || noGoZones.length === 0) return false;

        for (const zone of noGoZones) {
            const polygon = zone.geometry.coordinates[0]; 
            let isInside = false;
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                const xi = polygon[i][0], yi = polygon[i][1];
                const xj = polygon[j][0], yj = polygon[j][1];

                const intersect = ((yi > point.lat) !== (yj > point.lat))
                    && (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi);
                if (intersect) isInside = !isInside;
            }
            if (isInside) return true;
        }
        return false;
    }

    /**
     * Cost function for water-based travel. Land is now blocked by runAStar.
     */
    calculateSegmentCost(fromNode, toNode, grid, params, envCache, strategy = 'balanced', noGoZones = []) {
        const baseFuelPerKm = this.calculateFuelPerKm(params);
        const distanceKm = this.calculateDistance(fromNode, toNode, grid);
        if (distanceKm === 0) return { fuelCost: 0, distanceKm, effectiveSpeedKmh: params.speed * 1.852, timeHours: 0 };

        let weatherPenaltyWeight = 1.0, fuelWeight = 1.0;
        if (strategy === 'fastest') weatherPenaltyWeight = 0.2;
        else if (strategy === 'safest') weatherPenaltyWeight = 5.0;

        const { lat, lng } = grid.gridToLatLng(fromNode.x, fromNode.y);
        const envData = envCache.getData(lat, lng) ?? {};

        if (envData.depth === null || envData.depth === undefined) {
            const penaltyFuel = baseFuelPerKm * distanceKm * 5;
            return {
                distanceKm,
                effectiveSpeedKmh: params.speed * 1.852,
                timeHours: distanceKm / Math.max(0.0001, params.speed * 1.852),
                fuelCost: penaltyFuel,
                finalCost: penaltyFuel
            };
        }

        let costMultiplier = 1.0;
        const boatBearing = this.calculateBearing(fromNode, toNode, grid);

        costMultiplier += weatherPenaltyWeight * this.windCostMultiplier(boatBearing, baseFuelPerKm, 1, params, envData);
        costMultiplier += weatherPenaltyWeight * this.currentCostMutiplier(boatBearing, params, envData);
        costMultiplier += weatherPenaltyWeight * this.waveCostMutiplier(boatBearing, params, envData);
        costMultiplier += weatherPenaltyWeight * this.rainCostMutiplier(params, envData);
        costMultiplier += weatherPenaltyWeight * this.iceCostMutiplier(params, envData);
        costMultiplier += this.depthCostMutiplier(params, envData);

        const toNodeLatLng = grid.gridToLatLng(toNode.x, toNode.y);
        if (this.isPointInNoGoZone(toNodeLatLng, noGoZones)) {
            costMultiplier *= 100; // Heavy penalty for entering a no-go zone
        }

        // REMOVED: The heavy land penalty is no longer needed as land is now impassable.
        
        const baseSpeedKmh = params.speed * 1.852;
        const effectiveSpeedKmh = this.getEffectiveSpeed(baseSpeedKmh, envData, boatBearing, params);

        const timeHours = effectiveSpeedKmh > 0 ? (distanceKm / effectiveSpeedKmh) : Infinity;

        const fuelMultiplier = Math.max(0.5, 1.0 + (baseSpeedKmh - effectiveSpeedKmh) / Math.max(1e-6, baseSpeedKmh));
        const finalCost = baseFuelPerKm * distanceKm * fuelWeight * Math.max(0.1, costMultiplier) * fuelMultiplier;

        return {
            from: { lat, lng },
            to: toNodeLatLng,
            distanceKm,
            effectiveSpeedKmh,
            timeHours,
            fuelCost: finalCost,
            finalCost
        };
    }

    calculateFuelPerKm(params) {
        const { speed, hpReq, fuelRate, k = 0.005, baseWeight, load, F = 1, S = 1 } = params;
        const speedKmh = speed * 1.852;

        if (speedKmh <= 0) return Infinity;
        const totalWeight = (baseWeight || 0) + (load || 0);
        const weightFactor = totalWeight > 0 ? (1 + k * (load / baseWeight)) : 1;
        const fuelPerKm = (((hpReq *0.95) * fuelRate * weightFactor * F * S) / speedKmh);
        return fuelPerKm || 0.1;
    }

    heuristic(a, b, grid, params, strategy) {
        const distanceKm = this.calculateDistance(a, b, grid);
        let baseCost = this.calculateFuelPerKm(params) * distanceKm;
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
    
    // --- Cost Multiplier Helper Functions ---
    windCostMultiplier(boatBearing, baseFuelPerKm, SFOC, params, envData) {
        const rho = 1.225;
        const Cd_front = 0.4;
        const Cd_side = 0.6;
        const Vship = params.speed * 0.514444;
        const speed_kmh = Vship * 1.852;
        const A_front = 0.08 * params.beam * params.shipLength;
        const A_side = 0.25 * params.beam * params.shipLength;
        if (envData.wind_speed_mps === null || envData.wind_speed_mps <= 0) {
            return 0;
        }
        else {
            const delta = (envData.wind_direction_deg - boatBearing + 360) % 360;
            let A, Cd, Vrel;
            if (delta <= 45 || delta >= 315) {
                A = A_front;
                Cd = Cd_front;
                Vrel = Vship + envData.wind_speed_mps;
            } else if (delta >= 135 && delta <= 225) {
                A = A_front;
                Cd = Cd_front;
                Vrel = Math.max(0, Math.abs(Vship - envData.wind_speed_mps));
            } else {
                A = A_side;
                Cd = Cd_side;
                Vrel = Math.sqrt(Vship * Vship + envData.wind_speed_mps * envData.wind_speed_mps);
            }
            const Fwind = 0.5 * rho * Cd * A * Vrel * Vrel;
            const Padded_kW = (Fwind * Vship) / 1000.0;
            const baseFuelPerKm_kg = baseFuelPerKm * 1000;
            const baseFuelPerHour_kg = baseFuelPerKm_kg * speed_kmh;
            const Pbase_kW = baseFuelPerHour_kg / Math.max(SFOC, 1e-9);
            const windCostMultiplier = Padded_kW / Math.max(Pbase_kW, 1e-6);
            return windCostMultiplier;
        }
    }

    currentCostMutiplier(boatBearing, params, envData) {
        if (envData.current_speed_mps === null || envData.current_speed_mps <= 0) {
            return 0;
        }
        else {
            const deg2rad = d => (d * Math.PI) / 180.0;
            const Vship = params.speed * 0.514444;
            const shipRad = deg2rad(boatBearing);
            const ship_x = Vship * Math.sin(shipRad);
            const ship_y = Vship * Math.cos(shipRad);
            const curRad = deg2rad(envData.current_direction_deg);
            const cur_x = envData.current_speed_mps * Math.sin(curRad);
            const cur_y = envData.current_speed_mps * Math.cos(curRad);
            const sog_x = ship_x + cur_x;
            const sog_y = ship_y + cur_y;
            const SOG_mps = Math.sqrt(sog_x * sog_x + sog_y * sog_y);
            const SOG_kmh = SOG_mps * 3.6;
            const speed_kmh = Vship * 1.852;
            if (SOG_kmh < 0.0001)
                return Infinity;
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
            const waveDirection = envData.wind_direction_deg;
            const displacement = (params.baseWeight + params.load) || 1;
            const k = 0.2 * (params.beam / params.shipLength) * (displacement) / 100000;
            const waveHeight = envData.waves_height_m;
            const delta = Math.abs((waveDirection - boatBearing + 360) % 360);
            let factor = 0;
            if (delta <= 45 || delta >= 315) {
                factor = 1.0;
            } else if (delta >= 135 && delta <= 225) {
                factor = -0.3;
            } else {
                factor = 0.4;
            }
            const Vship = params.speed * 0.514444;
            const Vref = 10 * 0.514444;
            const speedFactor = (Vship / Vref) ** 2;
            const waveCostMultiplier = k * waveHeight * factor * speedFactor;
            return waveCostMultiplier;
        }
    } 

    rainCostMutiplier(params, envData) {
        if (envData.weekly_precip_mean === null || envData.weekly_precip_mean <= 0) {
            return 0;
        } else {
            const displacement = (params.baseWeight + params.load) || 1; 
            const k = 0.5
            const sensitivity = k / Math.sqrt(displacement);
            let maxIncrease = 0.30 * Math.pow(500 / displacement, 0.2);
            if (maxIncrease > 0.50) {
                return 5;
            }
            else {
                maxIncrease = Math.min(0.30, Math.max(0.05, maxIncrease));
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
            const refDisp = 10000;
            const displacement = (params.baseWeight + params.load) || 1;
            const bands = [
                { max: 0.10, base: 0.0, navigable: true },
                { max: 0.30, base: 0.05, navigable: true },
                { max: 0.60, base: 0.15, navigable: true },
                { max: 0.80, base: 0.50, navigable: false },
                { max: 1.00, base: 1.00, navigable: false }
            ];
            let band = bands[bands.length - 1];
            let lowerBound = 0;
            for (const b of bands) {
                if (envData.ice_conc <= b.max) {
                    band = b;
                    break;
                }
                lowerBound = b.max;
            }
            const bandFraction = (envData.ice_conc - lowerBound) / Math.max(band.max - lowerBound, 1e-6);
            const concentrationIncrease = band.base * (0.5 + 0.5 * bandFraction);
            const displacementScaling = Math.sqrt(refDisp / displacement);
            let iceCostMultiplier = concentrationIncrease * displacementScaling;
            iceCostMultiplier = Math.max(0, Math.min(iceCostMultiplier, 3.0));
            return iceCostMultiplier;
        }
    }

    depthCostMutiplier(params, envData) {
        const seaDepth = envData.depth
        const depthToDraftRatio = seaDepth / params.draft;
        if (depthToDraftRatio > 5) {
            return 0;
        }
        if (depthToDraftRatio < 1.2) {
            return 5; 
        }
        const shallowEffect = 1 / Math.max(depthToDraftRatio - 1, 0.1);
        const depthCostMultiplier = Math.min(shallowEffect, 1.0);
        return depthCostMultiplier;
    }

    /**
     * Calculates a more realistic effective speed over ground (SOG).
     * This model first determines the ship's speed through water (STW) by applying
     * resistance penalties, then performs a vector sum with the ocean current.
     *
     * @param {number} baseSpeedKmh - The ship's speed in calm, deep water (km/h).
     * @param {object} envData - Environmental data for the current node.
     * @param {number} headingDeg - The ship's compass heading in degrees.
     * @param {object} params - Vessel parameters (draft, etc.).
     * @returns {number} The final effective speed over ground in km/h.
     */
    getEffectiveSpeed(baseSpeedKmh, envData, headingDeg, params) {
        // --- Step 1: Calculate Speed Through Water (STW) by applying resistance ---
    
        let speedThroughWaterKmh = baseSpeedKmh;
    
        // Environmental factors with defaults
        const waveHeight = envData.waves_height_m || 0;
        const waveDir = envData.wind_direction_deg || 0; // Assume waves align with wind
        const iceConc = envData.ice_conc || 0;           // 0.0 to 1.0
        const depth = envData.depth || Infinity;         // meters
    
        // 1a. Wave Resistance Penalty 🌊
        if (waveHeight > 0.1) {
            const relWaveAngle = Math.abs((waveDir - headingDeg + 360) % 360);
            let waveResistanceFactor = 0;
    
            if (relWaveAngle <= 60 || relWaveAngle >= 300) { // Head seas
                waveResistanceFactor = 1.0;
            } else if (relWaveAngle > 60 && relWaveAngle < 120) { // Beam seas
                waveResistanceFactor = 0.4;
            }
    
            const waveSpeedPenalty = (waveHeight * waveResistanceFactor * 0.10);
            speedThroughWaterKmh *= (1 - Math.min(0.75, waveSpeedPenalty));
        }
    
        // 1b. Ice Resistance Penalty 🧊
        if (iceConc > 0.05) {
            const icePenalty = Math.pow(iceConc, 2);
            speedThroughWaterKmh *= (1 - icePenalty);
        }
    
        // 1c. Shallow Water Effect Penalty (Squat) 🚤
        if (depth !== Infinity) {
            const depthToDraftRatio = depth / Math.max(0.1, params.draft);
            if (depthToDraftRatio < 1.2) {
                speedThroughWaterKmh *= 0.2;
            } else if (depthToDraftRatio < 1.5) {
                speedThroughWaterKmh *= 0.6;
            } else if (depthToDraftRatio < 3.0) {
                speedThroughWaterKmh *= 0.9;
            }
        }
    
        // --- Step 2: Calculate Speed Over Ground (SOG) using Vector Addition ---
    
        const currentSpeedMps = envData.current_speed_mps || 0;
        const currentDir = envData.current_direction_deg || 0;
    
        if (currentSpeedMps > 0.05) {
            const deg2rad = d => (d * Math.PI) / 180.0;
    
            const shipRad = deg2rad(headingDeg);
            const ship_x = speedThroughWaterKmh * Math.sin(shipRad);
            const ship_y = speedThroughWaterKmh * Math.cos(shipRad);
    
            const currentSpeedKmh = currentSpeedMps * 3.6;
            const currentRad = deg2rad(currentDir);
            const cur_x = currentSpeedKmh * Math.sin(currentRad);
            const cur_y = currentSpeedKmh * Math.cos(currentRad);
    
            const sog_x = ship_x + cur_x;
            const sog_y = ship_y + cur_y;
    
            const effectiveSpeedKmh = Math.sqrt(sog_x * sog_x + sog_y * sog_y);
            return Math.max(0.5, effectiveSpeedKmh);
        }
    
        return Math.max(0.5, speedThroughWaterKmh);
    }

    getCurrentNodeSpeed(currentNode, grid, params, envCache, nextNode = null) {
        const baseSpeedKmh = params.speed * 1.852;

        let bearing = 0;
        if (nextNode) {
            bearing = this.calculateBearing(currentNode, nextNode, grid);
        }

        const { lat, lng } = grid.gridToLatLng(currentNode.x, currentNode.y);
        const envData = envCache.getData(lat, lng);

        const effectiveSpeedKmh = this.getEffectiveSpeed(baseSpeedKmh, envData, bearing, params);

        return effectiveSpeedKmh;
    }
}

module.exports = AStarPathfinder;

