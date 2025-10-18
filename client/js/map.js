// map.js
import { onMapClick } from './app.js';
import { state } from './state.js';
import { showMessage } from './ui.js';
import * as App from './app.js'; // Import all app functions

let map;

/**
 * Initializes the Leaflet map and its layers.
 */
export function initializeMap() {
    map = L.map('map', { 
        center: [1.3521, 103.8198], 
        zoom: 7, 
        zoomControl: false, 
        doubleClickZoom: false 
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd', maxZoom: 20
    }).addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    
    // MERGED: Initialize all required layers, including the new riskyZonesLayer
    state.routeLayer = L.layerGroup().addTo(map);
    state.criticalPointsLayer = L.layerGroup().addTo(map);
    state.riskyZonesLayer = L.layerGroup().addTo(map);
    
    map.on('dblclick', onMapClick);

    // Call function to add custom controls
    initializeCustomControls();

    return map;
}

/**
 * Initializes the Leaflet.draw controls for No-Go zones.
 */
export function initializeDrawControls() {
    state.drawnItems = new L.FeatureGroup();
    map.addLayer(state.drawnItems);

    const drawControl = new L.Control.Draw({
        position: 'bottomright',
        edit: {
            featureGroup: state.drawnItems,
            remove: true
        },
        draw: {
            polygon: { shapeOptions: { color: '#f06eaa', weight: 2, fillOpacity: 0.3 } },
            rectangle: { shapeOptions: { color: '#f06eaa', weight: 2, fillOpacity: 0.3 } },
            polyline: false, circle: false, marker: false, circlemarker: false,
        },
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, (event) => {
        const layer = event.layer;
        state.drawnItems.addLayer(layer);
        state.noGoZones.push(layer.toGeoJSON());
        showMessage('No-Go zone added. It will be applied on the next route calculation.', 'purple');
    });

    map.on(L.Draw.Event.EDITED, () => {
        state.noGoZones = [];
        state.drawnItems.eachLayer(layer => {
            state.noGoZones.push(layer.toGeoJSON());
        });
        showMessage('No-Go zones updated.', 'purple');
    });

    map.on(L.Draw.Event.DELETED, () => {
        state.noGoZones = [];
        state.drawnItems.eachLayer(layer => {
            state.noGoZones.push(layer.toGeoJSON());
        });
        showMessage('No-Go zones removed.', 'purple');
    });
}

/**
 * Creates and adds all the custom icon buttons to the map.
 */
function initializeCustomControls() {
    const CustomControl = L.Control.extend({
        options: { position: 'bottomright', icon: '', title: '', action: () => {}, id: '' },
        onAdd: function() {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
            
            if (this.options.id) {
                container.id = this.options.id;
            }

            const link = L.DomUtil.create('a', 'custom-control bg-gray-700 hover:bg-gray-600 flex items-center justify-center w-9 h-9 rounded-md shadow-md', container);
            link.href = '#';
            link.title = this.options.title;
            link.innerHTML = this.options.icon;
            link.setAttribute('role', 'button');

            L.DomEvent.on(container, 'click', (e) => {
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);
                this.options.action(e); // Pass the raw event to the action
            });
            return container;
        }
    });

    const resetIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-refresh-cw"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
    const boatIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-send"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
    const anchorIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22V8M5 12H2a10 10 0 0 0 20 0h-3M12 8a4 4 0 0 0-4 4h8a4 4 0 0 0-4-4z"></path></svg>`;

    new CustomControl({ icon: resetIcon, title: 'Reset Route', action: App.resetNavigation }).addTo(map);

    // MERGED: Add the anchor button
    new CustomControl({
        id: 'anchor-button-container', 
        icon: anchorIcon,
        title: 'Toggle Anchor',
        action: App.toggleAnchor
    }).addTo(map);

    new CustomControl({
        id: 'toggle-animation-button-container',
        icon: boatIcon,
        title: 'Toggle Boat Animation',
        action: App.toggleBoatAnimation
    }).addTo(map);

    const animContainer = document.getElementById('toggle-animation-button-container');
    if (animContainer) {
        animContainer.querySelector('a').id = 'toggle-animation-button';
    }

    const anchorContainer = document.getElementById('anchor-button-container');
    if (anchorContainer) {
        anchorContainer.querySelector('a').id = 'anchor-button';
    }
    
    // MERGED: Add styling for both toggled-on buttons (animation and anchor)
    const style = document.createElement('style');
    style.innerHTML = `
        a#toggle-animation-button.toggled-on, a#anchor-button.toggled-on { 
            background-color: #3b82f6 !important; 
            animation: pulse 1s infinite;
        }
        @keyframes pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); } 
            50% { box-shadow: 0 0 0 5px rgba(59, 130, 246, 0); }
        }
        .boat-icon-wrapper { transition: transform 0.1s linear; }
    `;
    document.head.appendChild(style);
}
