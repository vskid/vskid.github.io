// ============================================================
//  apps/vtracker/sampler.js
//  Sampler engine — loading, preview with choke, waveform editor
// ============================================================

export class Sampler {
    constructor(actx, masterGain, setStatus) {
        this.actx      = actx;
        this.master    = masterGain;
        this.setStatus = setStatus;
        this._nodes    = new Map(); // chokeKey → { src, g }
    }

    // Preview with choke logic
    // selfChokeOnly=true → only stop same slot (chord-safe)
    preview(smp, slot, selfChokeOnly = false) {
        if (!smp?.buffer) return;
        const selfKey  = `self:${slot}`;
        const groupKey = smp.chokeGroup > 0 ? `grp:${smp.chokeGroup}` : null;

        this._stop(selfKey);
        if (groupKey && !selfChokeOnly) this._stop(groupKey);

        const ctx = this.actx;

        // Use ping-pong baked buffer if needed
        let playBuf = smp.buffer;
        if (smp.loop && smp.loopMode === 1 && smp.loopEnd > smp.loopStart) {
            const cacheKey = `_ppBuf_${smp.loopStart}_${smp.loopEnd}`;
            if (!smp[cacheKey] || smp[cacheKey]._srcLen !== smp.buffer.length) {
                // Inline ping-pong builder (can't import tracker fn here)
                const buf = smp.buffer;
                const sr  = buf.sampleRate;
                const nch = buf.numberOfChannels;
                const ls = smp.loopStart, le = smp.loopEnd;
                const segLen = le - ls;
                if (segLen > 0) {
                    const out = ctx.createBuffer(nch, ls + segLen*2 + (buf.length - le), sr);
                    for (let c = 0; c < nch; c++) {
                        const src2 = buf.getChannelData(c), dst = out.getChannelData(c);
                        dst.set(src2.subarray(0, ls), 0);
                        dst.set(src2.subarray(ls, le), ls);
                        for (let i = 0; i < segLen; i++) dst[ls + segLen + i] = src2[le - 1 - i];
                        dst.set(src2.subarray(le), ls + segLen*2);
                    }
                    smp[cacheKey] = out; smp[cacheKey]._srcLen = buf.length;
                }
            }
            playBuf = smp[cacheKey] ?? smp.buffer;
        }

        const src = ctx.createBufferSource();
        src.buffer = playBuf;
        src.playbackRate.value = Math.pow(2, (smp.finetune || 0) / 1200);

        if (smp.loop && smp.loopEnd > smp.loopStart) {
            src.loop = true;
            const sr = playBuf.sampleRate;
            if (smp.loopMode === 1) {
                const ppLen = (smp.loopEnd - smp.loopStart) * 2;
                src.loopStart = smp.loopStart / sr;
                src.loopEnd   = (smp.loopStart + ppLen) / sr;
            } else {
                src.loopStart = smp.loopStart / sr;
                src.loopEnd   = smp.loopEnd   / sr;
            }
        }

        // Gain: x^2.5 curve for consistency with tracker
        const linVol = smp.volume / 64;
        const g = ctx.createGain();
        g.gain.value = linVol * linVol * Math.sqrt(linVol);
        src.connect(g); g.connect(this.master);

        const startSec = (smp.startPoint || 0) / smp.buffer.sampleRate;
        if (smp.loop) {
            src.start(0, startSec);
        } else {
            const ep = smp.endPoint > smp.startPoint ? smp.endPoint : smp.buffer.length;
            const durSec = (ep - (smp.startPoint || 0)) / smp.buffer.sampleRate;
            src.start(0, startSec, durSec);
        }

        const ref = { src, g };
        this._nodes.set(selfKey, ref);
        if (groupKey) this._nodes.set(groupKey, ref);

        src.onended = () => {
            if (this._nodes.get(selfKey)  === ref) this._nodes.delete(selfKey);
            if (groupKey && this._nodes.get(groupKey) === ref) this._nodes.delete(groupKey);
        };
    }

