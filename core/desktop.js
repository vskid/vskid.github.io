// ============================================================
// core/desktop.js
// ============================================================
// Core desktop OS primitives. Exports a single init() that
// boots the whole shell and returns the public API that app
// modules use to register and control windows.
//
// Exports:  { registerWindow, openWindow, closeWindow,
//             minimizeWindow, bringToFront }
// ============================================================


// ── CLOCK ───────────────────────────────────────────────────
// Updates the taskbar time display every second.

function initClock() {
    const el = document.getElementById('clock');
    const tick = () => {
        const now = new Date();
        el.textContent =
            String(now.getHours()).padStart(2, '0') + ':' +
            String(now.getMinutes()).padStart(2, '0');
    };
    setInterval(tick, 1000);
    tick();
}


// ── WINDOW SYSTEM ────────────────────────────────────────────
// Every <div class="window"> in the HTML becomes a managed
// window after registerWindow(el) is called on it.
//
// Entry object shape: { el, title, icon, taskbarBtn }
//
// CSS class state machine:
//   (none)     : open and visible
//   .hidden    : closed, no taskbar button
//   .minimized : hidden but taskbar button remains

function initWindowSystem() {
    const registry = [];
    let highestZ        = 50;
    let cascadeCount    = 0;  // increments each time a window is opened
    const CASCADE_STEP  = 28; // px offset per open
    const CASCADE_RESET = 8;  // reset after this many opens to avoid going off-screen

    function bringToFront(el) {
        el.style.zIndex = ++highestZ;
    }

    // Read title/icon from the window's .title-bar DOM.
    // Pass opts.icon to override the taskbar icon (e.g. force 📁 for all explorer windows).
    function registerWindow(windowEl, opts = {}) {
        const titleEl = windowEl.querySelector('.title-text');
        const iconEl  = titleEl?.querySelector('.title-icon');
        const icon    = opts.icon ?? iconEl?.textContent.trim() ?? '🗔';
        const title   = titleEl
            ? Array.from(titleEl.childNodes)
                .filter(n => n.nodeType === Node.TEXT_NODE)
                .map(n => n.textContent.trim())
                .join('') || titleEl.textContent.trim()
            : 'Window';

        const entry = { el: windowEl, title, icon, taskbarBtn: null };
        registry.push(entry);

        windowEl.querySelector('.close-btn')
            ?.addEventListener('click', () => closeWindow(entry));
        windowEl.querySelector('.minimize-btn')
            ?.addEventListener('click', () => minimizeWindow(entry));

        // Inject maximize button between minimize and close
        const controls = windowEl.querySelector('.window-controls');
        if (controls && !controls.querySelector('.maximize-btn')) {
            const maxBtn = document.createElement('button');
            maxBtn.className = 'maximize-btn';
            maxBtn.title     = 'Maximize';
            maxBtn.textContent = '□';
            maxBtn.addEventListener('click', () => toggleMaximize(entry));
            const closeBtn = controls.querySelector('.close-btn');
            closeBtn ? controls.insertBefore(maxBtn, closeBtn) : controls.appendChild(maxBtn);
        }

        windowEl.addEventListener('mousedown', () => bringToFront(windowEl));

        // Make the title bar draggable and the window resizable
        makeDraggable(windowEl, bringToFront);
        makeResizable(windowEl);

        return entry;
    }

    function openWindow(entry) {
        const firstOpen = entry.el.classList.contains('hidden') &&
                          !entry.taskbarBtn;
        entry.el.classList.remove('hidden', 'minimized');
        // Force animation restart
        entry.el.style.animation = 'none';
        void entry.el.offsetWidth;
        entry.el.style.animation = '';
        bringToFront(entry.el);

        // Cascade: nudge position each time a new window is opened so they
        // don't perfectly overlap. Only applies on the very first open (not
        // restore-from-minimise) and only if the user hasn't already dragged it.
        if (firstOpen && !entry._cascaded) {
            entry._cascaded = true;
            const step = (cascadeCount % CASCADE_RESET) * CASCADE_STEP;
            cascadeCount++;
            // Only offset if the window hasn't been manually dragged yet
            // (transform is still the CSS default 'none' or empty)
            const t = entry.el.style.transform;
            if (!t || t === 'none') {
                entry.el.style.transform = `translate3d(${step}px, ${step}px, 0)`;
            }
        }

        updateTaskbarBtn(entry, true);
    }

    // ── Maximize / restore ────────────────────────────────────
    // Saves the window's current inline position/size before
    // maximizing so restore brings it back exactly.

    function toggleMaximize(entry) {
        const el = entry.el;
        const maxBtn = el.querySelector('.maximize-btn');

        if (el.classList.contains('maximized')) {
            // Restore
            el.classList.remove('maximized');
            // Restore saved inline styles
            const s = entry._preMaximize || {};
            el.style.transform = s.transform ?? '';
            el.style.width     = s.width     ?? '';
            el.style.height    = s.height    ?? '';
            el.style.left      = s.left      ?? '';
            el.style.top       = s.top       ?? '';
            el.style.position  = s.position  ?? '';
            if (maxBtn) { maxBtn.textContent = '□'; maxBtn.title = 'Maximize'; }
        } else {
            // Save current inline styles before overriding
            entry._preMaximize = {
                transform: el.style.transform,
                width:     el.style.width,
                height:    el.style.height,
                left:      el.style.left,
                top:       el.style.top,
                position:  el.style.position,
            };
            // Clear position/size so .maximized CSS takes full effect
            el.style.transform = '';
            el.style.width     = '';
            el.style.height    = '';
            el.style.left      = '';
            el.style.top       = '';
            el.style.position  = '';
            el.classList.add('maximized');
            bringToFront(el);
            if (maxBtn) { maxBtn.textContent = '❐'; maxBtn.title = 'Restore'; }
        }
    }

    function closeWindow(entry) {
        entry.el.classList.remove('hidden', 'minimized', 'maximized');
        entry.el.classList.add('hidden');
        entry.taskbarBtn?.remove();
        entry.taskbarBtn = null;
        entry._preMaximize = null;
        // Reset maximize button symbol
        const maxBtn = entry.el.querySelector('.maximize-btn');
        if (maxBtn) { maxBtn.textContent = '□'; maxBtn.title = 'Maximize'; }
        // Reset any inline styles from drag/resize so the window reopens
        // at its CSS-defined size and position, not stuck at last session's state.
        entry.el.style.transform = '';
        entry.el.style.width     = '';
        entry.el.style.height    = '';
        entry.el.style.maxWidth  = '';
        entry.el.style.maxHeight = '';
        entry.el.style.left      = '';
        entry.el.style.top       = '';
        entry.el.style.position  = '';
        // Reset cascade flag so it gets a fresh position on next open
        entry._cascaded = false;
    }

    function minimizeWindow(entry) {
        entry.el.classList.add('minimized');
        updateTaskbarBtn(entry, false);
    }

    function toggleWindow(entry) {
        const off = entry.el.classList.contains('hidden') ||
                    entry.el.classList.contains('minimized');
        off ? openWindow(entry) : minimizeWindow(entry);
    }

    function updateTaskbarBtn(entry, isActive) {
        if (!entry.taskbarBtn) {
            const btn = document.createElement('button');
            btn.className = 'taskbar-app-btn';
            btn.innerHTML = `<span class="taskbar-app-icon">${entry.icon}</span>`;
            document.querySelector('.taskbar-apps').appendChild(btn);
            entry.taskbarBtn = btn;
            initTaskbarBtnDrag(btn, entry, toggleWindow);
        }
        entry.taskbarBtn.classList.toggle('active', isActive);
    }

    return { registerWindow, openWindow, closeWindow, minimizeWindow, bringToFront };
}


