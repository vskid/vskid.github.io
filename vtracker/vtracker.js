'use strict';
// ============================================================
// vTracker — FT2-style sample tracker, macOS Aqua UI
// 8 channels, 32 instrument slots (each with 1 sample for now)
// Web Audio engine with full envelope + LFO per instrument
// ============================================================

// ── Constants ─────────────────────────────────────────────────
const NUM_CH    = 8;
const NUM_INST  = 32;
const DEF_ROWS  = 64;
const DEF_BPM   = 125;
const DEF_SPEED = 6;
const LOOKAHEAD = 0.12; // seconds
const TICK_MS   = 2.5;

const NOTE_OFF  = 254;
const NOTE_NONE = 255;
const NOTE_NAMES = ['C-','C#','D-','D#','E-','F-','F#','G-','G#','A-','A#','B-'];

const CH_COLOURS = ['#80ffff','#80ff80','#ffff80','#ff8080','#80c0ff','#ff80ff','#80ffb0','#ffb080'];

// Piano keyboard map (FT2 standard)
const KEY_NOTE = {
  'z':0,'s':1,'x':2,'d':3,'c':4,'v':5,'g':6,'b':7,'h':8,'n':9,'j':10,'m':11,
  'q':12,'2':13,'w':14,'3':15,'e':16,'r':17,'5':18,'t':19,'6':20,'y':21,'7':22,'u':23,
};

// ── Helpers ───────────────────────────────────────────────────
function uid()       { return Math.random().toString(36).slice(2,9); }
function noteName(n) {
  if (n === NOTE_OFF)  return '===';
  if (n === NOTE_NONE) return '---';
  return NOTE_NAMES[n % 12] + Math.floor(n / 12);
}
function hexByte(v)   { return v == null ? '--' : v.toString(16).toUpperCase().padStart(2,'0'); }
function hexNibble(v) { return v == null ? '-'  : v.toString(16).toUpperCase(); }

// ── Song state ────────────────────────────────────────────────
let song = makeSong();
let curPat   = 0;
let curRow   = 0;
let curCh    = 0;
let curField = 0; // 0=note 1=inst 2=vol 3=fx 4=fxp
let editMode = false;
let sel = null; // { startCh, startRow, endCh, endRow } or null — block selection
let clipboard = null; // { w, h, data: [[cell,...], ...] } — copied block
let editOct  = 4;
let editAdd  = 1;
let curInstSlot = 0;
let curSmpSlot  = 0;

function makeSong() {
  return {
    bpm:      DEF_BPM,
    speed:    DEF_SPEED,
    order:    [0],
    patterns: [makePattern(DEF_ROWS)],
    instruments: Array.from({length: NUM_INST}, () => makeInstrument()),
  };
}

function makePattern(rows = DEF_ROWS) {
  return {
    id: uid(), rows,
    data: Array.from({length: NUM_CH}, () =>
      Array.from({length: rows}, makeCell)),
  };
}

function makeCell() {
  return { note: NOTE_NONE, inst: null, vol: null, fx: null, fxp: null };
}

function makeInstrument() {
  return {
    name: '',
    // Sample
    buffer: null,
    loop: false, loopMode: 0, // 0=fwd 1=pingpong
    loopStart: 0, loopEnd: 0,
    startPoint: 0, endPoint: 0,
    baseNote: 48, volume: 64, finetune: 0,
    // Volume envelope
    volEnv: makeADSR(),
    // Filter
    filter: { type: 'lowpass', cutoff: 20000, resonance: 0.7 },
    filtEnv: makeADSR(),
    // Vibrato LFO (pitch)
    vibrato: { wave: 'sine', speed: 0, depth: 0 },
    // Tremolo LFO (volume)
    tremolo: { wave: 'sine', speed: 0, depth: 0 },
    // Panning LFO
    panLFO:  { wave: 'sine', speed: 0, depth: 0 },
  };
}

function makeADSR() {
  return { a: 0.002, d: 0.1, s: 1.0, r: 0.2 };
}

// ── Audio context ─────────────────────────────────────────────
let actx = null, masterGain = null, masterCompressor = null;
let analysers    = Array(NUM_CH).fill(null);
let chGainNodes  = Array(NUM_CH).fill(null);  // per-channel volume
let chPanNodes   = Array(NUM_CH).fill(null);  // per-channel pan
let chMuted      = Array(NUM_CH).fill(false); // mute state
// Mixer state (persists in song)
const mixerState = {
  chVol: Array.from({length: NUM_CH}, () => 1.0),  // 0..2
  chPan: Array.from({length: NUM_CH}, () => 0.0),  // -1..1
  chMute: Array(NUM_CH).fill(false),
  compressor: { threshold: -18, ratio: 4, attack: 0.003, release: 0.25, makeupGain: 1.0, enabled: true }
};

function getActx() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return actx; }
  actx = new (window.AudioContext || window.webkitAudioContext)();

  // Master chain: masterGain → compressor → destination
  masterGain = actx.createGain();
  masterGain.gain.value = 0.8;

  masterCompressor = actx.createDynamicsCompressor();
  const mc = mixerState.compressor;
  masterCompressor.threshold.value = mc.threshold;
  masterCompressor.ratio.value     = mc.ratio;
  masterCompressor.attack.value    = mc.attack;
  masterCompressor.release.value   = mc.release;

  const makeupNode = actx.createGain();
  makeupNode.gain.value = mc.makeupGain;
  masterGain.connect(masterCompressor);
  masterCompressor.connect(makeupNode);
  makeupNode.connect(actx.destination);

  // Per-channel: analyser → chPan → chGain → masterGain
  for (let ch = 0; ch < NUM_CH; ch++) {
    const an  = actx.createAnalyser();
    an.fftSize = 512; an.smoothingTimeConstant = 0.5;

    const pan = actx.createStereoPanner();
    pan.pan.value = mixerState.chPan[ch];

    const gain = actx.createGain();
    gain.gain.value = mixerState.chMute[ch] ? 0 : mixerState.chVol[ch];

    an.connect(pan); pan.connect(gain); gain.connect(masterGain);
    analysers[ch]   = an;
    chPanNodes[ch]  = pan;
    chGainNodes[ch] = gain;
  }
  return actx;
}

// ── Voice management ──────────────────────────────────────────
// One voice per channel. New note cuts old (FT2 behavior).
const voices = Array.from({length: NUM_CH}, () => ({
  node: null, gainNode: null, panNode: null, filtNode: null,
  lfoNodes: [],
  instIdx: 0, note: NOTE_NONE,
  adsrPhaseStart: null, adsrReleased: false,
  // FX state — persists across rows
  portaTarget: 0,      // target playbackRate for 3xx tone portamento
  portaSpeed:  0,      // speed stored from last 3xx
  sampleOffset: 0,     // 9xx — samples to offset start by
  patVibPhase:  0,     // 4xy pattern vibrato phase accumulator
  patTremPhase: 0,     // 7xy pattern tremolo phase accumulator
}));

// Per-channel pattern loop state (E6x)
const chLoopStart = new Int32Array(NUM_CH).fill(-1); // row index of E60, -1=unset
const chLoopCount = new Uint8Array(NUM_CH);           // remaining repeats

// Global pattern delay counter (EEx) — extra rows to hold before advancing
let patternDelay = 0;

function stopVoice(ch) {
  const v = voices[ch];
  if (v.node) {
    try { v.node.stop(); } catch(_) {}
    v.node = null;
  }
  v.lfoNodes.forEach(l => { try { l.osc.stop(); } catch(_) {} });
  v.lfoNodes = [];
  v.gainNode = null; v.panNode = null; v.filtNode = null;
}

function triggerNote(ch, instIdx, note, vol, atTime) {
  const ctx2 = getActx();
  stopVoice(ch);
  if (note === NOTE_OFF || note === NOTE_NONE) return;

  const inst = song.instruments[instIdx];
  if (!inst?.buffer) return;

  // ── Build node graph ─────────────────────────────────────
  // src → gain(volume ADSR) → filter → pan → analyser → master

  // Build sample buffer (handle pingpong)
  let playBuf = inst.buffer;
  if (inst.loop && inst.loopMode === 1 && inst.loopEnd > inst.loopStart) {
    playBuf = buildPingPong(inst);
  }

  const src = ctx2.createBufferSource();
  src.buffer = playBuf;
  const semitones = note - inst.baseNote + (inst.finetune || 0) / 100;
  src.playbackRate.value = Math.pow(2, semitones / 12);

  // Loop setup — all positions are sample indices within inst.buffer
  // startPoint/endPoint define the playable region; loopStart/loopEnd define the loop within it
  if (inst.loop && inst.loopEnd > inst.loopStart) {
    const sr = inst.buffer.sampleRate;
    // Clamp loop region to the playable region
    const ls = Math.max(inst.startPoint, inst.loopStart);
    const le = Math.min(inst.endPoint > 0 ? inst.endPoint : inst.buffer.length, inst.loopEnd);
    if (le > ls + 4) { // need at least a few samples to loop
      src.loop = true;
      if (inst.loopMode === 1) {
        // Ping-pong: playBuf is baked buffer; loopStart..loopStart+2*segLen is the doubled region
        const ppSr  = playBuf.sampleRate;
        const segLen = inst.loopEnd - inst.loopStart; // original seg length
        src.loopStart = inst.loopStart / ppSr;
        src.loopEnd   = (inst.loopStart + segLen * 2) / ppSr;
      } else {
        // Forward: loop exactly ls..le
        src.loopStart = ls / sr;
        src.loopEnd   = le / sr;
      }
    }
  }

  // Volume gain
  const gainNode = ctx2.createGain();
  const baseVol  = volCurve(inst.volume / 128) * 2.0 * volCurve((vol ?? 64) / 64);
  applyADSR(gainNode.gain, inst.volEnv, baseVol, atTime, ctx2);

  // Filter
  let filtNode = null;
  if (inst.filter.type !== 'off') {
    filtNode = ctx2.createBiquadFilter();
    filtNode.type = inst.filter.type;
    filtNode.frequency.value = Math.min(inst.filter.cutoff, ctx2.sampleRate / 2 - 1);
    filtNode.Q.value = Math.max(0.001, inst.filter.resonance);
    // Filter envelope modulates cutoff
    const { a, d, s, r } = inst.filtEnv;
    const fc = inst.filter.cutoff;
    filtNode.frequency.cancelScheduledValues(atTime);
    filtNode.frequency.setValueAtTime(fc, atTime);
    filtNode.frequency.linearRampToValueAtTime(Math.min(ctx2.sampleRate/2-1, fc * 1.5), atTime + Math.max(0.001, a));
    filtNode.frequency.linearRampToValueAtTime(Math.min(ctx2.sampleRate/2-1, fc * (0.5 + s * 0.5)), atTime + Math.max(0.001, a) + Math.max(0.001, d));
  }

  // Pan
  const panNode = ctx2.createStereoPanner();
  panNode.pan.value = 0;

  // Connect chain
  src.connect(gainNode);
  if (filtNode) { gainNode.connect(filtNode); filtNode.connect(panNode); }
  else           { gainNode.connect(panNode); }
  panNode.connect(analysers[ch] ?? masterGain);

  // Start playback at startPoint (+ 9xx offset)
  const prevOffset   = voices[ch].sampleOffset ?? 0;
  const prevVibPh    = voices[ch].patVibPhase  ?? 0;
  const prevTremPh   = voices[ch].patTremPhase ?? 0;
  const prevPortaSpd = voices[ch].portaSpeed   ?? 0;
  const sr0      = inst.buffer.sampleRate;
  const startSec = Math.max(0, ((inst.startPoint || 0) + prevOffset) / sr0);
  if (inst.loop) {
    // Looping: start at startPoint, no duration limit — loop region handles wrap
    src.start(atTime, startSec);
  } else {
    // One-shot: play startPoint..endPoint exactly
    const ep     = inst.endPoint > inst.startPoint ? inst.endPoint : inst.buffer.length;
    const durSec = Math.max(0.001, (ep - (inst.startPoint || 0)) / sr0);
    src.start(atTime, startSec, durSec);
  }

  // ── LFOs ───────────────────────────────────────────────────
  const lfoNodes = [];

  // Vibrato — modulates playbackRate
  if (inst.vibrato.depth > 0 && inst.vibrato.speed > 0) {
    const vib = makeLFO(ctx2, inst.vibrato, atTime);
    const vibGain = ctx2.createGain();
    vibGain.gain.value = inst.vibrato.depth * 0.01;
    vib.connect(vibGain); vibGain.connect(src.playbackRate);
    lfoNodes.push({ osc: vib, gain: vibGain });
  }

  // Tremolo — modulates gainNode
  if (inst.tremolo.depth > 0 && inst.tremolo.speed > 0) {
    const trem = makeLFO(ctx2, inst.tremolo, atTime);
    const tremGain = ctx2.createGain();
    tremGain.gain.value = inst.tremolo.depth * 0.3;
    trem.connect(tremGain); tremGain.connect(gainNode.gain);
    lfoNodes.push({ osc: trem, gain: tremGain });
  }

  // Panning LFO
  if (inst.panLFO.depth > 0 && inst.panLFO.speed > 0) {
    const panLFO = makeLFO(ctx2, inst.panLFO, atTime);
    const panGain = ctx2.createGain();
    panGain.gain.value = inst.panLFO.depth * 0.01;
    panLFO.connect(panGain); panGain.connect(panNode.pan);
    lfoNodes.push({ osc: panLFO, gain: panGain });
  }

  voices[ch] = { node: src, gainNode, panNode, filtNode, lfoNodes, instIdx, note,
                  adsrPhaseStart: atTime, adsrReleased: false,
                  portaTarget: src.playbackRate.value,
                  portaSpeed: prevPortaSpd,
                  sampleOffset: 0,
                  patVibPhase: prevVibPh,
                  patTremPhase: prevTremPh,
               };
}

function releaseNote(ch, atTime) {
  const v = voices[ch];
  if (!v.gainNode) return;
  const inst = song.instruments[v.instIdx];
  const r = inst?.volEnv?.r ?? 0.1;
  const cur = v.gainNode.gain.value || 0.0001;
  v.gainNode.gain.cancelScheduledValues(atTime);
  v.gainNode.gain.setValueAtTime(Math.max(0.0001, cur), atTime);
  v.gainNode.gain.exponentialRampToValueAtTime(0.0001, atTime + Math.max(0.01, r));
  const releaseEnd = atTime + Math.max(0.01, r) + 0.05;
  try { v.node?.stop(releaseEnd); } catch(_) {}
  v.node = null;
  v.adsrReleased = true;
  v.adsrPhaseStart = atTime;
  // Clear gainNode after release finishes so playhead stops
  const gn = v.gainNode;
  setTimeout(() => { if (v.gainNode === gn) v.gainNode = null; }, (releaseEnd - atTime + 0.1) * 1000);
}

function makeLFO(ctx2, lfo, atTime) {
  const osc = ctx2.createOscillator();
  osc.type = lfo.wave === 'ramp' ? 'sawtooth' : lfo.wave;
  osc.frequency.value = lfo.speed;
  osc.start(atTime);
  return osc;
}

function applyADSR(param, env, peak, t, ctx2) {
  const { a, d, s, r } = env;
  const FLOOR = 0.0001;
  param.cancelScheduledValues(t);
  param.setValueAtTime(FLOOR, t);
  param.exponentialRampToValueAtTime(Math.max(FLOOR, peak), t + Math.max(0.001, a));
  param.exponentialRampToValueAtTime(Math.max(FLOOR, peak * Math.max(0.001, s)), t + Math.max(0.001, a) + Math.max(0.001, d));
}

function volCurve(v) { return v * v * Math.sqrt(v); } // x^2.5 perceptual

