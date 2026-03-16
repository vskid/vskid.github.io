// ============================================================
//  apps/vtracker/vtracker.js
//  Pure sample-based tracker — FT2 / XM spirit
//  8 channels · 32 sample slots · pattern + song arranger
//
//  Changes vs original:
//    • Imports Sampler + WaveformEditor from sampler.js
//    • Imports createCompressorChain + mountCompressorUI from compressor.js
//    • Choke groups on samples (chokeGroup 0=off, 1-16=group, selfChoke always on)
//    • selfChokeOnly flag per sample to allow chords within a group
//    • Preview no longer spammable (choke on re-trigger)
//    • Oscilloscope: canvas sized to actual pixel dimensions (DPR-aware)
//    • Waveform editor: WaveformEditor class with start/loopStart/loopEnd/end markers
//    • Sample struct: added startPoint, endPoint, chokeGroup, selfChokeOnly
//    • Master compressor chain inserted between masterGain and destination
//    • YouTube loading via cnvmp3 API (in sampler.js)
// ============================================================

import { Sampler, WaveformEditor } from './sampler.js';
import { createCompressorChain, buildCompressorBar } from './compressor.js';

const NUM_CH     = 8;
const NUM_SMP    = 32;
const DEF_ROWS   = 64;
const DEF_BPM    = 125;
const DEF_SPEED  = 6;
const TICK_MS    = 2.5;
const LOOKAHEAD  = 0.120;

const NOTE_NAMES = ['C-','C#','D-','D#','E-','F-','F#','G-','G#','A-','A#','B-'];
const NOTE_OFF   = 254;
const NOTE_NONE  = 255;

function noteToHz(note) { return 440 * Math.pow(2, (note - 57) / 12); }
function noteName(note) {
    if (note === NOTE_OFF)  return '===';
    if (note === NOTE_NONE) return '---';
    return NOTE_NAMES[note % 12] + Math.floor(note / 12);
}
function hexByte(v)   { return v == null ? '--' : v.toString(16).toUpperCase().padStart(2,'0'); }
function hexNibble(v) { return v == null ? '-'  : v.toString(16).toUpperCase(); }
function uid()        { return Math.random().toString(36).slice(2,9); }

const KEY_NOTE_MAP = {
    'z':0,'s':1,'x':2,'d':3,'c':4,'v':5,'g':6,'b':7,'h':8,'n':9,'j':10,'m':11,
    'q':12,'2':13,'w':14,'3':15,'e':16,'r':17,'5':18,'t':19,'6':20,'y':21,'7':22,'u':23,
};

const CH_COLOURS = [
    '#80ffff','#80ff80','#ffff80','#ff8080',
    '#80c0ff','#ff80ff','#80ffb0','#ffb080',
];

