/**
 * Local-only HTTP workbench server (Node built-ins only).
 *
 *   POST /api/sample/source           -> FITS bytes (generated test image)
 *   POST /api/upload?kind=int16|float -> JSON meta (FITS is the raw body)
 *   POST /api/session/:id/release     -> 204
 *   POST /api/session/:id/overview    -> PNG bytes
 *   POST /api/session/:id/grid        -> JSON polylines in source pixels
 *   POST /api/session/:id/sample-point?x=&y= -> JSON pixel + sky readout
 *   POST /api/session/:id/rectangle   -> JSON sky centre/size of a pixel box
 *   POST /api/session/:id/cutout/preview  (JSON body) -> JSON {png(base64)...}
 *   POST /api/session/:id/cutout/file     (JSON body) -> FITS bytes
 *
 * Stale-response protection: every mutable request accepts `gen`; the
 * server rejects mismatched generations, and long-running requests echo a
 * client-supplied `token` so the browser can discard superseded replies.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SessionStore, FitsError } from '../lib/session.js';
import { readPhysical } from '../lib/fits.js';
import { indexToSky } from '../lib/wcs.js';
import { buildGrid, formatRa, formatDecDms } from '../lib/grid.js';
import {
  validateCutoutRequest,
  resampleCutout,
  writeCutoutFits,
  renderCutoutPreview,
  rectangleSky,
} from '../lib/cutout.js';
import { makeSampleInt16, makeSampleFloat32 } from '../lib/sample.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const DEFAULT_MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.fits': 'application/fits',
  '.png': 'image/png',
};

export function createServer(options = {}) {
  const maxUpload = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD;
  const store = new SessionStore();

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, store, maxUpload);
    } catch (err) {
      sendError(res, err);
    }
  });

  server.localStore = store;
  return server;
}

async function route(req, res, store, maxUpload) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return serveFile(path.join(PUBLIC_DIR, 'index.html'), res);
  }
  if (req.method === 'GET' && p.startsWith('/')) {
    const rel = p.slice(1);
    if (!rel.includes('..')) {
      const file = path.join(PUBLIC_DIR, rel);
      if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return serveFile(file, res);
      }
    }
  }

  if (p === '/api/sample/source' && req.method === 'POST') {
    const kind = url.searchParams.get('kind') || 'int16';
    const sample = kind === 'float32' ? makeSampleFloat32() : makeSampleInt16();
    res.writeHead(200, { 'Content-Type': 'application/fits' });
    return res.end(sample.fits);
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const body = await readBody(req, res, maxUpload);
    if (body === null) return; // 413 already sent
    const id = crypto.randomBytes(16).toString('hex');
    const session = store.create(id, body);
    return sendJson(res, 200, sessionMeta(session));
  }

  const m = p.match(/^\/api\/session\/([0-9a-f]+)(\/[a-z-]+)?(\/[a-z-]+)?$/);
  if (!m || req.method !== 'POST') {
    throw new FitsError('NOT_FOUND', `未知接口：${req.method} ${p}`, 404);
  }
  const [, id, actionPart, subPart] = m;
  const action = (actionPart || '').slice(1);
  const sub = (subPart || '').slice(1);
  const gen = url.searchParams.has('gen') ? Number(url.searchParams.get('gen')) : null;

  if (action === 'release') {
    store.delete(id);
    res.writeHead(204);
    return res.end();
  }

  let session = store.getWithGeneration(id, gen);
  if (!session) {
    throw new FitsError('UNKNOWN_SESSION', '会话不存在或已被新上传替换，请重新选择文件', 404);
  }
  if (session.stale) {
    throw new FitsError('STALE_GENERATION', '这是针对旧图像的请求：文件已替换，结果已丢弃', 409);
  }

  switch (action) {
    case 'overview': {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(session.overview.png);
    }
    case 'grid': {
      const grid = buildGrid(session.wcs, session.image.width, session.image.height);
      return sendJson(res, 200, { token: tokenFor(req), grid });
    }
    case 'sample-point': {
      const x = Number(url.searchParams.get('x'));
      const y = Number(url.searchParams.get('y'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new FitsError('BAD_REQUEST', 'x/y 必须是数字');
      }
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const physical = readPhysical(session.image, xi, yi);
      const sky = indexToSky(session.wcs, xi, yi);
      return sendJson(res, 200, {
        token: tokenFor(req),
        pixel: { x: xi, y: yi },
        physical: physical === null ? null : physical,
        missing: physical === null,
        bscale: session.image.bscale,
        bzero: session.image.bzero,
        sky: sky
          ? {
              ra: sky.ra,
              dec: sky.dec,
              raText: formatRa(sky.ra),
              decText: formatDecDms(sky.dec),
            }
          : null,
      });
    }
    case 'rectangle': {
      const body = await readJson(req, res);
      if (body === null) return;
      const { x0, y0, x1, y1 } = body;
      for (const v of [x0, y0, x1, y1]) {
        if (!Number.isInteger(v)) throw new FitsError('BAD_REQUEST', '矩形坐标必须是整数像素');
      }
      if (x0 === x1 || y0 === y1) throw new FitsError('BAD_REQUEST', '矩形宽高不能为零');
      const info = rectangleSky(session.wcs, x0, y0, x1, y1);
      return sendJson(res, 200, { token: tokenFor(req), ...info });
    }
    case 'cutout': {
      const body = await readJson(req, res);
      if (body === null) return;
      const creq = validateCutoutRequest(body);
      const sampled = resampleCutout(session.image, session.wcs, creq);
      if (sub === 'preview') {
        const preview = renderCutoutPreview(creq, sampled, 300);
        return sendJson(res, 200, {
          token: body.token ?? tokenFor(req),
          request: creq,
          png: preview.png.toString('base64'),
          width: preview.width,
          height: preview.height,
          vmin: preview.vmin,
          vmax: preview.vmax,
          coverage: {
            valid: sampled.valid,
            total: creq.outW * creq.outH,
            missingSource: sampled.missingSource,
            outside: sampled.outside,
            offHemisphere: sampled.offHemisphere,
          },
        });
      }
      if (sub === 'file') {
        const fits = writeCutoutFits(session.image, creq, sampled);
        const name = `cutout_ra${creq.ra.toFixed(4)}_dec${creq.dec.toFixed(4)}.fits`;
        res.writeHead(200, {
          'Content-Type': 'application/fits',
          'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        });
        return res.end(fits);
      }
      throw new FitsError('NOT_FOUND', `未知切片操作：${sub}`, 404);
    }
    default:
      throw new FitsError('NOT_FOUND', `未知操作：${action}`, 404);
  }
}

function tokenFor(req) {
  return new URL(req.url, 'http://localhost').searchParams.get('token') || null;
}

function sessionMeta(s) {
  const { image, wcs, overview } = s;
  return {
    sessionId: s.id,
    generation: s.generation,
    bitpix: image.bitpix,
    width: image.width,
    height: image.height,
    bscale: image.bscale,
    bzero: image.bzero,
    blank: image.blank,
    crpix: wcs.crpix,
    crval: wcs.crval,
    cd: wcs.cd,
    overview: { width: overview.width, height: overview.height, vmin: overview.vmin, vmax: overview.vmax },
  };
}

/* ----------------------------- IO helpers ----------------------------- */

async function readBody(req, res, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    sendError(res, new FitsError('FILE_TOO_LARGE',
      `上传文件 ${(declared / 1024 / 1024).toFixed(1)} MB 超过上限 ${(limit / 1024 / 1024).toFixed(0)} MB`, 413));
    req.resume();
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      sendError(res, new FitsError('FILE_TOO_LARGE',
        `上传数据超过 ${(limit / 1024 / 1024).toFixed(0)} MB 上限`, 413));
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, res) {
  const body = await readBody(req, res, 8 * 1024 * 1024);
  if (body === null) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new FitsError('BAD_JSON', '请求体不是合法 JSON');
  }
}

function serveFile(file, res) {
  const data = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(data);
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(buf);
}

function sendError(res, err) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const code = err.code || 'INTERNAL';
  const status = err.status || (err instanceof FitsError ? 400 : 500);
  if (!(err instanceof FitsError)) {
    console.error(err);
  }
  const body = {
    error: true,
    code,
    message: err instanceof FitsError ? err.message : `服务内部错误：${err.message}`,
  };
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(Buffer.from(JSON.stringify(body), 'utf8'));
}

// Start directly: `node server/index.js`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`FITS 工作台已启动：http://127.0.0.1:${port}`);
  });
}