// ── WINDOW TITLE-BAR DRAGGING ────────────────────────────────
// Attached to every window via registerWindow.
// Uses translate3d (GPU layer) rather than top/left.

function makeDraggable(windowEl, bringToFront) {
    const titleBar = windowEl.querySelector('.title-bar');
    if (!titleBar) return;

    let active = false;
    let startX, startY, ox = 0, oy = 0, cx, cy;

    // Read the current translate3d offset from inline style so that
    // the first drag after a cascade-open or re-open starts from the
    // correct position rather than snapping back to (0, 0).
    function readCurrentOffset() {
        const t = windowEl.style.transform;
        if (!t || t === 'none') { ox = 0; oy = 0; return; }
        const m = t.match(/translate3d\(\s*([-\d.]+)px,\s*([-\d.]+)px/);
        if (m) { ox = parseFloat(m[1]); oy = parseFloat(m[2]); }
    }

    function down(e) {
        if (e.target.closest('.window-controls')) return;
        if (e.target !== titleBar && !e.target.closest('.title-text')) return;
        // Don't allow dragging a maximized window — must restore first
        if (windowEl.classList.contains('maximized')) return;
        e.preventDefault();
        readCurrentOffset();
        const px = e.touches ? e.touches[0].clientX : e.clientX;
        const py = e.touches ? e.touches[0].clientY : e.clientY;
        startX = px - ox;
        startY = py - oy;
        active = true;
        bringToFront(windowEl);
    }

    function up() { active = false; }

    function move(e) {
        if (!active) return;
        e.preventDefault();
        const px = e.touches ? e.touches[0].clientX : e.clientX;
        const py = e.touches ? e.touches[0].clientY : e.clientY;
        cx = px - startX;
        cy = py - startY;
        ox = cx; oy = cy;
        windowEl.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
        windowEl.style.animation = 'none';
    }

    titleBar.addEventListener('mousedown',  down);
    titleBar.addEventListener('touchstart', down, { passive: false });
    document.addEventListener('mouseup',    up);
    document.addEventListener('touchend',   up);
    document.addEventListener('mousemove',  move);
    document.addEventListener('touchmove',  move, { passive: false });
}


// ── TASKBAR BUTTON DRAG-TO-REORDER ───────────────────────────
// Drag a taskbar button left/right to reorder.
// Other buttons slide to preview the drop slot.
// Release snaps everything back into flexbox flow.
// Short tap with no movement = click = toggleWindow.

function initTaskbarBtnDrag(btn, entry, toggleWindow) {
    const GAP = 8; // must match gap in .taskbar-apps CSS
    let dragStartX, pointerOffsetX, didDrag = false;

    const cx = e => e.touches ? e.touches[0].clientX : e.clientX;

    function down(e) {
        if (e.type === 'mousedown' && e.button !== 0) return;
        e.preventDefault();
        dragStartX     = cx(e);
        pointerOffsetX = cx(e) - btn.getBoundingClientRect().left;
        didDrag        = false;
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup',   up);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend',  up);
    }

    function move(e) {
        const x = cx(e);
        if (!didDrag && Math.abs(x - dragStartX) < 5) return;
        e.preventDefault();
        if (!didDrag) { didDrag = true; btn.classList.add('dragging'); freeze(); }

        const apps = document.querySelector('.taskbar-apps');
        const cr   = apps.getBoundingClientRect();
        const w    = btn.offsetWidth;
        const pos  = Math.max(0, Math.min(x - cr.left - pointerOffsetX, cr.width - w));
        btn.style.left = pos + 'px';

        const sibs   = sorted();
        const center = pos + w / 2;
        const target = targetIdx(sibs, center, w);
        sibs.forEach((s, i) => {
            if (s === btn) return;
            s.style.transition = 'left 0.15s ease';
            s.style.left = shiftedX(sibs, i, target, w) + 'px';
        });
    }

    function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup',   up);
        document.removeEventListener('touchmove', move);
        document.removeEventListener('touchend',  up);

        if (!didDrag) { toggleWindow(entry); return; }

        btn.classList.remove('dragging');
        const apps   = document.querySelector('.taskbar-apps');
        const sibs   = sorted();
        const w      = btn.offsetWidth;
        const center = parseFloat(btn.style.left) + w / 2;
        const target = targetIdx(sibs, center, w);
        const others = sibs.filter(s => s !== btn);
        const before = others[target] ?? null;
        before ? apps.insertBefore(btn, before) : apps.appendChild(btn);

        Array.from(apps.children).forEach(s => {
            s.style.transition = 'left 0.18s cubic-bezier(0.2,0,0.2,1)';
            s.style.left = '';
        });
        setTimeout(() => {
            Array.from(apps.children).forEach(s => {
                s.style.cssText = '';
            });
            apps.style.position = '';
            apps.style.height   = '';
        }, 200);
    }

    function freeze() {
        const apps = document.querySelector('.taskbar-apps');
        const cr   = apps.getBoundingClientRect();
        apps.style.position = 'relative';
        apps.style.height   = apps.offsetHeight + 'px';
        Array.from(apps.children).forEach(s => {
            const r = s.getBoundingClientRect();
            s.style.position = 'absolute';
            s.style.left     = (r.left - cr.left) + 'px';
            s.style.top      = (r.top  - cr.top)  + 'px';
            s.style.width    = r.width + 'px';
        });
    }

    function sorted() {
        return Array.from(document.querySelector('.taskbar-apps').children)
            .sort((a, b) => parseFloat(a.style.left||0) - parseFloat(b.style.left||0));
    }

    function targetIdx(sibs, center, w) {
        const others = sibs.filter(s => s !== btn);
        let idx = 0;
        others.forEach((s, i) => { if (center > i * (w + GAP) + w / 2) idx = i + 1; });
        return idx;
    }

    function shiftedX(sibs, sibIdx, target, w) {
        const others = sibs.filter(s => s !== btn);
        const rank   = others.indexOf(sibs[sibIdx]);
        if (rank === -1) return parseFloat(sibs[sibIdx].style.left || 0);
        return (rank >= target ? rank + 1 : rank) * (w + GAP);
    }

    btn.addEventListener('mousedown', down);
    btn.addEventListener('touchstart', down, { passive: false });
}


