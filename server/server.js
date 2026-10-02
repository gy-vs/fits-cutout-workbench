// Local-only HTTP workbench. No framework, no database, no network egress:
// uploaded bytes live in memory of this process and are released on replace,
// explicit release, idle eviction, or process exit.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { readFileSync } from 'node:fs';
import { parsePrimaryImage } from '../lib/fits-parser.js';
import { errorBody, fail, FitsError } from '../lib/errors.js';
import { SessionStore } from '../lib/sessions.js';
import { makePixelReader } from '../lib/pixels.js';
import { materializeCutout } from '../lib/pixels.js';
import { describeRegion, validateCutoutParams, previewFloat32 } from '../lib/cutout.js';
import { writeFloatFits } from '../lib/fits-writer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');

const MAX_UPLOAD_BYTES = (() => {
  const v = Number(process.env.MAX_UPLOAD_MB);
  return Number.isFinite(v) && v > 0 ? v * 1024 * 1024 : 64 * 1024 * 1024;
})();

export const CONFIG = Object.freeze({
  maxUploadBytes: MAX_UPLOAD_BYTES,
  maxOutputSide: 2048,
  maxOutputPixels: 4_000_000,
  idleTtlMinutes: 30
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

export function createServer({ store = new SessionStore() } = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res, store).catch((err) => {
      const { status, body } = errorBody(err);
      sendJson(res, status, body);
    });
  });
  server.on('close', () => store.close());
  return server;
}

async function handle(req, res, store) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/config') {
    return sendJson(res, 200, CONFIG);
  }
  if (method === 'POST' && p === '/api/fits') {
    return upload(req, res, store);
  }
  const fitsMatch = p.match(/^\/api\/fits\/([A-Za-z0-9_-]+)(\/(overview|grid|point|region|cutout|release))?$/);
  if (fitsMatch) {
    const [, id, , sub] = fitsMatch;
    if (sub === 'overview' && method === 'GET') return overview(id, res, store);
    if (sub === 'grid' && method === 'GET') return grid(id, res, store);
    if (sub === 'point' && method === 'GET') return point(id, url, res, store);
    if (sub === 'region' && method === 'POST') return region(id, req, res, store);
    if (sub === 'cutout' && method === 'POST') return cutout(id, req, url, res, store);
    if (sub === 'release' && (method === 'POST' || method === 'DELETE')) return release(id, res, store);
    if (!sub && method === 'GET') return meta(id, res, store);
    throw fail('BAD_REQUEST', `不支持的操作 ${method} ${p}`);
  }
  const jobMatch = p.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)(\/(preview|download))?$/);
  if (jobMatch && method === 'GET') {
    const [, jobId, , sub] = jobMatch;
    if (!sub) return jobMeta(jobId, res, store);
    if (sub === 'preview') return jobPreview(jobId, res, store);
    if (sub === 'download') return jobDownload(jobId, res, store);
  }
  if (method === 'GET') return staticFile(p, res);
  throw fail('BAD_REQUEST', `未知接口 ${method} ${p}`);
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

