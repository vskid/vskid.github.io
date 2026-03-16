// ============================================================
// apps/vclock/vclock.js
// ============================================================
// World clock — travel showcase.
// Two display modes:
//   • Green LCD (Casio-style): pale panel, dark segments
//   • Analog: realistic desk clock face (cream dial, proper hands)
//
// TO ADD A CITY: edit CITIES in core/config.js
// ============================================================

import { CITIES } from '../../core/config.js';

// ── 7-Segment definitions ──────────────────────────────────
// [top, top-right, bot-right, bottom, bot-left, top-left, middle]
const SEG_MAP = {
    '0': [1,1,1,1,1,1,0],
    '1': [0,1,1,0,0,0,0],
    '2': [1,1,0,1,1,0,1],
    '3': [1,1,1,1,0,0,1],
    '4': [0,1,1,0,0,1,1],
    '5': [1,0,1,1,0,1,1],
    '6': [1,0,1,1,1,1,1],
    '7': [1,1,1,0,0,0,0],
    '8': [1,1,1,1,1,1,1],
    '9': [1,1,1,1,0,1,1],
};

// ── Draw a single 7-segment digit ─────────────────────────
// Uses filled trapezoid segments like a real LCD display.
// ON = dark charcoal (visible segment), OFF = light (ghost)
function drawDigit(ctx, ch, x, y, w, h, onCol, offCol) {
    var segs = SEG_MAP[ch] || [0,0,0,0,0,0,0];
    var t = Math.max(2, Math.round(h * 0.11)); // thickness scales with height
    var g = 1;  // inter-segment gap

    function hSeg(on, sx, sy, sw) {
        // Horizontal segment — diamond/parallelogram cut ends
        ctx.beginPath();
        ctx.moveTo(sx + t,      sy);
        ctx.lineTo(sx + sw - t, sy);
        ctx.lineTo(sx + sw - t + t*0.4, sy + t/2);
        ctx.lineTo(sx + sw - t, sy + t);
        ctx.lineTo(sx + t,      sy + t);
        ctx.lineTo(sx + t - t*0.4, sy + t/2);
        ctx.closePath();
        ctx.fillStyle = on ? onCol : offCol;
        ctx.fill();
    }

    function vSeg(on, sx, sy, sh) {
        // Vertical segment — cut top + bottom ends
        ctx.beginPath();
        ctx.moveTo(sx,     sy + t);
        ctx.lineTo(sx + t, sy + t*0.6);
        ctx.lineTo(sx + t, sy + sh - t*0.6);
        ctx.lineTo(sx,     sy + sh - t);
        ctx.closePath();
        ctx.fillStyle = on ? onCol : offCol;
        ctx.fill();
    }

    var mid = Math.floor(h / 2);

    // a — top
    hSeg(segs[0], x,         y,              w);
    // b — top-right
    vSeg(segs[1], x + w - t, y + g,          mid - g);
    // c — bot-right
    vSeg(segs[2], x + w - t, y + mid + g,    mid - g*2);
    // d — bottom
    hSeg(segs[3], x,         y + h - t,      w);
    // e — bot-left
    vSeg(segs[4], x,         y + mid + g,    mid - g*2);
    // f — top-left
    vSeg(segs[5], x,         y + g,          mid - g);
    // g — middle
    hSeg(segs[6], x,         y + mid - Math.floor(t/2), w);
}

