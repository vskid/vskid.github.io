// ============================================================
//  instruments/sampler.js — Sample slicer / melody VST  v3
//
//  Public API:
//    SAMPLER_DEFAULTS
//    synthSampler(ctx, ins, note, vol, t, dur, dest,
//                 sampleBuffers, loadSample, amp, filter)
//    previewSlice(ctx, ins, sliceIdx, sampleBuffers, masterGainNode)
//    buildSamplerPanel(instrBody, trk, deps)
//    drawSamplerWaveform(canvas, ins, sampleBuffers)
//    resizeSlices(ins, n)
//    snapToZeroCrossing(buf, f)
//    makeDragNumber(opts)
//    injectSamplerCSS()
// ============================================================

// ── CSS injection ─────────────────────────────────────────────

let _cssInjected = false;
export function injectSamplerCSS() {
    if (_cssInjected) return;
    _cssInjected = true;
    const style = document.createElement('style');
    style.textContent = `
.vdaw-drag-num-wrap { display: inline-flex; align-items: center; }
.vdaw-drag-num {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 9px; border-radius: 4px; cursor: ns-resize;
    background: var(--bg0, #0e1117);
    border: 1px solid var(--bd2, #3d5070);
    font-family: 'Share Tech Mono', monospace;
    font-size: 0.68rem; font-weight: 700;
    color: var(--acc, #00aaff);
    user-select: none; min-width: 52px;
    transition: border-color 0.1s, background 0.1s;
    position: relative;
}
.vdaw-drag-num::before {
    content: '';
    position: absolute; left: 0; top: 20%; bottom: 20%;
    width: 3px; border-radius: 0 2px 2px 0;
    background: linear-gradient(to bottom, var(--acc, #00aaff), var(--acc2, #00e5cc));
    opacity: 0.5;
}
.vdaw-drag-num:hover { border-color: var(--acc, #00aaff); background: rgba(0,170,255,0.10); }
.vdaw-drag-num:hover::before { opacity: 1; }
.vdaw-drag-num.dragging { border-color: var(--acc2,#00e5cc); background: rgba(0,229,204,0.12); cursor: ns-resize; }
.vdaw-drag-num-label { font-size: 0.48rem; color: var(--txt3,#445a72); margin-right: 2px; letter-spacing: 0.06em; }
.vdaw-drag-num-value { color: var(--acc,#00aaff); }
.vdaw-drag-num-unit  { font-size: 0.50rem; color: var(--txt3,#445a72); }
.vdaw-drag-num-input {
    width: 60px; padding: 2px 5px; border-radius: 4px;
    background: var(--bg0,#0e1117); border: 1px solid var(--acc,#00aaff);
    color: var(--txt,#dde8f8); font-family: 'Share Tech Mono',monospace;
    font-size: 0.65rem; outline: none; text-align: center;
}
.vdaw-melody-controls { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
.vdaw-melody-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vdaw-melody-row .vdaw-lbl { flex-shrink: 0; min-width: 28px; }
.vdaw-wf-zoom-bar {
    display: flex; align-items: center; gap: 4px;
    margin: 2px 0; padding: 1px 0;
}
.vdaw-wf-zoom-btn {
    font-family: 'Share Tech Mono',monospace; font-size: 0.60rem; font-weight: 700;
    padding: 1px 6px; border-radius: 3px;
    border: 1px solid var(--bd2,#3d5070); background: var(--bg2,#1d2230);
    color: var(--txt2,#7a9ab8); cursor: default; transition: all 0.1s;
    user-select: none;
}
.vdaw-wf-zoom-btn:hover { border-color: var(--acc,#00aaff); color: var(--acc,#00aaff); }
.vdaw-wf-zoom-label { font-family: 'Share Tech Mono',monospace; font-size: 0.50rem; color: var(--txt3,#445a72); min-width: 28px; }
.vdaw-wf-scroll {
    flex: 1; height: 3px; cursor: ew-resize;
    appearance: none; -webkit-appearance: none;
    background: var(--bg0,#0e1117); border-radius: 2px;
    outline: none; border: 1px solid var(--bd2,#3d5070);
}
.vdaw-wf-scroll::-webkit-slider-thumb {
    -webkit-appearance: none; width: 14px; height: 7px;
    border-radius: 2px; background: var(--acc,#00aaff);
    cursor: ew-resize;
}
.vdaw-loop-toggle, .vdaw-pingpong-toggle {
    font-family: 'Share Tech Mono',monospace; font-size: 0.52rem; font-weight: 700;
    padding: 2px 7px; border-radius: 3px;
    border: 1px solid var(--bd2,#3d5070); background: var(--bg2,#1d2230);
    color: var(--txt2,#7a9ab8); cursor: default; transition: all 0.1s; user-select: none;
}
.vdaw-loop-toggle.active { border-color: var(--acc2,#00e5cc); color: var(--acc2,#00e5cc); background: rgba(0,229,204,0.10); }
.vdaw-pingpong-toggle.active { border-color: #cc44ff; color: #cc44ff; background: rgba(204,68,255,0.10); }
`;
    document.head.appendChild(style);
}

// ── Defaults ──────────────────────────────────────────────────

export const SAMPLER_DEFAULTS = {
    src: '../../../music/amen.mp3',
    slices: 8,
    pitchShift: 0,
    melodyMode: false,
    melodyRoot: 60,
    startPoint: 0,    // 0..1 fraction of total buffer
    endPoint:   1,
    loopPoint:  0,    // loop-back position (startPoint..endPoint), used when loopEnabled
    loopEnabled: false,
    pingPong:   false,
    crossfade:  0,    // seconds
    wfZoom:     1,    // 1 = full view; 2 = 2x zoom, etc. up to 32
    wfScroll:   0,    // 0..1 pan within zoomed view
};

// ── Helpers ───────────────────────────────────────────────────

// Build a reversed copy of buf between [startSamp, endSamp)
function _makeReversedBuf(ctx, buf, startSamp, endSamp) {
    const len = endSamp - startSamp;
    if (len <= 0) return null;
    const out = ctx.createBuffer(buf.numberOfChannels, len, ctx.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const src = buf.getChannelData(ch);
        const dst = out.getChannelData(ch);
        for (let i = 0; i < len; i++) dst[i] = src[endSamp - 1 - i];
    }
    return out;
}

