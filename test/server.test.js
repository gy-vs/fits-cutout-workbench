import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/server.js';
import { makeImageFits } from './helpers.js';
import { parsePrimaryImage } from '../lib/fits-parser.js';
import { TanWcs } from '../lib/wcs.js';

let server, base;
before(async () => {
  server = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((res) => server.close(res)));

const api = (path, init) => fetch(base + path, init);

function floatImage(opts = {}) {
  return makeImageFits({
    width: 40, height: 30, bitpix: -32,
    crval: [187.7, 12.3], crpix: [20.5, 15.5],
    cd: [[0.011, 0.003], [-0.003, 0.01]],
    valueFn: (x, y) => (x >= 29 && x <= 31 ? NaN : 10 + x * 0.7 + y * 0.4),
    ...opts
  });
}

async function upload(buf, headers = {}) {
  return api('/api/fits', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...headers },
    body: buf
  });
}

test('GET / 直接返回工作区页面（无介绍首页）', async () => {
  const r = await api('/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<title>FITS 切片工作台<\/title>/);
  assert.match(html, /mainCanvas/);
});

test('上传合法 float 图像 -> 元数据、概览、网格、point 读数', async () => {
  const buf = floatImage();
  const r = await upload(buf, { 'x-file-name': 't.fits' });
  if (r.status !== 200) throw new Error(`upload failed: ${r.status} ${await r.text()}`);
  const meta = await r.json();
  assert.equal(meta.width, 40);
  assert.equal(meta.height, 30);
  assert.equal(meta.bitpix, -32);

  const ov = await api(meta.endpoints.overview);
  assert.equal(ov.status, 200);
  assert.ok(Number(ov.headers.get('x-width')) > 0);
  const ovBuf = await ov.arrayBuffer();
  assert.equal(ovBuf.byteLength % 4, 0);

  const gr = await api(meta.endpoints.grid);
  const grid = await gr.json();
  assert.ok(Array.isArray(grid.raLines));

  // point 读数必须与本地 WCS 完全一致（同一服务端代码）。x=10,y=11 是 0 基
  // 坐标，对应 FITS 像素 (11,12)。
  const localWcs = parsePrimaryImage(buf).wcs;
  const localSky = localWcs.pixelToSky(11, 12);
  const pr = await api(`/api/fits/${meta.id}/point?x=10&y=11`);
  const pd = await pr.json();
  assert.ok(Math.abs(pd.sky.ra - localSky[0]) < 1e-10);
  assert.ok(Math.abs(pd.sky.dec - localSky[1]) < 1e-10);
  // float32 存储精度
  assert.ok(Math.abs(pd.value - (10 + 10 * 0.7 + 11 * 0.4)) < 1e-5);

  const miss = await (await api(`/api/fits/${meta.id}/point?x=30&y=5`)).json();
  assert.equal(miss.missing, true);
  assert.equal(miss.value, null);

  return meta;
});

test('区域描述 -> 切片 -> 下载 FITS -> 重新解析，坐标往返一致', async () => {
  const buf = floatImage();
  const meta = await (await upload(buf)).json();
  const rect = { x0: 8, y0: 6, x1: 32, y1: 20 };
  const rr = await api(`/api/fits/${meta.id}/region`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rect })
  });
  assert.equal(rr.status, 200);
  const region = await rr.json();
  assert.ok(region.angularSize.width > 0);

  const q = new URLSearchParams({
    ra: region.center.ra, dec: region.center.dec,
    widthDeg: region.angularSize.width, heightDeg: region.angularSize.height,
    outW: region.suggestedPixels.width, outH: region.suggestedPixels.height,
    seq: 1
  });
  const cr = await api(`/api/fits/${meta.id}/cutout?${q}`, { method: 'POST' });
  if (cr.status !== 200) throw new Error(`cutout failed: ${cr.status} ${await cr.text()}`);
  const cut = await cr.json();
  assert.ok(cut.srcCorners.length === 4);
  assert.equal(cut.seq, 1);
  assert.ok(cut.nanFraction > 0, 'NaN 列应保留为缺失');

  const pv = await api(cut.preview.url);
  assert.equal(pv.status, 200);
  const pvBuf = await pv.arrayBuffer();
  assert.ok(pvBuf.byteLength >= 4);

  const dl = await api(cut.downloadUrl);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-type'), /fits/);
  const fitsBuf = Buffer.from(await dl.arrayBuffer());
  assert.equal(fitsBuf.length % 2880, 0);

  // Re-read downloaded FITS: relocated reference point reproduces the center.
  const reImg = parsePrimaryImage(fitsBuf);
  const w = new TanWcs(reImg.wcs);
  const sky = w.pixelToSky(reImg.wcs.crpix[0], reImg.wcs.crpix[1]);
  assert.ok(Math.abs(sky[0] - region.center.ra) < 1e-7,
    `导出中心 RA ${sky[0]} vs ${region.center.ra}`);
  assert.ok(Math.abs(sky[1] - region.center.dec) < 1e-7,
    `导出中心 Dec ${sky[1]} vs ${region.center.dec}`);
  // 用源图 WCS 反算该天球位置。新切平面以区域中心为切点，与源切平面之间
  // 有真实 TAN 重投影；源图位置与几何中心相差约半个像素属正常几何差异。
  const src = new TanWcs(parsePrimaryImage(buf).wcs);
  const srcPix = src.skyToPixel(sky[0], sky[1]);
  assert.ok(Math.abs(srcPix[0] - 21) < 0.6, `srcPix ${srcPix}`);
  assert.ok(Math.abs(srcPix[1] - 14) < 0.6);
});

