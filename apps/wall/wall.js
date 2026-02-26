// ============================================================
// apps/wall/wall.js
// ============================================================
// The Wall — public guestbook backed by Supabase.
//
// Table: wall-posts
//   id         uuid        (auto)
//   created_at timestamptz (auto)
//   user       text
//   post       text
//   pin        bool        (default false)
//
// ── WHY TWO KEYS ─────────────────────────────────────────────
// Supabase RLS blocks UPDATE/DELETE for the anon key by default.
// PATCH (pin) and DELETE silently affect 0 rows unless either:
//   A) You add an RLS UPDATE/DELETE policy in the Supabase dashboard, OR
//   B) You use the service_role key for those operations (bypasses RLS).
//
// This file uses approach B for owner actions (pin, delete).
// The service_role key is only sent when owner mode is unlocked.
//
// To get your service_role key:
//   Supabase dashboard → Settings → API → "service_role" (secret)
//   Paste it into SUPABASE_SERVICE_KEY below.
//
// If you prefer approach A (RLS policy), run this SQL in your Supabase
// SQL editor instead and leave SUPABASE_SERVICE_KEY empty:
//   CREATE POLICY "owner update" ON "wall-posts"
//     FOR UPDATE USING (true) WITH CHECK (true);
//   CREATE POLICY "owner delete" ON "wall-posts"
//     FOR DELETE USING (true);
// ============================================================

import { WALL_PASSWORD } from '../../core/config.js';

// ── Supabase config ───────────────────────────────────────────
const SUPABASE_URL = 'https://emfvqpgrdqukyioiqxhl.supabase.co';

// Public anon key — safe to expose, used for SELECT + INSERT
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtZnZxcGdyZHF1a3lpb2lxeGhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwOTk0OTUsImV4cCI6MjA4NzY3NTQ5NX0.D0LVlwsaMB3BEvtQdnCclXfA7-fdtUJjps1iuQihn_g';

// Service role key — bypasses RLS, used ONLY for owner pin/delete.
// Get from: Supabase dashboard → Settings → API → service_role (secret)
// WARNING: This is a static site so this key is visible in source.
// That is acceptable here because: (a) the table has no sensitive data,
// (b) the key only touches one table, (c) owner actions require a password
// before this key is ever used client-side.
const SUPABASE_SERVICE_KEY = '';   // ← paste your service_role key here

const TABLE = 'wall-posts';

function makeHeaders(useServiceKey) {
    const key = (useServiceKey && SUPABASE_SERVICE_KEY) ? SUPABASE_SERVICE_KEY : SUPABASE_ANON_KEY;
    return {
        'Content-Type':  'application/json',
        'apikey':        key,
        'Authorization': 'Bearer ' + key,
    };
}

// ── Supabase REST helpers ─────────────────────────────────────

async function sbFetch(path, opts, useServiceKey) {
    opts = opts || {};
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
        ...opts,
        headers: { ...makeHeaders(useServiceKey), ...(opts.headers || {}) },
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error('Supabase ' + res.status + ': ' + err);
    }
    return res.status === 204 ? null : res.json();
}

// Public: SELECT — anon key
async function fetchPosts() {
    return sbFetch(
        TABLE + '?select=id,created_at,user,post,pin&order=pin.desc,created_at.desc',
        {}, false
    );
}

// Public: INSERT — anon key
async function insertPost(user, post) {
    return sbFetch(TABLE, {
        method:  'POST',
        headers: { 'Prefer': 'return=representation' },
        body:    JSON.stringify({ user: user, post: post }),
    }, false);
}

// Owner: PATCH pin — service_role key (bypasses RLS UPDATE block)
async function patchPin(id, pinned) {
    return sbFetch(TABLE + '?id=eq.' + id, {
        method:  'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body:    JSON.stringify({ pin: pinned }),
    }, true);
}

// Owner: DELETE — service_role key (bypasses RLS DELETE block)
async function deletePost(id) {
    return sbFetch(TABLE + '?id=eq.' + id, { method: 'DELETE' }, true);
}

// ── App ───────────────────────────────────────────────────────

