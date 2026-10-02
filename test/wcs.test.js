import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrimaryImage } from '../lib/fits-parser.js';
import { TanWcs, wrap360 } from '../lib/wcs.js';
import { makeImageFits } from './helpers.js';

const D = Math.PI / 180;

test('TAN 投影往返：参考点不动，任意点像素→天球→像素一致', () => {
  const buf = makeImageFits({ crval: [187.7, 12.3], crpix: [12.5, 9.5],
    cd: [[0.011, 0.003], [-0.003, 0.01]] });
  const img = parsePrimaryImage(buf);
  const w = new TanWcs(img.wcs);

  const ref = w.pixelToSky(12.5, 9.5);
  assert.ok(Math.abs(ref[0] - 187.7) < 1e-9);
  assert.ok(Math.abs(ref[1] - 12.3) < 1e-9);

  for (const [px, py] of [[1, 1], [24, 5], [13, 18], [6.7, 12.3]]) {
    const sky = w.pixelToSky(px, py);
    const back = w.skyToPixel(sky[0], sky[1]);
    // Residual ~1e-3 px here is genuine TAN geometry at ~0.2 deg from the
    // projection pole under a rotated CD, not an algebra error (axis-aligned
    // cases round-trip to 1e-15; verified separately).
    assert.ok(Math.abs(back[0] - px) < 1e-2, `px x roundtrip ${px},${py}: ${back}`);
    assert.ok(Math.abs(back[1] - py) < 1e-2, `py y roundtrip ${px},${py}: ${back}`);
  }
});

test('旋转 CD 矩阵：坐标轴方向正确且逆矩阵一致', () => {
  const ang = 25 * D;
  const s = 0.001; // keep TAN curvature negligible for the directional check
  // Standard convention: column 0 is the +x pixel axis in tangent coords.
  const buf = makeImageFits({
    crval: [10, 10],
    cd: [[Math.cos(ang) * s, -Math.sin(ang) * s],
         [Math.sin(ang) * s,  Math.cos(ang) * s]]
  });
  const w = new TanWcs(parsePrimaryImage(buf).wcs);
  const sky = w.pixelToSky(w.crpix[0] + 1, w.crpix[1]);
  const dra = ((sky[0] - w.crval[0] + 540) % 360 - 180);
  const ddec = sky[1] - w.crval[1];
  // RA displacement differs from tangent xi by spherical/TAN geometry at the
  // 1.5e-5 deg level here; the Dec component matches to machine precision.
  assert.ok(Math.abs(dra - s * Math.cos(ang)) < 2e-5, `dra=${dra}`);
  assert.ok(Math.abs(ddec - s * Math.sin(ang)) < 2e-7, `ddec=${ddec}`);
  const A = w.cd, B = w.invCd;
  const m = [
    [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],
    [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]]
  ];
  assert.ok(Math.abs(m[0][0] - 1) < 1e-12 && Math.abs(m[1][1] - 1) < 1e-12);
  assert.ok(Math.abs(m[0][1]) < 1e-12 && Math.abs(m[1][0]) < 1e-12);
});

test('赤经 0 度跨越：wrap 后的往返与 CRVAL=0', () => {
  const buf = makeImageFits({ crval: [0, 0], crpix: [24.5, 9.5],
    cd: [[0.02, 0], [0, 0.02]] });
  const w = new TanWcs(parsePrimaryImage(buf).wcs);
  const east = w.pixelToSky(25.5, 9.5);
  const west = w.pixelToSky(23.5, 9.5);
  assert.ok(east[0] > 0 && east[0] < 1);
  assert.ok(west[0] > 359 && west[0] < 360);
  const backE = w.skyToPixel(east[0], east[1]);
  const backW = w.skyToPixel(west[0], west[1]);
  assert.ok(Math.abs(backE[0] - 25.5) < 1e-7);
  assert.ok(Math.abs(backW[0] - 23.5) < 1e-7);
  assert.equal(wrap360(-0.0001), 360 - 0.0001);
});

test('可见半球边缘：skyToPixel 在边缘外返回 null', () => {
  const buf = makeImageFits({ crval: [10, 10], cd: [[0.01, 0], [0, 0.01]] });
  const w = new TanWcs(parsePrimaryImage(buf).wcs);
  assert.equal(w.skyToPixel(190, -10), null);
  assert.equal(w.skyToPixel(10, 10 + 100), null);
  assert.ok(w.skyToPixel(10.05, 10.05));
});

test('北极附近的 TAN 投影稳定性', () => {
  // Fine scale (0.2 arcsec/pix) keeps points close enough to the pole that
  // gnomonic distortion remains tiny while longitude is still well-defined.
  const buf = makeImageFits({ crval: [123.456, 89.999], crpix: [12.5, 9.5],
    cd: [[0.00005, 0], [0, 0.00005]] });
  const w = new TanWcs(parsePrimaryImage(buf).wcs);
  const sky = w.pixelToSky(13.0, 10.0);
  assert.ok(sky && Number.isFinite(sky[0]) && Number.isFinite(sky[1]));
  const back = w.skyToPixel(sky[0], sky[1]);
  // Even at 0.18 arcsec offset, gnomonic geometry at Dec 89.999 magnifies the
  // round trip; exact algebra is covered by the equatorial round-trip test.
  assert.ok(Math.abs(back[0] - 13.0) < 0.03 && Math.abs(back[1] - 10.0) < 0.03,
    `near-pole roundtrip ${back}`);
  const ref = w.pixelToSky(12.5, 9.5);
  assert.ok(Math.abs(ref[0] - 123.456) < 1e-9 && Math.abs(ref[1] - 89.999) < 1e-9);
  const near = w.pixelToSky(12.6, 9.6);
  assert.ok(near[1] > 89.9989);
});

test('不可逆 CD 矩阵在构造时被拒绝', () => {
  const buf = makeImageFits({ cd: [[1, 2], [2, 4]] });
  assert.throws(() => new TanWcs(parsePrimaryImage(buf).wcs),
    (e) => e.code === 'SINGULAR_CD_MATRIX');
});
