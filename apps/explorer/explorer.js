// ============================================================
// apps/explorer/explorer.js
// ============================================================
// ALL sidebar navigation is in-place — clicking any folder
// (including siblings) navigates within the same window.
// No cross-window opening from sidebar clicks.
//
// Sidebar is a collapsible tree. Subfolder icons always 📁.
// ============================================================

export async function initExplorer({ registerWindow, openWindow }) {

    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = new URL('explorer.css', import.meta.url).href;
    document.head.appendChild(link);

    let fs;
    try {
        const res = await fetch('/filesystem.json');
        fs = await res.json();
    } catch (err) {
        console.error('[explorer] Failed to load filesystem.json', err);
        return;
    }

    let template;
    try {
        const res = await fetch(new URL('explorer.html', import.meta.url).href);
        template  = await res.text();
    } catch (err) {
        console.error('[explorer] Failed to load explorer.html', err);
        return;
    }

    const topFolders = (fs.children || []).filter(n => n.iconId && n.windowId);

    topFolders.forEach(rootFolder => {
        const iconEl = document.getElementById(rootFolder.iconId);
        if (!iconEl) return;

        const html = template
            .replaceAll('{{windowId}}', rootFolder.windowId)
            .replaceAll('{{icon}}',     rootFolder.icon)
            .replaceAll('{{title}}',    rootFolder.name)
            .replaceAll('{{path}}',     `${fs.name}/${rootFolder.name}`)
            .replaceAll('{{items}}',    '');

        document.body.insertAdjacentHTML('beforeend', html);

        const windowEl = document.getElementById(rootFolder.windowId);
        windowEl.querySelector('.title-text').innerHTML =
            '<span class="title-icon">📁</span> Explorer';

        const entry = registerWindow(windowEl, { icon: '📁' });
        iconEl.addEventListener('dblclick', () => openWindow(entry));

        const backBtn    = windowEl.querySelectorAll('.nav-btn')[0];
        const fwdBtn     = windowEl.querySelectorAll('.nav-btn')[1];
        const addressBar = windowEl.querySelector('.address-bar');
        const fileGrid   = windowEl.querySelector('.file-grid');
        const sidebar    = windowEl.querySelector('.explorer-sidebar');

        // ── Path builder ──────────────────────────────────────
        function buildPath(target) {
            function search(node, acc) {
                const here = [...acc, node.name];
                if (node === target) return here;
                for (const c of node.children || []) {
                    const found = search(c, here);
                    if (found) return found;
                }
                return null;
            }
            return search(fs, []) || [target.name];
        }

        // ── History ───────────────────────────────────────────
        const hist = [{ node: rootFolder, path: [fs.name, rootFolder.name] }];
        let cur = 0;

        // ── Navigate ──────────────────────────────────────────
        function navigateTo(folderNode, path, push = true) {
            if (push) {
                hist.splice(cur + 1);
                hist.push({ node: folderNode, path });
                cur = hist.length - 1;
            }

            addressBar.textContent = path.join('/');
            backBtn.disabled = cur <= 0;
            fwdBtn.disabled  = cur >= hist.length - 1;

            // Render content grid
            fileGrid.innerHTML = '';
            for (const child of folderNode.children || []) {
                if (child.children) {
                    const el = document.createElement('div');
                    el.className = 'file-item';
                    el.innerHTML = `
                        <div class="file-icon">${child.icon || '📁'}</div>
                        <div class="file-name">${trunc(child.name)}</div>
                        <div class="file-date"></div>`;
                    el.addEventListener('click', () =>
                        navigateTo(child, buildPath(child)));
                    fileGrid.appendChild(el);
                } else {
                    fileGrid.insertAdjacentHTML('beforeend', renderItem(child));
                }
            }

            // Sync sidebar active state
            sidebar.querySelectorAll('.sidebar-item').forEach(btn => {
                btn.classList.toggle('active', btn._node === folderNode);
            });
        }

        backBtn.addEventListener('click', () => {
            if (cur <= 0) return;
            cur--;
            navigateTo(hist[cur].node, hist[cur].path, false);
        });
        fwdBtn.addEventListener('click', () => {
            if (cur >= hist.length - 1) return;
            cur++;
            navigateTo(hist[cur].node, hist[cur].path, false);
        });

        // File item click → dispatch file-open event
        windowEl.addEventListener('click', e => {
            const item = e.target.closest('.file-item[data-type]');
            if (!item) return;
            document.dispatchEvent(new CustomEvent('file-open', {
                detail: {
                    type:           item.dataset.type,
                    id:             item.dataset.id   ?? null,
                    title:          item.dataset.title ?? 'Untitled',
                    src:            item.dataset.src   ?? null,
                    sourceWindowId: rootFolder.windowId,
                }
            }));
        });

        // ── Sidebar collapsible tree ───────────────────────────
        // Every click navigates in-place. No window spawning ever.
        // Subfolders (depth > 0) always show 📁.

        const label = document.createElement('div');
        label.className   = 'sidebar-section-label';
        label.textContent = 'Folders';
        sidebar.appendChild(label);

        function buildTreeNode(node, depth) {
            const kids = (node.children || []).filter(c => c.children);

            const wrap = document.createElement('div');
            wrap.className = 'sidebar-tree-row';

            const btn = document.createElement('button');
            btn.className = 'sidebar-item' +
                (depth === 0 ? ' sidebar-item-toplevel' : ' sidebar-item-sub');
            btn.style.paddingLeft = `${12 + depth * 12}px`;
            btn._node = node;  // direct reference for active-state sync

            // Arrow — only when there are sub-folders
            const arrow = document.createElement('span');
            arrow.className = 'sidebar-arrow';
            arrow.textContent = kids.length ? '▶' : '';

            // Icon: top-level keeps its configured icon; sub-folders always 📁
            const ico = document.createElement('span');
            ico.className   = 'sidebar-item-icon';
            ico.textContent = node.icon || '📁';

            btn.appendChild(arrow);
            btn.appendChild(ico);
            btn.appendChild(document.createTextNode(node.name));
            wrap.appendChild(btn);

            // Children container
            let childDiv  = null;
            let expanded  = depth === 0;   // top-level open; sub-folders closed

            if (kids.length) {
                childDiv = document.createElement('div');
                childDiv.className    = 'sidebar-children';
                childDiv.style.display = expanded ? '' : 'none';
                if (expanded) arrow.classList.add('expanded');
                for (const k of kids) childDiv.appendChild(buildTreeNode(k, depth + 1));
                wrap.appendChild(childDiv);
            }

            btn.addEventListener('click', () => {
                // Always navigate in-place — never open another window
                navigateTo(node, buildPath(node));

                if (childDiv) {
                    expanded = !expanded;
                    childDiv.style.display = expanded ? '' : 'none';
                    arrow.classList.toggle('expanded', expanded);
                }
            });

            return wrap;
        }

        // Show the full filesystem tree in every window's sidebar
        for (const top of fs.children || []) {
            if (top.children) sidebar.appendChild(buildTreeNode(top, 0));
        }

        // Boot: show rootFolder's contents on first open
        navigateTo(rootFolder, [fs.name, rootFolder.name], false);
    });
}