// ── WINDOW RESIZE (SE corner handle) ─────────────────────────
// Injects a single bottom-right drag handle into every window.
// Works with mouse and touch. Respects any CSS min-width/height.
// Because windows use translate3d for position we must NOT use
// offsetLeft/offsetTop — we only change width/height, never position.

function makeResizable(windowEl) {
    const handle = document.createElement('div');
    handle.className = 'resize-handle resize-se';
    windowEl.appendChild(handle);

    let active = false;
    let startX, startY, startW, startH;

    function onDown(e) {
        // Don't resize a maximized window
        if (windowEl.classList.contains('maximized')) return;
        e.preventDefault();
        e.stopPropagation();
        const px = e.touches ? e.touches[0].clientX : e.clientX;
        const py = e.touches ? e.touches[0].clientY : e.clientY;
        const r  = windowEl.getBoundingClientRect();
        startX = px;
        startY = py;
        startW = r.width;
        startH = r.height;
        active = true;

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend',  onUp);
    }

    function onMove(e) {
        if (!active) return;
        e.preventDefault();
        const px = e.touches ? e.touches[0].clientX : e.clientX;
        const py = e.touches ? e.touches[0].clientY : e.clientY;

        // Compute desired size from drag delta
        const newW = Math.max(260, startW + (px - startX));
        const newH = Math.max(180, startH + (py - startY));

        windowEl.style.width  = newW + 'px';
        windowEl.style.height = newH + 'px';
        // Override any max constraints set by CSS
        windowEl.style.maxWidth  = 'none';
        windowEl.style.maxHeight = 'none';
    }

    function onUp() {
        active = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend',  onUp);
    }

    handle.addEventListener('mousedown',  onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
}


// ── START MENU ───────────────────────────────────────────────
// Toggle on Start click. Outside click closes.
// Shutdown: tries window.close(), falls back to terminal egg.

function initStartMenu() {
    const startBtn    = document.querySelector('.start-btn');
    const startMenu   = document.getElementById('start-menu');
    const shutdownBtn = document.getElementById('shutdown-btn');

    startBtn.addEventListener('click', e => {
        e.stopPropagation();
        startMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', e => {
        if (!startMenu.contains(e.target) && !startBtn.contains(e.target))
            startMenu.classList.add('hidden');
    });

    startMenu.addEventListener('click', e => e.stopPropagation());

    shutdownBtn.addEventListener('click', () => {
        window.open('', '_self', '');
        window.close();
        setTimeout(() => {
            const style = document.createElement('style');
            style.innerHTML = '@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}';
            document.head.appendChild(style);
            document.body.innerHTML = `<div id="shutdown-terminal" style="background:black;color:#aaa;font-family:'Courier New',monospace;font-size:1.1rem;width:100vw;height:100vh;position:fixed;top:0;left:0;z-index:9999;padding:20px;box-sizing:border-box;overflow:hidden;cursor:none"></div>`;
            const term  = document.getElementById('shutdown-terminal');
            const lines = [
                '> If you\'re seeing this,',
                '> the browser is blocking the tab from closing.',
                '> You can close the tab manually.',
                '> Thanks for visiting!'
            ];
            let i = 0;
            const iv = setInterval(() => {
                if (i < lines.length) { term.innerHTML += `<div>${lines[i++]}</div>`; }
                else {
                    clearInterval(iv);
                    term.innerHTML += `<div style="animation:blink 1s step-end infinite;display:inline-block;width:10px;height:1.1rem;background:#aaa;margin-top:5px"></div>`;
                }
            }, 1000);
        }, 100);
    });
}


// ── BOOT ─────────────────────────────────────────────────────

export function init() {
    initClock();
    initStartMenu();
    return initWindowSystem(); // returns { registerWindow, openWindow, ... }
}