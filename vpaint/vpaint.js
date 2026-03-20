// ============================================================
// vPaint — standalone paint app
// Features: all classic MS Paint tools + selection scaling,
//           rotation (15° increments), Catmull-Rom curve tool,
//           polygon, airbrush, zoom, text with font picker,
//           canvas resize, image attributes dialog.
// ============================================================

'use strict';

// ── Supabase ──────────────────────────────────────────────────
const SB_URL      = 'https://emfvqpgrdqukyioiqxhl.supabase.co';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtZnZxcGdyZHF1a3lpb2lxeGhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwOTk0OTUsImV4cCI6MjA4NzY3NTQ5NX0.D0LVlwsaMB3BEvtQdnCclXfA7-fdtUJjps1iuQihn_g';
const OWNER_PW    = 'John 3:16';
const TABLE       = 'vpaint-works';

async function sbFetch(path, opts = {}) {
  const res = await fetch(SB_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { 'Content-Type':'application/json', 'apikey':SB_ANON_KEY, 'Authorization':'Bearer '+SB_ANON_KEY, ...(opts.headers||{}) },
  });
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + await res.text());
  return res.status === 204 ? null : res.json();
}
const fetchWorks   = (h) => sbFetch(TABLE+'?select=id,created_at,author,thumb_data,image_data,pinned,hidden'+(h?'':'&hidden=eq.false')+'&order=pinned.desc,created_at.desc');
const insertWork   = (a,i,t) => sbFetch(TABLE, {method:'POST',headers:{'Prefer':'return=representation'},body:JSON.stringify({author:a||'anonymous',image_data:i,thumb_data:t,width:CW,height:CH})});
const deleteWork   = (id) => sbFetch(TABLE+'?id=eq.'+id, {method:'DELETE'});
const togglePin    = (id,v) => sbFetch(TABLE+'?id=eq.'+id, {method:'PATCH',headers:{'Prefer':'return=minimal'},body:JSON.stringify({pinned:v})});
const toggleHide   = (id,v) => sbFetch(TABLE+'?id=eq.'+id, {method:'PATCH',headers:{'Prefer':'return=minimal'},body:JSON.stringify({hidden:v})});

function canvasToJpeg(c, q=0.82) { return c.toDataURL('image/jpeg', q); }
function makeThumbnail(c, maxW=200, q=0.55) {
  const s = Math.min(1, maxW/c.width), tw = Math.round(c.width*s), th = Math.round(c.height*s);
  const t = document.createElement('canvas'); t.width=tw; t.height=th;
  t.getContext('2d').drawImage(c,0,0,tw,th); return t.toDataURL('image/jpeg',q);
}

// ── Palette ───────────────────────────────────────────────────
const PALETTE = ['#000000','#404040','#7f7f7f','#c3c3c3','#ffffff','#880015','#b97a57','#ff7f27','#ffaec9','#ffc90e','#efe4b0','#b5e61d','#22b14c','#99d9ea','#00a2e8','#3f48cc','#7092be','#c8bfe7','#9c4900','#ed1c24','#fff200','#a8e61d','#00a2e8','#3f48cc','#a349a4'];

// ── Canvas state ──────────────────────────────────────────────
let CW = 640, CH = 480;
let zoomLevel = 1;

// ── DOM refs ──────────────────────────────────────────────────
const canvasArea   = document.getElementById('canvas-area');
const canvasWrap   = document.getElementById('canvas-wrap');
const mainCanvas   = document.getElementById('main-canvas');
const overlayCanvas= document.getElementById('overlay-canvas');
const ctx          = mainCanvas.getContext('2d');
const ov           = overlayCanvas.getContext('2d');

const swFg         = document.getElementById('sw-fg');
const swBg         = document.getElementById('sw-bg');
const paletteEl    = document.getElementById('palette');
const sTool        = document.getElementById('s-tool');
const sPos         = document.getElementById('s-pos');
const sDim         = document.getElementById('s-dim');
const sSel         = document.getElementById('s-sel');
const sZoom        = document.getElementById('s-zoom');
const sSnap        = document.getElementById('s-snap');
const outlineEl    = document.getElementById('outline-style');
const fillEl       = document.getElementById('fill-style');
const textFontEl   = document.getElementById('text-font');
const textSizeEl   = document.getElementById('text-size');
const textBoldEl   = document.getElementById('text-bold');
const textItalicEl = document.getElementById('text-italic');
const selTranspEl  = document.getElementById('sel-transparent');
const galleryGrid  = document.getElementById('gallery-grid');
const galleryMsg   = document.getElementById('gallery-msg');
const galleryCount = document.getElementById('gallery-count');
const adminGrid    = document.getElementById('admin-grid');
const lockBtn      = document.getElementById('lockbtn');
const adminTab     = document.getElementById('tab-admin');
const lightbox     = document.getElementById('lightbox');
const lightboxImg  = document.getElementById('lightbox-img');
const toast        = document.getElementById('toast');

// ── Tool state ────────────────────────────────────────────────
let tool      = 'ellipse';
let size      = 1;
let fgColor   = '#000000';
let bgColor   = '#ffffff';
let shiftDown = false;
let centerMode= true;
let ownerMode = false;

// ── Undo/Redo ─────────────────────────────────────────────────
const undoStack = [], redoStack = [];
const MAX_UNDO  = 50;

function pushUndo() {
  undoStack.push(ctx.getImageData(0, 0, CW, CH));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}
function undo() {
  if (sel?.floating) { commitSelection(false); return; }
  if (!undoStack.length) return;
  redoStack.push(ctx.getImageData(0, 0, CW, CH));
  ctx.putImageData(undoStack.pop(), 0, 0);
  clearSelection();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(ctx.getImageData(0, 0, CW, CH));
  ctx.putImageData(redoStack.pop(), 0, 0);
}

// ── Selection state ───────────────────────────────────────────
let sel = null;
// sel = { x, y, w, h, floatCanvas, floating, rotation(deg) }
let clipboard  = null;
let selDragging = null; // 'move' | 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'
let selDragStart = null;
let selOrigRect  = null;

// ── Painting state ────────────────────────────────────────────
let painting  = false;
let lastX = 0, lastY = 0, snapX = 0, snapY = 0;

// ── Lasso ─────────────────────────────────────────────────────
let lassoPoints = [], lassoActive = false;

// ── Polygon ───────────────────────────────────────────────────
let polyPoints  = [], polyActive  = false;
let polyMouseX  = 0,  polyMouseY  = 0;

// ── Curve (Catmull-Rom) ───────────────────────────────────────
let curveKnots  = [], curveActive = false;
let curveMouse  = { x: 0, y: 0 };
let curveDragIdx = -1;

// ── Airbrush ──────────────────────────────────────────────────
let airbrushTimer = null;

// ── Text ──────────────────────────────────────────────────────
let textPos = null, textInputEl = null;

// ── Zoom ──────────────────────────────────────────────────────
const ZOOM_LEVELS = [0.125, 0.25, 0.5, 1, 2, 4, 8];

// ── Init canvas ───────────────────────────────────────────────
function initCanvas() {
  mainCanvas.width  = CW; mainCanvas.height  = CH;
  overlayCanvas.width = CW; overlayCanvas.height = CH;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, CW, CH);
  sDim.textContent = CW + ' × ' + CH;
  updateZoom();
  rebuildCanvasHandles();
}

function updateZoom() {
  canvasWrap.style.transform = `scale(${zoomLevel})`;
  canvasWrap.style.marginBottom = (CH * zoomLevel - CH) + 'px';
  canvasWrap.style.marginRight  = (CW * zoomLevel - CW) + 'px';
  sZoom.textContent = Math.round(zoomLevel * 100) + '%';
}

function zoomIn() {
  const idx = ZOOM_LEVELS.indexOf(zoomLevel);
  if (idx < ZOOM_LEVELS.length - 1) { zoomLevel = ZOOM_LEVELS[idx + 1]; updateZoom(); }
}
function zoomOut() {
  const idx = ZOOM_LEVELS.indexOf(zoomLevel);
  if (idx > 0) { zoomLevel = ZOOM_LEVELS[idx - 1]; updateZoom(); }
}
function zoomReset() { zoomLevel = 1; updateZoom(); }

// ── Canvas resize handles ─────────────────────────────────────
function rebuildCanvasHandles() {
  canvasWrap.querySelectorAll('.canvas-resize-handle').forEach(h => h.remove());
  ['se','e','s'].forEach(pos => {
    const h = document.createElement('div');
    h.className = 'canvas-resize-handle ' + pos;
    h.dataset.dir = pos;
    canvasWrap.appendChild(h);
    h.addEventListener('mousedown', onCanvasResizeStart);
  });
}

