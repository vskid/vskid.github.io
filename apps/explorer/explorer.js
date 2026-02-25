// ============================================================
// apps/explorer/explorer.js
// ============================================================
// Generic file explorer. Handles all folder windows.
//
// Each folder gets its own window (opened from desktop icon).
// Inside each window, the sidebar lists ALL folders ; clicking
// one navigates in-place (updates content, address bar, title).
// Back/forward buttons maintain per-window history.
//
// Adding a new folder: just add it to FOLDERS in config.js.
// The sidebar and navigation update automatically.
// ============================================================

import { FOLDERS } from '../../core/config.js';

export async function initExplorer({ registerWindow, openWindow }) {

    // ── Inject CSS ───────────────────────────────────────────
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
    FOLDERS.forEach((folder, startIndex) => {
        const iconEl = document.getElementById(folder.iconId);
        if (!iconEl) return;

        const html = template
            .replaceAll('{{windowId}}', folder.windowId)
            .replaceAll('{{icon}}',     folder.icon)
            .replaceAll('{{title}}',    folder.title)
            .replaceAll('{{path}}',     folder.path)
            .replaceAll('{{items}}',    folder.items.map(renderItem).join('\n'));

        document.body.insertAdjacentHTML('beforeend', html);
        const windowEl = document.getElementById(folder.windowId);
        // Title bar always shows "📁 Explorer" regardless of which folder is open
        const titleTextEl = windowEl.querySelector('.title-text');
        if (titleTextEl) titleTextEl.innerHTML = '<span class="title-icon">📁</span> Explorer';

        const entry = registerWindow(windowEl, { icon: '📁' });
        iconEl.addEventListener('dblclick', () => openWindow(entry));

        // ── DOM refs ─────────────────────────────────────────
        const backBtn    = windowEl.querySelectorAll('.nav-btn')[0];
        const fwdBtn     = windowEl.querySelectorAll('.nav-btn')[1];
        backBtn.title = 'Back (navigate via sidebar first)';
        fwdBtn.title  = 'Forward';
        const addressBar = windowEl.querySelector('.address-bar');
        const fileGrid   = windowEl.querySelector('.file-grid');
        const sidebar    = windowEl.querySelector('.explorer-sidebar');

        // ── Per-window nav history ────────────────────────────
        const navHistory = [startIndex];
        let cursor = 0;

        // ── Sidebar ───────────────────────────────────────────
        // One section label + one button per folder.
        // Adding folders to config.js automatically adds sidebar items.
        const sectionLabel = document.createElement('div');
        sectionLabel.className   = 'sidebar-section-label';
        sectionLabel.textContent = 'Folders';
        sidebar.appendChild(sectionLabel);

        const sidebarBtns = FOLDERS.map((f, idx) => {
            const btn = document.createElement('button');
            btn.className = 'sidebar-item' + (idx === startIndex ? ' active' : '');
            btn.innerHTML = `<span class="sidebar-item-icon">${f.icon}</span>${f.title}`;
            btn.title     = f.path;
            btn.addEventListener('click', () => navigateTo(idx));
            sidebar.appendChild(btn);
            return btn;
        });

        // ── Navigation ────────────────────────────────────────
        function navigateTo(folderIndex, push = true) {
            const target = FOLDERS[folderIndex];
            if (!target) return;

            if (push) {
                navHistory.splice(cursor + 1);
                navHistory.push(folderIndex);
                cursor = navHistory.length - 1;
            }

            // Update toolbar
            addressBar.textContent = target.path;
            backBtn.disabled = cursor <= 0;
            fwdBtn.disabled  = cursor >= navHistory.length - 1;

            // Update content
            fileGrid.innerHTML = target.items.map(renderItem).join('\n');

            // Update sidebar active state
            sidebarBtns.forEach((btn, i) => btn.classList.toggle('active', i === folderIndex));
        }

        backBtn.addEventListener('click', () => {
            if (cursor <= 0) return;
            cursor--;
            navigateTo(navHistory[cursor], false);
        });

        fwdBtn.addEventListener('click', () => {
            if (cursor >= navHistory.length - 1) return;
            cursor++;
            navigateTo(navHistory[cursor], false);
        });

        // ── File item clicks ──────────────────────────────────
        windowEl.addEventListener('click', e => {
            const item = e.target.closest('.file-item[data-type]');
            if (!item) return;
            document.dispatchEvent(new CustomEvent('file-open', {
                detail: {
                    type:           item.dataset.type,
                    id:             item.dataset.id    ?? null,
                    title:          item.dataset.title ?? 'Untitled',
                    src:            item.dataset.src   ?? null,
                    sourceWindowId: folder.windowId,
                }
            }));
        });
    });
}

// ── Item renderers ───────────────────────────────────────────
// Add new item types here; sidebar and navigation update for free.

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
<div class="file-item" data-type="video"
     data-id="${item.id ?? ''}" data-src="${item.src ?? ''}" data-title="${item.title}">
  <div class="file-icon">${item.icon}</div>
  <div class="file-name">${item.name}</div>
  <div class="file-date">${item.date}</div>
</div>`;

        case 'audio':
            return `
<div class="file-item" data-type="audio"
     data-src="${item.src}" data-title="${item.title}">
  <div class="file-icon">${item.icon}</div>
  <div class="file-name">${item.name}</div>
  <div class="file-date">${item.date}</div>
</div>`;

        case 'image':
            return `
<div class="file-item" data-type="image"
     data-src="${item.src}" data-title="${item.title}">
  <div class="file-icon">${item.icon}</div>
  <div class="file-name">${item.name}</div>
  <div class="file-date">${item.date}</div>
</div>`;

        default:
            return '';
    }
}