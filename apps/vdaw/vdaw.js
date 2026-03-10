// ============================================================
// apps/vdaw/vdaw.js  — v5
// Sampler logic fully delegated to instruments/sampler.js.
// ============================================================

import {
    SAMPLER_DEFAULTS,
    synthSampler     as _synthSampler,
    previewSlice     as _previewSlice,
    buildSamplerPanel,
    drawSamplerWaveform,
    resizeSlices     as resizeSlicesSmart,
} from './instruments/sampler.js';

const SB_URL      = 'https://emfvqpgrdqukyioiqxhl.supabase.co';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtZnZxcGdyZHF1a3lpb2lxeGhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwOTk0OTUsImV4cCI6MjA4NzY3NTQ5NX0.D0LVlwsaMB3BEvtQdnCclXfA7-fdtUJjps1iuQihn_g';
const IDB_NAME  = 'vdaw_v4';
const IDB_STORE = 'songs';
const AUTO_KEY  = '__auto__';

// Colour palette (used in JS canvas drawing)
const C = {
    bg0:'#0e1117', bg1:'#161a22', bg2:'#1d2230', bg3:'#252c3e',
    bd:'#2e3d52', bd2:'#3d5070',
    acc:'#00aaff', acc2:'#00e5cc', acc3:'#cc44ff',
    txt:'#dde8f8', txt2:'#7a9ab8', txt3:'#445a72',
    red:'#ff3344', grn:'#00cc77', yel:'#ffcc00',
    white_key:'#c8d8e8', black_key:'#1a2030',
};

const PITCH_MIN   = 21;
const PITCH_MAX   = 108;
const PITCH_RANGE = PITCH_MAX - PITCH_MIN + 1;
const ROW_H       = 14;
const BEAT_W      = 48;
const SUBDIV      = 4;
const CELL_W      = BEAT_W / SUBDIV;
const RULER_H     = 18;
const KEY_W       = 52;   // wider: room for note names always visible

const PALETTE = [
    '#00aaff','#00e5cc','#ff3344','#cc44ff',
    '#ffcc00','#00cc77','#ff7722','#aa44ff',
    '#44bbff','#ff4499',
];

const INSTR_DEF = {
    kick:    { pitch:60,  pitchDecay:200, noiseMix:0.10, decay:250 },
    snare:   { pitch:200, pitchDecay:80,  noiseMix:0.80, decay:180 },
    hihat:   { pitch:8000,pitchDecay:20,  noiseMix:1.00, decay:80  },
    perc:    { pitch:400, pitchDecay:100, noiseMix:0.30, decay:200 },
    bass:    { wave:'sawtooth', subMix:0.5, drive:0.2, octave:0 },
    lead:    { wave:'square',   detune:0, vibratoRate:5, vibratoDepth:0 },
    pad:     { wave:'sine',     chorusDepth:0.3, chorusRate:0.8, reverbSend:0.4 },
    pluck:   { decay:0.9, tone:0.5 },
    sampler: { ...SAMPLER_DEFAULTS },
};
const AMP_DEF    = { attack:10, decay:100, sustain:70, release:300 };
const FILTER_DEF = { type:'lowpass', cutoff:8000, resonance:1, envDepth:0,
                     attack:10, decay:200, sustain:50, release:400 };
const MASTER_DEF = { threshold:-24, ratio:4, knee:10, attack:10, release:150, makeup:6, volume:80 };