let canvasResizing = false, canvasResizeDir = '', canvasResizeStart = null, canvasResizeOrig = null;
function onCanvasResizeStart(e) {
  e.preventDefault(); e.stopPropagation();
  canvasResizing = true;
  canvasResizeDir = e.target.dataset.dir;
  canvasResizeStart = { x: e.clientX, y: e.clientY };
  canvasResizeOrig  = { w: CW, h: CH };
  pushUndo();
}
document.addEventListener('mousemove', e => {
  if (!canvasResizing) return;
  const dx = e.clientX - canvasResizeStart.x, dy = e.clientY - canvasResizeStart.y;
  let nw = canvasResizeOrig.w, nh = canvasResizeOrig.h;
  if (canvasResizeDir.includes('e')) nw = Math.max(1, Math.round(canvasResizeOrig.w + dx / zoomLevel));
  if (canvasResizeDir.includes('s')) nh = Math.max(1, Math.round(canvasResizeOrig.h + dy / zoomLevel));
  resizeCanvas(nw, nh);
});
document.addEventListener('mouseup', () => { canvasResizing = false; });

function resizeCanvas(nw, nh) {
  const tmp = document.createElement('canvas'); tmp.width = CW; tmp.height = CH;
  tmp.getContext('2d').drawImage(mainCanvas, 0, 0);
  CW = nw; CH = nh;
  mainCanvas.width = CW; mainCanvas.height = CH;
  overlayCanvas.width = CW; overlayCanvas.height = CH;
  ctx.fillStyle = bgColor; ctx.fillRect(0, 0, CW, CH);
  ctx.drawImage(tmp, 0, 0);
  sDim.textContent = CW + ' × ' + CH;
  rebuildCanvasHandles();
}

// ── Helpers ───────────────────────────────────────────────────
function hexToRgb(hex) { const n = parseInt(hex.replace('#',''), 16); return [(n>>16)&255, (n>>8)&255, n&255]; }
function setupCtx(color, lw, dash=[]) { ctx.strokeStyle=color; ctx.fillStyle=color; ctx.lineWidth=lw; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.setLineDash(dash); }

function getPos(e) {
  const r = mainCanvas.getBoundingClientRect();
  const px = e.touches ? e.touches[0].clientX : e.clientX;
  const py = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: Math.max(0, Math.min(CW-1, Math.round((px - r.left) / zoomLevel))),
    y: Math.max(0, Math.min(CH-1, Math.round((py - r.top)  / zoomLevel))),
  };
}

function clearOverlay() { ov.clearRect(0, 0, CW, CH); }

// ── Palette ───────────────────────────────────────────────────
function buildPalette() {
  paletteEl.innerHTML = '';
  PALETTE.forEach(hex => {
    const sw = document.createElement('div');
    sw.className = 'swatch'; sw.style.background = hex; sw.title = hex;
    sw.addEventListener('click',       () => setFg(hex));
    sw.addEventListener('contextmenu', e  => { e.preventDefault(); setBg(hex); });
    paletteEl.appendChild(sw);
  });
}
function setFg(hex) { fgColor = hex; swFg.style.background = hex; }
function setBg(hex) { bgColor = hex; swBg.style.background = hex; }
swFg.addEventListener('click', () => { const t = fgColor; setFg(bgColor); setBg(t); });

// ── Font picker ───────────────────────────────────────────────
function buildFontList() {
  const fonts = ['Arial','Verdana','Georgia','Times New Roman','Courier New','Impact','Comic Sans MS','Trebuchet MS','Palatino','Garamond','Futura','Helvetica'];
  fonts.forEach(f => { const o = document.createElement('option'); o.value = o.textContent = f; textFontEl.appendChild(o); });
}

// ── Tabs ──────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    document.getElementById('panel-' + tab.dataset.tab)?.classList.remove('hidden');
    if (tab.dataset.tab === 'gallery') loadGallery();
    if (tab.dataset.tab === 'admin')   loadAdmin();
  });
});

// ── Tools ─────────────────────────────────────────────────────
const TOOL_NAMES = { 'select-rect':'Select','select-lasso':'Free Select','pencil':'Pencil','brush':'Brush','airbrush':'Airbrush','fill':'Fill','text':'Text','eraser':'Eraser','picker':'Pick colour','zoom':'Zoom','line':'Line','curve':'Curve','rect':'Rectangle','roundrect':'Rounded rect','ellipse':'Ellipse','triangle':'Triangle','polygon':'Polygon' };
const SHAPE_TOOLS = new Set(['line','rect','roundrect','ellipse','triangle']);

document.querySelectorAll('.tool').forEach(btn => btn.addEventListener('click', () => activateTool(btn.dataset.tool)));

function activateTool(t) {
  if (curveActive && t !== 'curve') cancelCurve();
  if (polyActive  && t !== 'polygon') cancelPoly();
  if (t !== 'select-rect' && t !== 'select-lasso') commitSelection();
  finishTextInput();

  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  tool = t; canvasArea.dataset.tool = t;
  sTool.textContent = TOOL_NAMES[t] || t;

  // Context-sensitive ribbon sections
  document.getElementById('rg-sel-ops').style.display  = (t==='select-rect'||t==='select-lasso') ? '' : 'none';
  document.getElementById('rg-text-ops').style.display = t==='text'   ? '' : 'none';
  document.getElementById('rg-zoom-ops').style.display = t==='zoom'   ? '' : 'none';
  document.getElementById('rg-curve-ops').style.display= t==='curve'  ? '' : 'none';

  if (t === 'zoom') canvasArea.classList.remove('zoom-out-mode');
}

