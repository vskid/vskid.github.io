// ============================================================
// vmedia-albumart.js — Album art extraction (ID3 / MP4 tags)
// ============================================================

let ready = false;

export function loadJsmediatags() {
    if (ready || document.querySelector('script[src*="jsmediatags"]')) return;
    const s = document.createElement('script');
    s.src   = 'https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js';
    s.onload = () => { ready = true; };
    document.head.appendChild(s);
}

function readTagsFromBlob(blob, artEl) {
    if (!window.jsmediatags) return;
    window.jsmediatags.read(blob, {
        onSuccess(tag) {
            const pic = tag.tags?.picture;
            if (!pic) return;
            const url = URL.createObjectURL(
                new Blob([new Uint8Array(pic.data)], { type: pic.format })
            );
            artEl.innerHTML = `<img src="${url}"
                style="width:100%;height:100%;object-fit:cover;border-radius:4px;" alt="">`;
        },
        onError() {},
    });
}

export function tryLoadAlbumArt(artEl, src, file = null) {
    artEl.textContent = '🎵';
    if (file instanceof File) {
        readTagsFromBlob(file, artEl);
    } else if (src) {
        fetch(src)
            .then(r => r.blob())
            .then(b => readTagsFromBlob(b, artEl))
            .catch(() => {});
    }
}