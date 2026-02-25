// ============================================================
// apps/vmedia/vmedia.js
// ============================================================
// vMedia ; video (YouTube) + audio (HTML5 / SoundCloud) player.
//
// YouTube postMessage API notes:
//   - Send { event:'listening' } ONCE on iframe load to subscribe
//     to state events. Do NOT send it repeatedly; it causes YouTube
//     to re-broadcast state which interferes with pause.
//   - Valid commands: playVideo, pauseVideo, stopVideo, seekTo,
//     setVolume, setPlaybackRate, mute, unMute.
//   - getCurrentTime / getDuration are NOT valid postMessage cmds;
//     progress is tracked locally via setInterval against duration.
//   - onReady ; player is ready (sent once after listening handshake)
//   - onStateChange ; -1 unstarted, 0 ended, 1 playing, 2 paused,
//                     3 buffering, 5 cued
//   - infoDelivery ; carries duration when available
// ============================================================

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

    // ── DOM refs ─────────────────────────────────────────────
    const iframe        = document.getElementById('wmp-iframe');
    const audioEl       = document.getElementById('wmp-audio');
    const screenWrap    = document.getElementById('wmp-screen');
    const audioWrap     = document.getElementById('wmp-audio-wrap');
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
    let mode          = null;   // 'video' | 'audio-html5' | 'audio-sc'
    let isPlaying     = false;
    let duration      = 0;
    let elapsed       = 0;     // locally tracked playback position (seconds)
    let progressTimer = null;
    let speed         = 1;

    // ── Helpers ──────────────────────────────────────────────

    function setStatus(text, playing = null) {
        statusText.textContent = text;
        if (playing !== null) {
            isPlaying = playing;
            playPauseBtn.textContent = playing ? '\u23F8' : '\u25B6';
            playPauseBtn.classList.toggle('playing', playing);
            statusDot.classList.toggle('dot-playing', playing);
        }
    }

    function resetUI() {
        progressFill.style.width = '0%';
        trackName.textContent    = '\u2014';
        openYtBtn.style.display  = 'none';
        duration = 0;
        elapsed  = 0;
        stopProgressTimer();
    }

    function stopProgressTimer() {
        clearInterval(progressTimer);
        progressTimer = null;
    }

    // ── YouTube mode ─────────────────────────────────────────

    function loadYouTube(id, title) {
        mode = 'video';

        screenWrap.style.display = 'block';
        audioWrap.style.display  = 'none';
        openYtBtn.style.display  = 'inline-flex';
        modeLabel.textContent    = 'VIDEO';

        audioEl.pause();
        audioEl.src = '';

        iframe.src = 'https://www.youtube.com/embed/' + id +
            '?enablejsapi=1&autoplay=1&origin=' + encodeURIComponent(location.origin);

        trackName.textContent = title;
        setStatus('Loading\u2026', false);

        openYtBtn.onclick = () =>
            window.open('https://www.youtube.com/watch?v=' + id, '_blank');
    }

    function ytCmd(func, args) {
        iframe.contentWindow?.postMessage(
            JSON.stringify({ event: 'command', func, args: args || [] }), '*'
        );
    }

    // Send the listening handshake exactly once when the iframe loads.
    // This subscribes us to onReady and onStateChange events from YouTube.
    // Do NOT send 'listening' again after this — repeated sends cause
    // YouTube to re-broadcast its current state, which fights pause.
    iframe.addEventListener('load', () => {
        if (mode !== 'video') return;
        iframe.contentWindow?.postMessage(
            JSON.stringify({ event: 'listening' }), '*'
        );
    });

    window.addEventListener('message', e => {
        if (!e.data || mode !== 'video') return;
        let data;
        try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; }
        catch { return; }

        if (data.event === 'onReady') {
            // Playback starts via autoplay=1 in the embed URL.
            // Do NOT call playVideo here; onReady can fire multiple times
            // (e.g. on quality change) and would restart a paused video.
        }

        if (data.event === 'onStateChange') {
            const s = data.info;
            if (s === 1) {
                setStatus('Playing', true);
                startYTProgress();
            } else if (s === 2) {
                setStatus('Paused', false);
                stopProgressTimer();
            } else if (s === 0) {
                setStatus('Ended', false);
                stopProgressTimer();
                progressFill.style.width = '100%';
            } else if (s === 3) {
                setStatus('Buffering\u2026');
                stopProgressTimer();
            } else if (s === -1) {
                setStatus('Ready');
            }
        }

        // Capture duration from infoDelivery when YouTube sends it
        if (data.event === 'infoDelivery' && data.info && data.info.duration) {
            duration = data.info.duration;
        }
    });

    // Progress is tracked locally ; we know start time and speed,
    // so we increment elapsed ourselves rather than polling YouTube.
    function startYTProgress() {
        stopProgressTimer();
        const tick = 250;
        progressTimer = setInterval(() => {
            if (!duration) return;
            elapsed = Math.min(elapsed + (tick / 1000) * speed, duration);
            progressFill.style.width = (elapsed / duration * 100) + '%';
        }, tick);
    }

    // ── HTML5 audio mode ──────────────────────────────────────

    function loadHTML5Audio(src, title) {
        mode = 'audio-html5';

        screenWrap.style.display = 'none';
        audioWrap.style.display  = 'flex';
        openYtBtn.style.display  = 'none';
        modeLabel.textContent    = 'AUDIO';

        iframe.src           = '';
        audioEl.src          = src;
        audioEl.volume       = volumeSlider.value / 100;
        audioEl.playbackRate = speed;

        trackName.textContent = title;
        setStatus('Loading\u2026', false);
        audioEl.load();
    }

    audioEl.addEventListener('canplay', () => {
        if (mode !== 'audio-html5') return;
        duration = audioEl.duration || 0;
        setStatus('Ready');
        audioEl.play();
    });

    audioEl.addEventListener('play', () => {
        if (mode !== 'audio-html5') return;
        setStatus('Playing', true);
        stopProgressTimer();
        progressTimer = setInterval(() => {
            if (!audioEl.duration) return;
            progressFill.style.width = (audioEl.currentTime / audioEl.duration * 100) + '%';
        }, 250);
    });

    audioEl.addEventListener('pause', () => {
        if (mode !== 'audio-html5') return;
        setStatus('Paused', false);
        stopProgressTimer();
    });

    audioEl.addEventListener('ended', () => {
        if (mode !== 'audio-html5') return;
        setStatus('Ended', false);
        stopProgressTimer();
        progressFill.style.width = '100%';
    });

    audioEl.addEventListener('error', () => {
        if (mode === 'audio-html5') setStatus('Error loading file');
    });

    // ── SoundCloud mode ───────────────────────────────────────

    function loadSoundCloud(url, title) {
        mode = 'audio-sc';

        screenWrap.style.display = 'block';
        audioWrap.style.display  = 'none';
        openYtBtn.style.display  = 'none';
        modeLabel.textContent    = 'SOUNDCLOUD';

        audioEl.pause();
        audioEl.src = '';

        iframe.src = 'https://w.soundcloud.com/player/?url=' +
            encodeURIComponent(url) + '&color=%23ff6a00&auto_play=true&show_artwork=true';

        trackName.textContent = title;
        setStatus('SoundCloud', false);
    }

    // ── file-open routing ─────────────────────────────────────

    document.addEventListener('file-open', e => {
        const { type, id, src, title } = e.detail;
        if (type !== 'video' && type !== 'audio') return;

        resetUI();

        if (type === 'video') {
            loadYouTube(id, title);
        } else if (src && src.includes('soundcloud.com')) {
            loadSoundCloud(src, title);
        } else {
            loadHTML5Audio(src, title);
        }

        openWindow(entry);
    });

    // ── Transport controls ────────────────────────────────────

    playPauseBtn.addEventListener('click', () => {
        if (mode === 'video') {
            isPlaying ? ytCmd('pauseVideo') : ytCmd('playVideo');
        } else if (mode === 'audio-html5') {
            isPlaying ? audioEl.pause() : audioEl.play();
        }
    });

    // Restart ; seek to 0:00
    restartBtn.addEventListener('click', () => {
        elapsed = 0;
        if (mode === 'video') {
            ytCmd('seekTo', [0, true]);
            ytCmd('playVideo');
        } else if (mode === 'audio-html5') {
            audioEl.currentTime = 0;
            audioEl.play();
        }
    });

    // Speed toggle ; 1x / 2x
    speedBtn.addEventListener('click', () => {
        speed = speed === 1 ? 2 : 1;
        speedBtn.textContent = speed + '\xD7';
        speedBtn.classList.toggle('active', speed === 2);
        if (mode === 'video')            ytCmd('setPlaybackRate', [speed]);
        if (mode === 'audio-html5')      audioEl.playbackRate = speed;
    });

    volumeSlider.addEventListener('input', () => {
        const v = parseInt(volumeSlider.value);
        if (mode === 'video')            ytCmd('setVolume', [v]);
        if (mode === 'audio-html5')      audioEl.volume = v / 100;
    });

    progressTrack?.addEventListener('click', e => {
        const ratio = (e.clientX - progressTrack.getBoundingClientRect().left) / progressTrack.offsetWidth;
        if (mode === 'video' && duration) {
            elapsed = ratio * duration;
            ytCmd('seekTo', [elapsed, true]);
        } else if (mode === 'audio-html5' && audioEl.duration) {
            audioEl.currentTime = ratio * audioEl.duration;
        }
    });

    // ── Close ; stop everything ───────────────────────────────

    windowEl.querySelector('.close-btn').addEventListener('click', () => {
        ytCmd('stopVideo');
        audioEl.pause();
        audioEl.src = '';
        iframe.src  = '';
        stopProgressTimer();
        resetUI();
        setStatus('Ready', false);
        mode  = null;
        speed = 1;
        speedBtn.textContent = '1\xD7';
        speedBtn.classList.remove('active');
    }, true);

    // ── Menu bar ──────────────────────────────────────────────

    windowEl.querySelectorAll('.wmp-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            windowEl.querySelectorAll('.wmp-menu-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            setTimeout(() => item.classList.remove('active'), 300);
        });
    });
}