// ============================================================
// apps/vpaint/vpaint.js  —  vPaint
// ============================================================
// Full Win7 Paint feature set:
//   Tools:     pencil, brush, fill, eraser, line, rect,
//              rect-fill, ellipse, ellipse-fill, roundrect,
//              triangle, text, picker, select-rect
//   Selection: move, copy, cut, paste, delete, transparent/
//              opaque mode, rotate 90°, flip H/V, invert, crop
//   Image:     rotate 90°, flip H/V, resize+skew dialog
//   Undo:      30-state ImageData stack
//   Gallery:   JPEG-compressed thumbnails stored in Supabase
// ============================================================

import { WALL_PASSWORD } from '../../core/config.js';
import { initVPaintMenus } from './vpaint-menus.js';

// ── Supabase ──────────────────────────────────────────────────
const SB_URL       = 'https://emfvqpgrdqukyioiqxhl.supabase.co';
const SB_ANON_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtZnZxcGdyZHF1a3lpb2lxeGhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwOTk0OTUsImV4cCI6MjA4NzY3NTQ5NX0.D0LVlwsaMB3BEvtQdnCclXfA7-fdtUJjps1iuQihn_g';
const SB_ADMIN_KEY = '';
const TABLE        = 'vpaint-works';

function sbHeaders(admin = false) {
    const key = admin ? SB_ADMIN_KEY : SB_ANON_KEY;
    return {
        'Content-Type':  'application/json',
        'apikey':        key,
        'Authorization': 'Bearer ' + key,
    };
}

