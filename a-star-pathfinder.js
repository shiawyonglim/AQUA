// A* Pathfinder for fuel-efficient navigation

// MinHeap data structure to get the node with the lowest 'f' score. 
class MinHeap {
    constructor() { this.heap = []; } // Empty array to store the heap. 
    push(node) { this.heap.push(node); this.bubbleUp(); } // add new node and reorder the heap. 
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
            if (node.f >= parent.f) {
                break
            };
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
                if (leftChild.f < node.f) {
                    swap = leftChildIdx
                };
            }
            if (rightChildIdx < length) {
                let rightChild = this.heap[rightChildIdx];
                if ((swap === null && rightChild.f < node.f) || (swap !== null && rightChild.f < this.heap[swap].f)) {
                    swap = rightChildIdx;
                }
            }
            if (swap === null) {
                break
            };
            this.heap[index] = this.heap[swap];
            this.heap[swap] = node;
            index = swap;
        }
    }
}

class AStarPathfinder {
    /**
     * FIX: Added a constructor to properly initialize the pathfinder with depth data.
     * The depthGrid is now stored as a property of the class instance.
     * @param {DepthGrid} depthGrid - The grid containing depth information.
     */
    constructor(depthGrid) {
        this.depthGrid = depthGrid;
    }

    /**
     * Finds the most fuel-efficient path using A* algorithm.
     * @param {NavigationGrid} landGrid - The grid defining land (1) and water (0).
     * @param {object} startLatLng - The starting coordinates { lat, lng }.
     * @param {object} endLatLng - The ending coordinates { lat, lng }.
     * @param {object} params - All the parameters for the fuel formula.
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
        const closedSet = new Set(); // set of nodes. 
        const gScores = new Map(); // total fuel consumed (Liters)

        const startKey = `${startNode.x},${startNode.y}`;
        gScores.set(startKey, 0);

        const initialHeuristic = this.heuristic(startNode, endNode, landGrid, params);
        openSet.push({ ...startNode, g: 0, h: initialHeuristic, f: initialHeuristic, parent: null });

        while (openSet.size() > 0) {
            let currentNode = openSet.pop();
            const currentKey = `${currentNode.x},${currentNode.y}`;

            if (closedSet.has(currentKey)) {
                continue;
            }

            if (currentNode.x === endNode.x && currentNode.y === endNode.y) {
                let path = [];
                let temp = currentNode;
                while (temp) {
                    path.push({
                        ...landGrid.gridToLatLng(temp.x, temp.y),
                        onLand: landGrid.grid[temp.x][temp.y] === 1,
                        totalFuel: temp.g // Include the final fuel consumption
                    });
                    temp = temp.parent;
                }
                return path.reverse();
            }

            closedSet.add(currentKey);

            const neighbors = this.getNeighbors(currentNode, landGrid);
            for (const neighbor of neighbors) {
                const neighborKey = `${neighbor.x},${neighbor.y}`;
                if (closedSet.has(neighborKey)) {
                    continue
                };

                const isNeighborLand = landGrid.grid[neighbor.x][neighbor.y] === 1;
                const isNeighborDestination = neighbor.x === endNode.x && neighbor.y === endNode.y;
                const isCurrentNodeWater = landGrid.grid[currentNode.x][currentNode.y] === 0;

                if (isCurrentNodeWater && isNeighborLand && !isNeighborDestination) {
                    continue; // Skip water to land transitions unless it's the destination
                }

                // calculate the distance between the current node and the neighbor
                const distanceKm = this.calculateDistance(currentNode, neighbor, landGrid);
                // calculate fuel consumption for this segment
                const fuelForSegment = this.calculateFuelPerKm(params, currentNode, landGrid) * distanceKm;
                // total fuel consumed so far
                const gScore = currentNode.g + fuelForSegment; //

                // Check if this path to the neighbor is the most fuel-efficient one found so far.
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

    /**
     * Gets the depth value for a given grid node.
     * @param {object} node - The grid node { x, y }.
     * @param {NavigationGrid} landGrid - The land grid for coordinate conversion.
     * @returns {number} The depth factor.
     */
    getDepth(node, landGrid) {
        // FIX: Use this.depthGrid which is initialized in the constructor (was this.depthCache)
        if (!this.depthGrid || !this.depthGrid.grid) {
            return 1; // Default depth factor if no data is available
        }
        
        const { lat, lng } = landGrid.gridToLatLng(node.x, node.y);
        
        // Convert lat/lng to the depth grid's coordinate system
        const x = Math.floor((lng - this.depthGrid.bounds.west) / this.depthGrid.resolution);
        const y = Math.floor((lat - this.depthGrid.bounds.south) / this.depthGrid.resolution);

        // FIX: Check bounds and fix typo from 'gird' to 'grid'
        if (x < 0 || x >= this.depthGrid.grid.length || y < 0 || y >= this.depthGrid.grid[0].length) {
            return 1; // Default depth if out of bounds
        }

        const depth = Math.abs(this.depthGrid.grid[x][y]);
        

        // Return a depth factor, ensuring it's at least 1
        return Math.max(depth, 1);
    }



    /**
     * The core fuel consumption rate per km (including depth) 
     */
    calculateFuelPerKm(params, currentNode, landGrid) {
        const { speed, hpReq, fuelRate, k, baseWeight, load, F, S } = params;
        const speedKmh = speed * 1.852; // convert knots to km/h
        if (speedKmh === 0) {
            return Infinity; // Avoid division by zero
        }

        const depth = this.getDepth(currentNode, landGrid);
        console.log(`Depth ${depth}`);
        // The formula seems to use depth as a multiplier. Assuming this is the intended logic.

        const fuelPerKm = (((hpReq * 0.62) * fuelRate * (1 + k * (load / baseWeight)) * F * S * depth) / speedKmh);
        return fuelPerKm;
    }



    /**
     * Heuristic now estimates the MINIMUM POSSIBLE FUEL to the destination.
     * A straight line distance is used to estimate the fuel cost. 
     */
    heuristic(a, b, grid, params) {
        // calculated the straight-line distance between two grid points in km. 
        const distanceKm = this.calculateDistance(a, b, grid);
        // Estimate fuel cost for a straight line at the current parameters
        return this.calculateFuelPerKm(params, a, grid) * distanceKm;
    }

    /**
     * Calculate great-circle distance (shortest distance over earth's surface)
     */
    calculateDistance(a, b, grid) {
        const R = 6371;
        const p1 = grid.gridToLatLng(a.x, a.y);
        const p2 = grid.gridToLatLng(b.x, b.y);

        // convert kat and lng ro radins 
        const radLat1 = p1.lat * Math.PI / 180;
        const radLat2 = p2.lat * Math.PI / 180;
        const dLat = (p2.lat - p1.lat) * Math.PI / 180;
        const dLon = (p2.lng - p1.lng) * Math.PI / 180;

        // Haversine formula to calculate the distance
        const val = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(radLat1) * Math.cos(radLat2) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(val), Math.sqrt(1-val)); 
        return R * c; // distance in km
    }


    getNeighbors(node, grid) {
        const neighbors = [];
        const { x, y } = node;
        const { cols, rows } = grid;

        for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
                if (i === 0 && j === 0) {
                    continue;
                }
                const newY = y + j;
                if (newY < 0 || newY >= rows) {
                    continue;
                }
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
}

module.exports = AStarPathfinder;
