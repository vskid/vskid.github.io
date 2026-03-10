// ============================================================
//  instruments/drums.js — Drum synthesizer VST
//  Types: kick | snare | hihat | perc
// ============================================================

export const DRUM_DEFAULTS = {
    kick:  { pitch:60,  pitchDecay:200, noiseMix:0.10, decay:250 },
    snare: { pitch:200, pitchDecay:80,  noiseMix:0.80, decay:180 },
    hihat: { pitch:8000,pitchDecay:20,  noiseMix:1.00, decay:80  },
    perc:  { pitch:400, pitchDecay:100, noiseMix:0.30, decay:200 },
};

/**
 * Render drum hit into Web Audio graph.
 * @param {AudioContext} ctx
 * @param {string}       type        kick|snare|hihat|perc
 * @param {object}       ins         instrument params
 * @param {object}       note        piano-roll note (note.pitch used as pitch multiplier)
 * @param {number}       vol         0..1
 * @param {number}       t           AudioContext timestamp
 * @param {AudioNode}    dest        output node
 * @param {object|null}  slideTarget optional slide note for pitch glide
 * @param {number}       bpm         required when slideTarget is provided
 */
export function synthDrum(ctx, type, ins, note, vol, t, dest, slideTarget, bpm) {
    const pitchRatio = Math.pow(2, (note.pitch - 60) / 12);
    const basePitch  = ins.pitch * pitchRatio;

    const dur = ins.decay / 1000 + 0.05;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(dest);

    // Tonal oscillator component
    if (ins.noiseMix < 1.0) {
        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(basePitch, t);
        osc.frequency.exponentialRampToValueAtTime(
            basePitch * 0.3, t + ins.pitchDecay / 1000
        );
        // Slide: glide to target pitch
        if (slideTarget && bpm) {
            const targetPitch = ins.pitch * Math.pow(2, (slideTarget.pitch - 60) / 12);
            const slideStart  = t + (slideTarget.startBeat - note.startBeat) * (60 / bpm);
            const slideDur    = slideTarget.lengthBeats * (60 / bpm);
            osc.frequency.setValueAtTime(basePitch, slideStart);
            osc.frequency.linearRampToValueAtTime(targetPitch, slideStart + slideDur);
        }
        const og = ctx.createGain();
        og.gain.value = 1 - ins.noiseMix;
        osc.connect(og); og.connect(g);
        osc.start(t); osc.stop(t + dur + 0.05);
    }

    // Noise component
    if (ins.noiseMix > 0) {
        const len = Math.ceil(ctx.sampleRate * (dur + 0.05));
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d   = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

        const src = ctx.createBufferSource(); src.buffer = buf;
        const f   = ctx.createBiquadFilter();
        f.type      = type === 'hihat' ? 'highpass' : 'bandpass';
        f.frequency.value = basePitch;
        f.Q.value   = 0.8;
        const ng = ctx.createGain(); ng.gain.value = ins.noiseMix;
        src.connect(f); f.connect(ng); ng.connect(g);
        src.start(t); src.stop(t + dur + 0.06);
    }
}

/** Build the instrument-panel HTML for a drum track. */
export function buildDrumPanel(ins) {
    return `<div class="vst-knob-row">
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="pitch"
        data-min="20" data-max="2000" data-val="${ins.pitch||200}" data-unit="Hz" data-log="1"></canvas><span>PITCH</span></div>
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="pitchDecay"
        data-min="10" data-max="500" data-val="${ins.pitchDecay||150}" data-unit="ms"></canvas><span>P.DEC</span></div>
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="noiseMix"
        data-min="0" data-max="100" data-val="${(ins.noiseMix||0)*100}" data-unit="%"></canvas><span>NOISE</span></div>
      <div class="vst-kc"><canvas class="vdaw-knob vdaw-ik skeu-knob" data-ikey="decay"
        data-min="10" data-max="1000" data-val="${ins.decay||200}" data-unit="ms"></canvas><span>DECAY</span></div>
    </div>`;
}

export function normalizeDrumParam(key, v) {
    const pct01 = ['noiseMix'];
    return pct01.includes(key) ? v / 100 : v;
}