// ── Draw the full LCD panel (HH:MM) ───────────────────────
// Green-yellow LCD look: dark segments on pale panel.
// Canvas is 130×56px, rendered at native size (no CSS scaling).
// Layout: [H1][H2] [:] [M1][M2] with proper 1:2 digit aspect ratio.
function drawDigitalClock(canvas, hours, minutes) {
    var W   = canvas.width;   // 130
    var H   = canvas.height;  // 56
    var ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, W, H);

    var ON  = '#1a2200';   // dark green-black (active segment)
    var OFF = '#b8c87a';   // matches panel bg (ghost/off segment)

    // Real 7-seg digit aspect is ~1:2 (width:height).
    // Allocate: 4 digits + 1 colon gap. Padding each side.
    var pad    = 5;
    var colonW = 8;                                     // colon zone width
    var dgap   = 2;                                     // gap between digits
    var avail  = W - pad*2 - colonW - dgap*3;           // px for 4 digits
    var dw     = Math.floor(avail / 4);                 // digit width
    var dh     = H - pad*2;                             // digit height (~46px)
    var y      = pad;

    // Center the whole layout
    var totalW = dw*4 + colonW + dgap*3;
    var x0     = Math.floor((W - totalW) / 2);

    var h1 = String(Math.floor(hours / 10));
    var h2 = String(hours % 10);
    var m1 = String(Math.floor(minutes / 10));
    var m2 = String(minutes % 10);

    drawDigit(ctx, h1, x0,                  y, dw, dh, ON, OFF);
    drawDigit(ctx, h2, x0 + dw + dgap,      y, dw, dh, ON, OFF);

    // Colon dots — vertically centered, horizontally in the gap
    var cx    = x0 + dw*2 + dgap*2 + Math.floor(colonW/2) - 1;
    var blink = (Math.floor(Date.now() / 500) % 2 === 0);
    var dotSz = Math.max(2, Math.round(dh * 0.09));
    ctx.fillStyle = blink ? ON : OFF;
    ctx.fillRect(cx, y + Math.round(dh * 0.27), dotSz, dotSz);
    ctx.fillRect(cx, y + Math.round(dh * 0.63), dotSz, dotSz);

    var mx = x0 + dw*2 + dgap*2 + colonW;
    drawDigit(ctx, m1, mx,              y, dw, dh, ON, OFF);
    drawDigit(ctx, m2, mx + dw + dgap, y, dw, dh, ON, OFF);
}

// ── Draw a realistic analog clock face ────────────────────
// Cream/off-white dial, applied brass indices, proper hands.
function drawAnalogClock(canvas, hours, minutes, seconds) {
    var W   = canvas.width;
    var H   = canvas.height;
    var cx  = W / 2;
    var cy  = H / 2;
    var r   = Math.min(W, H) / 2 - 1;
    var ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, W, H);

    // ── Dial background ───────────────────────────────────
    // Outer bezel ring
    var bezelGrad = ctx.createRadialGradient(cx - r*0.1, cy - r*0.1, r*0.6, cx, cy, r);
    bezelGrad.addColorStop(0, '#555');
    bezelGrad.addColorStop(1, '#222');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.fillStyle = bezelGrad;
    ctx.fill();

    // Inner dial face — cream/ecru
    var dialR = r * 0.86;
    var dialGrad = ctx.createRadialGradient(cx - dialR*0.15, cy - dialR*0.2, 0, cx, cy, dialR);
    dialGrad.addColorStop(0, '#f5f0e0');
    dialGrad.addColorStop(0.7, '#ede5cc');
    dialGrad.addColorStop(1, '#d8cdb0');
    ctx.beginPath();
    ctx.arc(cx, cy, dialR, 0, Math.PI*2);
    ctx.fillStyle = dialGrad;
    ctx.fill();

    // Dial edge shadow
    ctx.beginPath();
    ctx.arc(cx, cy, dialR, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // ── Hour markers ──────────────────────────────────────
    for (var i = 0; i < 60; i++) {
        var angle = (i / 60) * Math.PI * 2 - Math.PI / 2;
        var isHour  = (i % 5 === 0);
        var isQuarter = (i % 15 === 0);
        var markerLen = isQuarter ? dialR * 0.14 : isHour ? dialR * 0.10 : dialR * 0.04;
        var markerW   = isQuarter ? 1.8 : isHour ? 1.2 : 0.7;
        var outerR    = dialR - 2;
        var innerR    = outerR - markerLen;

        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR);
        ctx.lineTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
        ctx.strokeStyle = isQuarter ? '#2a2218' : isHour ? '#4a3e2a' : '#8a7a60';
        ctx.lineWidth = markerW;
        ctx.lineCap = 'butt';
        ctx.stroke();
    }

    // ── Hands ─────────────────────────────────────────────
    // Apply a subtle shadow under hands
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur  = 3;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;

    // Hour hand — short, wide, tapered
    var ha = ((hours % 12) + minutes / 60) / 12 * Math.PI * 2 - Math.PI / 2;
    drawClockHand(ctx, cx, cy, ha, dialR * 0.48, dialR * 0.06, dialR * 0.03, '#1a1610');

    // Minute hand — long, narrower
    var ma = (minutes + seconds / 60) / 60 * Math.PI * 2 - Math.PI / 2;
    drawClockHand(ctx, cx, cy, ma, dialR * 0.70, dialR * 0.04, dialR * 0.02, '#1a1610');

    ctx.restore();

    // Second hand — thin red sweep hand
    var sa = seconds / 60 * Math.PI * 2 - Math.PI / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur  = 2;
    ctx.shadowOffsetX = 0.5;
    ctx.shadowOffsetY = 0.5;
    // Counterbalance tail
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(sa + Math.PI) * dialR * 0.20,
               cy + Math.sin(sa + Math.PI) * dialR * 0.20);
    ctx.lineTo(cx + Math.cos(sa) * dialR * 0.76,
               cy + Math.sin(sa) * dialR * 0.76);
    ctx.strokeStyle = '#c0180c';
    ctx.lineWidth   = 0.9;
    ctx.lineCap     = 'round';
    ctx.stroke();
    ctx.restore();

    // Centre cap — small brass disc
    var capGrad = ctx.createRadialGradient(cx - 0.5, cy - 0.5, 0.3, cx, cy, 3.5);
    capGrad.addColorStop(0, '#d4b060');
    capGrad.addColorStop(1, '#8a6820');
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = capGrad;
    ctx.fill();
}

