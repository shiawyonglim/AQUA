// ============================================================
// BOAT ANIMATION MODULE (boat.js)
// ============================================================
const animationDurationSeconds = 30;
class BoatAnimator {
    constructor(map) {
        this.map = map;
        this.boatMarker = null;
        this.trailLine = null;
        this.animationFrameId = null;
        this.isAnimating = false;
        this.environmentalParams = {};
    }

    _createBoatIcon() {
        const boatSVG = `<div class="boat-rotator"><svg class="boat-icon" width="24" height="24" viewBox="0 0 24 24" fill="#3b82f6" stroke="white" stroke-width="1.5"><path d="M12 2L2 19h20L12 2z"/></svg></div>`;
        return L.divIcon({
            html: boatSVG,
            className: 'boat-icon-wrapper',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });
    }

    /**
     * Starts the boat animation along a given path.
     * @param {Array<object>} path - An array of {lat, lng} points for the route.
     * @param {object} params - Static vessel and environmental parameters from the UI.
     * @param {number} totalDistanceKm - The pre-calculated total distance of the route.
     */
    startAnimation(path, params, totalDistanceKm) {
        // --- FIX: This function is now safer. The primary check for a valid path
        // is now handled in main.js before this is ever called. ---
        if (!path || path.length < 2) {
            console.error("Animation started with an invalid path.");
            return;
        }

        // This ensures any previous animation is completely stopped before starting a new one.
        this.stopAnimation();
        this.isAnimating = true;
        this.environmentalParams = params;

        const lineCoords = path.map(p => [p.lng, p.lat]);
        const turfLine = turf.lineString(lineCoords);

        // Always create a fresh marker and trail for the new animation
        const startLatLng = [path[0].lat, path[0].lng];
        this.boatMarker = L.marker(startLatLng, {
            icon: this._createBoatIcon(),
            zIndexOffset: 1000
        }).addTo(this.map);
        
        this.trailLine = L.polyline([], { color: '#1d4ed8', weight: 5 }).addTo(this.map);

        document.getElementById('hud-animation-progress').classList.remove('hidden');
        document.getElementById('turn-by-turn-panel').classList.remove('hidden');

        const startTime = performance.now();
        const durationMs = animationDurationSeconds * 1000;

        const animate = (timestamp) => {
            if (!this.isAnimating) return;

            const elapsed = timestamp - startTime;
            let progress = elapsed / durationMs;
            if (progress > 1) progress = 1;

            const distanceAlong = totalDistanceKm * progress;
            const currentPoint = turf.along(turfLine, distanceAlong, { units: 'kilometers' });
            const currentLatLng = [currentPoint.geometry.coordinates[1], currentPoint.geometry.coordinates[0]];
            
            if (this.boatMarker) {
                this.boatMarker.setLatLng(currentLatLng);
            }

            const boatBearing = this.updateBearingAndRotation(currentPoint, distanceAlong, turfLine, totalDistanceKm);
            this.updateTrail(currentPoint, turfLine);
            const currentSpeed = this.calculateCurrentSpeed(boatBearing);
            this.updateAnimationProgress(totalDistanceKm - distanceAlong, currentSpeed);
            this.updateTurnInstruction(path, distanceAlong, boatBearing);
            
            // This is the new call to update the live HUD data
            if (path[0].env) { // Check if the path is enriched
                const currentSegmentIndex = this.findCurrentSegmentIndex(path, distanceAlong);
                if (path[currentSegmentIndex] && path[currentSegmentIndex].env) {
                    updateHudWithLiveData(path[currentSegmentIndex].env);
                }
            }


            if (progress < 1) {
                this.animationFrameId = requestAnimationFrame(animate);
            } else {
                this.isAnimating = false;
                document.getElementById('turn-instruction').textContent = "Arrived at Destination";
                document.getElementById('turn-distance').textContent = "";
                showMessage('Animation finished.', 'green');
            }
        };

        this.animationFrameId = requestAnimationFrame(animate);
    }

    // --- FIX: stopAnimation now ensures all components are removed and reset ---
    stopAnimation() {
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        this.isAnimating = false;

        if (this.boatMarker) {
            this.map.removeLayer(this.boatMarker);
            this.boatMarker = null;
        }
        if (this.trailLine) {
            this.map.removeLayer(this.trailLine);
            this.trailLine = null;
        }
        
        document.getElementById('hud-animation-progress').classList.add('hidden');
        document.getElementById('turn-by-turn-panel').classList.add('hidden');
    }

    updateBearingAndRotation(currentPoint, distanceAlong, turfLine, totalDistance) {
        let bearing = 0;
        if (distanceAlong < totalDistance) {
            const nextPoint = turf.along(turfLine, distanceAlong + 0.1, { units: 'kilometers' });
            bearing = turf.bearing(currentPoint, nextPoint);
        } else {
            const prevPoint = turf.along(turfLine, totalDistance - 0.1, { units: 'kilometers' });
            bearing = turf.bearing(prevPoint, currentPoint);
        }
        
        if (this.boatMarker && this.boatMarker.getElement()) {
            const iconElement = this.boatMarker.getElement();
            const rotator = iconElement.querySelector('.boat-rotator');
            if (rotator) {
                rotator.style.transformOrigin = 'center center';
                rotator.style.transform = `rotate(${bearing}deg)`;
            }
        }
        return bearing;
    }

