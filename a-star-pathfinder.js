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
     * Finds the most fuel-efficient path considering environmental factors.
     * @param {NavigationGrid} landGrid - The grid defining land (1) and water (0).
     * @param {object} startLatLng - The starting coordinates { lat, lng }.
     * @param {object} endLatLng - The ending coordinates { lat, lng }.
     * @param {object} params - All vessel and environmental parameters.
     * @returns {Array<object>|null} The path with fuel info, or null.
     */
    findPath(landGrid, startLatLng, endLatLng, params) {
        const startNode = landGrid.latLngToGrid(startLatLng);
        const endNode = landGrid.latLngToGrid(endLatLng);

        if (startNode.x < 0 || startNode.x >= landGrid.cols || startNode.y < 0 || startNode.y >= landGrid.rows ||
            endNode.x < 0 || endNode.x >= landGrid.cols || endNode.y < 0 || endNode.y >= landGrid.rows) {
            return null;
        }

        const openSet = new MinHeap();
        const closedSet = new Set();
        const gScores = new Map(); // gScore is total fuel consumed in Liters

        const startKey = `${startNode.x},${startNode.y}`;
        gScores.set(startKey, 0);

        const initialHeuristic = this.heuristic(startNode, endNode, landGrid, params);
        openSet.push({ ...startNode, g: 0, h: initialHeuristic, f: initialHeuristic, parent: null });

        while (openSet.size() > 0) {
            let currentNode = openSet.pop();
            const currentKey = `${currentNode.x},${currentNode.y}`;

            if (closedSet.has(currentKey)) continue;

            if (currentNode.x === endNode.x && currentNode.y === endNode.y) {
                let path = [];
                let temp = currentNode;
                while (temp) {
                    path.push({
                        ...landGrid.gridToLatLng(temp.x, temp.y),
                        onLand: landGrid.grid[temp.x][temp.y] === 1,
                        totalFuel: temp.g
                    });
                    temp = temp.parent;
                }
                return path.reverse();
            }

            closedSet.add(currentKey);

            const neighbors = this.getNeighbors(currentNode, landGrid);
            for (const neighbor of neighbors) {
                const neighborKey = `${neighbor.x},${neighbor.y}`;
                if (closedSet.has(neighborKey)) continue;

                const isNeighborLand = landGrid.grid[neighbor.x][neighbor.y] === 1;
                const isNeighborDestination = neighbor.x === endNode.x && neighbor.y === endNode.y;
                const isCurrentNodeWater = landGrid.grid[currentNode.x][currentNode.y] === 0;

                // Prevent moving from water to land unless it's the destination
                if (isCurrentNodeWater && isNeighborLand && !isNeighborDestination) {
                    continue;
                }

                // NEW: Use the advanced cost calculation
                const fuelForSegment = this.calculateSegmentCost(currentNode, neighbor, landGrid, params);
                
                const gScore = currentNode.g + fuelForSegment;

                if (!gScores.has(neighborKey) || gScore < gScores.get(neighborKey)) {
                    gScores.set(neighborKey, gScore);
                    neighbor.parent = currentNode;
                    neighbor.g = gScore;
                    neighbor.h = this.heuristic(neighbor, endNode, landGrid, params);
                    neighbor.f = neighbor.g + neighbor.h;
                    openSet.push(neighbor);
                }
            }
        }
        return null;
    }
    
    // NEW: The core function for calculating fuel cost with environmental factors
    calculateSegmentCost(fromNode, toNode, grid, params) {
        const baseFuelPerKm = this.calculateFuelPerKm(params);
        const distanceKm = this.calculateDistance(fromNode, toNode, grid);

        let costMultiplier = 1.0;

        // --- Directional Factors (Wind, Current, Waves) ---
        const boatBearing = this.calculateBearing(fromNode, toNode, grid);
        
        // Wind Effect
        const windAngleDiff = Math.abs(boatBearing - params.windDirection);
        const windEffect = params.windStrength * Math.cos(windAngleDiff * Math.PI / 180); // Convert to radians for cos
        
        // Current Effect
        const currentAngleDiff = Math.abs(boatBearing - params.currentDirection);
        const currentEffect = params.currentStrength * Math.cos(currentAngleDiff * Math.PI / 180);

        // Wave Effect
        const waveAngleDiff = Math.abs(boatBearing - params.waveDirection);
        const waveEffect = params.waveHeight * Math.cos(waveAngleDiff * Math.PI / 180);

        // A value of 1.0 is neutral. We subtract the effect, so a tailwind (cos=1) reduces the multiplier,
        // and a headwind (cos=-1) increases it.
        // The coefficients (e.g., 0.1) control how much each factor affects the fuel.
        costMultiplier -= (windEffect * 0.1); 
        costMultiplier -= (currentEffect * 0.2); // Currents have a stronger effect
        costMultiplier += (waveEffect * 0.15); // Waves from front/side increase cost

        // --- Non-Directional Factors ---
        // These are simple penalties. Assumes higher intensity/probability is worse.
        costMultiplier += (params.rainIntensity * params.rainProbability * 0.05);

        // Sea depth: a simple penalty for shallow water (e.g., if depth < 2 * draft)
        // This is a simplified model; a real implementation would use a depth grid.
        if (params.seaDepth < params.draft * 2) {
            costMultiplier += 0.3; // 30% fuel penalty for shallow water
        }

        // Penalty for traveling over land (e.g., canals, ports)
        if (grid.grid[toNode.x][toNode.y] === 1) {
            costMultiplier *= 10; // Make land travel very expensive but possible
        }

        // Ensure the multiplier doesn't become negative (which would mean gaining fuel)
        return baseFuelPerKm * distanceKm * Math.max(0.1, costMultiplier);
    }
    
    calculateFuelPerKm(params) {
        const { speed, hpReq, fuelRate, k, baseWeight, load, F, S } = params;
        const speedKmh = speed * 1.852;
        if (speedKmh <= 0) return Infinity;
        const fuelPerKm = (((hpReq * 0.62) * fuelRate * (1 + k * (load / baseWeight)) * F * S) / speedKmh);
        return fuelPerKm;
    }

    heuristic(a, b, grid, params) {
        // The heuristic should be optimistic, so it calculates the cost in a straight line
        // with ideal conditions (no environmental resistance).
        const distanceKm = this.calculateDistance(a, b, grid);
        return this.calculateFuelPerKm(params) * distanceKm;
    }

    calculateDistance(a, b, grid) {
        // Using Haversine formula for distance
        const R = 6371; // Earth's radius in km
        const p1 = grid.gridToLatLng(a.x, a.y);
        const p2 = grid.gridToLatLng(b.x, b.y);

        const radLat1 = p1.lat * Math.PI / 180;
        const radLat2 = p2.lat * Math.PI / 180;
        const dLat = (p2.lat - p1.lat) * Math.PI / 180;
        const dLon = (p2.lng - p1.lng) * Math.PI / 180;

        const val = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(radLat1) * Math.cos(radLat2) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(val), Math.sqrt(1-val)); 
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
        return (brng + 360) % 360; // Normalize to 0-360
    }

    getNeighbors(node, grid) {
        // This function remains the same...
        const neighbors = [];
        const { x, y } = node;
        const { cols, rows } = grid;

        for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
                if (i === 0 && j === 0) continue;
                const newY = y + j;
                if (newY < 0 || newY >= rows) continue;
                const newX = (x + i + cols) % cols; // Handles world wrapping
                // Prevent diagonal cutting across two land cells
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
}

module.exports = AStarPathfinder;