// Build a buffer that contains one full forward+reverse cycle for ping-pong looping.
// The AudioBufferSourceNode can then loop this natively for perfect jitter-free ping-pong.
function _makePingPongCycleBuf(ctx, buf, loopStartSec, loopEndSec, rate) {
    const sr = ctx.sampleRate;
    const s  = Math.round(loopStartSec * sr);
    const e  = Math.round(loopEndSec   * sr);
    const len = e - s;
    if (len <= 0) return null;
    // cycle = forward region + reversed region
    const cycleLen = len * 2;
    const out = ctx.createBuffer(buf.numberOfChannels, cycleLen, sr);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const src = buf.getChannelData(ch);
        const dst = out.getChannelData(ch);
        for (let i = 0; i < len; i++) dst[i]            = src[s + i];
        for (let i = 0; i < len; i++) dst[len + i]      = src[e - 1 - i];
    }
    return out;
}

// ── Audio engine ──────────────────────────────────────────────

/**
 * synthSampler  —  schedule sampler playback
 *
 * @param {AudioContext}  ctx
 * @param {object}        ins          instrument state
 * @param {object}        note         { pitch, velocity, ... }
 * @param {number}        vol          0..1
 * @param {number}        t            AudioContext scheduled time
 * @param {number}        dur          gate duration in seconds
 * @param {AudioNode}     dest
 * @param {object}        sampleBuffers
 * @param {Function}      loadSample
 * @param {object|null}   amp          {attack,decay,sustain,release} (ms / %)
 * @param {object|null}   filter       {type,cutoff,resonance,envDepth,...}
 */
export function synthSampler(ctx, ins, note, vol, t, dur, dest,
                              sampleBuffers, loadSample, amp, filter) {
    const src_name = ins.src || 'amen.wav';
    const buf      = sampleBuffers[src_name];
    if (!buf) { loadSample(src_name); return; }

    // ── Build filter node ─────────────────────────────────────
    let endpoint = dest;
    if (filter) {
        const fNode = ctx.createBiquadFilter();
        fNode.type            = filter.type      || 'lowpass';
        fNode.frequency.value = filter.cutoff    || 8000;
        fNode.Q.value         = filter.resonance || 1;
        if (filter.envDepth && filter.envDepth !== 0) {
            const depth = filter.envDepth / 100;
            const atk   = (filter.attack  || 10)  / 1000;
            const dec   = (filter.decay   || 100) / 1000;
            const sus   = (filter.sustain || 70)  / 100;
            const rel   = (filter.release || 300) / 1000;
            const base  = filter.cutoff || 8000;
            const peak  = base + depth * (depth > 0 ? (20000 - base) : base);
            fNode.frequency.setValueAtTime(base, t);
            fNode.frequency.linearRampToValueAtTime(peak, t + atk);
            fNode.frequency.linearRampToValueAtTime(base + (peak - base) * sus, t + atk + dec);
            const ne = t + Math.max(atk + dec + 0.001, dur - rel);
            fNode.frequency.setValueAtTime(base + (peak - base) * sus, ne);
            fNode.frequency.linearRampToValueAtTime(base, ne + rel);
        }
        fNode.connect(dest);
        endpoint = fNode;
    }

    // ── Build amp envelope ────────────────────────────────────
    const gNode = ctx.createGain();
    gNode.connect(endpoint);

    const totalDur = dur; // gate length
    if (amp) {
        const atk = (amp.attack  || 10)  / 1000;
        const dec = (amp.decay   || 100) / 1000;
        const sus = (amp.sustain ?? 70)  / 100 * vol;
        const rel = (amp.release || 300) / 1000;
        gNode.gain.setValueAtTime(0.0001, t);
        gNode.gain.linearRampToValueAtTime(vol,  t + atk);
        gNode.gain.linearRampToValueAtTime(sus,  t + atk + dec);
        gNode.gain.setValueAtTime(sus, t + Math.max(atk + dec + 0.001, totalDur - rel));
        gNode.gain.linearRampToValueAtTime(0.0001, t + totalDur + rel);
    } else {
        const fade = Math.min(0.008, totalDur * 0.05);
        gNode.gain.setValueAtTime(vol, t);
        gNode.gain.setValueAtTime(vol, t + totalDur - fade);
        gNode.gain.linearRampToValueAtTime(0.0001, t + totalDur + fade);
    }

    if (ins.melodyMode) {
        _scheduleMelody(ctx, ins, buf, note, t, totalDur, gNode);
    } else {
        _scheduleSlicer(ctx, ins, buf, note, t, totalDur, gNode);
    }
}

// ── Melody scheduler ──────────────────────────────────────────

function _scheduleMelody(ctx, ins, buf, note, t, gateDur, dest) {
    const root      = ins.melodyRoot || 60;
    const semitones = (note.pitch - root) + (ins.pitchShift || 0);
    const rate      = Math.pow(2, semitones / 12);

    const startFrac = ins.startPoint  ?? 0;
    const endFrac   = ins.endPoint    ?? 1;
    const loopFrac  = ins.loopPoint   ?? startFrac;

    const startSec  = startFrac * buf.duration;
    const endSec    = endFrac   * buf.duration;
    const loopSec   = loopFrac  * buf.duration;

    // Duration (at playback rate) from startPoint to endPoint
    const firstPassDur = (endSec - startSec) / rate;

    if (!ins.loopEnabled || firstPassDur <= 0.001) {
        // ── No loop: play straight through start→end, capped by gate ──
        const playDur = Math.min(gateDur, firstPassDur);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        src.connect(dest);
        src.start(t, startSec, playDur + 0.02);
        src.stop(t + playDur + 0.03);
        return;
    }

    // ── Loop enabled ──────────────────────────────────────────
    // Strategy:
    //   1. First play: startPoint → endPoint  (plays once)
    //   2. Then loop:  loopPoint  → endPoint  (looped natively)
    //
    // For ping-pong: bake a forward+reverse cycle buffer and loop that.
    // For regular:   use native AudioBufferSourceNode.loop with loopStart/loopEnd.
    //
    // Gate is controlled purely by the amp envelope in the caller.

    const loopRegionDur = (endSec - loopSec) / rate;
    if (loopRegionDur < 0.001) return; // degenerate

    // ── Step 1: play startPoint → endPoint once ───────────────
    {
        const src1 = ctx.createBufferSource();
        src1.buffer = buf;
        src1.playbackRate.value = rate;
        src1.connect(dest);
        src1.start(t, startSec, firstPassDur + 0.005);
        src1.stop(t + firstPassDur + 0.01);
    }

    // ── Step 2: looping part starts at t + firstPassDur ───────
    const loopStartTime = t + firstPassDur;
    const xfade = Math.max(0, ins.crossfade || 0);

    if (ins.pingPong) {
        // Build a forward+reverse cycle buffer for the loop region
        const cycleBuf = _makePingPongCycleBuf(ctx, buf, loopSec, endSec, rate);
        if (!cycleBuf) return;
        const sr = ctx.sampleRate;
        const cycleLen = (Math.round(endSec * sr) - Math.round(loopSec * sr)) * 2;
        const cycleDurSec = cycleLen / sr;  // raw, before rate adjustment

        const src2 = ctx.createBufferSource();
        src2.buffer = cycleBuf;
        src2.playbackRate.value = rate;
        src2.loop = true;
        src2.loopStart = 0;
        src2.loopEnd   = cycleDurSec;
        src2.connect(dest);
        src2.start(loopStartTime);
        src2.stop(t + gateDur + 0.05 + (amp_relPeek || 0));
    } else {
        // Regular forward loop using native loopStart / loopEnd
        const src2 = ctx.createBufferSource();
        src2.buffer = buf;
        src2.playbackRate.value = rate;
        src2.loop = true;
        src2.loopStart = loopSec;
        src2.loopEnd   = endSec;
        src2.connect(dest);
        src2.start(loopStartTime, loopSec);
        src2.stop(t + gateDur + 0.05);
    }
}

