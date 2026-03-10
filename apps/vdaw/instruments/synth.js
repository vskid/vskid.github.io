// ============================================================
//  instruments/synth.js — Polyphonic synth VST
//  Types: bass | lead | pad | pluck
// ============================================================

export const SYNTH_DEFAULTS = {
    bass:  { wave:'sawtooth', subMix:0.5,  drive:0.2,          octave:0 },
    lead:  { wave:'square',   detune:0,    vibratoRate:5,       vibratoDepth:0 },
    pad:   { wave:'sine',     chorusDepth:0.3, chorusRate:0.8,  reverbSend:0.4 },
    pluck: { decay:0.9,       tone:0.5 },
};

function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function distCurve(amount) {
    const s = 256, c = new Float32Array(s);
    for (let i = 0; i < s; i++) {
        const x = (i * 2) / s - 1;
        c[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
    }
    return c;
}

// ── Shared DSP helpers — exported so vdaw.js can import them ─
export function makeAmpEnv(ctx, amp, vol, t, dur) {
    const g = ctx.createGain();
    const atk = amp.attack / 1000, dec = amp.decay / 1000;
    const sus = amp.sustain / 100 * vol, rel = amp.release / 1000;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + atk);
    g.gain.linearRampToValueAtTime(sus, t + atk + dec);
    g.gain.setValueAtTime(sus, t + Math.max(atk + dec + 0.001, dur - rel));
    g.gain.linearRampToValueAtTime(0.0001, t + dur + rel);
    return g;
}

export function makeFilterNode(ctx, f, t, dur) {
    const node = ctx.createBiquadFilter();
    node.type = f.type;
    node.frequency.value = f.cutoff;
    node.Q.value = f.resonance;
    if (f.envDepth !== 0) {
        const depth = f.envDepth / 100, atk = f.attack / 1000, dec = f.decay / 1000;
        const sus = f.sustain / 100, rel = f.release / 1000, base = f.cutoff;
        const peak = base + depth * (depth > 0 ? (20000 - base) : base);
        node.frequency.setValueAtTime(base, t);
        node.frequency.linearRampToValueAtTime(peak, t + atk);
        node.frequency.linearRampToValueAtTime(base + (peak - base) * sus, t + atk + dec);
        const ne = t + Math.max(atk + dec + 0.001, dur - rel);
        node.frequency.setValueAtTime(base + (peak - base) * sus, ne);
        node.frequency.linearRampToValueAtTime(base, ne + rel);
    }
    return node;
}

// ── Slide scheduler helper ───────────────────────────────────
// Schedules a pitch glide onto an AudioParam given an optional slideTarget note.
function scheduleSlide(freqParam, fromFreq, t, slideTarget, noteStartBeat, bpm, octaveShift = 0) {
    if (!slideTarget) return;
    const targetFreq = midiToHz(slideTarget.pitch + (octaveShift || 0));
    const slideStart = t + (slideTarget.startBeat - noteStartBeat) * (60 / bpm);
    const slideDur   = slideTarget.lengthBeats * (60 / bpm);
    freqParam.setValueAtTime(fromFreq, slideStart);
    freqParam.linearRampToValueAtTime(targetFreq, slideStart + slideDur);
}

// ── Synth functions (all slide-aware) ────────────────────────

/**
 * @param {number} bpm  — required for slide timing calculation
 */