// ── Size ──────────────────────────────────────────────────────
document.querySelectorAll('.szbtn').forEach(btn => {
  btn.addEventListener('click', () => { document.querySelectorAll('.szbtn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); size = parseInt(btn.dataset.size); });
});

// ── Keyboard ─────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const inInput = ['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName);
  const ctrl = e.ctrlKey || e.metaKey;

  if (!inInput) {
    if (ctrl && e.key==='z') { e.preventDefault(); undo(); return; }
    if (ctrl && e.key==='y') { e.preventDefault(); redo(); return; }
    if (ctrl && e.key==='c') { e.preventDefault(); copySelection(); return; }
    if (ctrl && e.key==='x') { e.preventDefault(); cutSelection(); return; }
    if (ctrl && e.key==='v') { e.preventDefault(); pasteSelection(); return; }
    if (ctrl && e.key==='a') { e.preventDefault(); selectAll(); return; }

    if ((e.key==='Delete'||e.key==='Backspace') && sel) { e.preventDefault(); deleteSelection(); return; }
    if (e.key==='Escape') { if (curveActive) cancelCurve(); else if (polyActive) cancelPoly(); else if (sel) commitSelection(); finishTextInput(); return; }
    if (e.key==='Enter' && curveActive) { commitCurve(); return; }
    if (e.key==='Enter' && polyActive)  { commitPoly(); return; }

    const map = { s:'select-rect',l:'select-lasso',p:'pencil',b:'brush',a:'airbrush',f:'fill',t:'text',e:'eraser',i:'picker',z:'zoom',c:'curve',r:'rect',o:'ellipse',g:'polygon' };
    if (!ctrl && map[e.key.toLowerCase()]) activateTool(map[e.key.toLowerCase()]);

    if (e.key==='=' || e.key==='+') { zoomIn(); return; }
    if (e.key==='-') { zoomOut(); return; }
  }

  if (e.key==='Shift') { shiftDown = true; }
  if (e.key==='Alt')   { centerMode = false; e.preventDefault(); }
});
document.addEventListener('keyup', e => {
  if (e.key==='Shift') shiftDown = false;
  if (e.key==='Alt')   centerMode = true;
});

// ── Flood fill ────────────────────────────────────────────────
function floodFill(sx, sy, fillHex) {
  const id = ctx.getImageData(0,0,CW,CH), d = id.data;
  const idx = (x,y) => (y*CW+x)*4, i0 = idx(sx,sy);
  const [tr,tg,tb,ta] = [d[i0],d[i0+1],d[i0+2],d[i0+3]];
  const [fr,fg2,fb] = hexToRgb(fillHex);
  if (tr===fr&&tg===fg2&&tb===fb&&ta===255) return;
  const stack = [[sx,sy]];
  const match = (x,y)=>{ const i=idx(x,y); return d[i]===tr&&d[i+1]===tg&&d[i+2]===tb&&d[i+3]===ta; };
  const paint = (x,y)=>{ const i=idx(x,y); d[i]=fr;d[i+1]=fg2;d[i+2]=fb;d[i+3]=255; };
  while (stack.length) {
    const [x,y]=stack.pop();
    if (x<0||x>=CW||y<0||y>=CH||!match(x,y)) continue;
    let l=x,r=x;
    while(l>0&&match(l-1,y))l--; while(r<CW-1&&match(r+1,y))r++;
    for(let cx=l;cx<=r;cx++){paint(cx,y);if(y>0&&match(cx,y-1))stack.push([cx,y-1]);if(y<CH-1&&match(cx,y+1))stack.push([cx,y+1]);}
  }
  ctx.putImageData(id,0,0);
}

function pickColor(x,y) { const px=ctx.getImageData(x,y,1,1).data; setFg('#'+[px[0],px[1],px[2]].map(v=>v.toString(16).padStart(2,'0')).join('')); }

// ── Airbrush ──────────────────────────────────────────────────
function doAirbrush(x, y, color) {
  const radius = Math.max(10, size * 8);
  const density = 30;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = color;
  for (let i = 0; i < density; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * radius;
    const ax = x + Math.cos(angle) * r;
    const ay = y + Math.sin(angle) * r;
    ctx.fillRect(ax, ay, 1, 1);
  }
}

// ── Shape preview ─────────────────────────────────────────────
function previewShape(rawX, rawY) {
  clearOverlay();
  const outline = outlineEl.value, fill = fillEl.value;
  const dash = outline === 'dash' ? [6,3] : [];
  let x = rawX, y = rawY;

  if (shiftDown && tool === 'line') {
    const dx=rawX-snapX, dy=rawY-snapY, len=Math.sqrt(dx*dx+dy*dy);
    const a = Math.round(Math.atan2(dy,dx)/(Math.PI/12))*(Math.PI/12);
    x = Math.round(snapX+len*Math.cos(a)); y = Math.round(snapY+len*Math.sin(a));
  } else if (shiftDown) {
    const dx=rawX-snapX, dy=rawY-snapY, dim=Math.max(Math.abs(dx),Math.abs(dy));
    x=snapX+Math.sign(dx)*dim; y=snapY+Math.sign(dy)*dim;
  }

  let ox=snapX, oy=snapY;
  if (centerMode && tool !== 'line') { ox=snapX-(x-snapX); oy=snapY-(y-snapY); }
  const w=x-ox, h=y-oy;

  ov.save(); ov.lineWidth=size; ov.lineCap='round'; ov.lineJoin='round'; ov.setLineDash(dash);

  const applyFill   = () => { if(fill!=='none'){ov.fillStyle=fill==='fg'?fgColor:bgColor;ov.fill();} };
  const applyStroke = () => { if(outline!=='none'){ov.strokeStyle=fgColor;ov.stroke();} };

  if (tool==='line')     { ov.strokeStyle=fgColor;ov.beginPath();ov.moveTo(snapX,snapY);ov.lineTo(x,y);ov.stroke(); }
  else if (tool==='rect'){ ov.beginPath();ov.rect(ox,oy,w,h);applyFill();applyStroke(); }
  else if (tool==='roundrect') {
    const r=Math.min(12,Math.abs(w)/4,Math.abs(h)/4);ov.beginPath();
    if(ov.roundRect)ov.roundRect(ox,oy,w,h,r);else ov.rect(ox,oy,w,h);applyFill();applyStroke();
  }
  else if (tool==='ellipse') {
    const ex=centerMode?snapX:(ox+x)/2,ey=centerMode?snapY:(oy+y)/2;
    const erx=centerMode?Math.abs(x-snapX):Math.abs(w)/2,ery=centerMode?Math.abs(y-snapY):Math.abs(h)/2;
    ov.beginPath();ov.ellipse(ex,ey,erx,ery,0,0,Math.PI*2);applyFill();applyStroke();
  }
  else if (tool==='triangle') { ov.beginPath();ov.moveTo(ox+w/2,oy);ov.lineTo(ox+w,oy+h);ov.lineTo(ox,oy+h);ov.closePath();applyFill();applyStroke(); }

  ov.restore();
}

function commitShape() { ctx.drawImage(overlayCanvas,0,0); clearOverlay(); }

// ── Catmull-Rom curve ─────────────────────────────────────────
function catmullRom(pts, tension=0.5) {
  // Returns array of {x,y} along a smooth path through all pts
  if (pts.length < 2) return pts.slice();
  const result = [];
  const extended = [pts[0], ...pts, pts[pts.length-1]];
  for (let i = 1; i < extended.length - 2; i++) {
    const p0=extended[i-1],p1=extended[i],p2=extended[i+1],p3=extended[i+2];
    for (let t=0; t<=1; t+=0.02) {
      const t2=t*t,t3=t2*t;
      const x = 0.5*((2*p1.x)+(-p0.x+p2.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(-p0.x+3*p1.x-3*p2.x+p3.x)*t3);
      const y = 0.5*((2*p1.y)+(-p0.y+p2.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(-p0.y+3*p1.y-3*p2.y+p3.y)*t3);
      result.push({x,y});
    }
  }
  return result;
}

function drawCurvePreview() {
  clearOverlay();
  if (curveKnots.length === 0) return;

  ov.save();

  // All knots + ghost mouse point for the preview
  const allPts = curveKnots.length >= 1 ? [...curveKnots, curveMouse] : curveKnots;

  // Draw control polygon (thin dashed line connecting knots in order) — ghost guide
  if (allPts.length >= 2) {
    ov.beginPath(); ov.moveTo(allPts[0].x, allPts[0].y);
    for (let i=1;i<allPts.length;i++) ov.lineTo(allPts[i].x, allPts[i].y);
    ov.strokeStyle = 'rgba(0,0,0,0.35)'; ov.lineWidth = 1; ov.setLineDash([3,3]); ov.stroke();
  }

  // Draw smooth Catmull-Rom curve through all points
  const path = catmullRom(allPts);
  if (path.length > 1) {
    ov.beginPath(); ov.moveTo(path[0].x, path[0].y);
    for (let i=1;i<path.length;i++) ov.lineTo(path[i].x, path[i].y);
    ov.strokeStyle = fgColor; ov.lineWidth = size; ov.lineCap = 'round'; ov.setLineDash([]);
    ov.stroke();
  }

  // Draw knot squares (like your screenshot)
  curveKnots.forEach((k, i) => {
    const s = 5;
    ov.fillStyle   = i === curveDragIdx ? '#ff4040' : '#ffffff';
    ov.strokeStyle = '#000000'; ov.lineWidth = 1; ov.setLineDash([]);
    ov.fillRect(k.x-s/2, k.y-s/2, s, s);
    ov.strokeRect(k.x-s/2, k.y-s/2, s, s);
  });

  // Ghost point at mouse (circle)
  ov.beginPath(); ov.arc(curveMouse.x, curveMouse.y, 3, 0, Math.PI*2);
  ov.fillStyle='rgba(255,255,255,0.6)'; ov.strokeStyle='rgba(0,0,0,0.4)'; ov.lineWidth=1; ov.setLineDash([]);
  ov.fill(); ov.stroke();

  ov.restore();
}

function commitCurve() {
  if (curveKnots.length < 2) { cancelCurve(); return; }
  pushUndo();
  const path = catmullRom(curveKnots);
  ctx.save(); ctx.strokeStyle=fgColor; ctx.lineWidth=size; ctx.lineCap='round'; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(path[0].x,path[0].y);
  for(let i=1;i<path.length;i++) ctx.lineTo(path[i].x,path[i].y);
  ctx.stroke(); ctx.restore();
  curveKnots=[]; curveActive=false; curveDragIdx=-1; clearOverlay();
}

function cancelCurve() { curveKnots=[]; curveActive=false; curveDragIdx=-1; clearOverlay(); }

document.getElementById('curve-commit').addEventListener('click', commitCurve);
document.getElementById('curve-cancel').addEventListener('click', cancelCurve);

// ── Polygon ───────────────────────────────────────────────────
function drawPolyPreview() {
  clearOverlay();
  if (!polyActive || polyPoints.length === 0) return;
  const pts = [...polyPoints, {x:polyMouseX, y:polyMouseY}];
  const outline = outlineEl.value, fill = fillEl.value;
  ov.save();
  ov.lineWidth=size; ov.lineCap='round'; ov.lineJoin='round';
  ov.setLineDash(outline==='dash'?[6,3]:[]);
  ov.beginPath(); ov.moveTo(pts[0].x,pts[0].y);
  for(let i=1;i<pts.length;i++) ov.lineTo(pts[i].x,pts[i].y);
  if(fill!=='none'){ov.closePath();ov.fillStyle=fill==='fg'?fgColor:bgColor;ov.fill();}
  if(outline!=='none'){ov.strokeStyle=fgColor;ov.stroke();}
  ov.restore();
}

function commitPoly() {
  if (polyPoints.length < 3) { cancelPoly(); return; }
  pushUndo();
  const outline=outlineEl.value, fill=fillEl.value;
  ctx.save(); ctx.lineWidth=size; ctx.lineCap='round'; ctx.lineJoin='round';
  ctx.setLineDash(outline==='dash'?[6,3]:[]);
  ctx.beginPath(); ctx.moveTo(polyPoints[0].x,polyPoints[0].y);
  for(let i=1;i<polyPoints.length;i++) ctx.lineTo(polyPoints[i].x,polyPoints[i].y);
  ctx.closePath();
  if(fill!=='none'){ctx.fillStyle=fill==='fg'?fgColor:bgColor;ctx.fill();}
  if(outline!=='none'){ctx.strokeStyle=fgColor;ctx.stroke();}
  ctx.restore();
  polyPoints=[]; polyActive=false; clearOverlay();
}
function cancelPoly() { polyPoints=[]; polyActive=false; clearOverlay(); }

// ── Selection helpers ─────────────────────────────────────────
function normRect(x1,y1,x2,y2) {
  const x=Math.max(0,Math.min(x1,x2)),y=Math.max(0,Math.min(y1,y2));
  return {x,y,w:Math.min(CW-x,Math.abs(x2-x1)),h:Math.min(CH-y,Math.abs(y2-y1))};
}

function clearSelection() {
  sel=null; sSel.textContent=''; clearOverlay(); updateSelHandles();
}

function commitSelection(draw=true) {
  if (!sel) return;
  if (sel.floatCanvas && draw && sel.w>0 && sel.h>0) {
    ctx.save(); ctx.globalCompositeOperation='source-over'; ctx.globalAlpha=1;
    const rot = (sel.rotation||0) * Math.PI / 180;
    if (rot !== 0) {
      // Erase original area first
      ctx.fillStyle = bgColor;
      ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
      // Draw rotated about center of selection
      const cx = sel.x + sel.w/2, cy = sel.y + sel.h/2;
      ctx.translate(cx, cy); ctx.rotate(rot); ctx.translate(-sel.w/2, -sel.h/2);
      if (selTranspEl.checked) ctx.drawImage(stampTransparent(sel.floatCanvas), 0, 0, sel.w, sel.h);
      else ctx.drawImage(sel.floatCanvas, 0, 0, sel.w, sel.h);
    } else {
      if (selTranspEl.checked) ctx.drawImage(stampTransparent(sel.floatCanvas), sel.x, sel.y, sel.w, sel.h);
      else ctx.drawImage(sel.floatCanvas, sel.x, sel.y, sel.w, sel.h);
    }
    ctx.restore();
  }
  clearSelection();
}

function stampTransparent(fc) {
  const tmp=document.createElement('canvas'); tmp.width=fc.width; tmp.height=fc.height;
  const tc=tmp.getContext('2d'); tc.drawImage(fc,0,0);
  const id=tc.getImageData(0,0,fc.width,fc.height);
  const [br,bg2,bb]=hexToRgb(bgColor);
  const TOL=30;
  for(let i=0;i<id.data.length;i+=4){
    if(Math.abs(id.data[i]-br)<TOL&&Math.abs(id.data[i+1]-bg2)<TOL&&Math.abs(id.data[i+2]-bb)<TOL)
      id.data[i+3]=0;
  }
  tc.putImageData(id,0,0); return tmp;
}

function liftSelection() {
  if (!sel || sel.floating) return;
  const fc=document.createElement('canvas'); fc.width=sel.w; fc.height=sel.h;
  fc.getContext('2d').drawImage(mainCanvas,sel.x,sel.y,sel.w,sel.h,0,0,sel.w,sel.h);
  pushUndo(); ctx.fillStyle=bgColor; ctx.fillRect(sel.x,sel.y,sel.w,sel.h);
  sel.floatCanvas=fc; sel.floating=true;
}

function selectAll() {
  commitSelection(); activateTool('select-rect');
  sel={x:0,y:0,w:CW,h:CH,floatCanvas:null,floating:false,rotation:0};
  liftSelection(); drawSelectionOverlay(); updateSelHandles(); setSelStatus();
}
function deleteSelection() { if(!sel)return; pushUndo(); if(!sel.floating){ctx.fillStyle=bgColor;ctx.fillRect(sel.x,sel.y,sel.w,sel.h);} clearSelection(); }
function copySelection() {
  if(!sel||sel.w<1||sel.h<1)return;
  const tmp=document.createElement('canvas');tmp.width=sel.w;tmp.height=sel.h;const tc=tmp.getContext('2d');
  if(sel.floating&&sel.floatCanvas)tc.drawImage(sel.floatCanvas,0,0);else tc.drawImage(mainCanvas,sel.x,sel.y,sel.w,sel.h,0,0,sel.w,sel.h);
  clipboard=tc.getImageData(0,0,sel.w,sel.h); showToast('Copied '+sel.w+'×'+sel.h);
}
function cutSelection() { if(!sel||sel.w<1||sel.h<1)return; copySelection(); pushUndo(); if(!sel.floating){ctx.fillStyle=bgColor;ctx.fillRect(sel.x,sel.y,sel.w,sel.h);} clearSelection(); }
function pasteSelection() {
  if(!clipboard)return; commitSelection(); activateTool('select-rect');
  const fc=document.createElement('canvas');fc.width=clipboard.width;fc.height=clipboard.height;fc.getContext('2d').putImageData(clipboard,0,0);
  sel={x:0,y:0,w:clipboard.width,h:clipboard.height,floatCanvas:fc,floating:true,rotation:0};
  drawSelectionOverlay(); updateSelHandles(); setSelStatus(); showToast('Pasted — drag to reposition');
}
function setSelStatus() { if(sel&&sel.w>0&&sel.h>0){sSel.textContent=sel.w+'×'+sel.h;}else{sSel.textContent='';} }

// ── Selection rotation ────────────────────────────────────────
function rotateSelection(deg) {
  if (!sel) return;
  liftSelection();
  sel.rotation = ((sel.rotation || 0) + deg + 360) % 360;
  drawSelectionOverlay(); updateSelHandles();
}
document.getElementById('sel-rot-cw') .addEventListener('click', () => rotateSelection(15));
document.getElementById('sel-rot-ccw').addEventListener('click', () => rotateSelection(-15));

// ── Selection transforms ──────────────────────────────────────
function selFlipH()  { if(!sel)return;liftSelection();flipCanvas(sel.floatCanvas,'h');drawSelectionOverlay(); }
function selFlipV()  { if(!sel)return;liftSelection();flipCanvas(sel.floatCanvas,'v');drawSelectionOverlay(); }
function selInvert() {
  if(!sel)return;liftSelection();
  const id=sel.floatCanvas.getContext('2d').getImageData(0,0,sel.w,sel.h);
  for(let i=0;i<id.data.length;i+=4){id.data[i]=255-id.data[i];id.data[i+1]=255-id.data[i+1];id.data[i+2]=255-id.data[i+2];}
  sel.floatCanvas.getContext('2d').putImageData(id,0,0);drawSelectionOverlay();
}
function flipCanvas(c, dir) {
  const tmp=document.createElement('canvas');tmp.width=c.width;tmp.height=c.height;const tc=tmp.getContext('2d');
  if(dir==='h'){tc.translate(c.width,0);tc.scale(-1,1);}else{tc.translate(0,c.height);tc.scale(1,-1);}
  tc.drawImage(c,0,0);const fc2=c.getContext('2d');fc2.clearRect(0,0,c.width,c.height);fc2.drawImage(tmp,0,0);
}
function cropToSelection(){if(!sel||sel.w<1||sel.h<1)return;commitSelection();pushUndo();const id=ctx.getImageData(sel.x,sel.y,sel.w,sel.h);ctx.fillStyle=bgColor;ctx.fillRect(0,0,CW,CH);ctx.putImageData(id,Math.round((CW-sel.w)/2),Math.round((CH-sel.h)/2));clearSelection();}

document.getElementById('sel-fliph') .addEventListener('click', selFlipH);
document.getElementById('sel-flipv') .addEventListener('click', selFlipV);
document.getElementById('sel-invert').addEventListener('click', selInvert);

// ── Selection overlay + handles ───────────────────────────────
function drawSelectionOverlay() {
  clearOverlay();
  if (!sel) return;
  ov.save();
  const rot = (sel.rotation||0) * Math.PI / 180;
  if (rot !== 0) {
    const cx=sel.x+sel.w/2, cy=sel.y+sel.h/2;
    ov.translate(cx,cy); ov.rotate(rot); ov.translate(-sel.w/2,-sel.h/2);
    if(sel.floating&&sel.floatCanvas) ov.drawImage(sel.floatCanvas,0,0,sel.w,sel.h);
    ov.strokeStyle='#000';ov.lineWidth=1;ov.setLineDash([4,4]);ov.lineDashOffset=0;ov.strokeRect(0.5,0.5,sel.w-1,sel.h-1);
    ov.strokeStyle='#fff';ov.lineDashOffset=4;ov.strokeRect(0.5,0.5,sel.w-1,sel.h-1);
  } else {
    const {x,y,w,h}=sel;
    if(sel.floating&&sel.floatCanvas) ov.drawImage(sel.floatCanvas,x,y,w,h);
    ov.strokeStyle='#000';ov.lineWidth=1;ov.setLineDash([4,4]);ov.lineDashOffset=0;ov.strokeRect(x+.5,y+.5,w,h);
    ov.strokeStyle='#fff';ov.lineDashOffset=4;ov.strokeRect(x+.5,y+.5,w,h);
  }
  ov.restore();
}

// Handle elements in DOM (overlay the canvas wrap)
let selHandleEls = [];
function updateSelHandles() {
  selHandleEls.forEach(h=>h.remove()); selHandleEls=[];
  if (!sel||sel.w<1||sel.h<1) return;

  // 8 handles: corners + edge midpoints
  const {x,y,w,h}=sel;
  const positions = [
    {id:'nw',fx:x,     fy:y,     cls:'corner'},
    {id:'n', fx:x+w/2, fy:y,     cls:'edge-h'},
    {id:'ne',fx:x+w,   fy:y,     cls:'corner ne'},
    {id:'e', fx:x+w,   fy:y+h/2, cls:'edge-v'},
    {id:'se',fx:x+w,   fy:y+h,   cls:'corner'},
    {id:'s', fx:x+w/2, fy:y+h,   cls:'edge-h'},
    {id:'sw',fx:x,     fy:y+h,   cls:'corner sw'},
    {id:'w', fx:x,     fy:y+h/2, cls:'edge-v'},
  ];
  positions.forEach(p => {
    const el = document.createElement('div');
    el.className = 'sel-handle ' + p.cls;
    el.dataset.dir = p.id;
    el.style.left = (p.fx * zoomLevel) + 'px';
    el.style.top  = (p.fy * zoomLevel) + 'px';
    el.addEventListener('mousedown', onSelHandleDown);
    canvasWrap.appendChild(el);
    selHandleEls.push(el);
  });
}

function onSelHandleDown(e) {
  e.preventDefault(); e.stopPropagation();
  liftSelection();
  selDragging  = e.target.dataset.dir;
  selDragStart = getPos(e);
  selOrigRect  = { x:sel.x, y:sel.y, w:sel.w, h:sel.h };
}

// ── Lasso ─────────────────────────────────────────────────────
function commitLasso(pts) {
  if(pts.length<3){lassoPoints=[];lassoActive=false;return;}
  const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
  const bx=Math.max(0,Math.floor(Math.min(...xs))),by=Math.max(0,Math.floor(Math.min(...ys)));
  const bx2=Math.min(CW,Math.ceil(Math.max(...xs))),by2=Math.min(CH,Math.ceil(Math.max(...ys)));
  const bw=bx2-bx,bh=by2-by;
  if(bw<2||bh<2){lassoPoints=[];lassoActive=false;return;}
  const mask=document.createElement('canvas');mask.width=CW;mask.height=CH;
  const mc=mask.getContext('2d');mc.beginPath();mc.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)mc.lineTo(pts[i].x,pts[i].y);mc.closePath();mc.fillStyle='#000';mc.fill();
  const maskData=mc.getImageData(bx,by,bw,bh),srcData=ctx.getImageData(bx,by,bw,bh);
  const fc=document.createElement('canvas');fc.width=bw;fc.height=bh;const fc2=fc.getContext('2d');const out=fc2.createImageData(bw,bh);
  for(let i=0;i<out.data.length;i+=4){if(maskData.data[i+3]>0){out.data[i]=srcData.data[i];out.data[i+1]=srcData.data[i+1];out.data[i+2]=srcData.data[i+2];out.data[i+3]=srcData.data[i+3];}}
  fc2.putImageData(out,0,0);lassoPoints=[];lassoActive=false;
  sel={x:bx,y:by,w:bw,h:bh,floatCanvas:fc,floating:true,rotation:0};
  setSelStatus();drawSelectionOverlay();updateSelHandles();
}

// ── Text ──────────────────────────────────────────────────────
function startTextInput(x, y) {
  finishTextInput();
  textPos = {x,y};
  const font = textFontEl.value || 'Arial';
  const fs   = parseInt(textSizeEl.value) || 16;
  const bold = textBoldEl.classList.contains('active') ? 'bold' : '';
  const ital = textItalicEl.classList.contains('active') ? 'italic' : '';
  textInputEl = document.createElement('textarea');
  const r = mainCanvas.getBoundingClientRect();
  Object.assign(textInputEl.style, {
    position:'fixed', left:(r.left + x*zoomLevel)+'px', top:(r.top + y*zoomLevel)+'px',
    minWidth:'60px', minHeight:'24px', background:'rgba(255,255,255,0.85)',
    border:'1px dashed #888', color:fgColor, fontSize:(fs*zoomLevel)+'px',
    fontFamily:font, fontWeight:bold||'normal', fontStyle:ital||'normal',
    resize:'both', outline:'none', zIndex:'50', padding:'2px 4px', userSelect:'text',
  });
  document.body.appendChild(textInputEl); textInputEl.focus();
  textInputEl.addEventListener('blur',    finishTextInput);
  textInputEl.addEventListener('keydown', e => { if(e.key==='Escape'){textInputEl.value='';finishTextInput();} e.stopPropagation(); });
}

function finishTextInput() {
  if (!textInputEl) return;
  const text = textInputEl.value;
  if (text.trim()) {
    pushUndo();
    const font=textFontEl.value||'Arial', fs=parseInt(textSizeEl.value)||16;
    const bold=textBoldEl.classList.contains('active')?'bold':'normal';
    const ital=textItalicEl.classList.contains('active')?'italic':'normal';
    ctx.save(); ctx.fillStyle=fgColor; ctx.font=`${ital} ${bold} ${fs}px ${font}`; ctx.textBaseline='top';
    text.split('\n').forEach((line,i)=>ctx.fillText(line,textPos.x,textPos.y+i*(fs+2)));
    ctx.restore();
  }
  textInputEl.removeEventListener('blur', finishTextInput);
  textInputEl.remove(); textInputEl=null; textPos=null;
}

textBoldEl.addEventListener('click',   () => textBoldEl.classList.toggle('active'));
textItalicEl.addEventListener('click', () => textItalicEl.classList.toggle('active'));

// ── Mouse events ──────────────────────────────────────────────
mainCanvas.addEventListener('mousedown',  onPointerDown);
mainCanvas.addEventListener('touchstart', onPointerDown, {passive:false});

function onPointerDown(e) {
  e.preventDefault();
  const {x,y} = getPos(e);
  const useRight = e.button === 2;
  const color = useRight ? bgColor : fgColor;

  // Curve tool
  if (tool === 'curve') {
    // Hit-test existing knots first
    const hit = curveKnots.findIndex(k => Math.hypot(k.x-x,k.y-y) < 8/zoomLevel);
    if (hit >= 0) { curveDragIdx = hit; return; }

    // Hit-test segments to insert a knot
    if (curveKnots.length >= 2) {
      const path = catmullRom(curveKnots);
      let bestDist = 12/zoomLevel, bestT = -1;
      for (let i=0;i<path.length-1;i++) {
        const d = Math.hypot(path[i].x-x, path[i].y-y);
        if (d < bestDist) { bestDist=d; bestT=i/(path.length-1); }
      }
      if (bestT >= 0) {
        // Find insertion index
        const ratio = Math.round(bestT * (curveKnots.length - 1));
        curveKnots.splice(ratio+1, 0, {x,y});
        curveActive = true; drawCurvePreview(); return;
      }
    }

    // Add new knot at end
    curveKnots.push({x,y}); curveActive = true; drawCurvePreview(); return;
  }

  // Polygon tool
  if (tool === 'polygon') {
    if (!polyActive) { polyActive=true; polyPoints=[{x,y}]; }
    else polyPoints.push({x,y});
    drawPolyPreview(); return;
  }

  // Zoom tool
  if (tool === 'zoom') {
    if (useRight || e.altKey) zoomOut(); else zoomIn(); return;
  }

  if (tool === 'picker') { pickColor(x,y); return; }
  if (tool === 'fill')   { pushUndo(); floodFill(x,y,color); return; }
  if (tool === 'text')   { startTextInput(x,y); return; }

  // Selection tools
  if (tool === 'select-rect' || tool === 'select-lasso') {
    // Check if clicking inside existing selection
    if (sel && sel.w>0 && sel.h>0 && x>=sel.x && x<=sel.x+sel.w && y>=sel.y && y<=sel.y+sel.h) {
      liftSelection();
      selDragging='move'; selDragStart={x,y}; selOrigRect={x:sel.x,y:sel.y,w:sel.w,h:sel.h};
    } else {
      commitSelection();
      if (tool === 'select-lasso') { lassoActive=true; lassoPoints=[{x,y}]; }
      else { snapX=x;snapY=y; sel={x,y,w:0,h:0,floatCanvas:null,floating:false,rotation:0}; }
    }
    return;
  }

  painting = true; lastX=x; lastY=y; snapX=x; snapY=y;
  if (SHAPE_TOOLS.has(tool)) return;

  if (tool==='eraser') {
    const ew=Math.max(8,size*6);ctx.globalCompositeOperation='source-over';ctx.fillStyle='#ffffff';ctx.fillRect(x-ew/2,y-ew/2,ew,ew);pushUndo();return;
  }
  if (tool==='airbrush') {
    doAirbrush(x,y,color); pushUndo();
    airbrushTimer = setInterval(() => { if(painting)doAirbrush(lastX,lastY,color); }, 50);
    return;
  }
  if (tool==='brush') { ctx.globalCompositeOperation='source-over';ctx.globalAlpha=0.65;setupCtx(color,size*5);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+0.001,y);ctx.stroke();pushUndo();return; }
  ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;setupCtx(color,size);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+0.001,y);ctx.stroke();pushUndo();
}

