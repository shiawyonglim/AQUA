// boat.js
import { logEnvData } from './api.js';
import { updateHudWithLiveData, showMessage, showProximityAlert } from './ui.js';
import { state } from './state.js';
import { checkProximityToRisk } from './risk.js';
import { getEffectiveSpeed } from './app.js';

export class BoatAnimator {
    constructor(map) {
        this.map = map;
        this.boatMarker = null;
        this.trailLine = null;
        this.animationFrameId = null;
        this.isAnimating = false;
        this.environmentalParams = {};
        this.path = [];
        this.totalDistanceKm = 0;
        this.turfLine = null;
        this.lastUpdateTime = 0;
        this.distanceTraveledKm = 0;

        // --- PROPERTIES FOR GRID-BASED LOGGING ---
        this.gridInfo = null;
        this.lastGridCell = { x: -1, y: -1 };
        this.gridCellsSinceLastLog = 0;
        this.LOG_INTERVAL_GRIDS = 5;
        this.SIMULATION_FRAME_SECONDS = 1;
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

    _latLngToGrid(lat, lng) {
        if (!this.gridInfo) return null;
        const x = Math.floor((lng - this.gridInfo.bounds.west) / this.gridInfo.resolution);
        const y = Math.floor((lat - this.gridInfo.bounds.south) / this.gridInfo.resolution);
        return { x, y };
    }

    startAnimation(path, params, totalDistanceKm, gridInfo) {
        if (!path || path.length < 2) {
            console.error("Animation started with an invalid path.");
            return;
        }

        this.stopAnimation();
        this.isAnimating = true;
        this.environmentalParams = params;
        this.totalDistanceKm = totalDistanceKm;
        this.distanceTraveledKm = 0;
        this.lastUpdateTime = performance.now();
        this.path = path;

        this.gridInfo = gridInfo;
        this.gridCellsSinceLastLog = 0;
        const startLatLng = path[0];
        const startGridCell = this._latLngToGrid(startLatLng.lat, startLatLng.lng);
        if (startGridCell) this.lastGridCell = startGridCell;

        const lineCoords = path.map(p => [p.lng, p.lat]);
        this.turfLine = turf.lineString(lineCoords);

        const startPoint = turf.along(this.turfLine, 0, { units: 'kilometers' });
        this.boatMarker = L.marker([startPoint.geometry.coordinates[1], startPoint.geometry.coordinates[0]], {
            icon: this._createBoatIcon(),
            zIndexOffset: 1000
        }).addTo(this.map);

        this.trailLine = L.polyline([], { color: '#1d4ed8', weight: 5 }).addTo(this.map);

        document.getElementById('hud-animation-progress').classList.remove('hidden');
        document.getElementById('turn-by-turn-panel').classList.remove('hidden');

        this._animate();
    }

    _animate() {
        if (!this.isAnimating) return;

        // MERGED: Includes anchor pause logic
        if (state.isAnchored) {
            this.lastUpdateTime = performance.now();
            this.animationFrameId = requestAnimationFrame(() => this._animate());
            return;
        }

        this.animationFrameId = requestAnimationFrame((timestamp) => {
            if (!this.isAnimating || state.isAnchored) {
                if (state.isAnchored) this._animate();
                return;
            }

            const speedMultiplier = parseFloat(document.getElementById('animationSpeed').value) || 1;

            // MERGED: Uses the dynamic, realistic speed calculation
            const currentSpeedKnots = this.calculateCurrentSpeed();
            const speedKmsPerSecond = (currentSpeedKnots * 1.852) / 3600;
            const distanceMovedKm = speedKmsPerSecond * this.SIMULATION_FRAME_SECONDS * speedMultiplier;

            this.distanceTraveledKm += distanceMovedKm;

            if (this.distanceTraveledKm >= this.totalDistanceKm) {
                this.isAnimating = false;
                showMessage('Animation finished. Route complete!', 'green');
                return;
            }

            const currentPoint = turf.along(this.turfLine, this.distanceTraveledKm, { units: 'kilometers' });
            const currentLatLng = [currentPoint.geometry.coordinates[1], currentPoint.geometry.coordinates[0]];

            if (this.boatMarker) this.boatMarker.setLatLng(currentLatLng);

            const boatBearing = this.updateBearingAndRotation(currentPoint);
            this.updateTrail(currentPoint);
            this.updateAnimationProgress(this.totalDistanceKm - this.distanceTraveledKm, currentSpeedKnots);
            this.updateTurnInstruction(this.path, this.distanceTraveledKm, boatBearing);

            // MERGED: Includes proactive risk checking
            const currentSegmentIndex = this.findCurrentSegmentIndex(this.path, this.distanceTraveledKm);
            if (currentSegmentIndex !== null) {
                const approachingZone = checkProximityToRisk(currentSegmentIndex);
                if (approachingZone) {
                    showProximityAlert(approachingZone);
                    state.notifiedRiskZones.add(approachingZone.id);
                }

                if (this.path.length > 0 && this.path[0].env && this.gridInfo) {
                    const currentGridCell = this._latLngToGrid(currentLatLng[0], currentLatLng[1]);
                    if (currentGridCell && (currentGridCell.x !== this.lastGridCell.x || currentGridCell.y !== this.lastGridCell.y)) {
                        this.gridCellsSinceLastLog++;
                        this.lastGridCell = currentGridCell;
                        if (this.gridCellsSinceLastLog >= this.LOG_INTERVAL_GRIDS) {
                            this.gridCellsSinceLastLog = 0;
                            const envData = this.path[currentSegmentIndex].env;
                            if (envData) {
                                envData.lat = currentLatLng[0];
                                envData.lon = currentLatLng[1];
                                logEnvData(envData);
                                updateHudWithLiveData(envData);
                            }
                        }
                    }
                }
            }
            this._animate();
        });
    }

    stopAnimation() {
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        this.isAnimating = false;
        this.distanceTraveledKm = 0;

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

    updateBearingAndRotation(currentPoint) {
        let bearing = 0;
        if (this.distanceTraveledKm < this.totalDistanceKm) {
            const nextPoint = turf.along(this.turfLine, this.distanceTraveledKm + 0.1, { units: 'kilometers' });
            bearing = turf.bearing(currentPoint, nextPoint);
        } else {
            const prevPoint = turf.along(this.turfLine, this.totalDistanceKm - 0.1, { units: 'kilometers' });
            bearing = turf.bearing(prevPoint, currentPoint);
        }
        if (this.boatMarker && this.boatMarker.getElement()) {
            const rotator = this.boatMarker.getElement().querySelector('.boat-rotator');
            if (rotator) rotator.style.transform = `rotate(${bearing}deg)`;
        }
        return bearing;
    }

    updateTrail(currentPoint) {
        if (!this.trailLine) return;
        const startOfLine = turf.point(this.turfLine.geometry.coordinates[0]);
        const trailGeoJSON = turf.lineSlice(startOfLine, currentPoint, this.turfLine);
        const trailLatLngs = trailGeoJSON.geometry.coordinates.map(coords => [coords[1], coords[0]]);
        this.trailLine.setLatLngs(trailLatLngs);
    }

    // MERGED: This is the advanced, dynamic speed calculation method
    calculateCurrentSpeed() {
        if (!this.path || this.path.length === 0) {
            return parseFloat(document.getElementById('shipSpeed').value) || 15;
        }

        const params = {
            shipLength: parseFloat(document.getElementById('shipLength').value),
            beam: parseFloat(document.getElementById('beam').value),
            speed: parseFloat(document.getElementById('shipSpeed').value),
            draft: parseFloat(document.getElementById('shipDraft').value),
            hpReq: parseFloat(document.getElementById('hpReq').value),
            fuelRate: parseFloat(document.getElementById('fuelRate').value),
            k: parseFloat(document.getElementById('hullFactor').value),
            baseWeight: parseFloat(document.getElementById('baseWeight').value),
            load: parseFloat(document.getElementById('load').value),
            F: parseFloat(document.getElementById('foulingFactor').value),
            S: parseFloat(document.getElementById('seaStateFactor').value),
        };

        const currentSegmentIndex = this.findCurrentSegmentIndex(this.path, this.distanceTraveledKm);
        const currentPoint = this.path[currentSegmentIndex];
        const nextPoint = this.path[currentSegmentIndex + 1] || currentPoint;

        if (!currentPoint || !currentPoint.env) {
            return params.speed || 15;
        }

        const bearing = turf.bearing(
            turf.point([currentPoint.lng, currentPoint.lat]),
            turf.point([nextPoint.lng, nextPoint.lat])
        );

        const envData = currentPoint.env;
        const baseSpeedKmh = params.speed * 1.852;
        const effectiveSpeedKmh = getEffectiveSpeed(baseSpeedKmh, envData, bearing, params);

        return effectiveSpeedKmh / 1.852;
    }

    updateAnimationProgress(distanceLeftKm, currentSpeedKnots) {
        const speedKmh = currentSpeedKnots * 1.852;
        const totalHoursLeft = speedKmh > 0 ? distanceLeftKm / speedKmh : Infinity;
        const days = Math.floor(totalHoursLeft / 24);
        const remainingHours = Math.round(totalHoursLeft % 24);
        document.getElementById('hud-current-speed').textContent = `${currentSpeedKnots.toFixed(1)} kts`;
        document.getElementById('hud-distance-left').textContent = `${distanceLeftKm.toFixed(0)} km`;
        document.getElementById('hud-time-left').textContent = `${days}d ${remainingHours}h`;
    }

    updateTurnInstruction(path, distanceAlong, currentBearing) {
        let nextTurnPointIndex = -1;
        let cumulativeDistance = 0;
        for (let i = 1; i < path.length - 1; i++) {
            const p1 = turf.point([path[i - 1].lng, path[i - 1].lat]);
            const p2 = turf.point([path[i].lng, path[i].lat]);
            cumulativeDistance += turf.distance(p1, p2);
            if (cumulativeDistance > distanceAlong) {
                const p3 = turf.point([path[i + 1].lng, path[i + 1].lat]);
                const bearing1 = turf.bearing(p1, p2);
                const bearing2 = turf.bearing(p2, p3);
                let turnAngle = bearing2 - bearing1;
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
            const nextBearing = turf.bearing(turf.point([turnNode.lng, turnNode.lat]), turf.point([nextSegmentNode.lng, nextSegmentNode.lat]));
            let turnAngle = nextBearing - currentBearing;
            if (turnAngle > 180) turnAngle -= 360;
            if (turnAngle < -180) turnAngle += 360;
            const direction = turnAngle > 0 ? "Starboard" : "Port";
            document.getElementById('turn-instruction').textContent = `Turn ${Math.abs(turnAngle).toFixed(0)}° ${direction}`;
            document.getElementById('turn-distance').textContent = `In ${distanceToTurn.toFixed(1)} km`;
        } else {
            document.getElementById('turn-instruction').textContent = "Maintain Course";
            const distanceToDestination = this.totalDistanceKm - distanceAlong;
            document.getElementById('turn-distance').textContent = `Destination in ${distanceToDestination.toFixed(1)} km`;
        }
    }

    findCurrentSegmentIndex(path, distanceAlong) {
        if (!path || path.length < 2) return null;
        if (distanceAlong <= 0) return 0;
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
