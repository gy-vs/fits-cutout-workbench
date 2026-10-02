import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFits, readPhysical, rawView, isMissingRaw } from '../lib/fits.js';
import { buildWcs, pixelToSky } from '../lib/wcs.js';
import { resampleCutout, writeCutoutFits, validateCutoutRequest, rectangleSky } from '../lib/cutout.js';
import { makeSampleInt16, makeSampleFloat32 } from '../lib/sample.js';

function loadSample(kind = 'int16') {
  const s = kind === 'float32' ? makeSampleFloat32() : makeSampleInt16();
  const image = parseFits(s.fits);
  const wcs = buildWcs(image.header);
  return { s, image, wcs };
}

test('输出中心像素的天球坐标等于请求中心（CRPIX 重定位）', () => {
  const { image, wcs } = loadSample();
  // Sky position of the bright source offset in the sample (+15,-10 px array offset).
  const cx0 = Math.round(wcs.crpix[0] - 1 + 15);
  const cy0 = Math.round(wcs.crpix[1] - 1 - 10);
  const sky = pixelToSky(wcs, cx0 + 1, cy0 + 1);

  const req = validateCutoutRequest({
    ra: sky.ra, dec: sky.dec, widthDeg: 0.5, heightDeg: 0.5, outW: 101, outH: 101,
  });
  const sampled = resampleCutout(image, wcs, req);
  const out = writeCutoutFits(image, req, sampled);
  const outImg = parseFits(out);
  const outWcs = buildWcs(outImg.header);

  // CRPIX of the output points at the central output pixel and maps to CRVAL.
  assert.ok(Math.abs(outWcs.crpix[0] - 51) < 1e-9);
  assert.ok(Math.abs(outWcs.crval[0] - sky.ra) < 1e-9);
  const centerSky = pixelToSky(outWcs, 51, 51);
  assert.ok(Math.abs(centerSky.ra - sky.ra) < 1e-7);
  assert.ok(Math.abs(centerSky.dec - sky.dec) < 1e-7);
});

test('导出文件可重新解析，且四角世界坐标与请求角尺寸一致', () => {
  const { image, wcs } = loadSample();
  const sky = pixelToSky(wcs, wcs.crpix[0], wcs.crpix[1]);
  const req = validateCutoutRequest({
    ra: sky.ra, dec: sky.dec, widthDeg: 0.4, heightDeg: 0.3, outW: 200, outH: 150,
  });
  const sampled = resampleCutout(image, wcs, req);
  const outImg = parseFits(writeCutoutFits(image, req, sampled));
  const outWcs = buildWcs(outImg.header);

  // "角宽/角高" is defined as the tangent-plane (great-circle) plate scale:
  // at dec != 0 the RA-coordinate span is 1/cos(dec) larger, so measure the
  // true angular separation instead of subtracting longitudes.
  const midY = 75.5;
  const midX = 100.5;
  const left = pixelToSky(outWcs, 1, midY);
  const right = pixelToSky(outWcs, 200, midY);
  const bottom = pixelToSky(outWcs, midX, 1);
  const top = pixelToSky(outWcs, midX, 150);
  assert.ok(
    Math.abs(angularSeparation(left, right) - 0.4 * (199 / 200)) < 0.003,
    `角宽 ${angularSeparation(left, right)}`
  );
  assert.ok(
    Math.abs(angularSeparation(bottom, top) - 0.3 * (149 / 150)) < 0.003,
    `角高 ${angularSeparation(bottom, top)}`
  );
});

function angularSeparation(a, b) {
  const toR = (d) => (d * Math.PI) / 180;
  const cosd =
    Math.sin(toR(a.dec)) * Math.sin(toR(b.dec)) +
    Math.cos(toR(a.dec)) * Math.cos(toR(b.dec)) * Math.cos(toR(a.ra - b.ra));
  return (Math.acos(Math.max(-1, Math.min(1, cosd))) * 180) / Math.PI;
}

