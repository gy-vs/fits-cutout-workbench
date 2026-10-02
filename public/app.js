// Front-end controller. Important invariants:
//  - The page never converts screen pixels to degrees itself. Pixel<->sky math
//    only happens server-side; here screen->source-pixel is a simple linear
//    zoom/pan transform, and source-pixel->sky always goes through an API.
//  - Every async response carries/derives from a session id + monotonic seq;
//    responses belonging to an older file or older region are discarded, and
//    in-flight obsolete requests are aborted (plus server-side 409).
const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $('fileInput'), pickBtn: $('pickBtn'), fileName: $('fileName'),
  releaseBtn: $('releaseBtn'), limits: $('limits'), banner: $('banner'),
  wrap: $('canvasWrap'), canvas: $('mainCanvas'), dropzone: $('dropzone'),
  hint: $('hint'), readout: $('readout'),
  roPixel: $('roPixel'), roValue: $('roValue'), roRa: $('roRa'), roDec: $('roDec'),
  inRa: $('inRa'), inDec: $('inDec'), inW: $('inW'), inH: $('inH'),
  inOW: $('inOW'), inOH: $('inOH'), regionNote: $('regionNote'),
  rectInfo: $('rectInfo'), suggested: $('suggested'),
  pvCanvas: $('previewCanvas'), previewMeta: $('previewMeta'),
  resSize: $('resSize'), resNaN: $('resNaN'), resCrpix: $('resCrpix'),
  resCenter: $('resCenter'), downloadBtn: $('downloadBtn')
};

const state = {
  session: null,
  overview: null, // {width,height,scale,vmin,vmax,ImageData?}
  grid: null,
  view: { scale: 1, tx: 0, ty: 0 }, // screen = srcpx * scale + translate
  rect: null,      // {x0,y0,x1,y1} in source pixels (0-based edges)
  drag: null,
  hover: { x: -1, y: -1 },
  region: null,    // latest server region description
  job: null,       // latest accepted cutout response
  gen: 0,          // bumped only on file replacement
  regionToken: 0,  // monotonic token for region/cutout supersession
  uploadSeq: 0
};

let config = { maxUploadBytes: 64 * 1024 * 1024 };
fetch('/api/config').then((r) => r.json()).then((c) => {
  config = c;
  els.limits.textContent =
    `上传上限 ${(c.maxUploadBytes / 1024 / 1024).toFixed(0)} MiB · 输出上限 ${c.maxOutputSide}px/边`;
}).catch(() => {});

const ERROR_TEXT = {
  EMPTY_UPLOAD: '上传内容为空。',
  PAYLOAD_TOO_LARGE: '文件超过服务器上传上限，已拒绝。',
  UNSUPPORTED_MEDIA: '上传类型不被接受，请发送 FITS 二进制。',
  MALFORMED_HEADER: 'FITS 头畸形（80 字节卡片/引号/END 对齐不符合规范）。',
  NOT_PRIMARY_IMAGE: '不是标准 primary image HDU。',
  UNSUPPORTED_BITPIX: '仅支持 BITPIX=16 或 BITPIX=-32。',
  UNSUPPORTED_NAXIS: '仅支持 NAXIS=2 的二维图像。',
  MISSING_WCS: '缺少 CRPIX/CRVAL/CD 等必需 WCS 关键字。',
  UNSUPPORTED_WCS_CONVENTION: '不支持 CDELT + PC 矩阵约定：本工作台仅接受 CD 矩阵，为避免错误坐标已拒绝。',
  UNSUPPORTED_PROJECTION: '仅支持 RA/DEC 的 TAN（gnomonic）投影。',
  SINGULAR_CD_MATRIX: 'CD 矩阵不可逆（行列式为零），无法建立像素↔天球坐标。',
  INVALID_WCS_VALUE: 'WCS 数值非法。',
  DIMENSION_PRODUCT_OVERFLOW: 'NAXIS1×NAXIS2 乘积溢出，拒绝处理。',
  TRUNCATED_DATA: '像素数据被截断，文件不完整。',
  SESSION_NOT_FOUND: '当前文件会话已失效（可能已被释放），请重新上传。',
  BAD_REQUEST: '请求参数有误。',
  OUTPUT_TOO_LARGE: '请求的输出像素尺寸超过上限。',
  REGION_OUTSIDE_HEMISPHERE: '该区域落在 TAN 可见半球之外，无法逆投影/导出。',
  STALE_RESPONSE: '旧切片请求的结果已被丢弃（已被更新的区域取代）。',
  INTERNAL: '服务器内部错误。'
};