// amp_relPeek is a tiny helper — we can't easily read amp.release from inside
// _scheduleMelody, but it doesn't matter much; we just add a small tail.
const amp_relPeek = 0.5; // conservative extra seconds after gate

// ── Slicer scheduler ─────────────────────────────────────────

function _scheduleSlicer(ctx, ins, buf, note, t, gateDur, dest) {
    const slices     = ins.slices || 8;
    const sliceNotes = ins.sliceNotes || Array.from({ length: slices }, (_, i) => 36 + i);
    const sliceIdx   = sliceNotes.findIndex(n => n === note.pitch);
    if (sliceIdx < 0) return;

    const sp       = ins.slicePoints?.[sliceIdx];
    const startSec = sp ? sp.start * buf.duration : sliceIdx * (buf.duration / slices);
    const sliceDur = sp ? (sp.end - sp.start) * buf.duration : buf.duration / slices;
    const rate     = Math.pow(2, (ins.pitchShift || 0) / 12);
    const playDur  = Math.min(gateDur, sliceDur / rate);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(dest);
    src.start(t, startSec, playDur + 0.02);
    src.stop(t + playDur + 0.03);
}

// ── Slice preview ─────────────────────────────────────────────

export function previewSlice(ctx, ins, sliceIdx, sampleBuffers, masterGainNode) {
    const buf = sampleBuffers[ins.src]; if (!buf) return;

    if (ins.melodyMode) {
        const src = ctx.createBufferSource(); src.buffer = buf;
        src.playbackRate.value = Math.pow(2, (ins.pitchShift || 0) / 12);
        const g = ctx.createGain(); g.gain.value = 0.7;
        src.connect(g); g.connect(masterGainNode || ctx.destination);
        const startSec = (ins.startPoint ?? 0) * buf.duration;
        const durSec   = Math.min(3.0, ((ins.endPoint ?? 1) - (ins.startPoint ?? 0)) * buf.duration);
        src.start(ctx.currentTime, startSec, durSec);
        return;
    }

    const sp = ins.slicePoints?.[sliceIdx]; if (!sp) return;
    const src = ctx.createBufferSource(); src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (ins.pitchShift || 0) / 12);
    const g = ctx.createGain(); g.gain.value = 0.7;
    src.connect(g); g.connect(masterGainNode || ctx.destination);
    src.start(ctx.currentTime, sp.start * buf.duration, (sp.end - sp.start) * buf.duration);
}

// ── Slice management ──────────────────────────────────────────

export function resizeSlices(ins, newCount) {
    const old  = ins.slicePoints || [];
    const oldN = ins.sliceNotes  || [];
    const cur  = old.length;
    if (newCount === cur) return;
    if (newCount < cur) {
        const kept = old.slice(0, newCount).map(sp => ({ ...sp }));
        kept[newCount - 1] = { start: kept[newCount - 1].start, end: 1.0 };
        ins.slicePoints = kept;
        ins.sliceNotes  = oldN.slice(0, newCount);
    } else {
        const tailStart = cur > 0 ? old[cur - 1].end : 0;
        const added = newCount - cur;
        const pts   = old.map(sp => ({ ...sp }));
        const notes = [...oldN];
        for (let i = 0; i < added; i++) {
            pts.push({
                start: tailStart + (i / added) * (1 - tailStart),
                end:   tailStart + ((i + 1) / added) * (1 - tailStart),
            });
            notes.push(36 + cur + i);
        }
        ins.slicePoints = pts;
        ins.sliceNotes  = notes;
    }
    ins.slices = newCount;
}

export function snapToZeroCrossing(buf, targetFrac) {
    if (!buf) return targetFrac;
    const data = buf.getChannelData(0), total = data.length;
    const target  = Math.round(targetFrac * total);
    const window_ = Math.round(total * 0.01);
    let best = target, bestDist = Infinity;
    for (let i = Math.max(1, target - window_); i <= Math.min(total - 1, target + window_); i++) {
        if ((data[i-1] <= 0 && data[i] >= 0) || (data[i-1] >= 0 && data[i] <= 0)) {
            const dist = Math.abs(i - target);
            if (dist < bestDist) { bestDist = dist; best = i; }
        }
    }
    return best / total;
}

// ── Zoom helpers ──────────────────────────────────────────────

// Convert a canvas-local fraction [0..1] → global buffer fraction, given zoom+scroll
function _canvasToGlobal(localFrac, zoom, scroll) {
    const viewWidth = 1 / zoom;
    const viewStart = scroll * (1 - viewWidth);
    return viewStart + localFrac * viewWidth;
}

// Convert a global buffer fraction → canvas-local fraction (may be outside [0,1])
function _globalToCanvas(globalFrac, zoom, scroll) {
    const viewWidth = 1 / zoom;
    const viewStart = scroll * (1 - viewWidth);
    return (globalFrac - viewStart) / viewWidth;
}

// ── Waveform renderer ─────────────────────────────────────────