function buildPingPong(inst) {
  const buf = inst.buffer, sr = buf.sampleRate, nch = buf.numberOfChannels;
  const ls = inst.loopStart, le = inst.loopEnd, segLen = le - ls;
  if (segLen <= 0) return buf;
  const total = ls + segLen * 2 + (buf.length - le);
  const out = actx.createBuffer(nch, total, sr);
  for (let c = 0; c < nch; c++) {
    const src2 = buf.getChannelData(c), dst = out.getChannelData(c);
    dst.set(src2.subarray(0, ls));
    dst.set(src2.subarray(ls, le), ls);
    for (let i = 0; i < segLen; i++) dst[ls + segLen + i] = src2[le - 1 - i];
    dst.set(src2.subarray(le), ls + segLen * 2);
  }
  return out;
}

// ── Sequencer ─────────────────────────────────────────────────
let playState = {
  playing: false, patOnly: false,
  orderIdx: 0, row: 0, tick: 0,
  nextRowTime: 0,
};
let schedTimer = null;

function tickDur()  { return 60 / (song.bpm * 24); }
function rowDur()   { return tickDur() * song.speed; }

function startPlay(patOnly = false) {
  getActx(); stopPlay();
  playState.playing  = true;
  playState.patOnly  = patOnly;
  // For pattern play: find where curPat appears in order, default to 0
  playState.orderIdx = patOnly ? Math.max(0, song.order.indexOf(curPat)) : 0;
  // If curPat doesn't exist in order at all, just point to order[0]
  if (patOnly && song.order[playState.orderIdx] !== curPat) playState.orderIdx = 0;
  playState.row = 0;
  playState.nextRowTime = actx.currentTime + 0.05;
  schedule();
  schedTimer = setInterval(schedule, TICK_MS * 2);
  if (patOnly) {
    document.getElementById('btn-play-pat').classList.add('active');
  } else {
    document.getElementById('btn-play-song').classList.add('active');
  }
  setStatus(patOnly ? 'PLAYING PATTERN…' : 'PLAYING SONG…');
}

function stopPlay() {
  patternDelay = 0;
  chLoopStart.fill(-1);
  chLoopCount.fill(0);
  clearInterval(schedTimer); schedTimer = null;
  playState.playing = false;
  voices.forEach((_, ch) => stopVoice(ch));
  document.getElementById('btn-play-song').classList.remove('active');
  document.getElementById('btn-play-pat') .classList.remove('active');
  renderGrid(); renderOrderList();
  setStatus('STOPPED.');
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
  const pat    = song.patterns[patIdx]; if (!pat) return;
  const row    = playState.row;

  // UI update on animation frame
  requestAnimationFrame(() => {
    if (!playState.playing) return;
    document.getElementById('status-pos').textContent =
      `ROW:${row.toString().padStart(2,'0')}  ORD:${playState.orderIdx.toString().padStart(2,'0')}`;
    scrollToRow(row);
    renderGrid(row);
    renderOrderList(playState.orderIdx);
  });

  for (let ch = 0; ch < NUM_CH; ch++) {
    const cell = pat.data[ch]?.[row]; if (!cell) continue;
    const fx  = cell.fx;
    const fxp = cell.fxp ?? 0;
    const lo  = fxp & 0xF;
    const hi  = (fxp >> 4) & 0xF;

    // EDx — note delay: trigger note x ticks into the row, not now
    const isDelayed = fx === 0xE && hi === 0xD && lo > 0;
    const noteTime  = isDelayed ? t + lo * tickDur() : t;

    if (cell.note === NOTE_OFF) {
      releaseNote(ch, noteTime);
    } else if (cell.note !== NOTE_NONE) {
      const instIdx = cell.inst != null ? cell.inst : voices[ch].instIdx;

      // 3xx — tone portamento: don't jump to new pitch, just update portaTarget
      if (fx === 0x3 && voices[ch].node) {
        voices[ch].portaTarget = Math.pow(2, (cell.note - (song.instruments[instIdx]?.baseNote ?? 48)) / 12);
        voices[ch].portaSpeed  = fxp;
        // Don't call triggerNote — keep current voice playing, slide toward target
      } else {
        triggerNote(ch, instIdx, cell.note, cell.vol, noteTime);
        // For 3xx: if this is a NEW note (no previous voice), set portaTarget after trigger
        if (fx === 0x3) {
          voices[ch].portaTarget = voices[ch].node?.playbackRate.value ?? 1;
          voices[ch].portaSpeed  = fxp;
        }
      }
    }

    // Apply FX (skip EDx — already handled above, and E6x/EEx handled below)
    if (fx != null && !isDelayed) applyFX(ch, cell, t);

    // E6x — pattern loop
    if (fx === 0xE && hi === 0x6) {
      if (lo === 0) {
        chLoopStart[ch] = row; // set loop start
      } else if (chLoopStart[ch] >= 0) {
        if (chLoopCount[ch] === 0) {
          chLoopCount[ch] = lo; // first encounter, set count
        }
        if (chLoopCount[ch] > 0) {
          chLoopCount[ch]--;
          // Jump back to loop start — only jump once all channels agree (use ch0 as authority)
          if (ch === 0 || !pat.data.some((_, c) => c < ch &&
              pat.data[c][row]?.fx === 0xE && ((pat.data[c][row].fxp??0)>>4) === 6)) {
            playState.row = chLoopStart[ch] - 1; // -1 because advanceRow adds 1
            if (chLoopCount[ch] === 0) chLoopStart[ch] = -1;
          }
        }
      }
    }
  }

  // EEx — pattern delay (any channel): hold this row for extra row-lengths
  for (let ch = 0; ch < NUM_CH; ch++) {
    const cell = pat.data[ch]?.[row];
    if (cell?.fx === 0xE && ((cell.fxp??0)>>4) === 0xE) {
      const extra = (cell.fxp??0) & 0xF;
      patternDelay = extra; // will be consumed in advanceRow
      break;
    }
  }
}

function advanceRow() {
  if (patternDelay > 0) {
    patternDelay--;
    playState.nextRowTime += rowDur();
    return;
  }
  playState.nextRowTime += rowDur();
  playState.row++;
  const pat = getCurPlayPat();
  if (playState.row >= (pat?.rows ?? DEF_ROWS)) {
    if (playState.patOnly) {
      playState.row = 0; // loop current pattern, stay at same orderIdx
    } else {
      advanceOrder();
    }
  }
}

function advanceOrder() {
  playState.orderIdx = (playState.orderIdx + 1) % song.order.length;
  playState.row = 0;
  // Reset pattern loop state when entering new pattern
  chLoopStart.fill(-1);
  chLoopCount.fill(0);
}

function getCurPlayPat() { return song.patterns[song.order[playState.orderIdx] ?? 0]; }

function applyFX(ch, cell, t) {
  const v    = voices[ch];
  const fxp  = cell.fxp ?? 0;
  const hi   = (fxp >> 4) & 0xF;
  const lo   = fxp & 0xF;
  const rowT  = rowDur();
  const tickT = tickDur();
  const spd  = song.speed;

  switch (cell.fx) {

    // 0xy — Arpeggio: root → root+x → root+y cycling per tick
    case 0x0: if (fxp !== 0 && v.node) {
      const base = v.node.playbackRate.value;
      for (let tick = 0; tick < spd; tick++) {
        const offset = tick % 3 === 0 ? 0 : tick % 3 === 1 ? hi : lo;
        v.node.playbackRate.setValueAtTime(
          base * Math.pow(2, offset / 12), t + tick * tickT);
      }
      v.node.playbackRate.setValueAtTime(base, t + rowT);
    } break;

    // 1xy — Pitch slide (x=up semitones, y=down semitones; only one nonzero)
    // Slides continuously for the row duration, stays there after.
    case 0x1: if (v.node) {
      const semis = hi > 0 ? hi : -lo;
      if (semis !== 0) {
        const cur = v.node.playbackRate.value;
        v.node.playbackRate.setValueAtTime(cur, t);
        v.node.playbackRate.exponentialRampToValueAtTime(
          Math.max(0.001, cur * Math.pow(2, semis / 12)), t + rowT);
      }
    } break;

    // 3xx — Tone portamento: slide toward portaTarget at speed xx per row
    // Target note is set in scheduleRow without jumping. Keeps sliding each row.
    case 0x3: if (v.node && v.portaTarget > 0) {
      v.portaSpeed = fxp || v.portaSpeed;
      const cur    = v.node.playbackRate.value;
      const target = v.portaTarget;
      const maxMove = (v.portaSpeed / 100) * spd; // semitones this row
      let dest;
      if (cur < target) dest = Math.min(target, cur * Math.pow(2,  maxMove / 12));
      else              dest = Math.max(target, cur * Math.pow(2, -maxMove / 12));
      v.node.playbackRate.setValueAtTime(cur, t);
      v.node.playbackRate.exponentialRampToValueAtTime(Math.max(0.001, dest), t + rowT);
    } break;

    // 4xy — Pattern vibrato (x=speed, y=depth)
    case 0x4: if (v.node && fxp !== 0) {
      const speed = hi * 0.5;
      const depth = lo / 64;
      const base  = v.portaTarget || v.node.playbackRate.value;
      for (let tick = 0; tick < spd; tick++) {
        const ph = v.patVibPhase + tick * speed * Math.PI * 2 / spd;
        v.node.playbackRate.setValueAtTime(
          base * Math.pow(2, Math.sin(ph) * depth / 12), t + tick * tickT);
      }
      v.patVibPhase = (v.patVibPhase + speed * Math.PI * 2) % (Math.PI * 2);
    } break;

    // 7xy — Pattern tremolo (x=speed, y=depth)
    case 0x7: if (v.gainNode && fxp !== 0) {
      const speed = hi * 0.5;
      const depth = lo / 64;
      const base  = v.gainNode.gain.value || 0.0001;
      for (let tick = 0; tick < spd; tick++) {
        const ph = v.patTremPhase + tick * speed * Math.PI * 2 / spd;
        v.gainNode.gain.setValueAtTime(
          Math.max(0.0001, base + Math.sin(ph) * depth), t + tick * tickT);
      }
      v.patTremPhase = (v.patTremPhase + speed * Math.PI * 2) % (Math.PI * 2);
    } break;

    // 9xx — Sample offset: store xx*256 samples, consumed on next triggerNote
    case 0x9:
      v.sampleOffset = fxp * 256;
      break;

    // Axy — Volume slide (x=up, y=down per tick; only one nonzero)
    case 0xA: if (v.gainNode && fxp !== 0) {
      const delta  = hi > 0 ? hi / 64 : -(lo / 64);
      const cur    = v.gainNode.gain.value || 0.0001;
      const target = Math.max(0.0001, Math.min(1, cur + delta * spd));
      v.gainNode.gain.setValueAtTime(cur, t);
      v.gainNode.gain.linearRampToValueAtTime(target, t + rowT);
    } break;

    // Bxx — Jump to order position
    case 0xB:
      playState.orderIdx = Math.min(fxp, song.order.length - 1);
      playState.row = -1;
      break;

    // Cxx — Set volume (persistent until changed)
    case 0xC:
      if (v.gainNode) v.gainNode.gain.setValueAtTime(volCurve(Math.min(64, fxp) / 64), t);
      break;

    // Dxx — Pattern break (advance to next order entry, start at row fxp)
    case 0xD:
      advanceOrder();
      playState.row = Math.min(fxp, (getCurPlayPat()?.rows ?? DEF_ROWS) - 1) - 1;
      break;

    // Exy — Extended effects
    case 0xE: switch (hi) {

      // E1y — Fine portamento up (y cents)
      case 0x1: if (v.node && lo > 0)
        v.node.playbackRate.setValueAtTime(
          v.node.playbackRate.value * Math.pow(2, lo / 1200), t);
        break;

      // E2y — Fine portamento down (y cents)
      case 0x2: if (v.node && lo > 0)
        v.node.playbackRate.setValueAtTime(
          Math.max(0.001, v.node.playbackRate.value * Math.pow(2, -lo / 1200)), t);
        break;

      // E9y — Retrigger: restart sample every y ticks within the row
      case 0x9: if (lo > 0 && v.instIdx != null && v.note !== NOTE_NONE) {
        const inst = song.instruments[v.instIdx];
        if (inst?.buffer) {
          for (let tick = lo; tick < spd; tick += lo) {
            const rt  = t + tick * tickT;
            const rs  = actx.createBufferSource();
            rs.buffer = inst.buffer;
            rs.playbackRate.value = v.node?.playbackRate.value ?? 1;
            const rg  = actx.createGain();
            rg.gain.value = v.gainNode?.gain.value ?? 0.5;
            rs.connect(rg); rg.connect(analysers[ch] ?? masterGain);
            const ssec = (inst.startPoint || 0) / inst.buffer.sampleRate;
            if (inst.loop) { rs.start(rt, ssec); }
            else {
              const ep = inst.endPoint > inst.startPoint ? inst.endPoint : inst.buffer.length;
              rs.start(rt, ssec, (ep - inst.startPoint) / inst.buffer.sampleRate);
            }
            rs.stop(rt + tickT * lo + 0.005);
          }
        }
      } break;

      // EAy — Fine vol slide up
      case 0xA: if (v.gainNode && lo > 0)
        v.gainNode.gain.setValueAtTime(
          Math.min(1, (v.gainNode.gain.value || 0.0001) + lo / 64), t);
        break;

      // EBy — Fine vol slide down
      case 0xB: if (v.gainNode && lo > 0)
        v.gainNode.gain.setValueAtTime(
          Math.max(0.0001, (v.gainNode.gain.value || 0.0001) - lo / 64), t);
        break;

      // ECy — Note cut: silence after y ticks
      case 0xC:
        if (v.gainNode) v.gainNode.gain.setValueAtTime(0.0001, t + lo * tickT);
        break;

      // EDy, E6y, EEy — handled in scheduleRow before applyFX is called

    } break;

    // Fxx — Set speed (F01-F1F) or BPM (F20-FFF)
    case 0xF:
      if (fxp < 0x20) { song.speed = Math.max(1, fxp); updateSpeedUI(); }
      else            { song.bpm   = Math.max(32, Math.min(255, fxp)); updateBpmUI(); }
      break;
  }
}

// ── Pattern editor rendering ──────────────────────────────────
let gridBuiltFor = null;

function getEditPat() { return song.patterns[curPat] ?? null; }

function renderGrid(playRow = -1) {
  const pat = getEditPat(); if (!pat) return;
  const grid = document.getElementById('pattern-grid');

  if (gridBuiltFor !== pat.id + '_' + pat.rows) buildGrid(pat);

  const rows = grid.children;
  for (let row = 0; row < pat.rows; row++) {
    const rowEl = rows[row]; if (!rowEl) continue;
    rowEl.classList.toggle('playhead',   row === playRow);
    rowEl.classList.toggle('cursor-row', row === curRow && playRow < 0);

    // Selection highlight
    const selMinR = sel ? Math.min(sel.startRow, sel.endRow) : -1;
    const selMaxR = sel ? Math.max(sel.startRow, sel.endRow) : -1;
    const selMinC = sel ? Math.min(sel.startCh,  sel.endCh)  : -1;
    const selMaxC = sel ? Math.max(sel.startCh,  sel.endCh)  : -1;

    for (let ch = 0; ch < NUM_CH; ch++) {
      const cellEl = rowEl.children[ch + 1]; if (!cellEl) continue;
      const cell   = pat.data[ch][row];
      const isCursor = row === curRow && ch === curCh;

      cellEl.classList.toggle('cursor', isCursor && curField >= 0);
      cellEl.classList.toggle('selected', sel != null && row >= selMinR && row <= selMaxR && ch >= selMinC && ch <= selMaxC);
      cellEl.classList.remove('cursor-note','cursor-inst','cursor-vol','cursor-fx');
      if (isCursor) {
        const cls = ['cursor-note','cursor-inst','cursor-vol','cursor-fx','cursor-fx'];
        cellEl.classList.add(cls[curField] ?? 'cursor-note');
      }

      updateCell(cellEl, cell);
    }
  }
}