function banner(kind, msg, detail = '') {
  els.banner.hidden = false;
  els.banner.className = `banner ${kind}`;
  els.banner.textContent = detail ? `${msg}（${detail}）` : msg;
}
function clearBanner() { els.banner.hidden = true; els.banner.textContent = ''; }

// ---------- upload lifecycle ----------
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files[0]) loadFile(els.fileInput.files[0]);
});
['dragenter', 'dragover'].forEach((ev) => els.wrap.addEventListener(ev, (e) => {
  e.preventDefault(); els.dropzone.classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => els.wrap.addEventListener(ev, (e) => {
  e.preventDefault(); els.dropzone.classList.remove('drag');
}));
els.wrap.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

async function loadFile(file) {
  if (file.size > config.maxUploadBytes) {
    banner('err', ERROR_TEXT.PAYLOAD_TOO_LARGE, `${file.size} 字节`);
    return;
  }
  banner('info', `正在上传与解析 ${file.name} …`);
  const myUpload = ++state.uploadSeq;
  state.gen++; // invalidate every response from the previous file
  state.regionToken++;
  cutoutSeq = 0; // server tracks seq per session
  state.session = null; state.overview = null; state.grid = null;
  _ovCanvas = null;
  state.rect = null; state.region = null; state.job = null;
  resetResultUi();
  try {
    const res = await fetch('/api/fits', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': file.name
      },
      body: file
    });
    if (myUpload !== state.uploadSeq) return; // replaced while uploading
    if (!res.ok) return showHttpError(res);
    const meta = await res.json();
    state.session = meta;
    els.fileName.textContent = `${file.name} — ${meta.width}×${meta.height}, BITPIX=${meta.bitpix}`;
    els.releaseBtn.disabled = false;
    els.dropzone.style.display = 'none';
    els.hint.hidden = false;
    clearBanner();
    await Promise.all([fetchOverview(meta), fetchGrid(meta)]);
    initViewAndRect(meta);
    draw();
    requestRegion(true);
  } catch (err) {
    if (myUpload === state.uploadSeq) banner('err', '上传失败：', err.message);
  }
}

async function fetchOverview(meta) {
  const res = await fetch(meta.endpoints.overview);
  if (!res.ok) return showHttpError(res);
  const w = Number(res.headers.get('x-width'));
  const h = Number(res.headers.get('x-height'));
  const vmin = Number(res.headers.get('x-vmin'));
  const vmax = Number(res.headers.get('x-vmax'));
  const buf = await res.arrayBuffer();
  const floats = new Float32Array(buf);
  state.overview = { width: w, height: h, vmin, vmax, floats };
}
async function fetchGrid(meta) {
  const res = await fetch(meta.endpoints.grid);
  if (!res.ok) return showHttpError(res);
  state.grid = await res.json();
}

function resetResultUi() {
  els.previewMeta.textContent = '尚无数值结果';
  const ctx = els.pvCanvas.getContext('2d');
  ctx.clearRect(0, 0, els.pvCanvas.width, els.pvCanvas.height);
  ['resSize', 'resNaN', 'resCrpix', 'resCenter', 'rectInfo', 'suggested',
   'roPixel', 'roValue', 'roRa', 'roDec'].forEach((k) => (els[k].textContent = '—'));
  els.downloadBtn.disabled = true;
  ['inRa', 'inDec', 'inW', 'inH', 'inOW', 'inOH'].forEach((k) => (els[k].value = ''));
}

async function showHttpError(res) {
  let info = {};
  try { info = await res.json(); } catch {}
  const text = ERROR_TEXT[info.error] || `请求失败（HTTP ${res.status}）`;
  banner(res.status === 409 ? 'info' : 'err', text, info.error && ERROR_TEXT[info.error] ? info.error : info.message || '');
  return null;
}

