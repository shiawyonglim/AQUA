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
    constructor(grid, params) {
        this.grid = grid;
        this.params = params;
        // Store the function passed from server.js to get depth data
        this.getDepthFunction = params.getDepthFunction;
        this.draft = params.draft || 5; // Default draft of 5 meters
    }

    /**
     * Finds the optimal path using an async A* algorithm.
     * @param {object} startCoords - The starting coordinates {lat, lon}.
     * @param {object} endCoords - The ending coordinates {lat, lon}.
     * @returns {Promise<object>} A promise that resolves to the path and cost.
     */
    async findPath(startCoords, endCoords) {
        const grid = this.grid;
        const startNode = grid.latLngToGrid(startCoords.lat, startCoords.lon);
        const endNode = grid.latLngToGrid(endCoords.lat, endCoords.lon);

        if (!startNode || !endNode) {
            console.error("Start or end node is outside the grid bounds.");
            return { path: null, cost: 0 };
        }
        startNode.id = `${startNode.x}-${startNode.y}`;
        endNode.id = `${endNode.x}-${endNode.y}`;

        const openSet = new MinHeap();
        const cameFrom = new Map();
        const gScore = new Map();
        const fScore = new Map();
        const closedSet = new Set();

        gScore.set(startNode.id, 0);
        fScore.set(startNode.id, this.heuristic(startNode, endNode, grid));
        startNode.f = fScore.get(startNode.id);
        openSet.push(startNode);

        while (openSet.size() > 0) {
            const current = openSet.pop();

            if (current.id === endNode.id) {
                return { path: this.reconstructPath(cameFrom, current), cost: gScore.get(current.id) };
            }

            closedSet.add(current.id);

            for (const neighbor of this.getNeighbors(current, grid)) {
                if (closedSet.has(neighbor.id)) continue;

                // Await the cost calculation, as it now depends on async depth fetching
                const cost = await this.getCost(current, neighbor, grid);
                if (cost === Infinity) continue;

                let tentativeGScore = gScore.get(current.id) + cost;

                if (tentativeGScore < (gScore.get(neighbor.id) || Infinity)) {
                    cameFrom.set(neighbor.id, current);
                    gScore.set(neighbor.id, tentativeGScore);
                    const h = this.heuristic(neighbor, endNode, grid);
                    const newFScore = tentativeGScore + h;
                    fScore.set(neighbor.id, newFScore);
                    neighbor.f = newFScore;
                    openSet.push(neighbor);
                }
            }
        }

        return { path: null, cost: 0 }; // No path found
    }

    /**
     * Calculates the cost of moving between two nodes. Now async.
     * @param {object} a - The starting node.
     * @param {object} b - The destination node.
     * @param {object} grid - The navigation grid.
     * @returns {Promise<number>} The cost, or Infinity if the path is blocked.
     */
    async getCost(a, b, grid) {
        const p1 = grid.gridToLatLng(a.x, a.y);
        const p2 = grid.gridToLatLng(b.x, b.y);

        // Asynchronously get the depth at the destination node
        const depth = await this.getDepthAt(p2.lon, p2.lat);

        // If the water is shallower than the ship's draft, this path is impossible
        if (depth < this.draft) {
            return Infinity;
        }

        // Basic cost is the geographic distance (Haversine formula)
        const R = 6371; // Earth's radius in km
        const lat1 = p1.lat * Math.PI / 180;
        const lat2 = p2.lat * Math.PI / 180;
        const dLat = (p2.lat - p1.lat) * Math.PI / 180;
        const dLon = (p2.lng - p1.lng) * Math.PI / 180;
        const hav = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav));
        const distance = R * c;

        return distance; // Return distance as the base cost
    }
    
    /**
     * Retrieves depth for a coordinate using the provided async function.
     * @param {number} lon - The longitude.
     * @param {number} lat - The latitude.
     * @returns {Promise<number>} The depth value.
     */
    async getDepthAt(lon, lat) {
        if (!this.getDepthFunction) {
            return 100; // Return safe depth if no function is available
        }
        return await this.getDepthFunction(lon, lat);
    }

    reconstructPath(cameFrom, current) {
        const totalPath = [this.grid.gridToLatLng(current.x, current.y)];
        while (cameFrom.has(current.id)) {
            current = cameFrom.get(current.id);
            totalPath.unshift(this.grid.gridToLatLng(current.x, current.y));
        }
        return totalPath;
    }

    heuristic(a, b, grid) {
        const p1 = grid.gridToLatLng(a.x, a.y);
        const p2 = grid.gridToLatLng(b.x, b.y);
        const R = 6371;
        const dLat = (p2.lat - p1.lat) * Math.PI / 180;
        const dLon = (p2.lng - p1.lng) * Math.PI / 180;
        return R * Math.sqrt(dLat**2 + dLon**2);
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
                neighbors.push({ x: newX, y: newY, id: `${newX}-${newY}` });
            }
        }
        return neighbors;
    }
}

module.exports = AStarPathfinder;