function buildGrid(pat) {
  const grid = document.getElementById('pattern-grid');
  grid.innerHTML = '';
  gridBuiltFor = pat.id + '_' + pat.rows;
  grid.style.width = (NUM_CH * (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cell-w')) + 1) + 32) + 'px';

  for (let row = 0; row < pat.rows; row++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'pt-row'; rowEl.dataset.row = row;

    const numEl = document.createElement('div');
    numEl.className = 'pt-rownum' + (row % 16 === 0 ? ' bar' : row % 4 === 0 ? ' beat' : '');
    numEl.textContent = row.toString(16).toUpperCase().padStart(2,'0');
    rowEl.appendChild(numEl);

    for (let ch = 0; ch < NUM_CH; ch++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'pt-cell'; cellEl.dataset.row = row; cellEl.dataset.ch = ch;
      cellEl.setAttribute('data-ch', ch);

      const note = document.createElement('span'); note.className = 'f-note';
      const inst = document.createElement('span'); inst.className = 'f-inst';
      const vol  = document.createElement('span'); vol.className  = 'f-vol';
      const fx   = document.createElement('span'); fx.className   = 'f-fx';
      cellEl.append(note, inst, vol, fx);

      cellEl.addEventListener('mousedown', e => {
        e.preventDefault();
        curRow = row; curCh = ch;
        const relX = e.clientX - cellEl.getBoundingClientRect().left;
        const w = cellEl.getBoundingClientRect().width;
        curField = relX < w*0.28 ? 0 : relX < w*0.44 ? 1 : relX < w*0.58 ? 2 : 3;
        renderGrid(); renderHeaders();
        document.getElementById('pattern-grid').focus();
      });

      rowEl.appendChild(cellEl);
    }
    grid.appendChild(rowEl);
  }
}

function updateCell(cellEl, cell) {
  const [noteEl, instEl, volEl, fxEl] = cellEl.children;
  noteEl.textContent = noteName(cell.note);
  noteEl.classList.toggle('note-off', cell.note === NOTE_OFF);
  noteEl.style.color = cell.note === NOTE_NONE ? 'var(--tr-empty)' : '';
  instEl.textContent = cell.inst != null ? hexByte(cell.inst + 1) : '--';
  instEl.style.color = cell.inst == null ? 'var(--tr-empty)' : '';
  volEl.textContent  = cell.vol  != null ? hexByte(cell.vol) : '--';
  volEl.style.color  = cell.vol  == null ? 'var(--tr-empty)' : '';
  fxEl.textContent   = cell.fx   != null ? hexNibble(cell.fx) + hexByte(cell.fxp ?? 0) : '---';
  fxEl.style.color   = cell.fx   == null ? 'var(--tr-empty)' : '';
}

function scrollToRow(row) {
  const scroll = document.getElementById('grid-scroll');
  if (!scroll) return;
  const ROW_H  = 13;
  const top    = row * ROW_H;
  const viewH  = scroll.clientHeight;
  const savedX = scroll.scrollLeft;
  if (top < scroll.scrollTop + 20 || top > scroll.scrollTop + viewH - 40)
    scroll.scrollTop = Math.max(0, top - viewH * 0.4);
  scroll.scrollLeft = savedX;
}

// ── Channel headers + scopes ──────────────────────────────────
let scopeCanvases    = [];  // pattern editor scope strip
let topbarScopes     = [];  // topbar per-channel scopes
let scopeAnimId      = null;

function renderHeaders() {
  const slave = document.getElementById('ch-headers-slave');
  slave.innerHTML = '';
  for (let ch = 0; ch < NUM_CH; ch++) {
    const hdr = document.createElement('div');
    hdr.className = 'ch-hdr' + (ch === curCh ? ' active' : '');
    hdr.dataset.ch = ch; hdr.setAttribute('data-ch', ch);
    hdr.textContent = `CH${ch + 1}`;
    hdr.title = 'Right-click to mute';
    hdr.addEventListener('click', () => { curCh = ch; renderGrid(); renderHeaders(); });
    hdr.addEventListener('contextmenu', e => {
      e.preventDefault();
      const pat = getEditPat(); if (!pat) return;
      if (!pat._muted) pat._muted = [];
      pat._muted[ch] = !pat._muted[ch];
      hdr.classList.toggle('muted', pat._muted[ch]);
    });
    slave.appendChild(hdr);
  }
  buildScopes();
  syncScroll();
}

function buildScopes() {
  const slave = document.getElementById('scope-slave');
  slave.innerHTML = ''; scopeCanvases = [];
  for (let ch = 0; ch < NUM_CH; ch++) {
    const cell = document.createElement('div'); cell.className = 'scope-cell';
    const cv   = document.createElement('canvas'); cv.className = 'scope-canvas';
    cell.appendChild(cv); slave.appendChild(cell); scopeCanvases.push(cv);
  }
}

function buildTopbarScopes() {
  const wrap = document.getElementById('topbar-scopes');
  if (!wrap) return;
  wrap.innerHTML = ''; topbarScopes = [];
  for (let ch = 0; ch < NUM_CH; ch++) {
    const cell = document.createElement('div'); cell.className = 'ts-scope-wrap';
    const lbl  = document.createElement('div'); lbl.className = 'ts-scope-label';
    lbl.textContent = `${ch + 1}`; lbl.style.color = CH_COLOURS[ch];
    const cv   = document.createElement('canvas'); cv.className = 'ts-scope-canvas';
    cell.appendChild(lbl); cell.appendChild(cv);
    wrap.appendChild(cell); topbarScopes.push(cv);
  }
}

function drawScopeCanvas(cv, ch, dpr) {
  const cssW = cv.clientWidth  || cv.parentElement?.clientWidth  || 60;
  const cssH = cv.clientHeight || cv.parentElement?.clientHeight || 30;
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const c = cv.getContext('2d'); c.save(); c.scale(dpr, dpr);
  const W = cssW, H = cssH;
  c.fillStyle = '#030008'; c.fillRect(0, 0, W, H);
  // Centre line
  c.strokeStyle = 'rgba(255,255,255,0.05)'; c.lineWidth = 1; c.setLineDash([]);
  c.beginPath(); c.moveTo(0, H / 2); c.lineTo(W, H / 2); c.stroke();
  const an = analysers[ch];
  if (an && actx) {
    const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
    let maxA = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > maxA) maxA = a; }
    const col = CH_COLOURS[ch];
    c.strokeStyle = col + (maxA > 0.002 ? 'cc' : '28');
    c.lineWidth   = maxA > 0.002 ? 1.5 : 0.7;
    c.shadowColor = col; c.shadowBlur = maxA > 0.01 ? 3 : 0;
    c.beginPath();
    const step = buf.length / W;
    for (let x = 0; x < W; x++) {
      const s = buf[Math.floor(x * step)] || 0;
      const y = (0.5 - s * 0.46) * H;
      x === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.stroke();
  }
  c.restore();
}

function drawScopes() {
  const dpr = window.devicePixelRatio || 1;
  // Pattern editor strip
  for (let ch = 0; ch < NUM_CH; ch++) {
    const cv = scopeCanvases[ch]; if (cv) drawScopeCanvas(cv, ch, dpr);
  }
  // Topbar scopes
  for (let ch = 0; ch < NUM_CH; ch++) {
    const cv = topbarScopes[ch]; if (cv) drawScopeCanvas(cv, ch, dpr);
  }
  scopeAnimId = requestAnimationFrame(drawScopes);
  // Update ADSR playhead on instrument editor if it's visible
  if (!document.getElementById('panel-instrument')?.classList.contains('hidden')) {
    updateADSRPlayheads();
    // Redraw waveform with playhead each frame
    const inst = song.instruments[curSmpSlot];
    if (inst) {
      drawWaveform(inst);
      drawWaveformPlayhead();
    }
  }
}

// ── Scroll sync (headers + scopes follow grid scroll) ─────────
function syncScroll() {
  const gridScroll = document.getElementById('grid-scroll');
  const hdrSlave   = document.getElementById('ch-headers-slave');
  const scopeSlave = document.getElementById('scope-slave');
  const handler    = () => {
    hdrSlave.scrollLeft   = gridScroll.scrollLeft;
    scopeSlave.scrollLeft = gridScroll.scrollLeft;
  };
  gridScroll.removeEventListener('scroll', handler);
  gridScroll.addEventListener('scroll', handler, { passive: true });
}

// ── Order list rendering ──────────────────────────────────────
function renderOrderList(playingIdx = -1) {
  const el = document.getElementById('order-list');
  el.innerHTML = '';
  song.order.forEach((patIdx, i) => {
    const row = document.createElement('div');
    row.className = 'order-row' +
      (patIdx === curPat ? ' active' : '') +
      (i === playingIdx ? ' playing' : '');
    row.title = `Order ${i}: Pattern ${patIdx}`;
    row.innerHTML =
      `<span class="ord-idx">${i.toString().padStart(2,'0')}</span>` +
      `<span class="ord-pat">${patIdx.toString(16).toUpperCase().padStart(2,'0')}</span>`;
    row.addEventListener('click', () => {
      curPat = patIdx;
      document.getElementById('pat-val').textContent = curPat.toString(16).toUpperCase().padStart(2,'0');
      renderGrid(); renderHeaders(); renderOrderList(); renderSongTab();
      switchTab('pattern');
    });
    el.appendChild(row);
  });
  // Scroll to playing row
  if (playingIdx >= 0) {
    const rows = el.querySelectorAll('.order-row');
    rows[playingIdx]?.scrollIntoView({ block: 'nearest' });
  }
}

// ── Instrument list ───────────────────────────────────────────
function renderInstList() {
  const el = document.getElementById('inst-list');
  el.innerHTML = '';
  song.instruments.forEach((inst, i) => {
    const row = document.createElement('div');
    row.className = 'inst-row' + (i === curInstSlot ? ' active' : '') + (inst.buffer ? ' has-sample' : '');
    row.innerHTML = `<span class="inst-num">${(i+1).toString(16).toUpperCase().padStart(2,'0')}</span><span class="inst-name">${inst.name || '(empty)'}</span><span class="inst-del">✕</span>`;
    row.querySelector('.inst-del').addEventListener('click', e => {
      e.stopPropagation();
      song.instruments[i] = makeInstrument(); renderInstList();
    });
    row.addEventListener('click', () => { curInstSlot = i; curSmpSlot = i; renderInstList(); renderSmpList(); renderSmpEditor(); });
    el.appendChild(row);
  });
}

// ── Sample list (instrument editor left panel) ────────────────
function renderSmpList() {
  const el = document.getElementById('smp-list');
  if (!el) return;
  el.innerHTML = '';
  song.instruments.forEach((inst, i) => {
    const row = document.createElement('div');
    row.className = 'smp-row' + (i === curSmpSlot ? ' active' : '') + (inst.buffer ? ' loaded' : '');
    row.innerHTML = `<span class="smp-num">${(i+1).toString(16).toUpperCase().padStart(2,'0')}</span><span class="smp-dot"></span><span class="smp-name">${inst.name || '(empty)'}</span>`;
    row.addEventListener('click', () => { curSmpSlot = i; curInstSlot = i; renderSmpList(); renderInstList(); renderSmpEditor(); });
    el.appendChild(row);
  });
}

// ── LFO controls HTML ─────────────────────────────────────────
function lfoControls(prefix, lfo) {
  const waves = ['sine','square','triangle','sawtooth'];
  const waveSymbols = { sine:'∿', square:'⊓', triangle:'∧', sawtooth:'⟋' };
  return `<div class="prop-grid">
    <div class="prop-row">
      <span class="field-lbl">Wave</span>
      <div class="lfo-wave-btns">
        ${waves.map(w => `<button class="lfo-wave-btn${lfo.wave===w?' active':''}" data-lfo="${prefix}" data-wave="${w}" title="${w}">${waveSymbols[w]}</button>`).join('')}
      </div>
    </div>
    <div class="prop-row">
      <span class="field-lbl">Speed</span>
      <span class="drag-val" id="${prefix}-spd">${lfo.speed.toFixed(1)}</span>
    </div>
    <div class="prop-row">
      <span class="field-lbl">Depth</span>
      <span class="drag-val" id="${prefix}-dep">${lfo.depth}</span>
    </div>
  </div>`;
}

// ── Sample editor (right panel) ───────────────────────────────
// FL-style: click+drag left/right to change value.
// el = the .drag-val element, already in DOM.
function makeDragSlider(el, get, set, min, max, fmt, step = 1) {
  let startX, startVal, dragging = false;
  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    startX   = e.clientX;
    startVal = get();
    dragging = true;
    el.classList.add('dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx    = e.clientX - startX;
    const range = max - min;
    const raw   = startVal + (dx / 200) * range;
    const v     = Math.max(min, Math.min(max, Math.round(raw / step) * step));
    set(v);
    el.textContent = fmt(v);
    // Fill indicator
    el.style.setProperty('--fill', ((v - min) / range * 100).toFixed(1) + '%');
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
  });
  // Double-click resets
  el.addEventListener('dblclick', () => {
    // No universal default — caller can override by re-calling makeDragSlider
  });
  // Init display
  const v = get();
  el.textContent = fmt(v);
  el.style.setProperty('--fill', ((v - min) / (max - min) * 100).toFixed(1) + '%');
}

function dragSliderHTML(id, label, value, fmt = v => v) {
  return `<div class="prop-row">
    <span class="field-lbl">${label}</span>
    <span class="drag-val" id="${id}" title="Drag to change · double-click to reset">${fmt(value)}</span>
  </div>`;
}

// ── Sample editor (right panel) ───────────────────────────────
let wfDrag = null, wfZoomStart = 0, wfZoomEnd = 1;
let adsrDrag = null;

