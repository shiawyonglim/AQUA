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
     * Finds the most fuel-efficient path.
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

        // --- FIX: Use Set and Map for memory efficiency on large grids ---
        const openSet = new MinHeap();
        const closedSet = new Set();
        const gScores = new Map(); // gScore is now total fuel consumed in Liters

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
                if (closedSet.has(neighborKey)) continue;

                const isNeighborLand = landGrid.grid[neighbor.x][neighbor.y] === 1;
                const isNeighborDestination = neighbor.x === endNode.x && neighbor.y === endNode.y;
                const isCurrentNodeWater = landGrid.grid[currentNode.x][currentNode.y] === 0;

                if (isCurrentNodeWater && isNeighborLand && !isNeighborDestination) {
                    continue;
                }

                const distanceKm = this.calculateDistance(currentNode, neighbor, landGrid);
                let fuelForSegment = this.calculateFuelPerKm(params) * distanceKm;
                
                if (isNeighborLand) {
                    fuelForSegment *= 1000;
                }

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
    
    calculateFuelPerKm(params) {
        const { speed, hpReq, fuelRate, k, baseWeight, load, F, S } = params;
        const speedKmh = speed * 1.852;
        if (speedKmh === 0) return Infinity;

        const fuelPerKm = (((hpReq * 0.62) * fuelRate * (1 + k * (load / baseWeight)) * F * S) / speedKmh);
        return fuelPerKm;
    }

    heuristic(a, b, grid, params) {
        const distanceKm = this.calculateDistance(a, b, grid);
        return this.calculateFuelPerKm(params) * distanceKm;
    }

    calculateDistance(a, b, grid) {
        const R = 6371;
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