document.addEventListener('mousemove', onPointerMove);
mainCanvas.addEventListener('touchmove', onPointerMove, {passive:false});

function onPointerMove(e) {
  e.preventDefault?.();
  const {x,y} = getPos(e);
  sPos.textContent = x + ', ' + y;
  if (typeof e.shiftKey === 'boolean') shiftDown = e.shiftKey;

  // Curve drag
  if (tool==='curve' && curveDragIdx>=0) {
    curveKnots[curveDragIdx]={x,y}; curveMouse={x,y}; drawCurvePreview(); return;
  }
  if (tool==='curve') { curveMouse={x,y}; if(curveKnots.length>0)drawCurvePreview(); return; }

  // Polygon hover
  if (tool==='polygon' && polyActive) { polyMouseX=x;polyMouseY=y;drawPolyPreview(); return; }

  // Selection resize via handles
  if (selDragging && selDragging !== 'move' && sel) {
    const dx=x-selDragStart.x, dy=y-selDragStart.y;
    const o=selOrigRect;
    let nx=o.x,ny=o.y,nw=o.w,nh=o.h;
    if(selDragging.includes('e'))nw=Math.max(1,o.w+dx);
    if(selDragging.includes('s'))nh=Math.max(1,o.h+dy);
    if(selDragging.includes('w')){nx=o.x+dx;nw=Math.max(1,o.w-dx);}
    if(selDragging.includes('n')){ny=o.y+dy;nh=Math.max(1,o.h-dy);}
    if(sel.floatCanvas){
      const tmp=document.createElement('canvas');tmp.width=nw;tmp.height=nh;
      tmp.getContext('2d').drawImage(sel.floatCanvas,0,0,nw,nh);sel.floatCanvas=tmp;
    }
    sel.x=nx;sel.y=ny;sel.w=nw;sel.h=nh;
    setSelStatus();drawSelectionOverlay();updateSelHandles();return;
  }

  // Selection move
  if (selDragging==='move' && sel) {
    sel.x=Math.max(0,Math.min(CW-sel.w,selOrigRect.x+(x-selDragStart.x)));
    sel.y=Math.max(0,Math.min(CH-sel.h,selOrigRect.y+(y-selDragStart.y)));
    drawSelectionOverlay();updateSelHandles();return;
  }

  // Lasso draw
  if (tool==='select-lasso' && lassoActive) {
    lassoPoints.push({x,y});
    clearOverlay();ov.save();ov.lineWidth=1;ov.setLineDash([4,4]);
    ov.beginPath();ov.moveTo(lassoPoints[0].x,lassoPoints[0].y);
    for(let i=1;i<lassoPoints.length;i++)ov.lineTo(lassoPoints[i].x,lassoPoints[i].y);
    ov.strokeStyle='#000';ov.lineDashOffset=0;ov.stroke();
    ov.strokeStyle='#fff';ov.lineDashOffset=4;ov.stroke();ov.restore();return;
  }

  // Rect select draw
  if (tool==='select-rect' && !sel?.floating && sel && !selDragging) {
    const r=normRect(snapX,snapY,x,y); sel={...sel,...r};
    clearOverlay();ov.save();ov.strokeStyle='#000';ov.lineWidth=1;ov.setLineDash([4,4]);ov.lineDashOffset=0;ov.strokeRect(r.x+.5,r.y+.5,r.w,r.h);ov.strokeStyle='#fff';ov.lineDashOffset=4;ov.strokeRect(r.x+.5,r.y+.5,r.w,r.h);ov.restore();
    setSelStatus();return;
  }

  if (!painting) return;

  if (tool==='eraser') {
    const ew=Math.max(8,size*6);ctx.globalCompositeOperation='source-over';ctx.fillStyle='#ffffff';
    const steps=Math.ceil(Math.hypot(x-lastX,y-lastY)/(ew/2))+1;
    for(let i=0;i<=steps;i++){const t=steps>0?i/steps:0;ctx.fillRect(lastX+(x-lastX)*t-ew/2,lastY+(y-lastY)*t-ew/2,ew,ew);}
    lastX=x;lastY=y;return;
  }
  if (tool==='airbrush') { lastX=x;lastY=y;return; }
  if (tool==='brush') { ctx.globalAlpha=0.65;ctx.beginPath();ctx.moveTo(lastX,lastY);ctx.lineTo(x,y);ctx.stroke();lastX=x;lastY=y;return; }
  if (tool==='pencil') { ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.beginPath();ctx.moveTo(lastX,lastY);ctx.lineTo(x,y);ctx.stroke();lastX=x;lastY=y;return; }
  if (SHAPE_TOOLS.has(tool)) { previewShape(x,y); return; }
}

