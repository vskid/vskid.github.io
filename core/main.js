// ============================================================
// core/main.js
// ============================================================
import { init as initDesktop }    from './desktop.js';
import { initExplorer }           from '../apps/explorer/explorer.js';
import { initVMedia }             from '../apps/vmedia/vmedia.js';
import { initVviewer }            from '../apps/vviewer/vviewer.js';
import { initWall }               from '../apps/wall/wall.js';
import { initVDoc }               from '../apps/vdoc/vdoc.js';
import { initSnake }              from '../apps/snake/snake.js';
import { initVClock }             from '../apps/vclock/vclock.js';
import { initVMap }               from '../apps/vmap/vmap.js';
import { initVisitorCounter }     from './visitor-counter.js';

const desktop = initDesktop();

initVisitorCounter().catch(err => console.warn('[main] counter failed:', err));

await initExplorer(desktop);
await initVMedia(desktop);
await initVviewer(desktop);
await initWall(desktop);
await initVDoc(desktop);
await initSnake(desktop);
await initVClock(desktop);
await initVMap(desktop);

// ── Standalone apps (open in new tab) ────────────────────────
document.getElementById('open-vpaint')
  ?.addEventListener('dblclick', () => window.open('/vpaint/', '_blank'));

document.getElementById('open-vtracker')
  ?.addEventListener('dblclick', () => window.open('/vtracker/', '_blank'));