// ---------- view / coordinate transforms ----------
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = els.wrap.getBoundingClientRect();
  els.canvas.width = Math.max(1, Math.round(r.width * dpr));
  els.canvas.height = Math.max(1, Math.round(r.height * dpr));
  els.canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
window.addEventListener('resize', resizeCanvas);

function initViewAndRect(meta) {
  const r = els.wrap.getBoundingClientRect();
  const scale = Math.min(r.width / meta.width, r.height / meta.height) * 0.92;
  state.view.scale = scale;
  state.view.tx = (r.width - meta.width * scale) / 2;
  state.view.ty = (r.height - meta.height * scale) / 2;
  // Initial cutout: centered 30% of the image.
  const rw = meta.width * 0.3, rh = meta.height * 0.3;
  state.rect = {
    x0: (meta.width - rw) / 2, y0: (meta.height - rh) / 2,
    x1: (meta.width + rw) / 2, y1: (meta.height + rh) / 2
  };
}
const toScreenX = (x) => x * state.view.scale + state.view.tx;
const toScreenY = (y) => y * state.view.scale + state.view.ty;
const toSrcX = (sx) => (sx - state.view.tx) / state.view.scale;
const toSrcY = (sy) => (sy - state.view.ty) / state.view.scale;

// ---------- drawing ----------
function stretch(v, vmin, vmax) {
  if (!Number.isFinite(v)) return -1; // missing
  let t = (v - vmin) / (vmax - vmin);
  t = Math.max(0, Math.min(1, t));
  // Square-root-ish grayscale for nicer sky background.
  return Math.sqrt(t);
}

function draw() {
  const ctx = els.canvas.getContext('2d');
  const r = els.wrap.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  if (!state.session || !state.overview) return;
  const { width: iw, height: ih } = state.session;
  const ov = state.overview;

  // checkerboard behind image marks missing coverage / outside footprint
  ctx.fillStyle = '#0a0e17';
  ctx.fillRect(0, 0, r.width, r.height);

  // Paint overview via a small ImageData in overview resolution, scaled up.
  const img = overviewImage(ov);
  const sx = toScreenX(0), sy = toScreenY(0);
  const sw = iw * state.view.scale, sh = ih * state.view.scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(img, sx, sy, sw, sh);
  // image border
  ctx.strokeStyle = '#3a4a70';
  ctx.lineWidth = 1;
  ctx.strokeRect(sx, sy, sw, sh);

  drawGrid(ctx);
  if (state.rect) drawRect(ctx);
}

let _ovCanvas = null;
function overviewImage(ov) {
  if (_ovCanvas && _ovCanvas.width === ov.width && _ovCanvas.height === ov.height
      && _ovCanvas._vmin === ov.vmin) return _ovCanvas;
  const c = document.createElement('canvas');
  c.width = ov.width; c.height = ov.height;
  const cctx = c.getContext('2d');
  const imgd = cctx.createImageData(ov.width, ov.height);
  for (let i = 0; i < ov.floats.length; i++) {
    const t = stretch(ov.floats[i], ov.vmin, ov.vmax);
    const o = i * 4;
    if (t < 0) {
      // missing blocks: magenta hatch color to read clearly as "no data"
      imgd.data[o] = 46; imgd.data[o + 1] = 12; imgd.data[o + 2] = 44; imgd.data[o + 3] = 255;
    } else {
      const g = Math.round(t * 235) + 20;
      imgd.data[o] = g; imgd.data[o + 1] = g; imgd.data[o + 2] = g + 6; imgd.data[o + 3] = 255;
    }
  }
  cctx.putImageData(imgd, 0, 0);
  c._vmin = ov.vmin;
  _ovCanvas = c;
  return c;
}