// ── Helpers ───────────────────────────────────────────────────
function trunc(s, max = 16) {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function renderItem(item) {
    const icon  = item.icon  || '📄';
    const name  = item.name  || item.title || 'Untitled';
    const date  = item.date  || '';
    const title = item.title || name;

    switch (item.type) {
        case 'project':
            return `
<a href="${item.href}" class="file-item-link" target="_blank" rel="noopener noreferrer" title="${name}">
  <div class="file-item">
    <div class="file-icon">${icon}</div>
    <div class="file-name">${trunc(name)}</div>
    <div class="file-date">${date}</div>
  </div>
</a>`;
        case 'video':
            return `
<div class="file-item" data-type="video"
     data-id="${item.id ?? ''}" data-src="${item.src ?? ''}" data-title="${title}" title="${name}">
  <div class="file-icon">${icon}</div>
  <div class="file-name">${trunc(name)}</div>
  <div class="file-date">${date}</div>
</div>`;
        case 'audio':
            return `
<div class="file-item" data-type="audio"
     data-src="${item.src ?? ''}" data-title="${title}" title="${name}">
  <div class="file-icon">${icon}</div>
  <div class="file-name">${trunc(name)}</div>
  <div class="file-date">${date}</div>
</div>`;
        case 'image':
            return `
<div class="file-item" data-type="image"
     data-src="${item.src ?? ''}" data-title="${title}" title="${name}">
  <div class="file-icon">${icon}</div>
  <div class="file-name">${trunc(name)}</div>
  <div class="file-date">${date}</div>
</div>`;
        case 'doc':
            return `
<div class="file-item" data-type="doc"
     data-id="${item.id ?? ''}" data-title="${title}" title="${title}">
  <div class="file-icon">${icon}</div>
  <div class="file-name">${trunc(title)}</div>
  <div class="file-date">${date}</div>
</div>`;
        default:
            return '';
    }
}