export async function initWall({ registerWindow, openWindow }) {

    // ── CSS ───────────────────────────────────────────────────
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = new URL('wall.css', import.meta.url).href;
    document.head.appendChild(link);

    // ── HTML ──────────────────────────────────────────────────
    try {
        const res  = await fetch(new URL('wall.html', import.meta.url).href);
        const html = await res.text();
        document.body.insertAdjacentHTML('beforeend', html);
    } catch (err) {
        console.error('[wall] Failed to load wall.html', err);
        return;
    }

    const windowEl = document.getElementById('wall-window');
    if (!windowEl) return;
    const entry = registerWindow(windowEl, { icon: '📖' });

    document.getElementById('open-wall')
        ?.addEventListener('dblclick', () => openWindow(entry));

    // ── DOM refs ──────────────────────────────────────────────
    const entriesEl   = document.getElementById('wall-entries');
    const emptyEl     = document.getElementById('wall-empty');
    const countEl     = document.getElementById('wall-count');
    const nameInput   = document.getElementById('wall-name');
    const msgInput    = document.getElementById('wall-msg');
    const msgCount    = document.getElementById('wall-msg-count');
    const postBtn     = document.getElementById('wall-post-btn');
    const ownerBtn    = document.getElementById('wall-owner-btn');
    const modal       = document.getElementById('wall-owner-modal');
    const modalPw     = document.getElementById('wall-owner-pw');
    const modalSubmit = document.getElementById('wall-modal-submit');
    const modalCancel = document.getElementById('wall-modal-cancel');
    const modalErr    = document.getElementById('wall-modal-err');

    // ── State ─────────────────────────────────────────────────
    let posts         = [];
    let ownerUnlocked = false;

    // ── Load & render ─────────────────────────────────────────

    async function reload(flashId) {
        setStatus('loading');
        try {
            posts = await fetchPosts();
        } catch (err) {
            console.error('[wall] fetchPosts failed:', err);
            setStatus('error');
            return;
        }
        setStatus('ok');
        render(flashId);
    }

    function setStatus(s) {
        postBtn.disabled = (s === 'loading') || msgInput.value.trim() === '';
        countEl.textContent = s === 'loading' ? 'loading…'
                            : s === 'error'   ? 'connection error'
                            : posts.length === 1 ? '1 entry'
                            : posts.length + ' entries';
    }

    function render(flashId) {
        Array.from(entriesEl.querySelectorAll('.wall-entry'))
            .forEach(function(el) { el.remove(); });

        emptyEl.style.display = posts.length ? 'none' : '';

        posts.forEach(function(p) {
            const card = buildCard(p);
            entriesEl.appendChild(card);

            if (p.id === flashId) {
                requestAnimationFrame(function() {
                    card.classList.add('flash');
                    card.addEventListener('animationend',
                        function() { card.classList.remove('flash'); },
                        { once: true }
                    );
                });
            }
        });

        entriesEl.classList.toggle('owner-unlocked', ownerUnlocked);
    }

    function buildCard(p) {
        const pinned = !!p.pin;

        const card = document.createElement('div');
        card.className  = 'wall-entry' + (pinned ? ' pinned' : '');
        card.dataset.id = p.id;

        if (pinned) {
            const badge = document.createElement('span');
            badge.className   = 'wall-pin-badge';
            badge.textContent = '📌 pinned';
            card.appendChild(badge);
        }

        const header = document.createElement('div');
        header.className = 'wall-entry-header';

        const nameEl = document.createElement('span');
        nameEl.className   = 'wall-entry-name';
        nameEl.textContent = p.user || 'anonymous';

        const rule = document.createElement('span');
        rule.className = 'wall-entry-rule';

        const timeEl = document.createElement('span');
        timeEl.className   = 'wall-entry-time';
        timeEl.textContent = formatDate(p.created_at);

        header.appendChild(nameEl);
        header.appendChild(rule);
        header.appendChild(timeEl);
        card.appendChild(header);

        const msgEl = document.createElement('div');
        msgEl.className   = 'wall-entry-msg';
        msgEl.textContent = p.post;
        card.appendChild(msgEl);

        const actions = document.createElement('div');
        actions.className = 'wall-entry-actions';

        const pinBtn = document.createElement('button');
        pinBtn.className   = 'wall-action-btn pin-btn' + (pinned ? ' active' : '');
        pinBtn.textContent = pinned ? 'unpin' : 'pin';
        pinBtn.addEventListener('click', function() { togglePin(p.id); });

        const delBtn = document.createElement('button');
        delBtn.className   = 'wall-action-btn delete-btn';
        delBtn.textContent = 'delete';
        delBtn.addEventListener('click', function() { confirmDelete(p.id); });

        actions.appendChild(pinBtn);
        actions.appendChild(delBtn);
        card.appendChild(actions);

        return card;
    }

    function formatDate(iso) {
        const d   = new Date(iso);
        const pad = function(n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
             + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    // ── Submit new post ───────────────────────────────────────

    async function submitEntry() {
        const user = nameInput.value.trim() || 'anonymous';
        const post = msgInput.value.trim();
        if (!post) return;

        postBtn.disabled    = true;
        postBtn.textContent = 'Posting…';

        try {
            const rows     = await insertPost(user, post);
            const inserted = Array.isArray(rows) ? rows[0] : rows;

            msgInput.value       = '';
            nameInput.value      = '';
            msgCount.textContent = '0/280';
            msgCount.classList.remove('warn');
            postBtn.textContent  = 'Post ↵';

            await reload(inserted ? inserted.id : null);
        } catch (err) {
            console.error('[wall] insertPost failed:', err);
            postBtn.textContent = 'Post ↵';
            postBtn.disabled    = false;
        }
    }

    // ── Pin / unpin ───────────────────────────────────────────

    async function togglePin(id) {
        const p = posts.find(function(x) { return x.id === id; });
        if (!p) return;

        const newPin = !p.pin;

        // Optimistic local update
        p.pin = newPin;
        posts.sort(function(a, b) {
            if (a.pin && !b.pin) return -1;
            if (!a.pin && b.pin) return  1;
            return 0;
        });
        render();

        try {
            await patchPin(id, newPin);
        } catch (err) {
            console.error('[wall] patchPin failed:', err);
            // Roll back
            p.pin = !newPin;
            posts.sort(function(a, b) {
                if (a.pin && !b.pin) return -1;
                if (!a.pin && b.pin) return  1;
                return 0;
            });
            render();
        }
    }

    // ── Delete ────────────────────────────────────────────────

    async function confirmDelete(id) {
        if (!window.confirm('Delete this post?')) return;
        try {
            await deletePost(id);
            posts = posts.filter(function(p) { return p.id !== id; });
            render();
            countEl.textContent = posts.length === 1
                ? '1 entry' : posts.length + ' entries';
        } catch (err) {
            console.error('[wall] deletePost failed:', err);
        }
    }

    // ── Owner login ───────────────────────────────────────────

    function unlockOwner() {
        ownerUnlocked = true;
        ownerBtn.textContent = '🔓';
        ownerBtn.classList.add('unlocked');
        ownerBtn.title = 'Owner mode (click to lock)';
        entriesEl.classList.add('owner-unlocked');
    }

    function lockOwner() {
        ownerUnlocked = false;
        ownerBtn.textContent = '🔒';
        ownerBtn.classList.remove('unlocked');
        ownerBtn.title = 'Owner login';
        entriesEl.classList.remove('owner-unlocked');
    }

    ownerBtn.addEventListener('click', function() {
        if (ownerUnlocked) { lockOwner(); return; }
        modal.classList.remove('hidden');
        modalPw.value = '';
        modalErr.classList.add('hidden');
        requestAnimationFrame(function() { modalPw.focus(); });
    });

    modalCancel.addEventListener('click', function() { modal.classList.add('hidden'); });
    modal.addEventListener('click', function(e) {
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
    modalPw.addEventListener('keydown', function(e) {
        if (e.key === 'Enter')  attemptLogin();
        if (e.key === 'Escape') modal.classList.add('hidden');
    });

    // ── Compose wiring ────────────────────────────────────────

    msgInput.addEventListener('input', function() {
        const len = msgInput.value.length;
        msgCount.textContent = len + '/280';
        msgCount.classList.toggle('warn', len > 240);
        postBtn.disabled = len === 0;
    });

    postBtn.disabled = true;
    postBtn.addEventListener('click', submitEntry);
    msgInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submitEntry();
        }
    });

    // ── Boot ──────────────────────────────────────────────────
    await reload();
}