// ============================================================
// apps/vdoc/vdoc.js — vDoc blog/document viewer
// ============================================================
// Posts live as .md files in the /posts/ folder at repo root.
// config.js holds only the index (id, title, date, file path).
// vDoc fetches each .md on demand and renders it as Markdown.
//
// config.js BLOG_POSTS entry shape:
//   {
//     id:      'hello-world',           // unique slug
//     title:   'Hello World',
//     date:    '2025-01-01',
//     summary: 'One-line preview',      // shown in sidebar
//     file:    'posts/hello-world.md',  // path from site root
//   }
//
// To add a post: create the .md file, add one entry to config.js.
// ============================================================

import { BLOG_POSTS, WALL_PASSWORD } from '../../core/config.js';

export async function initVDoc({ registerWindow, openWindow }) {

    // ── Inject CSS ────────────────────────────────────────────
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = new URL('vdoc.css', import.meta.url).href;
    document.head.appendChild(link);

    // ── Fetch + inject HTML ───────────────────────────────────
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

    // ── Open via file-open event (from Documents folder in Explorer) ──
    // vDoc has no desktop icon. Posts are opened by clicking items
    // in the Documents explorer folder, which dispatches file-open
    // with type:'doc' and id matching a BLOG_POSTS entry id.
    document.addEventListener('file-open', async e => {
        if (e.detail.type !== 'doc') return;
        const id = e.detail.id;
        if (id && posts.find(p => p.id === id)) {
            await openPost(id);
        }
        openWindow(entry);
    });

    // ── DOM refs ──────────────────────────────────────────────
    const postList    = document.getElementById('vdoc-post-list');
    const docEl       = document.getElementById('vdoc-document');
    const placeholder = document.getElementById('vdoc-placeholder');
    const toolbarTitle = document.getElementById('vdoc-doc-title');
    const toolbarDate  = document.getElementById('vdoc-doc-date');
    const ownerBtn    = document.getElementById('vdoc-owner-btn');
    const modal       = document.getElementById('vdoc-owner-modal');
    const modalPw     = document.getElementById('vdoc-owner-pw');
    const modalSubmit = document.getElementById('vdoc-modal-submit');
    const modalCancel = document.getElementById('vdoc-modal-cancel');
    const modalErr    = document.getElementById('vdoc-modal-err');

    // ── State ─────────────────────────────────────────────────
    let activeId      = null;
    let ownerUnlocked = false;
    const cache       = {};   // post id → rendered HTML, avoids re-fetching

    // ── Build sidebar post list ───────────────────────────────

    const posts = Array.isArray(BLOG_POSTS) ? BLOG_POSTS : [];

    if (posts.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:14px;font-size:0.78rem;color:rgba(200,222,255,0.3);font-style:italic;font-family:Georgia,serif;';
        empty.textContent = 'No posts yet.';
        postList.appendChild(empty);
    }

    posts.forEach(post => {
        const item = document.createElement('div');
        item.className   = 'vdoc-post-item';
        item.dataset.id  = post.id;

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

    // ── Markdown renderer ─────────────────────────────────────
    // Self-contained, no dependencies. Handles the common syntax.
    // Extend BLOCK_RULES or inlineFormat() to add new patterns.

    function renderMarkdown(md) {
        const lines = md.replace(/\r\n/g, '\n').split('\n');
        const out   = [];
        let i       = 0;
        let inUL    = false;
        let inOL    = false;

        const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

        function inline(text) {
            return esc(text)
                .replace(/`([^`]+)`/g,       '<code>$1</code>')
                .replace(/\*\*(.+?)\*\*/g,   '<strong>$1</strong>')
                .replace(/\*(.+?)\*/g,        '<em>$1</em>')
                .replace(/~~(.+?)~~/g,        '<del>$1</del>')
                // Images before links — ![alt](src) or ![alt](src "caption")
                .replace(/!\[([^\]]*)\]\(([^)"]+?)(?:\s+"([^"]*)")?\)/g,
                         (_, alt, src, cap) =>
                             '<figure class="vdoc-figure">' +
                             '<img src="' + src + '" alt="' + alt + '" class="vdoc-img" loading="lazy">' +
                             (cap || alt ? '<figcaption>' + (cap || alt) + '</figcaption>' : '') +
                             '</figure>')
                // Links
                .replace(/\[([^\]]+)\]\(([^)]+)\)/g,
                         '<a href="$2" target="_blank" rel="noopener">$1</a>');
        }

        function flushLists() {
            if (inUL) { out.push('</ul>'); inUL = false; }
            if (inOL) { out.push('</ol>'); inOL = false; }
        }

        while (i < lines.length) {
            const line = lines[i];

            // Fenced code block
            if (line.trimStart().startsWith('```')) {
                flushLists();
                const lang  = line.trim().slice(3).trim();
                const block = [];
                i++;
                while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
                    block.push(esc(lines[i]));
                    i++;
                }
                out.push(`<pre class="vdoc-code-block"${lang ? ` data-lang="${lang}"`:''}>` +
                         `<code>${block.join('\n')}</code></pre>`);
                i++; continue;
            }

            // Horizontal rule
            if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
                flushLists(); out.push('<hr>'); i++; continue;
            }

            // Heading  # ## ### ####
            const hm = line.match(/^(#{1,4})\s+(.+)/);
            if (hm) {
                flushLists();
                const lv = Math.min(hm[1].length + 1, 4); // h1 reserved for doc title
                out.push(`<h${lv}>${inline(hm[2])}</h${lv}>`);
                i++; continue;
            }

            // Blockquote
            if (line.startsWith('> ')) {
                flushLists();
                out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
                i++; continue;
            }

            // Unordered list
            const ulm = line.match(/^[-*+]\s+(.+)/);
            if (ulm) {
                if (!inUL) { if (inOL) { out.push('</ol>'); inOL = false; } out.push('<ul>'); inUL = true; }
                out.push(`<li>${inline(ulm[1])}</li>`);
                i++; continue;
            }

            // Ordered list
            const olm = line.match(/^\d+\.\s+(.+)/);
            if (olm) {
                if (!inOL) { if (inUL) { out.push('</ul>'); inUL = false; } out.push('<ol>'); inOL = true; }
                out.push(`<li>${inline(olm[1])}</li>`);
                i++; continue;
            }

            // Blank line
            if (line.trim() === '') { flushLists(); i++; continue; }

            // Standalone image line — render as block figure, not inline paragraph
            if (/^!\[/.test(line)) {
                flushLists();
                out.push('<div class="vdoc-figure-wrap">' + inline(line) + '</div>');
                i++; continue;
            }

            // Paragraph — consume until blank or block-level line
            flushLists();
            const para = [];
            while (
                i < lines.length &&
                lines[i].trim() !== '' &&
                !lines[i].match(/^(#{1,4}\s|>|[-*+]\s|\d+\.\s|```|(\*{3,}|-{3,}|_{3,})\s*$)/)
            ) { para.push(inline(lines[i])); i++; }
            if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
        }

        flushLists();
        return out.join('\n');
    }

    // ── Open post ─────────────────────────────────────────────

    async function openPost(id) {
        const post = posts.find(p => p.id === id);
        if (!post) return;

        activeId = id;

        // Sidebar active state
        postList.querySelectorAll('.vdoc-post-item')
            .forEach(el => el.classList.toggle('active', el.dataset.id === id));

        // Toolbar
        toolbarTitle.textContent = post.title;
        toolbarDate.textContent  = post.date ?? '';

        // Clear previous content, show loading spinner
        placeholder.style.display = 'none';
        docEl.querySelectorAll('.vdoc-doc-header, .vdoc-doc-body, .vdoc-loading')
            .forEach(el => el.remove());

        const spinner = document.createElement('div');
        spinner.className = 'vdoc-loading vdoc-placeholder';
        spinner.innerHTML = '<span>⏳</span><span>Loading…</span>';
        docEl.appendChild(spinner);
        docEl.parentElement.scrollTop = 0;

        // Fetch markdown (cached after first load)
        let bodyHtml;
        if (cache[id] !== undefined) {
            bodyHtml = cache[id];
        } else if (post.file) {
            try {
                const url = new URL(post.file, location.href).href;
                const res = await fetch(url);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                bodyHtml = renderMarkdown(await res.text());
            } catch (err) {
                console.error('[vdoc] Failed to fetch', post.file, err);
                bodyHtml = '<p><em>Could not load <code>' + post.file + '</code>.</em></p>'
                         + '<p>Make sure the file exists at that path in your repo.</p>';
            }
            cache[id] = bodyHtml;
        } else if (post.body) {
            // Legacy: inline HTML body in config.js still works
            bodyHtml  = post.body;
            cache[id] = bodyHtml;
        } else {
            bodyHtml = '<p><em>No content.</em></p>';
        }

        spinner.remove();

        // Render header + body
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

    modal.addEventListener('click', e => {
        if (e.target === modal) modal.classList.add('hidden');
    });

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
        // TODO: show "New Post" / "Edit Post" controls
    }

    function lockOwner() {
        ownerUnlocked = false;
        ownerBtn.textContent = '🔒';
        ownerBtn.classList.remove('unlocked');
        ownerBtn.title = 'Owner login';
    }

    // vDoc opens only when the user clicks a doc item in Explorer.
    // No auto-open on init — the window starts hidden.
}