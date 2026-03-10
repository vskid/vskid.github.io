// ============================================================
//  effects/compressor.js — Master bus compressor + gain VST
// ============================================================

export const COMPRESSOR_DEFAULTS = {
    threshold: -24, ratio: 4, knee: 10,
    attack: 10, release: 150, makeup: 6, volume: 80,
};

/**
 * Apply compressor settings to existing Web Audio nodes.
 * @param {DynamicsCompressorNode} compNode
 * @param {GainNode}               masterGain
 * @param {object}                 m   master params
 */
export function applyCompressor(compNode, masterGain, m) {
    if (!compNode) return;
    compNode.threshold.value = m.threshold;
    compNode.ratio.value     = m.ratio;
    compNode.knee.value      = m.knee;
    compNode.attack.value    = m.attack  / 1000;
    compNode.release.value   = m.release / 1000;
    if (masterGain)
        masterGain.gain.value = Math.pow(10, m.makeup / 20) * (m.volume / 100) * 0.85;
}

/** Build the master compressor panel HTML. */
export function buildCompressorPanel() {
    return `<div class="vdaw-sec-body" style="padding:10px 10px 16px">
      <div class="vst-knob-row">
        <div class="vst-kc"><canvas class="vdaw-knob skeu-knob" data-param="master.threshold"
          data-min="-60" data-max="0"    data-val="-24" data-unit="dB"></canvas><span>THR</span></div>
        <div class="vst-kc"><canvas class="vdaw-knob skeu-knob" data-param="master.ratio"
          data-min="1"   data-max="20"   data-val="4"   data-unit=":1"></canvas><span>RAT</span></div>
        <div class="vst-kc"><canvas class="vdaw-knob skeu-knob" data-param="master.knee"
          data-min="0"   data-max="40"   data-val="10"  data-unit="dB"></canvas><span>KNEE</span></div>
        <div class="vst-kc"><canvas class="vdaw-knob skeu-knob" data-param="master.attack"
          data-min="0"   data-max="200"  data-val="10"  data-unit="ms"></canvas><span>ATK</span></div>
        <div class="vst-kc"><canvas class="vdaw-knob skeu-knob" data-param="master.release"
          data-min="10"  data-max="1000" data-val="150" data-unit="ms"></canvas><span>REL</span></div>
        <div class="vst-kc"><canvas class="vdaw-knob skeu-knob" data-param="master.makeup"
          data-min="0"   data-max="24"   data-val="6"   data-unit="dB"></canvas><span>MKP</span></div>
      </div>
    </div>`;
}
