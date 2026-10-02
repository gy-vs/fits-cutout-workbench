/**
 * FITS workbench front-end (no framework, no build step).
 *
 * Coordinate discipline: the browser never converts screen pixels to sky
 * coordinates itself. It maps screen -> downsampled overview pixel ->
 * SOURCE pixel (simple ratio), and asks the server for the physical value
 * and RA/Dec. Grids, rectangle footprints and cutouts all come back from
 * the server in source-pixel or sky coordinates.
 *
 * Stale responses are guarded twice: each uploaded file has a server-side
 * generation (a replacement invalidates old replies with 409), and every
 * rapid-fire channel (hover, preview) carries a client token; replies
 * whose token is no longer current are discarded before painting.
 */

const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  overviewBitmap: null,
  grid: null,
  view: { scale: 1, ox: 0, oy: 0 },
  tool: 'pan',
  rect: null, // pending region in SOURCE pixel coords (0-based, half-open)
  liveRect: null,
  drag: null,
  hoverToken: 0,
  previewToken: 0,
  previewAbort: null,
  lastCutout: null,
};

const ERROR_TEXT = {
  MALFORMED_HEADER: 'FITS 头格式错误',
  UNSUPPORTED_BITPIX: '不支持的 BITPIX（仅 16 / -32）',
  UNSUPPORTED_NAXIS: '不支持的维数（仅 NAXIS=2）',
  UNSUPPORTED_WCS: '不支持的 WCS 约定（仅 CRPIX/CRVAL + CD 矩阵的 TAN）',
  SINGULAR_CD: 'CD 矩阵不可逆，无法建立坐标变换',
  DIMENSION_OVERFLOW: '图像尺寸乘积溢出，拒绝读取',
  PADDING_VIOLATION: '头块未按 2880 字节对齐',
  TRUNCATED_DATA: '像素数据被截断',
  FILE_TOO_LARGE: '上传文件过大',
  UNKNOWN_SESSION: '会话已失效（文件被替换或已释放）',
  STALE_GENERATION: '旧图像的响应已丢弃',
  BAD_CUTOUT: '切片参数不合法',
  RECT_NOT_PROJECTABLE: '所选区域超出 TAN 可见半球',
  OUTPUT_TOO_LARGE: '输出尺寸过大',
  NOT_FOUND: '接口不存在',
  BAD_REQUEST: '请求参数错误',
  BAD_JSON: '请求不是合法 JSON',
};

/* ------------------------------ HTTP helpers ------------------------------ */

async function apiRaw(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let code = 'ERROR';
    let message = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      code = j.code || code;
      message = j.message || message;
    } catch { /* keep default */ }
    const err = new Error(message);
    err.code = code;
    err.status = res.status;
    throw err;
  }
  return res;
}

async function apiJson(path, body, opts = {}) {
  const init = { method: 'POST', ...opts };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await apiRaw(path, init);
  return res.json();
}

function withGen(path) {
  const u = new URL(path, location.href);
  if (state.meta) u.searchParams.set('gen', state.meta.generation);
  return u.pathname + u.search;
}

/* --------------------------------- Upload --------------------------------- */

async function loadFits(buffer, label) {
  setBusy(true);
  clearGlobalError();
  // Release the previous session's bytes before replacing the image.
  if (state.meta) {
    try { await apiRaw(`/api/session/${state.meta.sessionId}/release`, { method: 'POST' }); }
    catch { /* best effort */ }
  }
  try {
    const res = await apiRaw('/api/upload', { method: 'POST', body: buffer });
    const meta = await res.json();
    const [ov, grid] = await Promise.all([
      fetchOverview(meta),
      fetchGrid(meta),
    ]);
    state.meta = meta;
    state.overviewBitmap = ov;
    state.grid = grid;
    state.rect = null;
    state.liveRect = null;
    state.lastCutout = null;
    fillMeta(meta, label);
    resetView(true);
    $('empty-state').hidden = true;
    $('preview-img').hidden = true;
    $('preview-empty').hidden = false;
    setPreviewMeta('等待请求');
    defaultRectangle(meta);
    draw();
  } catch (err) {
    showGlobalError(err);
  } finally {
    setBusy(false);
  }
}

async function fetchOverview(meta) {
  const u = `/api/session/${meta.sessionId}/overview?gen=${meta.generation}`;
  const res = await apiRaw(u, { method: 'POST' });
  const blob = await res.blob();
  return createImageBitmap(blob);
}