document.addEventListener('mouseup',    onPointerUp);
mainCanvas.addEventListener('touchend', onPointerUp);

function onPointerUp(e) {
  ctx.globalCompositeOperation='source-over'; ctx.globalAlpha=1;
  clearInterval(airbrushTimer); airbrushTimer=null;

  if (curveDragIdx >= 0) { curveDragIdx=-1; return; }

  if (selDragging) { selDragging=null; selDragStart=null; selOrigRect=null; return; }

  if (tool==='select-lasso' && lassoActive) { commitLasso(lassoPoints); return; }

  if (tool==='select-rect' && sel && !sel.floating) {
    if (sel.w>2 && sel.h>2) {
      const fc=document.createElement('canvas');fc.width=sel.w;fc.height=sel.h;
      fc.getContext('2d').drawImage(mainCanvas,sel.x,sel.y,sel.w,sel.h,0,0,sel.w,sel.h);
      sel.floatCanvas=fc;
    }
    updateSelHandles(); return;
  }

  if (!painting) return; painting=false;
  if (SHAPE_TOOLS.has(tool)) { pushUndo(); commitShape(); }
}

mainCanvas.addEventListener('dblclick', e => {
  if (tool==='polygon') commitPoly();
  if (tool==='curve')   commitCurve();
});

mainCanvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (tool==='select-rect'||tool==='select-lasso') commitSelection();
  else if (tool==='curve' && curveActive) cancelCurve();
  else if (tool==='polygon' && polyActive) cancelPoly();
});
canvasArea.addEventListener('mousedown', e => { if(e.target!==mainCanvas&&e.target!==overlayCanvas)commitSelection(); });

// ── Zoom tool ribbon buttons ───────────────────────────────────
document.getElementById('zoom-in-btn')   .addEventListener('click', zoomIn);
document.getElementById('zoom-out-btn')  .addEventListener('click', zoomOut);
document.getElementById('zoom-reset-btn').addEventListener('click', zoomReset);

// Ctrl+scroll to zoom
canvasArea.addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.deltaY < 0 ? zoomIn() : zoomOut(); }
}, {passive:false});

// ── Undo/Redo buttons ─────────────────────────────────────────
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);

// ── Clear / Save ──────────────────────────────────────────────
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!confirm('Clear the canvas?')) return;
  commitSelection(); pushUndo(); ctx.fillStyle=bgColor; ctx.fillRect(0,0,CW,CH);
});
document.getElementById('btn-save').addEventListener('click', () => {
  commitSelection();
  const a=document.createElement('a'); a.download='vpaint-'+Date.now()+'.png'; a.href=mainCanvas.toDataURL('image/png'); a.click();
});