function drawGrid(ctx) {
  if (!state.grid) return;
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  const drawLines = (lines, color, isRa) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    for (const seg of lines) {
      ctx.beginPath();
      let started = false;
      for (const [x, y] of seg.points) {
        const px = toScreenX(x), py = toScreenY(y);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
      // label at first point of first segment per degree
    }
  };
  drawLines(state.grid.raLines, 'rgba(120,170,255,.55)', true);
  drawLines(state.grid.decLines, 'rgba(255,180,120,.5)', false);
  // labels
  ctx.fillStyle = 'rgba(150,190,255,.9)';
  for (const seg of state.grid.raLines) {
    if (!seg.points.length) continue;
    const [x, y] = seg.points[0];
    ctx.fillText(`RA ${formatDeg(seg.deg)}`, toScreenX(x) + 2, toScreenY(y) - 2);
  }
  ctx.fillStyle = 'rgba(255,196,150,.9)';
  for (const seg of state.grid.decLines) {
    if (!seg.points.length) continue;
    const [x, y] = seg.points[0];
    ctx.fillText(`Dec ${formatDeg(seg.deg)}`, toScreenX(x) + 2, toScreenY(y) - 2);
  }
}
function formatDeg(d) {
  return (Math.round(d * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') + '°';
}

function drawRect(ctx) {
  const { x0, y0, x1, y1 } = state.rect;
  const X = toScreenX(Math.min(x0, x1)), Y = toScreenY(Math.min(y0, y1));
  const W = Math.abs(x1 - x0) * state.view.scale, H = Math.abs(y1 - y0) * state.view.scale;
  // dim outside
  const r = els.wrap.getBoundingClientRect();
  ctx.fillStyle = 'rgba(6,10,18,.55)';
  ctx.fillRect(0, 0, r.width, Y);
  ctx.fillRect(0, Y + H, r.width, r.height - Y - H);
  ctx.fillRect(0, Y, X, H);
  ctx.fillRect(X + W, Y, r.width - X - W, H);

  ctx.strokeStyle = '#ffb454';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.strokeRect(X, Y, W, H);
  // footprint of actual server cutout (may differ near edges / rotation)
  if (state.job && state.job.srcCorners) {
    ctx.strokeStyle = 'rgba(76,195,138,.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const cs = state.job.srcCorners;
    cs.forEach((p, i) => {
      if (!p) return;
      const px = toScreenX(p[0]), py = toScreenY(p[1]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();
  }
  // handles
  ctx.fillStyle = '#ffb454';
  const hs = 6;
  for (const [hx, hy] of [[X, Y], [X + W, Y], [X + W, Y + H], [X, Y + H]]) {
    ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
  }
  ctx.fillStyle = '#ffd8a0';
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText('待导出', X + 4, Y - 5);
  if (state.job) ctx.fillText('服务端实际裁切', X + 4, Y + H + 14);
}

// ---------- pointer interaction ----------
function eventPos(e) {
  const r = els.canvas.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}
function hitHandle(rect, sx, sy) {
  const pts = [
    ['x0', 'y0'], ['x1', 'y0'], ['x1', 'y1'], ['x0', 'y1']
  ];
  for (const [kx, ky] of pts) {
    const px = toScreenX(rect[kx]), py = toScreenY(rect[ky]);
    if (Math.abs(sx - px) < 7 && Math.abs(sy - py) < 7) return { kx, ky };
  }
  return null;
}
function insideRect(rect, sx, sy) {
  const x = toSrcX(sx), y = toSrcY(sy);
  return x >= Math.min(rect.x0, rect.x1) && x <= Math.max(rect.x0, rect.x1)
      && y >= Math.min(rect.y0, rect.y1) && y <= Math.max(rect.y0, rect.y1);
}

els.canvas.addEventListener('mousedown', (e) => {
  if (!state.session) return;
  e.preventDefault();
  const { sx, sy } = eventPos(e);
  const handle = state.rect && hitHandle(state.rect, sx, sy);
  const newBox = e.ctrlKey || e.metaKey;
  if (handle) {
    state.drag = { mode: 'resize', kx: handle.kx, ky: handle.ky };
  } else if (!newBox && insideRect(state.rect, sx, sy)) {
    state.drag = { mode: 'move', startS: { sx, sy }, orig: { ...state.rect } };
  } else if (newBox) {
    const x = toSrcX(sx), y = toSrcY(sy);
    state.rect = { x0: x, y0: y, x1: x, y1: y };
    state.drag = { mode: 'draw' };
  } else {
    state.drag = { mode: 'pan', startS: { sx, sy }, origView: { ...state.view } };
  }
});
window.addEventListener('mousemove', (e) => {
  const { sx, sy } = eventPos(e);
  if (state.drag) {
    const d = state.drag;
    if (d.mode === 'pan') {
      state.view.tx = d.origView.tx + (sx - d.startS.sx);
      state.view.ty = d.origView.ty + (sy - d.startS.sy);
    } else if (state.drag && state.session) {
      const x = toSrcX(sx), y = toSrcY(sy);
      const clampX = (v) => Math.max(-state.session.width * .1, Math.min(state.session.width * 1.1, v));
      const clampY = (v) => Math.max(-state.session.height * .1, Math.min(state.session.height * 1.1, v));
      if (d.mode === 'move') {
        const dx = toSrcX(sx) - toSrcX(d.startS.sx);
        const dy = toSrcY(sy) - toSrcY(d.startS.sy);
        state.rect = {
          x0: clampX(d.orig.x0 + dx), y0: clampY(d.orig.y0 + dy),
          x1: clampX(d.orig.x1 + dx), y1: clampY(d.orig.y1 + dy)
        };
      } else if (d.mode === 'resize') {
        state.rect[d.kx] = clampX(x);
        state.rect[d.ky] = clampY(y);
      } else if (d.mode === 'draw') {
        state.rect.x1 = clampX(x); state.rect.y1 = clampY(y);
      }
      scheduleRegion();
    }
    draw();
    return;
  }
  if (state.session) updateHover(sx, sy);
});
window.addEventListener('mouseup', () => {
  if (state.drag && state.drag.mode !== 'pan') scheduleRegion(true);
  state.drag = null;
});

els.canvas.addEventListener('wheel', (e) => {
  if (!state.session) return;
  e.preventDefault();
  const { sx, sy } = eventPos(e);
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const px = toSrcX(sx), py = toSrcY(sy);
  state.view.scale = Math.max(0.05, Math.min(40, state.view.scale * factor));
  state.view.tx = sx - px * state.view.scale;
  state.view.ty = sy - py * state.view.scale;
  draw();
}, { passive: false });

els.canvas.addEventListener('dblclick', () => {
  if (state.session) { initViewAndRect(state.session); draw(); scheduleRegion(true); }
});

// ---------- hover readout (server pixel+sky) ----------
let hoverAbort = null;
let hoverTimer = 0;
function updateHover(sx, sy) {
  const x = Math.floor(toSrcX(sx)), y = Math.floor(toSrcY(sy));
  if (x === state.hover.x && y === state.hover.y) return;
  state.hover = { x, y };
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => queryPoint(x, y), 45);
}
async function queryPoint(x, y) {
  const gen = state.gen;
  if (hoverAbort) hoverAbort.abort();
  hoverAbort = new AbortController();
  els.roPixel.textContent = `${x}, ${y}`;
  if (!state.session) return;
  if (x < 0 || y < 0 || x >= state.session.width || y >= state.session.height) {
    els.roValue.textContent = '（图像外）';
    els.roRa.textContent = '—'; els.roDec.textContent = '—';
    return;
  }
  try {
    const res = await fetch(`/api/fits/${state.session.id}/point?x=${x}&y=${y}`,
      { signal: hoverAbort.signal });
    if (gen !== state.gen) return;
    const d = await res.json();
    if (gen !== state.gen) return;
    if (d.missing) els.roValue.textContent = '缺失 (BLANK/NaN)';
    else els.roValue.textContent = d.value === null ? '—' : d.value.toPrecision(7);
    if (d.sky) {
      els.roRa.textContent = `${d.sky.ra.toFixed(6)}°`;
      els.roDec.textContent = `${d.sky.dec.toFixed(6)}°`;
    }
  } catch (err) {
    if (err.name !== 'AbortError') els.roValue.textContent = '读取失败';
  }
}

// ---------- region description (debounced) ----------
let regionTimer = 0;
let regionAbort = null;
function scheduleRegion(immediate = false) {
  if (!state.session || !state.rect) return;
  clearTimeout(regionTimer);
  const delay = immediate ? 0 : 120;
  regionTimer = setTimeout(() => requestRegion(false), delay);
}

async function requestRegion(initial) {
  if (regionAbort) regionAbort.abort();
  regionAbort = new AbortController();
  const gen = state.gen;
  // Region/cutout supersession uses a dedicated monotonic token: a newer
  // region invalidates an older region's response WITHOUT invalidating the
  // whole session (file replacement is the only thing that bumps state.gen).
  const regionToken = ++state.regionToken;
  const rect = normalizedRect();
  els.rectInfo.textContent =
    `x[${rect.x0.toFixed(1)}, ${rect.x1.toFixed(1)}) y[${rect.y0.toFixed(1)}, ${rect.y1.toFixed(1)})`;
  try {
    const res = await fetch(`/api/fits/${state.session.id}/region`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rect }),
      signal: regionAbort.signal
    });
    if (!res.ok) {
      if (res.status === 409 || gen !== state.gen || regionToken !== state.regionToken) return;
      const d = await res.json().catch(() => ({}));
      state.region = null;
      const text = ERROR_TEXT[d.error] || d.message || '区域计算失败';
      els.regionNote.textContent = text;
      banner('warn', text, d.error || '');
      return;
    }
    const d = await res.json();
    if (gen !== state.gen || regionToken !== state.regionToken) return;
    state.region = d;
    els.inRa.value = d.center.ra.toFixed(7);
    els.inDec.value = d.center.dec.toFixed(7);
    els.inW.value = d.angularSize.width.toFixed(7);
    els.inH.value = d.angularSize.height.toFixed(7);
    els.inOW.value = d.suggestedPixels.width;
    els.inOH.value = d.suggestedPixels.height;
    els.suggested.textContent = `${d.suggestedPixels.width} × ${d.suggestedPixels.height} px（按源像素网格）`;
    const notes = [];
    if (d.hemisphereClipped) notes.push('部分边缘落在 TAN 可见半球之外，将记为缺失');
    if (!d.boundsInsideImage) notes.push('区域超出图像边界，越界像素记为缺失');
    els.regionNote.textContent = notes.join('；');
    requestCutout(regionToken);
  } catch (err) {
    if (err.name !== 'AbortError' && gen === state.gen && regionToken === state.regionToken) {
      els.regionNote.textContent = '区域请求失败：' + err.message;
    }
  }
}

function normalizedRect() {
  const r = state.rect;
  return {
    x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1)
  };
}