async function fetchGrid(meta) {
  const j = await apiJson(`/api/session/${meta.sessionId}/grid?gen=${meta.generation}`);
  return j.grid;
}

async function loadSample(kind, label) {
  setBusy(true);
  try {
    const res = await apiRaw(`/api/sample/source?kind=${encodeURIComponent(kind)}`, { method: 'POST' });
    const buf = await res.arrayBuffer();
    await loadFits(buf, label);
  } catch (err) {
    showGlobalError(err);
    setBusy(false);
  }
}

/* --------------------------------- Drawing -------------------------------- */

const canvas = $('canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => { resizeCanvas(); if (state.meta) draw(); });

function resetView(fit = false) {
  if (!state.overviewBitmap) return;
  const r = canvas.getBoundingClientRect();
  const scale = Math.min(
    r.width / state.overviewBitmap.width,
    r.height / state.overviewBitmap.height
  ) * 0.95;
  state.view.scale = scale;
  state.view.ox = (r.width - state.overviewBitmap.width * scale) / 2;
  state.view.oy = (r.height - state.overviewBitmap.height * scale) / 2;
  if (state.meta || fit) draw();
}

const ovToScreenX = (x) => state.view.ox + x * state.view.scale;
const ovToScreenY = (y) => state.view.oy + y * state.view.scale;
const screenToOv = (sx, sy) => ({
  x: (sx - state.view.ox) / state.view.scale,
  y: (sy - state.view.oy) / state.view.scale,
});

function sourceToOverview(sx, sy) {
  const m = state.meta;
  return {
    x: (sx + 0.5) * (state.overviewBitmap.width / m.width),
    y: (sy + 0.5) * (state.overviewBitmap.height / m.height),
  };
}

function overviewToSource(ox, oy) {
  const m = state.meta;
  return {
    x: Math.floor((ox / state.overviewBitmap.width) * m.width),
    y: Math.floor((oy / state.overviewBitmap.height) * m.height),
  };
}

function drawChecker(w, h) {
  const size = 12;
  ctx.fillStyle = '#0d1320';
  ctx.fillRect(0, 0, w, h);
  // Missing-data checker behind the (transparent) overview PNG.
  ctx.save();
  ctx.beginPath();
  ctx.rect(state.view.ox, state.view.oy,
    state.overviewBitmap.width * state.view.scale,
    state.overviewBitmap.height * state.view.scale);
  ctx.clip();
  ctx.fillStyle = '#15202f';
  for (let y = state.view.oy; y < state.view.oy + state.overviewBitmap.height * state.view.scale; y += size) {
    for (let x = state.view.ox; x < state.view.ox + state.overviewBitmap.width * state.view.scale; x += size) {
      if ((Math.round((x - state.view.ox) / size) + Math.round((y - state.view.oy) / size)) % 2 === 0) {
        ctx.fillRect(x, y, size, size);
      }
    }
  }
  ctx.restore();
}

function draw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.fillStyle = '#0a0e16';
  ctx.fillRect(0, 0, r.width, r.height);
  if (!state.overviewBitmap) return;

  drawChecker(r.width, r.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    state.overviewBitmap,
    state.view.ox, state.view.oy,
    state.overviewBitmap.width * state.view.scale,
    state.overviewBitmap.height * state.view.scale
  );

  // Image border
  ctx.strokeStyle = '#33445f';
  ctx.lineWidth = 1;
  ctx.strokeRect(state.view.ox, state.view.oy,
    state.overviewBitmap.width * state.view.scale,
    state.overviewBitmap.height * state.view.scale);

  if ($('grid-toggle').checked && state.grid) drawGrid();
  drawRect();
}