function renderSmpEditor() {
  const inst = song.instruments[curSmpSlot];
  const ed   = document.getElementById('smp-editor');
  if (!inst) { ed.innerHTML = ''; return; }

  const slotHex = (curSmpSlot+1).toString(16).toUpperCase().padStart(2,'0');

  ed.innerHTML = `
    <!-- Sample header: name + load controls -->
    <div>
      <div class="ed-section">Sample ${slotHex}</div>
      <div style="display:flex;gap:3px;margin-bottom:3px">
        <input class="name-input" id="smp-name" maxlength="22" value="${inst.name}" placeholder="Name…">
      </div>
      <div style="display:flex;gap:3px;margin-bottom:3px">
        <input class="url-input" id="smp-url" placeholder="URL / YouTube…">
        <button class="aq-btn" id="smp-fetch">Load</button>
      </div>
      <div style="display:flex;gap:3px">
        <label class="aq-btn" style="cursor:pointer">File<input type="file" id="smp-file" accept="audio/*" style="display:none"></label>
        <button class="aq-btn" id="smp-mic">${micRecorder?.state === 'recording' ? '⏹ Stop' : '● Mic'}</button>
        ${inst.buffer ? '<button class="aq-btn" id="smp-crop" title="Crop to S..E markers">✂ Crop</button>' : ''}
        ${inst.buffer ? '<button class="aq-btn danger" id="smp-clear">✕</button>' : ''}
      </div>
    </div>

    <!-- Waveform -->
    <div>
      <div class="ed-section" style="display:flex;justify-content:space-between">
        <span>Waveform</span>
        <span style="font-size:7px;color:var(--ft-text3)">S:<span id="sp-val">${inst.startPoint}</span>
        L[<span id="ls-val">${inst.loopStart}</span>
        L]<span id="le-val">${inst.loopEnd}</span>
        E:<span id="ep-val">${inst.endPoint||inst.buffer?.length||0}</span>
        <button class="aq-btn" id="wf-reset" style="height:12px;padding:0 4px;font-size:8px">1:1</button></span>
      </div>
      <canvas class="waveform-canvas" id="wf-canvas"></canvas>
      <div style="font-size:8px;color:var(--ft-text3);margin-top:1px">Drag markers · Scroll=pan · Ctrl+Scroll=zoom</div>
    </div>

    <!-- Properties: drag sliders -->
    <div>
      <div class="ed-section">Properties</div>
      <div class="prop-grid">
        ${dragSliderHTML('drag-base', 'Base', inst.baseNote, noteName)}
        ${dragSliderHTML('drag-vol',  'Vol',  inst.volume,   v => Math.round(v/64*100)+'%')}
        ${dragSliderHTML('drag-fine', 'Fine', inst.finetune, v => (v >= 0 ? '+' : '') + v)}
        <div class="prop-row" style="gap:4px">
          <button class="loop-btn${inst.loop?' active':''}" id="loop-toggle">Loop</button>
          <button class="loop-btn${inst.loop&&inst.loopMode===1?' active':''}" id="pingpong-toggle">Ping</button>
        </div>
      </div>
    </div>

    <!-- Volume envelope -->
    <div>
      <div class="ed-section">Volume Envelope  <span style="font-size:7px;color:var(--ft-text3)">drag handles · right-click=reset</span></div>
      <canvas class="adsr-canvas" id="vol-adsr-canvas"></canvas>
      <div style="font-size:9px;color:var(--ft-text2);margin-top:2px;font-family:var(--font)">
        A:<span id="vol-a-ro">—</span>  D:<span id="vol-d-ro">—</span>  S:<span id="vol-s-ro">—</span>  R:<span id="vol-r-ro">—</span>
      </div>
    </div>

    <!-- Filter -->
    <div>
      <div class="ed-section">Filter</div>
      <div class="prop-grid">
        <div class="prop-row">
          <span class="field-lbl">Type</span>
          <select class="aq-select" id="filt-type">
            ${['off','lowpass','highpass','bandpass','notch'].map(t=>`<option value="${t}"${inst.filter.type===t?' selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        ${dragSliderHTML('drag-fcut', 'Cut', Math.round(inst.filter.cutoff), v => v+'Hz')}
        ${dragSliderHTML('drag-fres', 'Res', Math.round(inst.filter.resonance * 10), v => (v/10).toFixed(1))}
      </div>
      <canvas class="adsr-canvas" id="filt-adsr-canvas" style="margin-top:3px"></canvas>
      <div style="font-size:9px;color:var(--ft-text2);margin-top:2px;font-family:var(--font)">
        A:<span id="filt-a-ro">—</span>  D:<span id="filt-d-ro">—</span>  S:<span id="filt-s-ro">—</span>  R:<span id="filt-r-ro">—</span>
      </div>
    </div>

    <!-- LFOs -->
    <div>
      <div class="ed-section">Vibrato (Pitch LFO)</div>
      ${lfoControls('vib', inst.vibrato)}
    </div>
    <div>
      <div class="ed-section">Tremolo (Vol LFO)</div>
      ${lfoControls('trem', inst.tremolo)}
    </div>
    <div>
      <div class="ed-section">Pan LFO</div>
      ${lfoControls('pan', inst.panLFO)}
    </div>
  `;

  wireSmpEditor(inst);
  requestAnimationFrame(() => { drawWaveform(inst); });
}

function wireSmpEditor(inst) {
  const $ = id => document.getElementById(id);
  const rerender = () => renderSmpEditor();

  // Load controls
  $('smp-name').addEventListener('input', e => { inst.name = e.target.value; renderInstList(); renderSmpList(); });
  $('smp-fetch').addEventListener('click', () => { const url = $('smp-url').value.trim(); if (url) loadFromUrl(inst, url); });
  $('smp-file').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadFromFile(inst, f); });
  $('smp-mic')?.addEventListener('click', () => startMicRecord(inst));
  $('smp-crop')?.addEventListener('click', () => cropSample(inst));
  $('smp-clear')?.addEventListener('click', () => { inst.buffer=null; inst.name=''; rerender(); renderSmpList(); renderInstList(); });
  $('wf-reset')?.addEventListener('click', () => { wfZoomStart=0; wfZoomEnd=1; drawWaveform(inst); });

  // Loop buttons
  $('loop-toggle')?.addEventListener('click', () => { inst.loop=!inst.loop; rerender(); });
  $('pingpong-toggle')?.addEventListener('click', () => { inst.loopMode=inst.loopMode===1?0:1; rerender(); });

  // Drag sliders
  const dv = id => document.getElementById(id);
  makeDragSlider(dv('drag-base'), ()=>inst.baseNote, v=>{inst.baseNote=v;}, 0, 119, noteName, 1);
  makeDragSlider(dv('drag-vol'),  ()=>inst.volume,   v=>{inst.volume=v;},   0, 128, v=>Math.round(v/64*100)+'%', 1);
  makeDragSlider(dv('drag-fine'), ()=>inst.finetune, v=>{inst.finetune=v;}, -100, 100, v=>(v>=0?'+':'')+v, 1);
  makeDragSlider(dv('drag-fcut'), ()=>Math.round(inst.filter.cutoff),
    v=>{ inst.filter.cutoff=v; }, 20, 20000, v=>v+'Hz', 10);
  makeDragSlider(dv('drag-fres'), ()=>Math.round(inst.filter.resonance*10),
    v=>{ inst.filter.resonance=v/10; }, 1, 200, v=>(v/10).toFixed(1), 1);

  // Filter type
  $('filt-type')?.addEventListener('change', e => { inst.filter.type = e.target.value; });

  // ADSR canvases
  wireADSR('vol-adsr-canvas',  'vol',  inst.volEnv,  '#00b4ff');
  wireADSR('filt-adsr-canvas', 'filt', inst.filtEnv, '#00d060');

  // LFO wave buttons
  document.querySelectorAll('.lfo-wave-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lfoKey = btn.dataset.lfo, wave = btn.dataset.wave;
      const lfoObj = lfoKey==='vib' ? inst.vibrato : lfoKey==='trem' ? inst.tremolo : inst.panLFO;
      lfoObj.wave = wave;
      document.querySelectorAll(`.lfo-wave-btn[data-lfo="${lfoKey}"]`).forEach(b => b.classList.toggle('active', b.dataset.wave===wave));
    });
  });

  // LFO speed/depth drag sliders — wire after lfoControls injects them
  const lfoSliders = (prefix, lfoObj) => {
    const spEl = dv(`${prefix}-spd`);
    const dpEl = dv(`${prefix}-dep`);
    if (spEl) makeDragSlider(spEl, ()=>Math.round(lfoObj.speed*10), v=>{ lfoObj.speed=v/10; }, 0, 200, v=>(v/10).toFixed(1), 1);
    if (dpEl) makeDragSlider(dpEl, ()=>lfoObj.depth,               v=>{ lfoObj.depth=v; },    0, 100, v=>v, 1);
  };
  lfoSliders('vib',  inst.vibrato);
  lfoSliders('trem', inst.tremolo);
  lfoSliders('pan',  inst.panLFO);

  // Waveform markers
  wireWaveform(inst);
}

function redrawADSR(prefix, env) {
  const id = prefix==='vol'?'vol-adsr-canvas':'filt-adsr-canvas';
  const col = prefix==='vol'?'#3478f6':'#28c840';
  const cv = document.getElementById(id); if(cv) drawADSR(cv, env, col);
}

// ── Waveform drawing ──────────────────────────────────────────
function drawWaveform(inst) {
  const cv = document.getElementById('wf-canvas'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 400, cssH = cv.clientHeight || 90;
  if (cv.width !== Math.round(cssW*dpr)) { cv.width=Math.round(cssW*dpr); cv.height=Math.round(cssH*dpr); }
  const c = cv.getContext('2d'); c.save(); c.scale(dpr, dpr);
  const W = cssW, H = cssH;
  c.fillStyle='#040410'; c.fillRect(0,0,W,H);

  if (!inst?.buffer) {
    c.fillStyle='rgba(100,140,200,0.3)'; c.font='700 11px var(--font)';
    c.textAlign='center'; c.textBaseline='middle'; c.fillText('NO SAMPLE LOADED', W/2, H/2);
    c.restore(); return;
  }

  const data = inst.buffer.getChannelData(0);
  const len  = data.length;
  const vs   = wfZoomStart, ve = wfZoomEnd, span = ve - vs;

  // Zoom indicator
  if (span < 0.99) {
    c.fillStyle='rgba(52,120,246,0.1)'; c.fillRect(0,H-4,W,4);
    c.fillStyle='#3478f6'; c.fillRect(vs*W,H-4,span*W,4);
  }

  const toX = f => ((f-vs)/span)*W;
  const idxToX = i => toX(i/len);

  // Waveform
  const iStart=Math.floor(vs*len), iEnd=Math.ceil(ve*len);
  c.strokeStyle='#4080c0'; c.lineWidth=1; c.setLineDash([]);
  c.beginPath();
  let first=true;
  for (let x=0;x<W;x++) {
    const base=iStart+Math.floor((x/W)*(iEnd-iStart));
    let mn=1,mx=-1;
    const step=Math.max(1,Math.floor((iEnd-iStart)/W));
    for(let j=0;j<step&&base+j<iEnd;j++){const s=data[base+j];if(s<mn)mn=s;if(s>mx)mx=s;}
    const y1=(0.5-mx*0.47)*H, y2=(0.5-mn*0.47)*H;
    if(first){c.moveTo(x,y1);first=false;}else c.lineTo(x,y1);
    c.lineTo(x,y2);
  }
  c.stroke();

  // Centre line
  c.strokeStyle='rgba(128,192,255,0.1)'; c.lineWidth=1;
  c.beginPath(); c.moveTo(0,H/2); c.lineTo(W,H/2); c.stroke();

  // Loop region
  if (inst.loop && inst.loopEnd > inst.loopStart) {
    c.fillStyle='rgba(255,255,0,0.07)';
    c.fillRect(idxToX(inst.loopStart),0,idxToX(inst.loopEnd)-idxToX(inst.loopStart),H);
  }

  // Markers
  const markers = [
    {key:'startPoint',  color:'#00ff88',label:'S'},
    {key:'endPoint',    color:'#ff4040',label:'E'},
  ];
  if (inst.loop) {
    markers.push({key:'loopStart',color:'#ffff00',label:'['});
    markers.push({key:'loopEnd',  color:'#ffaa00',label:']'});
  }
  markers.forEach(m => {
    const px = idxToX(inst[m.key]||0);
    c.strokeStyle=m.color; c.lineWidth=1.5; c.setLineDash([]);
    c.beginPath(); c.moveTo(px,0); c.lineTo(px,H); c.stroke();
    c.fillStyle=m.color; c.fillRect(px-5,0,10,11);
    c.fillStyle='#000'; c.font='bold 8px var(--font)';
    c.textAlign='center'; c.textBaseline='top'; c.fillText(m.label,px,1);
  });

  c.restore();
}

// Compute waveform playhead position (0..1 fraction of buffer) for current inst
// Tracks both pattern voices and preview (▶ Play button)
let _previewStartTime = -1;   // actx.currentTime when previewSample was last started
let _previewInstIdx   = -1;

function getWaveformPlayhead() {
  if (!actx) return -1;
  const inst = song.instruments[curSmpSlot]; if (!inst?.buffer) return -1;
  const sr   = inst.buffer.sampleRate;

  // Check pattern voices first
  for (let ch = 0; ch < NUM_CH; ch++) {
    const v = voices[ch];
    if (!v.node || v.instIdx !== curSmpSlot) continue;
    if (v.adsrPhaseStart == null) continue;
    const elapsed  = actx.currentTime - v.adsrPhaseStart;
    return calcPlayheadPos(inst, elapsed, sr);
  }

  // Check preview voice (▶ Play button)
  if (_previewInstIdx === curSmpSlot && _previewStartTime >= 0) {
    const elapsed = actx.currentTime - _previewStartTime;
    const pos = calcPlayheadPos(inst, elapsed, sr);
    if (pos >= 1) { _previewStartTime = -1; _previewInstIdx = -1; return -1; }
    return pos;
  }

  return -1;
}

function calcPlayheadPos(inst, elapsed, sr) {
  const startSmp = inst.startPoint || 0;
  if (inst.loop && inst.loopEnd > inst.loopStart) {
    const ls        = Math.max(startSmp, inst.loopStart);
    const le        = Math.min(inst.endPoint > 0 ? inst.endPoint : inst.buffer.length, inst.loopEnd);
    const loopLen   = le - ls;
    const reachLoop = (ls - startSmp) / sr;
    if (elapsed < reachLoop) return (startSmp + elapsed * sr) / inst.buffer.length;
    const loopElapsed = (elapsed - reachLoop) % (loopLen / sr);
    if (inst.loopMode === 1) {
      const halfSec = loopLen / sr;
      const phase   = loopElapsed % (halfSec * 2);
      const smp     = phase < halfSec ? ls + phase * sr : le - (phase - halfSec) * sr;
      return Math.max(0, Math.min(1, smp / inst.buffer.length));
    }
    return Math.max(0, Math.min(1, (ls + loopElapsed * sr) / inst.buffer.length));
  } else {
    const ep  = inst.endPoint > startSmp ? inst.endPoint : inst.buffer.length;
    const pos = startSmp + elapsed * sr;
    return Math.min(1, pos / inst.buffer.length);
  }
}

function drawWaveformPlayhead() {
  const cv = document.getElementById('wf-canvas'); if (!cv) return;
  const inst = song.instruments[curSmpSlot]; if (!inst?.buffer) return;
  const ph = getWaveformPlayhead(); if (ph < 0) return;

  // We need to redraw over the existing waveform — full redraw each frame is expensive
  // so we draw just the playhead on a separate 2d pass (waveform redraws on marker change only)
  const dpr  = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 400, cssH = cv.clientHeight || 90;
  const span = wfZoomEnd - wfZoomStart;
  const px   = ((ph - wfZoomStart) / span) * cssW;
  if (px < 0 || px > cssW) return; // off-screen

  const c = cv.getContext('2d');
  c.save(); c.scale(dpr, dpr);
  // White playhead line
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth   = 1;
  c.setLineDash([3, 2]);
  c.beginPath(); c.moveTo(px, 0); c.lineTo(px, cssH); c.stroke();
  c.setLineDash([]);
  c.restore();
}

function wireWaveform(inst) {
  const cv = document.getElementById('wf-canvas'); if(!cv) return;
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r=cv.getBoundingClientRect();
    const cx=(e.clientX-r.left)/r.width;
    const vs=wfZoomStart,ve=wfZoomEnd,span=ve-vs;
    if(e.ctrlKey||e.metaKey||Math.abs(e.deltaY)>5){
      const f=e.deltaY<0?0.7:1/0.7;
      const ns2=Math.min(1,Math.max(0.001,span*f));
      const anchor=vs+cx*span;
      let ns=anchor-cx*ns2,ne=ns+ns2;
      if(ns<0){ns=0;ne=ns2;} if(ne>1){ne=1;ns=1-ns2;}
      wfZoomStart=ns;wfZoomEnd=ne;
    } else {
      const pan=(e.deltaX||0)/r.width*span*3;
      let ns=vs+pan,ne=ve+pan;
      if(ns<0){ns=0;ne=span;} if(ne>1){ne=1;ns=1-span;}
      wfZoomStart=ns;wfZoomEnd=ne;
    }
    drawWaveform(inst);
  },{passive:false});

  cv.addEventListener('dblclick',()=>{wfZoomStart=0;wfZoomEnd=1;drawWaveform(inst);});

  // Zero-crossing snap: find nearest zero crossing within ~5ms window
  function snapZero(pos, buf) {
    if (!buf) return pos;
    const data   = buf.getChannelData(0);
    const len    = buf.length;
    const window = Math.ceil(buf.sampleRate * 0.005); // 5ms search window
    let bestPos  = pos, bestVal = Math.abs(data[Math.max(0, Math.min(len-1, pos))]);
    for (let i = Math.max(0, pos - window); i <= Math.min(len-1, pos + window); i++) {
      const v = Math.abs(data[i]);
      if (v < bestVal) { bestVal = v; bestPos = i; }
    }
    return bestPos;
  }

  let dragKey = null;
  cv.addEventListener('mousedown', e => {
    if (!inst.buffer) return;
    const r     = cv.getBoundingClientRect();
    const f     = (e.clientX - r.left) / r.width;
    const world = wfZoomStart + f * (wfZoomEnd - wfZoomStart);
    const len   = inst.buffer.length;
    const tol   = 0.03 * (wfZoomEnd - wfZoomStart);
    const cands = [
      { key: 'startPoint', f: inst.startPoint / len },
      { key: 'endPoint',   f: inst.endPoint   / len },
    ];
    if (inst.loop) {
      cands.push({ key: 'loopStart', f: inst.loopStart / len });
      cands.push({ key: 'loopEnd',   f: inst.loopEnd   / len });
    }
    let best = null, bd = tol;
    cands.forEach(c => { const d = Math.abs(world - c.f); if (d < bd) { bd = d; best = c.key; } });
    dragKey = best;
  });

  window.addEventListener('mousemove', e => {
    if (!dragKey || !inst.buffer) return;
    const r     = cv.getBoundingClientRect();
    const f     = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const world = wfZoomStart + f * (wfZoomEnd - wfZoomStart);
    const len   = inst.buffer.length;
    let pos     = snapZero(Math.round(world * len), inst.buffer);

    // Update marker with constraints; keep loop markers inside start/end region
    const MIN_GAP = 16; // minimum samples between markers
    switch (dragKey) {
      case 'startPoint':
        pos = Math.max(0, Math.min(pos, inst.endPoint - MIN_GAP));
        inst.startPoint = pos;
        if (inst.loopStart < pos) inst.loopStart = snapZero(pos, inst.buffer);
        break;
      case 'endPoint':
        pos = Math.max(inst.startPoint + MIN_GAP, Math.min(pos, len));
        inst.endPoint = pos;
        if (inst.loopEnd > pos) inst.loopEnd = snapZero(pos, inst.buffer);
        break;
      case 'loopStart':
        inst.loopStart = Math.max(inst.startPoint, Math.min(pos, inst.loopEnd - MIN_GAP));
        break;
      case 'loopEnd':
        inst.loopEnd = Math.max(inst.loopStart + MIN_GAP, Math.min(pos, inst.endPoint));
        break;
    }

    drawWaveform(inst);
    ['sp-val','ls-val','le-val','ep-val'].forEach((id, i) => {
      const keys = ['startPoint','loopStart','loopEnd','endPoint'];
      const el = document.getElementById(id); if (el) el.textContent = inst[keys[i]];
    });
  });
  window.addEventListener('mouseup', () => { dragKey = null; });
}

// ── ADSR canvas ───────────────────────────────────────────────
// ── ADSR Canvas — draggable handles + playhead ────────────────
// env = { a, d, s, r }  (a/d/r in seconds, s in 0..1)
// Handles:
//   A  — x = attack time,  y = fixed peak (top)
//   D  — x = decay time,   y = sustain level
//   S  — x = hold end,     y = sustain level (sustain level only)
//   R  — x = release time, y = fixed zero (bottom)
// playhead: fraction 0..1 of the total timeline drawn as a vertical line
//
// wireADSR(canvasId, prefix, env, col) sets up all mouse/touch events.

const ADSR_TOTAL = 2.0;   // seconds the whole canvas represents
const ADSR_HOLD  = 0.4;   // hold time shown between D and R

// Map env values → canvas x/y coordinates
function adsrPoints(env, W, H) {
  const { a, d, s, r } = env;
  const T = ADSR_TOTAL, hold = ADSR_HOLD;
  const pad = 6;
  const xA   = (a / T) * W;
  const xD   = xA + (d / T) * W;
  const xS2  = xD + (hold / T) * W;
  const xR   = Math.min(W - pad, xS2 + (r / T) * W);
  const yPk  = pad;
  const ySus = H - pad - s * (H - pad * 2);
  const yBot = H - pad;
  return { xA, xD, xS2, xR, yPk, ySus, yBot, pad };
}

function drawADSR(cv, env, col, playheadFrac = -1) {
  if (!cv) return;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth  || 300;
  const cssH = cv.clientHeight || 72;
  if (cv.width !== Math.round(cssW * dpr)) {
    cv.width  = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
  }
  const c = cv.getContext('2d');
  c.save(); c.scale(dpr, dpr);
  const W = cssW, H = cssH;

  // Background
  c.fillStyle = '#050010'; c.fillRect(0, 0, W, H);

  // Grid lines
  c.strokeStyle = 'rgba(180,80,220,0.06)'; c.lineWidth = 1;
  for (let y = H * 0.25; y < H; y += H * 0.25) {
    c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
  }

  const { xA, xD, xS2, xR, yPk, ySus, yBot } = adsrPoints(env, W, H);

  // Fill
  c.fillStyle = col + '22';
  c.beginPath();
  c.moveTo(0, yBot); c.lineTo(xA, yPk);
  c.lineTo(xD, ySus); c.lineTo(xS2, ySus); c.lineTo(xR, yBot);
  c.closePath(); c.fill();

  // Line
  c.strokeStyle = col; c.lineWidth = 1.5; c.setLineDash([]);
  c.shadowColor = col; c.shadowBlur = 4;
  c.beginPath();
  c.moveTo(0, yBot); c.lineTo(xA, yPk);
  c.lineTo(xD, ySus); c.lineTo(xS2, ySus); c.lineTo(xR, yBot);
  c.stroke(); c.shadowBlur = 0;

  // Section labels
  c.font = '700 7px Silkscreen, monospace';
  c.fillStyle = col + '60'; c.textAlign = 'center'; c.textBaseline = 'top';
  c.fillText('A', xA / 2, 2);
  c.fillText('D', (xA + xD) / 2, 2);
  c.fillText('S', (xD + xS2) / 2, 2);
  c.fillText('R', Math.min(W - 8, (xS2 + xR) / 2), 2);

  // Drag handles — filled circles
  const handles = [
    { x: xA,  y: yPk,  key: 'a', label: 'A' },
    { x: xD,  y: ySus, key: 'd', label: 'D' },
    { x: xS2, y: ySus, key: 's', label: 'S' },
    { x: xR,  y: yBot, key: 'r', label: 'R' },
  ];
  const drag = cv._adsrDrag;
  handles.forEach(h => {
    const active = drag && drag.key === h.key;
    c.beginPath();
    c.arc(h.x, h.y, active ? 6 : 4.5, 0, Math.PI * 2);
    c.fillStyle = active ? '#ffffff' : col;
    c.shadowColor = col; c.shadowBlur = active ? 10 : 4;
    c.fill(); c.shadowBlur = 0;
    // Key letter inside
    c.fillStyle = active ? '#000000' : '#000010';
    c.font = '700 6px Silkscreen, monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(h.label, h.x, h.y);
  });

  // Playhead
  if (playheadFrac >= 0 && playheadFrac <= 1) {
    const px = playheadFrac * W;
    c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = 1; c.setLineDash([2, 2]);
    c.beginPath(); c.moveTo(px, 0); c.lineTo(px, H); c.stroke();
    c.setLineDash([]);
  }

  c.restore();
}

// Update the text readout below a canvas
function updateADSRReadout(prefix, env) {
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set(`${prefix}-a-ro`, Math.round(env.a * 1000) + 'ms');
  set(`${prefix}-d-ro`, Math.round(env.d * 1000) + 'ms');
  set(`${prefix}-s-ro`, Math.round(env.s * 100)  + '%');
  set(`${prefix}-r-ro`, Math.round(env.r * 1000) + 'ms');
}

// wireADSR — attach mouse/touch drag to a canvas
function wireADSR(canvasId, prefix, env, col) {
  const cv = document.getElementById(canvasId);
  if (!cv) return;

  // Store drag state on the canvas element itself so drawADSR can read it
  cv._adsrDrag = null;

  const HIT_R = 10; // hit radius in CSS px

  function getPos(e) {
    const r = cv.getBoundingClientRect();
    const px = e.touches ? e.touches[0].clientX : e.clientX;
    const py = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (px - r.left), y: (py - r.top) };
  }

  function hitTest(mx, my) {
    const W = cv.clientWidth || 300, H = cv.clientHeight || 72;
    const { xA, xD, xS2, xR, yPk, ySus, yBot } = adsrPoints(env, W, H);
    const pts = { a:[xA,yPk], d:[xD,ySus], s:[xS2,ySus], r:[xR,yBot] };
    let best = null, bestD = HIT_R;
    for (const [key, [hx, hy]] of Object.entries(pts)) {
      const d = Math.hypot(mx - hx, my - hy);
      if (d < bestD) { bestD = d; best = key; }
    }
    return best;
  }

  function applyDrag(key, mx, my) {
    const W = cv.clientWidth || 300, H = cv.clientHeight || 72;
    const T = ADSR_TOTAL, hold = ADSR_HOLD, pad = 6;
    const fx = mx / W, fy = my / H;

    // Convert canvas fraction to time or level
    switch (key) {
      case 'a': {
        const t = Math.max(0.001, fx * T);
        env.a = Math.min(T * 0.5, t);
        break;
      }
      case 'd': {
        // x relative to end of attack
        const aFrac = env.a / T;
        env.d = Math.max(0.001, Math.min(T * 0.5, (fx - aFrac) * T));
        // y → sustain level (inverted)
        env.s = Math.max(0, Math.min(1, 1 - (my - pad) / (H - pad * 2)));
        break;
      }
      case 's': {
        // only y → sustain level
        env.s = Math.max(0, Math.min(1, 1 - (my - pad) / (H - pad * 2)));
        break;
      }
      case 'r': {
        const holdEnd = (env.a + env.d + hold) / T;
        env.r = Math.max(0.001, Math.min(T * 0.6, (fx - holdEnd) * T));
        break;
      }
    }
  }

  function redraw() {
    drawADSR(cv, env, col);
    updateADSRReadout(prefix, env);
  }

  function onDown(e) {
    e.preventDefault();
    const { x, y } = getPos(e);
    const key = hitTest(x, y);
    if (!key) return;
    cv._adsrDrag = { key };
    redraw();

    const onMove = e2 => {
      e2.preventDefault();
      const p = getPos(e2);
      applyDrag(cv._adsrDrag.key, p.x, p.y);
      redraw();
    };
    const onUp = () => {
      cv._adsrDrag = null;
      redraw();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend',  onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend',  onUp);
  }

  // Right-click on a handle → reset it to default
  function onContext(e) {
    e.preventDefault();
    const { x, y } = getPos(e);
    const key = hitTest(x, y);
    if (!key) return;
    const def = makeADSR();
    env[key] = def[key];
    redraw();
  }

  cv.addEventListener('mousedown',  onDown);
  cv.addEventListener('touchstart', onDown, { passive: false });
  cv.addEventListener('contextmenu', onContext);

  // Hover: change cursor near handles
  cv.addEventListener('mousemove', e => {
    const { x, y } = getPos(e);
    cv.style.cursor = hitTest(x, y) ? 'grab' : 'default';
  });

  // Initial draw
  requestAnimationFrame(() => { drawADSR(cv, env, col); updateADSRReadout(prefix, env); });
}

// Playhead on envelope: call this every animation frame during note playback
// voices[ch].adsrPhase and .adsrPhaseStart are set in triggerNote/releaseNote
function updateADSRPlayheads() {
  // For each active voice, draw playhead on vol-adsr if that instrument is selected
  let frac = -1;
  for (let ch = 0; ch < NUM_CH; ch++) {
    const v = voices[ch];
    // Check gainNode (persists during release) not node (cleared on release)
    if (!v.gainNode || v.instIdx !== curSmpSlot) continue;
    if (v.adsrPhaseStart == null) continue;
    const actx2 = getActx();
    const elapsed = actx2.currentTime - v.adsrPhaseStart;
    const inst = song.instruments[v.instIdx];
    if (!inst) continue;
    const { a, d, r } = inst.volEnv;
    const hold = ADSR_HOLD;
    if (v.adsrReleased) {
      const relFrac = Math.min(1, elapsed / Math.max(0.001, r));
      const rStart = (a + d + hold) / ADSR_TOTAL;
      frac = Math.min(1, rStart + relFrac * (r / ADSR_TOTAL));
    } else {
      frac = Math.min((a + d + hold) / ADSR_TOTAL, elapsed / ADSR_TOTAL);
    }
    break;
  }
  const cv = document.getElementById('vol-adsr-canvas');
  const inst = song.instruments[curSmpSlot];
  if (cv && inst) drawADSR(cv, inst.volEnv, '#00aeff', frac);
}

// ── Sample loading ────────────────────────────────────────────
async function loadFromFile(inst, file) {
  setStatus(`LOADING: ${file.name}…`);
  try {
    const ab = await file.arrayBuffer();
    await decodeAudio(inst, ab, file.name);
  } catch(e) { setStatus(`ERROR: ${e.message}`); }
}

async function loadFromUrl(inst, url) {
  if (!url) return;
  setStatus(`FETCHING: ${url.slice(0,60)}…`);
  const proxies = [u=>u, u=>`https://corsproxy.io/?${encodeURIComponent(u)}`, u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`];
  for (const wrap of proxies) {
    try {
      const r = await fetch(wrap(url), {mode:'cors'});
      if (!r.ok) throw new Error('HTTP '+r.status);
      const ab = await r.arrayBuffer();
      await decodeAudio(inst, ab, url.split('/').pop().split('?')[0]);
      return;
    } catch(e) { /* try next */ }
  }
  setStatus('ERROR: Could not fetch URL (CORS). Try a direct .mp3/.wav link.');
}

function cropSample(inst) {
  if (!inst?.buffer) return;
  getActx();
  const buf  = inst.buffer;
  const sp   = inst.startPoint || 0;
  const ep   = inst.endPoint > sp ? inst.endPoint : buf.length;
  const len  = ep - sp;
  if (len <= 0) { setStatus('CROP: endPoint must be after startPoint.'); return; }

  const out = actx.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.getChannelData(c).set(buf.getChannelData(c).subarray(sp, ep));
  }

  // Remap loop markers relative to new buffer
  const newLoopStart = Math.max(0, inst.loopStart - sp);
  const newLoopEnd   = Math.min(len, inst.loopEnd   - sp);

  inst.buffer     = out;
  inst.startPoint = 0;
  inst.endPoint   = len;
  inst.loopStart  = newLoopStart;
  inst.loopEnd    = newLoopEnd > newLoopStart ? newLoopEnd : len;
  wfZoomStart = 0; wfZoomEnd = 1;
  renderSmpEditor();
  setStatus(`CROPPED: ${len} samples`);
}

