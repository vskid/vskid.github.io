// ============================================================
// apps/wall/wall.js
// ============================================================
// The Wall — public guestbook.
//
// Storage: window.storage (persistent cross-session key-value).
//   'wall:entries'  → JSON array of entry objects
//
// Entry shape:
//   { id, name, message, timestamp, pinned }
//
// Owner mode: hardcoded password from config.js (WALL_PASSWORD).
//   When unlocked, pin/delete buttons appear on each entry.
//   Owner state is session-only (never persisted).
//
// All mutations go through saveEntries() which writes back to
// window.storage and re-renders the list.
// ============================================================

import { WALL_PASSWORD } from '../../core/config.js';

const STORAGE_KEY = 'wall:entries';

export async function initWall({ registerWindow, openWindow }) {

    // ── Inject CSS ───────────────────────────────────────────
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = new URL('wall.css', import.meta.url).href;
    document.head.appendChild(link);

    // ── Fetch + inject HTML ──────────────────────────────────
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

    // ── Wire desktop icon ────────────────────────────────────
    const iconEl = document.getElementById('open-wall');
    iconEl?.addEventListener('dblclick', () => openWindow(entry));

    // ── DOM refs ─────────────────────────────────────────────
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
    let entries      = [];   // array of entry objects, loaded from storage
    let ownerUnlocked = false;

    // ── Storage helpers ───────────────────────────────────────

    async function loadEntries() {
        try {
            const result = await window.storage.get(STORAGE_KEY);
            entries = result ? JSON.parse(result.value) : [];
        } catch {
            entries = [];
        }
    }

    async function saveEntries() {
        try {
            await window.storage.set(STORAGE_KEY, JSON.stringify(entries));
        } catch (err) {
            console.error('[wall] Failed to save entries', err);
        }
        renderEntries();
    }

    // ── Render ────────────────────────────────────────────────

    function renderEntries() {
        // Remove all existing entry cards (keep the empty state element)
        Array.from(entriesEl.querySelectorAll('.wall-entry')).forEach(el => el.remove());

        // Sort: pinned first, then by timestamp descending (newest on top)
        const sorted = [...entries].sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return b.timestamp - a.timestamp;
        });

        emptyEl.style.display = sorted.length ? 'none' : '';
        countEl.textContent   = sorted.length === 1
            ? '1 entry' : `${sorted.length} entries`;

        sorted.forEach(e => {
            const card = buildCard(e);
            entriesEl.appendChild(card);
        });

        // Apply owner class so CSS shows action buttons
        entriesEl.classList.toggle('owner-unlocked', ownerUnlocked);
    }

    function buildCard(e) {
        const card = document.createElement('div');
        card.className  = 'wall-entry' + (e.pinned ? ' pinned' : '');
        card.dataset.id = e.id;

        // Pin badge
        if (e.pinned) {
            const badge = document.createElement('span');
            badge.className   = 'wall-pin-badge';
            badge.textContent = '📌 pinned';
            card.appendChild(badge);
        }

        // Header: name ── rule ── timestamp
        const header = document.createElement('div');
        header.className = 'wall-entry-header';

        const name = document.createElement('span');
        name.className   = 'wall-entry-name';
        name.textContent = e.name || 'anonymous';

        const rule = document.createElement('span');
        rule.className = 'wall-entry-rule';

        const time = document.createElement('span');
        time.className   = 'wall-entry-time';
        time.textContent = formatDate(e.timestamp);

        header.appendChild(name);
        header.appendChild(rule);
        header.appendChild(time);
        card.appendChild(header);

        // Message
        const msg = document.createElement('div');
        msg.className   = 'wall-entry-msg';
        msg.textContent = e.message;
        card.appendChild(msg);

        // Owner action buttons
        const actions = document.createElement('div');
        actions.className = 'wall-entry-actions';

        const pinBtn = document.createElement('button');
        pinBtn.className   = 'wall-action-btn pin-btn' + (e.pinned ? ' active' : '');
        pinBtn.textContent = e.pinned ? 'unpin' : 'pin';
        pinBtn.addEventListener('click', () => togglePin(e.id));

        const delBtn = document.createElement('button');
        delBtn.className   = 'wall-action-btn delete-btn';
        delBtn.textContent = 'delete';
        delBtn.addEventListener('click', () => deleteEntry(e.id));

        actions.appendChild(pinBtn);
        actions.appendChild(delBtn);
        card.appendChild(actions);

        return card;
    }

    function formatDate(ts) {
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} `
             + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    // ── Post new entry ────────────────────────────────────────

    function submitEntry() {
        const name    = nameInput.value.trim() || 'anonymous';
        const message = msgInput.value.trim();
        if (!message) return;

        const newEntry = {
            id:        crypto.randomUUID(),
            name,
            message,
            timestamp: Date.now(),
            pinned:    false,
        };

        entries.unshift(newEntry);
        saveEntries();

        // Flash the new card
        requestAnimationFrame(() => {
            const card = entriesEl.querySelector(`[data-id="${newEntry.id}"]`);
            if (card) {
                card.classList.add('flash');
                card.addEventListener('animationend', () => card.classList.remove('flash'), { once: true });
            }
        });

        // Clear compose fields
        msgInput.value    = '';
        nameInput.value   = '';
        msgCount.textContent = '0/280';
        msgCount.classList.remove('warn');
        postBtn.disabled  = true;
    }

    // ── Owner actions ─────────────────────────────────────────

    function togglePin(id) {
        const e = entries.find(e => e.id === id);
        if (e) { e.pinned = !e.pinned; saveEntries(); }
    }

    function deleteEntry(id) {
        entries = entries.filter(e => e.id !== id);
        saveEntries();
    }

    // ── Owner login ───────────────────────────────────────────

    function unlockOwner() {
        ownerUnlocked   = true;
        ownerBtn.textContent = '🔓';
        ownerBtn.classList.add('unlocked');
        ownerBtn.title  = 'Owner mode active (click to lock)';
        entriesEl.classList.add('owner-unlocked');
    }

    function lockOwner() {
        ownerUnlocked   = false;
        ownerBtn.textContent = '🔒';
        ownerBtn.classList.remove('unlocked');
        ownerBtn.title  = 'Owner login';
        entriesEl.classList.remove('owner-unlocked');
    }

    ownerBtn.addEventListener('click', () => {
        if (ownerUnlocked) { lockOwner(); return; }
        modal.classList.remove('hidden');
        modalPw.value = '';
        modalErr.classList.add('hidden');
        requestAnimationFrame(() => modalPw.focus());
    });

    modalCancel.addEventListener('click', () => {
        modal.classList.add('hidden');
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
        if (e.key === 'Enter') attemptLogin();
        if (e.key === 'Escape') modal.classList.add('hidden');
    });

    // Click outside modal box closes it
    modal.addEventListener('click', e => {
        if (e.target === modal) modal.classList.add('hidden');
    });

    // ── Compose field wiring ──────────────────────────────────

    msgInput.addEventListener('input', () => {
        const len = msgInput.value.length;
        msgCount.textContent = `${len}/280`;
        msgCount.classList.toggle('warn', len > 240);
        postBtn.disabled = len === 0;
    });

    postBtn.disabled = true;

    postBtn.addEventListener('click', submitEntry);

    // Ctrl+Enter or Cmd+Enter posts
    msgInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submitEntry();
        }
    });

    // ── Boot ──────────────────────────────────────────────────

    await loadEntries();
    renderEntries();
}