export function synthBass(ctx, ins, amp, filter, note, vol, t, dur, slideTarget, dest, bpm) {
    const octShift = (ins.octave || 0) * 12;
    const freq = midiToHz(note.pitch + octShift);
    const osc  = ctx.createOscillator();
    osc.type   = ins.wave || 'sawtooth';
    osc.frequency.setValueAtTime(freq, t);
    scheduleSlide(osc.frequency, freq, t, slideTarget, note.startBeat, bpm, octShift);

    if (ins.subMix > 0) {
        const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = freq / 2;
        const sg  = ctx.createGain(); sg.gain.value = ins.subMix;
        const fN  = makeFilterNode(ctx, filter, t, dur);
        const gN  = makeAmpEnv(ctx, amp, vol, t, dur);
        sub.connect(sg); sg.connect(fN); fN.connect(gN); gN.connect(dest);
        sub.start(t); sub.stop(t + dur + amp.release / 1000 + 0.05);
    }
    let chain = osc;
    if (ins.drive > 0) {
        const ws = ctx.createWaveShaper();
        ws.curve = distCurve(ins.drive * 400); ws.oversample = '4x';
        osc.connect(ws); chain = ws;
    }
    const fN = makeFilterNode(ctx, filter, t, dur);
    const gN = makeAmpEnv(ctx, amp, vol, t, dur);
    chain.connect(fN); fN.connect(gN); gN.connect(dest);
    osc.start(t); osc.stop(t + dur + amp.release / 1000 + 0.05);
}

export function synthLead(ctx, ins, amp, filter, note, vol, t, dur, slideTarget, dest, bpm) {
    const freq = midiToHz(note.pitch);
    const osc  = ctx.createOscillator(); osc.type = ins.wave || 'square';
    osc.frequency.setValueAtTime(freq, t);
    scheduleSlide(osc.frequency, freq, t, slideTarget, note.startBeat, bpm);

    if (ins.detune > 0) {
        const o2 = ctx.createOscillator(); o2.type = ins.wave || 'square';
        o2.frequency.value = freq; o2.detune.value = ins.detune;
        const f2 = makeFilterNode(ctx, filter, t, dur);
        const g2 = makeAmpEnv(ctx, amp, vol * 0.5, t, dur);
        o2.connect(f2); f2.connect(g2); g2.connect(dest);
        o2.start(t); o2.stop(t + dur + amp.release / 1000 + 0.05);
    }
    if (ins.vibratoDepth > 0) {
        const lfo = ctx.createOscillator(); const lg = ctx.createGain();
        lfo.frequency.value = ins.vibratoRate || 5; lg.gain.value = ins.vibratoDepth;
        lfo.connect(lg); lg.connect(osc.frequency);
        lfo.start(t + 0.08); lfo.stop(t + dur + 0.1);
    }
    const fN = makeFilterNode(ctx, filter, t, dur);
    const gN = makeAmpEnv(ctx, amp, vol, t, dur);
    osc.connect(fN); fN.connect(gN); gN.connect(dest);
    osc.start(t); osc.stop(t + dur + amp.release / 1000 + 0.05);
}

export function synthPad(ctx, ins, amp, filter, note, vol, t, dur, slideTarget, dest, reverbNode, bpm) {
    const freq = midiToHz(note.pitch);
    const fN   = makeFilterNode(ctx, filter, t, dur);
    const gN   = makeAmpEnv(ctx, amp, vol, t, dur);
    if (ins.reverbSend > 0 && reverbNode) {
        const sg = ctx.createGain(); sg.gain.value = ins.reverbSend;
        fN.connect(sg); sg.connect(reverbNode);
    }
    fN.connect(gN); gN.connect(dest);
    for (let i = 0; i < 4; i++) {
        const osc = ctx.createOscillator(); osc.type = ins.wave || 'sine';
        osc.frequency.value = freq;
        osc.detune.value = (i - 1.5) * (ins.chorusDepth || 0.3) * 15;
        scheduleSlide(osc.frequency, freq, t, slideTarget, note.startBeat, bpm);
        osc.connect(fN); osc.start(t); osc.stop(t + dur + amp.release / 1000 + 0.1);
    }
}