async function decodeAudio(inst, ab, name) {
  const ctx2 = getActx();
  const buf = await ctx2.decodeAudioData(ab);
  inst.buffer     = buf;
  inst.name       = (name || '').replace(/\.[^.]+$/, '').slice(0, 22);
  inst.startPoint = 0;
  inst.endPoint   = buf.length;
  inst.loopStart  = 0;
  inst.loopEnd    = buf.length;
  setStatus(`LOADED: ${inst.name} (${buf.duration.toFixed(2)}s · ${buf.sampleRate}Hz)`);
  renderSmpEditor(); renderSmpList(); renderInstList();
}

let micRecorder = null;
async function startMicRecord(inst) {
  if (micRecorder?.state === 'recording') {
    micRecorder.stop(); setStatus('PROCESSING…'); return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    const chunks = [];
    micRecorder = new MediaRecorder(stream);
    micRecorder.ondataavailable = e => chunks.push(e.data);
    micRecorder.onstop = async () => {
      const blob = new Blob(chunks, {type:'audio/webm'});
      await decodeAudio(inst, await blob.arrayBuffer(), 'REC');
      stream.getTracks().forEach(t=>t.stop()); micRecorder=null;
    };
    micRecorder.start();
    setStatus('● RECORDING… press MIC again to stop');
    renderSmpEditor();
  } catch(e) { setStatus('MIC ERROR: '+e.message); }
}