// ---------- cutout request with stale protection ----------
let cutoutAbort = null;
let cutoutSeq = 0;
function requestCutout(callerToken = state.regionToken) {
  if (!state.region) return;
  const ra = Number(els.inRa.value), dec = Number(els.inDec.value);
  const wDeg = Number(els.inW.value), hDeg = Number(els.inH.value);
  const outW = Math.round(Number(els.inOW.value)), outH = Math.round(Number(els.inOH.value));
  if (![ra, dec, wDeg, hDeg, outW, outH].every(Number.isFinite) || outW < 1 || outH < 1) {
    els.regionNote.textContent = '请检查中心/角尺寸/输出像素输入';
    return;
  }
  doCutout({ ra, dec, wDeg, hDeg, outW, outH }, callerToken);
}

async function doCutout(params, callerToken = state.regionToken) {
  if (cutoutAbort) cutoutAbort.abort();
  cutoutAbort = new AbortController();
  const gen = state.gen;
  const token = callerToken;
  const seq = ++cutoutSeq;
  const q = new URLSearchParams({
    ra: params.ra, dec: params.dec, widthDeg: params.wDeg, heightDeg: params.hDeg,
    outW: params.outW, outH: params.outH, seq
  });
  els.previewMeta.textContent = `计算中… (#${seq})`;
  try {
    const res = await fetch(`/api/fits/${state.session.id}/cutout?${q}`, {
      method: 'POST', signal: cutoutAbort.signal
    });
    if (!res.ok) {
      if (res.status === 409) return; // explicitly superseded on the server
      const d = await res.json().catch(() => ({}));
      if (gen !== state.gen || token !== state.regionToken) return;
      banner('err', ERROR_TEXT[d.error] || '切片失败', d.error || '');
      return;
    }
    const d = await res.json();
    // Drop stale results: replaced file, newer region, or reordered seq.
    if (gen !== state.gen || token !== state.regionToken || d.seq !== seq) return;
    state.job = d;
    await paintJobPreview(d, gen, token);
    els.resSize.textContent = `${d.outW} × ${d.outH} px`;
    els.resNaN.textContent = `${(d.nanFraction * 100).toFixed(2)}%（${d.finiteCount} 有效）`;
    els.resCrpix.textContent = `(${d.crpix[0].toFixed(3)}, ${d.crpix[1].toFixed(3)})`;
    els.resCenter.textContent = `RA ${d.center.ra.toFixed(6)}° Dec ${d.center.dec.toFixed(6)}°`;
    els.downloadBtn.disabled = false;
    clearBanner();
    draw();
  } catch (err) {
    if (err.name !== 'AbortError' && gen === state.gen && token === state.regionToken) {
      banner('err', '切片请求失败', err.message);
    }
  }
}

