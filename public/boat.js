// ============================================================
// BOAT ANIMATION MODULE (boat.js)
// This module handles the boat animation and progress trail.
// ============================================================

class BoatAnimator {
    constructor(map) {
        this.map = map;
        this.boatMarker = null;
        this.trailLine = null; // NEW: Layer for the completed route trail
        this.animationFrameId = null;
        this.isAnimating = false;
    }

    _createBoatIcon() {
        const boatSVG = `<svg class="boat-icon" width="24" height="24" viewBox="0 0 24 24" fill="#3b82f6" stroke="white" stroke-width="1.5"><path d="M12 2L2 19h20L12 2z"/></svg>`;
        return L.divIcon({
            html: boatSVG,
            className: 'boat-icon-wrapper',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });
    }

    startAnimation(path, animationDurationSeconds = 30) {
        if (!path || path.length < 2) {
            showMessage('No route available to animate.', 'red');
            return;
        }
        this.stopAnimation();

        const lineCoords = path.map(p => [p.lng, p.lat]);
        const turfLine = turf.lineString(lineCoords);
        const totalDistance = turf.length(turfLine, { units: 'kilometers' });
        
        // FIX: Ensure the boat marker is created at the correct starting position
        const startLatLng = [path[0].lat, path[0].lng];
        this.boatMarker = L.marker(startLatLng, {
            icon: this._createBoatIcon(),
            zIndexOffset: 1000
        }).addTo(this.map);

        // NEW: Create the trail line with a darker blue color
        this.trailLine = L.polyline([], { 
            color: '#1d4ed8', // A darker shade of blue
            weight: 5 
        }).addTo(this.map);

        document.getElementById('animation-display').classList.remove('hidden');
        this.isAnimating = true;
        const startTime = performance.now();
        const durationMs = animationDurationSeconds * 1000;

        const animate = (timestamp) => {
            if (!this.isAnimating) return;

            const elapsed = timestamp - startTime;
            let progress = elapsed / durationMs;
            if (progress > 1) progress = 1;

            const distanceAlong = totalDistance * progress;
            const currentPoint = turf.along(turfLine, distanceAlong, { units: 'kilometers' });
            
            this.boatMarker.setLatLng([currentPoint.geometry.coordinates[1], currentPoint.geometry.coordinates[0]]);

            let bearing = 0;
            if (progress < 1.0) {
                const nextPoint = turf.along(turfLine, distanceAlong + 0.1, { units: 'kilometers' });
                bearing = turf.bearing(currentPoint, nextPoint);
            } else {
                const prevPoint = turf.along(turfLine, totalDistance - 0.1, { units: 'kilometers' });
                bearing = turf.bearing(prevPoint, currentPoint);
            }
            
            const iconElement = this.boatMarker.getElement();
            if (iconElement) {
                iconElement.style.transformOrigin = 'center center';
                iconElement.style.transform = `rotate(${bearing}deg)`;
            }

            // NEW: Update the trail line using Turf.js lineSlice
            const startOfLine = turf.point(turfLine.geometry.coordinates[0]);
            const trailGeoJSON = turf.lineSlice(startOfLine, currentPoint, turfLine);
            const trailLatLngs = trailGeoJSON.geometry.coordinates.map(coords => [coords[1], coords[0]]);
            this.trailLine.setLatLngs(trailLatLngs);
            
            const shipSpeedKnots = parseFloat(document.getElementById('shipSpeed').value) || 15;
            this.updateAnimationProgress(totalDistance - distanceAlong, shipSpeedKnots);

            if (progress < 1) {
                this.animationFrameId = requestAnimationFrame(animate);
            } else {
                this.isAnimating = false;
                showMessage('Animation finished.', 'green');
            }
        };

        this.animationFrameId = requestAnimationFrame(animate);
    }

    stopAnimation() {
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
        }
        this.isAnimating = false;
        this.animationFrameId = null;

        if (this.boatMarker) {
            this.map.removeLayer(this.boatMarker);
            this.boatMarker = null;
        }
        // NEW: Remove the trail line when stopping the animation
        if (this.trailLine) {
            this.map.removeLayer(this.trailLine);
            this.trailLine = null;
        }
        document.getElementById('animation-display').classList.add('hidden');
    }

    updateAnimationProgress(distanceLeftKm, speedKnots) {
        const speedKmh = speedKnots * 1.852;
        const timeHoursLeft = speedKmh > 0 ? distanceLeftKm / speedKmh : 0;
        const days = Math.floor(timeHoursLeft / 24);
        const remainingHours = Math.round(timeHoursLeft % 24);
    
        document.getElementById('distance-left-value').textContent = `${distanceLeftKm.toFixed(0)} km`;
        document.getElementById('time-left-value').textContent = `${days}d ${remainingHours}h`;
    }
}