// ── Image Attributes dialog ───────────────────────────────────
const dlgAttr = document.getElementById('dlg-attributes');
document.getElementById('attr-cancel').addEventListener('click', () => dlgAttr.classList.add('hidden'));
dlgAttr.addEventListener('click', e => { if(e.target===dlgAttr)dlgAttr.classList.add('hidden'); });

document.getElementById('attr-canvas-ok').addEventListener('click', () => {
  const nw=parseInt(document.getElementById('attr-w').value)||CW;
  const nh=parseInt(document.getElementById('attr-h').value)||CH;
  dlgAttr.classList.add('hidden'); pushUndo(); resizeCanvas(nw,nh);
});

document.getElementById('attr-w').addEventListener('input', () => {
  if (document.getElementById('attr-lock').checked) {
    const r=CH/CW; document.getElementById('attr-h').value=Math.round(parseInt(document.getElementById('attr-w').value)*r)||CH;
  }
});

document.getElementById('attr-resize-ok').addEventListener('click', () => {
  const unit=document.querySelector('input[name="resize-unit"]:checked')?.value||'pct';
  let nw=parseFloat(document.getElementById('rs-w').value),nh=parseFloat(document.getElementById('rs-h').value);
  const skh=parseFloat(document.getElementById('skew-h').value)||0,skv=parseFloat(document.getElementById('skew-v').value)||0;
  const hasSel=sel&&sel.w>0&&sel.h>0,srcW=hasSel?sel.w:CW,srcH=hasSel?sel.h:CH;
  if(unit==='pct'){nw=Math.round(srcW*nw/100);nh=Math.round(srcH*nh/100);}
  nw=Math.max(1,Math.min(9999,nw));nh=Math.max(1,Math.min(9999,nh));
  const shx=Math.tan(skh*Math.PI/180),shy=Math.tan(skv*Math.PI/180);
  dlgAttr.classList.add('hidden');
  doTransform((src,sw,sh)=>{
    const dw=Math.round(nw+Math.abs(shx*nh)),dh=Math.round(nh+Math.abs(shy*nw));
    const out=document.createElement('canvas');out.width=dw;out.height=dh;
    const oc=out.getContext('2d');oc.transform(nw/sw,shy,shx,nh/sh,shx<0?-shx*nh:0,shy<0?-shy*nw:0);oc.drawImage(src,0,0,sw,sh);
    return{out,rw:dw,rh:dh};
  });
  document.getElementById('rs-w').value='100';document.getElementById('rs-h').value='100';
  document.getElementById('skew-h').value='0';document.getElementById('skew-v').value='0';
});

document.getElementById('rs-w').addEventListener('input',()=>{if(document.getElementById('rs-maintain').checked)document.getElementById('rs-h').value=document.getElementById('rs-w').value;});
document.getElementById('rs-h').addEventListener('input',()=>{if(document.getElementById('rs-maintain').checked)document.getElementById('rs-w').value=document.getElementById('rs-h').value;});

function openAttrDialog() {
  document.getElementById('attr-w').value=CW;
  document.getElementById('attr-h').value=CH;
  dlgAttr.classList.remove('hidden');
}

function doTransform(fn) {
  const hasSel=sel&&sel.w>0&&sel.h>0; pushUndo();
  let src,sw,sh;
  if(hasSel){if(sel.floating&&sel.floatCanvas)src=sel.floatCanvas;else{const tmp=document.createElement('canvas');tmp.width=sel.w;tmp.height=sel.h;tmp.getContext('2d').drawImage(mainCanvas,sel.x,sel.y,sel.w,sel.h,0,0,sel.w,sel.h);src=tmp;ctx.fillStyle=bgColor;ctx.fillRect(sel.x,sel.y,sel.w,sel.h);}sw=sel.w;sh=sel.h;}
  else{src=mainCanvas;sw=CW;sh=CH;}
  const{out,rw,rh}=fn(src,sw,sh);
  if(hasSel){if(sel.floating){const tmp=document.createElement('canvas');tmp.width=rw;tmp.height=rh;tmp.getContext('2d').drawImage(out,0,0);sel.floatCanvas=tmp;sel.w=rw;sel.h=rh;}drawSelectionOverlay();updateSelHandles();setSelStatus();}
  else{ctx.fillStyle=bgColor;ctx.fillRect(0,0,CW,CH);ctx.drawImage(out,Math.round((CW-rw)/2),Math.round((CH-rh)/2),rw,rh);}
}

function doRotate90(){ doTransform((s,sw,sh)=>{ const out=document.createElement('canvas');out.width=sh;out.height=sw;const oc=out.getContext('2d');oc.translate(sh,0);oc.rotate(Math.PI/2);oc.drawImage(s,0,0,sw,sh);return{out,rw:sh,rh:sw}; }); }
function doFlipH()   { doTransform((s,sw,sh)=>{ const out=document.createElement('canvas');out.width=sw;out.height=sh;const oc=out.getContext('2d');oc.translate(sw,0);oc.scale(-1,1);oc.drawImage(s,0,0,sw,sh);return{out,rw:sw,rh:sh}; }); }
function doFlipV()   { doTransform((s,sw,sh)=>{ const out=document.createElement('canvas');out.width=sw;out.height=sh;const oc=out.getContext('2d');oc.translate(0,sh);oc.scale(1,-1);oc.drawImage(s,0,0,sw,sh);return{out,rw:sw,rh:sh}; }); }

// ── Menu bar ──────────────────────────────────────────────────
const MENUS = {
  file: [
    {label:'Save PNG',       action:'save-png',   hint:'Ctrl+S'},
    {label:'Clear Canvas…',  action:'clear'},
    {sep:true},
    {label:'Close',          action:'close'},
  ],
  edit: [
    {label:'Undo',       action:'undo',       hint:'Ctrl+Z'},
    {label:'Redo',       action:'redo',       hint:'Ctrl+Y'},
    {sep:true},
    {label:'Cut',        action:'cut',        hint:'Ctrl+X'},
    {label:'Copy',       action:'copy',       hint:'Ctrl+C'},
    {label:'Paste',      action:'paste',      hint:'Ctrl+V'},
    {label:'Select All', action:'select-all', hint:'Ctrl+A'},
    {sep:true},
    {label:'Crop to Selection', action:'crop'},
  ],
  image: [
    {label:'Rotate 90°',       action:'rotate90'},
    {label:'Flip Horizontal',  action:'flip-h'},
    {label:'Flip Vertical',    action:'flip-v'},
    {sep:true},
    {label:'Image Attributes…',action:'attributes'},
  ],
  'gallery-menu': [
    {label:'Post to Gallery…', action:'post'},
    {sep:true},
    {label:'View Gallery',     action:'tab-gallery'},
  ],
};

let openMenuKey=null, openDropEl=null;
function buildDropdown(key) {
  const items=MENUS[key]; if(!items)return null;
  const drop=document.createElement('div'); drop.className='dropdown'; drop.dataset.menu=key;
  items.forEach(item=>{
    if(item.sep){const s=document.createElement('div');s.className='dropdown-sep';drop.appendChild(s);return;}
    const el=document.createElement('div'); el.className='dropdown-item'+(item.disabled?' disabled':'');
    const lbl=document.createElement('span');lbl.className='di-label';lbl.textContent=item.label;el.appendChild(lbl);
    if(item.hint){const h=document.createElement('span');h.className='menu-hint';h.textContent=item.hint;el.appendChild(h);}
    if(!item.disabled)el.addEventListener('click',e=>{e.stopPropagation();dispatchMenu(item.action);closeDropdown();});
    drop.appendChild(el);
  });
  return drop;
}
function openDropdown(key,anchor){
  closeDropdown();const drop=buildDropdown(key);if(!drop)return;
  const r=anchor.getBoundingClientRect();drop.style.left=r.left+'px';drop.style.top=(r.bottom+2)+'px';
  document.body.appendChild(drop);openMenuKey=key;openDropEl=drop;anchor.classList.add('active');
}
function closeDropdown(){openDropEl?.remove();openDropEl=null;if(openMenuKey){document.querySelector(`[data-menu="${openMenuKey}"]`)?.classList.remove('active');openMenuKey=null;}}
function dispatchMenu(a){
  switch(a){
    case 'save-png':   document.getElementById('btn-save').click();break;
    case 'clear':      document.getElementById('btn-clear').click();break;
    case 'close':      window.close();break;
    case 'undo':       undo();break;
    case 'redo':       redo();break;
    case 'cut':        cutSelection();break;
    case 'copy':       copySelection();break;
    case 'paste':      pasteSelection();break;
    case 'select-all': selectAll();break;
    case 'crop':       cropToSelection();break;
    case 'rotate90':   doRotate90();break;
    case 'flip-h':     doFlipH();break;
    case 'flip-v':     doFlipV();break;
    case 'attributes': openAttrDialog();break;
    case 'post':       openPostDialog();break;
    case 'tab-gallery':document.querySelector('.tab[data-tab="gallery"]').click();break;
  }
}
document.querySelectorAll('.menu-item[data-menu]').forEach(btn=>{
  btn.addEventListener('click',e=>{e.stopPropagation();const key=btn.dataset.menu;if(openMenuKey===key){closeDropdown();return;}openDropdown(key,btn);});
});
document.addEventListener('click', closeDropdown);