// Draw a tapered clock hand (wider at pivot, narrowing to tip)
function drawClockHand(ctx, cx, cy, angle, length, baseW, tipW, colour) {
    var perpAngle = angle + Math.PI / 2;
    var tipX  = cx + Math.cos(angle) * length;
    var tipY  = cy + Math.sin(angle) * length;
    var tailX = cx + Math.cos(angle + Math.PI) * (length * 0.12);
    var tailY = cy + Math.sin(angle + Math.PI) * (length * 0.12);

    ctx.beginPath();
    ctx.moveTo(tailX + Math.cos(perpAngle) * baseW,
               tailY + Math.sin(perpAngle) * baseW);
    ctx.lineTo(tipX  + Math.cos(perpAngle) * tipW,
               tipY  + Math.sin(perpAngle) * tipW);
    ctx.lineTo(tipX  - Math.cos(perpAngle) * tipW,
               tipY  - Math.sin(perpAngle) * tipW);
    ctx.lineTo(tailX - Math.cos(perpAngle) * baseW,
               tailY - Math.sin(perpAngle) * baseW);
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
}

// ── App init ──────────────────────────────────────────────────

export async function initVClock({ registerWindow, openWindow }) {

    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = new URL('vclock.css', import.meta.url).href;
    document.head.appendChild(link);

    try {
        const res  = await fetch(new URL('vclock.html', import.meta.url).href);
        const html = await res.text();
        document.body.insertAdjacentHTML('beforeend', html);
    } catch (err) {
        console.error('[vclock] Failed to load vclock.html', err);
        return;
    }

    const windowEl = document.getElementById('vclock-window');
    if (!windowEl) return;
    const entry = registerWindow(windowEl, { icon: '🕐' });

    document.getElementById('open-vclock')
        ?.addEventListener('dblclick', () => openWindow(entry));

    const grid   = document.getElementById('vclock-grid');
    const btnDig = document.getElementById('vclock-btn-digital');
    const btnAna = document.getElementById('vclock-btn-analog');

    var mode = 'digital';

    btnDig.addEventListener('click', function() { setMode('digital'); });
    btnAna.addEventListener('click', function() { setMode('analog'); });

    function setMode(m) {
        mode = m;
        btnDig.classList.toggle('active', m === 'digital');
        btnAna.classList.toggle('active', m === 'analog');
        grid.querySelectorAll('.vclock-digital').forEach(function(el) {
            el.style.display = m === 'digital' ? '' : 'none';
        });
        grid.querySelectorAll('.vclock-analog').forEach(function(el) {
            el.style.display = m === 'analog' ? '' : 'none';
        });
    }

    // ── Build city cards ──────────────────────────────────
    var cardData = {};

    CITIES.forEach(function(city) {
        var card = document.createElement('div');
        card.className = 'vclock-card';

        // data-vdoc-id is set on EVERY card so future wiring only requires
        // adding a vdocId in config.js — no JS changes needed.
        card.dataset.vdocId = city.vdocId || '';

        if (city.vdocId) {
            // Whole card is the click target — more discoverable than a tiny icon.
            card.classList.add('vclock-card--linked');
            card.title = 'Read writeup: ' + city.label;
            card.addEventListener('click', function() {
                document.dispatchEvent(new CustomEvent('vclock:open-vdoc', {
                    detail: { postId: city.vdocId }
                }));
            });

            // Persistent badge so user knows the card is clickable.
            // (Not hidden on hover — that was too easy to miss.)
            var badge = document.createElement('span');
            badge.className   = 'vclock-badge';
            badge.textContent = '✎';
            card.appendChild(badge);
        }

        var cityEl       = document.createElement('div');
        cityEl.className = 'vclock-city';
        cityEl.textContent = city.label;
        card.appendChild(cityEl);

        // Digital wrap
        var digWrap       = document.createElement('div');
        digWrap.className = 'vclock-digital';

        var segCanvas         = document.createElement('canvas');
        segCanvas.className   = 'vclock-seg-canvas';
        // Real 7-seg aspect: each digit ~0.55:1 (w:h).
        // 4 digits + colon at 22px wide each = ~110px wide, 52px tall.
        // Rendered at native pixel size — no CSS scaling — to avoid squish.
        segCanvas.width  = 130;
        segCanvas.height = 56;
        digWrap.appendChild(segCanvas);
        card.appendChild(digWrap);

        // Analog wrap (hidden in digital mode)
        var anaWrap           = document.createElement('div');
        anaWrap.className     = 'vclock-analog';
        anaWrap.style.display = 'none';

        var anaCanvas         = document.createElement('canvas');
        anaCanvas.className   = 'vclock-analog-canvas';
        anaCanvas.width       = 100;
        anaCanvas.height      = 100;
        anaWrap.appendChild(anaCanvas);
        card.appendChild(anaWrap);

        // Meta row
        var metaEl       = document.createElement('div');
        metaEl.className = 'vclock-meta';

        var dateEl       = document.createElement('div');
        dateEl.className = 'vclock-date';

        var tzEl         = document.createElement('div');
        tzEl.className   = 'vclock-tz';
        tzEl.textContent = city.tz.replace(/_/g, ' ');

        metaEl.appendChild(dateEl);
        metaEl.appendChild(tzEl);
        card.appendChild(metaEl);

        grid.appendChild(card);

        cardData[city.id] = { city, segCanvas, anaCanvas, dateEl };
    });

    // ── Tick ──────────────────────────────────────────────
    var DAY_NAMES = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
    var MON_NAMES = ['JAN','FEB','MAR','APR','MAY','JUN',
                     'JUL','AUG','SEP','OCT','NOV','DEC'];

    function pad2(n) { return n < 10 ? '0'+n : ''+n; }

    function tick() {
        var now = Date.now();

        CITIES.forEach(function(city) {
            var d        = new Date(now);
            var localStr = d.toLocaleString('en-US', { timeZone: city.tz });
            var local    = new Date(localStr);

            var h = local.getHours();
            var m = local.getMinutes();
            var s = local.getSeconds();

            var data = cardData[city.id];
            if (!data) return;

            if (mode === 'digital') drawDigitalClock(data.segCanvas, h, m);
            if (mode === 'analog')  drawAnalogClock(data.anaCanvas, h, m, s);

            data.dateEl.textContent =
                DAY_NAMES[local.getDay()] + ' ' +
                pad2(local.getDate()) + ' ' +
                MON_NAMES[local.getMonth()];
        });

        setTimeout(tick, mode === 'analog' ? 1000 : 500);
    }

    tick();
}
