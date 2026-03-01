// ============================================================
// apps/vmedia/vmedia.js
// ============================================================
// vMedia — video (YouTube + local) + audio player.
//
// Delegates to sub-modules:
//   vmedia-yt.js      — YouTube IFrame API
//   vmedia-albumart.js — ID3 album art extraction
//   vmedia-eq.js      — Graphic EQ, Web Audio, visualiser
//   vmedia-menus.js   — VLC-style dropdown menu bar
// ============================================================

import { createYTPlayer }              from './vmedia-yt.js';
import { loadJsmediatags, tryLoadAlbumArt } from './vmedia-albumart.js';
import { initEQ }                      from './vmedia-eq.js';
import { initMenus }                   from './vmedia-menus.js';

export async function initVMedia({ registerWindow, openWindow }) {

    // ── Inject CSS ───────────────────────────────────────────
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = new URL('vmedia.css', import.meta.url).href;
    document.head.appendChild(link);

    // ── Fetch + inject HTML ──────────────────────────────────
    try {
        const res  = await fetch(new URL('vmedia.html', import.meta.url).href);
        const html = await res.text();
        document.body.insertAdjacentHTML('beforeend', html);
    } catch (err) {
        console.error('[vmedia] Failed to load vmedia.html', err);
        return;
    }

    const windowEl = document.getElementById('media-player-window');
    if (!windowEl) return;
    const entry = registerWindow(windowEl);

    // ── Desktop icon — double-click to open
    document.getElementById('open-vmedia')?.addEventListener('dblclick', () => openWindow(entry));

    // ── DOM refs ─────────────────────────────────────────────
    const audioEl       = document.getElementById('wmp-audio');
    const screenWrap    = document.getElementById('wmp-screen');
    const audioWrap     = document.getElementById('wmp-audio-wrap');
    const albumArtEl    = document.getElementById('wmp-album-art');
    const trackName     = document.getElementById('wmp-track-name');
    const statusText    = document.getElementById('wmp-status');
    const statusDot     = document.getElementById('wmp-status-dot');
    const playPauseBtn  = document.getElementById('wmp-play-pause');
    const restartBtn    = document.getElementById('wmp-prev');
    const speedBtn      = document.getElementById('wmp-next');
    const volumeSlider  = document.getElementById('wmp-volume');
    const progressFill  = document.getElementById('wmp-progress-fill');
    const progressTrack = windowEl.querySelector('.wmp-progress-track');
    const openYtBtn     = document.getElementById('wmp-open-yt');
    const modeLabel     = document.getElementById('wmp-mode-label');

    // ── State ─────────────────────────────────────────────────
    let mode          = null;  // 'video' | 'video-local' | 'audio-html5' | 'audio-embed'
    let ytPlayer      = null;
    let ytPlaying     = false;
    let duration      = 0;
    let progressTimer = null;
    let speed         = 1;

    const HTML5_AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac|opus|weba)(\?.*)?$/i;
    const HTML5_VIDEO_EXT = /\.(mp4|webm|ogv|mov|mkv|avi)(\?.*)?$/i;

    loadJsmediatags();

    // ── EQ sub-module ─────────────────────────────────────────
    const eq = initEQ(audioEl);

    // ── UI helpers ────────────────────────────────────────────

    function setPlayUI(playing) {
        ytPlaying = playing;
        playPauseBtn.textContent = playing ? '⏸' : '▶';
        playPauseBtn.classList.toggle('playing', playing);
    }

    const STATUS_OK = /^(playing|paused|ended|ready|ok|soundcloud|spotify|embed)$/i;
    function setStatus(text) {
        statusText.textContent = text;
        statusDot.classList.toggle('dot-playing', !STATUS_OK.test(text.trim()));
    }

    function stopProgressTimer() { clearInterval(progressTimer); progressTimer = null; }

    function resetUI() {
        progressFill.style.width = '0%';
        trackName.textContent    = '—';
        openYtBtn.style.display  = 'none';
        duration = 0;
        stopProgressTimer();
        setPlayUI(false);
        setStatus('Ready');
    }

    // ── DOM helpers ───────────────────────────────────────────

    function ensureIframe() {
        let el = document.getElementById('wmp-iframe');
        if (!el) {
            el = document.createElement('iframe');
            el.id = 'wmp-iframe';
            el.frameBorder = '0';
            el.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
            el.allowFullscreen = true;
            el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
            screenWrap.innerHTML = '';
            screenWrap.appendChild(el);
        }
        return el;
    }

    function ensureVideoEl() {
        let el = document.getElementById('wmp-video-el');
        if (!el) {
            el = document.createElement('video');
            el.id = 'wmp-video-el';
            el.controls  = false;
            el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000;';
            screenWrap.innerHTML = '';
            screenWrap.appendChild(el);
        }
        return el;
    }

    function ensureNoVideo() {
        const el = document.getElementById('wmp-video-el');
        if (el) {
            el.pause(); el.src = ''; el.remove();
            eq.onVideoRemoved(el);  // let EQ know to clear its sourceNode for this element
        }
        document.getElementById('wmp-yt-target')?.remove();
    }

    // ── Loaders ───────────────────────────────────────────────

    async function loadYouTube(id, title) {
        mode = 'video';
        eq.setMode(mode);

        screenWrap.style.display = 'block';
        audioWrap.style.display  = 'none';
        openYtBtn.style.display  = 'inline-flex';
        modeLabel.textContent    = 'VIDEO';

        audioEl.pause(); audioEl.src = '';
        if (ytPlayer) { try { ytPlayer.destroy(); } catch (_) {} ytPlayer = null; }

        trackName.textContent = title;
        setStatus('Loading…');
        setPlayUI(false);
        openYtBtn.onclick = () => window.open('https://www.youtube.com/watch?v=' + id, '_blank');

        ytPlayer = await createYTPlayer(screenWrap, {
            videoId: id,
            volume:  parseInt(volumeSlider.value),
            onState(s) {
                if (s === YT.PlayerState.PLAYING) {
                    duration = ytPlayer.getDuration() || 0;
                    setStatus('Playing'); setPlayUI(true);
                    stopProgressTimer();
                    progressTimer = setInterval(() => {
                        if (isSeeking) return;
                        try { progressFill.style.width = (ytPlayer.getCurrentTime() / duration * 100) + '%'; } catch (_) {}
                    }, 100);
                } else if (s === YT.PlayerState.PAUSED) {
                    setStatus('Paused'); setPlayUI(false); stopProgressTimer();
                } else if (s === YT.PlayerState.ENDED) {
                    setStatus('Ended'); setPlayUI(false); stopProgressTimer();
                    progressFill.style.width = '100%';
                } else if (s === YT.PlayerState.BUFFERING) {
                    setStatus('Buffering…'); stopProgressTimer();
                }
            },
        });
    }

    function loadHTML5Audio(src, title, file = null) {
        mode = 'audio-html5';
        eq.setMode(mode);

        screenWrap.style.display = 'none';
        audioWrap.style.display  = 'flex';
        openYtBtn.style.display  = 'none';
        modeLabel.textContent    = 'AUDIO';

        ensureIframe(); ensureNoVideo();
        tryLoadAlbumArt(albumArtEl, src, file);

        audioEl.src          = src;
        audioEl.volume       = volumeSlider.value / 100;
        audioEl.playbackRate = speed;
        trackName.textContent = title;
        setStatus('Loading…'); setPlayUI(false);
        audioEl.load();
    }

    function loadLocalVideo(src, title) {
        mode = 'video-local';
        eq.setMode(mode);

        screenWrap.style.display = 'block';
        audioWrap.style.display  = 'none';
        openYtBtn.style.display  = 'none';
        modeLabel.textContent    = 'VIDEO';

        audioEl.pause(); audioEl.src = '';
        if (ytPlayer) { try { ytPlayer.destroy(); } catch (_) {} ytPlayer = null; }

        const videoEl = ensureVideoEl();

        let safeSrc = src;
        try { safeSrc = new URL(src, location.href).href; } catch (_) {}

        videoEl.src          = safeSrc;
        videoEl.volume       = volumeSlider.value / 100;
        videoEl.playbackRate = speed;
        trackName.textContent = title;
        setStatus('Loading…'); setPlayUI(false);
        videoEl.load();

        videoEl.oncanplay = () => { duration = videoEl.duration || 0; setStatus('Ready'); videoEl.play(); };
        videoEl.onplay    = () => {
            setStatus('Playing'); setPlayUI(true);
            stopProgressTimer();
            progressTimer = setInterval(() => {
                if (isSeeking) return;
                if (videoEl.duration) progressFill.style.width = (videoEl.currentTime / videoEl.duration * 100) + '%';
            }, 100);
        };
        videoEl.onpause  = () => { setStatus('Paused');  setPlayUI(false); stopProgressTimer(); };
        videoEl.onended  = () => { setStatus('Ended');   setPlayUI(false); stopProgressTimer(); progressFill.style.width = '100%'; };
        videoEl.onerror  = () => {
            const codes = { 1:'aborted', 2:'network error', 3:'decode error', 4:'unsupported format' };
            setStatus('Error: ' + (codes[videoEl.error?.code] || 'unknown'));
        };
    }

    function loadEmbedAudio(src, title) {
        mode = 'audio-embed';
        eq.setMode(mode);

        let embedSrc = src;
        if (/soundcloud\.com\//i.test(src) && !src.includes('w.soundcloud.com')) {
            embedSrc = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(src) +
                '&color=%23ff6a00&auto_play=true&show_artwork=true&buying=false&sharing=false';
        }
        ensureIframe().src = embedSrc;

        screenWrap.style.display = 'block';
        audioWrap.style.display  = 'none';
        openYtBtn.style.display  = 'none';
        modeLabel.textContent    = /spotify/i.test(src) ? 'SPOTIFY' : /soundcloud/i.test(src) ? 'SOUNDCLOUD' : 'EMBED';

        audioEl.pause(); audioEl.src = '';
        trackName.textContent = title;
        setStatus('Ready'); setPlayUI(false);
    }

    // ── Audio element events ──────────────────────────────────

    audioEl.addEventListener('canplay', () => {
        if (mode !== 'audio-html5') return;
        duration = audioEl.duration || 0;
        setStatus('Ready');
        audioEl.play();
    });

    audioEl.addEventListener('play', () => {
        if (mode !== 'audio-html5') return;
        setStatus('Playing'); setPlayUI(true);
        stopProgressTimer();
        progressTimer = setInterval(() => {
            if (isSeeking) return;
            if (audioEl.duration) progressFill.style.width = (audioEl.currentTime / audioEl.duration * 100) + '%';
        }, 100);
        eq.connectAudioEl();
        if (window.AudioContext && audioEl._audioCtx?.state === 'suspended') audioEl._audioCtx.resume();
    });

    audioEl.addEventListener('pause',  () => { if (mode === 'audio-html5') { setStatus('Paused');  setPlayUI(false); stopProgressTimer(); } });
    audioEl.addEventListener('ended',  () => { if (mode === 'audio-html5') { setStatus('Ended');   setPlayUI(false); stopProgressTimer(); progressFill.style.width = '100%'; } });
    audioEl.addEventListener('error',  () => { if (mode === 'audio-html5') setStatus('Error loading file'); });

    // Hook local video play to connect EQ (video element created dynamically).
    document.addEventListener('play', e => {
        if (mode !== 'video-local' || !e.target.matches('#wmp-video-el')) return;
        eq.connectVideoEl();
    }, true);

    // ── file-open routing ─────────────────────────────────────

    document.addEventListener('file-open', async e => {
        const { type, id, src, title, file } = e.detail;
        if (type !== 'video' && type !== 'audio') return;

        stopProgressTimer();
        if (ytPlayer) { try { ytPlayer.pauseVideo(); } catch (_) {} }
        audioEl.pause();
        ensureNoVideo();
        resetUI();

        if (type === 'video') {
            const localSrc = (src && HTML5_VIDEO_EXT.test(src)) ? src
                           : (id  && HTML5_VIDEO_EXT.test(id))  ? id : null;
            if (localSrc) loadLocalVideo(localSrc, title);
            else          await loadYouTube(id, title);
        } else if (HTML5_AUDIO_EXT.test(src)) {
            loadHTML5Audio(src, title, file ?? null);
        } else {
            loadEmbedAudio(src, title);
        }
        openWindow(entry);
    });

    // ── Transport controls ────────────────────────────────────

    playPauseBtn.addEventListener('click', () => {
        const v = document.getElementById('wmp-video-el');
        if      (mode === 'video'       && ytPlayer) ytPlaying ? ytPlayer.pauseVideo() : ytPlayer.playVideo();
        else if (mode === 'video-local' && v)        ytPlaying ? v.pause() : v.play();
        else if (mode === 'audio-html5')             ytPlaying ? audioEl.pause() : audioEl.play();
    });

    restartBtn.addEventListener('click', () => {
        const v = document.getElementById('wmp-video-el');
        if      (mode === 'video'       && ytPlayer) { ytPlayer.seekTo(0, true); ytPlayer.playVideo(); progressFill.style.width = '0%'; }
        else if (mode === 'video-local' && v)        { v.currentTime = 0; v.play(); progressFill.style.width = '0%'; }
        else if (mode === 'audio-html5')             { audioEl.currentTime = 0; audioEl.play(); }
    });

    const SPEEDS = [1, 2, 4, 8, 16, 32, 64];
    speedBtn.addEventListener('click', () => {
        speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
        speedBtn.textContent = speed + '×';
        speedBtn.classList.toggle('active', speed !== 1);
        const v = document.getElementById('wmp-video-el');
        if (mode === 'video'       && ytPlayer) ytPlayer.setPlaybackRate(speed);
        if (mode === 'video-local' && v)        v.playbackRate = speed;
        if (mode === 'audio-html5')             audioEl.playbackRate = speed;
    });

    function applyVolume() {
        const v = parseInt(volumeSlider.value);
        const _v = document.getElementById('wmp-video-el');
        if (mode === 'video'       && ytPlayer) ytPlayer.setVolume(v);
        if (mode === 'video-local' && _v)       _v.volume = v / 100;
        if (mode === 'audio-html5')             audioEl.volume = v / 100;
    }
    volumeSlider.addEventListener('input',     applyVolume);
    volumeSlider.addEventListener('change',    applyVolume);
    // iOS Safari: input fires on touchmove only if touch-action:none is set.
    // Setting it here avoids needing to touch vmedia.css.
    volumeSlider.style.touchAction = 'none';
    volumeSlider.addEventListener('touchstart', applyVolume, { passive: true });
    volumeSlider.addEventListener('touchmove',  applyVolume, { passive: true });

    // ── Seek bar — click + drag ───────────────────────────────
    // Replaces the old click-only handler with full drag support.
    // While dragging: progress fill tracks the mouse in real time,
    // the progress timer is suppressed, and we seek on mouseup.
    // For YouTube we seekTo on every move (it buffers ahead so this
    // is fine); for HTML5 we set currentTime directly.

    let isSeeking = false;

    function seekRatio(ratio) {
        ratio = Math.max(0, Math.min(1, ratio));
        progressFill.style.width = (ratio * 100) + '%';
        const v = document.getElementById('wmp-video-el');
        if      (mode === 'video'       && ytPlayer && duration)  ytPlayer.seekTo(ratio * duration, true);
        else if (mode === 'video-local' && v && v.duration)       v.currentTime = ratio * v.duration;
        else if (mode === 'audio-html5' && audioEl.duration)      audioEl.currentTime = ratio * audioEl.duration;
    }

    function getRatio(e, track) {
        const rect = track.getBoundingClientRect();
        return (e.clientX - rect.left) / rect.width;
    }

    progressTrack?.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        isSeeking = true;
        stopProgressTimer();
        progressTrack.classList.add('seeking');
        seekRatio(getRatio(e, progressTrack));
        e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
        if (!isSeeking || !progressTrack) return;
        seekRatio(getRatio(e, progressTrack));
    });

    document.addEventListener('mouseup', e => {
        if (!isSeeking) return;
        isSeeking = false;
        progressTrack?.classList.remove('seeking');
        // Resume the auto-advance timer if we're still playing
        if (ytPlaying && duration) {
            stopProgressTimer();
            progressTimer = setInterval(() => {
                if (isSeeking) return;
                const v = document.getElementById('wmp-video-el');
                try {
                    if      (mode === 'video'       && ytPlayer)        progressFill.style.width = (ytPlayer.getCurrentTime() / duration * 100) + '%';
                    else if (mode === 'video-local' && v && v.duration) progressFill.style.width = (v.currentTime / v.duration * 100) + '%';
                    else if (mode === 'audio-html5' && audioEl.duration) progressFill.style.width = (audioEl.currentTime / audioEl.duration * 100) + '%';
                } catch (_) {}
            }, 100);
        }
    });

    // Touch seek support
    progressTrack?.addEventListener('touchstart', e => {
        isSeeking = true;
        stopProgressTimer();
        progressTrack.classList.add('seeking');
        seekRatio(getRatio(e.touches[0], progressTrack));
    }, { passive: true });

    progressTrack?.addEventListener('touchmove', e => {
        if (!isSeeking) return;
        seekRatio(getRatio(e.touches[0], progressTrack));
    }, { passive: true });

    progressTrack?.addEventListener('touchend', () => {
        isSeeking = false;
        progressTrack?.classList.remove('seeking');
    });

    // ── Close ─────────────────────────────────────────────────

    windowEl.querySelector('.close-btn').addEventListener('click', () => {
        stopProgressTimer();
        if (ytPlayer) { try { ytPlayer.stopVideo(); } catch (_) {} }
        audioEl.pause(); audioEl.src = '';
        ensureNoVideo();
        ensureIframe().src = '';
        albumArtEl.textContent = '🎵';
        resetUI();
        mode  = null; speed = 1;
        speedBtn.textContent = '1×';
        speedBtn.classList.remove('active');
        setStatus('Ready');
        eq.closeEQ();
    }, true);

    // ── Menu bar ──────────────────────────────────────────────

    initMenus(windowEl, {
        toggleEQ:  () => eq.toggleEQ(mode),
        playPause: () => playPauseBtn.click(),
        restart:   () => restartBtn.click(),
        speed:     () => speedBtn.click(),
        close:     () => windowEl.querySelector('.close-btn').click(),
    });
}