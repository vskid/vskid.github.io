// ============================================================
// apps/snake/snake.js  —  Nokia 3310 edition
// ============================================================
// - Monochrome LCD rendering only: #a8b89a bg / #1a2410 ink
// - Walls wrap (no death on border — original Nokia behaviour)
// - D-pad buttons are the canonical input source
// - Keyboard arrow/WASD synthetically clicks D-pad buttons
// - Square-root speed curve: fast early gains, flattens at high scores
// ============================================================

export async function initSnake({ registerWindow, openWindow }) {

    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = new URL('snake.css', import.meta.url).href;
    document.head.appendChild(link);

    try {
        const res  = await fetch(new URL('snake.html', import.meta.url).href);
        const html = await res.text();
        document.body.insertAdjacentHTML('beforeend', html);
    } catch (err) {
        console.error('[snake] Failed to load snake.html', err);
        return;
    }

    const windowEl = document.getElementById('snake-window');
    if (!windowEl) return;
    const entry = registerWindow(windowEl, { icon: '🐍' });

    document.getElementById('open-snake')
        ?.addEventListener('dblclick', () => openWindow(entry));

    // ── DOM refs ──────────────────────────────────────────────
    const canvas       = document.getElementById('snake-canvas');
    const ctx          = canvas.getContext('2d');
    const scoreEl      = document.getElementById('snake-score');
    const bestEl       = document.getElementById('snake-best');
    const levelEl      = document.getElementById('snake-level');
    const overlay      = document.getElementById('snake-overlay');
    const overlayTitle = document.getElementById('snake-overlay-title');
    const overlaySub   = document.getElementById('snake-overlay-sub');
    const startBtn     = document.getElementById('snake-start-btn');
    const btnUp        = document.getElementById('dpad-up');
    const btnDown      = document.getElementById('dpad-down');
    const btnLeft      = document.getElementById('dpad-left');
    const btnRight     = document.getElementById('dpad-right');
    const btnPause     = document.getElementById('snake-pause-btn');
    const btnRestart   = document.getElementById('snake-restart-btn');

    // ── Grid ──────────────────────────────────────────────────
    const COLS  = 20;
    const ROWS  = 16;
    const CELL  = 10;       // px per cell including 1px gap
    const GAP   = 1;
    const INNER = CELL - GAP;
    const W     = COLS * CELL;
    const H     = ROWS * CELL;

    canvas.width  = W;
    canvas.height = H;

    // ── Nokia LCD palette — two colours only ──────────────────
    const LCD_OFF = '#a8b89a';
    const LCD_ON  = '#1a2410';
    const LCD_MID = '#7a9068';

    // ── State ─────────────────────────────────────────────────
    var snake, dir, nextDir, food, score, level, best, paused, running, loopId;

    best = parseInt(localStorage.getItem('vsnake-best') || '0');
    bestEl.textContent = best;

    function reset() {
        var mx = Math.floor(COLS / 2);
        var my = Math.floor(ROWS / 2);
        snake   = [ {x:mx,y:my},{x:mx-1,y:my},{x:mx-2,y:my} ];
        dir     = {x:1, y:0};
        nextDir = {x:1, y:0};
        score   = 0; level = 1; paused = false; running = false;
        placeFood(); updateHUD();
    }

    function placeFood() {
        var occ = {};
        for (var i = 0; i < snake.length; i++) occ[snake[i].x+','+snake[i].y] = true;
        var pos;
        do { pos = { x: Math.floor(Math.random()*COLS), y: Math.floor(Math.random()*ROWS) }; }
        while (occ[pos.x+','+pos.y]);
        food = pos;
    }

    function updateHUD() {
        scoreEl.textContent = score;
        levelEl.textContent = level;
        bestEl.textContent  = best;
    }

    // Square-root speed curve: 220ms → 90ms floor
    function tickMs() {
        var t = Math.sqrt(score) / Math.sqrt(60);
        return Math.max(90, Math.round(220 - 130 * t));
    }

    function startLoop() { stopLoop(); running = true; loopId = setTimeout(tick, tickMs()); }
    function stopLoop()  { if (loopId) { clearTimeout(loopId); loopId = null; } }

    function tick() {
        if (!running || paused) return;
        dir = {x:nextDir.x, y:nextDir.y};
        var head = {
            x: (snake[0].x + dir.x + COLS) % COLS,
            y: (snake[0].y + dir.y + ROWS) % ROWS,
        };
        for (var i = 0; i < snake.length; i++) {
            if (snake[i].x === head.x && snake[i].y === head.y) return gameOver();
        }
        snake.unshift(head);
        if (head.x === food.x && head.y === food.y) {
            score++;
            if (score > best) { best = score; localStorage.setItem('vsnake-best', best); }
            level = Math.floor(score / 5) + 1;
            updateHUD(); placeFood();
        } else { snake.pop(); }
        draw();
        loopId = setTimeout(tick, tickMs());
    }

    function gameOver() {
        running = false; stopLoop(); updateHUD();
        var flashes = 0;
        function flash() {
            flashes++;
            ctx.fillStyle = (flashes % 2 === 1) ? LCD_ON : LCD_OFF;
            ctx.fillRect(0, 0, W, H);
            if (flashes % 2 === 0) draw();
            if (flashes < 6) setTimeout(flash, 75);
            else showOverlay('GAME OVER', 'SCORE: '+score+'   LVL: '+level, '[ RETRY ]');
        }
        flash();
    }

    // ── Draw — monochrome only ────────────────────────────────
    function draw() {
        ctx.fillStyle = LCD_OFF;
        ctx.fillRect(0, 0, W, H);

        // Grid lines (LCD pixel gap)
        ctx.fillStyle = LCD_MID;
        for (var x = CELL; x < W; x += CELL) ctx.fillRect(x-1, 0, 1, H);
        for (var y = CELL; y < H; y += CELL) ctx.fillRect(0, y-1, W, 1);

        // Food: solid square with corners cut = cross shape
        var px = food.x * CELL, py = food.y * CELL, s = INNER;
        ctx.fillStyle = LCD_ON;
        ctx.fillRect(px+1, py,     s-2, 1);      // top edge (no corners)
        ctx.fillRect(px,   py+1,   s,   s-2);    // middle rows
        ctx.fillRect(px+1, py+s-1, s-2, 1);      // bottom edge (no corners)

        // Snake: plain filled squares, no rounding, no gradient, no glow
        ctx.fillStyle = LCD_ON;
        for (var i = 0; i < snake.length; i++) {
            ctx.fillRect(snake[i].x*CELL, snake[i].y*CELL, INNER, INNER);
        }

        // Pause indicator: two pixel bars
        if (paused) {
            var cx = Math.floor(W/2), cy = Math.floor(H/2);
            ctx.fillStyle = LCD_ON;
            ctx.fillRect(cx-5, cy-7, 3, 14);
            ctx.fillRect(cx+2, cy-7, 3, 14);
        }
    }

    // ── Overlay ───────────────────────────────────────────────
    function showOverlay(title, sub, btn) {
        overlayTitle.textContent = title;
        overlaySub.textContent   = sub;
        startBtn.textContent     = btn;
        overlay.classList.remove('hidden');
    }
    function hideOverlay() { overlay.classList.add('hidden'); }

    // ── D-pad input (canonical) ───────────────────────────────
    function pressDir(dx, dy, btnEl) {
        btnEl.classList.add('pressed');
        setTimeout(function() { btnEl.classList.remove('pressed'); }, 120);
        if (dx !== -dir.x || dy !== -dir.y) nextDir = {x:dx, y:dy};
        if (!running && !overlay.classList.contains('hidden')) startGame();
    }

    btnUp.addEventListener('click',    function() { pressDir( 0,-1,btnUp);    });
    btnDown.addEventListener('click',  function() { pressDir( 0, 1,btnDown);  });
    btnLeft.addEventListener('click',  function() { pressDir(-1, 0,btnLeft);  });
    btnRight.addEventListener('click', function() { pressDir( 1, 0,btnRight); });

    function addTouch(btn, dx, dy) {
        btn.addEventListener('touchstart', function(e) {
            e.preventDefault(); pressDir(dx, dy, btn);
        }, {passive:false});
    }
    addTouch(btnUp,0,-1); addTouch(btnDown,0,1);
    addTouch(btnLeft,-1,0); addTouch(btnRight,1,0);

    btnPause.addEventListener('click',   function() { if (running) togglePause(); });
    btnRestart.addEventListener('click', function() { if (!overlay.classList.contains('hidden')) return; reset(); startGame(); });
    startBtn.addEventListener('click', startGame);

    // Keyboard → D-pad clicks (single code path)
    var K = { ArrowUp:btnUp, ArrowDown:btnDown, ArrowLeft:btnLeft, ArrowRight:btnRight,
              w:btnUp, s:btnDown, a:btnLeft, d:btnRight };
    document.addEventListener('keydown', function(e) {
        if (windowEl.classList.contains('hidden') || windowEl.classList.contains('minimized')) return;
        var b = K[e.key];
        if (b) { e.preventDefault(); b.click(); return; }
        if (e.key==='p'||e.key==='P') btnPause.click();
        if (e.key==='r'||e.key==='R') btnRestart.click();
    });

    function startGame() { reset(); hideOverlay(); draw(); startLoop(); }
    function togglePause() {
        paused = !paused;
        if (!paused) { draw(); loopId = setTimeout(tick, tickMs()); }
        else { stopLoop(); draw(); }
    }

    reset(); draw();
    showOverlay('SNAKE II', 'USE DPAD OR WASD', '[ START ]');
}