// ═══════════════════════════════════════════════════════════
export async function initVDAW({ registerWindow, openWindow }) {

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('vdaw.css', import.meta.url).href;
    document.head.appendChild(link);

    try {
        const res  = await fetch(new URL('vdaw.html', import.meta.url).href);
        const html = await res.text();
        document.body.insertAdjacentHTML('beforeend', html);
    } catch(e) { console.error('[vdaw] html fail', e); return; }

    const winEl = document.getElementById('vdaw-window');
    if (!winEl) return;
    const entry = registerWindow(winEl, { icon:'🎹' });
    document.getElementById('open-vdaw')
        ?.addEventListener('dblclick', () => openWindow(entry));

    winEl.querySelector('.close-btn')?.addEventListener('click', () => {
        stopPlay(); if (actx) actx.suspend();
    });
    winEl.querySelector('.minimize-btn')?.addEventListener('click', stopPlay);

    // ── Song state ─────────────────────────────────────────
    let song = makeSong();
    let selectedTrackId = null;
    let instrPanelOpen  = false;
    let masterPanelOpen = false;
    let isDirty = false;
    let rollMode = 'draw';   // 'draw' | 'erase' | 'select'
    let selectedNoteIds = new Set();
    let autoSaveTimer = null;
    let idb = null;

    function makeSong() {
        return { name:'Untitled', bpm:120, swing:0, bars:4,
                 master:{ ...MASTER_DEF }, tracks:[] };
    }
    function makeTrack(type='bass') {
        const idx = song.tracks.length;
        return { id:uid(), name:`${capFirst(type)} ${idx+1}`,
                 color:PALETTE[idx % PALETTE.length], type,
                 muted:false, soloed:false, volume:80,
                 amp:{ ...AMP_DEF }, filter:{ ...FILTER_DEF },
                 instr:{ ...INSTR_DEF[type] }, notes:[] };
    }

    // ── Audio ──────────────────────────────────────────────
    let actx=null, compNode=null, masterGain=null;
    let sampleBuffers={}, reverbNode=null;

    function getActx() {
        if (actx) { if (actx.state==='suspended') actx.resume(); return actx; }
        actx = new (window.AudioContext||window.webkitAudioContext)();
        compNode   = actx.createDynamicsCompressor();
        masterGain = actx.createGain();
        compNode.connect(masterGain);
        masterGain.connect(actx.destination);
        buildReverb(); applyMaster();
        return actx;
    }
    function applyMaster() {
        if (!compNode) return;
        const m = song.master;
        compNode.threshold.value = m.threshold;
        compNode.ratio.value     = m.ratio;
        compNode.knee.value      = m.knee;
        compNode.attack.value    = m.attack  / 1000;
        compNode.release.value   = m.release / 1000;
        if (masterGain)
            masterGain.gain.value = Math.pow(10,m.makeup/20)*(m.volume/100)*0.85;
    }
    async function buildReverb() {
        const ctx=actx, sr=ctx.sampleRate, len=sr*2.5;
        const buf=ctx.createBuffer(2,len,sr);
        for(let ch=0;ch<2;ch++){const d=buf.getChannelData(ch);for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/len,2);}
        reverbNode=ctx.createConvolver(); reverbNode.buffer=buf;
        reverbNode.connect(masterGain);
    }
    async function loadSample(src) {
        if (sampleBuffers[src]) return sampleBuffers[src];
        try {
            const url=new URL(src,import.meta.url).href;
            const res=await fetch(url); if(!res.ok) return null;
            sampleBuffers[src]=await actx.decodeAudioData(await res.arrayBuffer());
            return sampleBuffers[src];
        } catch { return null; }
    }

    // ── DOM refs ───────────────────────────────────────────
    const screenTrack   = document.getElementById('vdaw-screen-track');
    const mixerStrips   = document.getElementById('vdaw-mixer-strips');
    const masterStripEl = document.getElementById('vdaw-master-strip');
    const masterVolEl   = document.getElementById('vdaw-master-vol');
    const mvolLbl       = document.getElementById('vdaw-mvol-lbl');
    const rollCanvas    = document.getElementById('vdaw-roll');
    const rulerCanvas   = document.getElementById('vdaw-ruler');
    const keyCanvas     = document.getElementById('vdaw-key-labels');
    const rollScroll    = document.getElementById('vdaw-roll-scroll');
    const playheadEl    = document.getElementById('vdaw-playhead');
    const instrPanel    = document.getElementById('vdaw-instr-panel');
    const masterPanel   = document.getElementById('vdaw-master-panel');
    const instrPanelScr = document.getElementById('vdaw-instr-panel-scroll');
    const instrHdr      = document.getElementById('vdaw-instr-hdr');
    const instrBody     = document.getElementById('vdaw-instr-body');
    const instrType     = document.getElementById('vdaw-insp-type');
    const filtTypeSeg   = document.getElementById('vdaw-filt-type');
    const rollTabs      = document.getElementById('vdaw-roll-tabs');
    const rollBack      = document.getElementById('vdaw-roll-back');
    const rollCrumbDot  = document.getElementById('vdaw-roll-crumb-dot');
    const rollCrumbNm   = document.getElementById('vdaw-roll-crumb-name');
    const playBtn       = document.getElementById('vdaw-play');
    const stopBtn       = document.getElementById('vdaw-stop');
    const bpmVal        = document.getElementById('vdaw-bpm-val');
    const bpmDn         = document.getElementById('vdaw-bpm-dn');
    const bpmUp         = document.getElementById('vdaw-bpm-up');
    const swingSlider   = document.getElementById('vdaw-swing');
    const swingLbl      = document.getElementById('vdaw-swing-lbl');
    const barsDn        = document.getElementById('vdaw-bars-dn');
    const barsUp        = document.getElementById('vdaw-bars-up');
    const barsVal       = document.getElementById('vdaw-bars-val');
    const saveBtn       = document.getElementById('vdaw-save');
    const addTrkBtn     = document.getElementById('vdaw-add-track');
    const autosaveEl    = document.getElementById('vdaw-autosave');
    const pips          = [0,1,2,3].map(i=>document.getElementById(`vdaw-pip-${i}`));
    const rollCtx       = rollCanvas.getContext('2d');
    const rulerCtx      = rulerCanvas.getContext('2d');
    const keyCtx        = keyCanvas.getContext('2d');

    // ── Screen navigation ──────────────────────────────────
    function goTo(screen) { screenTrack.classList.toggle('to-1', screen===1); }
    rollBack.addEventListener('click', () => { goTo(0); closeAllPanels(); });

    // ── Roll mode toolbar ──────────────────────────────────
    const rollToolbar = document.createElement('div');
    rollToolbar.className = 'vdaw-roll-toolbar';
    rollToolbar.innerHTML = `
      <div class="vdaw-roll-modes">
        <button class="vdaw-mode-btn active" data-mode="draw"   title="Draw (D)">✏ DRAW</button>
        <button class="vdaw-mode-btn"        data-mode="erase"  title="Erase (E)">✕ ERASE</button>
        <button class="vdaw-mode-btn"        data-mode="select" title="Select (S)">⬚ SELECT</button>
        <button class="vdaw-mode-btn"        data-mode="slide"  title="Slide (L)">⤴ SLIDE</button>
      </div>
      <div class="vdaw-roll-hint-txt" id="vdaw-roll-hint-txt"></div>`;
    document.getElementById('vdaw-screen-roll')
        .querySelector('.vdaw-screen-hdr').after(rollToolbar);

    rollToolbar.querySelectorAll('.vdaw-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            rollMode = btn.dataset.mode;
            syncModeButtons();
            updateRollHint();
            if (rollMode !== 'select') { selectedNoteIds.clear(); selBox=null; }
            if (rollMode !== 'slide' && rollMode !== 'select') { /* no slide notes to deselect */ }
            renderRoll();
        });
    });

    function syncModeButtons() {
        rollToolbar.querySelectorAll('.vdaw-mode-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.mode === rollMode));
    }
    function updateRollHint() {
        const el = document.getElementById('vdaw-roll-hint-txt');
        if (!el) return;
        const hints = {
            draw:   'Left-click: draw note · Right-click note or empty: delete · Drag right edge: resize · Drag bottom: velocity',
            erase:  'Left-click / drag to erase notes',
            select: 'Drag: rubber-band select · Drag selection: move · Right-click selection: delete · Left-click selected note: copy to cursor',
            slide:  'Left-click: place slide note (glide target) · Right-click slide note: delete it · Drag right edge: set glide duration',
        };
        el.textContent = hints[rollMode] || '';
    }

    // Keyboard shortcuts (no modifier needed — D/E/S in roll)
    document.addEventListener('keydown', e => {
        if (winEl.classList.contains('hidden') || winEl.classList.contains('minimized')) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.code === 'Space') { e.preventDefault(); getActx(); playState.playing ? pausePlay() : startPlay(); }
        if (!e.ctrlKey && !e.metaKey) {
            if (e.code === 'KeyD') { rollMode='draw';   syncModeButtons(); updateRollHint(); }
            if (e.code === 'KeyE') { rollMode='erase';  syncModeButtons(); updateRollHint(); }
            if (e.code === 'KeyS') { rollMode='select'; syncModeButtons(); updateRollHint(); selectedNoteIds.clear(); selBox=null; renderRoll(); }
            if (e.code === 'KeyL') { rollMode='slide';  syncModeButtons(); updateRollHint(); }
        }
    });

    // ── INSTR panel tab toggle ─────────────────────────────
    rollTabs.addEventListener('click', e => {
        const btn = e.target.closest('.vdaw-roll-tab'); if (!btn) return;
        const tab = btn.dataset.tab;
        rollTabs.querySelectorAll('.vdaw-roll-tab').forEach(b =>
            b.classList.toggle('active', b.dataset.tab===tab));
        if (tab==='instr') {
            masterPanel.classList.remove('open'); masterPanelOpen=false;
            instrPanel.classList.add('open'); instrPanelOpen=true;
        } else {
            instrPanel.classList.remove('open'); instrPanelOpen=false;
        }
    });

    masterStripEl.addEventListener('click', () => {
        closeAllPanels(); goTo(1);
        masterPanel.classList.add('open'); masterPanelOpen=true;
        rollTabs.querySelectorAll('.vdaw-roll-tab').forEach(b=>b.classList.remove('active'));
    });

    function closeAllPanels() {
        instrPanel.classList.remove('open'); masterPanel.classList.remove('open');
        instrPanelOpen=masterPanelOpen=false;
        rollTabs.querySelectorAll('.vdaw-roll-tab').forEach(b=>
            b.classList.toggle('active', b.dataset.tab==='notes'));
    }

    // ── Transport ──────────────────────────────────────────
    playBtn.addEventListener('click', () => { getActx(); playState.playing ? pausePlay() : startPlay(); });
    stopBtn.addEventListener('click', stopPlay);
    bpmDn.addEventListener('click', ()=>setBpm(song.bpm-1));
    bpmUp.addEventListener('click', ()=>setBpm(song.bpm+1));
    makeHold(bpmDn, ()=>setBpm(song.bpm-1));
    makeHold(bpmUp, ()=>setBpm(song.bpm+1));
    swingSlider.addEventListener('input', ()=>{ song.swing=+swingSlider.value; swingLbl.textContent=song.swing+'%'; markDirty(); });
    barsDn.addEventListener('click', ()=>setBars(song.bars-1));
    barsUp.addEventListener('click', ()=>setBars(song.bars+1));
    addTrkBtn.addEventListener('click', ()=>showAddTrackPicker());
    saveBtn.addEventListener('click', saveCloud);

    // ── LOAD button ────────────────────────────────────────
    const loadBtn=document.createElement('button');
    loadBtn.id='vdaw-load-btn'; loadBtn.className='vdaw-tbtn vdaw-tsave';
    loadBtn.textContent='LOAD'; loadBtn.style.marginLeft='4px';
    loadBtn.addEventListener('click', loadCloud);
    saveBtn.after(loadBtn);

    // ── Toast ──────────────────────────────────────────────
    let _toastTimer=null;
    function showToast(msg){
        let t=document.getElementById('vdaw-toast');
        if(!t){ t=document.createElement('div'); t.id='vdaw-toast';
            t.style.cssText='position:absolute;bottom:48px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.82);color:#dde8f8;font-family:"Share Tech Mono",monospace;font-size:0.60rem;font-weight:700;padding:5px 12px;border-radius:4px;border:1px solid rgba(0,170,255,0.3);pointer-events:none;z-index:200;transition:opacity 0.2s;';
            winEl.appendChild(t); }
        t.textContent=msg; t.style.opacity='1';
        clearTimeout(_toastTimer); _toastTimer=setTimeout(()=>{t.style.opacity='0';},2200);
    }
    masterVolEl.addEventListener('input', ()=>{
        song.master.volume=+masterVolEl.value;
        mvolLbl.textContent=song.master.volume+'%';
        applyMaster(); markDirty();
    });

    function setBpm(v){ song.bpm=Math.max(40,Math.min(240,v)); bpmVal.textContent=song.bpm; markDirty(); }
    function setBars(v){ song.bars=Math.max(1,Math.min(32,v)); barsVal.textContent=song.bars; resizeRoll(); markDirty(); }

    masterPanel.querySelectorAll('.vdaw-knob').forEach(canvas=>{
        const v=+canvas.dataset.val; canvas._value=v; drawKnob(canvas,v);
        wireKnob(canvas, val=>{
            const key=canvas.dataset.param.split('.')[1];
            song.master[key]=val; applyMaster(); markDirty();
        });
    });

    // ── Tracks ─────────────────────────────────────────────
    function addTrack(type){ const t=makeTrack(type); song.tracks.push(t); renderMixer(); resizeRoll(); markDirty(); return t; }
    function removeTrack(id){ song.tracks=song.tracks.filter(t=>t.id!==id); if(selectedTrackId===id) selectedTrackId=song.tracks[0]?.id??null; renderMixer(); resizeRoll(); if(selectedTrackId) updateCrumbs(); markDirty(); }
    function selectTrack(id){ selectedTrackId=id; updateCrumbs(); renderMixer(); }
    function updateCrumbs(){ const trk=selectedTrack(); if(!trk) return; rollCrumbDot.style.background=trk.color; rollCrumbNm.textContent=trk.name; instrType.value=trk.type; buildInstrPanel(trk); syncFxKnobs(trk); instrHdr.textContent=trk.type.toUpperCase(); }
    function selectedTrack(){ return song.tracks.find(t=>t.id===selectedTrackId)??null; }

    // ── Mixer ──────────────────────────────────────────────
    function renderMixer(){
        mixerStrips.innerHTML='';
        song.tracks.forEach(trk=>{
            const strip=document.createElement('div');
            strip.className='vdaw-strip'+(trk.id===selectedTrackId?' selected':'');
            strip.dataset.id=trk.id;
            strip.innerHTML=`
              <button class="vdaw-strip-del" title="Delete">&#x2715;</button>
              <div class="vdaw-strip-color" style="width:10px;height:10px;border-radius:50%;background:${trk.color};border:1.5px solid rgba(255,255,255,0.15);flex-shrink:0"></div>
              <div class="vdaw-strip-name">${esc(trk.name)}</div>
              <div class="vdaw-strip-type">${trk.type.toUpperCase()}</div>
              <div class="vdaw-vu"><div class="vdaw-vu-fill" id="vu-${trk.id}"></div></div>
              <div class="vdaw-fader-track">
                <div class="vdaw-fader-groove"></div>
                <input type="range" class="vdaw-fader-input" min="0" max="100" value="${trk.volume}" data-id="${trk.id}">
              </div>
              <div class="vdaw-ms-row">
                <button class="vdaw-mute-btn${trk.muted?' on':''}" data-id="${trk.id}">M</button>
                <button class="vdaw-solo-btn${trk.soloed?' on':''}" data-id="${trk.id}">S</button>
              </div>
              <div class="vdaw-strip-open">&#9654; EDIT</div>`;
            strip.addEventListener('click', e=>{
                if(e.target.closest('.vdaw-strip-del')||e.target.closest('.vdaw-fader-input')||e.target.closest('.vdaw-mute-btn')||e.target.closest('.vdaw-solo-btn')) return;
                selectTrack(trk.id); closeAllPanels(); resizeRoll(); renderRoll(); goTo(1);
            });
            strip.querySelector('.vdaw-strip-del').addEventListener('click',e=>{ e.stopPropagation(); removeTrack(trk.id); });
            strip.querySelector('.vdaw-fader-input').addEventListener('input',e=>{ trk.volume=+e.target.value; markDirty(); });
            strip.querySelector('.vdaw-mute-btn').addEventListener('click',e=>{ e.stopPropagation(); trk.muted=!trk.muted; e.target.classList.toggle('on',trk.muted); renderRoll(); markDirty(); });
            strip.querySelector('.vdaw-solo-btn').addEventListener('click',e=>{ e.stopPropagation(); trk.soloed=!trk.soloed; e.target.classList.toggle('on',trk.soloed); renderRoll(); markDirty(); });
            mixerStrips.appendChild(strip);
        });
    }

    // ── Piano roll ─────────────────────────────────────────
    function isBlack(midi){ return [1,3,6,8,10].includes(midi%12); }
    function noteNameOf(midi){
        const n=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        return n[midi%12]+Math.floor(midi/12-1);
    }

    // FIX: key canvas is placed INSIDE rollScroll as a sticky left column
    // so it scrolls vertically with the roll but stays fixed horizontally.
    // This is done via CSS position:sticky + left:0 on .vdaw-key-labels
    // and placing it inside .vdaw-roll-scroll alongside the main canvas.
    function resizeRoll(){
        const rollW=Math.max(500,song.bars*4*BEAT_W);
        const rollH=PITCH_RANGE*ROW_H;
        rollCanvas.width=rollW; rollCanvas.height=rollH;
        keyCanvas.width=KEY_W;  keyCanvas.height=rollH;
        const rr=document.getElementById('vdaw-roll-right');
        rulerCanvas.width=rr?rr.clientWidth:500; rulerCanvas.height=RULER_H;
        renderKeys(); renderRoll(); renderRuler();
        if(rollScroll.scrollTop===0){
            rollScroll.scrollTop=(PITCH_MAX-60)*ROW_H-80;
        }
        resizeVelLane();
    }

    function renderKeys(){
        const ctx=keyCtx;
        ctx.clearRect(0,0,KEY_W,keyCanvas.height);
        for(let midi=PITCH_MAX;midi>=PITCH_MIN;midi--){
            const y=(PITCH_MAX-midi)*ROW_H, black=isBlack(midi);
            // Skeuomorphic piano keys
            if(black){
                ctx.fillStyle='#18202e'; ctx.fillRect(0,y,KEY_W,ROW_H-1);
                ctx.fillStyle='rgba(255,255,255,0.04)'; ctx.fillRect(0,y,KEY_W,2);
            } else {
                const grad=ctx.createLinearGradient(0,y,KEY_W,y);
                grad.addColorStop(0,'#c0cfe0'); grad.addColorStop(1,'#8fa8c0');
                ctx.fillStyle=grad; ctx.fillRect(0,y,KEY_W,ROW_H-1);
                // subtle bevel
                ctx.fillStyle='rgba(255,255,255,0.45)'; ctx.fillRect(0,y,KEY_W,1);
                ctx.fillStyle='rgba(0,0,0,0.12)'; ctx.fillRect(0,y+ROW_H-2,KEY_W,1);
            }
            // C marker accent stripe
            if(midi%12===0){
                ctx.fillStyle='rgba(0,170,255,0.50)'; ctx.fillRect(KEY_W-4,y,4,ROW_H-1);
            }
            // Note name — always show C notes, show others on non-black rows
            const showLabel=(midi%12===0)||(midi%12===5); // C and F
            if(showLabel){
                ctx.fillStyle=black?'#7a9ab8':'#1a2030';
                ctx.font=`700 8px "Share Tech Mono",monospace`;
                ctx.textAlign='left'; ctx.fillText(noteNameOf(midi),2,y+ROW_H-3);
            }
        }
    }

    function renderRuler(){
        const ctx=rulerCtx, w=rulerCanvas.width;
        ctx.fillStyle=C.bg0; ctx.fillRect(0,0,w,RULER_H);
        ctx.font='700 9px "Share Tech Mono",monospace';
        const scrollX=rollScroll.scrollLeft, totalBeats=song.bars*4;
        for(let beat=0;beat<=totalBeats;beat++){
            const x=beat*BEAT_W-scrollX;
            if(x<-BEAT_W||x>w+BEAT_W) continue;
            const isBar=beat%4===0;
            ctx.fillStyle=isBar?C.acc:C.bd2;
            ctx.fillRect(x,isBar?0:RULER_H*0.55,1,isBar?RULER_H:RULER_H*0.45);
            if(isBar){ ctx.fillStyle=C.txt2; ctx.textAlign='left'; ctx.fillText(`${(beat/4)+1}`,x+3,RULER_H-4); }
        }
        if(playState.playing){
            const phX=(playState.step/SUBDIV)*BEAT_W-scrollX;
            ctx.fillStyle='rgba(255,80,30,0.85)'; ctx.fillRect(phX,0,1,RULER_H);
        }
    }

    function renderRoll(){
        const trk=selectedTrack();
        const W=rollCanvas.width, H=rollCanvas.height;
        const ctx=rollCtx;
        ctx.clearRect(0,0,W,H);
        // Row backgrounds
        for(let midi=PITCH_MAX;midi>=PITCH_MIN;midi--){
            const y=(PITCH_MAX-midi)*ROW_H, black=isBlack(midi);
            ctx.fillStyle=black?'rgba(0,0,0,0.28)':'rgba(255,255,255,0.025)';
            ctx.fillRect(0,y,W,ROW_H);
            if(midi%12===0){ ctx.fillStyle='rgba(0,170,255,0.10)'; ctx.fillRect(0,y,W,1); }
            ctx.fillStyle='rgba(42,61,94,0.50)'; ctx.fillRect(0,y+ROW_H-1,W,1);
        }
        // Grid
        const totalBeats=song.bars*4;
        for(let beat=0;beat<=totalBeats;beat++){
            const x=beat*BEAT_W, isBar=beat%4===0;
            ctx.fillStyle=isBar?'rgba(0,170,255,0.20)':'rgba(42,61,94,0.50)';
            ctx.fillRect(x,0,1,H);
        }
        for(let sub=0;sub<totalBeats*SUBDIV;sub++){
            if(sub%SUBDIV===0) continue;
            ctx.fillStyle='rgba(42,61,94,0.20)'; ctx.fillRect(sub*CELL_W,0,1,H);
        }

        if(!trk) return;

        // Notes
        trk.notes.forEach(note=>{
            const y=(PITCH_MAX-note.pitch)*ROW_H;
            const x=note.startBeat*BEAT_W;
            const w=Math.max(CELL_W-1,note.lengthBeats*BEAT_W-1);
            const vel=note.velocity/127;
            const isSelected=selectedNoteIds.has(note.id);

            if(note.isSlide){
                // ── Slide note: rendered as a glide arrow ──────────────────
                // Body: semi-transparent pill in acc3 (purple)
                ctx.globalAlpha=trk.muted?0.15:(isSelected?0.85:0.55);
                ctx.fillStyle=isSelected?C.yel:C.acc3;
                ctx.beginPath(); rrPath(ctx,x,y+2,w,ROW_H-4,3); ctx.fill();
                // Dashed border
                ctx.globalAlpha=trk.muted?0.10:(isSelected?0.95:0.80);
                ctx.strokeStyle=isSelected?C.yel:C.acc3;
                ctx.lineWidth=1; ctx.setLineDash([3,2]);
                ctx.beginPath(); rrPath(ctx,x,y+2,w,ROW_H-4,3); ctx.stroke();
                ctx.setLineDash([]);
                // Arrow chevron pointing right
                if(w>10){
                    const mid=y+ROW_H/2, aRight=x+w-3, aLeft=Math.max(x+4,aRight-8);
                    ctx.globalAlpha=trk.muted?0.10:0.90;
                    ctx.strokeStyle=isSelected?C.bg0:'rgba(255,255,255,0.90)';
                    ctx.lineWidth=1.5; ctx.setLineDash([]);
                    ctx.beginPath();
                    ctx.moveTo(aLeft, mid-3); ctx.lineTo(aRight, mid); ctx.lineTo(aLeft, mid+3);
                    ctx.stroke();
                }
                // Label: pitch name at left
                if(w>18){
                    ctx.globalAlpha=trk.muted?0.15:0.80;
                    ctx.fillStyle=isSelected?C.bg0:'rgba(255,255,255,0.85)';
                    ctx.font=`700 7px "Share Tech Mono",monospace`;
                    ctx.textAlign='left';
                    ctx.fillText(noteNameOf(note.pitch), x+3, y+ROW_H-4);
                }
                ctx.globalAlpha=1;
            } else {
                // ── Normal note ────────────────────────────────────────────
                ctx.globalAlpha=trk.muted?0.22:0.35+vel*0.65;
                ctx.fillStyle='rgba(0,0,0,0.40)'; ctx.fillRect(x+1,y+2,w,ROW_H-2);
                ctx.fillStyle=isSelected?C.yel:trk.color;
                ctx.beginPath(); rrPath(ctx,x,y+1,w,ROW_H-2,2); ctx.fill();
                // Velocity strip
                const velBarH=Math.max(1,Math.round((ROW_H-3)*vel));
                ctx.globalAlpha=trk.muted?0.08:0.50;
                ctx.fillStyle='rgba(255,255,255,0.50)';
                ctx.fillRect(x+1, y+ROW_H-1-velBarH, Math.min(4,w-2), velBarH);
                // Highlight
                ctx.globalAlpha=(trk.muted?0.08:0.18+vel*0.12);
                ctx.fillStyle='#ffffff';
                ctx.beginPath(); rrPath(ctx,x+1,y+2,Math.max(2,w-2),3,1); ctx.fill();
                // Resize handle
                if(w>8){ ctx.globalAlpha=isSelected?0.9:0.45; ctx.fillStyle=isSelected?C.yel:'rgba(255,255,255,0.80)'; ctx.fillRect(x+w-4,y+2,3,ROW_H-4); }
                // Selected outline
                if(isSelected){ ctx.globalAlpha=0.9; ctx.strokeStyle=C.yel; ctx.lineWidth=1.5; ctx.beginPath(); rrPath(ctx,x,y+1,w,ROW_H-2,2); ctx.stroke(); }
                ctx.globalAlpha=1;
            }
        });

        // Rubber-band selection rect
        if(rollMode==='select'&&selBox){
            const sb=normalizeBox(selBox);
            ctx.globalAlpha=0.18; ctx.fillStyle=C.yel; ctx.fillRect(sb.x,sb.y,sb.w,sb.h);
            ctx.globalAlpha=0.80; ctx.strokeStyle=C.yel; ctx.lineWidth=1; ctx.setLineDash([4,3]);
            ctx.strokeRect(sb.x,sb.y,sb.w,sb.h); ctx.setLineDash([]);
            ctx.globalAlpha=1;
        }
    }

    function rrPath(ctx,x,y,w,h,r){ r=Math.min(r,w/2,h/2); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r); ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r); ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r); ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r); }

    // ── Add Track Picker ────────────────────────────────────
    function showAddTrackPicker(){
        document.getElementById('vdaw-track-picker')?.remove();
        const overlay=document.createElement('div');
        overlay.id='vdaw-track-picker';
        overlay.style.cssText='position:absolute;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(8,14,28,0.80);backdrop-filter:blur(2px);';
        const instrGroups=[
            { label:'DRUMS', items:[['kick','🥁 Kick'],['snare','🥁 Snare'],['hihat','🎩 Hi-Hat'],['perc','🪘 Perc']] },
            { label:'SYNTH', items:[['bass','🎸 Bass'],['lead','🎹 Lead'],['pad','🌊 Pad'],['pluck','🪕 Pluck']] },
            { label:'SAMPLE', items:[['sampler','🎚 Sampler']] },
        ];
        let html=`<div style="background:var(--bg1);border:1px solid var(--bd2);border-radius:8px;padding:14px 16px 16px;min-width:260px;box-shadow:0 8px 40px rgba(0,0,0,0.7);">
          <div style="font-family:'Share Tech Mono',monospace;font-size:0.65rem;font-weight:700;letter-spacing:0.14em;color:var(--acc);margin-bottom:12px;">ADD TRACK</div>`;
        instrGroups.forEach(g=>{
            html+=`<div style="font-family:'Share Tech Mono',monospace;font-size:0.50rem;letter-spacing:0.12em;color:var(--txt3);margin:8px 0 4px;">${g.label}</div><div style="display:flex;flex-wrap:wrap;gap:4px;">`;
            g.items.forEach(([type,label])=>{ html+=`<button class="vdaw-picker-btn" data-type="${type}" style="font-family:'Share Tech Mono',monospace;font-size:0.58rem;font-weight:700;padding:5px 10px;border-radius:5px;border:1px solid var(--bd2);background:var(--bg2);color:var(--txt);cursor:default;">${label}</button>`; });
            html+='</div>';
        });
        html+=`<div style="margin-top:12px;display:flex;justify-content:flex-end;"><button id="vdaw-picker-cancel" style="font-family:'Share Tech Mono',monospace;font-size:0.55rem;font-weight:700;padding:4px 12px;border-radius:4px;border:1px solid var(--bd2);background:var(--bg0);color:var(--txt2);cursor:default;">CANCEL</button></div></div>`;
        overlay.innerHTML=html;
        overlay.querySelectorAll('.vdaw-picker-btn').forEach(btn=>{
            btn.addEventListener('mouseenter',()=>{ btn.style.background='rgba(0,170,255,0.18)'; btn.style.borderColor='var(--acc)'; });
            btn.addEventListener('mouseleave',()=>{ btn.style.background='var(--bg2)'; btn.style.borderColor='var(--bd2)'; });
            btn.addEventListener('click',()=>{ overlay.remove(); addTrack(btn.dataset.type); });
        });
        overlay.querySelector('#vdaw-picker-cancel').addEventListener('click',()=>overlay.remove());
        overlay.addEventListener('click',e=>{ if(e.target===overlay) overlay.remove(); });
        winEl.appendChild(overlay);
    }

    // ── Velocity lane ──────────────────────────────────────
    const VEL_LANE_H=48;
    const velLaneWrap=document.createElement('div');
    velLaneWrap.className='vdaw-vel-lane-wrap';
    velLaneWrap.innerHTML=`<div class="vdaw-vel-lane-label">VEL</div><canvas class="vdaw-vel-lane" id="vdaw-vel-lane"></canvas>`;
    rollScroll.after(velLaneWrap);
    const velCanvas=document.getElementById('vdaw-vel-lane');
    const velCtx=velCanvas.getContext('2d');

    function resizeVelLane(){
        const w=Math.max(500,song.bars*4*BEAT_W);
        velCanvas.width=w; velCanvas.height=VEL_LANE_H;
        renderVelLane();
    }
    function renderVelLane(){
        const trk=selectedTrack();
        const W=velCanvas.width, H=VEL_LANE_H;
        velCtx.clearRect(0,0,W,H);
        velCtx.fillStyle=C.bg0; velCtx.fillRect(0,0,W,H);
        const totalBeats=song.bars*4;
        for(let beat=0;beat<=totalBeats;beat++){
            const x=beat*BEAT_W, isBar=beat%4===0;
            velCtx.fillStyle=isBar?'rgba(0,170,255,0.18)':'rgba(42,61,94,0.35)';
            velCtx.fillRect(x,0,1,H);
        }
        if(!trk) return;
        trk.notes.forEach(note=>{
            const x=note.startBeat*BEAT_W+1;
            const barW=Math.max(3,note.lengthBeats*BEAT_W-2);
            const vel=note.velocity/127;
            const barH=Math.max(2,Math.round((H-4)*vel));
            const isSelected=selectedNoteIds.has(note.id);
            velCtx.globalAlpha=trk.muted?0.2:1;
            velCtx.fillStyle='rgba(0,0,0,0.5)'; velCtx.fillRect(x+1,H-barH+1,barW,barH);
            const grad=velCtx.createLinearGradient(0,H-barH,0,H);
            grad.addColorStop(0, isSelected?'#ffcc00':trk.color);
            grad.addColorStop(1, isSelected?'rgba(255,204,0,0.3)':'rgba(0,170,255,0.2)');
            velCtx.fillStyle=grad; velCtx.fillRect(x,H-barH,barW,barH);
            velCtx.fillStyle=isSelected?'#ffee88':'rgba(255,255,255,0.5)';
            velCtx.fillRect(x,H-barH,barW,2);
            velCtx.globalAlpha=1;
        });
    }

    // Velocity lane mouse
    let velDrag={down:false,note:null};
    velCanvas.addEventListener('mousedown',e=>{ e.preventDefault(); const note=velPtrNote(e); if(!note) return; velDrag.down=true; velDrag.note=note; updateVelFromMouse(e,note); });
    velCanvas.addEventListener('mousemove',e=>{ if(!velDrag.down||!velDrag.note) return; updateVelFromMouse(e,velDrag.note); });
    velCanvas.addEventListener('mouseup',()=>{ velDrag.down=false; velDrag.note=null; markDirty(); });
    velCanvas.addEventListener('mouseleave',()=>{ velDrag.down=false; velDrag.note=null; });
    function velPtrNote(e){
        const r=velCanvas.getBoundingClientRect(), x=e.clientX-r.left;
        const trk=selectedTrack(); if(!trk) return null;
        for(let i=trk.notes.length-1;i>=0;i--){
            const n=trk.notes[i];
            if(x>=n.startBeat*BEAT_W&&x<=n.startBeat*BEAT_W+Math.max(4,n.lengthBeats*BEAT_W)) return n;
        }
        return null;
    }
    function updateVelFromMouse(e,note){
        const r=velCanvas.getBoundingClientRect(), y=e.clientY-r.top;
        note.velocity=Math.max(1,Math.min(127,Math.round((1-(y/VEL_LANE_H))*127)));
        renderRoll(); renderVelLane();
    }

    // Scroll sync: ruler and vel lane follow horizontal scroll
    rollScroll.addEventListener('scroll',()=>{
        velLaneWrap.querySelector('.vdaw-vel-lane').style.transform=`translateX(-${rollScroll.scrollLeft}px)`;
        renderRuler();
        // Key canvas vertical scroll is handled by being inside rollScroll
    });

    // ── Roll mouse ──────────────────────────────────────────
    // selBox = {x0,y0,x1,y1} in canvas coords — rubber-band rect
    let selBox = null;
    let mouse={down:false,note:null,action:null,startX:0,startY:0,startLen:0,startBeat:0,startPitch:0,startVel:0,_wasDrag:false,_selStarts:{},_selPitches:{}};

    function ptrPos(e){ const r=rollCanvas.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top}; }
    function xToBeatSnap(x){ return Math.round(x/BEAT_W*SUBDIV)/SUBDIV; }
    function yToPitch(y){ return PITCH_MAX-Math.floor(y/ROW_H); }

    const RESIZE_ZONE=10, VEL_ZONE=4;

    function noteAt(x,y){
        const trk=selectedTrack(); if(!trk) return null;
        const beat=x/BEAT_W, pitch=yToPitch(y);
        for(let i=trk.notes.length-1;i>=0;i--){
            const n=trk.notes[i];
            if(n.pitch!==pitch) continue;
            if(beat<n.startBeat||beat>n.startBeat+n.lengthBeats) continue;
            const noteRight=n.startBeat*BEAT_W+n.lengthBeats*BEAT_W;
            const noteRowY=(PITCH_MAX-n.pitch)*ROW_H;
            const relY=y-noteRowY;
            if(x>=noteRight-RESIZE_ZONE) return {note:n,action:'resize'};
            if(relY>=ROW_H-VEL_ZONE-1)   return {note:n,action:'velocity'};
            return {note:n,action:'move'};
        }
        return null;
    }

    function notesInBox(box){
        const trk=selectedTrack(); if(!trk) return [];
        const b=normalizeBox(box);
        const beatL=b.x/BEAT_W, beatR=(b.x+b.w)/BEAT_W;
        const pitchTop=yToPitch(b.y), pitchBot=yToPitch(b.y+b.h);
        return trk.notes.filter(n =>
            n.startBeat+n.lengthBeats >= beatL &&
            n.startBeat <= beatR &&
            n.pitch >= pitchBot && n.pitch <= pitchTop
        );
    }
    function normalizeBox(b){ const x=Math.min(b.x0,b.x1),y=Math.min(b.y0,b.y1),x2=Math.max(b.x0,b.x1),y2=Math.max(b.y0,b.y1); return {x,y,w:x2-x,h:y2-y}; }

    rollCanvas.addEventListener('mousemove',e=>{
        const {x,y}=ptrPos(e);
        if(mouse.down){
            const mdx=x-mouse.startX, mdy=y-mouse.startY;
            if(Math.sqrt(mdx*mdx+mdy*mdy)>4) mouse._wasDrag=true;
            if(mouse.action==='rubber'){
                selBox={x0:mouse.startX,y0:mouse.startY,x1:x,y1:y};
                // Live highlight notes inside box
                const inside=notesInBox(selBox);
                selectedNoteIds=new Set(inside.map(n=>n.id));
                renderRoll(); renderVelLane(); return;
            }
            if(mouse.action==='create'||mouse.action==='resize'){
                const newLen=Math.max(1/SUBDIV,Math.round((x/BEAT_W-mouse.note.startBeat)*SUBDIV)/SUBDIV);
                mouse.note.lengthBeats=newLen;
            } else if(mouse.action==='move'){
                const dx=x-mouse.startX, dy=y-mouse.startY;
                const beatDelta=Math.round(dx/BEAT_W*SUBDIV)/SUBDIV;
                const pitchDelta=-Math.round(dy/ROW_H);
                mouse.note.startBeat=Math.max(0,mouse.startBeat+beatDelta);
                mouse.note.pitch=Math.max(PITCH_MIN,Math.min(PITCH_MAX,mouse.startPitch+pitchDelta));
                if(selectedNoteIds.size>1&&selectedNoteIds.has(mouse.note.id)){
                    selectedTrack()?.notes.forEach(n=>{
                        if(n.id===mouse.note.id||!selectedNoteIds.has(n.id)) return;
                        n.startBeat=Math.max(0,(mouse._selStarts[n.id]??n.startBeat)+beatDelta);
                        n.pitch=Math.max(PITCH_MIN,Math.min(PITCH_MAX,(mouse._selPitches[n.id]??n.pitch)+pitchDelta));
                    });
                }
            } else if(mouse.action==='velocity'){
                const dy=y-mouse.startY;
                const norm=mouse.startVel/127;
                const sensitivity=3+norm*norm*20;
                mouse.note.velocity=Math.max(1,Math.min(127,Math.round(mouse.startVel-dy*sensitivity*0.08)));
            } else if(mouse.action==='erase'){
                const hit=noteAt(x,y);
                if(hit){ const trk=selectedTrack(); if(trk){trk.notes=trk.notes.filter(n=>n!==hit.note); markDirty();} }
            }
            renderRoll(); renderVelLane(); return;
        }
        // Cursor hint
        const hit=noteAt(x,y);
        if(rollMode==='erase') rollCanvas.style.cursor=hit?'not-allowed':'crosshair';
        else if(rollMode==='slide') rollCanvas.style.cursor=hit&&hit.note.isSlide?(hit.action==='resize'?'ew-resize':'grab'):'crosshair';
        else if(rollMode==='select'){
            if(selectedNoteIds.size>0&&hit&&selectedNoteIds.has(hit.note.id)) rollCanvas.style.cursor='grab';
            else rollCanvas.style.cursor='crosshair';
        } else if(!hit) rollCanvas.style.cursor='crosshair';
        else if(hit.action==='resize')   rollCanvas.style.cursor='ew-resize';
        else if(hit.action==='velocity') rollCanvas.style.cursor='ns-resize';
        else rollCanvas.style.cursor='grab';
    });

    rollCanvas.addEventListener('mousedown',e=>{
        if(e.button===1){ e.preventDefault(); return; }
        if(e.button!==0) return; e.preventDefault(); getActx();
        const {x,y}=ptrPos(e);
        const hit=noteAt(x,y);
        mouse.down=true; mouse.startX=x; mouse.startY=y; mouse._wasDrag=false;

        if(rollMode==='erase'){
            mouse.action='erase';
            if(hit){ const trk=selectedTrack(); if(trk){trk.notes=trk.notes.filter(n=>n!==hit.note); renderRoll(); renderVelLane(); markDirty();} }
            return;
        }

        if(rollMode==='slide'){
            // Left-click: place a slide note (or resize existing one)
            if(hit && hit.note.isSlide){
                mouse.note=hit.note; mouse.action=hit.action;
                mouse.startLen=hit.note.lengthBeats; mouse.startBeat=hit.note.startBeat;
                mouse.startPitch=hit.note.pitch; mouse.startVel=hit.note.velocity;
            } else if(!hit){
                const trk=selectedTrack(); if(!trk) return;
                const pitch=yToPitch(y);
                const sn={id:uid(),startBeat:xToBeatSnap(x),lengthBeats:1/SUBDIV,velocity:100,pitch,slide:false,isSlide:true};
                trk.notes.push(sn); mouse.note=sn; mouse.action='create';
                mouse.startBeat=sn.startBeat; mouse.startPitch=sn.pitch; mouse.startVel=sn.velocity;
                renderRoll(); renderVelLane(); markDirty();
            }
            return;
        }

        if(rollMode==='select'){
            // If clicking on an already-selected note → move the whole selection
            if(hit&&selectedNoteIds.has(hit.note.id)){
                mouse.note=hit.note; mouse.action='move';
                mouse.startBeat=hit.note.startBeat; mouse.startPitch=hit.note.pitch;
                mouse._selStarts={}; mouse._selPitches={};
                selectedTrack()?.notes.forEach(n=>{ mouse._selStarts[n.id]=n.startBeat; mouse._selPitches[n.id]=n.pitch; });
            } else {
                // Start rubber-band
                selectedNoteIds.clear();
                selBox=null;
                mouse.action='rubber';
            }
            renderRoll(); return;
        }

        // draw mode
        if(hit){
            mouse.note=hit.note; mouse.action=hit.action;
            mouse.startLen=hit.note.lengthBeats; mouse.startBeat=hit.note.startBeat;
            mouse.startPitch=hit.note.pitch; mouse.startVel=hit.note.velocity;
        } else {
            const trk=selectedTrack(); if(!trk) return;
            const pitch=yToPitch(y);
            const n={id:uid(),startBeat:xToBeatSnap(x),lengthBeats:1/SUBDIV,velocity:100,pitch,slide:false};
            trk.notes.push(n); mouse.note=n; mouse.action='create';
            mouse.startBeat=n.startBeat; mouse.startPitch=n.pitch; mouse.startVel=n.velocity;
            previewNote(trk,n); renderRoll(); renderVelLane(); markDirty();
        }
    });

    rollCanvas.addEventListener('mouseup',()=>{
        if(mouse.action==='rubber'&&selBox){
            const inside=notesInBox(selBox);
            selectedNoteIds=new Set(inside.map(n=>n.id));
            selBox=null;
            renderRoll(); renderVelLane();
        }
        if(mouse.down) markDirty();
        mouse.down=false; mouse.note=null; mouse.action=null;
    });
    rollCanvas.addEventListener('mouseleave',()=>{
        if(mouse.action==='rubber'){ selBox=null; renderRoll(); }
        if(mouse.down&&mouse.note) markDirty();
        mouse.down=false; mouse.note=null; mouse.action=null;
    });

    // Right-click: always deletes in draw/erase/slide mode.
    // In select mode: deletes the current selection.
    rollCanvas.addEventListener('contextmenu',e=>{
        e.preventDefault();
        const {x,y}=ptrPos(e);
        const hit=noteAt(x,y);
        const trk=selectedTrack(); if(!trk) return;

        if(rollMode==='select'){
            if(selectedNoteIds.size>0){
                trk.notes=trk.notes.filter(n=>!selectedNoteIds.has(n.id));
                selectedNoteIds.clear(); renderRoll(); renderVelLane(); markDirty();
            }
            return;
        }

        // draw / erase / slide — right-click deletes whatever is under cursor
        if(hit){
            trk.notes=trk.notes.filter(n=>n!==hit.note);
            renderRoll(); renderVelLane(); markDirty();
        }
    });

    // Select mode: left-click on a selected note WITHOUT dragging → copy to cursor position
    rollCanvas.addEventListener('click',e=>{
        if(rollMode!=='select') return;
        const {x,y}=ptrPos(e);
        // Suppress if the mouse moved more than 4px (it was a drag, not a click)
        const dx=x-mouse.startX, dy=y-mouse.startY;
        if(Math.sqrt(dx*dx+dy*dy)>4) return;
        if(mouse._wasDrag) return;

        const hit=noteAt(x,y);
        const trk=selectedTrack(); if(!trk) return;
        if(selectedNoteIds.size===0) return;
        if(!hit||!selectedNoteIds.has(hit.note.id)) return;

        const selected=trk.notes.filter(n=>selectedNoteIds.has(n.id));
        const anchor=selected.reduce((a,b)=>a.startBeat<b.startBeat?a:b);
        const targetBeat=xToBeatSnap(x);
        const targetPitch=yToPitch(y);
        const beatOffset=targetBeat-anchor.startBeat;
        const pitchOffset=targetPitch-anchor.pitch;
        const copies=selected.map(n=>({
            ...n, id:uid(),
            startBeat:Math.max(0,n.startBeat+beatOffset),
            pitch:Math.max(PITCH_MIN,Math.min(PITCH_MAX,n.pitch+pitchOffset)),
        }));
        trk.notes.push(...copies);
        selectedNoteIds=new Set(copies.map(c=>c.id));
        renderRoll(); renderVelLane(); markDirty();
    });

    // Touch support
    let touchTimer=null;
    rollCanvas.addEventListener('touchstart',e=>{
        if(e.touches.length>1) return; e.preventDefault();
        const t=e.touches[0];
        const fe={clientX:t.clientX,clientY:t.clientY,button:0,preventDefault:()=>{}};
        touchTimer=setTimeout(()=>{
            // Long-press in draw mode on empty = place slide note
            if(rollMode==='draw'){
                const {x,y}=ptrPos(fe); const hit=noteAt(x,y);
                if(!hit){
                    const trk=selectedTrack(); if(trk){
                        const pitch=yToPitch(y);
                        const sn={id:uid(),startBeat:xToBeatSnap(x),lengthBeats:1/SUBDIV,velocity:100,pitch,slide:false,isSlide:true};
                        trk.notes.push(sn); renderRoll(); renderVelLane(); markDirty();
                    }
                }
            }
            touchTimer=null;
        },400);
        rollCanvas.dispatchEvent(Object.assign(new MouseEvent('mousedown'),fe));
    },{passive:false});
    rollCanvas.addEventListener('touchmove',e=>{
        if(e.touches.length>1){clearTimeout(touchTimer);return;} e.preventDefault(); clearTimeout(touchTimer);
        const t=e.touches[0]; rollCanvas.dispatchEvent(Object.assign(new MouseEvent('mousemove'),{clientX:t.clientX,clientY:t.clientY}));
    },{passive:false});
    rollCanvas.addEventListener('touchend',()=>{ clearTimeout(touchTimer); rollCanvas.dispatchEvent(new MouseEvent('mouseup')); });

    // ── MIDI Input ──────────────────────────────────────────
    // Wires Web MIDI API to piano roll: noteOn places/previews notes,
    // CC 64 (sustain) maps to slide toggle on last added note.
    let midiAccess=null;
    let midiHeldNotes={}; // pitch → {note, startTime}

    async function initMIDI(){
        if(!navigator.requestMIDIAccess) return;
        try {
            midiAccess=await navigator.requestMIDIAccess();
            midiAccess.inputs.forEach(input=>{
                input.onmidimessage=onMIDIMessage;
            });
            midiAccess.onstatechange=e=>{
                if(e.port.type==='input'&&e.port.state==='connected'){
                    e.port.onmidimessage=onMIDIMessage;
                }
            };
        } catch(err){ console.warn('[vdaw] MIDI unavailable', err); }
    }

    function onMIDIMessage(msg){
        const [status,pitch,vel]=msg.data;
        const cmd=status&0xf0;
        if(cmd===0x90&&vel>0){        // Note On
            midiNoteOn(pitch, vel);
        } else if(cmd===0x80||(cmd===0x90&&vel===0)){ // Note Off
            midiNoteOff(pitch);
        } else if(cmd===0xB0&&pitch===64){ // CC 64 sustain pedal → mark held notes as glide source
            if(vel>=64){
                // Place slide notes one step after each currently held note
                const trk=selectedTrack(); if(trk){
                    Object.values(midiHeldNotes).forEach(h=>{
                        const sn={id:uid(),startBeat:h.note.startBeat+h.note.lengthBeats,lengthBeats:1/SUBDIV,velocity:100,pitch:h.note.pitch,slide:false,isSlide:true};
                        trk.notes.push(sn);
                    });
                }
                renderRoll(); markDirty();
            }
        }
    }

    function midiNoteOn(pitch, vel){
        const trk=selectedTrack(); if(!trk) return;
        getActx();
        const beatPos=playState.playing ? playState.step/SUBDIV : xToBeatSnap(rollScroll.scrollLeft/BEAT_W);
        const n={id:uid(), startBeat:beatPos, lengthBeats:1/SUBDIV, velocity:Math.round(vel/127*127), pitch, slide:false};
        trk.notes.push(n);
        midiHeldNotes[pitch]={note:n, startTime:actx.currentTime};
        previewNote(trk,n);
        renderRoll(); renderVelLane(); markDirty();
    }

    function midiNoteOff(pitch){
        const held=midiHeldNotes[pitch]; if(!held) return;
        // Stretch note to how long key was held (quantised to SUBDIV)
        const dur=actx.currentTime-held.startTime;
        const beatsHeld=Math.max(1/SUBDIV, Math.round(dur*(song.bpm/60)*SUBDIV)/SUBDIV);
        held.note.lengthBeats=beatsHeld;
        delete midiHeldNotes[pitch];
        renderRoll(); renderVelLane(); markDirty();
    }

    initMIDI();

    // ── Instrument type change ─────────────────────────────
    instrType.addEventListener('change',()=>{
        const trk=selectedTrack(); if(!trk) return;
        trk.type=instrType.value; trk.instr={...INSTR_DEF[trk.type]};
        instrHdr.textContent=trk.type.toUpperCase();
        buildInstrPanel(trk); renderMixer(); markDirty();
    });
    filtTypeSeg.querySelectorAll('.vdaw-seg-btn').forEach(btn=>{
        btn.addEventListener('click',()=>{
            const trk=selectedTrack(); if(!trk) return;
            trk.filter.type=btn.dataset.val;
            filtTypeSeg.querySelectorAll('.vdaw-seg-btn').forEach(b=>b.classList.toggle('active',b.dataset.val===trk.filter.type));
            markDirty();
        });
    });

    // ── Skeumorphic Knob engine ────────────────────────────
    // Brushed aluminium face, deep shadow ring, engraved arc, indicator dot
    function drawKnob(canvas, value){
        const dpr=window.devicePixelRatio||1;
        const W=canvas.offsetWidth||44, H=canvas.offsetHeight||44;
        canvas.width=W*dpr; canvas.height=H*dpr;
        canvas.style.width=W+'px'; canvas.style.height=H+'px';
        const ctx=canvas.getContext('2d');
        ctx.scale(dpr,dpr);
        const cx=W/2, cy=H/2, r=Math.min(cx,cy)-2;

        // ── Outer bezel ring — dark machined rim ──
        const bezelGrad=ctx.createRadialGradient(cx-r*0.15,cy-r*0.25,r*0.2,cx,cy,r+2);
        bezelGrad.addColorStop(0,'#3a5070');
        bezelGrad.addColorStop(0.6,'#1a2838');
        bezelGrad.addColorStop(1,'#060c14');
        ctx.beginPath(); ctx.arc(cx,cy,r+1.5,0,Math.PI*2);
        ctx.fillStyle=bezelGrad; ctx.fill();

        // Bezel inner-shadow groove
        ctx.beginPath(); ctx.arc(cx,cy,r+1.5,0,Math.PI*2);
        ctx.strokeStyle='rgba(0,0,0,0.90)'; ctx.lineWidth=1.5; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx,cy,r-1,0,Math.PI*2);
        ctx.strokeStyle='rgba(255,255,255,0.07)'; ctx.lineWidth=1; ctx.stroke();

        // ── Main knob face — polished aluminium sphere illusion ──
        const faceGrad=ctx.createRadialGradient(cx-r*0.30,cy-r*0.35,r*0.02,cx+r*0.10,cy+r*0.10,r*1.05);
        faceGrad.addColorStop(0,'#5c7090');
        faceGrad.addColorStop(0.18,'#48607a');
        faceGrad.addColorStop(0.45,'#2e4058');
        faceGrad.addColorStop(0.72,'#1e2e42');
        faceGrad.addColorStop(0.90,'#14202e');
        faceGrad.addColorStop(1,'#0e1828');
        ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
        ctx.fillStyle=faceGrad; ctx.fill();

        // ── Fine brushed-metal radial lines (aluminium texture) ──
        ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.clip();
        for(let a=0;a<Math.PI*2;a+=Math.PI/36){
            const cos=Math.cos(a), sin=Math.sin(a);
            ctx.beginPath(); ctx.moveTo(cx+cos*r*0.5,cy+sin*r*0.5); ctx.lineTo(cx+cos*r,cy+sin*r);
            ctx.strokeStyle=`rgba(255,255,255,${0.012+0.006*(Math.sin(a*6)*0.5+0.5)})`;
            ctx.lineWidth=0.8; ctx.stroke();
        }
        ctx.restore();

        // ── Engraved travel arc ──
        const sa=0.75*Math.PI, sweep=1.5*Math.PI;
        ctx.beginPath(); ctx.arc(cx,cy,r-6,sa,sa+sweep);
        ctx.strokeStyle='rgba(0,0,0,0.65)'; ctx.lineWidth=3.5; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx,cy,r-6,sa,sa+sweep);
        ctx.strokeStyle='rgba(40,60,90,0.55)'; ctx.lineWidth=2; ctx.stroke();

        // ── Value arc — neon glow ──
        const min=+canvas.dataset.min, max=+canvas.dataset.max, isLog=!!canvas.dataset.log;
        let norm;
        if(isLog){ const lmin=Math.log(Math.max(min,0.001)),lmax=Math.log(max); norm=(Math.log(Math.max(value,0.001))-lmin)/(lmax-lmin); }
        else norm=(value-min)/(max-min);
        norm=Math.max(0,Math.min(1,norm));
        if(norm>0){
            const ea=sa+norm*sweep;
            // glow halo
            ctx.beginPath(); ctx.arc(cx,cy,r-6,sa,ea);
            ctx.strokeStyle='rgba(0,170,255,0.25)'; ctx.lineWidth=5; ctx.stroke();
            // main arc
            ctx.beginPath(); ctx.arc(cx,cy,r-6,sa,ea);
            ctx.strokeStyle=C.acc; ctx.lineWidth=2.5;
            ctx.shadowColor='rgba(0,170,255,0.80)'; ctx.shadowBlur=5;
            ctx.stroke(); ctx.shadowBlur=0;
        }

        // ── Indicator line — machined pointer ──
        const angle=sa+norm*sweep;
        const px1=cx+Math.cos(angle)*(r-10), py1=cy+Math.sin(angle)*(r-10);
        const px2=cx+Math.cos(angle)*(r-4),  py2=cy+Math.sin(angle)*(r-4);
        ctx.beginPath(); ctx.moveTo(px1,py1); ctx.lineTo(px2,py2);
        ctx.strokeStyle='rgba(0,0,0,0.70)'; ctx.lineWidth=3; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px1,py1); ctx.lineTo(px2,py2);
        ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=1.5; ctx.stroke();

        // ── Glass dome highlight — convex lens top-left catch-light ──
        // Main dome sheen
        const domeGrad=ctx.createRadialGradient(cx-r*0.28,cy-r*0.30,0,cx-r*0.10,cy-r*0.05,r*0.80);
        domeGrad.addColorStop(0,'rgba(255,255,255,0.22)');
        domeGrad.addColorStop(0.30,'rgba(255,255,255,0.08)');
        domeGrad.addColorStop(0.65,'rgba(255,255,255,0.02)');
        domeGrad.addColorStop(1,'rgba(255,255,255,0)');
        ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
        ctx.fillStyle=domeGrad; ctx.fill();

        // Small specular hot-spot
        const spotGrad=ctx.createRadialGradient(cx-r*0.32,cy-r*0.33,0,cx-r*0.32,cy-r*0.33,r*0.22);
        spotGrad.addColorStop(0,'rgba(255,255,255,0.28)');
        spotGrad.addColorStop(0.5,'rgba(255,255,255,0.08)');
        spotGrad.addColorStop(1,'rgba(255,255,255,0)');
        ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
        ctx.fillStyle=spotGrad; ctx.fill();

        // Bottom-right ambient bounce
        const bounceGrad=ctx.createRadialGradient(cx+r*0.30,cy+r*0.28,r*0.1,cx+r*0.30,cy+r*0.28,r*0.55);
        bounceGrad.addColorStop(0,'rgba(0,100,180,0.10)');
        bounceGrad.addColorStop(1,'rgba(0,100,180,0)');
        ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
        ctx.fillStyle=bounceGrad; ctx.fill();

        // Value label on hover
        if(canvas._hover){
            ctx.font=`700 ${Math.max(7,Math.round(W*0.18))}px "Share Tech Mono",monospace`;
            ctx.fillStyle='rgba(220,240,255,0.95)'; ctx.textAlign='center';
            ctx.shadowColor='rgba(0,0,0,0.90)'; ctx.shadowBlur=6;
            const disp=isLog?Math.round(value):(Number.isInteger(value)?value:value.toFixed(1));
            ctx.fillText(`${disp}${canvas.dataset.unit||''}`,cx,cy+3);
            ctx.shadowBlur=0;
        }
    }

    function wireKnob(canvas, onChange){
        let startY, startVal;
        const min=+canvas.dataset.min, max=+canvas.dataset.max, isLog=!!canvas.dataset.log;
        const onMove=e=>{
            const cy_=e.touches?e.touches[0].clientY:e.clientY, delta=cy_-startY;
            let val;
            if(isLog){ const lmin=Math.log(Math.max(min,0.001)),lmax=Math.log(max),ls=Math.log(Math.max(startVal,0.001)); val=Math.exp(Math.max(lmin,Math.min(lmax,ls-delta*(lmax-lmin)/150))); }
            else val=Math.max(min,Math.min(max,startVal-delta*(max-min)/150));
            canvas._value=val; drawKnob(canvas,val); onChange(val);
        };
        const onUp=()=>{ document.removeEventListener('mousemove',onMove); document.removeEventListener('mouseup',onUp); document.removeEventListener('touchmove',onMove); document.removeEventListener('touchend',onUp); };
        canvas.addEventListener('mousedown',e=>{ e.preventDefault(); startY=e.clientY; startVal=canvas._value??+canvas.dataset.val; document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp); });
        canvas.addEventListener('touchstart',e=>{ e.preventDefault(); startY=e.touches[0].clientY; startVal=canvas._value??+canvas.dataset.val; document.addEventListener('touchmove',onMove,{passive:false}); document.addEventListener('touchend',onUp); },{passive:false});
        canvas.addEventListener('mouseenter',()=>{ canvas._hover=true;  drawKnob(canvas,canvas._value??+canvas.dataset.val); });
        canvas.addEventListener('mouseleave',()=>{ canvas._hover=false; drawKnob(canvas,canvas._value??+canvas.dataset.val); });
    }

    function getParam(trk,path){ const [sec,key]=path.split('.'); if(sec==='amp') return trk.amp[key]; if(sec==='filter') return trk.filter[key]; if(sec==='master') return song.master[key]; }
    function setParam(trk,path,val){ const [sec,key]=path.split('.'); if(sec==='amp') trk.amp[key]=val; else if(sec==='filter') trk.filter[key]=val; else if(sec==='master'){ song.master[key]=val; applyMaster(); } markDirty(); }

    function initPanelKnobs(container){
        container.querySelectorAll('.vdaw-knob').forEach(canvas=>{
            const v=+canvas.dataset.val; canvas._value=v; drawKnob(canvas,v);
            wireKnob(canvas,val=>{
                const trk=selectedTrack();
                if(canvas.dataset.param?.startsWith('master.')){ const key=canvas.dataset.param.split('.')[1]; song.master[key]=val; applyMaster(); markDirty(); }
                else if(trk&&canvas.dataset.param){ setParam(trk,canvas.dataset.param,val); }
            });
        });
    }
    initPanelKnobs(instrPanel);

    function syncFxKnobs(trk){
        instrPanel.querySelectorAll('.vdaw-knob[data-param]').forEach(canvas=>{
            const v=getParam(trk,canvas.dataset.param); if(v===undefined) return;
            canvas._value=v; drawKnob(canvas,v);
        });
        filtTypeSeg.querySelectorAll('.vdaw-seg-btn').forEach(b=>b.classList.toggle('active',b.dataset.val===trk.filter.type));
    }

    // ── Instrument panel builder ───────────────────────────
    function waveButtons(cur){
        return [['sine','∿'],['square','⊓'],['sawtooth','⟋'],['triangle','⋀']]
            .map(([w,s])=>`<button class="vdaw-wave-btn${w===cur?' active':''}" data-wave="${w}">${s}</button>`).join('');
    }

    function buildInstrPanel(trk){
        instrBody.innerHTML='';
        const ins=trk.instr, type=trk.type;
        const isDrum=['kick','snare','hihat','perc'].includes(type);
        if(isDrum){
            instrBody.innerHTML=`<div class="vdaw-knob-row">
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="pitch"      data-min="20"   data-max="2000" data-val="${ins.pitch||200}"         data-unit="Hz" data-log="1"></canvas><span>PITCH</span></div>
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="pitchDecay" data-min="10"   data-max="500"  data-val="${ins.pitchDecay||150}"    data-unit="ms"></canvas><span>P.DEC</span></div>
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="noiseMix"   data-min="0"    data-max="100"  data-val="${(ins.noiseMix||0)*100}"  data-unit="%"></canvas><span>NOISE</span></div>
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="decay"      data-min="10"   data-max="1000" data-val="${ins.decay||200}"         data-unit="ms"></canvas><span>DECAY</span></div>
            </div>`;
        } else if(type==='bass'){
            instrBody.innerHTML=`<div class="vdaw-wave-row"><span class="vdaw-lbl">WAVE</span><div class="vdaw-wave-sel">${waveButtons(ins.wave)}</div></div>
            <div class="vdaw-knob-row">
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="subMix" data-min="0" data-max="100" data-val="${(ins.subMix||0)*100}" data-unit="%"></canvas><span>SUB</span></div>
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="drive"  data-min="0" data-max="100" data-val="${(ins.drive||0)*100}"  data-unit="%"></canvas><span>DRIVE</span></div>
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="octave" data-min="-2" data-max="2"  data-val="${ins.octave||0}"         data-unit="oct"></canvas><span>OCT</span></div>
            </div>`;
        } else if(type==='lead'){
            instrBody.innerHTML=`<div class="vdaw-wave-row"><span class="vdaw-lbl">WAVE</span><div class="vdaw-wave-sel">${waveButtons(ins.wave)}</div></div>
            <div class="vdaw-knob-row">
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="detune"       data-min="0"  data-max="100" data-val="${ins.detune||0}"       data-unit="ct"></canvas><span>DETUNE</span></div>
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="vibratoRate"  data-min="0"  data-max="20"  data-val="${ins.vibratoRate||5}"   data-unit="Hz"></canvas><span>VIB.RT</span></div>
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="vibratoDepth" data-min="0"  data-max="100" data-val="${ins.vibratoDepth||0}"  data-unit="ct"></canvas><span>VIB.DP</span></div>
            </div>`;
        } else if(type==='pad'){
            instrBody.innerHTML=`<div class="vdaw-wave-row"><span class="vdaw-lbl">WAVE</span><div class="vdaw-wave-sel">${waveButtons(ins.wave)}</div></div>
            <div class="vdaw-knob-row">
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="chorusDepth" data-min="0" data-max="100" data-val="${(ins.chorusDepth||0.3)*100}" data-unit="%"></canvas><span>CHO.D</span></div>
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="chorusRate"  data-min="0" data-max="10"  data-val="${ins.chorusRate||0.8}"         data-unit="Hz"></canvas><span>CHO.R</span></div>
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="reverbSend"  data-min="0" data-max="100" data-val="${(ins.reverbSend||0.4)*100}"   data-unit="%"></canvas><span>REVB</span></div>
            </div>`;
        } else if(type==='pluck'){
            instrBody.innerHTML=`<div class="vdaw-knob-row">
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="decay" data-min="0" data-max="100" data-val="${(ins.decay||0.9)*100}" data-unit="%"></canvas><span>DECAY</span></div>
              <div class="vdaw-kc"><canvas class="vdaw-knob vdaw-ik" data-ikey="tone"  data-min="0" data-max="100" data-val="${(ins.tone||0.5)*100}"   data-unit="%"></canvas><span>TONE</span></div>
            </div>`;
        } else if(type==='sampler'){
            buildSamplerPanel(instrBody, trk, {
                actx, sampleBuffers, masterGain, loadSample,
                KNOWN_SAMPLES, noteNameOf, markDirty, getActx,
            }); return;
        }

        instrBody.querySelectorAll('.vdaw-ik').forEach(canvas=>{
            canvas._value=+canvas.dataset.val; drawKnob(canvas,+canvas.dataset.val);
            wireKnob(canvas,v=>{
                const t=selectedTrack(); if(!t) return;
                const key=canvas.dataset.ikey;
                const pct01=['subMix','drive','noiseMix','reverbSend','chorusDepth'];
                if(pct01.includes(key)) t.instr[key]=v/100;
                else if(key==='decay'&&t.type==='pluck') t.instr[key]=v/100;
                else if(key==='tone') t.instr[key]=v/100;
                else t.instr[key]=v;
                markDirty();
            });
        });
        instrBody.querySelectorAll('.vdaw-wave-btn').forEach(btn=>{
            btn.addEventListener('click',()=>{
                const t=selectedTrack(); if(!t) return;
                t.instr.wave=btn.dataset.wave;
                instrBody.querySelectorAll('.vdaw-wave-btn').forEach(b=>b.classList.toggle('active',b.dataset.wave===t.instr.wave));
                markDirty();
            });
        });
    }

    // ── Known samples ──────────────────────────────────────
    let KNOWN_SAMPLES=[{label:'amen.wav',src:'../../../music/amen.wav'}];
    (async()=>{
        try {
            const fsRes=await fetch(new URL('../../../core/../filesystem.json',import.meta.url).href);
            const fsData=await fsRes.json();
            const musicFolder=fsData?.children?.find(c=>c.name==='Music');
            if(musicFolder?.children){
                musicFolder.children.forEach(item=>{
                    if(item.type==='audio'&&item.src&&!KNOWN_SAMPLES.some(s=>s.src===item.src))
                        KNOWN_SAMPLES.push({label:item.name,src:item.src});
                });
            }
        } catch(e){ console.warn('[vdaw] filesystem.json load failed',e); }
    })();

    // ── Sampler panel — fully handled by instruments/sampler.js ──
    // buildSamplerPanel(instrBody, trk, deps) is called from buildInstrPanel.

    // resizeSlicesSmart — re-exported from sampler.js as resizeSlices, aliased above in imports

    // Thin wrapper — delegates to imported sampler.js
    function previewSlice(ins, i) {
        _previewSlice(getActx(), ins, i, sampleBuffers, masterGain);
    }

    // drawSamplerWaveform — imported from sampler.js, exposed locally for legacy call-sites
    function _drawWaveform(canvas, ins) { drawSamplerWaveform(canvas, ins, sampleBuffers); }

    // ── Synthesis (inline — sourced from instruments/*.js in full refactor) ────
    function midiToHz(m){ return 440*Math.pow(2,(m-69)/12); }
    function makeDest(){ return compNode||masterGain||actx.destination; }

    function triggerNote(trk,note,time,slideTarget){
        const ctx=actx; if(!ctx) return;
        if(note.isSlide) return; // slide notes are not triggered directly
        const anySolo=song.tracks.some(t=>t.soloed);
        if(trk.muted||(anySolo&&!trk.soloed)) return;
        const vol=(trk.volume/100)*(note.velocity/127)*0.8;
        const dur=note.lengthBeats*(60/song.bpm);
        const dest=makeDest();
        const {amp,filter,instr,type}=trk;
        switch(type){
            case 'kick':case 'snare':case 'hihat':case 'perc':
                synthDrum(ctx,type,instr,note,vol,time,dest,slideTarget); break;
            case 'bass':   synthBass(ctx,instr,amp,filter,note,vol,time,dur,slideTarget,dest); break;
            case 'lead':   synthLead(ctx,instr,amp,filter,note,vol,time,dur,slideTarget,dest); break;
            case 'pad':    synthPad(ctx,instr,amp,filter,note,vol,time,dur,dest,reverbNode,slideTarget); break;
            case 'pluck':  synthPluck(ctx,instr,amp,filter,note,vol,time,dest,slideTarget); break;
            case 'sampler':synthSampler(ctx,instr,amp,filter,note,vol,time,dur,dest); break;
        }
    }
    function previewNote(trk,note){ if(!actx) return; triggerNote(trk,note,actx.currentTime,null); }

    function makeAmpEnv(ctx,amp,vol,t,dur){ const g=ctx.createGain(),atk=amp.attack/1000,dec=amp.decay/1000,sus=amp.sustain/100*vol,rel=amp.release/1000; g.gain.setValueAtTime(0.0001,t);g.gain.linearRampToValueAtTime(vol,t+atk);g.gain.linearRampToValueAtTime(sus,t+atk+dec);g.gain.setValueAtTime(sus,t+Math.max(atk+dec+0.001,dur-rel));g.gain.linearRampToValueAtTime(0.0001,t+dur+rel);return g; }
    function makeFilterNode(ctx,f,t,dur){ const node=ctx.createBiquadFilter();node.type=f.type;node.frequency.value=f.cutoff;node.Q.value=f.resonance;if(f.envDepth!==0){const depth=f.envDepth/100,atk=f.attack/1000,dec=f.decay/1000,sus=f.sustain/100,rel=f.release/1000,base=f.cutoff,peak=base+depth*(depth>0?(20000-base):base);node.frequency.setValueAtTime(base,t);node.frequency.linearRampToValueAtTime(peak,t+atk);node.frequency.linearRampToValueAtTime(base+(peak-base)*sus,t+atk+dec);const ne=t+Math.max(atk+dec+0.001,dur-rel);node.frequency.setValueAtTime(base+(peak-base)*sus,ne);node.frequency.linearRampToValueAtTime(base,ne+rel);}return node; }

    // synthDrum uses note.pitch to modulate base oscillator pitch + supports slideTarget
    function synthDrum(ctx,type,ins,note,vol,t,dest,slideTarget){const pitchRatio=Math.pow(2,(note.pitch-60)/12);const basePitch=ins.pitch*pitchRatio;const dur=ins.decay/1000+0.05;const g=ctx.createGain();g.gain.setValueAtTime(vol,t);g.gain.exponentialRampToValueAtTime(0.0001,t+dur);g.connect(dest);if(ins.noiseMix<1.0){const osc=ctx.createOscillator();osc.frequency.setValueAtTime(basePitch,t);osc.frequency.exponentialRampToValueAtTime(basePitch*0.3,t+ins.pitchDecay/1000);if(slideTarget){const targetPitch=ins.pitch*Math.pow(2,(slideTarget.pitch-60)/12);const slideStart=t+(slideTarget.startBeat-note.startBeat)*(60/song.bpm);const slideDur=slideTarget.lengthBeats*(60/song.bpm);osc.frequency.cancelScheduledValues(slideStart);osc.frequency.setValueAtTime(basePitch,slideStart);osc.frequency.linearRampToValueAtTime(targetPitch,slideStart+slideDur);}const og=ctx.createGain();og.gain.value=1-ins.noiseMix;osc.connect(og);og.connect(g);osc.start(t);osc.stop(t+dur+0.05);}if(ins.noiseMix>0){const len=Math.ceil(ctx.sampleRate*(dur+0.05));const buf=ctx.createBuffer(1,len,ctx.sampleRate);const d=buf.getChannelData(0);for(let i=0;i<len;i++)d[i]=Math.random()*2-1;const src=ctx.createBufferSource();src.buffer=buf;const f=ctx.createBiquadFilter();f.type=type==='hihat'?'highpass':'bandpass';f.frequency.value=basePitch;f.Q.value=0.8;const ng=ctx.createGain();ng.gain.value=ins.noiseMix;src.connect(f);f.connect(ng);ng.connect(g);src.start(t);src.stop(t+dur+0.06);}}
    function distCurve(amount){const s=256,c=new Float32Array(s);for(let i=0;i<s;i++){const x=(i*2)/s-1;c[i]=((Math.PI+amount)*x)/(Math.PI+amount*Math.abs(x));}return c;}
    function synthBass(ctx,ins,amp,filter,note,vol,t,dur,slideTarget,dest){const freq=midiToHz(note.pitch+(ins.octave||0)*12);const osc=ctx.createOscillator();osc.type=ins.wave||'sawtooth';osc.frequency.setValueAtTime(freq,t);if(slideTarget){const targetFreq=midiToHz(slideTarget.pitch+(ins.octave||0)*12);const slideStart=t+(slideTarget.startBeat-note.startBeat)*(60/song.bpm);const slideDur=slideTarget.lengthBeats*(60/song.bpm);osc.frequency.setValueAtTime(freq,slideStart);osc.frequency.linearRampToValueAtTime(targetFreq,slideStart+slideDur);}if(ins.subMix>0){const sub=ctx.createOscillator();sub.type='sine';sub.frequency.value=freq/2;const sg=ctx.createGain();sg.gain.value=ins.subMix;const fN=makeFilterNode(ctx,filter,t,dur);const gN=makeAmpEnv(ctx,amp,vol,t,dur);sub.connect(sg);sg.connect(fN);fN.connect(gN);gN.connect(dest);sub.start(t);sub.stop(t+dur+amp.release/1000+0.05);}let chain=osc;if(ins.drive>0){const ws=ctx.createWaveShaper();ws.curve=distCurve(ins.drive*400);ws.oversample='4x';osc.connect(ws);chain=ws;}const fN=makeFilterNode(ctx,filter,t,dur);const gN=makeAmpEnv(ctx,amp,vol,t,dur);chain.connect(fN);fN.connect(gN);gN.connect(dest);osc.start(t);osc.stop(t+dur+amp.release/1000+0.05);}
    function synthLead(ctx,ins,amp,filter,note,vol,t,dur,slideTarget,dest){const freq=midiToHz(note.pitch);const osc=ctx.createOscillator();osc.type=ins.wave||'square';osc.frequency.setValueAtTime(freq,t);if(slideTarget){const targetFreq=midiToHz(slideTarget.pitch);const slideStart=t+(slideTarget.startBeat-note.startBeat)*(60/song.bpm);const slideDur=slideTarget.lengthBeats*(60/song.bpm);osc.frequency.setValueAtTime(freq,slideStart);osc.frequency.linearRampToValueAtTime(targetFreq,slideStart+slideDur);}if(ins.detune>0){const o2=ctx.createOscillator();o2.type=ins.wave||'square';o2.frequency.value=freq;o2.detune.value=ins.detune;const f2=makeFilterNode(ctx,filter,t,dur);const g2=makeAmpEnv(ctx,amp,vol*0.5,t,dur);o2.connect(f2);f2.connect(g2);g2.connect(dest);o2.start(t);o2.stop(t+dur+amp.release/1000+0.05);}if(ins.vibratoDepth>0){const lfo=ctx.createOscillator();const lg=ctx.createGain();lfo.frequency.value=ins.vibratoRate||5;lg.gain.value=ins.vibratoDepth;lfo.connect(lg);lg.connect(osc.frequency);lfo.start(t+0.08);lfo.stop(t+dur+0.1);}const fN=makeFilterNode(ctx,filter,t,dur);const gN=makeAmpEnv(ctx,amp,vol,t,dur);osc.connect(fN);fN.connect(gN);gN.connect(dest);osc.start(t);osc.stop(t+dur+amp.release/1000+0.05);}
    function synthPad(ctx,ins,amp,filter,note,vol,t,dur,dest,reverbNode,slideTarget){const freq=midiToHz(note.pitch);const fN=makeFilterNode(ctx,filter,t,dur);const gN=makeAmpEnv(ctx,amp,vol,t,dur);if(ins.reverbSend>0&&reverbNode){const sg=ctx.createGain();sg.gain.value=ins.reverbSend;fN.connect(sg);sg.connect(reverbNode);}fN.connect(gN);gN.connect(dest);for(let i=0;i<4;i++){const osc=ctx.createOscillator();osc.type=ins.wave||'sine';osc.frequency.value=freq;osc.detune.value=(i-1.5)*(ins.chorusDepth||0.3)*15;if(slideTarget){const targetFreq=midiToHz(slideTarget.pitch);const detune=osc.detune.value;const slideStart=t+(slideTarget.startBeat-note.startBeat)*(60/song.bpm);const slideDur=slideTarget.lengthBeats*(60/song.bpm);osc.frequency.setValueAtTime(freq,slideStart);osc.frequency.linearRampToValueAtTime(targetFreq,slideStart+slideDur);}osc.connect(fN);osc.start(t);osc.stop(t+dur+amp.release/1000+0.1);}}
    function synthPluck(ctx,ins,amp,filter,note,vol,t,dest,slideTarget){const freq=midiToHz(note.pitch),period=Math.round(ctx.sampleRate/freq),len=Math.ceil(ctx.sampleRate*4);const buf=ctx.createBuffer(1,len,ctx.sampleRate);const data=buf.getChannelData(0);for(let i=0;i<period;i++)data[i]=(Math.random()*2-1)*vol;const decay=ins.decay||0.9,tone=ins.tone||0.5;for(let i=period;i<len;i++)data[i]=(data[i-period]*(1-tone)+data[i-period+1]*tone)*decay;const src=ctx.createBufferSource();src.buffer=buf;const fN=makeFilterNode(ctx,filter,t,4);const g=ctx.createGain();g.gain.value=1;src.connect(fN);fN.connect(g);g.connect(dest);src.start(t);src.stop(t+4.1);}
    function synthSampler(ctx,ins,amp,filter,note,vol,t,dur,dest){
        // Delegates to imported sampler.js — passes sampleBuffers cache + loadSample + amp + filter
        _synthSampler(ctx, ins, note, vol, t, dur, dest, sampleBuffers, loadSample, amp, filter);
    }

    // ── Scheduler ──────────────────────────────────────────
    const LOOKAHEAD=0.12, INTERVAL=28;
    const playState={playing:false,step:0,nextTime:0,timerId:null};
    function beatDur(){ return 60/song.bpm; }
    function subdiv16(){ return beatDur()/4; }
    function totalSteps(){ return song.bars*4*SUBDIV; }

    function startPlay(){ const ctx=getActx(); playState.playing=true;playState.step=0;playState.nextTime=ctx.currentTime+0.05; playBtn.classList.add('playing');playBtn.innerHTML='&#9646;&#9646;';sched(); }
    function pausePlay(){ playState.playing=false;clearTimeout(playState.timerId); playBtn.classList.remove('playing');playBtn.innerHTML='&#x25BA;'; }
    function stopPlay(){ pausePlay();playState.step=0; playheadEl.style.left='0px';pips.forEach(p=>p.classList.remove('on')); }

    function sched(){
        if(!playState.playing) return;
        const ctx=actx;
        while(playState.nextTime<ctx.currentTime+LOOKAHEAD){
            const step=playState.step,beat=step/SUBDIV;
            const swing=(step%2===1)?(song.swing/100)*subdiv16()*0.67:0;
            const t=playState.nextTime+swing;
            song.tracks.forEach(trk=>{
                trk.notes.forEach((note,ni)=>{
                    if(note.isSlide) return; // slide notes fire no audio directly
                    if(Math.abs(note.startBeat-beat)<(0.5/SUBDIV)){
                        // Find next slide note that starts during or just after this note
                        const noteEnd=note.startBeat+note.lengthBeats;
                        const slideTarget=trk.notes.find(sn=>
                            sn.isSlide &&
                            sn.startBeat >= note.startBeat &&
                            sn.startBeat < noteEnd + 0.5
                        ) || null;
                        triggerNote(trk,note,t,slideTarget);
                    }
                });
            });
            const capStep=step;
            requestAnimationFrame(()=>{
                if(!playState.playing) return;
                playheadEl.style.left=(capStep/SUBDIV)*BEAT_W+'px';
                const pipIdx=Math.floor(capStep/SUBDIV)%4;
                pips.forEach((p,i)=>p.classList.toggle('on',i===pipIdx));
                renderRuler();
                song.tracks.forEach(trk=>{ const el=document.getElementById(`vu-${trk.id}`); if(el){const active=trk.notes.some(n=>Math.abs(n.startBeat-capStep/SUBDIV)<(0.5/SUBDIV));el.style.width=active?(40+Math.random()*60)+'%':'0%';} });
            });
            playState.nextTime+=subdiv16(); playState.step=(step+1)%totalSteps();
        }
        playState.timerId=setTimeout(sched,INTERVAL);
    }

    // ── Persistence ────────────────────────────────────────
    async function openIDB(){return new Promise((res,rej)=>{const r=indexedDB.open(IDB_NAME,1);r.onupgradeneeded=e=>e.target.result.createObjectStore(IDB_STORE);r.onsuccess=e=>res(e.target.result);r.onerror=e=>rej(e.target.error);});}
    async function idbSet(k,v){if(!idb)idb=await openIDB();return new Promise((res,rej)=>{const tx=idb.transaction(IDB_STORE,'readwrite');tx.objectStore(IDB_STORE).put(v,k);tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});}
    async function idbGet(k){if(!idb)idb=await openIDB();return new Promise((res,rej)=>{const tx=idb.transaction(IDB_STORE,'readonly');const r=tx.objectStore(IDB_STORE).get(k);r.onsuccess=e=>res(e.target.result);r.onerror=e=>rej(e.target.error);});}

    function markDirty(){isDirty=true;autosaveEl.classList.remove('saved','saving');autosaveEl.classList.add('dirty');clearTimeout(autoSaveTimer);autoSaveTimer=setTimeout(autoSave,3000);}
    async function autoSave(){try{autosaveEl.classList.remove('dirty');autosaveEl.classList.add('saving');await idbSet(AUTO_KEY,JSON.stringify(song));autosaveEl.classList.remove('saving');autosaveEl.classList.add('saved');isDirty=false;}catch(e){console.warn('[vdaw] autosave fail',e);}}
    // ── Compressed MIDI serialisation ──────────────────────
    // Format: simple binary layout, gzip-compressed, base64-encoded.
    // Track header: [typeCode(1), colorIdx(1), volume(1), muted(1), soloed(1), nameLen(1), name(n)]
    //               amp(4×f32), filter(7×f32+typeCode(1)), instr JSON-length(2) + instr JSON(n)
    // Note: [pitch(1), startBeat×100(i16), lengthBeats×100(i16), velocity(1), flags(1)]
    //        flags: bit0=slide, bit1=isSlide

    const TYPE_IDS=['kick','snare','hihat','perc','bass','lead','pad','pluck','sampler'];
    const FILT_TYPES=['lowpass','highpass','bandpass','notch'];

    function encodeSongBinary(s){
        const enc=new TextEncoder();
        const parts=[];
        // Header: bpm(f32) swing(u8) bars(u8) master(7xf32) nameLen(u8) name
        const hdr=new DataView(new ArrayBuffer(4+1+1+7*4+1+255));
        let o=0;
        hdr.setFloat32(o,s.bpm,true); o+=4;
        hdr.setUint8(o,s.swing||0); o++;
        hdr.setUint8(o,s.bars||4); o++;
        const mk=s.master||{};
        ['threshold','ratio','knee','attack','release','makeup','volume'].forEach(k=>{hdr.setFloat32(o,mk[k]??0,true);o+=4;});
        const nameBytes=enc.encode((s.name||'Untitled').slice(0,254));
        hdr.setUint8(o,nameBytes.length); o++;
        parts.push(new Uint8Array(hdr.buffer,0,o));
        parts.push(nameBytes);

        // Tracks
        const numTracks=new Uint8Array(1); numTracks[0]=Math.min(255,s.tracks.length);
        parts.push(numTracks);
        (s.tracks||[]).forEach(trk=>{
            const typeId=TYPE_IDS.indexOf(trk.type); 
            const colorIdx=PALETTE.indexOf(trk.color);
            const th=new DataView(new ArrayBuffer(1+1+1+1+1+1+255));
            let to=0;
            th.setUint8(to,typeId<0?4:typeId); to++;
            th.setUint8(to,colorIdx<0?0:colorIdx); to++;
            th.setUint8(to,trk.volume||80); to++;
            th.setUint8(to,trk.muted?1:0); to++;
            th.setUint8(to,trk.soloed?1:0); to++;
            const tnm=enc.encode((trk.name||'').slice(0,254));
            th.setUint8(to,tnm.length); to++;
            parts.push(new Uint8Array(th.buffer,0,to)); parts.push(tnm);
            // amp
            const amp=trk.amp||AMP_DEF, ad=new DataView(new ArrayBuffer(16));
            ['attack','decay','sustain','release'].forEach((k,i)=>ad.setFloat32(i*4,amp[k]??0,true));
            parts.push(new Uint8Array(ad.buffer));
            // filter
            const f=trk.filter||FILTER_DEF, fd=new DataView(new ArrayBuffer(29));
            let fo=0;
            fd.setUint8(fo,FILT_TYPES.indexOf(f.type||'lowpass')); fo++;
            ['cutoff','resonance','envDepth','attack','decay','sustain','release'].forEach(k=>{fd.setFloat32(fo,f[k]??0,true);fo+=4;});
            parts.push(new Uint8Array(fd.buffer,0,fo));
            // instr as compact JSON
            const instrJson=enc.encode(JSON.stringify(trk.instr||{}));
            const instrLen=new DataView(new ArrayBuffer(2)); instrLen.setUint16(0,Math.min(65535,instrJson.length),true);
            parts.push(new Uint8Array(instrLen.buffer)); parts.push(instrJson.slice(0,65535));
            // notes count
            const notes=(trk.notes||[]).slice(0,65535);
            const nc=new DataView(new ArrayBuffer(2)); nc.setUint16(0,notes.length,true);
            parts.push(new Uint8Array(nc.buffer));
            notes.forEach(n=>{
                const nd=new DataView(new ArrayBuffer(7));
                nd.setUint8(0,Math.max(0,Math.min(127,n.pitch||60)));
                nd.setInt16(1,Math.round((n.startBeat||0)*100),true);
                nd.setInt16(3,Math.max(1,Math.round((n.lengthBeats||0.25)*100)),true);
                nd.setUint8(5,Math.max(1,Math.min(127,n.velocity||100)));
                nd.setUint8(6,(n.slide?1:0)|(n.isSlide?2:0));
                parts.push(new Uint8Array(nd.buffer));
            });
        });
        // Concatenate
        const total=parts.reduce((a,b)=>a+b.length,0);
        const out=new Uint8Array(total); let pos=0;
        parts.forEach(p=>{out.set(p,pos);pos+=p.length;});
        return out;
    }

    function decodeSongBinary(bytes){
        const dec=new TextDecoder();
        const dv=new DataView(bytes.buffer||bytes);
        let o=0;
        const s={};
        s.bpm=dv.getFloat32(o,true); o+=4;
        s.swing=dv.getUint8(o); o++;
        s.bars=dv.getUint8(o); o++;
        s.master={};
        ['threshold','ratio','knee','attack','release','makeup','volume'].forEach(k=>{s.master[k]=dv.getFloat32(o,true);o+=4;});
        const nameLen=dv.getUint8(o); o++;
        s.name=dec.decode(bytes.slice(o,o+nameLen)); o+=nameLen;
        s.tracks=[];
        const numTracks=dv.getUint8(o); o++;
        for(let ti=0;ti<numTracks;ti++){
            const typeId=dv.getUint8(o); o++;
            const colorIdx=dv.getUint8(o); o++;
            const volume=dv.getUint8(o); o++;
            const muted=dv.getUint8(o)===1; o++;
            const soloed=dv.getUint8(o)===1; o++;
            const tnmLen=dv.getUint8(o); o++;
            const name=dec.decode(bytes.slice(o,o+tnmLen)); o+=tnmLen;
            const type=TYPE_IDS[typeId]||'bass';
            const color=PALETTE[colorIdx]||PALETTE[0];
            // amp
            const amp={};
            ['attack','decay','sustain','release'].forEach((k,i)=>{amp[k]=dv.getFloat32(o,true);o+=4;});
            // filter
            const filtTypeId=dv.getUint8(o); o++;
            const filter={type:FILT_TYPES[filtTypeId]||'lowpass'};
            ['cutoff','resonance','envDepth','attack','decay','sustain','release'].forEach(k=>{filter[k]=dv.getFloat32(o,true);o+=4;});
            // instr
            const instrLen=dv.getUint16(o,true); o+=2;
            let instr={...INSTR_DEF[type]};
            try { instr={...instr,...JSON.parse(dec.decode(bytes.slice(o,o+instrLen)))}; } catch(e){}
            o+=instrLen;
            // notes
            const notesCount=dv.getUint16(o,true); o+=2;
            const notes=[];
            for(let ni=0;ni<notesCount;ni++){
                const pitch=dv.getUint8(o);
                const startBeat=dv.getInt16(o+1,true)/100;
                const lengthBeats=dv.getInt16(o+3,true)/100;
                const velocity=dv.getUint8(o+5);
                const flags=dv.getUint8(o+6);
                notes.push({id:uid(),pitch,startBeat,lengthBeats,velocity,slide:!!(flags&1),isSlide:!!(flags&2)});
                o+=7;
            }
            s.tracks.push({id:uid(),name,type,color,volume,muted,soloed,amp,filter,instr,notes});
        }
        return s;
    }

    // Gzip via DecompressionStream (Web API, no deps needed)
    async function gzip(data){
        const cs=new CompressionStream('gzip');
        const writer=cs.writable.getWriter(); writer.write(data); writer.close();
        const chunks=[]; const reader=cs.readable.getReader();
        while(true){const {done,value}=await reader.read(); if(done)break; chunks.push(value);}
        const total=chunks.reduce((a,b)=>a+b.length,0);
        const out=new Uint8Array(total); let pos=0;
        chunks.forEach(c=>{out.set(c,pos);pos+=c.length;}); return out;
    }
    async function gunzip(data){
        const ds=new DecompressionStream('gzip');
        const writer=ds.writable.getWriter(); writer.write(data); writer.close();
        const chunks=[]; const reader=ds.readable.getReader();
        while(true){const {done,value}=await reader.read(); if(done)break; chunks.push(value);}
        const total=chunks.reduce((a,b)=>a+b.length,0);
        const out=new Uint8Array(total); let pos=0;
        chunks.forEach(c=>{out.set(c,pos);pos+=c.length;}); return out;
    }
    function toB64(bytes){ let s=''; bytes.forEach(b=>s+=String.fromCharCode(b)); return btoa(s); }
    function fromB64(str){ const s=atob(str); const out=new Uint8Array(s.length); for(let i=0;i<s.length;i++)out[i]=s.charCodeAt(i); return out; }

    async function saveCloud(){
        saveBtn.textContent='…'; saveBtn.disabled=true;
        try {
            const raw=encodeSongBinary(song);
            const compressed=await gzip(raw);
            const b64=toB64(compressed);
            await fetch(`${SB_URL}/rest/v1/songs`,{
                method:'POST',
                headers:{'Content-Type':'application/json','apikey':SB_ANON_KEY,'Authorization':'Bearer '+SB_ANON_KEY,'Prefer':'return=minimal'},
                body:JSON.stringify({name:song.name||'Untitled',midi_data:b64,updated_at:new Date().toISOString()})
            });
            autosaveEl.classList.remove('dirty'); autosaveEl.classList.add('saved');
            showToast('✓ Saved to cloud');
        } catch(e){ console.warn('[vdaw] cloud save fail',e); showToast('⚠ Save failed'); }
        finally { saveBtn.textContent='SAVE'; saveBtn.disabled=false; }
    }

    async function loadCloud(){
        const dlBtn=document.getElementById('vdaw-load-btn'); if(dlBtn){dlBtn.textContent='…';dlBtn.disabled=true;}
        try {
            const res=await fetch(`${SB_URL}/rest/v1/songs?select=id,name,midi_data,updated_at&order=updated_at.desc&limit=20`,{
                headers:{'apikey':SB_ANON_KEY,'Authorization':'Bearer '+SB_ANON_KEY}
            });
            const rows=await res.json();
            if(!Array.isArray(rows)||rows.length===0){showToast('No saved songs found');return;}
            showSongPicker(rows);
        } catch(e){ console.warn('[vdaw] load fail',e); showToast('⚠ Load failed'); }
        finally { if(dlBtn){dlBtn.textContent='LOAD';dlBtn.disabled=false;} }
    }

    function showSongPicker(rows){
        document.getElementById('vdaw-song-picker')?.remove();
        const overlay=document.createElement('div');
        overlay.id='vdaw-song-picker';
        overlay.style.cssText='position:absolute;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(8,14,28,0.88);backdrop-filter:blur(2px);';
        let html=`<div style="background:var(--bg1);border:1px solid var(--bd2);border-radius:8px;padding:14px 16px 16px;min-width:300px;max-width:420px;box-shadow:0 8px 40px rgba(0,0,0,0.7);">
          <div style="font-family:'Share Tech Mono',monospace;font-size:0.65rem;font-weight:700;letter-spacing:0.14em;color:var(--acc);margin-bottom:10px;">LOAD SONG</div>
          <div style="max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:3px;">`;
        rows.forEach(r=>{
            const date=new Date(r.updated_at).toLocaleDateString();
            html+=`<button class="vdaw-picker-btn" data-id="${r.id}" style="font-family:'Share Tech Mono',monospace;font-size:0.58rem;font-weight:700;padding:7px 10px;border-radius:5px;border:1px solid var(--bd2);background:var(--bg2);color:var(--txt);cursor:default;text-align:left;display:flex;justify-content:space-between;align-items:center;">
              <span>${esc(r.name||'Untitled')}</span>
              <span style="color:var(--txt3);font-size:0.50rem;">${date}</span>
            </button>`;
        });
        html+=`</div><div style="margin-top:10px;display:flex;justify-content:flex-end;"><button id="vdaw-picker-cancel" style="font-family:'Share Tech Mono',monospace;font-size:0.55rem;font-weight:700;padding:4px 12px;border-radius:4px;border:1px solid var(--bd2);background:var(--bg0);color:var(--txt2);cursor:default;">CANCEL</button></div></div>`;
        overlay.innerHTML=html;
        overlay.querySelectorAll('.vdaw-picker-btn').forEach(btn=>{
            btn.addEventListener('mouseenter',()=>{btn.style.background='rgba(0,170,255,0.18)';btn.style.borderColor='var(--acc)';});
            btn.addEventListener('mouseleave',()=>{btn.style.background='var(--bg2)';btn.style.borderColor='var(--bd2)';});
            btn.addEventListener('click',async()=>{
                overlay.remove();
                const row=rows.find(r=>r.id==btn.dataset.id); if(!row||!row.midi_data) return;
                try {
                    const compressed=fromB64(row.midi_data);
                    const raw=await gunzip(compressed);
                    song=decodeSongBinary(raw);
                    syncToSong(); autosaveEl.classList.add('saved');
                    showToast(`✓ Loaded: ${row.name||'Untitled'}`);
                } catch(e){ console.warn('[vdaw] decode fail',e); showToast('⚠ Decode failed'); }
            });
        });
        overlay.querySelector('#vdaw-picker-cancel').addEventListener('click',()=>overlay.remove());
        overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.remove();});
        winEl.appendChild(overlay);
    }

    function syncToSong(){
        bpmVal.textContent=song.bpm;barsVal.textContent=song.bars;
        swingSlider.value=song.swing;swingLbl.textContent=song.swing+'%';
        masterVolEl.value=song.master.volume;mvolLbl.textContent=song.master.volume+'%';
        renderMixer();resizeRoll();renderVelLane();
        if(selectedTrackId) updateCrumbs();
    }

    // ── Helpers ────────────────────────────────────────────
    function makeHold(btn,fn){let t,iv;btn.addEventListener('mousedown',()=>{fn();t=setTimeout(()=>{iv=setInterval(fn,80);},400);});['mouseup','mouseleave'].forEach(ev=>btn.addEventListener(ev,()=>{clearTimeout(t);clearInterval(iv);}));}
    function uid(){ return crypto.randomUUID(); }
    function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function capFirst(s){ return s.charAt(0).toUpperCase()+s.slice(1); }

    // ── Boot ───────────────────────────────────────────────
    updateRollHint();
    addTrack('kick'); addTrack('bass'); addTrack('lead');
    const bass=song.tracks[1];
    [[0,36,1],[1,36,0.5],[1.5,38,0.5],[2,40,0.75],[3,36,1]].forEach(([start,pitch,len],i)=>{
        bass.notes.push({id:uid(),startBeat:start,lengthBeats:len,velocity:90-i*4,pitch,slide:false});
    });
    // Demo slide: note at beat 1.5 glides to C3 via a slide note
    bass.notes.push({id:uid(),startBeat:2,lengthBeats:0.25,velocity:85,pitch:41,slide:false,isSlide:true});
    selectTrack(song.tracks[0].id);
    resizeRoll(); renderMixer();

    // Load autosave
    try { const raw=await idbGet(AUTO_KEY); if(raw){ song=JSON.parse(raw); syncToSong(); autosaveEl.classList.add('saved'); } } catch(e){ console.warn('[vdaw] load fail',e); }

    const ro=new ResizeObserver(()=>resizeRoll());
    ro.observe(document.getElementById('vdaw-roll-right')||rollScroll);
}