    updateTrail(currentPoint, turfLine) {
        if (!this.trailLine) return;
        const startOfLine = turf.point(turfLine.geometry.coordinates[0]);
        const trailGeoJSON = turf.lineSlice(startOfLine, currentPoint, turfLine);
        const trailLatLngs = trailGeoJSON.geometry.coordinates.map(coords => [coords[1], coords[0]]);
        this.trailLine.setLatLngs(trailLatLngs);
    }

    calculateCurrentSpeed(boatBearing) {
        let baseSpeed = parseFloat(this.environmentalParams.speed);
        if (isNaN(baseSpeed) || baseSpeed <= 0) {
            baseSpeed = 15;
        }
        let speedModifier = 0;
        const windAngleDiff = Math.abs(boatBearing - this.environmentalParams.windDirection);
        speedModifier -= this.environmentalParams.windStrength * Math.cos(windAngleDiff * Math.PI / 180) * 0.5;
        const currentAngleDiff = Math.abs(boatBearing - this.environmentalParams.currentDirection);
        speedModifier -= this.environmentalParams.currentStrength * Math.cos(currentAngleDiff * Math.PI / 180) * 1.5;
        return Math.max(0.1, baseSpeed + speedModifier);
    }

    updateAnimationProgress(distanceLeftKm, currentSpeedKnots) {
        const timeHoursLeft = currentSpeedKnots > 0 ? distanceLeftKm / (currentSpeedKnots * 1.852) : Infinity;
        const days = Math.floor(timeHoursLeft / 24);
        const remainingHours = Math.round(timeHoursLeft % 24);
    
        document.getElementById('hud-current-speed').textContent = `${currentSpeedKnots.toFixed(1)} kts`;
        document.getElementById('hud-distance-left').textContent = `${distanceLeftKm.toFixed(0)} km`;
        document.getElementById('hud-time-left').textContent = `${days}d ${remainingHours}h`;
    }

    updateTurnInstruction(path, distanceAlong, currentBearing) {
        let nextTurnPointIndex = -1;
        let cumulativeDistance = 0;
        for (let i = 1; i < path.length - 1; i++) {
            const p1 = turf.point([path[i-1].lng, path[i-1].lat]);
            const p2 = turf.point([path[i].lng, path[i].lat]);
            const p3 = turf.point([path[i+1].lng, path[i+1].lat]);
            
            cumulativeDistance += turf.distance(p1, p2);

            if (cumulativeDistance > distanceAlong) {
                const bearing1 = turf.bearing(p1, p2);
                const bearing2 = turf.bearing(p2, p3);
                let turnAngle = bearing2 - bearing1;
                if (turnAngle > 180) turnAngle -= 360;
                if (turnAngle < -180) turnAngle += 360;

                if (Math.abs(turnAngle) > 15) {
                    nextTurnPointIndex = i;
                    break;
                }
            }
        }

        if (nextTurnPointIndex !== -1) {
            const distanceToTurn = cumulativeDistance - distanceAlong;
            const turnNode = path[nextTurnPointIndex];
            const nextSegmentNode = path[nextTurnPointIndex + 1];
            
            const nextBearing = turf.bearing(
                turf.point([turnNode.lng, turnNode.lat]),
                turf.point([nextSegmentNode.lng, nextSegmentNode.lat])
            );
            let turnAngle = nextBearing - currentBearing;
            if (turnAngle > 180) turnAngle -= 360;
            if (turnAngle < -180) turnAngle += 360;

            const direction = turnAngle > 0 ? "Starboard" : "Port";
            
            document.getElementById('turn-instruction').textContent = `Turn ${Math.abs(turnAngle).toFixed(0)}° ${direction}`;
            document.getElementById('turn-distance').textContent = `In ${distanceToTurn.toFixed(1)} km`;
        } else {
            document.getElementById('turn-instruction').textContent = "Maintain Course";
            const distanceToDestination = turf.length(turf.lineString(path.map(p => [p.lng, p.lat]))) - distanceAlong;
            document.getElementById('turn-distance').textContent = `Destination in ${distanceToDestination.toFixed(1)} km`;
        }
    }
    
    findCurrentSegmentIndex(path, distanceAlong) {
        let cumulativeDistance = 0;
        for (let i = 1; i < path.length; i++) {
            const from = turf.point([path[i - 1].lng, path[i - 1].lat]);
            const to = turf.point([path[i].lng, path[i].lat]);
            cumulativeDistance += turf.distance(from, to, { units: 'kilometers' });
            if (cumulativeDistance >= distanceAlong) {
                return i - 1;
            }
        }
        return path.length - 2;
    }
}

