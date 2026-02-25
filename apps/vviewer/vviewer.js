// ============================================================
// apps/vviewer/vviewer.js
// ============================================================
// Vviewer ; static image viewer. Winamp-aesthetic dark skin.
//
// On init: injects vviewer.css and fetches vviewer.html,
// then wires all viewer logic. Everything else is unchanged.
// ============================================================

export async function initVviewer({ registerWindow, openWindow }) {

    // ── Inject CSS ───────────────────────────────────────────
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = new URL('vviewer.css', import.meta.url).href;
    document.head.appendChild(link);

    // ── Fetch + inject HTML ──────────────────────────────────
    try {
        const res  = await fetch(new URL('vviewer.html', import.meta.url).href);
        const html = await res.text();
        document.body.insertAdjacentHTML('beforeend', html);
    } catch (err) {
        console.error('[vviewer] Failed to load vviewer.html', err);
        return;
    }

    const windowEl = document.getElementById('vviewer-window');
    if (!windowEl) return;
    const entry = registerWindow(windowEl);

    // ── DOM refs ────────────────────────────────────────────
    const img        = document.getElementById('vv-img');
    const titleEl    = document.getElementById('vv-title');
    const statusEl   = document.getElementById('vv-status');
    const counterEl  = document.getElementById('vv-counter');
    const prevBtn    = document.getElementById('vv-prev');
    const nextBtn    = document.getElementById('vv-next');
    const zoomInBtn  = document.getElementById('vv-zoom-in');
    const zoomOutBtn = document.getElementById('vv-zoom-out');
    const fitBtn     = document.getElementById('vv-fit');
    const viewport   = document.getElementById('vv-viewport');

    // ── State ───────────────────────────────────────────────
    let images    = [];
    let current   = 0;
    let scale     = 1;
    let panX      = 0;
    let panY      = 0;
    let isPanning = false;
    let panStart  = { x: 0, y: 0 };

    const MIN_SCALE = 0.1;
    const MAX_SCALE = 8;
    const ZOOM_STEP = 0.25;

    // ── Load image list from the Pictures folder ─────────────
    function refreshImageList() {
        const folder = document.getElementById('pictures-window');
        if (!folder) return;
        images = Array.from(folder.querySelectorAll('.file-item[data-type="image"]'))
            .map(el => ({ src: el.dataset.src, title: el.dataset.title ?? 'Untitled' }));
    }

    // ── Display a specific index ─────────────────────────────
    function showAt(index) {
        if (!images.length) return;
        current = ((index % images.length) + images.length) % images.length;
        const { src, title } = images[current];

        img.style.opacity = '0';
        img.onload = () => { fitToWindow(); img.style.opacity = '1'; statusEl.textContent = 'OK'; };
        img.onerror = () => { statusEl.textContent = 'Error loading image'; };
        img.src = src;

        titleEl.textContent   = title;
        statusEl.textContent  = 'Loading…';
        counterEl.textContent = `${current + 1} / ${images.length}`;

        prevBtn.disabled = images.length <= 1;
        nextBtn.disabled = images.length <= 1;
    }

    // ── Zoom / pan ───────────────────────────────────────────
    function applyTransform() {
        img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }

    function fitToWindow() {
        scale = 1; panX = 0; panY = 0;
        applyTransform();
    }

    function zoom(delta, cx, cy) {
        const prev = scale;
        scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta));
        if (cx !== undefined) {
            const rect = viewport.getBoundingClientRect();
            const ox = cx - rect.left - rect.width  / 2;
            const oy = cy - rect.top  - rect.height / 2;
            panX -= ox * (scale / prev - 1);
            panY -= oy * (scale / prev - 1);
        }
        applyTransform();
    }

    viewport.addEventListener('wheel', e => {
        e.preventDefault();
        zoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP, e.clientX, e.clientY);
    }, { passive: false });

    zoomInBtn .addEventListener('click', () => zoom(ZOOM_STEP));
    zoomOutBtn.addEventListener('click', () => zoom(-ZOOM_STEP));
    fitBtn    .addEventListener('click', fitToWindow);

    // ── Pan ──────────────────────────────────────────────────
    viewport.addEventListener('mousedown', e => {
        if (scale <= 1) return;
        isPanning = true;
        panStart  = { x: e.clientX - panX, y: e.clientY - panY };
        viewport.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', e => {
        if (!isPanning) return;
        panX = e.clientX - panStart.x;
        panY = e.clientY - panStart.y;
        applyTransform();
    });

    document.addEventListener('mouseup', () => {
        isPanning = false;
        viewport.style.cursor = scale > 1 ? 'grab' : 'default';
    });

    // ── Prev / Next ──────────────────────────────────────────
    prevBtn.addEventListener('click', () => showAt(current - 1));
    nextBtn.addEventListener('click', () => showAt(current + 1));

    document.addEventListener('keydown', e => {
        if (windowEl.classList.contains('hidden') ||
            windowEl.classList.contains('minimized')) return;
        if (e.key === 'ArrowLeft')       showAt(current - 1);
        if (e.key === 'ArrowRight')      showAt(current + 1);
        if (e.key === '+' || e.key === '=') zoom(ZOOM_STEP);
        if (e.key === '-')               zoom(-ZOOM_STEP);
        if (e.key === '0')               fitToWindow();
    });

    // ── file-open event ──────────────────────────────────────
    document.addEventListener('file-open', e => {
        if (e.detail.type !== 'image') return;
        refreshImageList();
        const idx = images.findIndex(im => im.src === e.detail.src);
        showAt(idx >= 0 ? idx : 0);
        openWindow(entry);
    });

    // ── Reset on close ───────────────────────────────────────
    windowEl.querySelector('.close-btn').addEventListener('click', () => {
        img.src = '';
        titleEl.textContent   = '—';
        statusEl.textContent  = 'Ready';
        counterEl.textContent = '';
        fitToWindow();
    }, true);
}