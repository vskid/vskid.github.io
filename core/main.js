// ============================================================
// core/main.js
// ============================================================
// Entry point. Boots the shell then initialises each app.
// Apps are awaited in sequence so each one has fully injected
// its HTML into the DOM before the next one starts.
//
// To add a new app:
//   1. Create apps/yourapp/yourapp.js exporting initYourApp()
//   2. import { initYourApp } from '../apps/yourapp/yourapp.js'
//   3. await initYourApp(desktop) below
// ============================================================

import { init as initDesktop } from './desktop.js';
import { initExplorer }        from '../apps/explorer/explorer.js';
import { initVMedia }          from '../apps/vmedia/vmedia.js';
import { initVviewer }         from '../apps/vviewer/vviewer.js';
import { initWall }            from '../apps/wall/wall.js';
import { initVDoc }            from '../apps/vdoc/vdoc.js';
import { initSnake }           from '../apps/snake/snake.js';
import { initVClock }          from '../apps/vclock/vclock.js';
import { initVMap }            from '../apps/vmap/vmap.js';

const desktop = initDesktop();

await initExplorer(desktop);
await initVMedia(desktop);
await initVviewer(desktop);
await initWall(desktop);
await initVDoc(desktop);
await initSnake(desktop);
await initVClock(desktop);
await initVMap(desktop);