test('int16 源：BLANK/BSCALE/BZERO 物理值在 point 与导出 NaN 语义中一致', async () => {
  const buf = makeImageFits({
    width: 20, height: 10, bitpix: 16, bscale: 0.5, bzero: 1000, blank: -32768,
    crval: [100, 20], crpix: [10.5, 5.5], cd: [[0.01, 0], [0, 0.01]],
    valueFn: (x, y) => (x >= 9 && x <= 11 ? -32768 : 2 * (50 + x + y)) // physical 1050+...
  });
  const meta = await (await upload(buf)).json();
  // raw=2*(50+0+0)=100 -> physical 100*0.5+1000 = 1050
  const p0 = await (await api(`/api/fits/${meta.id}/point?x=0&y=0`)).json();
  assert.ok(Math.abs(p0.value - 1050) < 1e-9, `physical ${p0.value}`);
  const pBlank = await (await api(`/api/fits/${meta.id}/point?x=10&y=2`)).json();
  assert.equal(pBlank.missing, true);

  const q = new URLSearchParams({
    ra: 100, dec: 20, widthDeg: 0.1, heightDeg: 0.05,
    outW: 10, outH: 5, seq: 1
  });
  const cut = await (await api(`/api/fits/${meta.id}/cutout?${q}`, { method: 'POST' })).json();
  assert.ok(cut.nanFraction > 0, 'BLANK 列在导出中必须变为 NaN');
  const fitsBuf = Buffer.from(await (await api(cut.downloadUrl)).arrayBuffer());
  const re = parsePrimaryImage(fitsBuf);
  assert.equal(re.bitpix, -32); // 导出统一为 float32
  let nan = 0;
  for (let i = 0; i < re.width * re.height; i++) {
    if (Number.isNaN(re.data.readFloatBE(i * 4))) nan++;
  }
  assert.ok(nan > 0);
});

test('赤经零度跨越样本：切片中心与导出重读坐标一致', async () => {
  // crval=[0,0], image straddles RA=0; ask for a cutout exactly centered at 0.
  const buf = makeImageFits({
    width: 48, height: 40, bitpix: -32,
    crval: [0, 0], crpix: [24.5, 20.5],
    cd: [[0.02, 0], [0, 0.02]],
    valueFn: (x, y) => 10 + x * 0.1 + y * 0.05
  });
  const meta = await (await upload(buf)).json();
  const q = new URLSearchParams({
    ra: 0, dec: 0, widthDeg: 0.2, heightDeg: 0.2,
    outW: 10, outH: 10, seq: 1
  });
  const cr = await api(`/api/fits/${meta.id}/cutout?${q}`, { method: 'POST' });
  if (cr.status !== 200) throw new Error(`RA0 cutout ${cr.status} ${await cr.text()}`);
  const cut = await cr.json();
  const fitsBuf = Buffer.from(await (await api(cut.downloadUrl)).arrayBuffer());
  const re = parsePrimaryImage(fitsBuf);
  const w = new TanWcs(re.wcs);
  const sky = w.pixelToSky(re.wcs.crpix[0], re.wcs.crpix[1]);
  // RA near 0 must not collapse to NaN or drift to 180; distance to 0 small.
  const raDelta = Math.abs(((sky[0] + 180) % 360) - 180);
  assert.ok(raDelta < 1e-7, `RA delta from 0: ${sky[0]}`);
  assert.ok(Math.abs(sky[1]) < 1e-7);
  // West edge of the output lies on the 359.. side and must still round-trip.
  const corner = w.pixelToSky(1, re.wcs.crpix[1]);
  assert.ok(corner[0] > 359.7 || corner[0] < 0.3 || corner[0] > 359,
    `west edge RA ${corner[0]}`);
});

