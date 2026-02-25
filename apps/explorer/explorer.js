// ============================================================
// apps/explorer/explorer.js
// ============================================================
// Generic file-explorer. Handles ALL folder windows.
//
// On init:
//   1. Injects explorer.css into <head>
//   2. Fetches explorer.html template once
//   3. For each folder in config.js, clones + populates the
//      template and appends it to <body>
//   4. Registers each window with the desktop window system
//   5. Wires desktop icon double-clicks to open the window
//
// File items dispatch a 'file-open' custom event so other
// app modules can react without being coupled here.
//
// The taskbar icon is always 📁 regardless of which folder
// is open ; explorer is one app, not four.
// ============================================================

import { FOLDERS } from '../../core/config.js';

export async function initExplorer({ registerWindow, openWindow }) {

    // ── Inject CSS ───────────────────────────────────────────
    // import.meta.url is this file's URL; replace .js with .css for a sibling path.
    // This works correctly regardless of where the site is hosted (root or subdirectory).
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = new URL('explorer.css', import.meta.url).href;
    document.head.appendChild(link);

    // ── Fetch HTML template ──────────────────────────────────
    let template;
    try {
        const res = await fetch(new URL('explorer.html', import.meta.url).href);
        template  = await res.text();
    } catch (err) {
        console.error('[explorer] Failed to load explorer.html', err);
        return;
    }

    // ── Build + register each folder window ─────────────────
    FOLDERS.forEach(folder => {
        const iconEl = document.getElementById(folder.iconId);
        if (!iconEl) return;

        // Render file items to HTML string
        const itemsHtml = folder.items.map(item => renderItem(item)).join('\n');

        // Populate template placeholders
        const html = template
            .replaceAll('{{windowId}}', folder.windowId)
            .replaceAll('{{icon}}',     folder.icon)
            .replaceAll('{{title}}',    folder.title)
            .replaceAll('{{path}}',     folder.path)
            .replaceAll('{{items}}',    itemsHtml);

        // Inject into DOM
        document.body.insertAdjacentHTML('beforeend', html);
        const windowEl = document.getElementById(folder.windowId);

        // Register with desktop ; override icon to always be 📁
        const entry = registerWindow(windowEl, { icon: '📁' });

        // Desktop icon double-click opens the window
        iconEl.addEventListener('dblclick', () => openWindow(entry));

        // Delegate file-item clicks : dispatch file-open event
        windowEl.addEventListener('click', e => {
            const item = e.target.closest('.file-item[data-type]');
            if (!item) return;
            document.dispatchEvent(new CustomEvent('file-open', {
                detail: {
                    type:           item.dataset.type,
                    id:             item.dataset.id    ?? null,
                    title:          item.dataset.title ?? 'Untitled',
                    src:            item.dataset.src   ?? null,
                    ext:            item.dataset.ext   ?? null,
                    sourceWindowId: folder.windowId,
                }
            }));
        });
    });
}

// ── Item renderers ───────────────────────────────────────────

function renderItem(item) {
    switch (item.type) {
        case 'project':
            return `
<a href="${item.href}" class="file-item-link" target="_blank" rel="noopener noreferrer">
  <div class="file-item">
    <div class="file-icon">${item.icon}</div>
    <div class="file-name">${item.name}</div>
    <div class="file-date">${item.date}</div>
  </div>
</a>`;

        case 'video':
            return `
<div class="file-item"
     data-type="video"
     data-id="${item.id}"
     data-title="${item.title}">
  <div class="file-icon">${item.icon}</div>
  <div class="file-name">${item.name}</div>
  <div class="file-date">${item.date}</div>
</div>`;

        case 'audio':
            return `
<div class="file-item"
     data-type="audio"
     data-src="${item.src}"
     data-title="${item.title}">
  <div class="file-icon">${item.icon}</div>
  <div class="file-name">${item.name}</div>
  <div class="file-date">${item.date}</div>
</div>`;

        case 'image':
            return `
<div class="file-item"
     data-type="image"
     data-src="${item.src}"
     data-title="${item.title}">
  <div class="file-icon">${item.icon}</div>
  <div class="file-name">${item.name}</div>
  <div class="file-date">${item.date}</div>
</div>`;

        default:
            return '';
    }
}