function drawGrid() {
  const toScreen = (sx, sy) => {
    const o = sourceToOverview(sx, sy);
    return [ovToScreenX(o.x), ovToScreenY(o.y)];
  };
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  for (const line of state.grid.lines) {
    ctx.strokeStyle = line.type === 'ra' ? 'rgba(79,156,255,.75)' : 'rgba(255,179,71,.75)';
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < line.points.length; i += 2) {
      const px = line.points[i];
      const py = line.points[i + 1];
      if (Number.isNaN(px) || Number.isNaN(py)) { pen = false; continue; }
      const [x, y] = toScreen(px, py);
      if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  for (const lab of state.grid.labels) {
    const o = sourceToOverview(lab.x, lab.y);
    const x = ovToScreenX(o.x);
    const y = ovToScreenY(o.y);
    ctx.fillStyle = 'rgba(8,12,20,.72)';
    const w = ctx.measureText(lab.text).width;
    ctx.fillRect(x - 2, y - 9, w + 4, 11);
    ctx.fillStyle = 'rgba(225,235,250,.92)';
    ctx.fillText(lab.text, x, y);
  }
}

function drawRect() {
  const rect = state.liveRect || state.rect;
  if (!rect) return;
  const a = sourceToOverview(rect.x0, rect.y0);
  const b = sourceToOverview(rect.x1, rect.y1);
  const x = ovToScreenX(a.x), y = ovToScreenY(a.y);
  const x2 = ovToScreenX(b.x), y2 = ovToScreenY(b.y);
  ctx.save();
  ctx.fillStyle = 'rgba(79,156,255,.15)';
  ctx.fillRect(x, y, x2 - x, y2 - y);
  ctx.strokeStyle = '#4f9cff';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.strokeRect(x, y, x2 - x, y2 - y);
  ctx.setLineDash([]);
  ctx.fillStyle = '#cfe2ff';
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText(`待导出 ${rect.x1 - rect.x0}×${rect.y1 - rect.y0} px`, x + 4, y - 5);
  ctx.restore();
}

/* -------------------------------- Interaction ------------------------------- */

function canvasPos(evt) {
  const r = canvas.getBoundingClientRect();
  return { sx: evt.clientX - r.left, sy: evt.clientY - r.top };
}

canvas.addEventListener('wheel', (evt) => {
  if (!state.meta) return;
  evt.preventDefault();
  const { sx, sy } = canvasPos(evt);
  const before = screenToOv(sx, sy);
  const factor = Math.exp(-evt.deltaY * 0.0012);
  state.view.scale = Math.min(40, Math.max(0.05, state.view.scale * factor));
  state.view.ox = sx - before.x * state.view.scale;
  state.view.oy = sy - before.y * state.view.scale;
  draw();
}, { passive: false });

canvas.addEventListener('mousedown', (evt) => {
  if (!state.meta) return;
  const { sx, sy } = canvasPos(evt);
  if (state.tool === 'select') {
    const o = screenToOv(sx, sy);
    const s = overviewToSource(o.x, o.y);
    state.drag = { mode: 'select', start: s };
    state.liveRect = { x0: s.x, y0: s.y, x1: s.x, y1: s.y };
    canvas.classList.add('selecting');
  } else {
    state.drag = { mode: 'pan', startX: sx, startY: sy, ox: state.view.ox, oy: state.view.oy };
    canvas.classList.add('grabbing');
  }
});

window.addEventListener('mousemove', (evt) => {
  if (!state.meta) return;
  const { sx, sy } = canvasPos(evt);
  if (state.drag) {
    if (state.drag.mode === 'pan') {
      state.view.ox = state.drag.ox + (sx - state.drag.startX);
      state.view.oy = state.drag.oy + (sy - state.drag.startY);
    } else {
      const o = screenToOv(sx, sy);
      const s = clampSource(overviewToSource(o.x, o.y));
      state.liveRect = {
        x0: state.drag.start.x, y0: state.drag.start.y, x1: s.x, y1: s.y,
      };
    }
    draw();
  }
  scheduleHover(sx, sy);
});

window.addEventListener('mouseup', async () => {
  if (!state.drag) return;
  canvas.classList.remove('grabbing', 'selecting');
  if (state.drag.mode === 'select' && state.liveRect) {
    const r = normalizeRect(state.liveRect);
    if (r.x1 - r.x0 >= 2 && r.y1 - r.y0 >= 2) {
      state.rect = r;
      await applyRectangle(r);
    }
    state.liveRect = null;
    draw();
  }
  state.drag = null;
});

function clampSource(s) {
  return {
    x: Math.max(0, Math.min(state.meta.width, s.x)),
    y: Math.max(0, Math.min(state.meta.height, s.y)),
  };
}
function normalizeRect(r) {
  return {
    x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1),
  };
}

/* ------------------------------ Hover readout ------------------------------ */

let hoverTimer = null;
function scheduleHover(sx, sy) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => doHover(sx, sy), 90);
}