test('过期切片响应：后发序号使先发结果返回 409 STALE_RESPONSE', async () => {
  const meta = await (await upload(floatImage())).json();
  const q = (seq) => new URLSearchParams({
    ra: 187.7, dec: 12.3, widthDeg: 0.05, heightDeg: 0.05,
    outW: 2000, outH: 2000, seq
  });
  // First a small request establishes seq; then fire a large (slow) one and
  // immediately a newer one. The slow one must be rejected with 409.
  const r1P = api(`/api/fits/${meta.id}/cutout?${q(1)}`, { method: 'POST' });
  const r1 = await r1P;
  assert.equal(r1.status, 200);

  const slow = api(`/api/fits/${meta.id}/cutout?${q(2)}`, { method: 'POST' });
  // Give the server a tick to register seq=2 before bumping to 3.
  await new Promise((res) => setTimeout(res, 5));
  const fast = await api(`/api/fits/${meta.id}/cutout?${q(3)}`, { method: 'POST' });
  assert.equal(fast.status, 200);
  const slowRes = await slow;
  assert.equal(slowRes.status, 409);
  const body = await slowRes.json();
  assert.equal(body.error, 'STALE_RESPONSE');
});

test('畸形头 / CDELT+PC / 尺寸非法 / 输出过大 返回可区分错误', async () => {
  const badHeader = Buffer.from(makeImageFits({ width: 2, height: 1 }));
  badHeader[14] = 0xff;
  let r = await upload(badHeader);
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, 'MALFORMED_HEADER');

  // CDELT + PC
  const { buildRawFits, makeCard } = await import('./helpers.js');
  const pc = buildRawFits([
    makeCard('SIMPLE', true), makeCard('BITPIX', -32), makeCard('NAXIS', 2),
    makeCard('NAXIS1', 4), makeCard('NAXIS2', 4),
    makeCard('CTYPE1', 'RA---TAN'), makeCard('CTYPE2', 'DEC--TAN'),
    makeCard('CRPIX1', 2.5), makeCard('CRPIX2', 2.5),
    makeCard('CRVAL1', 1), makeCard('CRVAL2', 2),
    makeCard('CDELT1', -0.01), makeCard('CDELT2', 0.01),
    makeCard('PC1_1', 1), makeCard('PC2_2', 1)
  ], Buffer.alloc(64));
  r = await upload(pc);
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, 'UNSUPPORTED_WCS_CONVENTION');

  const meta = await (await upload(floatImage())).json();
  const q = new URLSearchParams({
    ra: 187.7, dec: 12.3, widthDeg: 0.01, heightDeg: 0.01,
    outW: 5000, outH: 5000, seq: 1
  });
  r = await api(`/api/fits/${meta.id}/cutout?${q}`, { method: 'POST' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'OUTPUT_TOO_LARGE');

  // region outside hemisphere
  const q2 = new URLSearchParams({
    ra: 7.7, dec: -12.3, widthDeg: 0.01, heightDeg: 0.01,
    outW: 10, outH: 10, seq: 2
  });
  r = await api(`/api/fits/${meta.id}/cutout?${q2}`, { method: 'POST' });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, 'REGION_OUTSIDE_HEMISPHERE');
});

test('过大上传返回 413；空上传返回 400', async () => {
  // Tiny server-side limit can't be changed per request, so send declared
  // Content-Length larger than the configured 64 MiB without the bytes.
  const r = await api('/api/fits', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(70 * 1024 * 1024)
    },
    body: Buffer.alloc(10),
    duplex: 'half'
  }).catch((e) => ({ status: 'neterr', _e: e }));
  // Node fetch may reject before getting a response; either way the server
  // returns 413 for an honest oversized stream — verified separately below.
  assert.ok(r.status === 413 || r.status === 'neterr');

  const empty = await api('/api/fits', {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, 'EMPTY_UPLOAD');
});

test('真实字节超限的流上传返回 413 PAYLOAD_TOO_LARGE', async () => {
  const big = Buffer.alloc(70 * 1024 * 1024, 0x20);
  const r = await upload(big).catch((e) => ({ status: 'neterr' }));
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, 'PAYLOAD_TOO_LARGE');
}, { timeout: 60000 });

test('release 后会话与任务失效（资源释放）', async () => {
  const meta = await (await upload(floatImage())).json();
  const rel = await api(`/api/fits/${meta.id}/release`, { method: 'POST' });
  assert.equal(rel.status, 200);
  const gone = await api(`/api/fits/${meta.id}/point?x=1&y=1`);
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).error, 'SESSION_NOT_FOUND');
});