async function readLimited(req, limit, contentTypeOk) {
  const declared = req.headers['content-length'];
  if (declared && Number(declared) > limit) {
    throw fail('PAYLOAD_TOO_LARGE', `上传大小 ${Number(declared)} 字节超过上限 ${limit} 字节`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      throw fail('PAYLOAD_TOO_LARGE', `上传数据超过上限 ${limit} 字节，已中止读取`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readLimited(req, 1024 * 1024);
  try { return JSON.parse(buf.toString('utf8') || '{}'); }
  catch { throw fail('BAD_REQUEST', '请求体不是合法 JSON'); }
}

async function upload(req, res, store) {
  const ctype = (req.headers['content-type'] || '').toLowerCase();
  if (!ctype.startsWith('application/octet-stream') && !ctype.startsWith('application/fits')
      && ctype !== '') {
    throw fail('UNSUPPORTED_MEDIA', `不支持的 Content-Type: ${req.headers['content-type']}，请直接发送 FITS 二进制`);
  }
  const buffer = await readLimited(req, CONFIG.maxUploadBytes);
  if (buffer.length === 0) throw fail('EMPTY_UPLOAD', '上传内容为空');
  // Strict parse: any unsupported convention or malformed header fails here and
  // nothing is stored.
  const image = parsePrimaryImage(buffer);
  const name = decodeName(req.headers['x-file-name']) || 'upload.fits';
  const session = store.create({ name, buffer, image });
  sendJson(res, 200, {
    id: session.id, name,
    width: image.width, height: image.height, bitpix: image.bitpix,
    bscale: image.bscale, bzero: image.bzero, blank: image.blank,
    wcs: {
      crpix: image.wcs.crpix, crval: image.wcs.crval, cd: image.wcs.cd,
      determinant: image.wcs.det
    },
    endpoints: {
      overview: `/api/fits/${session.id}/overview`,
      grid: `/api/fits/${session.id}/grid`,
      region: `/api/fits/${session.id}/region`,
      cutout: `/api/fits/${session.id}/cutout`,
      release: `/api/fits/${session.id}/release`
    }
  });
}

function decodeName(v) {
  if (!v) return null;
  try { return Buffer.from(v, 'latin1').toString('utf8'); } catch { return String(v); }
}

function sessionMeta(s) {
  return {
    id: s.id, name: s.name,
    width: s.image.width, height: s.image.height, bitpix: s.image.bitpix,
    bscale: s.image.bscale, bzero: s.image.bzero, blank: s.image.blank,
    wcs: {
      crpix: s.image.wcs.crpix, crval: s.image.wcs.crval,
      cd: s.image.wcs.cd, determinant: s.image.wcs.det
    }
  };
}

function meta(id, res, store) {
  sendJson(res, 200, sessionMeta(store.get(id)));
}

function overview(id, res, store) {
  const s = store.get(id);
  const ov = store.overview(id);
  const buf = Buffer.from(ov.values.buffer, ov.values.byteOffset, ov.values.byteLength);
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'x-width': String(ov.width), 'x-height': String(ov.height),
    'x-scale': String(ov.scale),
    'x-vmin': String(ov.vmin), 'x-vmax': String(ov.vmax),
    'x-nan-count': String(ov.nanCount),
    'content-length': buf.length,
    'cache-control': 'no-store'
  });
  res.end(buf);
}

function grid(id, res, store) {
  store.get(id);
  sendJson(res, 200, store.grid(id));
}

function point(id, url, res, store) {
  const s = store.get(id);
  const x = Number(url.searchParams.get('x'));
  const y = Number(url.searchParams.get('y'));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw fail('BAD_REQUEST', 'point 需要数字 x/y');
  const img = s.image;
  const inside = x >= 0 && y >= 0 && x < img.width && y < img.height;
  const ix = Math.floor(x), iy = Math.floor(y);
  const reader = makePixelReader(img);
  const value = inside ? reader(ix + 1, iy + 1) : NaN; // reader 用 FITS 1 基坐标
  const missing = inside && !Number.isFinite(value);
  // Sky coordinate at the pixel CENTER of the hovered source pixel.
  const sky = inside ? img.wcs.pixelToSky(ix + 1, iy + 1) : null;
  sendJson(res, 200, {
    pixel: { x: ix, y: iy },
    inside,
    value: Number.isFinite(value) ? value : null,
    missing,
    physicalRule: img.bitpix === 16
      ? `raw*BSCALE(${img.bscale})+BZERO(${img.bzero})；BLANK=${img.blank} 记为缺失`
      : 'IEEE float；NaN 记为缺失',
    sky: sky ? { ra: sky[0], dec: sky[1] } : null
  });
}

async function region(id, req, res, store) {
  const s = store.get(id);
  const body = await readJson(req);
  const rect = body.rect;
  if (!rect || !['x0', 'y0', 'x1', 'y1'].every((k) => Number.isFinite(Number(rect[k])))) {
    throw fail('BAD_REQUEST', 'region 需要 rect:{x0,y0,x1,y1}（0 基像素坐标）');
  }
  const norm = Object.fromEntries(Object.entries(rect).map(([k, v]) => [k, Number(v)]));
  const desc = describeRegion(s.image, norm);
  sendJson(res, 200, desc);
}

async function cutout(id, req, url, res, store) {
  const s = store.get(id);
  // The client bumps this token on every new file and every new region; the
  // server rejects computation whose result would arrive for an obsolete
  // request. Combined with client-side abort this keeps stale previews out.
  const seq = Number(url.searchParams.get('seq') || req.headers['x-cutout-seq']);
  if (!Number.isInteger(seq) || seq <= 0) throw fail('BAD_REQUEST', 'cutout 需要正整数 seq（请求序号）');
  // Drain (small JSON or empty) body first so the client can reuse the socket.
  if (req.headers['content-length'] && Number(req.headers['content-length']) > 0) {
    await readLimited(req, 64 * 1024);
  }
  s.latestCutoutSeq = Math.max(s.latestCutoutSeq, seq);
  const params = validateCutoutParams(Object.fromEntries(url.searchParams), s.image);

  const checkFresh = () => {
    if (s.latestCutoutSeq > seq) {
      throw staleError(seq, s.latestCutoutSeq);
    }
  };
  const check = () => { checkFresh(); };
  check.cancelled = false;
  const onProgress = () => {
    if (s.latestCutoutSeq > seq) {
      const e = staleError(seq, s.latestCutoutSeq);
      onProgress.cancelled = true;
      throw e;
    }
  };

  let result;
  try {
    result = await materializeCutout({ image: s.image, ...params, onProgress });
  } catch (err) {
    if (err && err.code === 'STALE_RESPONSE') {
      return sendJson(res, 409, { error: 'STALE_RESPONSE', message: err.message, seq, latest: s.latestCutoutSeq });
    }
    throw err;
  }
  checkFresh();

  const pv = previewFloat32(result.values, result.outW, result.outH);
  const fits = writeFloatFits({
    values: result.values, width: result.outW, height: result.outH,
    wcs: result.wcsOutput,
    history: [
      `cutout center RA=${params.centerSky[0].toFixed(8)} DEC=${params.centerSky[1].toFixed(8)} deg`,
      `size ${params.angularSize[0].toFixed(8)} x ${params.angularSize[1].toFixed(8)} deg`,
      `resampled ${s.image.width}x${s.image.height} -> ${result.outW}x${result.outH} bilinear`
    ]
  });
  const jobId = store.putJob(s.id, {
    sessionId: s.id,
    params,
    values: result.values,
    preview: pv,
    fits,
    srcCorners: result.srcCorners,
    wcsOutput: result.wcsOutput,
    nanCount: result.nanCount,
    finiteCount: result.finiteCount,
    seq
  });
  sendJson(res, 200, {
    jobId, seq,
    outW: result.outW, outH: result.outH,
    srcCorners: result.srcCorners,
    center: { ra: params.centerSky[0], dec: params.centerSky[1] },
    angularSize: { width: params.angularSize[0], height: params.angularSize[1] },
    nanFraction: result.nanCount / result.values.length,
    finiteCount: result.finiteCount,
    crpix: result.wcsOutput.crpix,
    crval: result.wcsOutput.crval,
    cd: result.wcsOutput.cd,
    preview: { width: pv.width, height: pv.height, vmin: pv.vmin, vmax: pv.vmax, url: `/api/jobs/${jobId}/preview` },
    downloadUrl: `/api/jobs/${jobId}/download`,
    fitsBytes: fits.length
  });
}

function staleError(seq, latest) {
  const e = new Error(`切片请求 seq=${seq} 已被更新的请求 seq=${latest} 取代，丢弃旧结果`);
  e.code = 'STALE_RESPONSE';
  e.status = 409;
  return e;
}

function findJob(store, jobId) {
  // Job ids encode no session; search across sessions (only newest kept).
  for (const session of store.sessions.values()) {
    if (session.jobs && session.jobs.has(jobId)) {
      return { session, job: session.jobs.get(jobId) };
    }
  }
  throw fail('SESSION_NOT_FOUND', '找不到该切片结果（文件可能已被替换）');
}

function jobMeta(jobId, res, store) {
  const { job } = findJob(store, jobId);
  sendJson(res, 200, {
    jobId, seq: job.seq,
    outW: job.values.length && Math.round(Math.sqrt(job.values.length)),
    params: job.params,
    wcs: job.wcsOutput,
    nanFraction: job.values.length ? job.nanCount / job.values.length : 0
  });
}

function jobPreview(jobId, res, store) {
  const { job } = findJob(store, jobId);
  const pv = job.preview;
  const buf = Buffer.from(pv.values.buffer, pv.values.byteOffset, pv.values.byteLength);
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'x-width': String(pv.width), 'x-height': String(pv.height),
    'x-vmin': String(pv.vmin), 'x-vmax': String(pv.vmax),
    'x-nan-fraction': String(pv.nanFraction),
    'content-length': buf.length, 'cache-control': 'no-store'
  });
  res.end(buf);
}

