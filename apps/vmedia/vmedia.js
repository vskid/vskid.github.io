// ============================================================
// apps/vmedia/vmedia.js
// ============================================================
// vMedia — video (YouTube) + audio player.
//
// YouTube: uses the real IFrame Player API JS library
// (youtube.com/iframe_api) which gives us a proper YT.Player
// object with actual .pauseVideo() / .playVideo() methods.
// postMessage commands are unreliable without this library —
// they require a precise handshake that varies by browser and
// YouTube embed version. The API library handles all of that.
//
// Audio sources:
//   - HTML5 (mp3, wav, ogg, flac, m4a, aac) → native <audio>
//   - Spotify / SoundCloud / other embed URL → iframe
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
    // NOTE: iframeEl is NOT cached here — loadYouTube replaces the iframe
    // element in the DOM, so we always look it up fresh via getIframe().
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

    // Always fetch the current iframe from the DOM (YT.Player swaps the element)
    const getIframe = () => document.getElementById('wmp-iframe');

    // ── State ─────────────────────────────────────────────────
    let mode          = null;   // 'video' | 'audio-html5' | 'audio-embed'
    let ytPlayer      = null;   // YT.Player instance
    let ytPlaying     = false;
    let duration      = 0;
    let progressTimer = null;
    let speed         = 1;

    // ── Load YouTube IFrame API ───────────────────────────────
    // Returns a promise that resolves once window.YT.Player is ready.
    // Safe to call multiple times — only injects the script once.
    function loadYTApi() {
        if (window.YT && window.YT.Player) return Promise.resolve();
        return new Promise(resolve => {
            // YouTube calls this global when the API is ready
            const prev = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = () => {
                if (prev) prev();
                resolve();
            };
            if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
                const s  = document.createElement('script');
                s.src    = 'https://www.youtube.com/iframe_api';
                s.async  = true;
                document.head.appendChild(s);
            }
        });
    }

    // ── UI helpers ────────────────────────────────────────────

    function setPlayUI(playing) {
        ytPlaying = playing;
        playPauseBtn.textContent = playing ? '\u23F8' : '\u25B6';
        playPauseBtn.classList.toggle('playing', playing);
    }

    // Success states → green dot. Loading / error / transitional → orange dot.
    const STATUS_OK = /^(playing|paused|ended|ready|ok|soundcloud|spotify|embed)$/i;

    function setStatus(text) {
        statusText.textContent = text;
        const ok = STATUS_OK.test(text.trim());
        statusDot.classList.toggle('dot-playing', !ok);
    }

    function stopProgressTimer() {
        clearInterval(progressTimer);
        progressTimer = null;
    }

    function startProgressTimer() {
        stopProgressTimer();
        progressTimer = setInterval(() => {
            if (!ytPlayer || !duration) return;
            try {
                const t = ytPlayer.getCurrentTime();
                progressFill.style.width = (t / duration * 100) + '%';
            } catch (_) {}
        }, 250);
    }

    function resetUI() {
        progressFill.style.width = '0%';
        trackName.textContent    = '\u2014';
        openYtBtn.style.display  = 'none';
        duration = 0;
        stopProgressTimer();
        setPlayUI(false);
        setStatus('Ready');
    }

    // ── YouTube mode ──────────────────────────────────────────

    async function loadYouTube(id, title) {
        mode = 'video';

        screenWrap.style.display = 'block';
        audioWrap.style.display  = 'none';
        openYtBtn.style.display  = 'inline-flex';
        modeLabel.textContent    = 'VIDEO';

        audioEl.pause();
        audioEl.src = '';

        trackName.textContent = title;
        setStatus('Loading\u2026');
        setPlayUI(false);

        openYtBtn.onclick = () =>
            window.open('https://www.youtube.com/watch?v=' + id, '_blank');

        // Ensure the API is ready before creating a player
        await loadYTApi();

        // Destroy previous player if any
        if (ytPlayer) {
            try { ytPlayer.destroy(); } catch (_) {}
            ytPlayer = null;
        }

        // The YT.Player needs a plain div to replace. Wipe screenWrap and
        // insert a fresh target div — this is the only safe way to guarantee
        // the target element exists regardless of previous player state.
        screenWrap.innerHTML = '';
        const ytTarget = document.createElement('div');
        ytTarget.id = 'wmp-yt-target';
        ytTarget.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
        screenWrap.appendChild(ytTarget);

        ytPlayer = new window.YT.Player('wmp-yt-target', {
            videoId: id,
            playerVars: {
                autoplay:       1,
                rel:            0,
                modestbranding: 1,
            },
            events: {
                onReady(e) {
                    e.target.setVolume(parseInt(volumeSlider.value));
                },
                onStateChange(e) {
                    const s = e.data;
                    if (s === YT.PlayerState.PLAYING) {
                        duration = ytPlayer.getDuration() || 0;
                        setStatus('Playing');
                        setPlayUI(true);
                        startProgressTimer();
                    } else if (s === YT.PlayerState.PAUSED) {
                        setStatus('Paused');
                        setPlayUI(false);
                        stopProgressTimer();
                    } else if (s === YT.PlayerState.ENDED) {
                        setStatus('Ended');
                        setPlayUI(false);
                        stopProgressTimer();
                        progressFill.style.width = '100%';
                    } else if (s === YT.PlayerState.BUFFERING) {
                        setStatus('Buffering\u2026');
                        stopProgressTimer();
                    }
                },
            },
        });
    }

    // ── HTML5 audio mode ──────────────────────────────────────

    const HTML5_AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac|opus|weba)(\?.*)?$/i;
    const HTML5_VIDEO_EXT = /\.(mp4|webm|ogv|mov|mkv|avi)(\?.*)?$/i;
    const HTML5_EXT       = src => HTML5_AUDIO_EXT.test(src) || HTML5_VIDEO_EXT.test(src);

    // Album art via jsmediatags (ID3/MP4 tags from local File objects).
    let jsmediatagsReady = false;
    function loadJsmediatags() {
        if (jsmediatagsReady || document.querySelector('script[src*="jsmediatags"]')) return;
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js';
        s.onload = () => { jsmediatagsReady = true; };
        document.head.appendChild(s);
    }
    loadJsmediatags();

    const albumArtEl = document.getElementById('wmp-album-art');

    function tryLoadAlbumArt(src, file = null) {
        albumArtEl.textContent = '\u{1F3B5}';
        // Prefer a real File object (drag-drop), fall back to fetching the URL.
        if (file instanceof File) {
            readTagsFromBlob(file);
        } else if (src) {
            fetch(src)
                .then(r => r.blob())
                .then(blob => readTagsFromBlob(blob))
                .catch(() => {}); // network/CORS failure; keep emoji placeholder
        }
    }

    function readTagsFromBlob(blob) {
        if (!window.jsmediatags) return;
        window.jsmediatags.read(blob, {
            onSuccess(tag) {
                const pic = tag.tags?.picture;
                if (!pic) return;
                const bytes = new Uint8Array(pic.data);
                const imgBlob = new Blob([bytes], { type: pic.format });
                const url = URL.createObjectURL(imgBlob);
                albumArtEl.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:4px;" alt="">`;
            },
            onError() {}, // no art in tags; keep emoji placeholder
        });
    }

    function loadHTML5Audio(src, title, file = null) {
        mode = 'audio-html5';

        screenWrap.style.display = 'none';
        audioWrap.style.display  = 'flex';
        openYtBtn.style.display  = 'none';
        modeLabel.textContent    = 'AUDIO';

        ensureIframe();
        ensureNoVideo();

        albumArtEl.textContent = '\u{1F3B5}';
        tryLoadAlbumArt(src, file ?? null);

        audioEl.src          = src;
        audioEl.volume       = volumeSlider.value / 100;
        audioEl.playbackRate = speed;

        trackName.textContent = title;
        setStatus('Loading\u2026');
        setPlayUI(false);
        audioEl.load();
    }

    // ── HTML5 video mode (local files) ────────────────────────

    function ensureVideoEl() {
        let el = document.getElementById('wmp-video-el');
        if (!el) {
            el = document.createElement('video');
            el.id            = 'wmp-video-el';
            el.controls      = false;
            el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000;';
            // YT Player injects its own <iframe> (no id) — wipe cleanly.
            screenWrap.innerHTML = '';
            screenWrap.appendChild(el);
        }
        return el;
    }

    function ensureNoVideo() {
        const el = document.getElementById('wmp-video-el');
        if (el) { el.pause(); el.src = ''; el.remove(); }
        // Also remove any lingering YT target div from a previous load
        const yt = document.getElementById('wmp-yt-target');
        if (yt) yt.remove();
    }

    function loadLocalVideo(src, title) {
        mode = 'video-local';

        screenWrap.style.display = 'block';
        audioWrap.style.display  = 'none';
        openYtBtn.style.display  = 'none';
        modeLabel.textContent    = 'VIDEO';

        audioEl.pause(); audioEl.src = '';
        if (ytPlayer) { try { ytPlayer.destroy(); } catch (_) {} ytPlayer = null; }

        const videoEl = ensureVideoEl();

        // Encode the path so special characters (spaces, brackets, etc.) are safe.
        // new URL() resolves relative paths against the page origin correctly.
        let safeSrc = src;
        try {
            const url = new URL(src, location.href);
            safeSrc = url.href;
        } catch (_) {
            // If URL() fails it's probably already absolute or malformed ; use as-is
        }

        videoEl.src          = safeSrc;
        videoEl.volume       = volumeSlider.value / 100;
        videoEl.playbackRate = speed;

        trackName.textContent = title;
        setStatus('Loading\u2026');
        setPlayUI(false);
        videoEl.load();

        videoEl.oncanplay = () => { duration = videoEl.duration || 0; setStatus('Ready'); videoEl.play(); };
        videoEl.onplay    = () => {
            setStatus('Playing'); setPlayUI(true);
            stopProgressTimer();
            progressTimer = setInterval(() => {
                if (!videoEl.duration) return;
                progressFill.style.width = (videoEl.currentTime / videoEl.duration * 100) + '%';
            }, 250);
        };
        videoEl.onpause  = () => { setStatus('Paused');  setPlayUI(false); stopProgressTimer(); };
        videoEl.onended  = () => { setStatus('Ended');   setPlayUI(false); stopProgressTimer(); progressFill.style.width = '100%'; };
        videoEl.onerror  = () => {
            const err = videoEl.error;
            const codes = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'unsupported format' };
            const msg = err ? (codes[err.code] || 'unknown error') : 'load error';
            console.error('[vmedia] Video error', err?.code, err?.message, 'src:', safeSrc);
            setStatus('Error: ' + msg);
        };
    }

    audioEl.addEventListener('canplay', () => {
        if (mode !== 'audio-html5') return;
        duration = audioEl.duration || 0;
        setStatus('Ready');
        audioEl.play();
    });

    audioEl.addEventListener('play', () => {
        if (mode !== 'audio-html5') return;
        setStatus('Playing');
        setPlayUI(true);
        stopProgressTimer();
        progressTimer = setInterval(() => {
            if (!audioEl.duration) return;
            progressFill.style.width = (audioEl.currentTime / audioEl.duration * 100) + '%';
        }, 250);
    });

    audioEl.addEventListener('pause', () => {
        if (mode !== 'audio-html5') return;
        setStatus('Paused');
        setPlayUI(false);
        stopProgressTimer();
    });

    audioEl.addEventListener('ended', () => {
        if (mode !== 'audio-html5') return;
        setStatus('Ended');
        setPlayUI(false);
        stopProgressTimer();
        progressFill.style.width = '100%';
    });

    audioEl.addEventListener('error', () => {
        if (mode === 'audio-html5') setStatus('Error loading file');
    });

    // ── Embed audio (Spotify, SoundCloud, etc.) ───────────────

    function loadEmbedAudio(src, title) {
        mode = 'audio-embed';

        let embedSrc = src;
        if (/soundcloud\.com\//i.test(src) && !src.includes('w.soundcloud.com')) {
            embedSrc =
                'https://w.soundcloud.com/player/?url=' +
                encodeURIComponent(src) +
                '&color=%23ff6a00&auto_play=true&show_artwork=true&buying=false&sharing=false';
        }

        // Restore plain iframe (YT player may have replaced it)
        const el = ensureIframe();
        el.src = embedSrc;

        screenWrap.style.display = 'block';
        audioWrap.style.display  = 'none';
        openYtBtn.style.display  = 'none';
        modeLabel.textContent    = /spotify/i.test(src) ? 'SPOTIFY'
                                 : /soundcloud/i.test(src) ? 'SOUNDCLOUD' : 'EMBED';

        audioEl.pause();
        audioEl.src = '';

        trackName.textContent = title;
        setStatus('Ready');
        setPlayUI(false);
    }

    // Ensures <iframe id="wmp-iframe"> exists inside #wmp-screen.
    // YT.Player replaces the target div with its own iframe; this
    // restores a plain iframe for embed-audio / next-video use.
    function ensureIframe() {
        let el = document.getElementById('wmp-iframe');
        if (!el) {
            el = document.createElement('iframe');
            el.id              = 'wmp-iframe';
            el.frameBorder     = '0';
            el.allow           = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
            el.allowFullscreen = true;
            el.style.cssText   = 'position:absolute;inset:0;width:100%;height:100%';
            // Clear screenWrap of any YT-created elements (YT injects its own
            // <iframe> without our id, plus the target div gets replaced).
            screenWrap.innerHTML = '';
            screenWrap.appendChild(el);
        }
        return el;
    }

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
            // Local video: path may be stored in either src or id field.
            // A YouTube ID is always a short alphanumeric string (11 chars, no slashes).
            const localSrc = (src && HTML5_VIDEO_EXT.test(src)) ? src
                           : (id  && HTML5_VIDEO_EXT.test(id))  ? id
                           : null;
            if (localSrc) {
                loadLocalVideo(localSrc, title);     // local video file
            } else {
                await loadYouTube(id, title);        // YouTube ID
            }
        } else if (HTML5_AUDIO_EXT.test(src)) {
            loadHTML5Audio(src, title, file ?? null);
        } else {
            loadEmbedAudio(src, title);
        }

        openWindow(entry);
    });

    // ── Transport controls ────────────────────────────────────

    playPauseBtn.addEventListener('click', () => {
        const videoEl = document.getElementById('wmp-video-el');
        if (mode === 'video' && ytPlayer) {
            ytPlaying ? ytPlayer.pauseVideo() : ytPlayer.playVideo();
        } else if (mode === 'video-local' && videoEl) {
            ytPlaying ? videoEl.pause() : videoEl.play();
        } else if (mode === 'audio-html5') {
            ytPlaying ? audioEl.pause() : audioEl.play();
        }
    });

    restartBtn.addEventListener('click', () => {
        const videoEl = document.getElementById('wmp-video-el');
        if (mode === 'video' && ytPlayer) {
            ytPlayer.seekTo(0, true);
            ytPlayer.playVideo();
            progressFill.style.width = '0%';
        } else if (mode === 'video-local' && videoEl) {
            videoEl.currentTime = 0;
            videoEl.play();
            progressFill.style.width = '0%';
        } else if (mode === 'audio-html5') {
            audioEl.currentTime = 0;
            audioEl.play();
        }
    });

    const SPEEDS = [1, 2, 4, 8, 16, 32, 64];
    speedBtn.addEventListener('click', () => {
        const idx = SPEEDS.indexOf(speed);
        speed = SPEEDS[(idx + 1) % SPEEDS.length];
        speedBtn.textContent = speed + '\xD7';
        speedBtn.classList.toggle('active', speed !== 1);
        if (mode === 'video' && ytPlayer)  ytPlayer.setPlaybackRate(speed);
        const _sv = document.getElementById('wmp-video-el');
        if (mode === 'video-local' && _sv) _sv.playbackRate = speed;
        if (mode === 'audio-html5')        audioEl.playbackRate = speed;
    });

    volumeSlider.addEventListener('input', () => {
        const v = parseInt(volumeSlider.value);
        if (mode === 'video' && ytPlayer)  ytPlayer.setVolume(v);
        const _vv = document.getElementById('wmp-video-el');
        if (mode === 'video-local' && _vv) _vv.volume = v / 100;
        if (mode === 'audio-html5')        audioEl.volume = v / 100;
    });

    progressTrack?.addEventListener('click', e => {
        const ratio = (e.clientX - progressTrack.getBoundingClientRect().left) /
                      progressTrack.offsetWidth;
        if (mode === 'video' && ytPlayer && duration) {
            const t = ratio * duration;
            ytPlayer.seekTo(t, true);
            progressFill.style.width = (ratio * 100) + '%';
        } else if (mode === 'video-local') {
            const _pv = document.getElementById('wmp-video-el');
            if (_pv && _pv.duration) _pv.currentTime = ratio * _pv.duration;
        } else if (mode === 'audio-html5' && audioEl.duration) {
            audioEl.currentTime = ratio * audioEl.duration;
        }
    });

    // ── Close ─────────────────────────────────────────────────

    windowEl.querySelector('.close-btn').addEventListener('click', () => {
        stopProgressTimer();
        if (ytPlayer) { try { ytPlayer.stopVideo(); } catch (_) {} }
        audioEl.pause();
        audioEl.src = '';
        ensureNoVideo();
        ensureIframe().src = '';
        albumArtEl.textContent = '\u{1F3B5}';
        resetUI();
        mode  = null;
        speed = 1;
        speedBtn.textContent = '1\xD7';
        speedBtn.classList.remove('active');
        setStatus('Ready');
        closeEQ(); // EQ closes with vMedia
    }, true);

    // ── Menu bar — VLC-style dropdowns ───────────────────────
    // Each .wmp-menu-item click opens a positioned dropdown panel.
    // Clicking outside or on another item closes the open one.
    // Items that trigger actions have data-action attributes.
    //
    // Menu structure is defined here in JS so adding new items
    // is just adding an entry to MENUS below.

    const MENUS = {
        file: [
            { label: 'Open File…',      action: 'file-open-dialog' },
            { label: 'Open URL…',       action: 'url-open-dialog'  },
            { sep: true },
            { label: 'Close',           action: 'close-player'     },
        ],
        view: [
            { label: 'Equalizer',       action: 'toggle-eq',       id: 'menu-item-eq' },
            { sep: true },
            { label: 'Always on Top',   action: 'noop', disabled: true },
        ],
        playback: [
            { label: 'Play / Pause',    action: 'playpause'  },
            { label: 'Restart',         action: 'restart'    },
            { sep: true },
            { label: 'Speed: 1×',       action: 'speed',     id: 'menu-item-speed' },
        ],
        tools: [
            { label: 'Preferences',     action: 'noop', disabled: true },
        ],
        help: [
            { label: 'About vMedia',    action: 'about' },
        ],
    };

    let openMenuKey = null;  // which menu is currently open
    let openDropEl  = null;  // the open dropdown DOM element

    function buildDropdown(key) {
        const items = MENUS[key];
        if (!items) return null;

        const drop = document.createElement('div');
        drop.className = 'wmp-dropdown';
        drop.dataset.menu = key;

        items.forEach(item => {
            if (item.sep) {
                const sep = document.createElement('div');
                sep.className = 'wmp-dropdown-sep';
                drop.appendChild(sep);
                return;
            }
            const el = document.createElement('div');
            el.className = 'wmp-dropdown-item' + (item.disabled ? ' disabled' : '');
            el.textContent = item.label;
            if (item.id) el.id = item.id;
            if (!item.disabled) {
                el.addEventListener('click', e => {
                    e.stopPropagation();
                    handleMenuAction(item.action, el);
                    closeDropdown();
                });
            }
            drop.appendChild(el);
        });

        return drop;
    }

    function openDropdown(key, anchorEl) {
        closeDropdown();
        const drop = buildDropdown(key);
        if (!drop) return;

        // Position below the menu item
        const rect = anchorEl.getBoundingClientRect();
        drop.style.left = rect.left + 'px';
        drop.style.top  = (rect.bottom + 2) + 'px';
        document.body.appendChild(drop);

        openMenuKey = key;
        openDropEl  = drop;
        anchorEl.classList.add('active');
    }

    function closeDropdown() {
        if (openDropEl) { openDropEl.remove(); openDropEl = null; }
        if (openMenuKey) {
            windowEl.querySelector(`[data-menu="${openMenuKey}"]`)
                ?.classList.remove('active');
            openMenuKey = null;
        }
    }

    // Wire each menu item
    windowEl.querySelectorAll('.wmp-menu-item[data-menu]').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const key = btn.dataset.menu;
            if (openMenuKey === key) { closeDropdown(); return; }
            openDropdown(key, btn);
        });
    });

    // Click outside closes open dropdown
    document.addEventListener('click', () => closeDropdown());

    // ── Menu action handler ───────────────────────────────────

    function handleMenuAction(action) {
        switch (action) {
            case 'toggle-eq':
                toggleEQ();
                break;
            case 'playpause':
                playPauseBtn.click();
                break;
            case 'restart':
                restartBtn.click();
                break;
            case 'speed':
                speedBtn.click();
                // Update the menu label next time the menu opens
                break;
            case 'close-player': {
                const closeBtn = windowEl.querySelector('.close-btn');
                if (closeBtn) closeBtn.click();
                break;
            }
            case 'about':
                alert('vMedia — modular web media player\nPart of vskid.github.io desktop');
                break;
            case 'file-open-dialog':
            case 'url-open-dialog':
            case 'noop':
            default:
                break;
        }
    }

    // ── Graphic EQ — standalone floating window ───────────────
    // The EQ lives in its own <div class="window" id="wmp-eq-window">
    // registered with the desktop so it's draggable + has a taskbar btn.
    // View menu item opens/closes it. Canvas visualiser runs whenever
    // the EQ window is open.

    const GAIN_BANDS = [
        { freq: 32,    label: '32'  },
        { freq: 64,    label: '64'  },
        { freq: 125,   label: '125' },
        { freq: 250,   label: '250' },
        { freq: 500,   label: '500' },
        { freq: 1000,  label: '1k'  },
        { freq: 2000,  label: '2k'  },
        { freq: 4000,  label: '4k'  },
        { freq: 8000,  label: '8k'  },
        { freq: 16000, label: '16k' },
    ];
    const VIS_BARS = 40;

    const eqWindowEl = document.getElementById('wmp-eq-window');
    // EQ is NOT registered with the desktop window system ; no taskbar button.
    // Draggable via a minimal local implementation.
    // z-index starts high (above any registered window) and bumps on click.
    eqWindowEl.style.zIndex = 200;
    {
        const bar = eqWindowEl.querySelector('.title-bar');
        let ox = 0, oy = 0, sx, sy, active = false;
        eqWindowEl.addEventListener('mousedown', () => {
            eqWindowEl.style.zIndex = 300; // always on top when interacted with
        });
        bar.addEventListener('mousedown', e => {
            if (e.target.closest('.window-controls')) return;
            e.stopPropagation(); // don't let vMedia's drag handler steal this
            sx = e.clientX - ox; sy = e.clientY - oy; active = true;
        });
        document.addEventListener('mousemove', e => {
            if (!active) return;
            ox = e.clientX - sx; oy = Math.max(0, e.clientY - sy);
            eqWindowEl.style.transform = `translate3d(${ox}px,${oy}px,0)`;
        });
        document.addEventListener('mouseup', () => { active = false; });
    }
    const eqCanvas   = document.getElementById('wmp-eq-canvas');
    const eqSliders  = document.getElementById('wmp-eq-sliders');
    const eqLabels   = document.getElementById('wmp-eq-labels');
    const eqResetBtn = document.getElementById('wmp-eq-reset');
    const ctx2d      = eqCanvas.getContext('2d');

    let audioCtx    = null;
    let analyser    = null;
    let filters     = [];
    let sourceNode  = null;
    let animFrameId = null;
    let gainValues  = new Array(GAIN_BANDS.length).fill(0);
    let decoTarget  = new Array(VIS_BARS).fill(0);
    let decoVal     = new Array(VIS_BARS).fill(0);
    let peakVal     = new Array(VIS_BARS).fill(0);
    let peakTimer   = new Array(VIS_BARS).fill(0);

    // ── Build gain slider DOM ─────────────────────────────────

    GAIN_BANDS.forEach((band, i) => {
        const bandEl = document.createElement('div');
        bandEl.className = 'wmp-eq-band';

        const valEl = document.createElement('div');
        valEl.className = 'wmp-eq-band-val';
        valEl.textContent = '0';

        const slider = document.createElement('input');
        slider.type      = 'range';
        slider.className = 'wmp-eq-slider';
        slider.min       = -12;
        slider.max       = 12;
        slider.step      = 0.5;
        slider.value     = 0;

        function applyGain(db) {
            gainValues[i] = db;
            slider.value  = db;
            valEl.textContent = (db >= 0 ? '+' : '') + db.toFixed(0);
            if (filters[i]) filters[i].gain.value = db;
        }

        slider.addEventListener('input', () => applyGain(parseFloat(slider.value)));

        // Double-click OR double-tap resets to 0 dB
        slider.addEventListener('dblclick', () => applyGain(0));
        let lastTap = 0;
        slider.addEventListener('touchend', e => {
            const now = Date.now();
            if (now - lastTap < 300) { e.preventDefault(); applyGain(0); }
            lastTap = now;
        });

        bandEl.appendChild(valEl);
        bandEl.appendChild(slider);
        eqSliders.appendChild(bandEl);

        const labelEl = document.createElement('div');
        labelEl.className   = 'wmp-eq-label';
        labelEl.textContent = band.label;
        eqLabels.appendChild(labelEl);
    });

    // Reset All button — zeroes every band
    eqResetBtn?.addEventListener('click', () => {
        GAIN_BANDS.forEach((_, i) => {
            gainValues[i] = 0;
            if (filters[i]) filters[i].gain.value = 0;
            const band   = eqSliders.children[i];
            const slider = band?.querySelector('.wmp-eq-slider');
            const valEl  = band?.querySelector('.wmp-eq-band-val');
            if (slider) slider.value = 0;
            if (valEl)  valEl.textContent = '0';
        });
    });

    // ── View → EQ: open/close EQ window ─────────────────────
    // EQ has no desktop entry ; show/hide directly, no taskbar involvement.

    function openEQ() {
        eqWindowEl.classList.remove('hidden');
        if (mode === 'audio-html5' && !audioEl.paused) connectAudioEl();
        requestAnimationFrame(() => { resizeCanvas(); startVisualiser(); });
    }

    function closeEQ() {
        eqWindowEl.classList.add('hidden');
        stopVisualiser();
    }

    function toggleEQ() {
        eqWindowEl.classList.contains('hidden') ? openEQ() : closeEQ();
    }

    // When the EQ window's own X button is clicked, stop the visualiser.
    // EQ close button ; just call closeEQ() which hides + stops visualiser.
    eqWindowEl.querySelector('.close-btn').addEventListener('click', () => {
        closeEQ();
    });

    function resizeCanvas() {
        const dpr = devicePixelRatio || 1;
        eqCanvas.width  = eqCanvas.offsetWidth  * dpr;
        eqCanvas.height = eqCanvas.offsetHeight * dpr;
        // Don't accumulate scale — reset to identity then scale once
        ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ── Web Audio setup ───────────────────────────────────────

    function setupAudioContext() {
        if (audioCtx) return;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize            = 2048; // 1024 bins → finer frequency resolution
        analyser.smoothingTimeConstant = 0.8;

        filters = GAIN_BANDS.map((band, i) => {
            const f           = audioCtx.createBiquadFilter();
            f.type            = i === 0 ? 'lowshelf'
                              : i === GAIN_BANDS.length - 1 ? 'highshelf' : 'peaking';
            f.frequency.value = band.freq;
            f.gain.value      = gainValues[i];
            f.Q.value         = 1.4;
            return f;
        });

        for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
        filters[filters.length - 1].connect(analyser);
        analyser.connect(audioCtx.destination);
    }

    function connectAudioEl() {
        if (!audioCtx) setupAudioContext();
        if (sourceNode) return;
        try {
            sourceNode = audioCtx.createMediaElementSource(audioEl);
            sourceNode.connect(filters[0]);
            if (audioCtx.state === 'suspended') audioCtx.resume();
        } catch (err) {
            console.warn('[vmedia EQ]', err);
        }
    }

    // ── Visualiser ────────────────────────────────────────────

    function startVisualiser() { stopVisualiser(); drawFrame(); }
    function stopVisualiser()  { if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; } }

    function drawFrame() {
        animFrameId = requestAnimationFrame(drawFrame);
        const W = eqCanvas.offsetWidth;
        const H = eqCanvas.offsetHeight;
        if (!W || !H) return;

        const dpr = devicePixelRatio || 1;
        if (eqCanvas.width !== W * dpr || eqCanvas.height !== H * dpr) {
            eqCanvas.width  = W * dpr;
            eqCanvas.height = H * dpr;
            ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        ctx2d.clearRect(0, 0, W, H);
        ctx2d.fillStyle = '#000';
        ctx2d.fillRect(0, 0, W, H);

        const gap  = 1;
        const barW = (W - (VIS_BARS + 1) * gap) / VIS_BARS;
        const maxH = H - 4;
        // Three rendering modes:
        //   'real'  — HTML5 audio through Web Audio analyser → real FFT bars
        //   'deco'  — embed audio (SC/Spotify) playing → animated fake bars
        //   'idle'  — YouTube, local video, paused, stopped → decay to flat
        const hasRealData = analyser && sourceNode && mode === 'audio-html5';
        const isEmbedPlay = mode === 'audio-embed';
        const renderMode  = hasRealData ? 'real' : isEmbedPlay ? 'deco' : 'idle';

        if (renderMode === 'real') {
            // Real FFT data
            const buf     = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(buf);
            const nyquist = audioCtx.sampleRate / 2;
            // Map VIS_BARS logarithmically across 20 Hz → 20 kHz
            for (let i = 0; i < VIS_BARS; i++) {
                const fLow  = 20 * Math.pow(20000 / 20, i / VIS_BARS);
                const fHigh = 20 * Math.pow(20000 / 20, (i + 1) / VIS_BARS);
                const bLow  = Math.floor(fLow  / nyquist * buf.length);
                const bHigh = Math.ceil(fHigh  / nyquist * buf.length);
                let sum = 0, count = 0;
                for (let b = bLow; b <= Math.min(bHigh, buf.length - 1); b++) { sum += buf[b]; count++; }
                const raw  = count ? sum / count / 255 : 0;
                const barH = Math.max(1, raw * maxH);

                // Peak hold: rise instantly, fall slowly
                if (barH > peakVal[i]) { peakVal[i] = barH; peakTimer[i] = 30; }
                else if (peakTimer[i] > 0) { peakTimer[i]--; }
                else { peakVal[i] = Math.max(1, peakVal[i] - 1.2); }

                const x = gap + i * (barW + gap);
                const y = H - barH - 2;

                const grad = ctx2d.createLinearGradient(0, H, 0, 2);
                grad.addColorStop(0,   'rgba(255, 60,  0,   0.95)');
                grad.addColorStop(0.6, 'rgba(255, 160, 0,   0.9)');
                grad.addColorStop(1,   'rgba(255, 240, 100, 0.85)');
                ctx2d.fillStyle = grad;
                ctx2d.fillRect(x, y, barW, barH);

                // Peak line
                const py = H - peakVal[i] - 2;
                ctx2d.fillStyle = 'rgba(255, 255, 200, 0.85)';
                ctx2d.fillRect(x, py, barW, 1.5);
            }
        } else {
            // 'deco' = embed playing, animate randomly
            // 'idle' = YouTube/video/paused, decay quietly to flat
            for (let i = 0; i < VIS_BARS; i++) {
                if (renderMode === 'deco') {
                    if (Math.random() < 0.03) decoTarget[i] = Math.random() * 0.9 + 0.05;
                    decoVal[i] += (decoTarget[i] - decoVal[i]) * 0.1;
                } else {
                    decoVal[i] *= 0.88; // idle: smooth decay only, no random jumps
                }

                if (decoVal[i] > peakVal[i]) { peakVal[i] = decoVal[i]; peakTimer[i] = 30; }
                else if (peakTimer[i] > 0)   { peakTimer[i]--; }
                else                         { peakVal[i] = Math.max(0, peakVal[i] - 0.008); }

                const barH  = Math.max(0, decoVal[i] * maxH);
                const x     = gap + i * (barW + gap);
                const y     = H - barH - 2;
                const alpha = renderMode === 'deco' ? '0.75' : '0.3';

                const grad = ctx2d.createLinearGradient(0, H, 0, 2);
                grad.addColorStop(0,   `rgba(255,60,0,${alpha})`);
                grad.addColorStop(0.6, `rgba(255,150,0,${alpha})`);
                grad.addColorStop(1,   `rgba(255,230,80,${alpha})`);
                ctx2d.fillStyle = grad;
                ctx2d.fillRect(x, y, barW, barH);

                const py = H - peakVal[i] * maxH - 2;
                ctx2d.fillStyle = `rgba(255,255,150,${renderMode === 'deco' ? '0.6' : '0.15'})`;
                ctx2d.fillRect(x, py, barW, 1.5);
            }
        }

        // Grid lines
        ctx2d.strokeStyle = 'rgba(255, 120, 0, 0.07)';
        ctx2d.lineWidth   = 1;
        [0.25, 0.5, 0.75].forEach(f => {
            const y = Math.round(H * f) + 0.5;
            ctx2d.beginPath(); ctx2d.moveTo(0, y); ctx2d.lineTo(W, y); ctx2d.stroke();
        });
    }

    audioEl.addEventListener('play', () => {
        const eqIsOpen = eqWindowEl && !eqWindowEl.classList.contains('hidden');
        if (mode === 'audio-html5' && eqIsOpen) connectAudioEl();
        if (audioCtx?.state === 'suspended') audioCtx.resume();
    });

}