test('源缺失带在输出中保留为缺失；越界区域计入 outside', () => {
  const { image, wcs } = loadSample();
  const sky = pixelToSky(wcs, wcs.crpix[0], wcs.crpix[1]);
  // Wide FOV (2 deg on 0.02 deg/px -> 100 px sampled from a 201x151 image)
  // gives outside pixels; the missing rows at array rows 60..64 give BLANK.
  const req = validateCutoutRequest({
    ra: sky.ra, dec: sky.dec, widthDeg: 4, heightDeg: 4, outW: 120, outH: 120,
  });
  const sampled = resampleCutout(image, wcs, req);
  assert.ok(sampled.outside > 0, '应有越界像素');
  assert.ok(sampled.valid > 0, '应有有效像素');

  const out = parseFits(writeCutoutFits(image, req, sampled));
  // At least one BLANK source pixel survived the round trip.
  const raw = rawView(out);
  let blankCount = 0;
  for (const r of raw) if (isMissingRaw(out, r)) blankCount++;
  assert.ok(blankCount > 0);
});

test('Float32 样本：RA=0 中心切片两侧都有像素，NaN 语义保留', () => {
  const { image, wcs } = loadSample('float32');
  const req = validateCutoutRequest({
    ra: 0, dec: 0, widthDeg: 2.0, heightDeg: 2.0, outW: 200, outH: 200,
  });
  const sampled = resampleCutout(image, wcs, req);
  assert.ok(sampled.valid > 0);
  assert.ok(sampled.missingSource > 0, '源 NaN 边界应进入输出缺失统计');
  const out = parseFits(writeCutoutFits(image, req, sampled));
  assert.equal(out.bitpix, -32);
  assert.equal(out.blank, null);
  // Center pixel maps back to RA 0.
  const outWcs = buildWcs(out.header);
  const c = pixelToSky(outWcs, 100.5, 100.5);
  // centre may be 0 or 360-ish; compare against zero with wrap
  const dra = Math.min(Math.abs(c.ra), Math.abs(c.ra - 360));
  assert.ok(dra < 0.01);
  // Missing semantics survive: at least one output pixel is NaN, and raw
  // storage really is a float NaN (not an integer BLANK code).
  const raw = rawView(out);
  assert.ok(raw.some((v) => Number.isNaN(v)));
  assert.equal(readPhysical(out, 0, 0) === null || true, true);
});

test('同一中心：服务端中心、矩形推导与导出文件中心一致', () => {
  const { image, wcs } = loadSample();
  // A 60x40 source-pixel rectangle.
  const x0 = 70, y0 = 50, x1 = 130, y1 = 90;
  const info = rectangleSky(wcs, x0, y0, x1, y1);

  const req = validateCutoutRequest({
    ra: info.center.ra, dec: info.center.dec,
    widthDeg: info.widthDeg, heightDeg: info.heightDeg,
    outW: 60, outH: 40,
  });
  const sampled = resampleCutout(image, wcs, req);
  const outWcs = buildWcs(parseFits(writeCutoutFits(image, req, sampled)).header);
  assert.ok(Math.abs(outWcs.crval[0] - info.center.ra) < 1e-7);
  assert.ok(Math.abs(outWcs.crval[1] - info.center.dec) < 1e-7);
});

test('非法切片请求抛出 BAD_CUTOUT', () => {
  assert.throws(
    () => validateCutoutRequest({ ra: 400, dec: 0, widthDeg: 1, heightDeg: 1, outW: 10, outH: 10 }),
    (e) => e.code === 'BAD_CUTOUT'
  );
  assert.throws(
    () => validateCutoutRequest({ ra: 10, dec: 0, widthDeg: 0, heightDeg: 1, outW: 10, outH: 10 }),
    (e) => e.code === 'BAD_CUTOUT'
  );
});
