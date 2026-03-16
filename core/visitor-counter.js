// ============================================================
// core/visitor-counter.js  —  Win98-style visitor counter gadget
// ============================================================
// A fixed floating widget in the bottom-right of the desktop.
// Classic Windows 98 grey chrome: raised bevels, sunken LED
// display, pixel marquee text, the whole deal.
// Draggable by the title bar. Position saved to sessionStorage.
//
// ── Supabase setup (run once in SQL Editor) ────────────────
//
//   CREATE TABLE visitor_count (
//     id    INTEGER PRIMARY KEY DEFAULT 1,
//     count BIGINT  NOT NULL DEFAULT 0,
//     CHECK (id = 1)
//   );
//   INSERT INTO visitor_count (id, count) VALUES (1, 0)
//   ON CONFLICT DO NOTHING;
//
//   CREATE OR REPLACE FUNCTION increment_visitor()
//   RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
//     UPDATE visitor_count SET count = count + 1 WHERE id = 1
//     RETURNING count;
//   $$;
//
//   ALTER TABLE visitor_count ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "anon read" ON visitor_count
//     FOR SELECT TO anon USING (true);
//   GRANT EXECUTE ON FUNCTION increment_visitor() TO anon;
//
// ── File placement ────────────────────────────────────────
//   core/visitor-counter.js   ← this file
// ============================================================

const SB_URL      = 'https://emfvqpgrdqukyioiqxhl.supabase.co';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtZnZxcGdyZHF1a3lpb2lxeGhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwOTk0OTUsImV4cCI6MjA4NzY3NTQ5NX0.D0LVlwsaMB3BEvtQdnCclXfA7-fdtUJjps1iuQihn_g';
const SESSION_KEY = 'vskid_counted';
const POS_KEY     = 'vskid_counter_pos';

async function incrementAndGet() {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/increment_visitor`, {
        method: 'POST',
        headers: {
            'Content-Type':  'application/json',
            'apikey':        SB_ANON_KEY,
            'Authorization': 'Bearer ' + SB_ANON_KEY,
        },
        body: '{}',
    });
    if (!res.ok) throw new Error('rpc ' + res.status);
    return res.json();
}

async function getCount() {
    const res = await fetch(`${SB_URL}/rest/v1/visitor_count?select=count&id=eq.1`, {
        headers: {
            'apikey':        SB_ANON_KEY,
            'Authorization': 'Bearer ' + SB_ANON_KEY,
        },
    });
    if (!res.ok) throw new Error('read ' + res.status);
    const rows = await res.json();
    return rows?.[0]?.count ?? null;
}

// ── Aqua CSS ───────────────────────────────────────────────
const CSS = `
#vcounter-win {
    position: fixed;
    bottom: 100px;
    right: 14px;
    width: 210px;
    z-index: 90;
    background: linear-gradient(180deg, rgba(232,242,255,0.97) 0%, rgba(218,234,252,0.97) 100%);
    backdrop-filter: blur(18px) saturate(160%);
    -webkit-backdrop-filter: blur(18px) saturate(160%);
    font-family: -apple-system, 'Lucida Grande', Helvetica, sans-serif;
    font-size: 12px;
    color: #1a2e55;
    border-radius: 10px;
    border: 1px solid rgba(130,170,230,0.50);
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.88),
        0 0 0 1px rgba(60,90,150,0.18),
        0 12px 36px rgba(0,30,120,0.28),
        0 3px 8px rgba(0,0,0,0.16);
    user-select: none;
    overflow: hidden;
}

/* Title bar — Aqua gradient */
#vcounter-titlebar {
    height: 28px;
    background: linear-gradient(180deg,
        #e8f2fc 0%,
        #c8e0f5 38%,
        #aacde8 62%,
        #cce2f6 100%);
    border-bottom: 1px solid rgba(80,130,180,0.40);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.88);
    display: flex;
    align-items: center;
    padding: 0 8px;
    gap: 7px;
    cursor: default;
}
#vcounter-titlebar.inactive {
    background: linear-gradient(180deg, #e0e8f0 0%, #ccd8e8 100%);
    filter: saturate(0.4);
}

/* Traffic light close button */
#vcounter-close {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: radial-gradient(circle at 38% 32%, #ff8a80, #ff5f57 62%, #c0392b);
    border: 1px solid #c0392b;
    box-shadow: inset 0 1px 2px rgba(255,255,255,0.55), 0 1px 2px rgba(0,0,0,0.25);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0;
    cursor: pointer;
    flex-shrink: 0;
    transition: filter 0.1s;
}
#vcounter-close:hover { filter: brightness(1.15); font-size: 8px; color: rgba(80,0,0,0.7); }