    _stop(key) {
        const n = this._nodes.get(key);
        if (n) { try { n.src.stop(); } catch(_) {} this._nodes.delete(key); }
    }

    stopAll() {
        for (const [, n] of this._nodes) { try { n.src.stop(); } catch(_) {} }
        this._nodes.clear();
    }

    // ── Load from file ────────────────────────────────────────
    async loadFromFile(smp, file) {
        this.setStatus(`LOADING: ${file.name}`);
        try {
            const ab = await file.arrayBuffer();
            await this._decode(smp, ab, file.name);
        } catch(e) { this.setStatus(`ERROR: ${e.message}`); }
    }

    // ── Load from URL ─────────────────────────────────────────
    async loadFromUrl(smp, rawUrl) {
        this.setStatus(`LOADING: ${rawUrl}`);

        if (/youtube\.com|youtu\.be/i.test(rawUrl)) {
            await this._loadYouTube(smp, rawUrl);
            return;
        }

        // Direct + two CORS proxies
        for (const wrap of [u=>u, u=>`https://corsproxy.io/?${encodeURIComponent(u)}`, u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`]) {
            try {
                const r = await fetch(wrap(rawUrl), { mode: 'cors' });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const ab = await r.arrayBuffer();
                await this._decode(smp, ab, rawUrl.split('/').pop().split('?')[0]);
                return;
            } catch(e) { /* try next */ }
        }
        this.setStatus('ERROR: CORS blocked on all proxies. Paste a direct .mp3/.wav URL.');
    }

    // ── YouTube via multiple fallback APIs ───────────────────
    // Tries several public audio-extraction services in order.
    // Each service is tried with CORS proxies if needed.
    async _loadYouTube(smp, ytUrl) {
        const vidId = ytUrl.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1];
        if (!vidId) { this.setStatus('YT ERROR: Could not parse video ID from URL.'); return; }

        this.setStatus(`YOUTUBE: Trying to extract audio for ${vidId}...`);

        // ── Service list — tried in order ───────────────────
        const services = [

            // 1. cobalt.tools (v10 JSON API)
            async () => {
                const r = await fetch('https://api.cobalt.tools/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ url: ytUrl, downloadMode: 'audio', audioFormat: 'mp3' }),
                });
                if (!r.ok) throw new Error(`cobalt HTTP ${r.status}`);
                const d = await r.json();
                if (d.status === 'error') throw new Error(`cobalt: ${d.error?.code ?? d.error}`);
                const url = d.url;
                if (!url) throw new Error('cobalt: no URL in response');
                this.setStatus('YOUTUBE: Downloading via cobalt...');
                return this._fetchAudioBlob(url, vidId);
            },

            // 2. yt-dlp.kellyc.net  (GET /api/youtube?url=…&type=mp3)
            async () => {
                const api = `https://yt-dlp.kellyc.net/api/youtube?url=${encodeURIComponent(ytUrl)}&type=mp3`;
                const r   = await fetch(api);
                if (!r.ok) throw new Error(`kellyc HTTP ${r.status}`);
                const d   = await r.json();
                const url = d.url ?? d.audio_url ?? d.link;
                if (!url) throw new Error('kellyc: no URL');
                this.setStatus('YOUTUBE: Downloading via kellyc...');
                return this._fetchAudioBlob(url, vidId);
            },

            // 3. ytstream.net  (GET /stream?url=…&type=mp3)
            async () => {
                const api = `https://ytstream.net/stream?url=${encodeURIComponent(ytUrl)}&type=mp3`;
                const r   = await fetch(api, { mode: 'cors' });
                if (!r.ok) throw new Error(`ytstream HTTP ${r.status}`);
                const ab  = await r.arrayBuffer();
                if (ab.byteLength < 10000) throw new Error('ytstream: response too small');
                return ab;
            },

            // 4. allorigins passthrough for any of the above URLs (last-ditch)
            async () => {
                const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://yt-dlp.kellyc.net/api/youtube?url=${encodeURIComponent(ytUrl)}&type=mp3`)}`;
                const r = await fetch(proxy);
                if (!r.ok) throw new Error(`allorigins HTTP ${r.status}`);
                const d   = await r.json();
                const url = d.url ?? d.audio_url ?? d.link;
                if (!url) throw new Error('allorigins/kellyc: no URL');
                return this._fetchAudioBlob(url, vidId);
            },
        ];

        let lastErr = 'all services failed';
        for (const [i, svc] of services.entries()) {
            try {
                const ab = await svc();
                await this._decode(smp, ab, `yt-${vidId}`);
                return;
            } catch(e) {
                lastErr = e.message;
                this.setStatus(`YOUTUBE: Service ${i+1} failed (${e.message.slice(0,60)}), trying next...`);
            }
        }
        this.setStatus(`YOUTUBE ERROR: ${lastErr}. All services exhausted — paste a direct MP3 URL instead.`);
    }

