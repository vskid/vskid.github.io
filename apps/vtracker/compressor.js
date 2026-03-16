// ============================================================
//  apps/vtracker/compressor.js
//  Master bus compressor — sits between masterGain and destination.
//  All audio goes through this. Pure Web Audio, no UI framework.
//
//  createCompressorChain(actx)
//    Returns { input, output, comp, limiter, setEnabled }
//    Wire: masterGain → chain.input   chain.output → actx.destination
//
//  buildCompressorBar(chain, actx)
//    Returns an HTMLElement row to insert in the topbar.
//    Uses identical FT2 bevel/nudge/numval styling — no sliders.
// ============================================================

export function createCompressorChain(actx) {
    const inputGain = actx.createGain();
    inputGain.gain.value = 1.0;

    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value      =  6;
    comp.ratio.value     =  4;
    comp.attack.value    =  0.003;
    comp.release.value   =  0.25;

    // Hard limiter — brickwall at -0.5 dBFS
    const limiter = actx.createDynamicsCompressor();
    limiter.threshold.value = -0.5;
    limiter.knee.value      = 0;
    limiter.ratio.value     = 20;
    limiter.attack.value    = 0.001;
    limiter.release.value   = 0.1;

    const outputGain = actx.createGain();
    outputGain.gain.value = 1.0;

    // Active path: inputGain → comp → limiter → outputGain
    inputGain.connect(comp);
    comp.connect(limiter);
    limiter.connect(outputGain);

    // Bypass path: inputGain → bypass (gain=0 normally)
    const bypass = actx.createGain();
    bypass.gain.value = 0;
    inputGain.connect(bypass);

    let enabled = true;

    function setEnabled(v) {
        enabled = v;
        const now = actx.currentTime;
        if (v) {
            // Restore comp: set bypass silent, restore output
            bypass.gain.setValueAtTime(0, now);
            outputGain.gain.setValueAtTime(1.0, now);
        } else {
            // Mute output chain, open bypass
            bypass.gain.setValueAtTime(1, now);
            outputGain.gain.setValueAtTime(0, now);
        }
    }

    return { input: inputGain, output: outputGain, bypass, comp, limiter, inputGain, outputGain, setEnabled, get enabled() { return enabled; } };
}