async function doHover(sx, sy) {
  if (!state.meta || state.drag) return;
  const o = screenToOv(sx, sy);
  if (o.x < 0 || o.y < 0 || o.x >= state.overviewBitmap.width || o.y >= state.overviewBitmap.height) {
    setReadout(null);
    return;
  }
  const s = overviewToSource(o.x, o.y);
  if (s.x < 0 || s.y < 0 || s.x >= state.meta.width || s.y >= state.meta.height) {
    setReadout(null);
    return;
  }
  const token = ++state.hoverToken;
  try {
    const j = await apiJson(
      withGen(`/api/session/${state.meta.sessionId}/sample-point?x=${s.x}&y=${s.y}&token=${token}`)
    );
    if (token !== state.hoverToken) return; // newer hover superseded this reply
    setReadout(j);
  } catch (err) {
    if (token !== state.hoverToken) return;
    if (err.status === 409 || err.status === 404) return; // replaced/closed — ignore stale
    setReadout({ error: err });
  }
}

function setReadout(j) {
  if (!j) {
    $('ro-pixel').textContent = '—';
    $('ro-value').textContent = '—';
    $('ro-ra').textContent = '—';
    $('ro-dec').textContent = '—';
    return;
  }
  if (j.error) {
    $('ro-pixel').textContent = '?';
    $('ro-value').textContent = ERROR_TEXT[j.error.code] || j.error.message;
    return;
  }
  $('ro-pixel').textContent = `[${j.pixel.x}, ${j.pixel.y}]`;
  $('ro-value').textContent = j.missing ? '缺失（BLANK/NaN）' : j.physical.toFixed(4);
  if (j.sky) {
    $('ro-ra').textContent = `${j.sky.ra.toFixed(6)}°  ${j.sky.raText}`;
    $('ro-dec').textContent = `${j.sky.dec.toFixed(6)}°  ${j.sky.decText}`;
  } else {
    $('ro-ra').textContent = '超出 TAN 可见半球';
    $('ro-dec').textContent = '—';
  }
}

/* ------------------------------ Cutout form ------------------------------ */

function readForm() {
  return {
    ra: Number($('f-ra').value),
    dec: Number($('f-dec').value),
    widthDeg: Number($('f-width').value),
    heightDeg: Number($('f-height').value),
    outW: Number($('f-outw').value),
    outH: Number($('f-outh').value),
  };
}

function fillForm(req) {
  $('f-ra').value = req.ra.toFixed(6);
  $('f-dec').value = req.dec.toFixed(6);
  $('f-width').value = req.widthDeg.toFixed(5);
  $('f-height').value = req.heightDeg.toFixed(5);
}

function defaultRectangle(meta) {
  // Initial pending region: centre 40% of the source pixels.
  const w = Math.round(meta.width * 0.4);
  const h = Math.round(meta.height * 0.4);
  const r = {
    x0: Math.round((meta.width - w) / 2),
    y0: Math.round((meta.height - h) / 2),
    x1: Math.round((meta.width + w) / 2),
    y1: Math.round((meta.height + h) / 2),
  };
  state.rect = r;
  $('f-outw').value = String(w);
  $('f-outh').value = String(h);
  applyRectangle(r).catch(() => {});
}

async function applyRectangle(r) {
  try {
    const j = await apiJson(withGen(`/api/session/${state.meta.sessionId}/rectangle`), r);
    fillForm({ ra: j.center.ra, dec: j.center.dec, widthDeg: j.widthDeg, heightDeg: j.heightDeg });
    updatePendingHint();
    schedulePreview();
  } catch (err) {
    showGlobalError(err);
  }
}

function updatePendingHint() {
  const f = readForm();
  $('pending-hint').textContent =
    `待导出：中心 (${f.ra.toFixed(4)}°, ${f.dec.toFixed(4)}°)，` +
    `${f.widthDeg.toFixed(3)}°×${f.heightDeg.toFixed(3)}°，输出 ${f.outW}×${f.outH} px`;
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => requestPreview().catch(showGlobalError), 280);
}

async function requestPreview() {
  if (!state.meta) return;
  const req = readForm();
  const token = ++state.previewToken;
  if (state.previewAbort) state.previewAbort.abort();
  const ctrl = new AbortController();
  state.previewAbort = ctrl;
  setPreviewMeta('请求服务端裁切…');
  try {
    const j = await apiJson(withGen(`/api/session/${state.meta.sessionId}/cutout/preview`),
      { ...req, token }, { signal: ctrl.signal });
    if (token !== state.previewToken) return; // newer edit superseded this preview
    state.lastCutout = { req: j.request, coverage: j.coverage };
    const img = $('preview-img');
    img.src = `data:image/png;base64,${j.png}`;
    img.hidden = false;
    $('preview-empty').hidden = true;
    const c = j.coverage;
    const pct = (100 * c.valid / c.total).toFixed(1);
    setPreviewMeta(
      `有效像素 ${c.valid}/${c.total}（${pct}%）；源缺失 ${c.missingSource}，` +
      `越界 ${c.outside}，远半球 ${c.offHemisphere}；值域 ${j.vmin.toFixed(2)}…${j.vmax.toFixed(2)}`
    );
    updatePendingHint();
  } catch (err) {
    if (err.name === 'AbortError' || token !== state.previewToken) return;
    setPreviewMeta(`错误：${ERROR_TEXT[err.code] || ''} ${err.message}`);
  }
}