// ── Gallery ───────────────────────────────────────────────────
async function loadGallery() {
  if(galleryMsg)galleryMsg.style.display='';galleryMsg && (galleryMsg.textContent='Loading…');
  Array.from(galleryGrid.querySelectorAll('.card')).forEach(c=>c.remove());
  let works; try{works=await fetchWorks(false);}catch(err){if(galleryMsg){galleryMsg.style.display='';galleryMsg.textContent='Could not connect to gallery.';}return;}
  if(galleryMsg)galleryMsg.style.display='none';
  galleryCount.textContent=works.length+' work'+(works.length===1?'':'s');
  if(!works.length){if(galleryMsg){galleryMsg.style.display='';galleryMsg.textContent='No works yet!';}return;}
  works.forEach(w=>galleryGrid.appendChild(buildCard(w,false)));
}
document.getElementById('gallery-refresh').addEventListener('click', loadGallery);

async function loadAdmin() {
  adminGrid.innerHTML='<p class="gridmsg">Loading…</p>';
  let works; try{works=await fetchWorks(true);}catch(err){adminGrid.innerHTML='<p class="gridmsg">Error: '+err.message+'</p>';return;}
  adminGrid.innerHTML='';
  if(!works.length){adminGrid.innerHTML='<p class="gridmsg">No works yet.</p>';return;}
  works.forEach(w=>adminGrid.appendChild(buildCard(w,true)));
}
document.getElementById('admin-refresh').addEventListener('click', loadAdmin);

function buildCard(work,isAdmin) {
  const card=document.createElement('div');card.className='card'+(work.pinned?' card-pinned':'');
  if(work.pinned){const b=document.createElement('div');b.className='pin-badge';b.textContent='📌';card.appendChild(b);}
  const img=document.createElement('img');img.className='card-thumb';img.src=work.thumb_data||work.image_data;img.alt='By '+(work.author||'anonymous');
  img.addEventListener('click',()=>{lightboxImg.src=work.image_data;lightbox.classList.remove('hidden');});card.appendChild(img);
  const meta=document.createElement('div');meta.className='card-meta';
  const au=document.createElement('div');au.className='card-author';au.textContent=work.author||'anonymous';
  const dt=document.createElement('div');dt.className='card-date';dt.textContent=new Date(work.created_at).toLocaleDateString();
  meta.append(au,dt);card.appendChild(meta);
  if(isAdmin||ownerMode){
    const row=document.createElement('div');row.className='card-actions';
    const pinBtn=document.createElement('button');pinBtn.className='card-action-btn';pinBtn.textContent=work.pinned?'📌 UNPIN':'📌 PIN';
    pinBtn.addEventListener('click',async()=>{const np=!work.pinned;try{await togglePin(work.id,np);work.pinned=np;pinBtn.textContent=np?'📌 UNPIN':'📌 PIN';card.classList.toggle('card-pinned',np);showToast(np?'Pinned.':'Unpinned.');}catch(e){showToast('Failed: '+e.message,true);}});
    row.appendChild(pinBtn);
    if(isAdmin){
      const hb=document.createElement('button');hb.className='card-action-btn';hb.textContent=work.hidden?'👁 SHOW':'🙈 HIDE';
      hb.addEventListener('click',async()=>{const nh=!work.hidden;try{await toggleHide(work.id,nh);work.hidden=nh;hb.textContent=nh?'👁 SHOW':'🙈 HIDE';card.style.opacity=nh?'0.45':'1';showToast(nh?'Hidden.':'Visible.');}catch(e){showToast('Failed: '+e.message,true);}});
      row.appendChild(hb);
      const db=document.createElement('button');db.className='card-action-btn card-delete-btn';db.textContent='🗑 DEL';
      db.addEventListener('click',async()=>{if(!confirm('Delete permanently?'))return;try{await deleteWork(work.id);card.remove();showToast('Deleted.');}catch(e){showToast('Delete failed: '+e.message,true);}});
      row.appendChild(db);
    }
    card.appendChild(row);
  }
  if(work.hidden&&isAdmin)card.style.opacity='0.45';
  return card;
}

// ── Post to gallery ───────────────────────────────────────────
const dlgPost=document.getElementById('dlg-post');
function openPostDialog(){document.getElementById('post-err').classList.add('hidden');document.getElementById('post-name').value='';dlgPost.classList.remove('hidden');requestAnimationFrame(()=>document.getElementById('post-name').focus());}
document.getElementById('post-cancel').addEventListener('click',()=>dlgPost.classList.add('hidden'));
dlgPost.addEventListener('click',e=>{if(e.target===dlgPost)dlgPost.classList.add('hidden');});
document.getElementById('post-submit').addEventListener('click',async()=>{
  commitSelection();const author=document.getElementById('post-name').value.trim()||'anonymous';
  const imageData=canvasToJpeg(mainCanvas,0.82),thumbData=makeThumbnail(mainCanvas,200,0.55);
  const btn=document.getElementById('post-submit');btn.disabled=true;btn.textContent='⏳';document.getElementById('post-err').classList.add('hidden');
  try{await insertWork(author,imageData,thumbData);dlgPost.classList.add('hidden');showToast('Posted!');document.getElementById('post-name').value='';}
  catch(err){document.getElementById('post-err').textContent='POST FAILED';document.getElementById('post-err').classList.remove('hidden');console.error(err);}
  finally{btn.disabled=false;btn.textContent='TRANSMIT';}
});
document.getElementById('post-name').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('post-submit').click();if(e.key==='Escape')dlgPost.classList.add('hidden');});

// ── Lightbox ──────────────────────────────────────────────────
lightbox.addEventListener('click',()=>lightbox.classList.add('hidden'));

// ── Toast ─────────────────────────────────────────────────────
let toastTimer;
function showToast(msg,isError=false){toast.textContent=msg;toast.classList.remove('hidden','error');if(isError)toast.classList.add('error');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.add('hidden'),3000);}

// ── Owner ─────────────────────────────────────────────────────
const dlgOwner=document.getElementById('dlg-owner');
lockBtn.addEventListener('click',()=>{if(ownerMode){lockOwner();return;}dlgOwner.classList.remove('hidden');document.getElementById('owner-pw').value='';document.getElementById('owner-err').classList.add('hidden');requestAnimationFrame(()=>document.getElementById('owner-pw').focus());});
document.getElementById('owner-cancel').addEventListener('click',()=>dlgOwner.classList.add('hidden'));
dlgOwner.addEventListener('click',e=>{if(e.target===dlgOwner)dlgOwner.classList.add('hidden');});
function attemptLogin(){if(document.getElementById('owner-pw').value===OWNER_PW){dlgOwner.classList.add('hidden');unlockOwner();}else{document.getElementById('owner-err').classList.remove('hidden');document.getElementById('owner-pw').value='';document.getElementById('owner-pw').focus();}}
document.getElementById('owner-submit').addEventListener('click',attemptLogin);
document.getElementById('owner-pw').addEventListener('keydown',e=>{if(e.key==='Enter')attemptLogin();if(e.key==='Escape')dlgOwner.classList.add('hidden');});
function unlockOwner(){ownerMode=true;lockBtn.textContent='🔓';lockBtn.classList.add('unlocked');adminTab.classList.remove('hidden');}
function lockOwner(){ownerMode=false;lockBtn.textContent='🔒';lockBtn.classList.remove('unlocked');adminTab.classList.add('hidden');if(!document.getElementById('panel-admin').classList.contains('hidden'))document.querySelector('.tab[data-tab="paint"]').click();}

// ── Title bar ─────────────────────────────────────────────────
document.getElementById('tl-close').addEventListener('click',()=>window.close());
document.getElementById('tl-max').addEventListener('click',()=>{
  if(document.fullscreenElement)document.exitFullscreen();else document.getElementById('app').requestFullscreen?.();
});

// ── Boot ──────────────────────────────────────────────────────
buildPalette();
buildFontList();
initCanvas();
activateTool('ellipse');
setFg('#000000'); setBg('#ffffff');