#vcounter-title-text {
    color: #18284a;
    font-size: 0.78rem;
    font-weight: 700;
    text-shadow: 0 1px 0 rgba(255,255,255,0.80);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 4px;
}

/* Body */
#vcounter-body {
    padding: 8px 8px 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
}

/* Marquee strip */
#vcounter-marquee-wrap {
    width: 100%;
    overflow: hidden;
    background: rgba(255,255,255,0.70);
    border: 1px solid rgba(130,170,230,0.40);
    border-radius: 4px;
    height: 18px;
    display: flex;
    align-items: center;
}
#vcounter-marquee {
    display: inline-block;
    white-space: nowrap;
    font-family: -apple-system, 'Lucida Grande', sans-serif;
    font-size: 10px;
    color: #1a4aaa;
    font-weight: 600;
    padding-left: 100%;
    animation: vc-scroll 12s linear infinite;
}
@keyframes vc-scroll {
    0%   { transform: translateX(0); }
    100% { transform: translateX(-200%); }
}

/* LED counter panel */
#vcounter-screen-frame {
    width: 100%;
    background: #0a1020;
    border: 1px solid rgba(60,90,150,0.50);
    border-radius: 6px;
    box-shadow: inset 0 2px 6px rgba(0,0,0,0.50);
    padding: 5px 6px 6px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
}

#vcounter-screen-label {
    font-family: 'VT323', 'Courier New', monospace;
    font-size: 11px;
    color: #00aa44;
    letter-spacing: 0.12em;
    text-shadow: 0 0 4px rgba(0,200,80,0.5);
    text-transform: uppercase;
    align-self: flex-start;
}

#vcounter-digits-row {
    display: flex;
    align-items: center;
    gap: 0;
}

.vc98-digit {
    font-family: 'VT323', 'Courier New', monospace;
    font-size: 28px;
    font-weight: normal;
    color: #00ff66;
    text-shadow:
        0 0 4px rgba(0,255,100,0.9),
        0 0 10px rgba(0,255,100,0.5),
        0 0 18px rgba(0,200,80,0.3);
    background: transparent;
    width: 18px;
    text-align: center;
    line-height: 1;
    display: inline-block;
}