// Per-instrument self-choking preview voices
const previewVoices = new Map(); // instIdx → { src }

function stopPreview(instIdx) {
  const pv = previewVoices.get(instIdx);
  if (pv) { try { pv.src.stop(); } catch(_) {} previewVoices.delete(instIdx); }
}

function previewSample(inst) {
  if (!inst?.buffer) return;
  getActx();
  const idx = song.instruments.indexOf(inst);
  stopPreview(idx);

  const sr = inst.buffer.sampleRate;
  let playBuf = inst.buffer;

  // Build ping-pong buffer if needed
  if (inst.loop && inst.loopMode === 1 && inst.loopEnd > inst.loopStart) {
    playBuf = buildPingPong(inst);
  }

  const src = actx.createBufferSource();
  src.buffer = playBuf;
  const g = actx.createGain(); g.gain.value = volCurve(inst.volume / 128) * 2.0;
  src.connect(g); g.connect(masterGain);

  const startSec = (inst.startPoint || 0) / sr;

  if (inst.loop && inst.loopEnd > inst.loopStart) {
    const ls = Math.max(inst.startPoint, inst.loopStart);
    const le = Math.min(inst.endPoint > 0 ? inst.endPoint : inst.buffer.length, inst.loopEnd);
    if (le > ls + 4) {
      src.loop = true;
      if (inst.loopMode === 1) {
        const ppSr   = playBuf.sampleRate;
        const segLen = inst.loopEnd - inst.loopStart;
        src.loopStart = inst.loopStart / ppSr;
        src.loopEnd   = (inst.loopStart + segLen * 2) / ppSr;
      } else {
        src.loopStart = ls / sr;
        src.loopEnd   = le / sr;
      }
    }
  src.start(0, startSec);
  _previewStartTime = actx.currentTime;
  _previewInstIdx   = song.instruments.indexOf(inst);
  setTimeout(() => { stopPreview(idx); _previewStartTime = -1; _previewInstIdx = -1; }, 3000);
  } else {
    const ep     = inst.endPoint > inst.startPoint ? inst.endPoint : inst.buffer.length;
    const durSec = Math.max(0.001, (ep - (inst.startPoint || 0)) / sr);
    src.start(0, startSec, durSec);
  }

  src.onended = () => previewVoices.delete(idx);
  previewVoices.set(idx, { src });
}

function previewNote(instIdx, note) {
  getActx();
  const inst = song.instruments[instIdx]; if (!inst?.buffer) return;
  stopPreview(instIdx);
  // Reuse triggerNote on a scratch channel so ADSR/filter applies
  const scratchCh = 0;
  triggerNote(scratchCh, instIdx, note, 64, actx.currentTime);
  // Track for stopPreview compatibility
  previewVoices.set(instIdx, { src: voices[scratchCh]?.node });
}

// ── Keyboard handling ─────────────────────────────────────────
let hexEntry = { field:'', val:0, digits:0, maxDigits:0 };

document.addEventListener('keydown', e => {
  // Skip if focused on a text input
  if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
  // Blur any focused button so Space/Enter don't double-fire on it
  if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();

  const ctrl = e.ctrlKey || e.metaKey;
  const key  = e.key.toLowerCase();

  // Kill scroll keys unconditionally
  if (['ArrowUp','ArrowDown','PageUp','PageDown'].includes(e.key)) e.preventDefault();

  // Space is handled in capture phase above — never reaches here

  // Global shortcuts
  if (ctrl && key==='z') { e.preventDefault(); undoPat(); return; }
  if (ctrl && key==='s') { e.preventDefault(); saveSong(); return; }

  // Octave
  if (!ctrl && (e.key==='=' || e.key==='+')) { editOct=Math.min(8,editOct+1); document.getElementById('oct-val').textContent=editOct; return; }
  if (!ctrl && e.key==='-')                  { editOct=Math.max(0,editOct-1); document.getElementById('oct-val').textContent=editOct; return; }

  // Transport
  if (e.key==='Enter' && !e.altKey) { e.preventDefault(); playState.playing?stopPlay():startPlay(false); return; }
  if (e.altKey && !e.shiftKey)      { e.preventDefault(); playState.playing?stopPlay():startPlay(true); return; }
  if (e.shiftKey && e.altKey)       { e.preventDefault(); playRowByRow(); return; }

  // Panel switching
  if (ctrl && e.key==='ArrowUp')   { e.preventDefault(); cyclePanelUp(); return; }
  if (ctrl && e.key==='ArrowDown') { e.preventDefault(); cyclePanelDown(); return; }

  // Note preview — instrument tab: always; pattern tab: only when not in edit mode
  const onInstrumentTab = document.querySelector('.tab.active')?.dataset.tab === 'instrument';
  if ((onInstrumentTab || !editMode) && key in KEY_NOTE && !e.repeat) {
    e.preventDefault();
    const semi = KEY_NOTE[key], octOff = semi >= 12 ? 1 : 0;
    const note  = (editOct + octOff) * 12 + (semi % 12);
    if (!playState.playing) {
      getActx();
      triggerNote(0, curInstSlot, note, 64, actx.currentTime);
    } else {
      previewNote(curInstSlot, note);
    }
    return;
  }

  if (e.key === 'Escape') { stopPlay(); return; }

  // Only pattern editor navigation below
  if (document.querySelector('.tab.active')?.dataset.tab !== 'pattern') return;

  if (e.key==='ArrowUp')    { e.preventDefault(); moveRow(-1); return; }
  if (e.key==='ArrowDown')  { e.preventDefault(); moveRow(1); return; }
  if (e.key==='ArrowLeft') {
    e.preventDefault();
    if (curField > 0) { moveField(-1); }
    else { moveCh(-1); curField = 4; renderGrid(); renderHeaders(); }
    return;
  }
  if (e.key==='ArrowRight') {
    e.preventDefault();
    if (curField < 4) { moveField(1); }
    else { moveCh(1); curField = 0; renderGrid(); renderHeaders(); }
    return;
  }
  if (e.key==='Tab')        { e.preventDefault(); moveCh(e.shiftKey?-1:1); return; }
  if (e.key==='PageUp')     { e.preventDefault(); moveRow(-16); return; }
  if (e.key==='PageDown')   { e.preventDefault(); moveRow(16); return; }
  if (e.key==='Home')       { e.preventDefault(); curRow=0; renderGrid(); scrollToRow(curRow); return; }
  if (e.key==='End')        { e.preventDefault(); const pat=getEditPat(); curRow=(pat?.rows??DEF_ROWS)-1; renderGrid(); scrollToRow(curRow); return; }
  if (e.key==='Backspace')  { e.preventDefault(); clearCursorCell(); moveRow(-1); return; }

  // ── Block selection ───────────────────────────────────────
  if (e.shiftKey && !ctrl && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    if (!sel) sel = { startCh: curCh, startRow: curRow, endCh: curCh, endRow: curRow };
    if (e.key==='ArrowUp')    { sel.endRow = Math.max(0, sel.endRow - 1); curRow = sel.endRow; }
    if (e.key==='ArrowDown')  { const max=(getEditPat()?.rows??DEF_ROWS)-1; sel.endRow = Math.min(max, sel.endRow + 1); curRow = sel.endRow; }
    if (e.key==='ArrowLeft')  { sel.endCh = Math.max(0, sel.endCh - 1); curCh = sel.endCh; }
    if (e.key==='ArrowRight') { sel.endCh = Math.min(NUM_CH-1, sel.endCh + 1); curCh = sel.endCh; }
    renderGrid(); scrollToRow(curRow); renderHeaders(); return;
  }
  if (ctrl && key==='a') { // select all channels, all rows
    e.preventDefault();
    const rows = (getEditPat()?.rows ?? DEF_ROWS) - 1;
    sel = { startCh: 0, startRow: 0, endCh: NUM_CH-1, endRow: rows };
    renderGrid(); return;
  }
  if (ctrl && key==='c' && sel) {
    e.preventDefault();
    const pat = getEditPat(); if (!pat) return;
    const r0=Math.min(sel.startRow,sel.endRow), r1=Math.max(sel.startRow,sel.endRow);
    const c0=Math.min(sel.startCh, sel.endCh),  c1=Math.max(sel.startCh, sel.endCh);
    clipboard = { w: c1-c0+1, h: r1-r0+1,
      data: Array.from({length:c1-c0+1}, (_,ci) =>
        Array.from({length:r1-r0+1}, (_,ri) => ({...pat.data[c0+ci][r0+ri]})))};
    setStatus(`COPIED ${clipboard.w}ch × ${clipboard.h}rows`); return;
  }
  if (ctrl && key==='x' && sel) {
    e.preventDefault();
    const pat = getEditPat(); if (!pat) return;
    snapshotPat();
    const r0=Math.min(sel.startRow,sel.endRow), r1=Math.max(sel.startRow,sel.endRow);
    const c0=Math.min(sel.startCh, sel.endCh),  c1=Math.max(sel.startCh, sel.endCh);
    clipboard = { w: c1-c0+1, h: r1-r0+1,
      data: Array.from({length:c1-c0+1}, (_,ci) =>
        Array.from({length:r1-r0+1}, (_,ri) => ({...pat.data[c0+ci][r0+ri]})))};
    for (let ci=c0;ci<=c1;ci++) for (let ri=r0;ri<=r1;ri++) pat.data[ci][ri]=makeCell();
    sel=null; renderGrid(); setStatus(`CUT ${clipboard.w}ch × ${clipboard.h}rows`); return;
  }
  if (ctrl && key==='v' && clipboard) {
    e.preventDefault();
    const pat = getEditPat(); if (!pat) return;
    snapshotPat();
    for (let ci=0;ci<clipboard.w;ci++) {
      const dstCh = curCh+ci; if (dstCh>=NUM_CH) break;
      for (let ri=0;ri<clipboard.h;ri++) {
        const dstRow = curRow+ri; if (dstRow>=pat.rows) break;
        pat.data[dstCh][dstRow] = {...clipboard.data[ci][ri]};
      }
    }
    sel = { startCh:curCh, startRow:curRow, endCh:Math.min(NUM_CH-1,curCh+clipboard.w-1), endRow:Math.min(pat.rows-1,curRow+clipboard.h-1) };
    renderGrid(); setStatus(`PASTED ${clipboard.w}ch × ${clipboard.h}rows`); return;
  }
  if (ctrl && key==='d' && sel) { // duplicate — copy then paste below selection
    e.preventDefault();
    const pat = getEditPat(); if (!pat) return;
    snapshotPat();
    const r0=Math.min(sel.startRow,sel.endRow), r1=Math.max(sel.startRow,sel.endRow);
    const c0=Math.min(sel.startCh, sel.endCh),  c1=Math.max(sel.startCh, sel.endCh);
    const block = Array.from({length:c1-c0+1}, (_,ci) =>
      Array.from({length:r1-r0+1}, (_,ri) => ({...pat.data[c0+ci][r0+ri]})));
    const pasteRow = r1+1;
    for (let ci=0;ci<=c1-c0;ci++) for (let ri=0;ri<r1-r0+1;ri++) {
      const dr=pasteRow+ri; if (dr>=pat.rows) break;
      pat.data[c0+ci][dr]={...block[ci][ri]};
    }
    renderGrid(); setStatus('DUPLICATED'); return;
  }
  // Escape clears selection
  if (!sel && e.key==='Escape') { stopPlay(); return; }
  if (sel && e.key==='Escape')  { sel=null; renderGrid(); return; }

  // ── Edit mode: write to pattern ───────────────────────────
  if (curField === 0 && key in KEY_NOTE && !e.repeat) {
    e.preventDefault();
    const semi=KEY_NOTE[key], octOff=semi>=12?1:0;
    const note=(editOct+octOff)*12+(semi%12);
    placeNote(note); return;
  }
  if (curField === 0 && (e.key==='`'||e.key==='NumpadDecimal')) {
    e.preventDefault();
    snapshotPat();
    const cell=getCell(); cell.note=NOTE_OFF; cell.inst=cell.vol=cell.fx=cell.fxp=null;
    moveRow(editAdd); renderGrid(); return;
  }
  if (curField===1 && /^[0-9a-fA-F]$/.test(e.key)) { e.preventDefault(); snapshotPat(); enterHex('inst',e.key,2,v=>{const i=Math.max(0,Math.min(NUM_INST-1,v-1));getCell().inst=v===0?null:i;}); return; }
  if (curField===2 && /^[0-9a-fA-F]$/.test(e.key)) { e.preventDefault(); snapshotPat(); enterHex('vol', e.key,2,v=>getCell().vol=Math.max(0,Math.min(64,v))); return; }
  if (curField===3 && /^[0-9a-fA-F]$/.test(e.key)) { e.preventDefault(); snapshotPat(); enterHex('fx',  e.key,1,v=>getCell().fx=v); return; }
  if (curField===4 && /^[0-9a-fA-F]$/.test(e.key)) { e.preventDefault(); snapshotPat(); enterHex('fxp', e.key,2,v=>getCell().fxp=Math.min(255,v)); return; }
});

// Key release — stop preview voice
document.addEventListener('keyup', e => {
  if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
  const key = e.key.toLowerCase();
  if (key in KEY_NOTE && !playState.playing && actx) {
    // Short fade-out regardless of instrument release setting — loop must stop on key release
    const v = voices[0];
    if (v.gainNode) {
      const t = actx.currentTime;
      v.gainNode.gain.cancelScheduledValues(t);
      v.gainNode.gain.setValueAtTime(Math.max(0.0001, v.gainNode.gain.value), t);
      v.gainNode.gain.exponentialRampToValueAtTime(0.0001, t + 0.04); // 40ms fade
      try { v.node?.stop(t + 0.05); } catch(_) {}
      v.node = null;
      v.adsrReleased = true;
      v.adsrPhaseStart = t;
    }
  }
});

function enterHex(field, key, maxD, cb) {
  if (hexEntry.field !== field) hexEntry = {field,val:0,digits:0,maxDigits:maxD};
  hexEntry.val = (hexEntry.val<<4)|parseInt(key,16); hexEntry.digits++;
  cb(hexEntry.val);
  if (hexEntry.digits >= hexEntry.maxDigits) { hexEntry={field:'',val:0,digits:0,maxDigits:0}; moveRow(editAdd); }
  renderGrid();
}

function clearCursorCell() {
  const cell = getCell();
  switch(curField) {
    case 0: cell.note=NOTE_NONE;cell.inst=cell.vol=cell.fx=cell.fxp=null; break;
    case 1: cell.inst=null; break;
    case 2: cell.vol=null; break;
    case 3: cell.fx=cell.fxp=null; break;
    case 4: cell.fxp=null; break;
  }
  renderGrid();
}