async function downloadCutout() {
  if (!state.meta) return;
  const req = readForm();
  try {
    const res = await apiRaw(withGen(`/api/session/${state.meta.sessionId}/cutout/file`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const buf = await res.arrayBuffer();
    const blob = new Blob([buf], { type: 'application/fits' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cutout_ra${req.ra.toFixed(4)}_dec${req.dec.toFixed(4)}.fits`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) {
    showGlobalError(err);
  }
}

function setPreviewMeta(text) {
  const dl = $('preview-meta');
  dl.innerHTML = '';
  const dt = document.createElement('dt'); dt.textContent = '裁切';
  const dd = document.createElement('dd'); dd.textContent = text;
  dl.append(dt, dd);
}

/* --------------------------------- Meta/UI -------------------------------- */

function fillMeta(meta, label) {
  const rows = [
    ['文件', label || '本机上传'],
    ['BITPIX', String(meta.bitpix)],
    ['尺寸', `${meta.width} × ${meta.height} px`],
    ['BSCALE/BZERO', `${meta.bscale} / ${meta.bzero}`],
    ['BLANK', meta.blank === null ? '无（浮点 NaN 表示缺失）' : String(meta.blank)],
    ['CRPIX', `[${meta.crpix[0].toFixed(2)}, ${meta.crpix[1].toFixed(2)}]`],
    ['CRVAL', `[${meta.crval[0].toFixed(4)}°, ${meta.crval[1].toFixed(4)}°]`],
    ['CD', `[[${meta.cd[0].map((v) => v.toExponential(3)).join(', ')}], [${meta.cd[1].map((v) => v.toExponential(3)).join(', ')}]]`],
  ];
  const dl = $('meta');
  dl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
}

let globalErrorTimer = null;
function showGlobalError(err) {
  const el = $('global-error');
  const code = err.code || 'ERROR';
  el.textContent = `❌ ${ERROR_TEXT[code] || '请求失败'}：${err.message}`;
  el.hidden = false;
  clearTimeout(globalErrorTimer);
  globalErrorTimer = setTimeout(() => { el.hidden = true; }, 10_000);
}
function clearGlobalError() { $('global-error').hidden = true; }

function setBusy(on) { $('busy').hidden = !on; }

/* --------------------------------- Wiring --------------------------------- */

$('pick-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async () => {
  const f = $('file-input').files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  await loadFits(buf, f.name);
  $('file-input').value = '';
});
$('sample-btn').addEventListener('click', () => loadSample('int16', '代码生成样本 (Int16)'));
$('sample-float-btn').addEventListener('click', () => loadSample('float32', '代码生成样本 (Float32, RA=0)'));

$('tool-pan').addEventListener('click', () => setTool('pan'));
$('tool-select').addEventListener('click', () => setTool('select'));
function setTool(t) {
  state.tool = t;
  $('tool-pan').classList.toggle('active', t === 'pan');
  $('tool-select').classList.toggle('active', t === 'select');
}
$('grid-toggle').addEventListener('change', () => draw());
$('reset-view').addEventListener('click', () => resetView());

for (const id of ['f-ra', 'f-dec', 'f-width', 'f-height', 'f-outw', 'f-outh']) {
  $(id).addEventListener('input', () => { updatePendingHint(); schedulePreview(); });
}
$('preview-btn').addEventListener('click', () => requestPreview().catch(showGlobalError));
$('download-btn').addEventListener('click', () => downloadCutout());

// Release in-memory bytes when the tab is closed / navigated away.
window.addEventListener('pagehide', () => {
  if (state.meta) {
    navigator.sendBeacon(`/api/session/${state.meta.sessionId}/release`);
  }
});

resizeCanvas();
new ResizeObserver(() => { resizeCanvas(); if (state.meta) draw(); }).observe($('canvas-wrap'));
