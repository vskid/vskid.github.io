// ============================================================
// core/main.js
// ============================================================
import { init as initDesktop }    from './desktop.js';
import { initExplorer }           from '../apps/explorer/explorer.js';
import { initVMedia }             from '../apps/vmedia/vmedia.js';
import { initVviewer }            from '../apps/vviewer/vviewer.js';
import { initWall }               from '../apps/wall/wall.js';
import { initVDoc }               from '../apps/vdoc/vdoc.js';
import { initVPaint }             from '../apps/vpaint/vpaint.js';
import { initSnake }              from '../apps/snake/snake.js';
import { initVClock }             from '../apps/vclock/vclock.js';
import { initVMap }               from '../apps/vmap/vmap.js';
import { initVisitorCounter }     from './visitor-counter.js';

const desktop = initDesktop();

// Visitor counter runs first — it's fast and non-blocking
initVisitorCounter().catch(err => console.warn('[main] counter failed:', err));

await initExplorer(desktop);
await initVMedia(desktop);
await initVviewer(desktop);
await initWall(desktop);
await initVDoc(desktop);

try {
    await initVPaint(desktop);
} catch (err) {
    console.error('[main] initVPaint failed:', err);
}

await initSnake(desktop);
await initVClock(desktop);
await initVMap(desktop);
