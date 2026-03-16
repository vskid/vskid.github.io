// ============================================================
// apps/vmap/vmap.js
// ============================================================
// Leaflet + OpenStreetMap world map.
// 
// Constraints:
//   • No infinite tiling — world bounds locked, noWrap tile layer
//   • minZoom = 2 (whole world fits), maxZoom = 18
//   • maxBoundsViscosity = 1.0 (hard wall at world edges)
//
// LoD (Level of Detail) marker system:
//   zoom 2–3  lod-dot    — small dot only
//   zoom 4–5  lod-label  — dot + city name label
//   zoom 6+   lod-detail — larger dot + full label
//
// City data comes from config.js CITIES.
// Each city needs a { lat, lng } to appear on the map.
// Cities without coordinates are silently skipped.
//
// Future transit fantasy layer:
//   Add routes as GeoJSON to the ROUTES export in config.js,
//   then call map.addLayer(L.geoJSON(ROUTES, { style: routeStyle }))
//   below the marker init.
// ============================================================

import { CITIES } from '../../core/config.js';

// Leaflet is loaded from CDN in vmap.html — accessed via window.L
// We load it dynamically here so it only loads when vMap is opened.

const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';

// ── LoD thresholds ────────────────────────────────────────
const LOD_DOT    = 'lod-dot';
const LOD_LABEL  = 'lod-label';
const LOD_DETAIL = 'lod-detail';

function getLod(zoom) {
    if (zoom >= 6) return LOD_DETAIL;
    if (zoom >= 4) return LOD_LABEL;
    return LOD_DOT;
}

// ── Load a script/link tag dynamically ───────────────────
function loadCSS(href) {
    if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
    return new Promise(resolve => {
        const el = document.createElement('link');
        el.rel  = 'stylesheet';
        el.href = href;
        el.onload = resolve;
        document.head.appendChild(el);
    });
}

function loadScript(src) {
    if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const el  = document.createElement('script');
        el.src    = src;
        el.onload = resolve;
        el.onerror = reject;
        document.head.appendChild(el);
    });
}

// ── Popup time display ────────────────────────────────────
function localTimeStr(tz) {
    const d = new Date();
    return d.toLocaleTimeString('en-US', {
        timeZone: tz,
        hour:     '2-digit',
        minute:   '2-digit',
        second:   '2-digit',
        hour12:   false,
    });
}

// ── App ───────────────────────────────────────────────────