function jobDownload(jobId, res, store) {
  const { job, session } = findJob(store, jobId);
  const safe = (session.name || 'cutout').replace(/[^A-Za-z0-9._-]+/g, '_');
  res.writeHead(200, {
    'content-type': 'application/fits',
    'content-disposition': `attachment; filename="cutout_${jobId.slice(0, 8)}.fits"; filename*=UTF-8''${encodeURIComponent(safe.replace(/\.fits$/i, '') + '_cutout.fits')}`,
    'content-length': job.fits.length,
    'cache-control': 'no-store'
  });
  res.end(job.fits);
}

function release(id, res, store) {
  const existed = store.release(id);
  sendJson(res, existed ? 200 : 200, { id, released: existed });
}

function staticFile(p, res) {
  let rel = p === '/' ? '/index.html' : p;
  if (rel.includes('..')) throw fail('BAD_REQUEST', '非法路径');
  const full = join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC)) throw fail('BAD_REQUEST', '非法路径');
  let buf;
  try { buf = readFileSync(full); }
  catch { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
  res.end(buf);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  const server = createServer();
  server.listen(port, () => {
    console.log(`FITS 工作台已启动: http://localhost:${port}`);
    console.log(`上传上限 ${Math.round(CONFIG.maxUploadBytes / 1024 / 1024)} MiB；资源仅保存在本进程内存中。`);
  });
}