    // Fetch raw audio bytes, trying direct then CORS proxies
    async _fetchAudioBlob(url, _hint) {
        const proxies = [
            u => u,
            u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
            u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        ];
        for (const wrap of proxies) {
            try {
                const r = await fetch(wrap(url), { mode: 'cors' });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const ab = await r.arrayBuffer();
                if (ab.byteLength < 10000) throw new Error('response too small');
                return ab;
            } catch(_) {}
        }
        throw new Error(`Could not download audio from: ${url.slice(0,80)}`);
    }

    async _decode(smp, ab, rawName) {
        const buf     = await this.actx.decodeAudioData(ab);
        smp.buffer    = buf;
        smp.name      = rawName.replace(/\.[^.]+$/, '').slice(0, 22);
        smp.loopEnd   = buf.length;
        smp.endPoint  = buf.length;
        this.setStatus(`LOADED: ${smp.name} (${buf.duration.toFixed(2)}s · ${buf.sampleRate}Hz)`);
    }

    // ── Mic recording ─────────────────────────────────────────
    async startMicRecord(smp, onDone) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks = [];
        const rec    = new MediaRecorder(stream);
        rec.ondataavailable = e => chunks.push(e.data);
        rec.onstop = async () => {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            await this._decode(smp, await blob.arrayBuffer(), 'REC');
            stream.getTracks().forEach(t => t.stop());
            onDone?.();
        };
        rec.start();
        this.setStatus('● RECORDING... press STOP REC to finish');
        return rec;
    }
}

// ── Waveform editor ───────────────────────────────────────────
// Canvas waveform with 4 draggable markers: S (start), [ (loopStart), ] (loopEnd), E (end).
// Markers are always visible even without loop enabled (loop markers hidden when loop=false).
export class WaveformEditor {
    constructor(canvas, smp, onChange) {
        this.canvas   = canvas;
        this.smp      = smp;
        this.onChange = onChange;
        this._drag    = null;

        // Zoom/scroll state: viewStart/viewEnd are fractions [0,1]
        this._viewStart = 0;
        this._viewEnd   = 1;

        canvas.addEventListener('mousedown',  e => this._down(e));
        window.addEventListener('mousemove',  e => this._move(e));
        window.addEventListener('mouseup',    ()  => this._up());
        canvas.addEventListener('touchstart', e => this._down(e.touches[0]), { passive: true });
        window.addEventListener('touchmove',  e => this._move(e.touches[0]), { passive: true });
        window.addEventListener('touchend',   () => this._up());

        // Scroll-wheel zoom (Ctrl+wheel = zoom, plain wheel = scroll when zoomed)
        canvas.addEventListener('wheel', e => this._wheel(e), { passive: false });

        // Defer first draw so CSS height has applied
        requestAnimationFrame(() => this.draw());
    }

