// ============================================================
// apps/vdoc/vdoc.js — vDoc blog/document viewer
// ============================================================
// Reads all doc nodes from /filesystem.json (walks the tree).
// Posts can use:
//   file: 'posts/my-post.md'   ← fetched and rendered as markdown
//   body: '<p>inline HTML</p>' ← used as-is
// ============================================================

import { WALL_PASSWORD } from '../../core/config.js';

// ── Markdown renderer ─────────────────────────────────────────
function mdToHtml(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inCode = false, codeLang = '', codeLines = [];
    let inList = false, listType = '';

    function flushList() {
        if (!inList) return;
        out.push(`</${listType}>`);
        inList = false; listType = '';
    }

    for (const raw of lines) {
        if (/^```/.test(raw)) {
            if (!inCode) {
                flushList();
                inCode = true; codeLang = raw.slice(3).trim(); codeLines = [];
            } else {
                const esc = codeLines.join('\n')
                    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                out.push(`<pre><code class="lang-${codeLang}">${esc}</code></pre>`);
                inCode = false;
            }
            continue;
        }
        if (inCode) { codeLines.push(raw); continue; }

        const hm = raw.match(/^(#{1,3})\s+(.*)/);
        if (hm) { flushList(); out.push(`<h${hm[1].length}>${inl(hm[2])}</h${hm[1].length}>`); continue; }
        if (/^---+$/.test(raw.trim())) { flushList(); out.push('<hr>'); continue; }
        if (/^>\s?/.test(raw)) { flushList(); out.push(`<blockquote>${inl(raw.replace(/^>\s?/,''))}</blockquote>`); continue; }

        const ulm = raw.match(/^[-*]\s+(.*)/);
        if (ulm) {
            if (!inList || listType !== 'ul') { flushList(); out.push('<ul>'); inList = true; listType = 'ul'; }
            out.push(`<li>${inl(ulm[1])}</li>`); continue;
        }
        const olm = raw.match(/^\d+\.\s+(.*)/);
        if (olm) {
            if (!inList || listType !== 'ol') { flushList(); out.push('<ol>'); inList = true; listType = 'ol'; }
            out.push(`<li>${inl(olm[1])}</li>`); continue;
        }
        if (raw.trim() === '') { flushList(); out.push(''); continue; }
        flushList();
        out.push(`<p>${inl(raw)}</p>`);
    }
    flushList();
    return out.join('\n');
}

function inl(s) {
    return s
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/`([^`]+)`/g,'<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
        .replace(/__([^_]+)__/g,'<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g,'<em>$1</em>')
        .replace(/_([^_]+)_/g,'<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// ── Walk filesystem.json and collect all doc nodes ────────────
async function loadDocs() {
    try {
        const res = await fetch('/filesystem.json');
        const fs  = await res.json();
        const docs = [];
        function walk(node) {
            if (node.type === 'doc') { docs.push(node); return; }
            for (const child of node.children || []) walk(child);
        }
        walk(fs);
        return docs;
    } catch (err) {
        console.error('[vdoc] Failed to load filesystem.json', err);
        return [];
    }
}

// ── App ───────────────────────────────────────────────────────
export async function initVDoc({ registerWindow, openWindow }) {

    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = new URL('vdoc.css', import.meta.url).href;
    document.head.appendChild(link);

    try {
        const res  = await fetch(new URL('vdoc.html', import.meta.url).href);
        const html = await res.text();
        document.body.insertAdjacentHTML('beforeend', html);
    } catch (err) {
        console.error('[vdoc] Failed to load vdoc.html', err);
        return;
    }

    const windowEl = document.getElementById('vdoc-window');
    if (!windowEl) return;
    const entry = registerWindow(windowEl, { icon: '📝' });

    document.addEventListener('file-open', e => {
        if (e.detail?.type !== 'doc') return;
        openWindow(entry);
        if (e.detail.id) openPost(e.detail.id);
    });

    // ── DOM refs ──────────────────────────────────────────────
    const sidebar      = document.getElementById('vdoc-sidebar');
    const sidebarToggle = document.getElementById('vdoc-sidebar-toggle');
    const postList     = document.getElementById('vdoc-post-list');
    const docEl        = document.getElementById('vdoc-document');
    const placeholder  = document.getElementById('vdoc-placeholder');
    const toolbarTitle = document.getElementById('vdoc-doc-title');
    const toolbarDate  = document.getElementById('vdoc-doc-date');
    const ownerBtn     = document.getElementById('vdoc-owner-btn');
    const modal        = document.getElementById('vdoc-owner-modal');
    const modalPw      = document.getElementById('vdoc-owner-pw');
    const modalSubmit  = document.getElementById('vdoc-modal-submit');
    const modalCancel  = document.getElementById('vdoc-modal-cancel');
    const modalErr     = document.getElementById('vdoc-modal-err');

    let ownerUnlocked = false;

    // ── Sidebar toggle ────────────────────────────────────────
    sidebarToggle?.addEventListener('click', () => {
        const collapsed = sidebar.classList.toggle('collapsed');
        sidebarToggle.textContent = collapsed ? '›' : '‹';
        sidebarToggle.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
    });

    // ── Load posts ────────────────────────────────────────────
    const posts = await loadDocs();

    if (posts.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:14px;font-size:0.78rem;color:rgba(200,222,255,0.3);font-style:italic;font-family:Georgia,serif;';
        empty.textContent = 'No documents yet.';
        postList.appendChild(empty);
    }

    posts.forEach(post => {
        const item = document.createElement('div');
        item.className  = 'vdoc-post-item';
        item.dataset.id = post.id;

        const title = document.createElement('div');
        title.className   = 'vdoc-post-item-title';
        title.textContent = post.title || post.name;

        const date = document.createElement('div');
        date.className   = 'vdoc-post-item-date';
        date.textContent = post.date ?? '';

        item.appendChild(title);
        item.appendChild(date);
        item.addEventListener('click', () => openPost(post.id));
        postList.appendChild(item);
    });

    // ── Open post ─────────────────────────────────────────────
    async function openPost(id) {
        const post = posts.find(p => p.id === id);
        if (!post) return;

        postList.querySelectorAll('.vdoc-post-item').forEach(el =>
            el.classList.toggle('active', el.dataset.id === id));

        toolbarTitle.textContent  = post.title || post.name;
        toolbarDate.textContent   = post.date ?? '';
        placeholder.style.display = 'none';

        docEl.querySelectorAll('.vdoc-doc-header, .vdoc-doc-body, .vdoc-loading')
            .forEach(el => el.remove());

        const loading = document.createElement('div');
        loading.className = 'vdoc-loading';
        loading.style.cssText = 'padding:40px;text-align:center;color:#a0b0c0;font-style:italic;font-size:0.88rem;font-family:Georgia,serif;';
        loading.textContent = 'Loading…';
        docEl.appendChild(loading);

        let bodyHtml = '';
        if (post.body) {
            bodyHtml = post.body;
        } else if (post.file) {
            try {
                const r = await fetch(post.file);
                if (!r.ok) throw new Error(r.status);
                bodyHtml = mdToHtml(await r.text());
            } catch {
                bodyHtml = `<p><em>Could not load: ${post.file}</em></p>`;
            }
        } else {
            bodyHtml = '<p><em>No content.</em></p>';
        }

        loading.remove();

        const header = document.createElement('div');
        header.className = 'vdoc-doc-header';

        const titleEl = document.createElement('h1');
        titleEl.className   = 'vdoc-doc-title';
        titleEl.textContent = post.title || post.name;

        const meta = document.createElement('div');
        meta.className   = 'vdoc-doc-meta';
        meta.textContent = post.date ?? '';

        header.appendChild(titleEl);
        header.appendChild(meta);

        const body = document.createElement('div');
        body.className = 'vdoc-doc-body';
        body.innerHTML = bodyHtml;

        docEl.appendChild(header);
        docEl.appendChild(body);
        docEl.parentElement.scrollTop = 0;
    }

    // ── Owner mode ────────────────────────────────────────────
    ownerBtn.addEventListener('click', () => {
        if (ownerUnlocked) { lockOwner(); return; }
        modal.classList.remove('hidden');
        modalPw.value = '';
        modalErr.classList.add('hidden');
        requestAnimationFrame(() => modalPw.focus());
    });

    modalCancel.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });

    function attemptLogin() {
        if (modalPw.value === WALL_PASSWORD) {
            modal.classList.add('hidden');
            unlockOwner();
        } else {
            modalErr.classList.remove('hidden');
            modalPw.value = '';
            modalPw.focus();
        }
    }

    modalSubmit.addEventListener('click', attemptLogin);
    modalPw.addEventListener('keydown', e => {
        if (e.key === 'Enter')  attemptLogin();
        if (e.key === 'Escape') modal.classList.add('hidden');
    });

    function unlockOwner() {
        ownerUnlocked = true;
        ownerBtn.textContent = '🔓';
        ownerBtn.classList.add('unlocked');
        ownerBtn.title = 'Owner mode active';
    }

    function lockOwner() {
        ownerUnlocked = false;
        ownerBtn.textContent = '🔒';
        ownerBtn.classList.remove('unlocked');
        ownerBtn.title = 'Owner login';
    }

    if (posts.length > 0) openPost(posts[0].id);
}
