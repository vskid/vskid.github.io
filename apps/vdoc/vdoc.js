// ============================================================
// apps/vdoc/vdoc.js — vDoc blog/document viewer
// ============================================================
// Posts defined in BLOG_POSTS (config.js).
// Each post can have either:
//   body: '<p>inline HTML</p>'      ← inline content
//   file: 'posts/my-post.md'        ← path to a .md file (fetched at open time)
//
// Opened by:
//   - Double-clicking the "Documents" desktop icon (open-docs)
//   - Clicking a doc item in the explorer (file-open event, type:'doc')
// ============================================================

import { BLOG_POSTS, WALL_PASSWORD } from '../../core/config.js';

// ── Minimal markdown → HTML ───────────────────────────────────
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
        if (/^>\s?/.test(raw))         { flushList(); out.push(`<blockquote>${inl(raw.replace(/^>\s?/,''))}</blockquote>`); continue; }

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

// ── App init ──────────────────────────────────────────────────
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

    // Desktop icon: open-docs (Documents folder on desktop)
    document.getElementById('open-docs')
        ?.addEventListener('dblclick', () => openWindow(entry));

    // Explorer file-open event: type:'doc', id: post id
    document.addEventListener('file-open', e => {
        if (e.detail?.type !== 'doc') return;
        openWindow(entry);
        if (e.detail.id) openPost(e.detail.id);
    });

    // ── DOM refs ──────────────────────────────────────────────
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
    const posts = Array.isArray(BLOG_POSTS) ? BLOG_POSTS : [];

    // ── Build sidebar ─────────────────────────────────────────
    if (posts.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:14px;font-size:0.78rem;color:rgba(200,222,255,0.3);font-style:italic;font-family:Georgia,serif;';
        empty.textContent = 'No posts yet.';
        postList.appendChild(empty);
    }

    posts.forEach(post => {
        const item = document.createElement('div');
        item.className  = 'vdoc-post-item';
        item.dataset.id = post.id;

        const title = document.createElement('div');
        title.className   = 'vdoc-post-item-title';
        title.textContent = post.title;

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

        postList.querySelectorAll('.vdoc-post-item').forEach(el => {
            el.classList.toggle('active', el.dataset.id === id);
        });

        toolbarTitle.textContent = post.title;
        toolbarDate.textContent  = post.date ?? '';
        placeholder.style.display = 'none';

        docEl.querySelectorAll('.vdoc-doc-header, .vdoc-doc-body, .vdoc-loading')
            .forEach(el => el.remove());

        // Loading indicator while fetching .md files
        const loading = document.createElement('div');
        loading.className = 'vdoc-loading';
        loading.style.cssText = 'padding:40px;text-align:center;color:#a0b0c0;font-style:italic;font-size:0.88rem;font-family:Georgia,serif;';
        loading.textContent = 'Loading…';
        docEl.appendChild(loading);

        // Resolve body: inline HTML > fetch .md file > fallback
        let bodyHtml = '';
        if (post.body) {
            bodyHtml = post.body;
        } else if (post.file) {
            try {
                const r = await fetch(post.file);
                if (!r.ok) throw new Error(r.status);
                const md = await r.text();
                bodyHtml = mdToHtml(md);
            } catch (err) {
                bodyHtml = `<p><em>Could not load file: ${post.file}</em></p>`;
            }
        } else {
            bodyHtml = '<p><em>No content.</em></p>';
        }

        loading.remove();

        const header = document.createElement('div');
        header.className = 'vdoc-doc-header';

        const titleEl = document.createElement('h1');
        titleEl.className   = 'vdoc-doc-title';
        titleEl.textContent = post.title;

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
        ownerBtn.title = 'Owner mode active (click to lock)';
    }

    function lockOwner() {
        ownerUnlocked = false;
        ownerBtn.textContent = '🔒';
        ownerBtn.classList.remove('unlocked');
        ownerBtn.title = 'Owner login';
    }

    // Open first post by default
    if (posts.length > 0) openPost(posts[0].id);
}
