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
    let highestZ   = 50;

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
        windowEl.addEventListener('mousedown', () => bringToFront(windowEl));

        // Make the title bar draggable
        makeDraggable(windowEl, bringToFront);

        return entry;
    }

    function openWindow(entry) {
        entry.el.classList.remove('hidden', 'minimized');
        // Force animation restart
        entry.el.style.animation = 'none';
        void entry.el.offsetWidth;
        entry.el.style.animation = '';
        bringToFront(entry.el);
        updateTaskbarBtn(entry, true);
    }

    function closeWindow(entry) {
        entry.el.classList.add('hidden');
        entry.el.classList.remove('minimized');
        entry.taskbarBtn?.remove();
        entry.taskbarBtn = null;
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

    function down(e) {
        if (e.target.closest('.window-controls')) return;
        const px = e.touches ? e.touches[0].clientX : e.clientX;
        const py = e.touches ? e.touches[0].clientY : e.clientY;
        startX = px - ox;
        startY = py - oy;
        if (e.target === titleBar || e.target.closest('.title-text')) {
            active = true;
            bringToFront(windowEl);
        }
    }

    function up() {
        startX = cx; startY = cy;
        active = false;
    }

    function move(e) {
        if (!active) return;
        e.preventDefault();
        const px = e.touches ? e.touches[0].clientX : e.clientX;
        const py = e.touches ? e.touches[0].clientY : e.clientY;
        cx = px - startX;
        cy = Math.max(0, py - startY); // clamp top edge
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