export function synthPluck(ctx, ins, amp, filter, note, vol, t, dest) {
    const freq   = midiToHz(note.pitch);
    const period = Math.round(ctx.sampleRate / freq);
    const len    = Math.ceil(ctx.sampleRate * 4);
    const buf    = ctx.createBuffer(1, len, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < period; i++) data[i] = (Math.random() * 2 - 1) * vol;
    const decay = ins.decay || 0.9, tone = ins.tone || 0.5;
    for (let i = period; i < len; i++)
        data[i] = (data[i - period] * (1 - tone) + data[i - period + 1] * tone) * decay;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const fN  = makeFilterNode(ctx, filter, t, 4);
    const g   = ctx.createGain(); g.gain.value = 1;
    src.connect(fN); fN.connect(g); g.connect(dest);
    src.start(t); src.stop(t + 4.1);
}

// ── Panel HTML builders ──────────────────────────────────────

function waveButtons(cur) {
    return [['sine','∿'],['square','⊓'],['sawtooth','⟋'],['triangle','⋀']]
        .map(([w,s]) => `<button class="vdaw-wave-btn${w===cur?' active':''}" data-wave="${w}">${s}</button>`)
        .join('');
}

export function buildBassPanel(ins) {
    return `<div class="vdaw-wave-row"><span class="vdaw-lbl">WAVE</span>
      <div class="vdaw-wave-sel">${waveButtons(ins.wave)}</div></div>
    <div class="vst-knob-row">
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="subMix" data-min="0" data-max="100" data-val="${(ins.subMix||0)*100}" data-unit="%"></canvas><span>SUB</span></div>
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="drive"  data-min="0" data-max="100" data-val="${(ins.drive||0)*100}"  data-unit="%"></canvas><span>DRIVE</span></div>
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="octave" data-min="-2" data-max="2"  data-val="${ins.octave||0}"         data-unit="oct"></canvas><span>OCT</span></div>
    </div>`;
}

export function buildLeadPanel(ins) {
    return `<div class="vdaw-wave-row"><span class="vdaw-lbl">WAVE</span>
      <div class="vdaw-wave-sel">${waveButtons(ins.wave)}</div></div>
    <div class="vst-knob-row">
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="detune"       data-min="0"  data-max="100" data-val="${ins.detune||0}"       data-unit="ct"></canvas><span>DETUNE</span></div>
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="vibratoRate"  data-min="0"  data-max="20"  data-val="${ins.vibratoRate||5}"   data-unit="Hz"></canvas><span>VIB.RT</span></div>
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="vibratoDepth" data-min="0"  data-max="100" data-val="${ins.vibratoDepth||0}"  data-unit="ct"></canvas><span>VIB.DP</span></div>
    </div>`;
}

export function buildPadPanel(ins) {
    return `<div class="vdaw-wave-row"><span class="vdaw-lbl">WAVE</span>
      <div class="vdaw-wave-sel">${waveButtons(ins.wave)}</div></div>
    <div class="vst-knob-row">
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="chorusDepth" data-min="0" data-max="100" data-val="${(ins.chorusDepth||0.3)*100}" data-unit="%"></canvas><span>CHO.D</span></div>
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="chorusRate"  data-min="0" data-max="10"  data-val="${ins.chorusRate||0.8}"         data-unit="Hz"></canvas><span>CHO.R</span></div>
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="reverbSend"  data-min="0" data-max="100" data-val="${(ins.reverbSend||0.4)*100}"   data-unit="%"></canvas><span>REVB</span></div>
    </div>`;
}

export function buildPluckPanel(ins) {
    return `<div class="vst-knob-row">
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="decay" data-min="0" data-max="100" data-val="${(ins.decay||0.9)*100}" data-unit="%"></canvas><span>DECAY</span></div>
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="tone"  data-min="0" data-max="100" data-val="${(ins.tone||0.5)*100}"   data-unit="%"></canvas><span>TONE</span></div>
    </div>`;
}

export function normalizeSynthParam(key, v) {
    const pct01 = ['subMix','drive','chorusDepth','reverbSend'];
    const raw01 = ['decay','tone']; // pluck
    if (pct01.includes(key)) return v / 100;
    if (raw01.includes(key)) return v / 100;
    return v;
}