function moveRow(d)   { const rows=getEditPat()?.rows??DEF_ROWS; curRow=((curRow+d)%rows+rows)%rows; renderGrid(); scrollToRow(curRow); }
function moveCh(d)    { curCh=((curCh+d)%NUM_CH+NUM_CH)%NUM_CH; renderGrid(); renderHeaders(); }
function moveField(d) { curField=Math.max(0,Math.min(4,curField+d)); renderGrid(); }
function getCell()    { const pat=getEditPat();if(!pat)return makeCell();return pat.data[curCh][curRow]; }

function placeNote(note) {
  snapshotPat();
  const cell = getCell();
  cell.note = Math.max(0, Math.min(119, note));
  cell.inst = curInstSlot;
  previewNote(curInstSlot, note);
  moveRow(editAdd);
}

// ── Undo ──────────────────────────────────────────────────────
const undoStacks = new Map();

function snapshotPat() {
  const pat = getEditPat(); if (!pat) return;
  if (!undoStacks.has(pat.id)) undoStacks.set(pat.id, []);
  const stack = undoStacks.get(pat.id);
  stack.push(JSON.parse(JSON.stringify(pat.data)));
  if (stack.length > 64) stack.shift();
}

function undoPat() {
  const pat = getEditPat(); if (!pat) return;
  const stack = undoStacks.get(pat.id);
  if (!stack?.length) { setStatus('NOTHING TO UNDO.'); return; }
  pat.data = stack.pop();
  renderGrid();
  setStatus('UNDO.');
}


function toggleEditMode() {
  editMode = !editMode;
  const btn = document.getElementById('btn-edit');
  btn.classList.toggle('active', editMode);
  btn.textContent = editMode ? 'Edit ON' : 'Edit';
  document.getElementById('panel-pattern')?.classList.toggle('edit-on', editMode);
  setStatus(editMode ? 'EDIT MODE ON' : 'EDIT MODE OFF');
}

function playRowByRow() {
  // Play current row once and advance
  if (!playState.playing) getActx();
  const patIdx = song.order[playState.orderIdx] ?? curPat;
  const pat = song.patterns[patIdx] ?? getEditPat(); if (!pat) return;
  const t = actx.currentTime + 0.01;
  for (let ch = 0; ch < NUM_CH; ch++) {
    const cell = pat.data[ch]?.[curRow]; if (!cell) continue;
    if (cell.note === NOTE_OFF) { releaseNote(ch, t); continue; }
    if (cell.note !== NOTE_NONE) {
      const instIdx = cell.inst != null ? cell.inst : voices[ch].instIdx;
      triggerNote(ch, instIdx, cell.note, cell.vol, t);
    }
  }
  moveRow(editAdd);
}

// ── Panel cycling ─────────────────────────────────────────────
const TABS = ['pattern','instrument','song','mixer'];
function cyclePanelUp()   { const i=TABS.indexOf(activeTab()); switchTab(TABS[(i-1+TABS.length)%TABS.length]); }
function cyclePanelDown() { const i=TABS.indexOf(activeTab()); switchTab(TABS[(i+1)%TABS.length]); }
function activeTab() { return document.querySelector('.tab.active')?.dataset.tab||'pattern'; }

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('hidden',p.id!==`panel-${name}`));
  if (name==='pattern')   { renderGrid(); renderHeaders(); document.getElementById('pattern-grid').focus(); }
  if (name==='instrument'){ renderSmpList(); renderInstList(); renderSmpEditor(); }
  if (name==='song')      { renderSongTab(); }
  if (name==='mixer')     { renderMixer(); }
}

// ── Song tab ──────────────────────────────────────────────────
function renderSongTab() {
  // Order editor
  const ordEl = document.getElementById('order-editor'); ordEl.innerHTML='';
  song.order.forEach((patIdx,i)=>{
    const row=document.createElement('div');
    row.className='ord-row'+(patIdx===curPat?' active':'');
    row.innerHTML=`<span class="ord-idx">${i.toString().padStart(2,'0')}:</span><span class="ord-pat">${patIdx.toString(16).toUpperCase().padStart(2,'0')}</span>`;
    row.addEventListener('click',()=>{ curPat=patIdx; document.getElementById('pat-val').textContent=curPat.toString(16).toUpperCase().padStart(2,'0'); renderSongTab();renderGrid();renderOrderList();switchTab('pattern'); });
    ordEl.appendChild(row);
  });

  // Pattern list editor
  const patEl=document.getElementById('pat-list-editor'); patEl.innerHTML='';
  song.patterns.forEach((pat,i)=>{
    const row=document.createElement('div');
    row.className='pat-row'+(i===curPat?' active':'');
    const uses=song.order.filter(o=>o===i).length;
    row.innerHTML=`<span class="pat-idx">${i.toString(16).toUpperCase().padStart(2,'0')}</span><span>${pat.rows} rows</span><span class="pat-rows">×${uses} in order</span>`;
    row.addEventListener('click',()=>{ curPat=i; document.getElementById('pat-val').textContent=curPat.toString(16).toUpperCase().padStart(2,'0'); renderSongTab();renderGrid();renderOrderList();switchTab('pattern'); });
    patEl.appendChild(row);
  });
}

// ── Mixer ─────────────────────────────────────────────────────
// Reverb/delay send nodes — created lazily
let reverbNode = null, delayNode = null, reverbSends = [], delaySends = [];

function ensureFxNodes() {
  if (!actx) return;
  if (!reverbNode) {
    // Simple convolver reverb (1.5s impulse)
    reverbNode = actx.createConvolver();
    const len  = actx.sampleRate * 1.5;
    const ir   = actx.createBuffer(2, len, actx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/len, 2);
    }
    reverbNode.buffer = ir;
    const rvGain = actx.createGain(); rvGain.gain.value = 0.6;
    reverbNode.connect(rvGain); rvGain.connect(masterGain);
  }
  if (!delayNode) {
    delayNode = actx.createDelay(2.0);
    delayNode.delayTime.value = 0.375; // 1/8 at 80bpm approx
    const fb = actx.createGain(); fb.gain.value = 0.4;
    delayNode.connect(fb); fb.connect(delayNode);
    const dlGain = actx.createGain(); dlGain.gain.value = 0.5;
    delayNode.connect(dlGain); dlGain.connect(masterGain);
  }
  // Ensure send gain nodes exist for each channel
  for (let ch = 0; ch < NUM_CH; ch++) {
    if (!reverbSends[ch]) {
      const g = actx.createGain(); g.gain.value = mixerState.chReverb?.[ch] ?? 0;
      analysers[ch].connect(g); g.connect(reverbNode);
      reverbSends[ch] = g;
    }
    if (!delaySends[ch]) {
      const g = actx.createGain(); g.gain.value = mixerState.chDelay?.[ch] ?? 0;
      analysers[ch].connect(g); g.connect(delayNode);
      delaySends[ch] = g;
    }
  }
}

// Init send state
if (!mixerState.chReverb) mixerState.chReverb = Array(NUM_CH).fill(0);
if (!mixerState.chDelay)  mixerState.chDelay  = Array(NUM_CH).fill(0);
let soloedCh = -1; // -1 = no solo

function applyMixerToAudio() {
  if (!actx) return;
  ensureFxNodes();
  for (let ch = 0; ch < NUM_CH; ch++) {
    const muted   = mixerState.chMute[ch] || (soloedCh >= 0 && soloedCh !== ch);
    if (chGainNodes[ch]) chGainNodes[ch].gain.setTargetAtTime(muted ? 0 : mixerState.chVol[ch], actx.currentTime, 0.01);
    if (chPanNodes[ch])  chPanNodes[ch].pan.setTargetAtTime(mixerState.chPan[ch], actx.currentTime, 0.01);
    if (reverbSends[ch]) reverbSends[ch].gain.setTargetAtTime(mixerState.chReverb[ch], actx.currentTime, 0.01);
    if (delaySends[ch])  delaySends[ch].gain.setTargetAtTime(mixerState.chDelay[ch], actx.currentTime, 0.01);
  }
  if (masterCompressor) {
    const mc = mixerState.compressor;
    masterCompressor.threshold.setTargetAtTime(mc.threshold, actx.currentTime, 0.01);
    masterCompressor.ratio.setTargetAtTime(mc.ratio, actx.currentTime, 0.01);
    masterCompressor.attack.setTargetAtTime(mc.attack, actx.currentTime, 0.01);
    masterCompressor.release.setTargetAtTime(mc.release, actx.currentTime, 0.01);
  }
}

function renderMixer() {
  getActx(); ensureFxNodes();
  const chEl = document.getElementById('mixer-channels');
  chEl.innerHTML = '';

  for (let ch = 0; ch < NUM_CH; ch++) {
    const col = CH_COLOURS[ch];
    const strip = document.createElement('div');
    strip.className = 'mix-strip';

    // Channel label
    const lbl = document.createElement('div');
    lbl.className = 'mix-ch-label'; lbl.textContent = `CH${ch+1}`;
    lbl.style.color = col; strip.appendChild(lbl);

    // Volume fader (vertical drag)
    const volWrap = document.createElement('div');
    volWrap.className = 'mix-fader-wrap';
    const volTrack = document.createElement('div'); volTrack.className = 'mix-fader-track';
    const volThumb = document.createElement('div'); volThumb.className = 'mix-fader-thumb';
    volThumb.style.background = col;
    const volVal = document.createElement('div'); volVal.className = 'mix-fader-val';

    function setVol(v) {
      mixerState.chVol[ch] = Math.max(0, Math.min(2, v));
      const pct = (1 - mixerState.chVol[ch] / 2) * 100;
      volThumb.style.top = pct.toFixed(1) + '%';
      volVal.textContent  = Math.round(mixerState.chVol[ch] * 100) + '%';
      applyMixerToAudio();
    }
    setVol(mixerState.chVol[ch]);

    let dragY = null, dragStartVol = null;
    volThumb.addEventListener('mousedown', e => {
      dragY = e.clientY; dragStartVol = mixerState.chVol[ch]; e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (dragY == null) return;
      const trackH = volTrack.clientHeight || 100;
      const delta  = (dragY - e.clientY) / trackH * 2;
      setVol(dragStartVol + delta);
    });
    document.addEventListener('mouseup', () => { dragY = null; });
    volThumb.addEventListener('dblclick', () => setVol(1.0));

    volTrack.appendChild(volThumb);
    volWrap.appendChild(volTrack);
    volWrap.appendChild(volVal);
    strip.appendChild(volWrap);

    // Pan drag-val
    const panEl = document.createElement('span');
    panEl.className = 'drag-val mix-pan';
    panEl.title = 'Pan — drag left/right · dblclick=center';
    const panFmt = v => v === 0 ? 'C' : (v > 0 ? 'R' : 'L') + Math.abs(Math.round(v*100));
    panEl.textContent = panFmt(mixerState.chPan[ch]);
    panEl.style.setProperty('--fill', ((mixerState.chPan[ch]+1)/2*100).toFixed(1)+'%');

    let panDragX = null, panDragStart = null;
    panEl.addEventListener('mousedown', e => { panDragX = e.clientX; panDragStart = mixerState.chPan[ch]; e.preventDefault(); });
    document.addEventListener('mousemove', e => {
      if (panDragX == null) return;
      const v = Math.max(-1, Math.min(1, panDragStart + (e.clientX - panDragX) / 80));
      mixerState.chPan[ch] = Math.round(v * 100) / 100;
      panEl.textContent = panFmt(mixerState.chPan[ch]);
      panEl.style.setProperty('--fill', ((mixerState.chPan[ch]+1)/2*100).toFixed(1)+'%');
      applyMixerToAudio();
    });
    document.addEventListener('mouseup', () => { panDragX = null; });
    panEl.addEventListener('dblclick', () => {
      mixerState.chPan[ch] = 0;
      panEl.textContent = panFmt(0);
      panEl.style.setProperty('--fill', '50%');
      applyMixerToAudio();
    });
    strip.appendChild(panEl);

    // Reverb send
    const rvEl = document.createElement('span');
    rvEl.className = 'drag-val mix-send'; rvEl.title = 'Reverb send';
    const sendFmt = v => Math.round(v*100)+'%';
    rvEl.textContent = sendFmt(mixerState.chReverb[ch]);
    rvEl.style.setProperty('--fill', (mixerState.chReverb[ch]*100).toFixed(1)+'%');
    let rvDragX = null, rvDragStart = null;
    rvEl.addEventListener('mousedown', e => { rvDragX = e.clientX; rvDragStart = mixerState.chReverb[ch]; e.preventDefault(); });
    document.addEventListener('mousemove', e => {
      if (rvDragX == null) return;
      const v = Math.max(0, Math.min(1, rvDragStart + (e.clientX - rvDragX) / 100));
      mixerState.chReverb[ch] = Math.round(v*100)/100;
      rvEl.textContent = sendFmt(mixerState.chReverb[ch]);
      rvEl.style.setProperty('--fill', (mixerState.chReverb[ch]*100).toFixed(1)+'%');
      applyMixerToAudio();
    });
    document.addEventListener('mouseup', () => { rvDragX = null; });
    rvEl.addEventListener('dblclick', () => { mixerState.chReverb[ch]=0; rvEl.textContent=sendFmt(0); rvEl.style.setProperty('--fill','0%'); applyMixerToAudio(); });
    strip.appendChild(document.createTextNode('R'));
    strip.appendChild(rvEl);

    // Delay send
    const dlEl = document.createElement('span');
    dlEl.className = 'drag-val mix-send'; dlEl.title = 'Delay send';
    dlEl.textContent = sendFmt(mixerState.chDelay[ch]);
    dlEl.style.setProperty('--fill', (mixerState.chDelay[ch]*100).toFixed(1)+'%');
    let dlDragX = null, dlDragStart = null;
    dlEl.addEventListener('mousedown', e => { dlDragX = e.clientX; dlDragStart = mixerState.chDelay[ch]; e.preventDefault(); });
    document.addEventListener('mousemove', e => {
      if (dlDragX == null) return;
      const v = Math.max(0, Math.min(1, dlDragStart + (e.clientX - dlDragX) / 100));
      mixerState.chDelay[ch] = Math.round(v*100)/100;
      dlEl.textContent = sendFmt(mixerState.chDelay[ch]);
      dlEl.style.setProperty('--fill', (mixerState.chDelay[ch]*100).toFixed(1)+'%');
      applyMixerToAudio();
    });
    document.addEventListener('mouseup', () => { dlDragX = null; });
    dlEl.addEventListener('dblclick', () => { mixerState.chDelay[ch]=0; dlEl.textContent=sendFmt(0); dlEl.style.setProperty('--fill','0%'); applyMixerToAudio(); });
    strip.appendChild(document.createTextNode('D'));
    strip.appendChild(dlEl);

    // Mute / Solo
    const muteBtn = document.createElement('button');
    muteBtn.className = 'mix-btn' + (mixerState.chMute[ch] ? ' active' : '');
    muteBtn.textContent = 'M';
    muteBtn.addEventListener('click', () => {
      mixerState.chMute[ch] = !mixerState.chMute[ch];
      muteBtn.classList.toggle('active', mixerState.chMute[ch]);
      applyMixerToAudio();
    });
    const soloBtn = document.createElement('button');
    soloBtn.className = 'mix-btn' + (soloedCh === ch ? ' solo' : '');
    soloBtn.textContent = 'S';
    soloBtn.addEventListener('click', () => {
      soloedCh = soloedCh === ch ? -1 : ch;
      document.querySelectorAll('.mix-btn.solo').forEach(b => b.classList.remove('solo'));
      if (soloedCh >= 0) soloBtn.classList.add('solo');
      applyMixerToAudio();
    });
    strip.appendChild(muteBtn);
    strip.appendChild(soloBtn);

    chEl.appendChild(strip);
  }

  // Compressor controls
  const compEl = document.getElementById('mixer-comp-controls');
  compEl.innerHTML = '';
  const mc = mixerState.compressor;
  const compParams = [
    { label:'Thresh', key:'threshold', min:-60, max:0,    step:1,    fmt:v=>v+'dB' },
    { label:'Ratio',  key:'ratio',     min:1,   max:20,   step:0.5,  fmt:v=>v+':1' },
    { label:'Attack', key:'attack',    min:0,   max:1,    step:0.001,fmt:v=>Math.round(v*1000)+'ms' },
    { label:'Release',key:'release',   min:0,   max:2,    step:0.01, fmt:v=>Math.round(v*1000)+'ms' },
    { label:'Gain',   key:'makeupGain',min:0.5, max:4,    step:0.1,  fmt:v=>'+'+((Math.log10(v)*20).toFixed(1))+'dB' },
  ];
  compParams.forEach(p => {
    const wrap = document.createElement('div'); wrap.className = 'mix-comp-param';
    const lbl  = document.createElement('span'); lbl.className = 'field-lbl'; lbl.textContent = p.label;
    const el   = document.createElement('span'); el.className = 'drag-val';
    el.title = p.label + ' · drag left/right · dblclick=reset';
    const range = p.max - p.min;
    el.textContent = p.fmt(mc[p.key]);
    el.style.setProperty('--fill', ((mc[p.key]-p.min)/range*100).toFixed(1)+'%');
    let dx = null, dv = null;
    el.addEventListener('mousedown', e => { dx = e.clientX; dv = mc[p.key]; e.preventDefault(); });
    document.addEventListener('mousemove', e => {
      if (dx == null) return;
      const raw = dv + (e.clientX - dx) / 150 * range;
      mc[p.key] = Math.max(p.min, Math.min(p.max, Math.round(raw / p.step) * p.step));
      el.textContent = p.fmt(mc[p.key]);
      el.style.setProperty('--fill', ((mc[p.key]-p.min)/range*100).toFixed(1)+'%');
      applyMixerToAudio();
    });
    document.addEventListener('mouseup', () => { dx = null; });
    wrap.appendChild(lbl); wrap.appendChild(el);
    compEl.appendChild(wrap);
  });

  const compEnabled = document.getElementById('comp-enabled');
  if (compEnabled) {
    compEnabled.checked = mc.enabled ?? true;
    compEnabled.onchange = () => {
      mc.enabled = compEnabled.checked;
      // Bypass: connect masterGain directly to destination if disabled
      // (full bypass requires reconnecting; just slam ratio to 1 as cheap bypass)
      if (masterCompressor) masterCompressor.ratio.value = mc.enabled ? mc.ratio : 1;
    };
  }
}