async function sbFetch(path, opts = {}, admin = false) {
    const res = await fetch(SB_URL + '/rest/v1/' + path, {
        ...opts,
        headers: { ...sbHeaders(admin), ...(opts.headers || {}) },
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error('Supabase ' + res.status + ': ' + txt);
    }
    return res.status === 204 ? null : res.json();
}

async function fetchWorks(includeHidden = false) {
    const filter = includeHidden ? '' : '&hidden=eq.false';
    return sbFetch(TABLE + '?select=id,created_at,author,thumb_data,image_data,pinned,hidden' + filter + '&order=pinned.desc,created_at.desc');
}

async function insertWork(author, imageData, thumbData) {
    return sbFetch(TABLE, {
        method:  'POST',
        headers: { 'Prefer': 'return=representation' },
        body:    JSON.stringify({
            author:     author || 'anonymous',
            image_data: imageData,   // JPEG quality 0.82
            thumb_data: thumbData,   // JPEG quality 0.55, 200px wide
            width:      640,
            height:     480,
        }),
    });
}

async function deleteWork(id) {
    // Use anon key — owner verified client-side
    return sbFetch(TABLE + '?id=eq.' + id, { method: 'DELETE' }, false);
}

async function togglePin(id, pinned) {
    return sbFetch(TABLE + '?id=eq.' + id, {
        method:  'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body:    JSON.stringify({ pinned }),
    }, false);
}

async function toggleHideWork(id, hidden) {
    return sbFetch(TABLE + '?id=eq.' + id, {
        method:  'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body:    JSON.stringify({ hidden }),
    }, false);
}

// Compress canvas → JPEG data URL
function canvasToJpeg(srcCanvas, quality = 0.82) {
    return srcCanvas.toDataURL('image/jpeg', quality);
}

// 200px-wide thumbnail
function makeThumbnail(srcCanvas, maxW = 200, quality = 0.55) {
    const scale = Math.min(1, maxW / srcCanvas.width);
    const tw = Math.round(srcCanvas.width  * scale);
    const th = Math.round(srcCanvas.height * scale);
    const tmp = document.createElement('canvas');
    tmp.width = tw; tmp.height = th;
    tmp.getContext('2d').drawImage(srcCanvas, 0, 0, tw, th);
    return tmp.toDataURL('image/jpeg', quality);
}

// ── Colour palette (28 colours matching Win7 Paint) ───────────
const PALETTE = [
    '#000000','#404040','#7f7f7f','#c3c3c3','#ffffff',
    '#880015','#b97a57','#ff7f27','#ffaec9','#ffc90e',
    '#efe4b0','#b5e61d','#22b14c','#99d9ea','#00a2e8',
    '#3f48cc','#7092be','#c8bfe7','#880015','#9c4900',
    '#ed1c24','#ff7f27','#ffc90e','#fff200','#a8e61d',
    '#00a2e8','#3f48cc','#a349a4',
];

// ── Canvas dimensions ─────────────────────────────────────────
const W = 640;
const H = 480;

// ── App entry ─────────────────────────────────────────────────
export async function initVPaint(desktop) {
    const { registerWindow, openWindow } = desktop;

    // Inject CSS
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = new URL('vpaint.css', import.meta.url).href;
    document.head.appendChild(link);

    // Inject HTML
    try {
        const res  = await fetch(new URL('vpaint.html', import.meta.url).href);
        const html = await res.text();
        document.body.insertAdjacentHTML('beforeend', html);
    } catch (err) {
        console.error('[vpaint] Failed to load vpaint.html', err);
        return;
    }

    const win = document.getElementById('vpaint-window');
    if (!win) return;
    const entry = registerWindow(win, { icon: '🎨' });

    document.getElementById('open-vpaint')
        ?.addEventListener('dblclick', () => openWindow(entry));

    // ── DOM refs ──────────────────────────────────────────────
    const canvas      = document.getElementById('vp-canvas');
    const canvasArea  = document.getElementById('vp-canvas-area');
    const paletteEl   = document.getElementById('vp-palette');
    const swFg        = document.getElementById('vp-sw-fg');
    const swBg        = document.getElementById('vp-sw-bg');
    const sTool       = document.getElementById('vp-s-tool');
    const sPos        = document.getElementById('vp-s-pos');
    const sDim        = document.getElementById('vp-s-dim');
    const sSel        = document.getElementById('vp-s-sel');
    const sSelPipe    = document.getElementById('vp-s-selpipe');
    const sSnap       = document.getElementById('vp-s-snap');
    const sSnapPipe   = document.getElementById('vp-s-snappipe');
    const nameInput   = document.getElementById('vp-name');
    const postBtn     = document.getElementById('vp-post');
    const postDialog  = document.getElementById('vp-post-dialog');
    const postCancel  = document.getElementById('vp-post-cancel');
    const postErr     = document.getElementById('vp-post-err');
    const undoBtn     = document.getElementById('vp-undo');
    const clearBtn    = document.getElementById('vp-clear');
    const saveBtn     = document.getElementById('vp-save');
    const lockBtn     = document.getElementById('vp-lock');
    const adminTab    = document.getElementById('vp-tab-admin');
    const modal       = document.getElementById('vp-modal');
    const modalPw     = document.getElementById('vp-modal-pw');
    const modalSubmit = document.getElementById('vp-modal-submit');
    const modalCancel = document.getElementById('vp-modal-cancel');
    const modalErr    = document.getElementById('vp-modal-err');
    const toast       = document.getElementById('vp-toast');
    const lightbox    = document.getElementById('vp-lightbox');
    const lightboxImg = document.getElementById('vp-lightbox-img');
    const selOptsEl   = document.getElementById('vp-sel-opts');
    const selTransp   = document.getElementById('vp-sel-transparent');
    const outlineEl   = document.getElementById('vp-outline-style');
    const fillEl      = document.getElementById('vp-fill-style');
    const resizeDlg   = document.getElementById('vp-resize-dialog');
    const galleryGrid = document.getElementById('vp-gallery-grid');
    const galleryMsg  = document.getElementById('vp-gallery-msg');
    const galleryCount= document.getElementById('vp-gallery-count');
    const gallRefresh = document.getElementById('vp-gallery-refresh');
    const adminGrid   = document.getElementById('vp-admin-grid');
    const adminRefresh= document.getElementById('vp-admin-refresh');

    // ── Canvas setup ──────────────────────────────────────────
    canvas.width  = W;
    canvas.height = H;
    sDim.textContent = W + ' × ' + H;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Wrap canvas + overlay in a single relative container so they scroll together.
    // The canvasArea (vp-canvas-wrap) is the scrollable box; canvasWrap sits inside it.
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'position:relative;display:inline-block;line-height:0;';
    canvas.parentNode.insertBefore(canvasWrap, canvas);
    canvasWrap.appendChild(canvas);

    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.id     = 'vp-sel-canvas';
    overlayCanvas.width  = W;
    overlayCanvas.height = H;
    overlayCanvas.style.cssText =
        'position:absolute;top:0;left:0;pointer-events:none;z-index:2;';
    canvasWrap.appendChild(overlayCanvas);
    const ov = overlayCanvas.getContext('2d');

    // ── State ─────────────────────────────────────────────────
    let tool     = 'ellipse';
    let size     = 1;
    let fgColor  = '#000000';
    let bgColor  = '#ffffff';
    let painting = false;
    let lastX = 0, lastY = 0;
    let snapX = 0, snapY = 0;
    let ownerMode = false;
    let shiftDown  = false;  // Shift: angle snap + 1:1 shapes
    let centerMode = true;   // Default: shapes grow from center. Alt toggles to corner mode.

    const undoStack = [];
    const MAX_UNDO  = 30;

    // Selection: { x, y, w, h, floatCanvas, floating }
    let sel = null;
    let clipboard = null; // ImageData

    // Selection drag state
    let selDrawing  = false; // user is drawing a new sel rect
    let selMoving   = false; // user is dragging floating sel
    let selMoveBaseX = 0, selMoveBaseY = 0; // cursor at drag start
    let selMoveSelX  = 0, selMoveSelY  = 0; // sel.x/y at drag start

    // Lasso select state
    let lassoPoints  = [];   // [{x,y}] raw path while drawing
    let lassoActive  = false;

    // Text tool
    let textPos   = null;
    let textInput = null;

    // ── Palette ───────────────────────────────────────────────
    PALETTE.forEach(hex => {
        const sw = document.createElement('div');
        sw.className        = 'vp-swatch';
        sw.style.background = hex;
        sw.title            = hex;
        sw.addEventListener('click',       () => setFg(hex));
        sw.addEventListener('contextmenu', e  => { e.preventDefault(); setBg(hex); });
        paletteEl.appendChild(sw);
    });

    function setFg(hex) { fgColor = hex; swFg.style.background = hex; }
    function setBg(hex) { bgColor = hex; swBg.style.background = hex; }
    setFg('#000000');
    setBg('#ffffff');

    // Clicking swatches swaps FG/BG
    swFg.addEventListener('click', () => { const t = fgColor; setFg(bgColor); setBg(t); });

    // ── Tab switching ─────────────────────────────────────────
    win.querySelectorAll('.vp-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            win.querySelectorAll('.vp-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            win.querySelectorAll('.vp-panel').forEach(p => p.classList.add('hidden'));
            document.getElementById('vp-panel-' + tab.dataset.tab)?.classList.remove('hidden');
            if (tab.dataset.tab === 'gallery') loadGallery();
            if (tab.dataset.tab === 'admin')   loadAdmin();
        });
    });

    // ── Tool buttons ──────────────────────────────────────────
    win.querySelectorAll('.vp-tool').forEach(btn => {
        btn.addEventListener('click', () => activateTool(btn.dataset.tool));
    });

    function activateTool(t) {
        if (t !== 'select-rect' && t !== 'select-lasso') commitSelection();
        win.querySelectorAll('.vp-tool').forEach(b =>
            b.classList.toggle('active', b.dataset.tool === t));
        tool = t;
        canvasArea.dataset.tool = t;
        // Pretty name for status bar
        const names = {
            'select-rect': 'Select', 'pencil': 'Pencil', 'brush': 'Brush',
            'fill': 'Fill', 'text': 'Text', 'eraser': 'Eraser', 'picker': 'Pick colour',
            'line': 'Line', 'rect': 'Rectangle', 'rect-fill': 'Filled rect',
            'ellipse': 'Ellipse', 'ellipse-fill': 'Filled ellipse',
            'roundrect': 'Rounded rect', 'triangle': 'Triangle',
            'select-lasso': 'Free Select',
        };
        sTool.textContent = names[t] || t;
        selOptsEl.style.display = (t === 'select-rect' || t === 'select-lasso') ? '' : 'none';
    }

    // ── Size buttons ──────────────────────────────────────────
    win.querySelectorAll('.vp-szbtn').forEach(btn => {
        btn.addEventListener('click', () => {
            win.querySelectorAll('.vp-szbtn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            size = parseInt(btn.dataset.size);
        });
    });

    // ── Keyboard shortcuts ────────────────────────────────────
    document.addEventListener('keydown', e => {
        if (win.classList.contains('hidden')) return;
        if (!modal.classList.contains('hidden')) return;
        if (document.activeElement?.tagName === 'INPUT')    return;
        if (document.activeElement?.tagName === 'TEXTAREA') return;
        if (document.activeElement?.tagName === 'SELECT')   return;

        const ctrl = e.ctrlKey || e.metaKey;

        if (ctrl && e.key === 'z') { e.preventDefault(); undo(); return; }
        if (ctrl && e.key === 'c') { e.preventDefault(); copySelection(); return; }
        if (ctrl && e.key === 'x') { e.preventDefault(); cutSelection(); return; }
        if (ctrl && e.key === 'v') { e.preventDefault(); pasteSelection(); return; }
        if (ctrl && e.key === 'a') { e.preventDefault(); selectAll(); return; }

        if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
            e.preventDefault(); deleteSelection(); return;
        }
        if (e.key === 'Escape' && sel) { commitSelection(); return; }

        const map = {
            s: 'select-rect', q: 'select-lasso', p: 'pencil', b: 'brush', f: 'fill',
            e: 'eraser', l: 'line', r: 'rect', o: 'ellipse',
            i: 'picker', t: 'text',
        };
        if (!ctrl && map[e.key]) activateTool(map[e.key]);
    });

    // ── Shift-key tracking (for snap UX) ─────────────────────
    // We track shiftDown ourselves so previewShape can read it
    // without needing the event object passed through.
    document.addEventListener('keydown', e => {
        if (e.key === 'Shift') { shiftDown = true;  updateSnapStatus(); }
        if (e.key === 'Alt')   { centerMode = false; e.preventDefault(); }
    });
    document.addEventListener('keyup', e => {
        if (e.key === 'Shift') { shiftDown = false; updateSnapStatus(); }
        if (e.key === 'Alt')   { centerMode = true; }
    });

    function updateSnapStatus() {
        const active = shiftDown && painting && SHAPE_TOOLS.has(tool);
        const lineSnap = shiftDown && painting && tool === 'line';
        if (active || lineSnap) {
            sSnap.textContent = lineSnap ? 'SNAP 15°' : 'SNAP 1:1';
            sSnap.style.display     = '';
            sSnapPipe.style.display = '';
        } else {
            sSnap.style.display     = 'none';
            sSnapPipe.style.display = 'none';
        }
    }

    // ── Undo ──────────────────────────────────────────────────
    function pushUndo() {
        undoStack.push(ctx.getImageData(0, 0, W, H));
        if (undoStack.length > MAX_UNDO) undoStack.shift();
    }

    function undo() {
        if (sel?.floating) { commitSelection(false); return; }
        if (!undoStack.length) return;
        ctx.putImageData(undoStack.pop(), 0, 0);
        sel = null; sSel.textContent = ''; sSelPipe.style.display = 'none';
        clearOverlay();
    }

    undoBtn.addEventListener('click', undo);

    // ── Clear ─────────────────────────────────────────────────
    clearBtn.addEventListener('click', () => {
        if (!confirm('Clear the canvas?')) return;
        commitSelection();
        pushUndo();
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, W, H);
    });

    // ── Save PNG ──────────────────────────────────────────────
    saveBtn.addEventListener('click', () => {
        commitSelection();
        const a = document.createElement('a');
        a.download = 'vpaint-' + Date.now() + '.png';
        a.href     = canvas.toDataURL('image/png');
        a.click();
    });

    // ── Canvas position helper ────────────────────────────────
    function getPos(e) {
        const r  = canvas.getBoundingClientRect();
        const sx = W / r.width;
        const sy = H / r.height;
        const px = e.touches ? e.touches[0].clientX : e.clientX;
        const py = e.touches ? e.touches[0].clientY : e.clientY;
        return {
            x: Math.max(0, Math.min(W - 1, Math.round((px - r.left) * sx))),
            y: Math.max(0, Math.min(H - 1, Math.round((py - r.top)  * sy))),
        };
    }

    function setupCtx(color, lw, dash = []) {
        ctx.strokeStyle = color;
        ctx.fillStyle   = color;
        ctx.lineWidth   = lw;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.setLineDash(dash);
    }

    // ── Flood fill ────────────────────────────────────────────
    function hexToRgb(hex) {
        const n = parseInt(hex.replace('#', ''), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function floodFill(sx, sy, fillHex) {
        const id   = ctx.getImageData(0, 0, W, H);
        const d    = id.data;
        const idx  = (x, y) => (y * W + x) * 4;
        const i0   = idx(sx, sy);
        const [tr, tg, tb, ta] = [d[i0], d[i0+1], d[i0+2], d[i0+3]];
        const [fr, fg, fb]     = hexToRgb(fillHex);
        if (tr === fr && tg === fg && tb === fb && ta === 255) return;
        const stack = [[sx, sy]];
        const match = (x, y) => {
            const i = idx(x, y);
            return d[i]===tr && d[i+1]===tg && d[i+2]===tb && d[i+3]===ta;
        };
        const paint = (x, y) => {
            const i = idx(x, y);
            d[i]=fr; d[i+1]=fg; d[i+2]=fb; d[i+3]=255;
        };
        while (stack.length) {
            const [x, y] = stack.pop();
            if (x < 0 || x >= W || y < 0 || y >= H || !match(x, y)) continue;
            let l = x, r = x;
            while (l > 0   && match(l-1, y)) l--;
            while (r < W-1 && match(r+1, y)) r++;
            for (let cx = l; cx <= r; cx++) {
                paint(cx, y);
                if (y > 0   && match(cx, y-1)) stack.push([cx, y-1]);
                if (y < H-1 && match(cx, y+1)) stack.push([cx, y+1]);
            }
        }
        ctx.putImageData(id, 0, 0);
    }

    // ── Colour picker ─────────────────────────────────────────
    function pickColor(x, y) {
        const px  = ctx.getImageData(x, y, 1, 1).data;
        const hex = '#' + [px[0],px[1],px[2]]
            .map(v => v.toString(16).padStart(2, '0')).join('');
        setFg(hex);
    }

    // ── Overlay helpers ───────────────────────────────────────
    function clearOverlay() { ov.clearRect(0, 0, W, H); }

    function drawMarquee(x, y, w, h) {
        clearOverlay();
        // Marching-ants effect (two offset dashed strokes)
        ov.save();
        ov.strokeStyle = '#000';
        ov.lineWidth   = 1;
        ov.setLineDash([4, 4]);
        ov.lineDashOffset = 0;
        ov.strokeRect(x + 0.5, y + 0.5, w, h);
        ov.strokeStyle    = '#fff';
        ov.lineDashOffset = 4;
        ov.strokeRect(x + 0.5, y + 0.5, w, h);
        ov.restore();
        // If floating, draw the floating pixels
        if (sel?.floating && sel.floatCanvas) {
            ov.drawImage(sel.floatCanvas, sel.x, sel.y);
        }
    }


    // ── Lasso overlay helpers ──────────────────────────────────────
    function drawLassoOverlay(pts) {
        clearOverlay();
        if (pts.length < 2) return;
        ov.save();
        ov.lineWidth = 1;
        ov.setLineDash([4, 4]);
        ov.beginPath();
        ov.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ov.lineTo(pts[i].x, pts[i].y);
        ov.strokeStyle = '#000'; ov.lineDashOffset = 0; ov.stroke();
        ov.strokeStyle = '#fff'; ov.lineDashOffset = 4; ov.stroke();
        ov.restore();
        if (sel?.floating && sel.floatCanvas) ov.drawImage(sel.floatCanvas, sel.x, sel.y);
    }

    function commitLasso(pts) {
        if (pts.length < 3) { lassoPoints = []; lassoActive = false; return; }
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        const bx  = Math.max(0, Math.floor(Math.min(...xs)));
        const by  = Math.max(0, Math.floor(Math.min(...ys)));
        const bx2 = Math.min(W, Math.ceil(Math.max(...xs)));
        const by2 = Math.min(H, Math.ceil(Math.max(...ys)));
        const bw = bx2 - bx, bh = by2 - by;
        if (bw < 2 || bh < 2) { lassoPoints = []; lassoActive = false; return; }

        const mask = document.createElement('canvas');
        mask.width = W; mask.height = H;
        const mc = mask.getContext('2d');
        mc.beginPath();
        mc.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) mc.lineTo(pts[i].x, pts[i].y);
        mc.closePath();
        mc.fillStyle = '#000';
        mc.fill();
        const maskData = mc.getImageData(bx, by, bw, bh);
        const srcData  = ctx.getImageData(bx, by, bw, bh);

        const fc = document.createElement('canvas');
        fc.width = bw; fc.height = bh;
        const fc2 = fc.getContext('2d');
        const outData = fc2.createImageData(bw, bh);
        for (let i = 0; i < outData.data.length; i += 4) {
            if (maskData.data[i + 3] > 0) {
                outData.data[i]     = srcData.data[i];
                outData.data[i + 1] = srcData.data[i + 1];
                outData.data[i + 2] = srcData.data[i + 2];
                outData.data[i + 3] = srcData.data[i + 3];
            }
        }
        fc2.putImageData(outData, 0, 0);
        lassoPoints = []; lassoActive = false;
        sel = { x: bx, y: by, w: bw, h: bh, floatCanvas: fc, floating: true };
        setSelStatus();
        drawMarquee(bx, by, bw, bh);
    }

    // ── Shape preview ─────────────────────────────────────────
    function previewShape(rawX, rawY) {
        clearOverlay();
        const outline = outlineEl.value;
        const fill    = fillEl.value;
        const dash    = outline === 'dash' ? [6, 3] : [];

        // ── Shift-snap ────────────────────────────────────────
        let x = rawX, y = rawY;

        if (shiftDown && tool === 'line') {
            // Snap line angle to nearest 15° increment
            const dx   = rawX - snapX;
            const dy   = rawY - snapY;
            const len  = Math.sqrt(dx*dx + dy*dy);
            const rawAngle  = Math.atan2(dy, dx);
            const snapAngle = Math.round(rawAngle / (Math.PI/12)) * (Math.PI/12);
            x = Math.round(snapX + len * Math.cos(snapAngle));
            y = Math.round(snapY + len * Math.sin(snapAngle));
        } else if (shiftDown && tool !== 'line') {
            // Constrain shape to 1:1 (square/circle) —
            // use the larger dimension, preserving sign of each delta.
            const dx  = rawX - snapX;
            const dy  = rawY - snapY;
            const dim = Math.max(Math.abs(dx), Math.abs(dy));
            x = snapX + Math.sign(dx) * dim;
            y = snapY + Math.sign(dy) * dim;
        }

        // Center mode (Alt key): click point becomes center of shape
        let ox = snapX, oy = snapY;
        if (centerMode && tool !== 'line') {
            const dx = x - snapX, dy = y - snapY;
            ox = snapX - dx;
            oy = snapY - dy;
        }
        const w = x - ox, h = y - oy;

        ov.save();
        ov.lineWidth  = size;
        ov.lineCap    = 'round';
        ov.lineJoin   = 'round';
        ov.setLineDash(dash);

        function applyFill()   { if (fill !== 'none') { ov.fillStyle = fill === 'fg' ? fgColor : bgColor; ov.fill(); } }
        function applyStroke() { if (outline !== 'none') { ov.strokeStyle = fgColor; ov.stroke(); } }

        if (tool === 'line') {
            ov.strokeStyle = fgColor;
            ov.beginPath(); ov.moveTo(snapX, snapY); ov.lineTo(x, y); ov.stroke();

        } else if (tool === 'rect' || tool === 'rect-fill') {
            ov.beginPath(); ov.rect(ox, oy, w, h);
            applyFill(); applyStroke();

        } else if (tool === 'roundrect') {
            const r = Math.min(12, Math.abs(w)/4, Math.abs(h)/4);
            ov.beginPath();
            if (ov.roundRect) ov.roundRect(ox, oy, w, h, r);
            else               ov.rect(ox, oy, w, h);
            applyFill(); applyStroke();

        } else if (tool === 'ellipse' || tool === 'ellipse-fill') {
            const ex = centerMode ? snapX : (ox+x)/2;
            const ey = centerMode ? snapY : (oy+y)/2;
            const erx = centerMode ? Math.abs(x-snapX) : Math.abs(w)/2;
            const ery = centerMode ? Math.abs(y-snapY) : Math.abs(h)/2;
            ov.beginPath();
            ov.ellipse(ex, ey, erx, ery, 0, 0, Math.PI*2);
            applyFill(); applyStroke();

        } else if (tool === 'triangle') {
            ov.beginPath();
            ov.moveTo(ox + w/2, oy);
            ov.lineTo(ox + w, oy + h);
            ov.lineTo(ox, oy + h);
            ov.closePath();
            applyFill(); applyStroke();
        }
        ov.restore();
    }

    function commitShape() {
        ctx.drawImage(overlayCanvas, 0, 0);
        clearOverlay();
    }

    // ── Selection helpers ─────────────────────────────────────
    function normRect(x1, y1, x2, y2) {
        const x = Math.max(0, Math.min(x1, x2));
        const y = Math.max(0, Math.min(y1, y2));
        return { x, y, w: Math.min(W - x, Math.abs(x2-x1)), h: Math.min(H - y, Math.abs(y2-y1)) };
    }

    function setSelStatus() {
        if (sel && sel.w > 0 && sel.h > 0) {
            sSel.textContent          = sel.w + '×' + sel.h;
            sSelPipe.style.display    = '';
        } else {
            sSel.textContent       = '';
            sSelPipe.style.display = 'none';
        }
    }

    // Commit floating pixels back onto canvas
    function commitSelection(draw = true) {
        if (!sel) return;
        const hasContent = sel.floatCanvas && draw && sel.w > 0 && sel.h > 0;
        if (hasContent) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
            if (selTransp.checked) {
                // TRANSPARENT mode: stamp with bg-coloured pixels masked to alpha=0
                // so the destination canvas shows through those pixels.
                const tmp = document.createElement('canvas');
                tmp.width = sel.w; tmp.height = sel.h;
                const tc = tmp.getContext('2d');
                tc.drawImage(sel.floatCanvas, 0, 0);
                const id = tc.getImageData(0, 0, sel.w, sel.h);
                const [br, bg2, bb] = hexToRgb(bgColor);
                for (let i = 0; i < id.data.length; i += 4) {
                    if (id.data[i] === br && id.data[i+1] === bg2 && id.data[i+2] === bb)
                        id.data[i+3] = 0;
                }
                tc.putImageData(id, 0, 0);
                ctx.drawImage(tmp, sel.x, sel.y);
            } else {
                // OPAQUE mode: stamp floatCanvas directly (origin was already erased on lift)
                ctx.drawImage(sel.floatCanvas, sel.x, sel.y);
            }
        }
        sel = null;
        clearOverlay();
        setSelStatus();
    }

    function selectAll() {
        commitSelection();
        activateTool('select-rect');
        sel = { x:0, y:0, w:W, h:H, floatCanvas:null, floating:false };
        drawMarquee(0, 0, W, H);
        setSelStatus();
    }

    function deleteSelection() {
        if (!sel) return;
        pushUndo();
        if (!sel.floating) {
            ctx.fillStyle = bgColor;
            ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
        }
        sel = null; clearOverlay(); setSelStatus();
    }

    function copySelection() {
        if (!sel || sel.w < 1 || sel.h < 1) return;
        const tmp = document.createElement('canvas');
        tmp.width = sel.w; tmp.height = sel.h;
        const tc  = tmp.getContext('2d');
        if (sel.floating && sel.floatCanvas) {
            tc.drawImage(sel.floatCanvas, 0, 0);
        } else {
            tc.drawImage(canvas, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
        }
        clipboard = tc.getImageData(0, 0, sel.w, sel.h);
        showToast('Copied ' + sel.w + '×' + sel.h);
    }

    function cutSelection() {
        if (!sel || sel.w < 1 || sel.h < 1) return;
        copySelection();
        pushUndo();
        if (!sel.floating) {
            ctx.fillStyle = bgColor;
            ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
        }
        sel = null; clearOverlay(); setSelStatus();
    }

    function pasteSelection() {
        if (!clipboard) return;
        // Commit any existing floating selection before pasting
        commitSelection();
        activateTool('select-rect');
        const fc = document.createElement('canvas');
        fc.width  = clipboard.width;
        fc.height = clipboard.height;
        fc.getContext('2d').putImageData(clipboard, 0, 0);
        // Paste at (0,0) — top-left of canvas, with selection already active on the copy.
        // floating=true so the pasted content is the floatCanvas and can be moved immediately.
        sel = { x: 0, y: 0, w: clipboard.width, h: clipboard.height,
                floatCanvas: fc, floating: true };
        drawMarquee(0, 0, sel.w, sel.h);
        setSelStatus();
        showToast('Pasted — drag to reposition');
    }

    // ── Transform: operates on selection or whole canvas ──────
    function doTransform(fn) {
        const hasSel = sel && sel.w > 0 && sel.h > 0;
        pushUndo();

        let src, sw, sh;
        if (hasSel) {
            if (sel.floating && sel.floatCanvas) {
                src = sel.floatCanvas;
            } else {
                const tmp = document.createElement('canvas');
                tmp.width = sel.w; tmp.height = sel.h;
                tmp.getContext('2d').drawImage(canvas, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
                src = tmp;
                ctx.fillStyle = bgColor;
                ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
            }
            sw = sel.w; sh = sel.h;
        } else {
            src = canvas; sw = W; sh = H;
        }

        const { out, rw, rh } = fn(src, sw, sh);

        if (hasSel) {
            sel.floatCanvas = out;
            sel.w = rw; sel.h = rh;
            sel.floating = true;
            drawMarquee(sel.x, sel.y, sel.w, sel.h);
            setSelStatus();
        } else {
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, W, H);
            ctx.drawImage(out, Math.round((W - rw)/2), Math.round((H - rh)/2), rw, rh);
        }
    }

    function makeOut(sw, sh, dw, dh, drawFn) {
        const out = document.createElement('canvas');
        out.width = dw; out.height = dh;
        const oc  = out.getContext('2d');
        drawFn(oc, sw, sh);
        return { out, rw: dw, rh: dh };
    }

    function doRotate90() {
        doTransform((src, sw, sh) => makeOut(sw, sh, sh, sw, (oc) => {
            oc.translate(sh, 0); oc.rotate(Math.PI/2); oc.drawImage(src, 0, 0, sw, sh);
        }));
    }
    function doFlipH() {
        doTransform((src, sw, sh) => makeOut(sw, sh, sw, sh, (oc) => {
            oc.translate(sw, 0); oc.scale(-1, 1); oc.drawImage(src, 0, 0, sw, sh);
        }));
    }
    function doFlipV() {
        doTransform((src, sw, sh) => makeOut(sw, sh, sw, sh, (oc) => {
            oc.translate(0, sh); oc.scale(1, -1); oc.drawImage(src, 0, 0, sw, sh);
        }));
    }

    function cropToSelection() {
        if (!sel || sel.w < 1 || sel.h < 1) return;
        commitSelection();
        pushUndo();
        const id = ctx.getImageData(sel.x, sel.y, sel.w, sel.h);
        ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H);
        ctx.putImageData(id, Math.round((W - sel.w)/2), Math.round((H - sel.h)/2));
        sel = null; clearOverlay(); setSelStatus();
    }

    function invertColors() {
        if (!sel || sel.w < 1 || sel.h < 1) return;
        pushUndo();
        const hasSrc = sel.floating && sel.floatCanvas;
        const id = hasSrc
            ? sel.floatCanvas.getContext('2d').getImageData(0, 0, sel.w, sel.h)
            : ctx.getImageData(sel.x, sel.y, sel.w, sel.h);
        for (let i = 0; i < id.data.length; i += 4) {
            id.data[i]=255-id.data[i]; id.data[i+1]=255-id.data[i+1]; id.data[i+2]=255-id.data[i+2];
        }
        if (hasSrc) { sel.floatCanvas.getContext('2d').putImageData(id, 0, 0); drawMarquee(sel.x, sel.y, sel.w, sel.h); }
        else        { ctx.putImageData(id, sel.x, sel.y); }
    }

    // Ribbon button wiring — only buttons that still exist in the stripped ribbon
    document.getElementById('vp-crop')      .addEventListener('click', cropToSelection);
    document.getElementById('vp-sel-rot90') .addEventListener('click', doRotate90);
    document.getElementById('vp-sel-fliph') .addEventListener('click', doFlipH);
    document.getElementById('vp-sel-flipv') .addEventListener('click', doFlipV);
    document.getElementById('vp-sel-invert').addEventListener('click', invertColors);

    // ── Resize/Skew dialog ────────────────────────────────────
    const rsW    = document.getElementById('vp-rs-w');
    const rsH    = document.getElementById('vp-rs-h');
    const rsMnt  = document.getElementById('vp-rs-maintain');
    rsW.addEventListener('input', () => { if (rsMnt.checked) rsH.value = rsW.value; });
    rsH.addEventListener('input', () => { if (rsMnt.checked) rsW.value = rsH.value; });

    document.getElementById('vp-rs-cancel').addEventListener('click', () =>
        resizeDlg.classList.add('hidden'));

    document.getElementById('vp-rs-ok').addEventListener('click', () => {
        resizeDlg.classList.add('hidden');
        const unit = win.querySelector('input[name="resize-unit"]:checked')?.value || 'pct';
        let nw = parseFloat(rsW.value), nh = parseFloat(rsH.value);
        const skh = parseFloat(document.getElementById('vp-skew-h').value) || 0;
        const skv = parseFloat(document.getElementById('vp-skew-v').value) || 0;
        const hasSel = sel && sel.w > 0 && sel.h > 0;
        const srcW   = hasSel ? sel.w : W;
        const srcH   = hasSel ? sel.h : H;
        if (unit === 'pct') { nw = Math.round(srcW * nw/100); nh = Math.round(srcH * nh/100); }
        nw = Math.max(1, Math.min(9999, nw));
        nh = Math.max(1, Math.min(9999, nh));
        const shx = Math.tan(skh * Math.PI/180);
        const shy = Math.tan(skv * Math.PI/180);
        doTransform((src, sw, sh) => {
            const dw = Math.round(nw + Math.abs(shx * nh));
            const dh = Math.round(nh + Math.abs(shy * nw));
            const out = document.createElement('canvas');
            out.width = dw; out.height = dh;
            const oc  = out.getContext('2d');
            oc.transform(nw/sw, shy, shx, nh/sh,
                shx < 0 ? -shx * nh : 0,
                shy < 0 ? -shy * nw : 0);
            oc.drawImage(src, 0, 0, sw, sh);
            return { out, rw: dw, rh: dh };
        });
        rsW.value = '100'; rsH.value = '100';
        document.getElementById('vp-skew-h').value = '0';
        document.getElementById('vp-skew-v').value = '0';
    });

    // ── Pointer events ────────────────────────────────────────
    const SHAPE_TOOLS = new Set(['line','rect','rect-fill','ellipse','ellipse-fill','roundrect','triangle']);

    canvas.addEventListener('mousedown',  onStart);
    canvas.addEventListener('touchstart', onStart, { passive: false });

    function onStart(e) {
        e.preventDefault();
        const { x, y } = getPos(e);
        const useRight  = e.button === 2;
        const color     = useRight ? bgColor : fgColor;

        if (tool === 'picker') { pickColor(x, y); return; }
        if (tool === 'fill')   { pushUndo(); floodFill(x, y, color); return; }
        if (tool === 'text')   { startTextInput(x, y); return; }

        // ── Rect select ───────────────────────────────────────
        if (tool === 'select-rect') {
            const inside = sel && sel.w > 0 && sel.h > 0
                && x >= sel.x && x <= sel.x + sel.w
                && y >= sel.y && y <= sel.y + sel.h;
            if (inside) {
                // Lift non-floating selection immediately
                if (!sel.floating) {
                    const fc = document.createElement('canvas');
                    fc.width = sel.w; fc.height = sel.h;
                    fc.getContext('2d').drawImage(canvas, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
                    pushUndo();
                    ctx.fillStyle = bgColor;
                    ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
                    sel.floatCanvas = fc;
                    sel.floating    = true;
                }
                selMoving    = true;
                selMoveBaseX = x; selMoveBaseY = y;
                selMoveSelX  = sel.x; selMoveSelY = sel.y;
            } else {
                commitSelection();
                selDrawing = true;
                snapX = x; snapY = y;
                sel = { x, y, w:0, h:0, floatCanvas:null, floating:false };
            }
            return;
        }

        // ── Lasso select ──────────────────────────────────────
        if (tool === 'select-lasso') {
            const inside = sel && sel.w > 0 && sel.h > 0
                && x >= sel.x && x <= sel.x + sel.w
                && y >= sel.y && y <= sel.y + sel.h;
            if (inside) {
                // Move existing lasso selection same as rect
                if (!sel.floating) {
                    const fc = document.createElement('canvas');
                    fc.width = sel.w; fc.height = sel.h;
                    fc.getContext('2d').drawImage(canvas, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
                    pushUndo();
                    ctx.fillStyle = bgColor;
                    ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
                    sel.floatCanvas = fc;
                    sel.floating    = true;
                }
                selMoving    = true;
                selMoveBaseX = x; selMoveBaseY = y;
                selMoveSelX  = sel.x; selMoveSelY = sel.y;
            } else {
                commitSelection();
                lassoActive = true;
                lassoPoints = [{ x, y }];
            }
            return;
        }

        painting = true;
        lastX = x; lastY = y; snapX = x; snapY = y;
        if (SHAPE_TOOLS.has(tool)) return;

        // ── Eraser: true clear (destination-out then fill white) ───────────
        if (tool === 'eraser') {
            const ew = Math.max(8, size * 6);
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x - ew/2, y - ew/2, ew, ew);
            pushUndo();
            return;
        }

        // ── Brush: wider, soft round strokes ─────────────────────
        if (tool === 'brush') {
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 0.65;
            setupCtx(color, size * 5);
            ctx.beginPath();
            ctx.moveTo(x, y); ctx.lineTo(x + 0.001, y); ctx.stroke();
            pushUndo();
            return;
        }

        // ── Pencil and all others ─────────────────────────────────
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        setupCtx(color, size);
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x + 0.001, y); ctx.stroke();
        pushUndo();
    }

    canvas.addEventListener('mousemove',  onMove);
    canvas.addEventListener('touchmove',  onMove, { passive: false });

    function onMove(e) {
        e.preventDefault?.();
        const { x, y } = getPos(e);
        sPos.textContent = x + ', ' + y;

        if (typeof e.shiftKey === 'boolean') shiftDown = e.shiftKey;

        // ── Rect select move/draw ─────────────────────────────
        if (tool === 'select-rect') {
            if (selDrawing) {
                const r = normRect(snapX, snapY, x, y);
                sel = { ...sel, ...r };
                drawMarquee(r.x, r.y, r.w, r.h);
                setSelStatus();
            } else if (selMoving && sel) {
                sel.x = Math.max(0, Math.min(W - sel.w, selMoveSelX + (x - selMoveBaseX)));
                sel.y = Math.max(0, Math.min(H - sel.h, selMoveSelY + (y - selMoveBaseY)));
                drawMarquee(sel.x, sel.y, sel.w, sel.h);
            }
            return;
        }

        // ── Lasso draw / move ─────────────────────────────────
        if (tool === 'select-lasso') {
            if (lassoActive) {
                lassoPoints.push({ x, y });
                drawLassoOverlay(lassoPoints);
            } else if (selMoving && sel) {
                sel.x = Math.max(0, Math.min(W - sel.w, selMoveSelX + (x - selMoveBaseX)));
                sel.y = Math.max(0, Math.min(H - sel.h, selMoveSelY + (y - selMoveBaseY)));
                drawMarquee(sel.x, sel.y, sel.w, sel.h);
            }
            return;
        }

        if (!painting) return;

        // ── Eraser ────────────────────────────────────────────
        if (tool === 'eraser') {
            const ew = Math.max(8, size * 6);
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = '#ffffff';
            // Fill every point along the stroke path to avoid gaps
            const steps = Math.ceil(Math.hypot(x - lastX, y - lastY) / (ew / 2)) + 1;
            for (let i = 0; i <= steps; i++) {
                const t = steps > 0 ? i / steps : 0;
                const ix = lastX + (x - lastX) * t;
                const iy = lastY + (y - lastY) * t;
                ctx.fillRect(ix - ew/2, iy - ew/2, ew, ew);
            }
            lastX = x; lastY = y;
            return;
        }

        // ── Brush ─────────────────────────────────────────────
        if (tool === 'brush') {
            ctx.globalAlpha = 0.65;
            ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(x, y); ctx.stroke();
            lastX = x; lastY = y;
            return;
        }

        // ── Pencil ────────────────────────────────────────────
        if (tool === 'pencil') {
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(x, y); ctx.stroke();
            lastX = x; lastY = y;
            return;
        }

        if (SHAPE_TOOLS.has(tool)) {
            updateSnapStatus();
            previewShape(x, y);
        }
    }

    canvas.addEventListener('mouseup',    onEnd);
    canvas.addEventListener('touchend',   onEnd);
    canvas.addEventListener('mouseleave', onEnd);
    document.addEventListener('mouseup',  onEnd);

    function onEnd() {
        // Always restore composite op
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;

        // ── Rect select ───────────────────────────────────────
        if (tool === 'select-rect') {
            if (selDrawing) {
                selDrawing = false;
                if (sel && sel.w > 2 && sel.h > 2) {
                    const fc = document.createElement('canvas');
                    fc.width = sel.w; fc.height = sel.h;
                    fc.getContext('2d').drawImage(canvas, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
                    sel.floatCanvas = fc;
                }
            }
            if (selMoving) { selMoving = false; }
            return;
        }

        // ── Lasso select ──────────────────────────────────────
        if (tool === 'select-lasso') {
            if (lassoActive && lassoPoints.length > 2) {
                commitLasso(lassoPoints);
            } else if (lassoActive) {
                lassoPoints = []; lassoActive = false; clearOverlay();
            }
            if (selMoving) { selMoving = false; }
            return;
        }

        if (!painting) return;
        painting = false;
        if (SHAPE_TOOLS.has(tool)) { pushUndo(); commitShape(); }
        updateSnapStatus();
    }

    canvas.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (tool === 'select-rect' || tool === 'select-lasso') commitSelection();
    });

    canvasArea.addEventListener('mousedown', e => {
        if (e.target !== canvas) commitSelection();
    });

    // ── Text tool ─────────────────────────────────────────────
    function startTextInput(x, y) {
        if (textInput) finishTextInput();
        textPos   = { x, y };
        const fs  = Math.max(12, size * 3);
        textInput = document.createElement('textarea');
        const r   = canvas.getBoundingClientRect();
        const sx  = r.width  / W;
        const sy  = r.height / H;
        Object.assign(textInput.style, {
            position:   'absolute',
            left:       (r.left - canvasArea.getBoundingClientRect().left + x * sx) + 'px',
            top:        (r.top  - canvasArea.getBoundingClientRect().top  + y * sy) + 'px',
            minWidth:   '60px', minHeight: '24px',
            background: 'transparent',
            border:     '1px dashed #888',
            color:      fgColor,
            fontSize:   fs + 'px',
            fontFamily: 'Segoe UI, sans-serif',
            resize:     'both',
            outline:    'none',
            zIndex:     10,
            padding:    '2px 4px',
            userSelect: 'text',
        });
        canvasArea.appendChild(textInput);
        textInput.focus();
        textInput.addEventListener('blur',    finishTextInput);
        textInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') { textInput.value = ''; finishTextInput(); }
        });
    }

    function finishTextInput() {
        if (!textInput) return;
        const text = textInput.value;
        if (text.trim()) {
            pushUndo();
            const fs = Math.max(12, size * 3);
            ctx.fillStyle    = fgColor;
            ctx.font         = fs + 'px Segoe UI,sans-serif';
            ctx.textBaseline = 'top';
            text.split('\n').forEach((line, i) =>
                ctx.fillText(line, textPos.x, textPos.y + i * (fs + 2)));
        }
        textInput.removeEventListener('blur', finishTextInput);
        textInput.remove();
        textInput = null; textPos = null;
    }

    // ── Gallery ───────────────────────────────────────────────
    async function loadGallery() {
        if (galleryMsg) { galleryMsg.style.display = ''; galleryMsg.textContent = 'Loading…'; }
        Array.from(galleryGrid.querySelectorAll('.vp-card')).forEach(c => c.remove());
        let works;
        try {
            works = await fetchWorks(false);
        } catch (err) {
            if (galleryMsg) galleryMsg.textContent = 'Could not connect to gallery.';
            return;
        }
        if (galleryMsg) galleryMsg.style.display = 'none';
        galleryCount.textContent = works.length + ' work' + (works.length === 1 ? '' : 's');
        if (!works.length) {
            if (galleryMsg) { galleryMsg.style.display=''; galleryMsg.textContent='No works yet!'; }
            return;
        }
        works.forEach(w => galleryGrid.appendChild(buildCard(w, false)));
    }

    gallRefresh.addEventListener('click', loadGallery);

    async function loadAdmin() {
        adminGrid.innerHTML = '<p class="vp-gridmsg">Loading…</p>';
        let works;
        try   { works = await fetchWorks(true); }
        catch (err) { adminGrid.innerHTML = '<p class="vp-gridmsg">Error: ' + err.message + '</p>'; return; }
        adminGrid.innerHTML = '';
        if (!works.length) { adminGrid.innerHTML = '<p class="vp-gridmsg">No works yet.</p>'; return; }
        works.forEach(w => adminGrid.appendChild(buildCard(w, true)));
    }

    adminRefresh.addEventListener('click', loadAdmin);

    function buildCard(work, isAdmin) {
        const card = document.createElement('div');
        card.className = 'vp-card';
        if (work.pinned) card.classList.add('vp-card-pinned');

        // Pin badge
        if (work.pinned) {
            const badge = document.createElement('div');
            badge.className   = 'vp-pin-badge';
            badge.textContent = '📌';
            badge.title       = 'Pinned';
            card.appendChild(badge);
        }

        const img = document.createElement('img');
        img.className = 'vp-card-thumb';
        img.src = work.thumb_data || work.image_data;
        img.alt = 'By ' + (work.author || 'anonymous');
        img.addEventListener('click', () => {
            lightboxImg.src = work.image_data;
            lightbox.classList.remove('hidden');
        });
        card.appendChild(img);

        const meta = document.createElement('div');
        meta.className = 'vp-card-meta';
        const author = document.createElement('div');
        author.className   = 'vp-card-author';
        author.textContent = work.author || 'anonymous';
        const date = document.createElement('div');
        date.className   = 'vp-card-date';
        date.textContent = new Date(work.created_at).toLocaleDateString();
        meta.append(author, date);
        card.appendChild(meta);

        // Owner action row — shown in gallery when ownerMode, always in admin
        if (isAdmin || ownerMode) {
            const row = document.createElement('div');
            row.className = 'vp-card-actions';

            // Pin/unpin
            const pinBtn = document.createElement('button');
            pinBtn.className   = 'vp-card-action-btn';
            pinBtn.textContent = work.pinned ? '📌 UNPIN' : '📌 PIN';
            pinBtn.title       = work.pinned ? 'Unpin from top' : 'Pin to top of gallery';
            pinBtn.addEventListener('click', async () => {
                const newPinned = !work.pinned;
                try {
                    await togglePin(work.id, newPinned);
                    work.pinned        = newPinned;
                    pinBtn.textContent = newPinned ? '📌 UNPIN' : '📌 PIN';
                    card.classList.toggle('vp-card-pinned', newPinned);
                    showToast(newPinned ? 'Pinned to top.' : 'Unpinned.');
                } catch (err) { showToast('Pin failed: ' + err.message, true); }
            });
            row.appendChild(pinBtn);

            if (isAdmin) {
                // Hide/show toggle (admin only)
                const hideBtn = document.createElement('button');
                hideBtn.className   = 'vp-card-action-btn';
                hideBtn.textContent = work.hidden ? '👁 SHOW' : '🙈 HIDE';
                hideBtn.title       = work.hidden ? 'Show in gallery' : 'Hide from gallery';
                hideBtn.addEventListener('click', async () => {
                    const newHidden = !work.hidden;
                    try {
                        await toggleHideWork(work.id, newHidden);
                        work.hidden        = newHidden;
                        hideBtn.textContent = newHidden ? '👁 SHOW' : '🙈 HIDE';
                        card.style.opacity  = newHidden ? '0.45' : '1';
                        showToast(newHidden ? 'Hidden.' : 'Visible.');
                    } catch (err) { showToast('Failed: ' + err.message, true); }
                });
                row.appendChild(hideBtn);
            }

            // Delete (admin only)
            if (isAdmin) {
                const del = document.createElement('button');
                del.className   = 'vp-card-action-btn vp-card-delete-btn';
                del.textContent = '🗑 DEL';
                del.title       = 'Delete permanently';
                del.addEventListener('click', async () => {
                    if (!confirm('Delete permanently?')) return;
                    try   { await deleteWork(work.id); card.remove(); showToast('Deleted.'); }
                    catch (err) { showToast('Delete failed: ' + err.message, true); }
                });
                row.appendChild(del);
            }

            card.appendChild(row);
        }

        if (work.hidden && isAdmin) card.style.opacity = '0.45';
        return card;
    }

    // ── Post to Gallery (via dialog) ──────────────────────────
    function openPostDialog() {
        postErr.classList.add('hidden');
        nameInput.value = '';
        postDialog.classList.remove('hidden');
        requestAnimationFrame(() => nameInput.focus());
    }

    postCancel.addEventListener('click', () => postDialog.classList.add('hidden'));
    postDialog.addEventListener('click', e => {
        if (e.target === postDialog) postDialog.classList.add('hidden');
    });

    async function doPost() {
        commitSelection();
        const author    = nameInput.value.trim() || 'anonymous';
        const imageData = canvasToJpeg(canvas, 0.82);
        const thumbData = makeThumbnail(canvas, 200, 0.55);

        postBtn.disabled    = true;
        postBtn.textContent = '⏳';
        postErr.classList.add('hidden');

        try {
            await insertWork(author, imageData, thumbData);
            postDialog.classList.add('hidden');
            showToast('Posted!');
            nameInput.value = '';
        } catch (err) {
            const isUnconfigured = SB_URL.includes('YOURPROJECT');
            const isFetchErr = err.message?.includes('fetch');
            let msg = 'POST FAILED';
            if (isUnconfigured) msg = 'SUPABASE NOT CONFIGURED';
            else if (isFetchErr) msg = 'NETWORK ERROR — CHECK CONSOLE';
            postErr.textContent = msg;
            postErr.classList.remove('hidden');
            console.error('[vpaint] post failed:', err);
        } finally {
            postBtn.disabled    = false;
            postBtn.textContent = 'Post 📤';
        }
    }

    postBtn.addEventListener('click', doPost);
    nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter')  doPost();
        if (e.key === 'Escape') postDialog.classList.add('hidden');
    });

    // ── Lightbox ──────────────────────────────────────────────
    lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));

    // ── Toast ─────────────────────────────────────────────────
    let toastTimer;
    function showToast(msg, isError = false) {
        toast.textContent = msg;
        toast.classList.remove('hidden', 'error');
        if (isError) toast.classList.add('error');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
    }

    // ── Menu bar ──────────────────────────────────────────────
    initVPaintMenus(win, {
        savePNG:       () => saveBtn.click(),
        clear:        () => clearBtn.click(),
        close:        () => entry.el.classList.add('hidden'),
        undo,
        copy:         copySelection,
        cut:          cutSelection,
        paste:        pasteSelection,
        selectAll,
        rotate90:     doRotate90,
        flipH:        doFlipH,
        flipV:        doFlipV,
        resize:       () => resizeDlg.classList.remove('hidden'),
        postToGallery: openPostDialog,
        tabGallery:   () => win.querySelector('.vp-tab[data-tab="gallery"]').click(),
    });

    // ── Owner mode ────────────────────────────────────────────
    lockBtn.addEventListener('click', () => {
        if (ownerMode) { lockOwner(); return; }
        modal.classList.remove('hidden');
        modalPw.value = '';
        modalErr.classList.add('hidden');
        requestAnimationFrame(() => modalPw.focus());
    });

    modalCancel.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });

    function attemptLogin() {
        if (modalPw.value === WALL_PASSWORD) {
            modal.classList.add('hidden');
            unlockOwner();
        } else {
            modalErr.classList.remove('hidden');
            modalPw.value = ''; modalPw.focus();
        }
    }

    modalSubmit.addEventListener('click', attemptLogin);
    modalPw.addEventListener('keydown', e => {
        if (e.key === 'Enter')  attemptLogin();
        if (e.key === 'Escape') modal.classList.add('hidden');
    });

    function unlockOwner() {
        ownerMode = true;
        lockBtn.textContent = '🔓';
        lockBtn.classList.add('unlocked');
        adminTab.classList.remove('hidden');
        // Refresh gallery so owner action buttons appear on cards
        if (!document.getElementById('vp-panel-gallery').classList.contains('hidden'))
            loadGallery();
    }

    function lockOwner() {
        ownerMode = false;
        lockBtn.textContent = '🔒';
        lockBtn.classList.remove('unlocked');
        adminTab.classList.add('hidden');
        if (!document.getElementById('vp-panel-admin').classList.contains('hidden'))
            win.querySelector('.vp-tab[data-tab="paint"]').click();
        // Refresh gallery to hide owner action buttons
        if (!document.getElementById('vp-panel-gallery').classList.contains('hidden'))
            loadGallery();
    }
}
