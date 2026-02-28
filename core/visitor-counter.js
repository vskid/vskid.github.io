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

// ── Win98 CSS ──────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');

/* Win98 bevel helpers */
.w98-raised {
    border-top:    2px solid #ffffff;
    border-left:   2px solid #ffffff;
    border-right:  2px solid #808080;
    border-bottom: 2px solid #808080;
    box-shadow: 1px 1px 0 #000 inset, -1px -1px 0 #dfdfdf inset;
}
.w98-sunken {
    border-top:    2px solid #808080;
    border-left:   2px solid #808080;
    border-right:  2px solid #ffffff;
    border-bottom: 2px solid #ffffff;
    box-shadow: -1px -1px 0 #dfdfdf inset, 1px 1px 0 #000 inset;
}

#vcounter-win {
    position: fixed;
    bottom: 62px;
    right: 14px;
    width: 210px;
    z-index: 90;
    background: #d4d0c8;
    font-family: 'MS Sans Serif', 'Tahoma', 'Arial', sans-serif;
    font-size: 11px;
    color: #000;
    border-top:    2px solid #ffffff;
    border-left:   2px solid #ffffff;
    border-right:  2px solid #404040;
    border-bottom: 2px solid #404040;
    box-shadow:    1px 1px 0 #808080;
    user-select:   none;
}

/* Title bar — exact Win98 gradient */
#vcounter-titlebar {
    height: 18px;
    background: linear-gradient(to right, #000080 0%, #1084d0 100%);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 2px 0 4px;
    cursor: default;
}
#vcounter-titlebar.inactive {
    background: linear-gradient(to right, #808080 0%, #b0b0b0 100%);
}
#vcounter-title-text {
    color: white;
    font-size: 11px;
    font-weight: bold;
    font-family: 'MS Sans Serif', 'Tahoma', sans-serif;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-shadow: none;
    display: flex;
    align-items: center;
    gap: 3px;
}
#vcounter-close {
    width: 14px;
    height: 14px;
    background: #d4d0c8;
    border-top:    1px solid #ffffff;
    border-left:   1px solid #ffffff;
    border-right:  1px solid #404040;
    border-bottom: 1px solid #404040;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: bold;
    color: #000;
    cursor: pointer;
    flex-shrink: 0;
    font-family: 'Marlett', 'Arial', sans-serif;
    line-height: 1;
}
#vcounter-close:active {
    border-top:    1px solid #404040;
    border-left:   1px solid #404040;
    border-right:  1px solid #ffffff;
    border-bottom: 1px solid #ffffff;
}

/* Body */
#vcounter-body {
    padding: 8px 8px 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
}

/* "You are visitor number" text */
#vcounter-marquee-wrap {
    width: 100%;
    overflow: hidden;
    background: #fff;
    border-top:    1px solid #808080;
    border-left:   1px solid #808080;
    border-right:  1px solid #ffffff;
    border-bottom: 1px solid #ffffff;
    height: 18px;
    display: flex;
    align-items: center;
}
#vcounter-marquee {
    display: inline-block;
    white-space: nowrap;
    font-family: 'MS Sans Serif', 'Tahoma', sans-serif;
    font-size: 10px;
    color: #000080;
    font-weight: bold;
    padding-left: 100%;
    animation: vc-scroll 12s linear infinite;
}
@keyframes vc-scroll {
    0%   { transform: translateX(0); }
    100% { transform: translateX(-200%); }
}

/* LED counter panel — sunken frame */
#vcounter-screen-frame {
    width: 100%;
    background: #000;
    border-top:    2px solid #404040;
    border-left:   2px solid #404040;
    border-right:  2px solid #dfdfdf;
    border-bottom: 2px solid #dfdfdf;
    box-shadow:    -1px -1px 0 #808080 inset;
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

/* Individual 7-seg-style digit cell */
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

/* Ghost digit (dim 8 behind real digit) */
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

/* Loading — pulse all digits */
.vc-loading .vc98-digit {
    color: rgba(0,150,50,0.3);
    text-shadow: none;
    animation: vc98-pulse 1s ease-in-out infinite;
}
@keyframes vc98-pulse {
    0%,100% { opacity: 0.25; }
    50%      { opacity: 0.7;  }
}

/* Reveal animation */
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

/* "You are visitor #N" badge — shown on first visit */
#vcounter-badge {
    width: 100%;
    background: #000080;
    color: #ffffff;
    font-family: 'MS Sans Serif', 'Tahoma', sans-serif;
    font-size: 10px;
    font-weight: bold;
    text-align: center;
    padding: 3px 4px;
    border-top:    1px solid #6060c0;
    border-bottom: 1px solid #000040;
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
