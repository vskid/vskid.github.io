// ============================================================
// vmedia-eq.js — Graphic EQ window, Web Audio graph, visualiser
// ============================================================
// Exported surface:
//   initEQ(audioEl)  →  { openEQ, closeEQ, toggleEQ,
//                         connectAudioEl, connectVideoEl,
//                         getMode: () => renderMode }
// The EQ window element must already exist in the DOM
// (#wmp-eq-window, populated by vmedia.html).
// ============================================================

const GAIN_BANDS = [
    { freq: 32,    label: '32'  },
    { freq: 64,    label: '64'  },
    { freq: 125,   label: '125' },
    { freq: 250,   label: '250' },
    { freq: 500,   label: '500' },
    { freq: 1000,  label: '1k'  },
    { freq: 2000,  label: '2k'  },
    { freq: 4000,  label: '4k'  },
    { freq: 8000,  label: '8k'  },
    { freq: 16000, label: '16k' },
];
const VIS_BARS = 40;

export function initEQ(audioEl) {
    const eqWindowEl = document.getElementById('wmp-eq-window');
    const eqCanvas   = document.getElementById('wmp-eq-canvas');
    const eqSliders  = document.getElementById('wmp-eq-sliders');
    const eqLabels   = document.getElementById('wmp-eq-labels');
    const eqResetBtn = document.getElementById('wmp-eq-reset');
    const ctx2d      = eqCanvas.getContext('2d');

    // ── EQ window drag ────────────────────────────────────────
    // Uses position:fixed left/top directly — no translate juggling.
    // On first drag, reads rendered position and switches to fixed left/top.
    // Subsequent drags update left/top directly.
    eqWindowEl.style.zIndex = 200;
    {
        const bar = eqWindowEl.querySelector('.title-bar');
        let dragging = false;
        let startMouseX, startMouseY, startLeft, startTop;

        function onDown(e) {
            if (e.target.closest('.window-controls')) return;
            e.preventDefault();
            e.stopPropagation();

            // Read the window's *actual* screen position as fixed coordinates.
            // getBoundingClientRect() always returns correct values when the
            // element is visible (openEQ is called before any drag can happen).
            const r = eqWindowEl.getBoundingClientRect();

            // Switch to position:fixed left/top if not already done,
            // clearing any CSS top/left/transform from the stylesheet.
            eqWindowEl.style.position  = 'fixed';
            eqWindowEl.style.transform = 'none';
            eqWindowEl.style.left      = r.left + 'px';
            eqWindowEl.style.top       = r.top  + 'px';

            startLeft   = r.left;
            startTop    = r.top;
            const px    = e.touches ? e.touches[0].clientX : e.clientX;
            const py    = e.touches ? e.touches[0].clientY : e.clientY;
            startMouseX = px;
            startMouseY = py;
            dragging    = true;
            eqWindowEl.style.zIndex = 300;
        }

        function onMove(e) {
            if (!dragging) return;
            e.preventDefault();
            const px = e.touches ? e.touches[0].clientX : e.clientX;
            const py = e.touches ? e.touches[0].clientY : e.clientY;
            eqWindowEl.style.left = (startLeft + px - startMouseX) + 'px';
            eqWindowEl.style.top  = Math.max(0, startTop + py - startMouseY) + 'px';
        }

        function onUp() { dragging = false; }

        bar.addEventListener('mousedown',  onDown);
        bar.addEventListener('touchstart', onDown,  { passive: false });
        document.addEventListener('mousemove',  onMove);
        document.addEventListener('touchmove',  onMove, { passive: false });
        document.addEventListener('mouseup',    onUp);
        document.addEventListener('touchend',   onUp);
    }

    // ── Web Audio state ───────────────────────────────────────
    let audioCtx    = null;
    let analyser    = null;
    let filters     = [];
    let sourceNode  = null;
    let sourceEl    = null;   // which element sourceNode was created from
    let animFrameId = null;

    const gainValues = new Array(GAIN_BANDS.length).fill(0);
    const decoTarget = new Array(VIS_BARS).fill(0);
    const decoVal    = new Array(VIS_BARS).fill(0);
    const peakVal    = new Array(VIS_BARS).fill(0);
    const peakTimer  = new Array(VIS_BARS).fill(0);

    // ── Build gain slider DOM ─────────────────────────────────
    GAIN_BANDS.forEach((band, i) => {
        const bandEl = document.createElement('div');
        bandEl.className = 'wmp-eq-band';

        const valEl = document.createElement('div');
        valEl.className   = 'wmp-eq-band-val';
        valEl.textContent = '0';

        const slider = document.createElement('input');
        slider.type      = 'range';
        slider.className = 'wmp-eq-slider';
        slider.min = -12; slider.max = 12; slider.step = 0.5; slider.value = 0;

        function applyGain(db) {
            gainValues[i] = db;
            slider.value  = db;
            valEl.textContent = (db >= 0 ? '+' : '') + db.toFixed(0);
            if (filters[i]) filters[i].gain.value = db;
        }

        slider.addEventListener('input',   () => applyGain(parseFloat(slider.value)));
        slider.addEventListener('dblclick', () => applyGain(0));
        let lastTap = 0;
        slider.addEventListener('touchend', e => {
            const now = Date.now();
            if (now - lastTap < 300) { e.preventDefault(); applyGain(0); }
            lastTap = now;
        });

        bandEl.appendChild(valEl);
        bandEl.appendChild(slider);
        eqSliders.appendChild(bandEl);

        const labelEl = document.createElement('div');
        labelEl.className   = 'wmp-eq-label';
        labelEl.textContent = band.label;
        eqLabels.appendChild(labelEl);
    });

    eqResetBtn?.addEventListener('click', () => {
        GAIN_BANDS.forEach((_, i) => {
            gainValues[i] = 0;
            if (filters[i]) filters[i].gain.value = 0;
            const band   = eqSliders.children[i];
            const s      = band?.querySelector('.wmp-eq-slider');
            const v      = band?.querySelector('.wmp-eq-band-val');
            if (s) s.value = 0;
            if (v) v.textContent = '0';
        });
    });

    eqWindowEl.querySelector('.close-btn').addEventListener('click', () => closeEQ());

    // ── Web Audio setup ───────────────────────────────────────

    function setupAudioContext() {
        if (audioCtx) return;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize               = 2048;
        analyser.smoothingTimeConstant = 0.8;

        filters = GAIN_BANDS.map((band, i) => {
            const f           = audioCtx.createBiquadFilter();
            f.type            = i === 0 ? 'lowshelf'
                              : i === GAIN_BANDS.length - 1 ? 'highshelf' : 'peaking';
            f.frequency.value = band.freq;
            f.gain.value      = gainValues[i];
            f.Q.value         = 1.4;
            return f;
        });
        for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
        filters[filters.length - 1].connect(analyser);
        analyser.connect(audioCtx.destination);
    }

    // Connect a media element to the EQ filter chain.
    // Same element → just resume the context (src changes are fine).
    // Different element → disconnect old source, create new one.
    function connectMediaEl(mediaEl) {
        if (!mediaEl) return;
        if (!audioCtx) setupAudioContext();
        try {
            if (sourceNode && sourceEl === mediaEl) {
                if (audioCtx.state === 'suspended') audioCtx.resume();
                return;
            }
            if (sourceNode) {
                try { sourceNode.disconnect(); } catch (_) {}
                sourceNode = null;
                sourceEl   = null;
            }
            sourceNode = audioCtx.createMediaElementSource(mediaEl);
            sourceEl   = mediaEl;
            sourceNode.connect(filters[0]);
            if (audioCtx.state === 'suspended') audioCtx.resume();
        } catch (err) {
            console.warn('[vmedia EQ] connect failed:', err);
        }
    }

    // ── Public connect helpers ────────────────────────────────

    function connectAudioEl() {
        connectMediaEl(audioEl);
    }

    function connectVideoEl() {
        const v = document.getElementById('wmp-video-el');
        if (v) connectMediaEl(v);
    }

    // Called by loadLocalVideo when the video element is removed from DOM.
    // Clears the stale sourceNode so the next video gets a fresh connection.
    function onVideoRemoved(removedEl) {
        if (sourceEl === removedEl) {
            try { sourceNode?.disconnect(); } catch (_) {}
            sourceNode = null;
            sourceEl   = null;
        }
    }

    // ── Visualiser ────────────────────────────────────────────

    function startVisualiser() { stopVisualiser(); drawFrame(); }
    function stopVisualiser()  {
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    }

    function resizeCanvas() {
        const dpr = devicePixelRatio || 1;
        eqCanvas.width  = eqCanvas.offsetWidth  * dpr;
        eqCanvas.height = eqCanvas.offsetHeight * dpr;
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // currentMode is set by vmedia.js via the returned setter
    let currentMode = null;

    function drawFrame() {
        animFrameId = requestAnimationFrame(drawFrame);
        const W = eqCanvas.offsetWidth;
        const H = eqCanvas.offsetHeight;
        if (!W || !H) return;

        const dpr = devicePixelRatio || 1;
        if (eqCanvas.width !== W * dpr || eqCanvas.height !== H * dpr) {
            eqCanvas.width  = W * dpr;
            eqCanvas.height = H * dpr;
            ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        ctx2d.clearRect(0, 0, W, H);
        ctx2d.fillStyle = '#000';
        ctx2d.fillRect(0, 0, W, H);

        const gap  = 1;
        const barW = (W - (VIS_BARS + 1) * gap) / VIS_BARS;
        const maxH = H - 4;

        const hasRealData = analyser && sourceNode &&
            (currentMode === 'audio-html5' || currentMode === 'video-local');
        const renderMode  = hasRealData ? 'real'
                          : currentMode === 'audio-embed' ? 'deco' : 'idle';

        if (renderMode === 'real') {
            const buf     = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(buf);
            const nyquist = audioCtx.sampleRate / 2;
            for (let i = 0; i < VIS_BARS; i++) {
                const fLow  = 20 * Math.pow(20000 / 20, i / VIS_BARS);
                const fHigh = 20 * Math.pow(20000 / 20, (i + 1) / VIS_BARS);
                const bLow  = Math.floor(fLow  / nyquist * buf.length);
                const bHigh = Math.ceil( fHigh / nyquist * buf.length);
                let sum = 0, count = 0;
                for (let b = bLow; b <= Math.min(bHigh, buf.length - 1); b++) { sum += buf[b]; count++; }
                const raw  = count ? sum / count / 255 : 0;
                const barH = Math.max(1, raw * maxH);

                if (barH > peakVal[i]) { peakVal[i] = barH; peakTimer[i] = 30; }
                else if (peakTimer[i] > 0) peakTimer[i]--;
                else peakVal[i] = Math.max(1, peakVal[i] - 1.2);

                const x = gap + i * (barW + gap);
                const grad = ctx2d.createLinearGradient(0, H, 0, 2);
                grad.addColorStop(0,   'rgba(255,60,0,0.95)');
                grad.addColorStop(0.6, 'rgba(255,160,0,0.9)');
                grad.addColorStop(1,   'rgba(255,240,100,0.85)');
                ctx2d.fillStyle = grad;
                ctx2d.fillRect(x, H - barH - 2, barW, barH);
                ctx2d.fillStyle = 'rgba(255,255,200,0.85)';
                ctx2d.fillRect(x, H - peakVal[i] - 2, barW, 1.5);
            }
        } else {
            const alpha = renderMode === 'deco' ? '0.75' : '0.3';
            for (let i = 0; i < VIS_BARS; i++) {
                if (renderMode === 'deco') {
                    if (Math.random() < 0.03) decoTarget[i] = Math.random() * 0.9 + 0.05;
                    decoVal[i] += (decoTarget[i] - decoVal[i]) * 0.1;
                } else {
                    decoVal[i] *= 0.88;
                }
                if (decoVal[i] > peakVal[i]) { peakVal[i] = decoVal[i]; peakTimer[i] = 30; }
                else if (peakTimer[i] > 0)   peakTimer[i]--;
                else peakVal[i] = Math.max(0, peakVal[i] - 0.008);

                const barH = Math.max(0, decoVal[i] * maxH);
                const x    = gap + i * (barW + gap);
                const grad = ctx2d.createLinearGradient(0, H, 0, 2);
                grad.addColorStop(0,   `rgba(255,60,0,${alpha})`);
                grad.addColorStop(0.6, `rgba(255,150,0,${alpha})`);
                grad.addColorStop(1,   `rgba(255,230,80,${alpha})`);
                ctx2d.fillStyle = grad;
                ctx2d.fillRect(x, H - barH - 2, barW, barH);
                ctx2d.fillStyle = `rgba(255,255,150,${renderMode === 'deco' ? '0.6' : '0.15'})`;
                ctx2d.fillRect(x, H - peakVal[i] * maxH - 2, barW, 1.5);
            }
        }

        // Grid lines
        ctx2d.strokeStyle = 'rgba(255,120,0,0.07)';
        ctx2d.lineWidth   = 1;
        [0.25, 0.5, 0.75].forEach(f => {
            const y = Math.round(H * f) + 0.5;
            ctx2d.beginPath(); ctx2d.moveTo(0, y); ctx2d.lineTo(W, y); ctx2d.stroke();
        });
    }

    // ── Open / close ──────────────────────────────────────────

    function openEQ(mode) {
        currentMode = mode;
        eqWindowEl.classList.remove('hidden');
        if (mode === 'audio-html5')       connectAudioEl();
        else if (mode === 'video-local')  connectVideoEl();
        requestAnimationFrame(() => { resizeCanvas(); startVisualiser(); });
    }

    function closeEQ() {
        eqWindowEl.classList.add('hidden');
        stopVisualiser();
    }

    function toggleEQ(mode) {
        eqWindowEl.classList.contains('hidden') ? openEQ(mode) : closeEQ();
    }

    // vmedia.js calls this whenever mode changes so the visualiser
    // uses the right render path even when EQ is already open.
    function setMode(mode) { currentMode = mode; }

    return {
        openEQ, closeEQ, toggleEQ, setMode,
        connectAudioEl, connectVideoEl, onVideoRemoved,
    };
}