export function drawSamplerWaveform(canvas, ins, sampleBuffers) {
    const buf = sampleBuffers[ins.src];
    const gfx = canvas.getContext('2d');
    const W = canvas.width  = canvas.offsetWidth  || 240;
    const H = canvas.height = canvas.height || 80;

    gfx.fillStyle = '#0e1117'; gfx.fillRect(0, 0, W, H);

    if (!buf) {
        gfx.fillStyle = '#445a72';
        gfx.font = '700 10px "Share Tech Mono",monospace';
        gfx.textAlign = 'center';
        gfx.fillText('No sample loaded', W / 2, H / 2 + 4);
        return;
    }

    const zoom   = ins.wfZoom   || 1;
    const scroll = ins.wfScroll ?? 0;

    // visible window in global fractions
    const viewWidth = 1 / zoom;
    const viewStart = scroll * (1 - viewWidth);
    const viewEnd   = viewStart + viewWidth;

    // Waveform — only render the visible window
    const data  = buf.getChannelData(0);
    const total = data.length;
    const sampleStart = Math.floor(viewStart * total);
    const sampleEnd   = Math.ceil(viewEnd   * total);
    const step = Math.max(1, Math.ceil((sampleEnd - sampleStart) / W));

    gfx.strokeStyle = 'rgba(0,170,255,0.75)'; gfx.lineWidth = 1; gfx.beginPath();
    for (let x = 0; x < W; x++) {
        const si = sampleStart + Math.floor(x * (sampleEnd - sampleStart) / W);
        let mn = 1, mx = -1;
        for (let j = 0; j < step; j++) {
            const s = data[si + j] || 0;
            if (s < mn) mn = s; if (s > mx) mx = s;
        }
        const y1 = ((1 - mx) / 2) * H, y2 = ((1 - mn) / 2) * H;
        if (x === 0) gfx.moveTo(x, y1); else gfx.lineTo(x, y1);
        gfx.lineTo(x, y2);
    }
    gfx.stroke();

    // Helper: global fraction → canvas x pixel
    const gToX = f => _globalToCanvas(f, zoom, scroll) * W;

    if (ins.melodyMode) {
        const spG = ins.startPoint ?? 0;
        const epG = ins.endPoint   ?? 1;
        const lpG = ins.loopPoint  ?? spG;

        const spX = gToX(spG), epX = gToX(epG), lpX = gToX(lpG);

        // Darken outside active region (clipped to canvas)
        gfx.fillStyle = 'rgba(0,0,0,0.50)';
        if (spX > 0)  gfx.fillRect(0,    0, Math.min(spX, W), H);
        if (epX < W)  gfx.fillRect(Math.max(epX, 0), 0, W - Math.max(epX, 0), H);

        // Active region tint
        const rL = Math.max(0, spX), rR = Math.min(W, epX);
        if (rR > rL) { gfx.fillStyle = 'rgba(0,170,255,0.07)'; gfx.fillRect(rL, 0, rR - rL, H); }

        // Loop region tint
        if (ins.loopEnabled) {
            const lL = Math.max(0, lpX), lR = Math.min(W, epX);
            if (lR > lL) { gfx.fillStyle = 'rgba(0,229,204,0.10)'; gfx.fillRect(lL, 0, lR - lL, H); }
        }

        // Markers (only draw if in view)
        if (spX >= -20 && spX <= W + 20) _drawMarker(gfx, spX, H, '#00cc77', 'S', 'right');
        if (epX >= -20 && epX <= W + 20) _drawMarker(gfx, epX, H, '#ff3344', 'E', 'left');
        if (ins.loopEnabled && lpX >= -20 && lpX <= W + 20) _drawMarker(gfx, lpX, H, '#00e5cc', 'L', 'right');
    } else {
        // Slicer overlays — only visible slices
        (ins.slicePoints || []).forEach((sp, i) => {
            const x1 = gToX(sp.start), x2 = gToX(sp.end);
            if (x2 < 0 || x1 > W) return;
            const cx1 = Math.max(0, x1), cx2 = Math.min(W, x2);
            gfx.fillStyle = i % 2 === 0 ? 'rgba(0,170,255,0.07)' : 'rgba(0,229,204,0.07)';
            gfx.fillRect(cx1, 0, cx2 - cx1, H);
        });
        (ins.slicePoints || []).slice(0, -1).forEach(sp => {
            const x = gToX(sp.end); if (x < 0 || x > W) return;
            gfx.strokeStyle = 'rgba(0,229,204,0.25)'; gfx.lineWidth = 5;
            gfx.beginPath(); gfx.moveTo(x, 0); gfx.lineTo(x, H); gfx.stroke();
            gfx.strokeStyle = '#00e5cc'; gfx.lineWidth = 1.5;
            gfx.beginPath(); gfx.moveTo(x, 0); gfx.lineTo(x, H); gfx.stroke();
            gfx.fillStyle = '#00e5cc';
            gfx.beginPath();
            gfx.moveTo(x, 4); gfx.lineTo(x + 4, 9); gfx.lineTo(x, 14);
            gfx.lineTo(x - 4, 9); gfx.closePath(); gfx.fill();
        });
        gfx.font = '600 8px "Share Tech Mono",monospace'; gfx.textAlign = 'center';
        (ins.slicePoints || []).forEach((sp, i) => {
            const cx = gToX((sp.start + sp.end) / 2);
            if (cx < 0 || cx > W) return;
            gfx.fillStyle = 'rgba(255,255,255,0.35)';
            gfx.fillText(i + 1, cx, H - 4);
        });
    }

    // Zoom indicator bar at bottom
    if (zoom > 1) {
        const bh = 3, by = H - bh;
        gfx.fillStyle = 'rgba(255,255,255,0.06)'; gfx.fillRect(0, by, W, bh);
        const bx = viewStart * W, bw = viewWidth * W;
        gfx.fillStyle = 'rgba(0,170,255,0.5)'; gfx.fillRect(bx, by, bw, bh);
    }
}

function _drawMarker(gfx, x, H, color, label, flagSide) {
    gfx.strokeStyle = color + '44'; gfx.lineWidth = 5;
    gfx.beginPath(); gfx.moveTo(x, 0); gfx.lineTo(x, H); gfx.stroke();
    gfx.strokeStyle = color; gfx.lineWidth = 1.5;
    gfx.beginPath(); gfx.moveTo(x, 0); gfx.lineTo(x, H); gfx.stroke();
    const fw = 14, fh = 12, fy = 3;
    gfx.fillStyle = color;
    gfx.beginPath();
    if (flagSide === 'right') {
        gfx.moveTo(x, fy); gfx.lineTo(x + fw, fy + fh * 0.4);
        gfx.lineTo(x + fw, fy + fh * 0.6); gfx.lineTo(x, fy + fh);
    } else {
        gfx.moveTo(x, fy); gfx.lineTo(x - fw, fy + fh * 0.4);
        gfx.lineTo(x - fw, fy + fh * 0.6); gfx.lineTo(x, fy + fh);
    }
    gfx.closePath(); gfx.fill();
    gfx.fillStyle = '#000'; gfx.font = '700 7px "Share Tech Mono",monospace'; gfx.textAlign = 'center';
    gfx.fillText(label, flagSide === 'right' ? x + fw * 0.55 : x - fw * 0.55, fy + fh * 0.72);
}

// ── FL-style drag-number widget ───────────────────────────────