export async function initVMap(desktop) {
    const { registerWindow, openWindow } = desktop;

    // Load our CSS
    const styleLink = document.createElement('link');
    styleLink.rel  = 'stylesheet';
    styleLink.href = new URL('vmap.css', import.meta.url).href;
    document.head.appendChild(styleLink);

    // Inject HTML
    try {
        const res  = await fetch(new URL('vmap.html', import.meta.url).href);
        const html = await res.text();
        document.body.insertAdjacentHTML('beforeend', html);
    } catch (err) {
        console.error('[vmap] Failed to load vmap.html', err);
        return;
    }

    const windowEl = document.getElementById('vmap-window');
    if (!windowEl) return;
    const entry = registerWindow(windowEl, { icon: '🗺' });

    document.getElementById('open-vmap')
        ?.addEventListener('dblclick', () => openWindow(entry));

    // ── Lazy-init the map — only once, on first open ──────
    let mapInitialised = false;

    function maybeInitMap() {
        if (mapInitialised) return;
        if (windowEl.classList.contains('hidden')) return;
        mapInitialised = true;
        initLeafletMap();
    }

    // Hook into openWindow by observing class changes
    const obs = new MutationObserver(maybeInitMap);
    obs.observe(windowEl, { attributes: true, attributeFilter: ['class'] });

    // ── Build the Leaflet map ─────────────────────────────
    async function initLeafletMap() {
        // Load Leaflet from CDN if not already present
        await loadCSS(LEAFLET_CSS);
        await loadScript(LEAFLET_JS);

        const L = window.L;

        // World bounds — no tiling beyond this
        const WORLD_BOUNDS = L.latLngBounds(
            L.latLng(-85.05, -180),
            L.latLng(85.05,   180)
        );

        const map = L.map('vmap-leaflet', {
            center:              [15, 100],   // Southeast Asia-ish default
            zoom:                4,
            minZoom:             2,
            maxZoom:             18,
            maxBounds:           WORLD_BOUNDS,
            maxBoundsViscosity:  1.0,         // hard wall — no bouncing past edge
            worldCopyJump:       false,
            zoomControl:         true,
            attributionControl:  true,
        });

        // OSM tile layer — noWrap prevents infinite horizontal tiling
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            noWrap:      true,       // ← critical: no tile wrapping
            bounds:      WORLD_BOUNDS,
            minZoom:     2,
            maxZoom:     19,
        }).addTo(map);

        // Prevent the user from panning the map empty on the sides
        // by clamping on every moveend as a belt-and-suspenders fix
        map.on('moveend', function() {
            const bounds = map.getBounds();
            if (!WORLD_BOUNDS.contains(bounds.getCenter())) {
                map.panInsideBounds(WORLD_BOUNDS, { animate: false });
            }
        });

        // ── City markers (only cities with lat/lng) ───────
        // Each city in config.js can have { lat, lng } added.
        // Until then they're silently skipped.
        const markersWithEl = [];

        CITIES.forEach(function(city) {
            if (city.lat == null || city.lng == null) return;

            // Marker element — built from raw DOM, not Leaflet icons,
            // so we can drive LoD purely with CSS classes.
            const el = document.createElement('div');
            el.className = 'vmap-marker ' + LOD_DOT;

            const dot = document.createElement('div');
            dot.className = 'vmap-dot';

            const label = document.createElement('div');
            label.className   = 'vmap-label';
            label.textContent = city.label;

            el.appendChild(dot);
            el.appendChild(label);

            const icon = L.divIcon({
                html:        el,
                className:   '',          // suppress Leaflet's default white box
                iconSize:    [0, 0],      // we size via CSS
                iconAnchor:  [0, 0],
            });

            const marker = L.marker([city.lat, city.lng], {
                icon,
                title: city.label,
            }).addTo(map);

            // Popup — shows live local time, updates on open
            let popupTimer = null;

            marker.bindPopup(function() {
                const wrap = document.createElement('div');

                const cityDiv = document.createElement('div');
                cityDiv.className   = 'vmap-popup-city';
                cityDiv.textContent = city.label;

                const tzDiv = document.createElement('div');
                tzDiv.className   = 'vmap-popup-tz';
                tzDiv.textContent = city.tz.replace(/_/g, ' ');

                const timeDiv = document.createElement('div');
                timeDiv.className   = 'vmap-popup-time';
                timeDiv.textContent = localTimeStr(city.tz);

                wrap.appendChild(cityDiv);
                wrap.appendChild(tzDiv);
                wrap.appendChild(timeDiv);

                if (city.vdocId) {
                    const lnk = document.createElement('div');
                    lnk.className   = 'vmap-popup-link';
                    lnk.textContent = '✎ Read writeup';
                    lnk.addEventListener('click', function() {
                        document.dispatchEvent(new CustomEvent('vclock:open-vdoc', {
                            detail: { postId: city.vdocId }
                        }));
                    });
                    wrap.appendChild(lnk);
                }

                // Tick the time while popup is open
                popupTimer = setInterval(function() {
                    timeDiv.textContent = localTimeStr(city.tz);
                }, 1000);

                return wrap;
            }, {
                // Keep popup open on marker hover too
                autoPan: true,
            });

            marker.on('popupclose', function() {
                clearInterval(popupTimer);
                popupTimer = null;
            });

            markersWithEl.push({ city, el });
        });

        // ── LoD update ─────────────────────────────────────
        // Runs on every zoom change. Swaps CSS class on each
        // marker element — CSS does the rest (no layout thrashing).
        function updateLod() {
            const lod = getLod(map.getZoom());
            markersWithEl.forEach(function(m) {
                m.el.classList.remove(LOD_DOT, LOD_LABEL, LOD_DETAIL);
                m.el.classList.add(lod);
            });
        }

        map.on('zoomend', updateLod);
        updateLod(); // run once at initial zoom

        // ── Resize: invalidate map when window is resized ──
        // Leaflet needs this when the container changes size.
        const resizeObs = new ResizeObserver(function() {
            map.invalidateSize();
        });
        resizeObs.observe(document.getElementById('vmap-leaflet'));
    }
}