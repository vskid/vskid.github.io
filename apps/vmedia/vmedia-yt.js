// ============================================================
// vmedia-yt.js — YouTube IFrame API wrapper
// ============================================================

export function loadYTApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    return new Promise(resolve => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
        if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
            const s = document.createElement('script');
            s.src   = 'https://www.youtube.com/iframe_api';
            s.async = true;
            document.head.appendChild(s);
        }
    });
}

// Creates or replaces the YT.Player inside screenWrap.
// Returns the new YT.Player instance.
export async function createYTPlayer(screenWrap, { videoId, volume, onState }) {
    screenWrap.innerHTML = '';
    const target = document.createElement('div');
    target.id = 'wmp-yt-target';
    target.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    screenWrap.appendChild(target);

    await loadYTApi();

    return new window.YT.Player('wmp-yt-target', {
        videoId,
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },
        events: {
            onReady: e => e.target.setVolume(volume),
            onStateChange: e => onState(e.data),
        },
    });
}