    _wheel(e) {
        e.preventDefault();
        const r   = this.canvas.getBoundingClientRect();
        const cx  = (e.clientX - r.left) / r.width;   // cursor fraction [0,1]
        const vs  = this._viewStart, ve = this._viewEnd;
        const span = ve - vs;

        if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 5) {
            // Zoom in/out centred on cursor
            const factor = e.deltaY < 0 ? 0.7 : 1 / 0.7;
            const newSpan = Math.min(1, Math.max(0.001, span * factor));
            const anchor = vs + cx * span; // world position under cursor
            let ns = anchor - cx * newSpan;
            let ne = ns + newSpan;
            if (ns < 0) { ns = 0; ne = newSpan; }
            if (ne > 1) { ne = 1; ns = 1 - newSpan; }
            this._viewStart = ns; this._viewEnd = ne;
        } else {
            // Pan when zoomed
            const pan = (e.deltaX || 0) / r.width * span * 3;
            let ns = vs + pan, ne = ve + pan;
            if (ns < 0) { ns = 0; ne = span; }
            if (ne > 1) { ne = 1; ns = 1 - span; }
            this._viewStart = ns; this._viewEnd = ne;
        }
        this.draw();
    }

    draw() {
        const canvas = this.canvas;
        const smp    = this.smp;
        const dpr    = window.devicePixelRatio || 1;

        const cssW = canvas.clientWidth  || canvas.offsetWidth  || 400;
        const cssH = canvas.clientHeight || canvas.offsetHeight || 80;

        // Only resize if needed
        const needW = Math.round(cssW * dpr), needH = Math.round(cssH * dpr);
        if (canvas.width !== needW || canvas.height !== needH) {
            canvas.width  = needW;
            canvas.height = needH;
        }

        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.scale(dpr, dpr);
        const W = cssW, H = cssH;

        // ── Background ──
        ctx.fillStyle = '#000018';
        ctx.fillRect(0, 0, W, H);

        if (!smp?.buffer) {
            ctx.fillStyle   = '#404060';
            ctx.font        = '700 11px "Share Tech Mono",monospace';
            ctx.textAlign   = 'center';
            ctx.textBaseline= 'middle';
            ctx.fillText('NO SAMPLE LOADED', W/2, H/2);
            ctx.restore(); return;
        }

        const data = smp.buffer.getChannelData(0);
        const len  = data.length;

        const vs  = this._viewStart ?? 0;
        const ve  = this._viewEnd   ?? 1;
        const span = ve - vs;

        // ── Zoom indicator ──
        if (span < 0.99) {
            ctx.fillStyle = 'rgba(0,255,136,0.08)';
            ctx.fillRect(0, H - 4, W, 4);
            ctx.fillStyle = '#00ff88';
            ctx.fillRect(vs * W, H - 4, span * W, 4);
            // Label
            ctx.fillStyle = '#00ff8899';
            ctx.font = '700 8px "Share Tech Mono",monospace';
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
            const zoomX = Math.round(1 / span);
            ctx.fillText(`${zoomX}×ZOOM`, 2, H - 5);
        }

        // Convert world fraction to canvas X
        const worldToX = f => ((f - vs) / span) * W;
        // Sample index → canvas X
        const idxToX   = i => worldToX(i / len);

        // ── Waveform ──
        const iStart = Math.floor(vs * len);
        const iEnd   = Math.ceil(ve * len);
        const step   = Math.max(1, Math.floor((iEnd - iStart) / W));
        ctx.strokeStyle = '#4080c0';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        let first = true;
        for (let x = 0; x < W; x++) {
            const base = iStart + Math.floor((x / W) * (iEnd - iStart));
            let mn = 1, mx = -1;
            for (let j = 0; j < step && base+j < iEnd; j++) {
                const s = data[base+j]; if(s<mn)mn=s; if(s>mx)mx=s;
            }
            const y1 = (0.5 - mx * 0.48) * H;
            const y2 = (0.5 - mn * 0.48) * H;
            if (first) { ctx.moveTo(x, y1); first = false; }
            else ctx.lineTo(x, y1);
            ctx.lineTo(x, y2);
        }
        ctx.stroke();

        // Centre line
        ctx.strokeStyle = 'rgba(128,192,255,0.12)';
        ctx.lineWidth   = 1;
        ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();

        // ── Loop region fill ──
        if (smp.loop && smp.loopEnd > smp.loopStart) {
            const lsX = idxToX(smp.loopStart);
            const leX = idxToX(smp.loopEnd);
            ctx.fillStyle = 'rgba(255,255,0,0.07)';
            ctx.fillRect(lsX, 0, leX - lsX, H);
        }

        // ── Markers (only draw if in view range) ──
        const markers = [
            { key:'start',     px: idxToX(smp.startPoint), col:'#00ff88', label:'S' },
            { key:'end',       px: idxToX(smp.endPoint),   col:'#ff4040', label:'E' },
        ];
        if (smp.loop) {
            markers.push({ key:'loopStart', px: idxToX(smp.loopStart), col:'#ffff00', label:'[' });
            markers.push({ key:'loopEnd',   px: idxToX(smp.loopEnd),   col:'#ffaa00', label:']' });
        }

        for (const m of markers) {
            // Vertical line — full height, solid
            ctx.strokeStyle = m.col; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(m.px, 0); ctx.lineTo(m.px, H); ctx.stroke();

            // Flag at top — 10×11 filled box with black letter
            ctx.fillStyle = m.col;
            ctx.fillRect(m.px - 5, 0, 10, 11);
            ctx.fillStyle    = '#000000';
            ctx.font         = 'bold 8px "Share Tech Mono",monospace';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(m.label, m.px, 1);
        }

        ctx.restore();
    }

    // Canvas X fraction → world fraction [0,1]
    _frac(e) {
        const r   = this.canvas.getBoundingClientRect();
        const cx  = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        const vs  = this._viewStart ?? 0, ve = this._viewEnd ?? 1;
        return vs + cx * (ve - vs);
    }

    _hitTest(f) {
        const smp = this.smp; if (!smp?.buffer) return null;
        const len = smp.buffer.length;
        const span = (this._viewEnd ?? 1) - (this._viewStart ?? 0);
        const T   = 0.03 * span; // 3% of visible range
        const cands = [
            { key:'start', f: smp.startPoint / len },
            { key:'end',   f: smp.endPoint   / len },
        ];
        if (smp.loop) {
            cands.push({ key:'loopStart', f: smp.loopStart / len });
            cands.push({ key:'loopEnd',   f: smp.loopEnd   / len });
        }
        let best = null, bd = T;
        for (const c of cands) { const d=Math.abs(f-c.f); if(d<bd){bd=d;best=c.key;} }
        return best;
    }

    _down(e) { this._drag = this._hitTest(this._frac(e)); }

    _move(e) {
        if (!this._drag || !this.smp?.buffer) return;
        const f   = this._frac(e);
        const len = this.smp.buffer.length;
        const pos = Math.round(f * len);
        const smp = this.smp;
        switch(this._drag) {
            case 'start':
                smp.startPoint = Math.max(0, Math.min(pos, smp.endPoint - 1));
                if (smp.loopStart < smp.startPoint) smp.loopStart = smp.startPoint;
                break;
            case 'end':
                smp.endPoint = Math.max(smp.startPoint + 1, Math.min(pos, len));
                if (smp.loopEnd > smp.endPoint) smp.loopEnd = smp.endPoint;
                break;
            case 'loopStart':
                smp.loopStart = Math.max(smp.startPoint, Math.min(pos, smp.loopEnd - 1));
                break;
            case 'loopEnd':
                smp.loopEnd = Math.max(smp.loopStart + 1, Math.min(pos, smp.endPoint));
                break;
        }
        this.draw();
        this.onChange?.(this._drag, pos);
    }

    _up() { this._drag = null; }

    resetZoom() { this._viewStart = 0; this._viewEnd = 1; this.draw(); }

    update(smp) { this.smp = smp; this.draw(); }
}