.vc98-digit-wrap {
    position: relative;
    width: 18px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.vc98-ghost {
    position: absolute;
    font-family: 'VT323', 'Courier New', monospace;
    font-size: 28px;
    color: rgba(0,100,40,0.25);
    line-height: 1;
    user-select: none;
    pointer-events: none;
}

.vc98-sep {
    font-family: 'VT323', monospace;
    font-size: 24px;
    color: rgba(0,255,100,0.45);
    line-height: 1;
    width: 8px;
    text-align: center;
    align-self: flex-end;
    padding-bottom: 3px;
}

.vc-loading .vc98-digit {
    color: rgba(0,150,50,0.3);
    text-shadow: none;
    animation: vc98-pulse 1s ease-in-out infinite;
}
@keyframes vc98-pulse {
    0%,100% { opacity: 0.25; }
    50%      { opacity: 0.7;  }
}

@keyframes vc98-drop {
    0%   { opacity:0; transform:translateY(-8px); }
    60%  { transform:translateY(2px); }
    100% { opacity:1; transform:translateY(0); }
}
.vc-ready .vc98-digit {
    animation: vc98-drop 0.4s cubic-bezier(0.2,0.8,0.2,1) both;
}
.vc-ready .vc98-digit-wrap:nth-child(1) .vc98-digit { animation-delay: 0.00s; }
.vc-ready .vc98-digit-wrap:nth-child(2) .vc98-digit { animation-delay: 0.05s; }
.vc-ready .vc98-digit-wrap:nth-child(3) .vc98-digit { animation-delay: 0.10s; }
.vc-ready .vc98-digit-wrap:nth-child(4) .vc98-digit { animation-delay: 0.15s; }
.vc-ready .vc98-digit-wrap:nth-child(5) .vc98-digit { animation-delay: 0.20s; }
.vc-ready .vc98-digit-wrap:nth-child(6) .vc98-digit { animation-delay: 0.25s; }
.vc-ready .vc98-digit-wrap:nth-child(7) .vc98-digit { animation-delay: 0.30s; }
.vc-ready .vc98-digit-wrap:nth-child(8) .vc98-digit { animation-delay: 0.35s; }

/* "You are visitor #N" badge */
#vcounter-badge {
    width: 100%;
    background: linear-gradient(180deg, rgba(52,120,246,0.88) 0%, rgba(30,90,220,0.88) 100%);
    color: #ffffff;
    font-family: -apple-system, 'Lucida Grande', sans-serif;
    font-size: 10px;
    font-weight: 700;
    text-align: center;
    padding: 4px 6px;
    border-radius: 4px;
    border: 1px solid rgba(30,80,200,0.55);
    display: none;
    animation: vc-fadein 0.8s ease 0.6s both;
}
@keyframes vc-fadein {
    from { opacity:0; }
    to   { opacity:1; }
}
`;

// ── Build digit display ─────────────────────────────────────
function buildDigits(count) {
    const s = String(Math.max(0, count));
    const parts = [];
    s.split('').forEach((d, i) => {
        const fromRight = s.length - 1 - i;
        parts.push(`<span class="vc98-digit-wrap"><span class="vc98-ghost">8</span><span class="vc98-digit">${d}</span></span>`);
        if (fromRight > 0 && fromRight % 3 === 0) {
            parts.push(`<span class="vc98-sep">,</span>`);
        }
    });
    return parts.join('');
}

// ── Drag (by titlebar) ──────────────────────────────────────
function makeDraggable98(el, handle) {
    let drag = false, ox = 0, oy = 0;
    handle.addEventListener('mousedown', e => {
        drag = true;
        const r = el.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        document.getElementById('vcounter-titlebar')?.classList.remove('inactive');
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!drag) return;
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = el.offsetWidth, h = el.offsetHeight;
        let nx = Math.max(0, Math.min(vw - w, e.clientX - ox));
        let ny = Math.max(0, Math.min(vh - h - 50, e.clientY - oy));
        el.style.left = nx + 'px'; el.style.right  = 'auto';
        el.style.top  = ny + 'px'; el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
        if (!drag) return;
        drag = false;
        try {
            sessionStorage.setItem(POS_KEY, JSON.stringify({
                left: el.style.left, top: el.style.top
            }));
        } catch(_) {}
    });
}

// ── Init ───────────────────────────────────────────────────
export async function initVisitorCounter() {
    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    const win = document.createElement('div');
    win.id = 'vcounter-win';
    win.innerHTML = `
        <div id="vcounter-titlebar">
            <span id="vcounter-title-text">🌐 Visitor Counter</span>
            <button id="vcounter-close" title="Close">✕</button>
        </div>
        <div id="vcounter-body">
            <div id="vcounter-marquee-wrap">
                <span id="vcounter-marquee">★ WELCOME TO VSKID'S HOMEPAGE ★ THANKS FOR VISITING! ★ </span>
            </div>
            <div id="vcounter-screen-frame">
                <div id="vcounter-screen-label">visitors</div>
                <div id="vcounter-digits-row" class="vc-loading">${buildDigits(0)}</div>
            </div>
            <div id="vcounter-badge"></div>
        </div>
    `;
    document.body.appendChild(win);

    // Close button hides the widget (show if reloaded — it'll re-init)
    document.getElementById('vcounter-close').addEventListener('click', () => {
        win.style.display = 'none';
    });

    // Restore saved position
    try {
        const saved = JSON.parse(sessionStorage.getItem(POS_KEY) || 'null');
        if (saved?.left) {
            win.style.left   = saved.left; win.style.right  = 'auto';
            win.style.top    = saved.top;  win.style.bottom = 'auto';
        }
    } catch(_) {}

    makeDraggable98(win, document.getElementById('vcounter-titlebar'));

    const digitsRow = document.getElementById('vcounter-digits-row');
    const badge     = document.getElementById('vcounter-badge');

    function showCount(count, isNew) {
        digitsRow.classList.remove('vc-loading', 'vc-ready');
        digitsRow.innerHTML = buildDigits(count);
        void digitsRow.offsetWidth;
        digitsRow.classList.add('vc-ready');

        if (isNew) {
            badge.style.display = 'block';
            badge.textContent   = `★  You are visitor #${Number(count).toLocaleString('en-US')}  ★`;
            // Scroll the marquee faster with their number
            const marquee = document.getElementById('vcounter-marquee');
            if (marquee) {
                marquee.textContent =
                    `★ YOU ARE VISITOR #${Number(count).toLocaleString('en-US')} ★ WELCOME TO VSKID'S HOMEPAGE! ★ `;
            }
        }
    }

    try {
        const alreadyCounted = sessionStorage.getItem(SESSION_KEY);
        if (alreadyCounted) {
            const count = await getCount();
            if (count !== null) showCount(count, false);
        } else {
            const newCount = await incrementAndGet();
            if (newCount !== null) {
                sessionStorage.setItem(SESSION_KEY, '1');
                showCount(newCount, true);
            }
        }
    } catch (err) {
        console.warn('[visitor-counter]', err.message);
        digitsRow.classList.remove('vc-loading');
        digitsRow.innerHTML = buildDigits(0);
    }
}