// ── Save / Load ───────────────────────────────────────────────
function saveSong() {
  const data = {
    bpm:song.bpm, speed:song.speed, order:song.order,
    patterns:song.patterns.map(p=>({id:p.id,rows:p.rows,data:p.data.map(ch=>ch.map(r=>({...r})))})),
    instruments:song.instruments.map(s=>({
      name:s.name,loop:s.loop,loopMode:s.loopMode,
      loopStart:s.loopStart,loopEnd:s.loopEnd,startPoint:s.startPoint,endPoint:s.endPoint,
      baseNote:s.baseNote,volume:s.volume,finetune:s.finetune,
      volEnv:s.volEnv,filtEnv:s.filtEnv,filter:s.filter,
      vibrato:s.vibrato,tremolo:s.tremolo,panLFO:s.panLFO,
    })),
  };
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  a.download='song.vtk'; a.click();
  setStatus('SAVED.');
}

document.getElementById('btn-save').addEventListener('click',saveSong);
document.getElementById('btn-load-trigger').addEventListener('click',()=>document.getElementById('btn-load').click());
document.getElementById('btn-load').addEventListener('change',async e=>{
  const f=e.target.files[0]; if(!f)return;
  try {
    const data=JSON.parse(await f.text());
    song.bpm=data.bpm??DEF_BPM; song.speed=data.speed??DEF_SPEED;
    song.order=data.order??[0];
    song.patterns=(data.patterns??[makePattern()]).map(p=>({...p,id:p.id??uid()}));
    data.instruments?.forEach((s,i)=>{
      if(!song.instruments[i])song.instruments[i]=makeInstrument();
      Object.assign(song.instruments[i],s);
      song.instruments[i].buffer=null;
    });
    curPat=0;curRow=0;curCh=0;gridBuiltFor=null;
    updateBpmUI();updateSpeedUI();
    document.getElementById('pat-val').textContent='00';
    renderAll();
    setStatus('LOADED. Re-import audio samples — buffers not stored in .vtk');
  } catch(err){setStatus('LOAD ERROR: '+err.message);}
});

// ── Transport wiring ──────────────────────────────────────────
document.getElementById('btn-play-song').addEventListener('click',()=>{ if(playState.playing)stopPlay();else startPlay(false); });
document.getElementById('btn-play-pat') .addEventListener('click',()=>{ if(playState.playing)stopPlay();else startPlay(true); });
document.getElementById('btn-stop')     .addEventListener('click',stopPlay);
document.getElementById('btn-edit')     .addEventListener('click',toggleEditMode);

function updateBpmUI() { document.getElementById('bpm-val').textContent=song.bpm; }
function updateSpeedUI() { document.getElementById('spd-val').textContent=song.speed; }

function nudgeField(dnId,upId,get,set,min,max,update) {
  document.getElementById(dnId).addEventListener('click',()=>{set(Math.max(min,get()-1));update();});
  document.getElementById(upId).addEventListener('click',()=>{set(Math.min(max,get()+1));update();});
}
nudgeField('bpm-dn','bpm-up',()=>song.bpm,  v=>song.bpm=v,  32,255,updateBpmUI);
nudgeField('spd-dn','spd-up',()=>song.speed,v=>song.speed=v,1,31,updateSpeedUI);
nudgeField('oct-dn','oct-up',()=>editOct,v=>editOct=v,0,8,()=>document.getElementById('oct-val').textContent=editOct);
nudgeField('add-dn','add-up',()=>editAdd,v=>editAdd=v,0,16,()=>document.getElementById('add-val').textContent=editAdd);

document.getElementById('pat-dn').addEventListener('click',()=>{
  curPat=Math.max(0,curPat-1);
  document.getElementById('pat-val').textContent=curPat.toString(16).toUpperCase().padStart(2,'0');
  gridBuiltFor=null; renderGrid(); renderHeaders(); renderOrderList();
});
document.getElementById('pat-up').addEventListener('click',()=>{
  if(curPat>=song.patterns.length-1) song.patterns.push(makePattern(parseInt(document.getElementById('pat-len').value)));
  curPat=Math.min(song.patterns.length-1,curPat+1);
  document.getElementById('pat-val').textContent=curPat.toString(16).toUpperCase().padStart(2,'0');
  gridBuiltFor=null; renderGrid(); renderHeaders(); renderOrderList();
});
document.getElementById('pat-len').addEventListener('change',e=>{
  const pat=getEditPat();if(!pat)return;
  const rows=parseInt(e.target.value);
  const old=pat.rows; pat.rows=rows;
  for(let ch=0;ch<NUM_CH;ch++){
    if(rows>old){while(pat.data[ch].length<rows)pat.data[ch].push(makeCell());}
    else pat.data[ch].length=rows;
  }
  if(curRow>=rows)curRow=rows-1;
  gridBuiltFor=null; renderGrid();
});

// Order list nudges (topbar)
document.getElementById('ord-add').addEventListener('click',()=>{song.order.push(curPat);renderOrderList();});
document.getElementById('ord-del').addEventListener('click',()=>{if(song.order.length>1)song.order.pop();renderOrderList();});
document.getElementById('ord-dup').addEventListener('click',()=>{const i=song.order.indexOf(curPat);if(i>=0)song.order.splice(i+1,0,curPat);renderOrderList();});

// Song tab order list buttons
document.getElementById('song-ord-add').addEventListener('click',()=>{song.order.push(curPat);renderOrderList();renderSongTab();});
document.getElementById('song-ord-del').addEventListener('click',()=>{if(song.order.length>1)song.order.pop();renderOrderList();renderSongTab();});
document.getElementById('song-ord-dup').addEventListener('click',()=>{const i=song.order.indexOf(curPat);if(i>=0)song.order.splice(i+1,0,curPat);renderOrderList();renderSongTab();});
document.getElementById('song-pat-new').addEventListener('click',()=>{ document.getElementById('dlg-newpat').classList.remove('hidden'); });
document.getElementById('song-pat-clone').addEventListener('click',()=>{const src=getEditPat();if(!src)return;const clone=JSON.parse(JSON.stringify(src));clone.id=uid();song.patterns.push(clone);curPat=song.patterns.length-1;document.getElementById('pat-val').textContent=curPat.toString(16).toUpperCase().padStart(2,'0');renderSongTab();renderGrid();renderHeaders();renderOrderList();switchTab('pattern');});
document.getElementById('song-pat-del').addEventListener('click',()=>{if(song.patterns.length<=1){setStatus('CANNOT DELETE LAST PATTERN.');return;}song.patterns.splice(curPat,1);song.order=song.order.map(o=>o>=curPat?Math.max(0,o-1):o);curPat=Math.min(curPat,song.patterns.length-1);document.getElementById('pat-val').textContent=curPat.toString(16).toUpperCase().padStart(2,'0');renderSongTab();renderGrid();renderHeaders();renderOrderList();});

// Instrument list up/down
document.getElementById('inst-up').addEventListener('click',()=>{curInstSlot=Math.max(0,curInstSlot-1);renderInstList();renderSmpList();renderSmpEditor();});
document.getElementById('inst-dn').addEventListener('click',()=>{curInstSlot=Math.min(NUM_INST-1,curInstSlot+1);renderInstList();renderSmpList();renderSmpEditor();});
document.getElementById('smp-up')?.addEventListener('click',()=>{curSmpSlot=Math.max(0,curSmpSlot-1);curInstSlot=curSmpSlot;renderSmpList();renderInstList();renderSmpEditor();});
document.getElementById('smp-dn')?.addEventListener('click',()=>{curSmpSlot=Math.min(NUM_INST-1,curSmpSlot+1);curInstSlot=curSmpSlot;renderSmpList();renderInstList();renderSmpEditor();});

// Tab switching
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));

// Titlebar
document.getElementById('tl-close').addEventListener('click',()=>window.close());
document.getElementById('tl-min')  .addEventListener('click',()=>document.getElementById('app').style.display='none');
document.getElementById('tl-max').addEventListener('click',()=>{
  if(document.fullscreenElement)document.exitFullscreen();else document.getElementById('app').requestFullscreen?.();
});

// New-pattern dialog
document.getElementById('newpat-cancel').addEventListener('click',()=>document.getElementById('dlg-newpat').classList.add('hidden'));
document.getElementById('newpat-ok').addEventListener('click',()=>{
  const len = parseInt(document.getElementById('newpat-len').value);
  document.getElementById('dlg-newpat').classList.add('hidden');
  song.patterns.push(makePattern(len));
  curPat = song.patterns.length - 1;
  document.getElementById('pat-val').textContent = curPat.toString(16).toUpperCase().padStart(2,'0');
  renderSongTab(); renderGrid(); renderHeaders(); renderOrderList(); switchTab('pattern');
});

// Mouse wheel on pattern grid
document.getElementById('grid-scroll').addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  const scroll = document.getElementById('grid-scroll');
  scroll.scrollTop = Math.max(0, scroll.scrollTop + e.deltaY);
}, { passive: false });

// ── Disk operations ───────────────────────────────────────────
function setDiskStatus(msg) {
  const el = document.getElementById('disk-status');
  if (el) el.textContent = msg;
}

// Save module — reuse saveSong logic
document.getElementById('disk-save-mod').addEventListener('click', () => {
  saveSong();
  setDiskStatus('MODULE SAVED.');
});

// Load module — trigger file picker
document.getElementById('disk-load-mod').addEventListener('click', () => {
  document.getElementById('disk-load-file').click();
});
document.getElementById('disk-load-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  setDiskStatus(`LOADING: ${f.name}…`);
  try {
    const data = JSON.parse(await f.text());
    song.bpm     = data.bpm   ?? DEF_BPM;
    song.speed   = data.speed ?? DEF_SPEED;
    song.order   = data.order ?? [0];
    song.patterns = (data.patterns ?? [makePattern()]).map(p => ({ ...p, id: p.id ?? uid() }));
    data.instruments?.forEach((d, i) => {
      if (!song.instruments[i]) song.instruments[i] = makeInstrument();
      Object.assign(song.instruments[i], d);
      song.instruments[i].buffer = null; // buffers not serialised
    });
    curPat = 0; curRow = 0; curCh = 0;
    updateBpmUI(); updateSpeedUI();
    document.getElementById('pat-val').textContent = '00';
    renderAll(); switchTab('pattern');
    setDiskStatus(`LOADED: ${f.name}`);
  } catch (err) { setDiskStatus(`ERROR: ${err.message}`); }
  e.target.value = '';
});

// Save sample — export current instrument buffer as WAV
document.getElementById('disk-save-smp').addEventListener('click', () => {
  const inst = song.instruments[curSmpSlot];
  if (!inst?.buffer) { setDiskStatus('NO SAMPLE LOADED.'); return; }
  const buf = inst.buffer;
  const nch = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
  const pcm = new Float32Array(len * nch);
  for (let c = 0; c < nch; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < len; i++) pcm[i * nch + c] = ch[i];
  }
  // Build WAV header
  const dataBytes = pcm.length * 2; // 16-bit
  const ab = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(ab);
  const ws = s => { for (let i = 0; i < s.length; i++) dv.setUint8(i + dv._off++, s.charCodeAt(i)); };
  dv._off = 0;
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  dv.setUint32(4,  36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1,  true);   // PCM
  dv.setUint16(22, nch, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * nch * 2, true);
  dv.setUint16(32, nch * 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataBytes, true);
  // Write samples as 16-bit
  for (let i = 0; i < pcm.length; i++) {
    dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), true);
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ab], { type: 'audio/wav' }));
  a.download = (inst.name || 'sample') + '.wav';
  a.click();
  setDiskStatus(`SAVED: ${a.download}`);
});

// Load sample into current instrument slot
document.getElementById('disk-load-smp').addEventListener('click', () => {
  document.getElementById('disk-load-smp-file').click();
});
document.getElementById('disk-load-smp-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  const inst = song.instruments[curSmpSlot];
  setDiskStatus(`LOADING: ${f.name}…`);
  await loadFromFile(inst, f);
  setDiskStatus(`LOADED: ${inst.name}`);
  e.target.value = '';
});

// ── Center panel view cycling ─────────────────────────────────
document.querySelectorAll('.center-view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.center-view-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.center-view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    const viewId = view === 'scope' ? 'scope-view' : view === 'disk' ? 'disk-view' : 'keyref-view';
    document.getElementById(viewId)?.classList.add('active');
  });
});

// ── Status ────────────────────────────────────────────────────
function setStatus(msg) { document.getElementById('status-msg').textContent = msg; }

// ── Full render ───────────────────────────────────────────────
function renderAll() {
  renderHeaders();
  renderGrid();
  renderOrderList();
  renderInstList();
  renderSmpList();
  buildTopbarScopes();
}

// ── Boot ──────────────────────────────────────────────────────
// Space is handled in capture phase — fires before anything else, can't be blocked
document.addEventListener('keydown', e => {
  if (e.key === 'Space' && !['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) {
    e.preventDefault();
    toggleEditMode();
    // stop so the bubble-phase handler doesn't also try to process Space
    e.stopImmediatePropagation();
  }
}, true);
renderAll();
switchTab('pattern');
setStatus('Ready.  Space=Edit · Enter=Play · Alt=Pattern · Z-M/Q-U=Notes');
document.getElementById('pattern-grid').focus();
requestAnimationFrame(drawScopes);