export function makeDragNumber(opts) {
    const { min = 0, max = 100, value = 0, step = 1, unit = '', label = '', onChange } = opts;
    injectSamplerCSS();

    const wrap = document.createElement('div');
    wrap.className = 'vdaw-drag-num-wrap';

    const display = document.createElement('div');
    display.className = 'vdaw-drag-num';
    display.title = 'Drag up/down · Double-click to type · Scroll wheel';

    if (label) {
        const lbl = document.createElement('span');
        lbl.className = 'vdaw-drag-num-label';
        lbl.textContent = label;
        display.appendChild(lbl);
    }
    const valSpan = document.createElement('span');
    valSpan.className = 'vdaw-drag-num-value';
    display.appendChild(valSpan);
    if (unit) {
        const u = document.createElement('span');
        u.className = 'vdaw-drag-num-unit'; u.textContent = unit;
        display.appendChild(u);
    }
    wrap.appendChild(display);

    let current = Math.max(min, Math.min(max, value));
    let isDragging = false;
    function fmt(v) { return step < 1 ? v.toFixed(1) : String(Math.round(v)); }
    function set(v, notify = true) {
        current = Math.max(min, Math.min(max, Math.round(v / step) * step));
        valSpan.textContent = fmt(current);
        if (notify && onChange) onChange(current);
    }
    set(current, false);

    let dragStartY = 0, dragStartVal = 0;
    function onMove(e) {
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        const delta = dragStartY - cy;
        if (!isDragging && Math.abs(delta) > 2) {
            isDragging = true; display.classList.add('dragging');
            document.body.style.cursor = 'ns-resize';
        }
        if (isDragging) set(dragStartVal + delta * (max - min) / 120);
    }
    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend',  onUp);
        setTimeout(() => { isDragging = false; display.classList.remove('dragging'); document.body.style.cursor = ''; }, 0);
    }
    display.addEventListener('mousedown', e => {
        e.preventDefault(); dragStartY = e.clientY; dragStartVal = current;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
    display.addEventListener('touchstart', e => {
        e.preventDefault(); dragStartY = e.touches[0].clientY; dragStartVal = current;
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend',  onUp);
    }, { passive: false });
    display.addEventListener('dblclick', e => {
        if (isDragging) return; e.stopPropagation();
        const input = document.createElement('input');
        input.type = 'number'; input.min = min; input.max = max; input.step = step;
        input.value = current; input.className = 'vdaw-drag-num-input';
        wrap.replaceChild(input, display);
        input.focus(); input.select();
        function commit() {
            const v = parseFloat(input.value);
            wrap.replaceChild(display, input);
            if (!isNaN(v)) set(v);
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', ke => {
            if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
            if (ke.key === 'Escape') wrap.replaceChild(display, input);
        });
    });
    display.addEventListener('wheel', e => { e.preventDefault(); set(current - Math.sign(e.deltaY) * step); }, { passive: false });

    wrap.setValue = v => set(v, false);
    wrap.getValue = () => current;
    return wrap;
}

// ── Panel builder ─────────────────────────────────────────────