async function paintJobPreview(d, gen, token) {
  const res = await fetch(d.preview.url);
  if (!res.ok || gen !== state.gen || token !== state.regionToken) return;
  const w = Number(res.headers.get('x-width'));
  const h = Number(res.headers.get('x-height'));
  const vmin = Number(res.headers.get('x-vmin'));
  const vmax = Number(res.headers.get('x-vmax'));
  const buf = await res.arrayBuffer();
  if (gen !== state.gen || token !== state.regionToken) return;
  const floats = new Float32Array(buf);
  const c = els.pvCanvas;
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const imgd = ctx.createImageData(w, h);
  for (let i = 0; i < floats.length; i++) {
    const t = stretch(floats[i], vmin, vmax);
    const o = i * 4;
    if (t < 0) {
      imgd.data[o] = 46; imgd.data[o + 1] = 12; imgd.data[o + 2] = 44; imgd.data[o + 3] = 255;
    } else {
      const g = Math.round(t * 235) + 20;
      imgd.data[o] = g; imgd.data[o + 1] = g; imgd.data[o + 2] = g + 6; imgd.data[o + 3] = 255;
    }
  }
  ctx.putImageData(imgd, 0, 0);
  els.previewMeta.textContent = `服务端像素 ${w}×${h}`;
}