// ============================================================
export async function initVTracker({ registerWindow, openWindow }) {

    // ── Load HTML + CSS ──────────────────────────────────────
    const link = document.createElement('link');
    link.rel   = 'stylesheet';
    link.href  = new URL('vtracker.css', import.meta.url).href;
    document.head.appendChild(link);

    try {
        const res  = await fetch(new URL('vtracker.html', import.meta.url).href);
        const html = await res.text();
        document.body.insertAdjacentHTML('beforeend', html);
    } catch(e) { console.error('[vtracker] html load failed', e); return; }

    const winEl = document.getElementById('vtracker-window');
    if (!winEl) return;

    const entry = registerWindow(winEl, { icon: '🎚' });
    document.getElementById('open-vtracker')
        ?.addEventListener('dblclick', () => openWindow(entry));

    winEl.querySelector('.close-btn')?.addEventListener('click', stopPlay);
    winEl.querySelector('.minimize-btn')?.addEventListener('click', stopPlay);

    // ── Song state ────────────────────────────────────────────
    let song = makeSong();
    let curPat     = 0;
    let curRow     = 0;
    let curCh      = 0;
    let curField   = 0;
    let curSmpSlot = 0;
    let editOct    = 4;
    let editStep   = 1;
    let activeSmpIdx = 0;

    function makeSong() {
        return {
            bpm:      DEF_BPM,
            speed:    DEF_SPEED,
            order:    [0],
            patterns: [makePattern(DEF_ROWS)],
            samples:  Array.from({ length: NUM_SMP }, () => makeSample()),
        };
    }
    function makePattern(rows = DEF_ROWS) {
        return { id: uid(), rows,
                 data: Array.from({ length: NUM_CH }, () =>
                     Array.from({ length: rows }, () => makeRow())) };
    }
    function makeRow() {
        return { note: NOTE_NONE, smp: null, vol: null, fx: null, fxp: null };
    }
    function makeSample() {
        return {
            name: '', buffer: null,
            loop: false, loopMode: 0,  // 0=forward, 1=ping-pong
            loopStart: 0, loopEnd: 0,
            startPoint: 0, endPoint: 0,
            baseNote: 48, volume: 64, finetune: 0,
            chokeGroup: 0, selfChokeOnly: false,
            // Volume ADSR (times in seconds, sustain 0-1)
            adsr: { a: 0.002, d: 0.1, s: 1.0, r: 0.2 },
            // Filter
            filter: {
                type: 'lowpass',  // lowpass|highpass|bandpass|notch|off
                cutoff: 20000,    // Hz
                resonance: 0.7,   // Q
                // Filter envelope (modulates cutoff)
                envAmt:  0,       // Hz offset at peak (can be negative)
                a: 0.01, d: 0.3, s: 0.0, r: 0.2,
            },
        };
    }

    // ── Audio context ─────────────────────────────────────────
    let actx = null, masterGain = null, compChain = null;
    let analysers = new Array(NUM_CH).fill(null);
    let sampler   = null;

    function getActx() {
        if (actx) { if (actx.state === 'suspended') actx.resume(); return actx; }
        actx = new (window.AudioContext || window.webkitAudioContext)();

        masterGain = actx.createGain();
        masterGain.gain.value = 0.85;

        // Master compressor chain: all audio → masterGain → comp → destination
        compChain = createCompressorChain(actx);
        masterGain.connect(compChain.input);
        compChain.output.connect(actx.destination);
        compChain.bypass.connect(actx.destination);

        // Per-channel analysers → masterGain
        for (let ch = 0; ch < NUM_CH; ch++) {
            const an = actx.createAnalyser();
            an.fftSize = 512;
            an.smoothingTimeConstant = 0.5;
            an.connect(masterGain);
            analysers[ch] = an;
        }

        sampler = new Sampler(actx, masterGain, setStatus);

        // Insert compressor bar into topbar (once, first time audio starts)
        const topbar = document.getElementById('vt-topbar');
        if (topbar && !topbar.querySelector('.vt-comp-bar')) {
            topbar.appendChild(buildCompressorBar(compChain, actx));
        }

        return actx;
    }

    // ── Scheduler ─────────────────────────────────────────────
    let playState = {
        playing: false, patOnly: false,
        orderIdx: 0, row: 0, tick: 0,
        nextRowTime: 0, scheduledTo: 0,
    };
    let schedTimer = null;
    let voices = Array.from({ length: NUM_CH }, () => ({
        node: null, gainNode: null, filterNode: null,
        note: NOTE_NONE, smp: 0, vol: 64,
        period: 0, portaTarget: 0, volSlide: 0,
        _baseVol: 0.8, _adsr: null, _filter: null,
    }));

    function tickDuration() { return 60 / (song.bpm * 24); }
    function rowDuration()  { return tickDuration() * song.speed; }

    function startPlay(patOnly = false) {
        getActx(); stopPlay();
        playState.playing   = true;
        playState.patOnly   = patOnly;
        playState.orderIdx  = patOnly ? Math.max(0, song.order.indexOf(curPat)) : 0;
        playState.row       = 0;
        playState.tick      = 0;
        playState.nextRowTime = actx.currentTime + 0.05;
        schedule();
        schedTimer = setInterval(schedule, TICK_MS * 2);
        document.getElementById('vt-play').textContent = '■ STOP';
        setStatus('PLAYING...');
    }

    function stopPlay() {
        clearInterval(schedTimer); schedTimer = null;
        playState.playing = false;
        voices.forEach(v => { try { v.node?.stop(); } catch(_){} v.node = null; });
        document.getElementById('vt-play').textContent = '▶ PLAY';
        document.getElementById('vt-pos').textContent  = 'ROW:00 ORD:00';
        document.getElementById('vt-pat-val').textContent = curPat.toString().padStart(2,'0');
        renderGrid();
    }

    function schedule() {
        if (!playState.playing || !actx) return;
        const now = actx.currentTime;
        while (playState.nextRowTime < now + LOOKAHEAD) {
            scheduleRow(playState.nextRowTime);
            advanceRow();
        }
    }

    function scheduleRow(t) {
        const patIdx = song.order[playState.orderIdx] ?? 0;
        const pat    = song.patterns[patIdx];
        if (!pat) return;
        const row = playState.row;
        requestAnimationFrame(() => {
            if (!playState.playing) return;
            document.getElementById('vt-pos').textContent =
                `ROW:${row.toString().padStart(2,'0')} ORD:${playState.orderIdx.toString().padStart(2,'0')}`;
            scrollToPlayRow(row);
            renderGrid(row);
        });
        for (let ch = 0; ch < NUM_CH; ch++) {
            const cell = pat.data[ch]?.[row];
            if (!cell) continue;
            triggerCell(ch, cell, t);
        }
    }

    // ── Volume curve: aggressive exponential (x^2.5 perceptual) ──
    // Maps linear 0-1 → 0-1 but with a steep curve so small values
    // are nearly silent and upper half of the knob does real work.
    function volCurve(v) { return v * v * Math.sqrt(v); } // x^2.5

    function triggerCell(ch, cell, t) {
        const v = voices[ch];
        let smpIdx = cell.smp != null ? cell.smp : v.smp;
        let velGain = volCurve(cell.vol != null ? cell.vol / 63 : v.vol / 64);

        if (cell.note === NOTE_OFF) {
            // Release phase — exponential fall for natural tail
            if (v.gainNode) {
                const smp = song.samples[v.smp];
                const rel = smp?.adsr?.r ?? 0.2;
                const now_gain = v.gainNode.gain.value || 0.0001;
                v.gainNode.gain.cancelScheduledValues(t);
                v.gainNode.gain.setValueAtTime(Math.max(0.0001, now_gain), t);
                v.gainNode.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.005, rel));
                try { v.node?.stop(t + Math.max(0.005, rel) + 0.01); } catch(_) {}
            } else {
                try { v.node?.stop(t + 0.005); } catch(_) {}
            }
            v.node = null; return;
        }

        if (cell.note !== NOTE_NONE) {
            // Release previous voice
            if (v.gainNode) {
                const prevSmp = song.samples[v.smp];
                const rel = prevSmp?.adsr?.r ?? 0.05;
                v.gainNode.gain.setTargetAtTime(0, t, rel / 5);
                try { v.node?.stop(t + rel + 0.05); } catch(_) {}
            }
            v.node = null; v.gainNode = null; v.filterNode = null;

            const smp = song.samples[smpIdx];
            if (!smp?.buffer) return;

            // ── Loop mode setup ────────────────────────────────────
            // loopMode 0 = forward loop (native Web Audio src.loop)
            // loopMode 1 = ping-pong  (pre-baked reversed buffer, cached on smp)
            // loopMode 2 = one-shot   (no loop, play start→end once)
            let playBuf;
            if (smp.loop && smp.loopMode === 1 && smp.loopEnd > smp.loopStart) {
                // Ping-pong: build once, cache on smp object to avoid re-alloc every note
                const cacheKey = `_ppBuf_${smp.loopStart}_${smp.loopEnd}`;
                if (!smp[cacheKey] || smp[cacheKey]._srcLen !== smp.buffer.length) {
                    smp[cacheKey] = buildPingPongBuffer(smp);
                    smp[cacheKey]._srcLen = smp.buffer.length;
                }
                playBuf = smp[cacheKey];
            } else {
                playBuf = smp.buffer;
            }

            const src = actx.createBufferSource();
            src.buffer = playBuf;
            src.playbackRate.value = Math.pow(2, (cell.note - smp.baseNote) / 12) *
                Math.pow(2, (smp.finetune || 0) / 1200);

            // ── Loop region ────────────────────────────────────────
            if (smp.loop && smp.loopEnd > smp.loopStart) {
                src.loop = true;
                const sr = playBuf.sampleRate;
                if (smp.loopMode === 1) {
                    // Ping-pong buffer: loop over the doubled baked region
                    const ppLen = (smp.loopEnd - smp.loopStart) * 2;
                    src.loopStart = smp.loopStart / sr;
                    src.loopEnd   = (smp.loopStart + ppLen) / sr;
                } else {
                    // Forward loop: clamp loopStart >= startPoint
                    const ls = Math.max(smp.startPoint || 0, smp.loopStart);
                    const le = Math.min(
                        smp.endPoint > smp.startPoint ? smp.endPoint : smp.buffer.length,
                        smp.loopEnd
                    );
                    src.loopStart = ls / sr;
                    src.loopEnd   = Math.max(src.loopStart + 0.001, le / sr);
                }
            }

            // Gain node
            const g = actx.createGain();
            const baseVol = velGain * volCurve(smp.volume / 64);
            g.gain.value = 0; // start at 0 for ADSR

            // Filter node
            let dest = g;
            const filt = smp.filter;
            let filterNode = null;
            if (filt && filt.type !== 'off') {
                filterNode = actx.createBiquadFilter();
                filterNode.type = filt.type;
                filterNode.frequency.value = Math.min(filt.cutoff, actx.sampleRate / 2 - 1);
                filterNode.Q.value = Math.max(0.001, filt.resonance);
                g.connect(filterNode);
                filterNode.connect(analysers[ch] ?? masterGain);
                dest = filterNode; // for reference
            } else {
                g.connect(analysers[ch] ?? masterGain);
            }

            src.connect(g);

            // Start with offset (startPoint), duration capped at endPoint
            const sr2     = smp.buffer.sampleRate;
            const startSec = (smp.startPoint || 0) / sr2;
            const endSec   = smp.endPoint > smp.startPoint
                ? (smp.endPoint - (smp.startPoint || 0)) / sr2 : undefined;
            if (smp.loop) {
                // Looping: start at startPoint, no duration limit (loop handles it)
                src.start(t, startSec);
            } else {
                endSec != null ? src.start(t, startSec, endSec) : src.start(t, startSec);
            }

            // Volume ADSR — exponential ramps for punchy, musical feel
            // Uses setTargetAtTime for attack/decay/release (natural curve)
            const { a, d, s, r } = smp.adsr ?? { a:0.002, d:0.1, s:1, r:0.2 };
            const FLOOR = 0.0001; // Web Audio exponential ramps can't hit 0
            g.gain.cancelScheduledValues(t);
            g.gain.setValueAtTime(FLOOR, t);
            // Attack: exponential rise
            if (a < 0.005) {
                g.gain.linearRampToValueAtTime(baseVol, t + Math.max(0.001, a));
            } else {
                g.gain.exponentialRampToValueAtTime(baseVol, t + Math.max(0.001, a));
            }
            // Decay: exponential fall to sustain
            const susLevel = Math.max(FLOOR, baseVol * s);
            g.gain.exponentialRampToValueAtTime(susLevel, t + Math.max(0.001, a) + Math.max(0.001, d));

            // Filter envelope
            if (filterNode && filt.envAmt !== 0) {
                const fc = filt.cutoff;
                const fa = filt.a, fd = filt.d, fs = filt.s, fr = filt.r, fenv = filt.envAmt;
                filterNode.frequency.cancelScheduledValues(t);
                filterNode.frequency.setValueAtTime(fc, t);
                filterNode.frequency.linearRampToValueAtTime(fc + fenv, t + Math.max(0.001, fa));
                filterNode.frequency.linearRampToValueAtTime(fc + fenv * fs, t + Math.max(0.001, fa) + Math.max(0.001, fd));
            }

            v.node = src; v.gainNode = g; v.filterNode = filterNode;
            v.note = cell.note; v.smp = smpIdx;
            v.vol  = cell.vol != null ? cell.vol : v.vol;
            v._baseVol = baseVol;
            v._adsr = smp.adsr;
            v._filter = filt;
        } else if (cell.vol != null && v.gainNode) {
            v.gainNode.gain.setValueAtTime(volCurve(cell.vol / 63), t);
            v.vol = cell.vol;
        }

        if (cell.fx != null) applyEffect(ch, cell, t);
    }

    // Build a ping-pong buffer: forward region + reversed region concatenated
    function buildPingPongBuffer(smp) {
        const buf = smp.buffer;
        const sr  = buf.sampleRate;
        const nch = buf.numberOfChannels;
        const ls  = smp.loopStart, le = smp.loopEnd;
        const segLen = le - ls;
        if (segLen <= 0) return buf;

        const preLen  = ls;               // samples before loop start
        const ppLen   = segLen * 2;       // forward + reversed
        const postLen = buf.length - le;  // samples after loop end
        const total   = preLen + ppLen + postLen;

        const out = actx.createBuffer(nch, total, sr);
        for (let ch = 0; ch < nch; ch++) {
            const src  = buf.getChannelData(ch);
            const dst  = out.getChannelData(ch);
            // Pre-loop
            dst.set(src.subarray(0, preLen), 0);
            // Forward pass
            dst.set(src.subarray(ls, le), preLen);
            // Reversed pass
            for (let i = 0; i < segLen; i++) dst[preLen + segLen + i] = src[le - 1 - i];
            // Post-loop (after the loop ends, if any)
            dst.set(src.subarray(le), preLen + ppLen);
        }
        return out;
    }

    function applyEffect(ch, cell, t) {
        const v = voices[ch]; const fx = cell.fx; const fxp = cell.fxp ?? 0;
        switch(fx) {
            case 0xC: { const vol = Math.min(63, fxp);
                if (v.gainNode) v.gainNode.gain.setValueAtTime(volCurve(vol/63), t); v.vol = vol; break; }
            case 0xF: fxp < 0x20 ? (song.speed = Math.max(1,fxp), updateSpeedUI())
                                 : (song.bpm = fxp, updateBpmUI()); break;
            case 0xB: playState.orderIdx = Math.min(fxp, song.order.length-1);
                      playState.row = -1; break;
            case 0xD: advanceOrder();
                      playState.row = Math.min(fxp, (getCurrentPat()?.rows ?? DEF_ROWS)-1)-1; break;
        }
    }

    function advanceRow() {
        playState.nextRowTime += rowDuration();
        playState.row++;
        const pat = getCurrentPat();
        if (playState.row >= (pat?.rows ?? DEF_ROWS)) {
            playState.patOnly ? (playState.row = 0) : advanceOrder();
        }
    }
    function advanceOrder() {
        playState.orderIdx = (playState.orderIdx + 1) % song.order.length;
        playState.row = 0;
    }
    function getCurrentPat() { return song.patterns[song.order[playState.orderIdx] ?? 0]; }

    // ── DOM refs ──────────────────────────────────────────────
    const gridEl    = document.getElementById('vt-grid');
    const chHdrs    = document.getElementById('vt-ch-headers');
    const gridScroll= document.getElementById('vt-grid-scroll');
    const patValEl  = document.getElementById('vt-pat-val');
    const bpmValEl  = document.getElementById('vt-bpm-val');
    const spdValEl  = document.getElementById('vt-spd-val');
    const octValEl  = document.getElementById('vt-oct-val');
    const stepValEl = document.getElementById('vt-step-val');

    // ── Oscilloscopes ─────────────────────────────────────────
    let scopeCanvases = [];

    function buildScopeStrip() {
        const strip = document.getElementById('vt-scope-strip');
        strip.innerHTML = '';
        const gutter = document.createElement('div');
        gutter.className = 'vt-scope-gutter';
        strip.appendChild(gutter);

        // Slave div — mirrors gridScroll.scrollLeft
        const slave = document.createElement('div');
        slave.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:row;';
        _scopeSlaveEl = slave;

        scopeCanvases = [];
        for (let ch = 0; ch < NUM_CH; ch++) {
            const wrap   = document.createElement('div');
            wrap.className = 'vt-scope-cell';
            const canvas = document.createElement('canvas');
            canvas.className = 'vt-scope-canvas';
            wrap.appendChild(canvas);
            slave.appendChild(wrap);
            scopeCanvases.push(canvas);
        }
        strip.appendChild(slave);
    }

    function drawScopes() {
        const dpr = window.devicePixelRatio || 1;
        for (let ch = 0; ch < NUM_CH; ch++) {
            const canvas = scopeCanvases[ch];
            if (!canvas) continue;
            // Always size to physical pixels
            const cssW = canvas.clientWidth  || canvas.offsetWidth  || 110;
            const cssH = canvas.clientHeight || canvas.offsetHeight || 40;
            const pw   = Math.round(cssW * dpr);
            const ph   = Math.round(cssH * dpr);
            if (canvas.width !== pw || canvas.height !== ph) {
                canvas.width  = pw;
                canvas.height = ph;
            }

            const ctx = canvas.getContext('2d');
            ctx.save();
            ctx.scale(dpr, dpr);
            const W = cssW, H = cssH;

            ctx.fillStyle = '#06060f';
            ctx.fillRect(0, 0, W, H);

            // Centre line
            ctx.strokeStyle = 'rgba(255,255,255,0.07)';
            ctx.lineWidth   = 1;
            ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();

            const analyser = analysers[ch];
            if (!analyser || !actx) {
                ctx.strokeStyle = CH_COLOURS[ch] + '33';
                ctx.lineWidth   = 1;
                ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
                ctx.restore(); continue;
            }

            const buf = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(buf);
            let maxAmp = 0;
            for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a>maxAmp) maxAmp=a; }

            const col   = CH_COLOURS[ch];
            const alpha = maxAmp > 0.002 ? 'cc' : '33';
            ctx.strokeStyle = col + alpha;
            ctx.lineWidth   = maxAmp > 0.002 ? 1.5 : 0.8;
            ctx.shadowColor = col;
            ctx.shadowBlur  = maxAmp > 0.01 ? 4 : 0;

            ctx.beginPath();
            const step = buf.length / W;
            for (let x = 0; x < W; x++) {
                const s = buf[Math.floor(x * step)] || 0;
                const y = (0.5 - s * 0.48) * H;
                x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.restore();
        }
        requestAnimationFrame(drawScopes);
    }

    // ── Channel headers ───────────────────────────────────────
    // Gutter is fixed-left; the channel header strip and scope strip
    // are slave-scrolled to match gridScroll.scrollLeft via syncHeaders().
    let _hdrSlaveEl   = null;  // inner flex row of CH headers
    let _scopeSlaveEl = null;  // inner flex row of scope canvases

    function renderHeaders() {
        chHdrs.innerHTML = '';

        // Fixed gutter
        const gutter = document.createElement('div');
        gutter.className = 'vt-row-gutter';
        chHdrs.appendChild(gutter);

        // Scrollable slave div — overflow hidden, JS sets scrollLeft
        const slave = document.createElement('div');
        slave.className = 'vt-hdr-slave';
        slave.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:row;';
        _hdrSlaveEl = slave;

        for (let ch = 0; ch < NUM_CH; ch++) {
            const hdr = document.createElement('div');
            hdr.className = 'vt-ch-hdr' + (ch===curCh?' active':'');
            hdr.dataset.ch = ch; hdr.textContent = `CH${ch+1}`;
            hdr.title = 'Right-click to mute';
            hdr.addEventListener('click', () => { curCh=ch; renderGrid(); renderHeaders(); });
            hdr.addEventListener('contextmenu', e => {
                e.preventDefault();
                const pat = getEditPat(); pat._muted = pat._muted||[];
                pat._muted[ch] = !pat._muted[ch];
                hdr.classList.toggle('muted', pat._muted[ch]);
            });
            slave.appendChild(hdr);
        }
        chHdrs.appendChild(slave);
        buildScopeStrip();
        // Immediately sync to current scroll position
        syncHeaders();
    }

    function syncHeaders() {
        const sx = gridScroll.scrollLeft;
        if (_hdrSlaveEl)   _hdrSlaveEl.scrollLeft   = sx;
        if (_scopeSlaveEl) _scopeSlaveEl.scrollLeft  = sx;
    }

    // Wire scroll listener once (after DOM refs are ready)
    // Called after init
    function initScrollSync() {
        gridScroll.addEventListener('scroll', syncHeaders, { passive: true });
    }

    // ── Pattern grid ──────────────────────────────────────────
    function renderGrid(playRow = -1) {
        const pat = getEditPat(); if (!pat) return;
        if (gridEl.dataset.patId !== pat.id || gridEl.childElementCount !== pat.rows) buildGrid(pat);

        for (let row = 0; row < pat.rows; row++) {
            const rowEl = gridEl.children[row]; if (!rowEl) continue;
            rowEl.classList.toggle('playhead', row === playRow);
            for (let ch = 0; ch < NUM_CH; ch++) {
                const cellEl = rowEl.children[ch+1]; if (!cellEl) continue;
                const cell   = pat.data[ch][row];
                const isCursor = row===curRow && ch===curCh;
                cellEl.classList.toggle('cursor', isCursor && curField>=0);
                cellEl.classList.remove('cursor-note','cursor-smp','cursor-vol','cursor-fx');
                if (isCursor) {
                    const fm = ['cursor-note','cursor-smp','cursor-vol','cursor-fx','cursor-fx'];
                    cellEl.classList.add(fm[curField] ?? 'cursor-note');
                }
                updateCellDOM(cellEl, cell);
            }
        }
    }

    function buildGrid(pat) {
        gridEl.innerHTML = ''; gridEl.dataset.patId = pat.id;
        gridEl.style.width = (NUM_CH*(112+1)+30)+'px';
        for (let row = 0; row < pat.rows; row++) {
            const rowEl = document.createElement('div'); rowEl.className='vt-row'; rowEl.dataset.row=row;
            const numEl = document.createElement('div');
            numEl.className = 'vt-row-num' + (row%16===0?' bar':row%4===0?' beat':'');
            numEl.textContent = row.toString(16).toUpperCase().padStart(2,'0');
            rowEl.appendChild(numEl);
            for (let ch = 0; ch < NUM_CH; ch++) {
                const cellEl = document.createElement('div');
                cellEl.className='vt-cell'; cellEl.dataset.row=row; cellEl.dataset.ch=ch;
                const note=document.createElement('span'); note.className='vt-f-note';
                const smp =document.createElement('span'); smp.className ='vt-f-smp';
                const vol =document.createElement('span'); vol.className ='vt-f-vol';
                const fx  =document.createElement('span'); fx.className  ='vt-f-fx';
                cellEl.append(note,smp,vol,fx);
                cellEl.addEventListener('mousedown', e => {
                    e.preventDefault(); curRow=row; curCh=ch;
                    const relX=e.clientX-cellEl.getBoundingClientRect().left;
                    const cw=cellEl.getBoundingClientRect().width;
                    curField = relX<cw*0.28?0:relX<cw*0.43?1:relX<cw*0.58?2:3;
                    renderGrid(); renderHeaders(); gridEl.focus();
                });
                rowEl.appendChild(cellEl);
            }
            gridEl.appendChild(rowEl);
        }
    }

    function updateCellDOM(cellEl, cell) {
        const [noteEl,smpEl,volEl,fxEl] = cellEl.children;
        noteEl.textContent = noteName(cell.note);
        noteEl.classList.toggle('off', cell.note===NOTE_OFF);
        noteEl.style.color = cell.note===NOTE_NONE ? 'var(--ft-col-empty)' : '';
        smpEl.textContent  = cell.smp!=null ? hexByte(cell.smp+1) : '--';
        smpEl.style.color  = cell.smp==null ? 'var(--ft-col-empty)' : '';
        volEl.textContent  = cell.vol!=null ? hexByte(cell.vol) : '--';
        volEl.style.color  = cell.vol==null ? 'var(--ft-col-empty)' : '';
        fxEl.textContent   = cell.fx!=null ? hexNibble(cell.fx)+hexByte(cell.fxp??0) : '---';
        fxEl.style.color   = cell.fx==null ? 'var(--ft-col-empty)' : '';
    }

    function scrollToPlayRow(row) {
        const rowEl=gridEl.children[row]; if (!rowEl) return;
        const top=rowEl.offsetTop, viewH=gridScroll.clientHeight, scrollY=gridScroll.scrollTop;
        if (top<scrollY+viewH*0.25 || top>scrollY+viewH*0.75) gridScroll.scrollTop=top-viewH*0.4;
    }
    function scrollToCursor() {
        const rowEl=gridEl.children[curRow]; if (!rowEl) return;
        const top=rowEl.offsetTop, h=rowEl.offsetHeight||14, viewH=gridScroll.clientHeight, scrollY=gridScroll.scrollTop;
        if (top<scrollY) gridScroll.scrollTop=top-8;
        else if (top+h>scrollY+viewH) gridScroll.scrollTop=top-viewH+h+8;
    }

    // ── Song view ─────────────────────────────────────────────
    function renderSong() {
        const ordEl=document.getElementById('vt-orderlist'); ordEl.innerHTML='';
        song.order.forEach((patIdx,i) => {
            const row=document.createElement('div');
            row.className='vt-ord-row'+(patIdx===curPat?' active':'');
            row.innerHTML=`<span class="vt-ord-idx">${i.toString().padStart(2,'0')}:</span><span class="vt-ord-num">${patIdx.toString().padStart(2,'0')}</span>`;
            row.addEventListener('click',()=>{ curPat=patIdx; patValEl.textContent=curPat.toString().padStart(2,'0'); renderSong();renderGrid();renderHeaders();switchTab('pattern'); });
            ordEl.appendChild(row);
        });
        const patListEl=document.getElementById('vt-patlist'); patListEl.innerHTML='';
        song.patterns.forEach((pat,i)=>{
            const row=document.createElement('div');
            row.className='vt-pat-row'+(i===curPat?' active':'');
            const uses=song.order.filter(o=>o===i).length;
            row.innerHTML=`<span class="vt-pat-idx">${i.toString().padStart(2,'0')}</span><span>${pat.rows} rows</span><span class="vt-pat-info">×${uses} in order</span>`;
            row.addEventListener('click',()=>{ curPat=i; patValEl.textContent=curPat.toString().padStart(2,'0'); renderSong();renderGrid();renderHeaders();switchTab('pattern'); });
            patListEl.appendChild(row);
        });
    }

    // ── Sample list ───────────────────────────────────────────
    function renderSampleList() {
        const listEl=document.getElementById('vt-sample-list'); listEl.innerHTML='';
        for (let i=0;i<NUM_SMP;i++) {
            const smp=song.samples[i];
            const slot=document.createElement('div');
            slot.className='vt-smp-slot'+(smp.buffer?' loaded':'')+(i===curSmpSlot?' active':'');
            slot.innerHTML=`<span class="vt-smp-num">${(i+1).toString(16).toUpperCase().padStart(2,'0')}</span><span class="vt-smp-dot"></span><span class="vt-smp-name">${smp.name||'(empty)'}</span>`;
            slot.addEventListener('click',()=>{ curSmpSlot=i; activeSmpIdx=i; renderSampleList(); renderSampleEditor(i); });
            listEl.appendChild(slot);
        }
    }

    // ── Sample editor ─────────────────────────────────────────
    let _wfEditor  = null;
    let _adsrEditor= null;
    let _micRec    = null;

    function renderSampleEditor(slot) {
        const smp  = song.samples[slot];
        const edEl = document.getElementById('vt-sample-editor');
        const isRec = _micRec && _micRec.state === 'recording';
        if (!smp.adsr)   smp.adsr   = { a:0.002, d:0.1, s:1.0, r:0.2 };
        if (!smp.filter) smp.filter = { type:'lowpass', cutoff:20000, resonance:0.7, envAmt:0, a:0.01, d:0.3, s:0.0, r:0.2 };
        if (smp.loopMode == null) smp.loopMode = 0;

        edEl.innerHTML = `
        <div class="vt-smp-row">
          <span class="vt-lbl">SMP ${(slot+1).toString(16).toUpperCase().padStart(2,'0')}</span>
          <input class="vt-smp-name-input" id="vt-sname" maxlength="22" value="${smp.name}" placeholder="SAMPLE NAME">
        </div>
        <div class="vt-smp-load-row">
          <input class="vt-url-input" id="vt-url" placeholder="URL or YouTube link..." value="">
          <button class="vt-btn" id="vt-load-url">FETCH</button>
        </div>
        <div class="vt-smp-load-row">
          <label class="vt-btn" style="cursor:pointer;">📁 FILE<input type="file" id="vt-smp-file" accept="audio/*" style="display:none"></label>
          <button class="vt-btn" id="vt-mic-start">${isRec?'⏹ STOP REC':'● REC MIC'}</button>
          ${smp.buffer?'<button class="vt-btn" id="vt-preview-smp">▶ PREVIEW</button>':''}
          ${smp.buffer?'<button class="vt-btn" id="vt-clear-smp" style="color:var(--ft-red)">✕ CLEAR</button>':''}
        </div>

        <canvas class="vt-waveform" id="vt-wf" style="width:100%;height:80px;display:block;flex-shrink:0;"></canvas>
        <div style="display:flex;justify-content:flex-end;gap:2px;margin-top:1px;">
          <span class="vt-lbl" style="margin-right:auto;font-size:8px;color:var(--ft-text3)">SCROLL=PAN · CTRL+SCROLL=ZOOM · DBLCLICK=RESET</span>
          <button class="vt-btn" id="vt-wf-zoom-reset" style="font-size:8px;padding:0 5px;">1:1</button>
        </div>

        <div class="vt-smp-props">
          <div class="vt-smp-prop">
            <span class="vt-lbl">BASE</span>
            <button class="vt-nudge" id="vt-base-dn">−</button>
            <span class="vt-smp-numval" id="vt-base-val">${noteName(smp.baseNote)}</span>
            <button class="vt-nudge" id="vt-base-up">+</button>
          </div>
          <div class="vt-smp-prop">
            <span class="vt-lbl">VOL</span>
            <button class="vt-nudge" id="vt-svol-dn">−</button>
            <span class="vt-smp-numval" id="vt-svol-val">${smp.volume}</span>
            <button class="vt-nudge" id="vt-svol-up">+</button>
          </div>
          <div class="vt-smp-prop">
            <span class="vt-lbl">FINE</span>
            <button class="vt-nudge" id="vt-fine-dn">−</button>
            <span class="vt-smp-numval" id="vt-fine-val">${smp.finetune}</span>
            <button class="vt-nudge" id="vt-fine-up">+</button>
          </div>
          <div class="vt-sep"></div>
          <button class="vt-loop-btn${smp.loop?' active':''}" id="vt-loop-toggle">⟳ LOOP</button>
          <button class="vt-loop-btn${smp.loop && smp.loopMode===1?' active':''}" id="vt-pingpong-toggle" title="Toggle ping-pong / forward loop">↔ PING</button>
          <span class="vt-lbl" id="vt-loop-mode-lbl" style="font-size:8px;color:${smp.loop?(smp.loopMode===1?'var(--ft-yellow)':'var(--ft-green)'):'var(--ft-text3)'};">${smp.loop?(smp.loopMode===1?'PINGPONG':'FORWARD'):'OFF'}</span>
          <div class="vt-sep"></div>
          <span class="vt-lbl">CHOKE</span>
          <select class="vt-sel" id="vt-choke-grp">
            <option value="0"${smp.chokeGroup===0?' selected':''}>OFF</option>
            ${Array.from({length:16},(_,i)=>`<option value="${i+1}"${smp.chokeGroup===i+1?' selected':''}>${i+1}</option>`).join('')}
          </select>
          <label style="display:flex;align-items:center;gap:3px;cursor:pointer;">
            <input type="checkbox" id="vt-self-choke-only" ${smp.selfChokeOnly?'checked':''}>
            <span class="vt-lbl">SELF</span>
          </label>
        </div>

        <div class="vt-smp-prop" style="font-size:9px;color:var(--ft-text3);">
          S:<span id="vt-sp-val">${smp.startPoint}</span>
          &nbsp;L[<span id="vt-ls-val">${smp.loopStart}</span>
          &nbsp;L]<span id="vt-le-val">${smp.loopEnd}</span>
          &nbsp;E:<span id="vt-ep-val">${smp.endPoint||smp.buffer?.length||0}</span>
        </div>

        <!-- ── Volume ADSR ── -->
        <div class="vt-section-hdr"><span class="vt-lbl">VOL ADSR</span></div>
        <canvas id="vt-adsr-canvas" class="vt-adsr-canvas" style="width:100%;height:54px;display:block;flex-shrink:0;"></canvas>
        <div class="vt-smp-props" style="margin-top:2px;">
          <div class="vt-smp-prop"><span class="vt-lbl">A</span>
            <button class="vt-nudge" id="vt-adsr-a-dn">−</button>
            <span class="vt-smp-numval" id="vt-adsr-a-val">${(smp.adsr.a*1000).toFixed(0)}ms</span>
            <button class="vt-nudge" id="vt-adsr-a-up">+</button>
          </div>
          <div class="vt-smp-prop"><span class="vt-lbl">D</span>
            <button class="vt-nudge" id="vt-adsr-d-dn">−</button>
            <span class="vt-smp-numval" id="vt-adsr-d-val">${(smp.adsr.d*1000).toFixed(0)}ms</span>
            <button class="vt-nudge" id="vt-adsr-d-up">+</button>
          </div>
          <div class="vt-smp-prop"><span class="vt-lbl">S</span>
            <button class="vt-nudge" id="vt-adsr-s-dn">−</button>
            <span class="vt-smp-numval" id="vt-adsr-s-val">${(smp.adsr.s*100).toFixed(0)}%</span>
            <button class="vt-nudge" id="vt-adsr-s-up">+</button>
          </div>
          <div class="vt-smp-prop"><span class="vt-lbl">R</span>
            <button class="vt-nudge" id="vt-adsr-r-dn">−</button>
            <span class="vt-smp-numval" id="vt-adsr-r-val">${(smp.adsr.r*1000).toFixed(0)}ms</span>
            <button class="vt-nudge" id="vt-adsr-r-up">+</button>
          </div>
        </div>

        <!-- ── Filter ── -->
        <div class="vt-section-hdr"><span class="vt-lbl">FILTER</span></div>
        <div class="vt-smp-props">
          <span class="vt-lbl">TYPE</span>
          <select class="vt-sel" id="vt-filt-type">
            ${['off','lowpass','highpass','bandpass','notch'].map(t=>`<option value="${t}"${smp.filter.type===t?' selected':''}>${t.toUpperCase()}</option>`).join('')}
          </select>
          <div class="vt-smp-prop"><span class="vt-lbl">CUT</span>
            <button class="vt-nudge" id="vt-filt-cut-dn">−</button>
            <span class="vt-smp-numval" id="vt-filt-cut-val">${Math.round(smp.filter.cutoff)}Hz</span>
            <button class="vt-nudge" id="vt-filt-cut-up">+</button>
          </div>
          <div class="vt-smp-prop"><span class="vt-lbl">RES</span>
            <button class="vt-nudge" id="vt-filt-res-dn">−</button>
            <span class="vt-smp-numval" id="vt-filt-res-val">${smp.filter.resonance.toFixed(1)}</span>
            <button class="vt-nudge" id="vt-filt-res-up">+</button>
          </div>
        </div>
        <canvas id="vt-fenv-canvas" class="vt-adsr-canvas" style="width:100%;height:44px;display:block;flex-shrink:0;"></canvas>
        <div class="vt-smp-props" style="margin-top:2px;">
          <div class="vt-smp-prop"><span class="vt-lbl">ENV</span>
            <button class="vt-nudge" id="vt-fenv-amt-dn">−</button>
            <span class="vt-smp-numval" id="vt-fenv-amt-val">${smp.filter.envAmt>0?'+':''}${Math.round(smp.filter.envAmt)}Hz</span>
            <button class="vt-nudge" id="vt-fenv-amt-up">+</button>
          </div>
          <div class="vt-smp-prop"><span class="vt-lbl">A</span>
            <button class="vt-nudge" id="vt-fenv-a-dn">−</button>
            <span class="vt-smp-numval" id="vt-fenv-a-val">${(smp.filter.a*1000).toFixed(0)}ms</span>
            <button class="vt-nudge" id="vt-fenv-a-up">+</button>
          </div>
          <div class="vt-smp-prop"><span class="vt-lbl">D</span>
            <button class="vt-nudge" id="vt-fenv-d-dn">−</button>
            <span class="vt-smp-numval" id="vt-fenv-d-val">${(smp.filter.d*1000).toFixed(0)}ms</span>
            <button class="vt-nudge" id="vt-fenv-d-up">+</button>
          </div>
          <div class="vt-smp-prop"><span class="vt-lbl">S</span>
            <button class="vt-nudge" id="vt-fenv-s-dn">−</button>
            <span class="vt-smp-numval" id="vt-fenv-s-val">${(smp.filter.s*100).toFixed(0)}%</span>
            <button class="vt-nudge" id="vt-fenv-s-up">+</button>
          </div>
          <div class="vt-smp-prop"><span class="vt-lbl">R</span>
            <button class="vt-nudge" id="vt-fenv-r-dn">−</button>
            <span class="vt-smp-numval" id="vt-fenv-r-val">${(smp.filter.r*1000).toFixed(0)}ms</span>
            <button class="vt-nudge" id="vt-fenv-r-up">+</button>
          </div>
        </div>`;

        // Ensure endPoint
        if (smp.buffer && smp.endPoint <= smp.startPoint) smp.endPoint = smp.buffer.length;

        // Waveform editor
        const wfCanvas = document.getElementById('vt-wf');
        requestAnimationFrame(() => {
            _wfEditor = new WaveformEditor(wfCanvas, smp, (marker, pos) => {
                const up = id => { const el=document.getElementById(id); if(el) el.textContent=smp[{start:'startPoint',end:'endPoint',loopStart:'loopStart',loopEnd:'loopEnd'}[marker]||marker]; };
                ['vt-sp-val','vt-ls-val','vt-le-val','vt-ep-val'].forEach((id,i)=>{
                    const keys=['startPoint','loopStart','loopEnd','endPoint'];
                    const el=document.getElementById(id);if(el)el.textContent=smp[keys[i]];
                });
            });
            // Double-click canvas to reset zoom
            wfCanvas.addEventListener('dblclick', () => _wfEditor?.resetZoom());
            document.getElementById('vt-wf-zoom-reset')?.addEventListener('click', () => _wfEditor?.resetZoom());
        });

        // ADSR canvas editor
        requestAnimationFrame(() => {
            _adsrEditor = new AdsrEditor(
                document.getElementById('vt-adsr-canvas'), smp.adsr,
                '#00ff88', 1.0, 2.0, () => refreshAdsrNudges(smp));
            new AdsrEditor(
                document.getElementById('vt-fenv-canvas'), smp.filter,
                '#80c0ff', 1.0, 2.0, () => refreshFenvNudges(smp));
        });

        // Load controls
        document.getElementById('vt-sname').addEventListener('input', e => { smp.name=e.target.value; renderSampleList(); });
        document.getElementById('vt-load-url').addEventListener('click', async () => {
            const url=document.getElementById('vt-url').value.trim(); if(!url) return;
            getActx(); await sampler.loadFromUrl(smp, url); renderSampleList(); renderSampleEditor(slot);
        });
        document.getElementById('vt-smp-file').addEventListener('change', async e => {
            const f=e.target.files[0]; if(!f) return;
            getActx(); await sampler.loadFromFile(smp, f); renderSampleList(); renderSampleEditor(slot);
        });
        document.getElementById('vt-mic-start').addEventListener('click', async () => {
            if (_micRec && _micRec.state==='recording') { _micRec.stop(); setStatus('PROCESSING...'); return; }
            getActx();
            _micRec = await sampler.startMicRecord(smp, () => { _micRec=null; renderSampleList(); renderSampleEditor(slot); });
            renderSampleEditor(slot);
        });
        document.getElementById('vt-preview-smp')?.addEventListener('click', () => {
            getActx(); sampler.preview(smp, slot, smp.selfChokeOnly);
        });
        document.getElementById('vt-clear-smp')?.addEventListener('click', () => {
            smp.buffer=null; smp.name=''; renderSampleList(); renderSampleEditor(slot); setStatus('SAMPLE CLEARED.');
        });

        // Loop / ping-pong
        function updateLoopLabel() {
            const lbl = document.getElementById('vt-loop-mode-lbl');
            if (!lbl) return;
            lbl.textContent = smp.loop ? (smp.loopMode===1 ? 'PINGPONG' : 'FORWARD') : 'OFF';
            lbl.style.color = smp.loop ? (smp.loopMode===1 ? 'var(--ft-yellow)' : 'var(--ft-green)') : 'var(--ft-text3)';
            // Invalidate cached ping-pong buffer when loop mode changes
            for (const k of Object.keys(smp)) { if (k.startsWith('_ppBuf_')) delete smp[k]; }
        }
        document.getElementById('vt-loop-toggle').addEventListener('click', () => {
            smp.loop = !smp.loop;
            document.getElementById('vt-loop-toggle').classList.toggle('active', smp.loop);
            document.getElementById('vt-pingpong-toggle').classList.toggle('active', smp.loop && smp.loopMode===1);
            updateLoopLabel();
            _wfEditor?.draw();
        });
        document.getElementById('vt-pingpong-toggle').addEventListener('click', () => {
            smp.loopMode = smp.loopMode===1 ? 0 : 1;
            document.getElementById('vt-pingpong-toggle').classList.toggle('active', smp.loopMode===1);
            updateLoopLabel();
            // Invalidate ping-pong cache
            for (const k of Object.keys(smp)) { if (k.startsWith('_ppBuf_')) delete smp[k]; }
        });

        // Choke
        document.getElementById('vt-choke-grp').addEventListener('change', e => { smp.chokeGroup=parseInt(e.target.value); });
        document.getElementById('vt-self-choke-only').addEventListener('change', e => { smp.selfChokeOnly=e.target.checked; });

        // Base/vol/fine nudges
        function nudgeSmp(dnId, upId, valId, get, set, min, max, fmt) {
            const upd = () => { const el=document.getElementById(valId); if(el) el.textContent=fmt(get()); };
            document.getElementById(dnId)?.addEventListener('click',()=>{ set(Math.max(min,get()-1)); upd(); });
            document.getElementById(upId)?.addEventListener('click',()=>{ set(Math.min(max,get()+1)); upd(); });
        }
        nudgeSmp('vt-base-dn','vt-base-up','vt-base-val', ()=>smp.baseNote, v=>smp.baseNote=v, 0,119, noteName);
        nudgeSmp('vt-svol-dn','vt-svol-up','vt-svol-val', ()=>smp.volume,   v=>smp.volume=v,   0,64,   v=>v);
        nudgeSmp('vt-fine-dn','vt-fine-up','vt-fine-val', ()=>smp.finetune, v=>smp.finetune=v, -128,127, v=>v);

        // ADSR nudges
        function nudgeMs(dnId, upId, valId, get, set, minMs, maxMs) {
            const step = v => v < 50 ? 1 : v < 500 ? 10 : 50;
            const upd = () => { const el=document.getElementById(valId); if(el) el.textContent=Math.round(get()*1000)+'ms'; _adsrEditor?.draw(); };
            document.getElementById(dnId)?.addEventListener('click',()=>{ const cur=get()*1000; set(Math.max(minMs,cur-step(cur))/1000); upd(); });
            document.getElementById(upId)?.addEventListener('click',()=>{ const cur=get()*1000; set(Math.min(maxMs,cur+step(cur))/1000); upd(); });
        }
        nudgeMs('vt-adsr-a-dn','vt-adsr-a-up','vt-adsr-a-val', ()=>smp.adsr.a, v=>smp.adsr.a=v, 1,5000);
        nudgeMs('vt-adsr-d-dn','vt-adsr-d-up','vt-adsr-d-val', ()=>smp.adsr.d, v=>smp.adsr.d=v, 1,5000);
        nudgeSmp('vt-adsr-s-dn','vt-adsr-s-up','vt-adsr-s-val', ()=>Math.round(smp.adsr.s*100), v=>smp.adsr.s=v/100, 0,100, v=>v+'%');
        nudgeMs('vt-adsr-r-dn','vt-adsr-r-up','vt-adsr-r-val', ()=>smp.adsr.r, v=>smp.adsr.r=v, 1,10000);

        // Filter nudges
        document.getElementById('vt-filt-type').addEventListener('change', e => { smp.filter.type=e.target.value; });
        function nudgeHz(dnId, upId, valId, get, set, minHz, maxHz) {
            const step = v => v < 200 ? 10 : v < 2000 ? 50 : 500;
            const upd = () => { const el=document.getElementById(valId); if(el) el.textContent=Math.round(get())+'Hz'; };
            document.getElementById(dnId)?.addEventListener('click',()=>{ set(Math.max(minHz,get()-step(get()))); upd(); });
            document.getElementById(upId)?.addEventListener('click',()=>{ set(Math.min(maxHz,get()+step(get()))); upd(); });
        }
        nudgeHz('vt-filt-cut-dn','vt-filt-cut-up','vt-filt-cut-val', ()=>smp.filter.cutoff, v=>smp.filter.cutoff=v, 20,20000);
        nudgeSmp('vt-filt-res-dn','vt-filt-res-up','vt-filt-res-val', ()=>+(smp.filter.resonance.toFixed(1)), v=>smp.filter.resonance=v, 0.1,20, v=>v.toFixed(1));
        nudgeHz('vt-fenv-amt-dn','vt-fenv-amt-up','vt-fenv-amt-val', ()=>smp.filter.envAmt, v=>smp.filter.envAmt=v, -20000,20000);
        nudgeMs('vt-fenv-a-dn','vt-fenv-a-up','vt-fenv-a-val', ()=>smp.filter.a, v=>smp.filter.a=v, 1,5000);
        nudgeMs('vt-fenv-d-dn','vt-fenv-d-up','vt-fenv-d-val', ()=>smp.filter.d, v=>smp.filter.d=v, 1,5000);
        nudgeSmp('vt-fenv-s-dn','vt-fenv-s-up','vt-fenv-s-val', ()=>Math.round(smp.filter.s*100), v=>smp.filter.s=v/100, 0,100, v=>v+'%');
        nudgeMs('vt-fenv-r-dn','vt-fenv-r-up','vt-fenv-r-val', ()=>smp.filter.r, v=>smp.filter.r=v, 1,10000);
    }

    function refreshAdsrNudges(smp) {
        const set = (id,txt) => { const el=document.getElementById(id); if(el) el.textContent=txt; };
        set('vt-adsr-a-val', Math.round(smp.adsr.a*1000)+'ms');
        set('vt-adsr-d-val', Math.round(smp.adsr.d*1000)+'ms');
        set('vt-adsr-s-val', Math.round(smp.adsr.s*100)+'%');
        set('vt-adsr-r-val', Math.round(smp.adsr.r*1000)+'ms');
    }
    function refreshFenvNudges(smp) {
        const set = (id,txt) => { const el=document.getElementById(id); if(el) el.textContent=txt; };
        set('vt-fenv-a-val', Math.round(smp.filter.a*1000)+'ms');
        set('vt-fenv-d-val', Math.round(smp.filter.d*1000)+'ms');
        set('vt-fenv-s-val', Math.round(smp.filter.s*100)+'%');
        set('vt-fenv-r-val', Math.round(smp.filter.r*1000)+'ms');
    }

    // ── Graphical ADSR Editor ──────────────────────────────────
    // Draggable handles on a canvas. Mutates adsr object directly.
    // adsr = { a, d, s, r } where a/d/r are seconds, s is 0-1.
    // Features: exponential curve rendering, R handle, curve shape toggle.
    class AdsrEditor {
        constructor(canvas, adsr, col, totalSec, holdSec, onChange) {
            this.canvas   = canvas;
            this.adsr     = adsr;
            this.col      = col;
            this.totalSec = totalSec;
            this.holdSec  = holdSec;
            this.onChange = onChange;
            this._drag    = null;
            this.expCurve = true; // toggle between exponential and linear rendering

            canvas.addEventListener('mousedown',  e => this._down(e));
            window.addEventListener('mousemove',  e => this._move(e));
            window.addEventListener('mouseup',    () => this._up());
            // Right-click to toggle curve shape
            canvas.addEventListener('contextmenu', e => {
                e.preventDefault();
                this.expCurve = !this.expCurve;
                this.draw();
            });
            requestAnimationFrame(() => this.draw());
        }

        _pts() {
            const c = this.canvas;
            const W = c.clientWidth || 300;
            const H = c.clientHeight || 54;
            const { a, d, s, r } = this.adsr;
            const total = this.totalSec;
            const hold  = this.holdSec;
            const xA  = (a / total) * W;
            const xD  = xA + (d / total) * W;
            const xS2 = xD + (hold / total) * W;
            const xR  = Math.min(W - 2, xS2 + (r / total) * W);
            const yPeak = 4;
            const ySus  = H - 4 - (s * (H - 8));
            const yZero = H - 4;
            return { W, H, xA, xD, xS2, xR, yPeak, ySus, yZero };
        }

        // Draw an exponential-looking curve between two points using quadratic bezier
        _curveTo(ctx, x1, y1, x2, y2, concaveUp) {
            if (!this.expCurve) { ctx.lineTo(x2, y2); return; }
            // Control point pulled toward the "fast start / slow end" character
            const cpx = concaveUp ? x1 + (x2-x1)*0.15 : x1 + (x2-x1)*0.85;
            const cpy = concaveUp ? y2 : y1;
            ctx.quadraticCurveTo(cpx, cpy, x2, y2);
        }

        draw() {
            const canvas = this.canvas;
            if (!canvas.parentNode) return;
            const dpr  = window.devicePixelRatio || 1;
            const cssW = canvas.clientWidth  || 300;
            const cssH = canvas.clientHeight || 54;
            if (canvas.width !== Math.round(cssW*dpr)) {
                canvas.width  = Math.round(cssW*dpr);
                canvas.height = Math.round(cssH*dpr);
            }
            const ctx = canvas.getContext('2d');
            ctx.save(); ctx.scale(dpr, dpr);
            const { W, H, xA, xD, xS2, xR, yPeak, ySus, yZero } = this._pts();

            ctx.fillStyle = '#000018'; ctx.fillRect(0, 0, W, H);

            // Grid lines
            ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
            for (let y = H/4; y < H; y += H/4) {
                ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
            }

            // ── Fill under ADSR ──
            ctx.fillStyle = this.col + '1a';
            ctx.beginPath();
            ctx.moveTo(0, yZero);
            this._curveTo(ctx, 0, yZero, xA, yPeak, true);     // attack
            this._curveTo(ctx, xA, yPeak, xD, ySus, false);    // decay
            ctx.lineTo(xS2, ySus);                               // sustain
            this._curveTo(ctx, xS2, ySus, xR, yZero, false);   // release
            ctx.lineTo(0, yZero);
            ctx.closePath(); ctx.fill();

            // ── ADSR outline ──
            ctx.strokeStyle = this.col; ctx.lineWidth = 1.5;
            ctx.shadowColor = this.col; ctx.shadowBlur = 3;
            ctx.beginPath();
            ctx.moveTo(0, yZero);
            this._curveTo(ctx, 0, yZero, xA, yPeak, true);     // attack
            this._curveTo(ctx, xA, yPeak, xD, ySus, false);    // decay
            ctx.lineTo(xS2, ySus);                               // sustain
            this._curveTo(ctx, xS2, ySus, xR, yZero, false);   // release
            ctx.stroke();
            ctx.shadowBlur = 0;

            // ── Section labels ──
            ctx.font = '700 7px "Share Tech Mono",monospace';
            ctx.textBaseline = 'top'; ctx.fillStyle = this.col + '88';
            const labels = [
                { x: xA/2,              label: 'A' },
                { x: (xA+xD)/2,         label: 'D' },
                { x: (xD+xS2)/2,        label: 'S' },
                { x: Math.min(W-8, (xS2+xR)/2), label: 'R' },
            ];
            for (const { x, label } of labels) {
                ctx.textAlign = 'center'; ctx.fillText(label, x, 2);
            }

            // ── Curve mode indicator ──
            ctx.textAlign = 'right'; ctx.fillStyle = this.expCurve ? '#ffff0088' : '#ffffff44';
            ctx.fillText(this.expCurve ? 'EXP' : 'LIN', W - 2, 2);

            // ── Drag handles ──
            const handles = [
                { x: xA,  y: yPeak, key: 'a' },
                { x: xD,  y: ySus,  key: 'd' },
                { x: xS2, y: ySus,  key: 's' },
                { x: xR,  y: yZero, key: 'r' },
            ];
            for (const h of handles) {
                const active = this._drag === h.key;
                ctx.fillStyle   = active ? '#ffffff' : this.col;
                ctx.strokeStyle = '#000018'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.arc(h.x, h.y, active ? 5 : 4, 0, Math.PI*2);
                ctx.fill(); ctx.stroke();
                // Key label inside handle
                ctx.fillStyle    = active ? '#000000' : '#000018';
                ctx.font         = '700 6px "Share Tech Mono",monospace';
                ctx.textAlign    = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(h.key.toUpperCase(), h.x, h.y);
            }

            ctx.restore();
        }

        _frac(e) {
            const r = this.canvas.getBoundingClientRect();
            return { fx: Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),
                     fy: Math.max(0,Math.min(1,(e.clientY-r.top)/r.height)) };
        }

        _hitTest(fx, fy) {
            const { W, H, xA, xD, xS2, xR, yPeak, ySus, yZero } = this._pts();
            const pts = {
                a: [xA/W, yPeak/H],
                d: [xD/W, ySus/H],
                s: [xS2/W, ySus/H],
                r: [xR/W, yZero/H],
            };
            for (const [key,[px,py]] of Object.entries(pts)) {
                if (Math.hypot(fx-px, fy-py) < 0.06) return key;
            }
            return null;
        }

        _down(e) {
            if (e.button !== 0) return;
            const { fx, fy } = this._frac(e);
            this._drag = this._hitTest(fx, fy);
        }

        _move(e) {
            if (!this._drag) return;
            const { fx, fy } = this._frac(e);
            const adsr = this.adsr; const total = this.totalSec; const hold = this.holdSec;
            switch(this._drag) {
                case 'a': adsr.a = Math.max(0.0005, fx * total); break;
                case 'd': {
                    const aFrac = adsr.a / total;
                    adsr.d = Math.max(0.001, (fx - aFrac) * total);
                    adsr.s = Math.max(0, Math.min(1, 1 - fy));
                    break;
                }
                case 's': adsr.s = Math.max(0, Math.min(1, 1 - fy)); break;
                case 'r': {
                    const aFrac = adsr.a/total, dFrac = adsr.d/total, hFrac = hold/total;
                    adsr.r = Math.max(0.001, (fx - aFrac - dFrac - hFrac) * total);
                    break;
                }
            }
            this.draw(); this.onChange?.();
        }

        _up() { this._drag = null; }
    }

    // ── Keyboard ──────────────────────────────────────────────
    let _hexEntry = { field:'', val:0, digits:0, maxDigits:0, cb:null };

    function handleKeyDown(e) {
        if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
        if (document.querySelector('.vt-tab.active')?.dataset.tab !== 'pattern') return;

        const pat  = getEditPat();
        const rows = pat?.rows ?? DEF_ROWS;
        const key  = e.key.toLowerCase();

        if (e.code==='Space')     { e.preventDefault(); togglePlay(); return; }
        if (e.key==='Escape')     { stopPlay(); return; }
        if (e.key.match(/^F[1-8]$/)) { e.preventDefault(); curCh=parseInt(e.key.slice(1))-1; renderGrid();renderHeaders(); return; }
        if (e.ctrlKey) { if(key==='s'){e.preventDefault();saveSong();} return; }

        if (e.key==='ArrowUp')    { e.preventDefault(); moveRow(-1); return; }
        if (e.key==='ArrowDown')  { e.preventDefault(); moveRow(1);  return; }
        if (e.key==='ArrowLeft')  { e.preventDefault(); moveField(-1); return; }
        if (e.key==='ArrowRight') { e.preventDefault(); moveField(1);  return; }
        if (e.key==='Tab')        { e.preventDefault(); moveCh(e.shiftKey?-1:1); return; }
        if (e.key==='PageUp')     { e.preventDefault(); moveRow(-16); return; }
        if (e.key==='PageDown')   { e.preventDefault(); moveRow(16);  return; }
        if (e.key==='Home')       { e.preventDefault(); curRow=0; renderGrid();scrollToCursor(); return; }
        if (e.key==='End')        { e.preventDefault(); curRow=rows-1; renderGrid();scrollToCursor(); return; }
        if (e.key==='Delete'||e.key==='Backspace') { e.preventDefault(); clearCursorField(); moveRow(editStep); return; }
        if (e.key==='NumpadMultiply'||e.key==='*') { editOct=Math.min(8,editOct+1); octValEl.textContent=editOct; return; }
        if (e.key==='NumpadDivide'||e.key==='/') { editOct=Math.max(0,editOct-1); octValEl.textContent=editOct; return; }

        if (curField===0 && key in KEY_NOTE_MAP) {
            e.preventDefault();
            const semi=KEY_NOTE_MAP[key]; const octOff=semi>=12?1:0;
            placeNote((editOct+octOff)*12+(semi%12)); return;
        }
        if (curField===0 && (e.key==='`'||e.key==='NumpadDecimal')) {
            e.preventDefault();
            const cell=getCell(); cell.note=NOTE_OFF; cell.smp=cell.vol=cell.fx=cell.fxp=null;
            moveRow(editStep); renderGrid(); return;
        }
        if (curField===1 && /^[0-9a-fA-F]$/.test(e.key)) {
            e.preventDefault();
            enterHexField('smp',e.key,2,v=>{const i=Math.max(0,Math.min(NUM_SMP-1,v-1));getCell().smp=v===0?null:i;}); return;
        }
        if (curField===2 && /^[0-9a-fA-F]$/.test(e.key)) {
            e.preventDefault(); enterHexField('vol',e.key,2,v=>getCell().vol=Math.max(0,Math.min(63,v))); return;
        }
        if (curField===3 && /^[0-9a-fA-F]$/.test(e.key)) {
            e.preventDefault(); enterHexField('fx',e.key,1,v=>getCell().fx=v); return;
        }
        if (curField===4 && /^[0-9a-fA-F]$/.test(e.key)) {
            e.preventDefault(); enterHexField('fxp',e.key,2,v=>getCell().fxp=Math.min(255,v)); return;
        }
    }

    function enterHexField(field,key,maxDigits,cb) {
        if (_hexEntry.field!==field) _hexEntry={field,val:0,digits:0,maxDigits,cb};
        _hexEntry.val=(_hexEntry.val<<4)|parseInt(key,16); _hexEntry.digits++;
        _hexEntry.cb(_hexEntry.val);
        if (_hexEntry.digits>=_hexEntry.maxDigits) { _hexEntry={field:'',val:0,digits:0,maxDigits:0,cb:null}; moveRow(editStep); }
        renderGrid();
    }

    function placeNote(noteVal) {
        const cell=getCell(); cell.note=Math.max(0,Math.min(119,noteVal));
        if (activeSmpIdx>=0) cell.smp=activeSmpIdx;
        getActx();
        const smp=song.samples[activeSmpIdx];
        if (smp?.buffer) {
            const src=actx.createBufferSource(); src.buffer=smp.buffer;
            src.playbackRate.value=Math.pow(2,(noteVal-smp.baseNote)/12);
            const g=actx.createGain(); g.gain.value=0.5;
            src.connect(g); g.connect(masterGain);
            src.start(); src.stop(actx.currentTime+0.25);
        }
        moveRow(editStep); renderGrid();
    }

    function clearCursorField() {
        const cell=getCell();
        switch(curField) {
            case 0:cell.note=NOTE_NONE;cell.smp=cell.vol=cell.fx=cell.fxp=null;break;
            case 1:cell.smp=null;break; case 2:cell.vol=null;break;
            case 3:cell.fx=cell.fxp=null;break; case 4:cell.fxp=null;break;
        }
        renderGrid();
    }
    function moveRow(d){ const rows=getEditPat()?.rows??DEF_ROWS; curRow=((curRow+d)%rows+rows)%rows; renderGrid();scrollToCursor(); }
    function moveCh(d) { curCh=((curCh+d)%NUM_CH+NUM_CH)%NUM_CH; renderGrid();renderHeaders(); }
    function moveField(d){ curField=Math.max(0,Math.min(4,curField+d)); renderGrid(); }
    function getCell()   { const pat=getEditPat();if(!pat)return makeRow();return pat.data[curCh][curRow]; }
    function getEditPat(){ return song.patterns[curPat]??null; }

    // ── Transport wiring ──────────────────────────────────────
    function togglePlay(){ playState.playing?stopPlay():startPlay(false); }
    document.getElementById('vt-play').addEventListener('click',()=>{ if(playState.playing)stopPlay();else startPlay(false); });
    document.getElementById('vt-play-pat').addEventListener('click',()=>{ if(playState.playing)stopPlay();else startPlay(true); });
    document.getElementById('vt-stop').addEventListener('click',stopPlay);

    const bpmValEl2=document.getElementById('vt-bpm-val');
    const spdValEl2=document.getElementById('vt-spd-val');
    function updateBpmUI(){ bpmValEl2.textContent=song.bpm; }
    function updateSpeedUI(){ spdValEl2.textContent=song.speed; }
    document.getElementById('vt-bpm-dn').addEventListener('click',()=>{ song.bpm=Math.max(32,song.bpm-1);updateBpmUI(); });
    document.getElementById('vt-bpm-up').addEventListener('click',()=>{ song.bpm=Math.min(255,song.bpm+1);updateBpmUI(); });
    document.getElementById('vt-spd-dn').addEventListener('click',()=>{ song.speed=Math.max(1,song.speed-1);updateSpeedUI(); });
    document.getElementById('vt-spd-up').addEventListener('click',()=>{ song.speed=Math.min(31,song.speed+1);updateSpeedUI(); });
    document.getElementById('vt-oct-dn').addEventListener('click',()=>{ editOct=Math.max(0,editOct-1);octValEl.textContent=editOct; });
    document.getElementById('vt-oct-up').addEventListener('click',()=>{ editOct=Math.min(8,editOct+1);octValEl.textContent=editOct; });
    document.getElementById('vt-step-dn').addEventListener('click',()=>{ editStep=Math.max(0,editStep-1);stepValEl.textContent=editStep; });
    document.getElementById('vt-step-up').addEventListener('click',()=>{ editStep=Math.min(16,editStep+1);stepValEl.textContent=editStep; });

    document.getElementById('vt-pat-dn').addEventListener('click',()=>{
        curPat=Math.max(0,curPat-1); patValEl.textContent=curPat.toString().padStart(2,'0');
        renderGrid();renderHeaders();
    });
    document.getElementById('vt-pat-up').addEventListener('click',()=>{
        if(curPat>=song.patterns.length-1) song.patterns.push(makePattern(parseInt(document.getElementById('vt-rows-sel').value)));
        curPat=Math.min(song.patterns.length-1,curPat+1); patValEl.textContent=curPat.toString().padStart(2,'0');
        renderGrid();renderHeaders();
    });
    document.getElementById('vt-rows-sel').addEventListener('change',e=>{
        const pat=getEditPat();if(!pat)return;
        const rows=parseInt(e.target.value); const old=pat.rows; pat.rows=rows;
        for(let ch=0;ch<NUM_CH;ch++){
            if(rows>old){while(pat.data[ch].length<rows)pat.data[ch].push(makeRow());}
            else pat.data[ch].length=rows;
        }
        if(curRow>=rows)curRow=rows-1; renderGrid();
    });

    document.getElementById('vt-ord-add').addEventListener('click',()=>{ song.order.push(curPat);renderSong(); });
    document.getElementById('vt-ord-del').addEventListener('click',()=>{ if(song.order.length>1)song.order.pop();renderSong(); });
    document.getElementById('vt-ord-dup').addEventListener('click',()=>{ const i=song.order.indexOf(curPat);if(i>=0)song.order.splice(i+1,0,curPat);renderSong(); });
    document.getElementById('vt-newpat').addEventListener('click',()=>{ song.patterns.push(makePattern(DEF_ROWS));curPat=song.patterns.length-1;patValEl.textContent=curPat.toString().padStart(2,'0');renderSong();renderGrid();renderHeaders(); });
    document.getElementById('vt-clonepat').addEventListener('click',()=>{ const src=getEditPat();if(!src)return;const clone=JSON.parse(JSON.stringify(src));clone.id=uid();song.patterns.push(clone);curPat=song.patterns.length-1;patValEl.textContent=curPat.toString().padStart(2,'0');renderSong();renderGrid();renderHeaders(); });
    document.getElementById('vt-delpat').addEventListener('click',()=>{ if(song.patterns.length<=1){setStatus('CANNOT DELETE LAST PATTERN.');return;} song.patterns.splice(curPat,1);song.order=song.order.map(o=>o>=curPat?Math.max(0,o-1):o);curPat=Math.min(curPat,song.patterns.length-1);patValEl.textContent=curPat.toString().padStart(2,'0');renderSong();renderGrid();renderHeaders(); });

    // ── Tabs ──────────────────────────────────────────────────
    function switchTab(name) {
        document.querySelectorAll('.vt-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
        document.querySelectorAll('.vt-panel').forEach(p=>p.classList.toggle('active',p.id===`vt-panel-${name}`));
        if(name==='song')    renderSong();
        if(name==='samples'){ renderSampleList();renderSampleEditor(curSmpSlot); }
        if(name==='pattern'){ renderGrid();renderHeaders();gridEl.focus(); }
    }
    document.querySelectorAll('.vt-tab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));

    // ── Save / Load ───────────────────────────────────────────
    function saveSong() {
        const data = {
            bpm:song.bpm, speed:song.speed, order:song.order,
            patterns:song.patterns.map(p=>({id:p.id,rows:p.rows,data:p.data.map(ch=>ch.map(r=>({...r})))})),
            samples:song.samples.map(s=>({
                name:s.name,loop:s.loop,loopStart:s.loopStart,loopEnd:s.loopEnd,
                startPoint:s.startPoint,endPoint:s.endPoint,
                baseNote:s.baseNote,volume:s.volume,finetune:s.finetune,
                chokeGroup:s.chokeGroup,selfChokeOnly:s.selfChokeOnly,
            })),
        };
        const a=document.createElement('a');
        a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
        a.download='song.vtk'; a.click();
        setStatus('SONG SAVED.');
    }
    document.getElementById('vt-save').addEventListener('click',saveSong);
    document.getElementById('vt-load-btn').addEventListener('click',()=>document.getElementById('vt-load-file').click());
    document.getElementById('vt-load-file').addEventListener('change',async e=>{
        const f=e.target.files[0];if(!f)return;
        try {
            const data=JSON.parse(await f.text());
            song.bpm=data.bpm??DEF_BPM; song.speed=data.speed??DEF_SPEED;
            song.order=data.order??[0];
            song.patterns=(data.patterns??[makePattern()]).map(p=>({...p,id:p.id??uid()}));
            data.samples?.forEach((s,i)=>{ if(!song.samples[i])song.samples[i]=makeSample(); Object.assign(song.samples[i],s); song.samples[i].buffer=null; });
            curPat=0;curRow=0;curCh=0;
            updateBpmUI();updateSpeedUI();
            patValEl.textContent='00';
            renderGrid();renderHeaders();renderSong();renderSampleList();
            setStatus('LOADED. (Re-import audio — buffers not in .vtk)');
        } catch(err) { setStatus(`LOAD ERROR: ${err.message}`); }
    });

    // ── Keyboard handler attachment ───────────────────────────
    gridEl.tabIndex=0;
    gridEl.addEventListener('keydown',handleKeyDown);
    document.addEventListener('keydown',e=>{ if(document.querySelector('.vt-tab.active')?.dataset.tab==='pattern'&&document.activeElement!==gridEl)handleKeyDown(e); });

    // ── Utility ───────────────────────────────────────────────
    function setStatus(msg){ document.getElementById('vt-status-msg').textContent=msg; }

    // ── Init ──────────────────────────────────────────────────
    renderHeaders(); renderGrid(); renderSampleList(); renderSampleEditor(0);
    setStatus('READY.  Z-M/Q-U=NOTES · TAB=CH · SPACE=PLAY · F1-F8=CH');
    initScrollSync();
    requestAnimationFrame(drawScopes);
    setTimeout(()=>gridEl.focus(),100);
}