export function buildSamplerPanel(instrBody, trk, deps) {
    injectSamplerCSS();
    const { actx, sampleBuffers, masterGain, loadSample, KNOWN_SAMPLES,
            noteNameOf, markDirty, getActx } = deps;
    const ins    = trk.instr;
    const slices = ins.slices || 8;

    // defaults
    if (!ins.sliceNotes  || ins.sliceNotes.length  !== slices)
        ins.sliceNotes  = Array.from({ length: slices }, (_, i) => 36 + i);
    if (!ins.slicePoints || ins.slicePoints.length !== slices)
        ins.slicePoints = Array.from({ length: slices }, (_, i) => ({
            start: i / slices, end: (i + 1) / slices,
        }));
    if (!ins.src)                ins.src         = KNOWN_SAMPLES[0]?.src || '';
    if (ins.melodyMode == null)  ins.melodyMode  = false;
    if (!ins.melodyRoot)         ins.melodyRoot  = 60;
    if (ins.startPoint == null)  ins.startPoint  = 0;
    if (ins.endPoint   == null)  ins.endPoint    = 1;
    if (ins.loopPoint  == null)  ins.loopPoint   = ins.startPoint;
    if (ins.loopEnabled == null) ins.loopEnabled = false;
    if (ins.pingPong   == null)  ins.pingPong    = false;
    if (ins.crossfade  == null)  ins.crossfade   = 0;
    if (ins.wfZoom     == null)  ins.wfZoom      = 1;
    if (ins.wfScroll   == null)  ins.wfScroll    = 0;

    const optionHTML = KNOWN_SAMPLES.map(s =>
        `<option value="${s.src}"${ins.src === s.src ? ' selected' : ''}>${s.label}</option>`
    ).join('');
    const melodyRootOptions = Array.from({ length: 88 }, (_, i) => {
        const m = 21 + i;
        return `<option value="${m}"${m === ins.melodyRoot ? ' selected' : ''}>${noteNameOf(m)}</option>`;
    }).join('');

    instrBody.innerHTML = `
    <div style="font-family:'Share Tech Mono',monospace;font-size:0.44rem;color:var(--acc2);margin-bottom:3px;letter-spacing:0.06em;">↑ AMP ENVELOPE &amp; FILTER apply to this instrument</div>
    <div class="vdaw-sampler-mode-row">
      <button class="vdaw-sampler-mode-btn${!ins.melodyMode ? ' active' : ''}" id="vdaw-smp-slice">✂ SLICER</button>
      <button class="vdaw-sampler-mode-btn${ins.melodyMode  ? ' active' : ''}" id="vdaw-smp-melody">♪ MELODY</button>
    </div>
    <div class="vdaw-row-gap" style="margin-bottom:3px;flex-wrap:wrap;gap:4px;">
      <span class="vdaw-lbl">SAMPLE</span>
      <select id="vdaw-sampler-src" style="font-family:'Share Tech Mono',monospace;font-size:0.55rem;font-weight:700;color:var(--txt);background:var(--bg2);border:1px solid var(--bd2);border-radius:4px;padding:2px 5px;outline:none;flex:1;min-width:0;max-width:160px;">${optionHTML}</select>
      <label style="font-family:'Share Tech Mono',monospace;font-size:0.52rem;font-weight:700;color:var(--acc2);border:1px solid var(--bd2);border-radius:4px;padding:2px 6px;cursor:pointer;background:var(--bg2);white-space:nowrap;">
        📁 FILE<input type="file" id="vdaw-sampler-file" accept="audio/*" style="display:none;">
      </label>
    </div>
    <div style="position:relative;">
      <canvas class="vdaw-sampler-waveform" id="vdaw-sampler-wf" height="80" style="width:100%;cursor:crosshair;display:block;"></canvas>
    </div>
    <div class="vdaw-wf-zoom-bar">
      <button class="vdaw-wf-zoom-btn" id="vdaw-wf-zout">−</button>
      <span class="vdaw-wf-zoom-label" id="vdaw-wf-zlbl">${ins.wfZoom || 1}×</span>
      <button class="vdaw-wf-zoom-btn" id="vdaw-wf-zin">+</button>
      <input type="range" class="vdaw-wf-scroll" id="vdaw-wf-scroll" min="0" max="1" step="0.001"
             value="${ins.wfScroll || 0}" ${(ins.wfZoom || 1) <= 1 ? 'disabled' : ''}>
      <button class="vdaw-wf-zoom-btn" id="vdaw-wf-zreset" title="Reset zoom">⌂</button>
    </div>
    <div id="vdaw-sampler-slices-area">
      ${!ins.melodyMode ? `
        <div class="vdaw-sampler-slices" id="vdaw-sampler-slices"></div>
        <div class="vdaw-sampler-slice-ctrl">
          <span class="vdaw-lbl">SLICES</span>
          <button class="vdaw-slice-count-btn" id="vdaw-slices-dn">&#8722;</button>
          <span class="vdaw-slice-count-val" id="vdaw-slices-val">${slices}</span>
          <button class="vdaw-slice-count-btn" id="vdaw-slices-up">&#43;</button>
        </div>` : `
        <div class="vdaw-melody-controls">
          <div class="vdaw-melody-row">
            <span class="vdaw-lbl">ROOT</span>
            <select id="vdaw-melody-root" style="font-family:'Share Tech Mono',monospace;font-size:0.55rem;font-weight:700;color:var(--txt);background:var(--bg2);border:1px solid var(--bd2);border-radius:4px;padding:2px 5px;outline:none;">${melodyRootOptions}</select>
          </div>
          <div class="vdaw-melody-row">
            <button class="vdaw-loop-toggle${ins.loopEnabled ? ' active' : ''}" id="vdaw-loop-toggle">⟳ LOOP</button>
            <button class="vdaw-pingpong-toggle${ins.pingPong ? ' active' : ''}" id="vdaw-pingpong-toggle"
              style="${!ins.loopEnabled ? 'opacity:0.35;pointer-events:none;' : ''}">⇌ PING-PONG</button>
          </div>
          <div class="vdaw-melody-row">
            <span class="vdaw-lbl" style="${!ins.loopEnabled ? 'opacity:0.35;' : ''}">XFADE</span>
            <div id="vdaw-xfade-ctrl"></div>
          </div>
        </div>
        <div style="font-family:'Share Tech Mono',monospace;font-size:0.42rem;color:var(--txt3);margin-top:3px;line-height:1.7;">
          Drag <span style="color:#00cc77">▶S</span> start ·
          <span style="color:#ff3344">◀E</span> end ·
          <span style="color:#00e5cc">▶L</span> loop point
        </div>`}
    </div>
    <div class="vdaw-sampler-note" id="vdaw-sampler-note">${
        ins.melodyMode
            ? 'Melody · root=' + noteNameOf(ins.melodyRoot) + ' · piano pitch shifts speed'
            : 'Dbl-click: add slice · Drag marker: move · Click: preview'
    }</div>
    <div class="vdaw-sampler-pitch-row" style="margin-top:6px;display:flex;align-items:center;gap:8px;">
      <span class="vdaw-lbl" style="flex-shrink:0;">PITCH</span>
    </div>`;

    const wfCanvas = instrBody.querySelector('#vdaw-sampler-wf');
    const pitchRow = instrBody.querySelector('.vdaw-sampler-pitch-row');
    const redraw   = () => drawSamplerWaveform(wfCanvas, ins, sampleBuffers);

    // ── Pitch drag-number ────────────────────────────────────
    pitchRow.appendChild(makeDragNumber({
        min: -24, max: 24, value: ins.pitchShift || 0, step: 1, unit: ' st',
        onChange: v => { ins.pitchShift = v; markDirty(); },
    }));

    // ── Zoom controls ────────────────────────────────────────
    const zlbl      = instrBody.querySelector('#vdaw-wf-zlbl');
    const scrollEl  = instrBody.querySelector('#vdaw-wf-scroll');
    const ZOOM_STEPS = [1, 2, 4, 8, 16, 32];

    function applyZoom(newZoom, newScroll) {
        newZoom = Math.max(1, Math.min(32, newZoom));
        // clamp scroll so view doesn't go past end
        const viewWidth = 1 / newZoom;
        newScroll = Math.max(0, Math.min(1, newScroll ?? ins.wfScroll));
        // make sure viewStart+viewWidth <= 1
        if (newScroll * (1 - viewWidth) + viewWidth > 1.0001) newScroll = 1;
        ins.wfZoom = newZoom; ins.wfScroll = newScroll;
        zlbl.textContent = newZoom + '×';
        scrollEl.disabled = newZoom <= 1;
        scrollEl.value = newScroll;
        redraw();
    }

    instrBody.querySelector('#vdaw-wf-zin').addEventListener('click', () => {
        const zi = ZOOM_STEPS.indexOf(ins.wfZoom);
        applyZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, zi + 1)], ins.wfScroll);
    });
    instrBody.querySelector('#vdaw-wf-zout').addEventListener('click', () => {
        const zi = ZOOM_STEPS.indexOf(ins.wfZoom);
        applyZoom(ZOOM_STEPS[Math.max(0, zi - 1)], ins.wfScroll);
    });
    instrBody.querySelector('#vdaw-wf-zreset').addEventListener('click', () => applyZoom(1, 0));
    scrollEl.addEventListener('input', e => applyZoom(ins.wfZoom, parseFloat(e.target.value)));

    // Scroll wheel on canvas = zoom in/out; Shift+scroll = pan
    wfCanvas.addEventListener('wheel', e => {
        e.preventDefault();
        if (e.shiftKey || ins.wfZoom <= 1 && e.deltaX) {
            // pan
            const delta = (e.deltaX || e.deltaY) / 500;
            applyZoom(ins.wfZoom, ins.wfScroll + delta);
        } else {
            // zoom toward cursor position
            const rect  = wfCanvas.getBoundingClientRect();
            const cx    = (e.clientX - rect.left) / wfCanvas.offsetWidth; // cursor 0..1 in canvas
            const zoom  = ins.wfZoom, scroll = ins.wfScroll;
            const viewWidth = 1 / zoom;
            const viewStart = scroll * (1 - viewWidth);
            const cursorGlobal = viewStart + cx * viewWidth; // global frac under cursor

            const zi    = ZOOM_STEPS.indexOf(zoom);
            const newZi = e.deltaY < 0
                ? Math.min(ZOOM_STEPS.length - 1, zi + 1)
                : Math.max(0, zi - 1);
            const newZoom    = ZOOM_STEPS[newZi];
            const newView    = 1 / newZoom;
            // keep cursor over same global position
            const newViewStart = cursorGlobal - cx * newView;
            const maxStart     = 1 - newView;
            const newScroll    = maxStart <= 0 ? 0 : Math.max(0, Math.min(1, newViewStart / maxStart));
            applyZoom(newZoom, newScroll);
        }
    }, { passive: false });

    // ── Melody-mode controls ─────────────────────────────────
    if (ins.melodyMode) {
        const xfadeCtrl = makeDragNumber({
            min: 0, max: 500, value: Math.round((ins.crossfade || 0) * 1000),
            step: 5, unit: ' ms',
            onChange: v => { ins.crossfade = v / 1000; markDirty(); },
        });
        if (!ins.loopEnabled) xfadeCtrl.style.opacity = '0.35';
        instrBody.querySelector('#vdaw-xfade-ctrl')?.appendChild(xfadeCtrl);

        instrBody.querySelector('#vdaw-loop-toggle').addEventListener('click', () => {
            ins.loopEnabled = !ins.loopEnabled;
            buildSamplerPanel(instrBody, trk, deps); markDirty();
        });
        instrBody.querySelector('#vdaw-pingpong-toggle').addEventListener('click', () => {
            if (!ins.loopEnabled) return;
            ins.pingPong = !ins.pingPong;
            buildSamplerPanel(instrBody, trk, deps); markDirty();
        });
        instrBody.querySelector('#vdaw-melody-root')?.addEventListener('change', e => {
            ins.melodyRoot = parseInt(e.target.value); markDirty();
        });
    }

    // ── Mode toggles ─────────────────────────────────────────
    instrBody.querySelector('#vdaw-smp-slice').addEventListener('click', () => {
        ins.melodyMode = false; buildSamplerPanel(instrBody, trk, deps); markDirty();
    });
    instrBody.querySelector('#vdaw-smp-melody').addEventListener('click', () => {
        ins.melodyMode = true; buildSamplerPanel(instrBody, trk, deps); markDirty();
    });

    // ── Sample source ────────────────────────────────────────
    instrBody.querySelector('#vdaw-sampler-src').addEventListener('change', e => {
        ins.src = e.target.value; sampleBuffers[ins.src] = null;
        wfCanvas.getContext('2d').clearRect(0, 0, wfCanvas.width, wfCanvas.height);
        if (actx) loadSample(ins.src).then(b => { if (b) redraw(); });
        markDirty();
    });
    instrBody.querySelector('#vdaw-sampler-file').addEventListener('change', async e => {
        const file = e.target.files[0]; if (!file) return;
        try {
            const buf = await getActx().decodeAudioData(await file.arrayBuffer());
            const key = '__local__:' + file.name;
            sampleBuffers[key] = buf; ins.src = key;
            const sel = instrBody.querySelector('#vdaw-sampler-src');
            if (!sel.querySelector(`option[value="${key}"]`)) {
                const opt = document.createElement('option');
                opt.value = key; opt.textContent = '📁 ' + file.name; sel.appendChild(opt);
            }
            sel.value = key;
            ins.startPoint = 0; ins.endPoint = 1; ins.loopPoint = 0;
            ins.wfZoom = 1; ins.wfScroll = 0;
            if (!ins.melodyMode)
                ins.slicePoints = Array.from({ length: ins.slices || 8 }, (_, i) => ({
                    start: i / (ins.slices || 8), end: (i + 1) / (ins.slices || 8),
                }));
            redraw(); markDirty();
        } catch (err) { console.warn('[sampler] file load failed', err); }
    });

    // ── Slice count ──────────────────────────────────────────
    if (!ins.melodyMode) {
        instrBody.querySelector('#vdaw-slices-dn').addEventListener('click', () => {
            resizeSlices(ins, Math.max(1, ins.slices - 1));
            buildSamplerPanel(instrBody, trk, deps); markDirty();
        });
        instrBody.querySelector('#vdaw-slices-up').addEventListener('click', () => {
            resizeSlices(ins, Math.min(32, ins.slices + 1));
            buildSamplerPanel(instrBody, trk, deps); markDirty();
        });
    }

    // ── Waveform interaction ─────────────────────────────────
    let wfDrag = { active: false, type: null, markerIdx: -1 };

    // Convert a mouse event to global buffer fraction, accounting for zoom/scroll
    function evToGlobal(e) {
        const r   = wfCanvas.getBoundingClientRect();
        const loc = Math.max(0, Math.min(1, (e.clientX - r.left) / wfCanvas.offsetWidth));
        return _canvasToGlobal(loc, ins.wfZoom || 1, ins.wfScroll ?? 0);
    }

    const HIT_PX = 10; // pixels
    function hitMelodyMarker(gfrac) {
        if (!ins.melodyMode) return null;
        const zoom = ins.wfZoom || 1, scroll = ins.wfScroll ?? 0;
        const W    = wfCanvas.offsetWidth || 240;
        const HIT  = HIT_PX / W / zoom; // in global fractions
        if (Math.abs(gfrac - (ins.startPoint ?? 0)) < HIT) return 'start';
        if (Math.abs(gfrac - (ins.endPoint   ?? 1)) < HIT) return 'end';
        if (ins.loopEnabled && Math.abs(gfrac - (ins.loopPoint ?? 0)) < HIT) return 'loop';
        return null;
    }
    function hitSliceMarker(gfrac) {
        if (ins.melodyMode) return -1;
        const zoom = ins.wfZoom || 1;
        const W    = wfCanvas.offsetWidth || 240;
        const HIT  = HIT_PX / W / zoom;
        return (ins.slicePoints || []).slice(0, -1).findIndex(sp => Math.abs(sp.end - gfrac) < HIT);
    }

    wfCanvas.addEventListener('mousemove', e => {
        const g = evToGlobal(e);
        if (ins.melodyMode)
            wfCanvas.style.cursor = hitMelodyMarker(g) ? 'ew-resize' : 'default';
        else
            wfCanvas.style.cursor = hitSliceMarker(g) >= 0 ? 'ew-resize' : 'crosshair';
    });

    wfCanvas.addEventListener('mousedown', e => {
        e.preventDefault();
        const g = evToGlobal(e);
        if (ins.melodyMode) {
            const mk = hitMelodyMarker(g);
            if (mk) { wfDrag.active = true; wfDrag.type = mk; }
            else     previewSlice(getActx(), ins, 0, sampleBuffers, masterGain);
            return;
        }
        const idx = hitSliceMarker(g);
        if (idx >= 0) { wfDrag.active = true; wfDrag.type = 'slice-boundary'; wfDrag.markerIdx = idx; }
        else {
            const ci = (ins.slicePoints || []).findIndex(sp => g >= sp.start && g < sp.end);
            if (ci >= 0) previewSlice(getActx(), ins, ci, sampleBuffers, masterGain);
        }
    });

    wfCanvas.addEventListener('dblclick', e => {
        if (ins.melodyMode) return;
        e.preventDefault();
        const g = evToGlobal(e);
        const snapped = snapToZeroCrossing(sampleBuffers[ins.src], g);
        const ci = (ins.slicePoints || []).findIndex(sp => snapped > sp.start && snapped < sp.end);
        if (ci < 0) return;
        const sp = ins.slicePoints[ci];
        ins.slicePoints.splice(ci, 1,
            { start: sp.start, end: snapped },
            { start: snapped,  end: sp.end  }
        );
        ins.sliceNotes.splice(ci + 1, 0, (ins.sliceNotes[ci] || 36 + ci) + 1);
        ins.slices = ins.slicePoints.length;
        redraw();
        buildSamplerPanel(instrBody, trk, deps); markDirty();
    });

    const onWfMove = e => {
        if (!wfDrag.active) return;
        const g = evToGlobal(e);
        if (wfDrag.type === 'start') {
            ins.startPoint = Math.max(0, Math.min((ins.endPoint ?? 1) - 0.005, g));
            if ((ins.loopPoint ?? 0) < ins.startPoint) ins.loopPoint = ins.startPoint;
        } else if (wfDrag.type === 'end') {
            ins.endPoint = Math.max((ins.startPoint ?? 0) + 0.005, Math.min(1, g));
            if ((ins.loopPoint ?? 0) > ins.endPoint) ins.loopPoint = ins.startPoint ?? 0;
        } else if (wfDrag.type === 'loop') {
            ins.loopPoint = Math.max(ins.startPoint ?? 0, Math.min(ins.endPoint ?? 1, g));
        } else if (wfDrag.type === 'slice-boundary') {
            const idx = wfDrag.markerIdx;
            const lo  = (idx > 0 ? ins.slicePoints[idx].start : 0) + 0.005;
            const hi  = (idx < ins.slicePoints.length - 2 ? ins.slicePoints[idx + 1].end : 1) - 0.005;
            const c   = Math.max(lo, Math.min(hi, g));
            ins.slicePoints[idx].end = c;
            if (idx + 1 < ins.slicePoints.length) ins.slicePoints[idx + 1].start = c;
        }
        redraw(); markDirty();
    };
    const onWfUp = () => {
        if (!wfDrag.active) return;
        const buf = sampleBuffers[ins.src];

        if (wfDrag.type === 'slice-boundary') {
            // Snap slice boundary to nearest zero crossing
            const idx     = wfDrag.markerIdx;
            const snapped = snapToZeroCrossing(buf, ins.slicePoints[idx].end);
            const lo = (idx > 0 ? ins.slicePoints[idx].start : 0) + 0.005;
            const hi = (idx < ins.slicePoints.length - 2 ? ins.slicePoints[idx + 1].end : 1) - 0.005;
            ins.slicePoints[idx].end = Math.max(lo, Math.min(hi, snapped));
            if (idx + 1 < ins.slicePoints.length)
                ins.slicePoints[idx + 1].start = ins.slicePoints[idx].end;

        } else if (wfDrag.type === 'start') {
            // Snap start marker to nearest zero crossing, keep it before endPoint
            const snapped = snapToZeroCrossing(buf, ins.startPoint);
            ins.startPoint = Math.max(0, Math.min((ins.endPoint ?? 1) - 0.005, snapped));
            if ((ins.loopPoint ?? 0) < ins.startPoint) ins.loopPoint = ins.startPoint;

        } else if (wfDrag.type === 'end') {
            // Snap end marker to nearest zero crossing, keep it after startPoint
            const snapped = snapToZeroCrossing(buf, ins.endPoint);
            ins.endPoint = Math.max((ins.startPoint ?? 0) + 0.005, Math.min(1, snapped));
            if ((ins.loopPoint ?? 0) > ins.endPoint) ins.loopPoint = ins.startPoint ?? 0;

        } else if (wfDrag.type === 'loop') {
            // Snap loop marker to nearest zero crossing, clamped within [startPoint, endPoint]
            const snapped = snapToZeroCrossing(buf, ins.loopPoint);
            ins.loopPoint = Math.max(ins.startPoint ?? 0, Math.min(ins.endPoint ?? 1, snapped));
        }

        redraw(); markDirty();
        wfDrag.active = false; wfDrag.type = null; wfDrag.markerIdx = -1;
    };
    document.addEventListener('mousemove', onWfMove);
    document.addEventListener('mouseup',   onWfUp);
    new MutationObserver(() => {
        if (!document.contains(wfCanvas)) {
            document.removeEventListener('mousemove', onWfMove);
            document.removeEventListener('mouseup',   onWfUp);
        }
    }).observe(instrBody, { childList: true });

    // ── Initial draw ─────────────────────────────────────────
    if (ins.src && sampleBuffers[ins.src])
        redraw();
    else if (actx && ins.src)
        loadSample(ins.src).then(b => { if (b) redraw(); });
    else
        redraw();

    // ── Slice buttons ─────────────────────────────────────────
    if (!ins.melodyMode) {
        const slicesEl = instrBody.querySelector('#vdaw-sampler-slices');
        (ins.slicePoints || []).forEach((sp, i) => {
            const midiNote = ins.sliceNotes[i] || 36 + i;
            const btn = document.createElement('button');
            btn.className = 'vdaw-slice-btn';
            btn.title     = `Slice ${i + 1} → ${noteNameOf(midiNote)}`;
            btn.textContent = noteNameOf(midiNote);
            btn.addEventListener('click', () => {
                previewSlice(getActx(), ins, i, sampleBuffers, masterGain);
                btn.classList.add('playing');
                const b = sampleBuffers[ins.src];
                const d = b ? (sp.end - sp.start) * b.duration : 0.5;
                setTimeout(() => btn.classList.remove('playing'), d * 1000 + 100);
                instrBody.querySelector('#vdaw-sampler-note').textContent =
                    `Slice ${i + 1}: ${noteNameOf(midiNote)} — draw in piano roll`;
            });
            btn.addEventListener('contextmenu', e => {
                e.preventDefault();
                const v = prompt(`Slice ${i + 1} MIDI note (0–127):`, midiNote);
                if (v === null) return;
                const n = parseInt(v);
                if (isNaN(n) || n < 0 || n > 127) return;
                ins.sliceNotes[i] = n;
                btn.textContent = noteNameOf(n);
                btn.title = `Slice ${i + 1} → ${noteNameOf(n)}`;
                markDirty();
            });
            slicesEl.appendChild(btn);
        });
    }
}