// Manual edits to the numeric inputs: apply on change/blur/Enter.
['inRa', 'inDec', 'inW', 'inH', 'inOW', 'inOH'].forEach((k) => {
  els[k].addEventListener('change', () => {
    if (state.session) requestCutoutFromInputs();
  });
  els[k].addEventListener('keydown', (e) => {
    if (e.key === 'Enter') requestCutoutFromInputs();
  });
});
function requestCutoutFromInputs() {
  // Manual numeric edits supersede prior auto cutouts but don't move the rect.
  state.regionToken++;
  doCutout({
    ra: Number(els.inRa.value), dec: Number(els.inDec.value),
    wDeg: Number(els.inW.value), hDeg: Number(els.inH.value),
    outW: Number(els.inOW.value), outH: Number(els.inOH.value)
  }, state.regionToken);
}

// ---------- download / release ----------
els.downloadBtn.addEventListener('click', () => {
  if (!state.job) return;
  const a = document.createElement('a');
  a.href = state.job.downloadUrl;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
});

els.releaseBtn.addEventListener('click', releaseCurrent);
async function releaseCurrent() {
  const s = state.session;
  state.gen++;
  if (s) {
    // Beacon keeps the release reliable even during actual unload; here also
    // await it for immediate UI reset.
    try { await fetch(s.endpoints.release, { method: 'POST', keepalive: true }); } catch {}
  }
  state.session = null; state.overview = null; state.grid = null;
  _ovCanvas = null;
  state.rect = null; state.region = null; state.job = null;
  els.fileName.textContent = '未选择文件（仅支持 BITPIX=16/-32、NAXIS=2、CD+TAN）';
  els.releaseBtn.disabled = true;
  els.dropzone.style.display = 'flex';
  els.hint.hidden = true;
  els.fileInput.value = '';
  resetResultUi();
  resizeCanvas();
  banner('ok', '已释放当前文件占用的内存。');
}
window.addEventListener('pagehide', () => {
  const s = state.session;
  if (s) navigator.sendBeacon(`/api/fits/${s.id}/release`);
});

resizeCanvas();