// ── FT2-style compressor bar ──────────────────────────────────
// Returns a <div> that slots directly into .vt-topbar.
// Uses the same classes as the tracker: vt-lbl, vt-nudge, vt-numval, vt-btn, vt-sep.
export function buildCompressorBar(chain, actx) {
    const { comp, outputGain } = chain;

    // State (display values — actual AudioParam values are scaled)
    let state = {
        enabled:   true,
        threshold: -18,   // dB, -60..0
        ratio:      4,    // 1..20
        attack:     3,    // ms, 1..200
        release:  250,    // ms, 10..2000
        makeup:     0,    // dB, -12..+12
    };

    function applyComp() {
        const now = actx.currentTime;
        comp.threshold.setTargetAtTime(state.threshold, now, 0.01);
        comp.ratio.setTargetAtTime(state.ratio, now, 0.01);
        comp.attack.setTargetAtTime(state.attack  / 1000, now, 0.01);
        comp.release.setTargetAtTime(state.release / 1000, now, 0.01);
        outputGain.gain.setTargetAtTime(Math.pow(10, state.makeup / 20), now, 0.01);
    }

    // Build DOM
    const bar = document.createElement('div');
    bar.className = 'vt-comp-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:2px;flex-shrink:0;';

    function makeSep() {
        const s = document.createElement('div'); s.className='vt-sep'; return s;
    }
    function makeLbl(t) {
        const s = document.createElement('span'); s.className='vt-lbl'; s.textContent=t; return s;
    }
    function makeNumval(id, txt) {
        const s = document.createElement('span'); s.className='vt-numval';
        s.id=id; s.textContent=txt;
        s.style.minWidth = '36px';
        return s;
    }
    function makeNudge(txt, cb) {
        const b = document.createElement('button'); b.className='vt-nudge'; b.textContent=txt;
        b.addEventListener('mousedown', e => { e.preventDefault(); cb(); });
        return b;
    }
    function makeField(lbl, id, val, upCb, dnCb) {
        const grp = document.createElement('div'); grp.className='vt-field-grp';
        grp.append(makeLbl(lbl), makeNudge('−',dnCb), makeNumval(id, val), makeNudge('+',upCb));
        return grp;
    }

    // COMP ON/OFF button
    const onBtn = document.createElement('button');
    onBtn.className = 'vt-btn';
    onBtn.textContent = 'COMP:ON';
    onBtn.style.color = 'var(--ft-green)';
    onBtn.addEventListener('mousedown', e => {
        e.preventDefault();
        state.enabled = !state.enabled;
        chain.setEnabled(state.enabled);
        onBtn.textContent = state.enabled ? 'COMP:ON' : 'COMP:OFF';
        onBtn.style.color = state.enabled ? 'var(--ft-green)' : 'var(--ft-red)';
    });

    // GR meter (canvas, 40×10px, pure FT2 style — no fancy gradient)
    const grCanvas = document.createElement('canvas');
    grCanvas.width  = 40; grCanvas.height = 10;
    grCanvas.style.cssText = 'display:block;image-rendering:pixelated;border-top:1px solid #14142a;border-left:1px solid #14142a;border-bottom:1px solid #8888b8;border-right:1px solid #8888b8;cursor:default;';

    function drawGR() {
        const gr  = comp.reduction; // ≤ 0 dB
        const pct = Math.min(1, Math.abs(gr) / 20);
        const ctx = grCanvas.getContext('2d');
        ctx.fillStyle = '#000018'; ctx.fillRect(0,0,40,10);
        // Segmented bars like FT2 VU — just a rect for simplicity
        const W = Math.round(pct * 38);
        if (W > 0) {
            // green→yellow→red depending on amount
            ctx.fillStyle = pct < 0.5 ? '#40e040' : pct < 0.8 ? '#ffff00' : '#ff4040';
            ctx.fillRect(1, 2, W, 6);
        }
        requestAnimationFrame(drawGR);
    }
    requestAnimationFrame(drawGR);

    // Nudge steps
    const THRESH_STEP = 1, RATIO_STEP = 1, ATK_STEP = 1, REL_STEP = 10, MAKEUP_STEP = 1;

    bar.append(
        makeSep(),
        onBtn,
        makeLbl('GR'),
        grCanvas,
        makeField('THR', 'vtc-thr', state.threshold + 'dB',
            () => { state.threshold = Math.min(0,    state.threshold + THRESH_STEP); document.getElementById('vtc-thr').textContent = state.threshold+'dB'; applyComp(); },
            () => { state.threshold = Math.max(-60,  state.threshold - THRESH_STEP); document.getElementById('vtc-thr').textContent = state.threshold+'dB'; applyComp(); }),
        makeField('RAT', 'vtc-rat', state.ratio+':1',
            () => { state.ratio = Math.min(20,  state.ratio + RATIO_STEP); document.getElementById('vtc-rat').textContent = state.ratio+':1'; applyComp(); },
            () => { state.ratio = Math.max(1,   state.ratio - RATIO_STEP); document.getElementById('vtc-rat').textContent = state.ratio+':1'; applyComp(); }),
        makeField('ATK', 'vtc-atk', state.attack+'ms',
            () => { state.attack = Math.min(200,  state.attack + ATK_STEP); document.getElementById('vtc-atk').textContent = state.attack+'ms'; applyComp(); },
            () => { state.attack = Math.max(1,    state.attack - ATK_STEP); document.getElementById('vtc-atk').textContent = state.attack+'ms'; applyComp(); }),
        makeField('REL', 'vtc-rel', state.release+'ms',
            () => { state.release = Math.min(2000, state.release + REL_STEP); document.getElementById('vtc-rel').textContent = state.release+'ms'; applyComp(); },
            () => { state.release = Math.max(10,   state.release - REL_STEP); document.getElementById('vtc-rel').textContent = state.release+'ms'; applyComp(); }),
        makeField('MUP', 'vtc-mup', state.makeup+'dB',
            () => { state.makeup = Math.min(12,  state.makeup + MAKEUP_STEP); document.getElementById('vtc-mup').textContent = state.makeup+'dB'; applyComp(); },
            () => { state.makeup = Math.max(-12, state.makeup - MAKEUP_STEP); document.getElementById('vtc-mup').textContent = state.makeup+'dB'; applyComp(); }),
    );

    return bar;
}
