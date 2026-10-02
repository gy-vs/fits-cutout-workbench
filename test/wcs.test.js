import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWcs, pixelToSky, skyToPixel, normalizeRa } from '../lib/wcs.js';
import { FitsError } from '../lib/fits.js';

function wcsHeader(over = {}) {
  return {
    CTYPE1: 'RA---TAN',
    CTYPE2: 'DEC--TAN',
    CRPIX1: 101, CRPIX2: 76,
    CRVAL1: 10, CRVAL2: 20,
    CD1_1: 0.02, CD1_2: 0,
    CD2_1: 0, CD2_2: 0.02,
    CUNIT1: 'deg', CUNIT2: 'deg',
    ...over,
  };
}

test('参考像素往返 CRVAL；像素与天球坐标互逆', () => {
  const w = buildWcs(wcsHeader());
  const s = pixelToSky(w, 101, 76);
  assert.ok(Math.abs(s.ra - 10) < 1e-9);
  assert.ok(Math.abs(s.dec - 20) < 1e-9);

  for (const [px, py] of [[50, 40], [150, 100], [101, 76], [1, 1]]) {
    const sky = pixelToSky(w, px, py);
    const back = skyToPixel(w, sky.ra, sky.dec);
    assert.ok(Math.abs(back[0] - px) < 1e-7, `px ${px} roundtrip`);
    assert.ok(Math.abs(back[1] - py) < 1e-7, `py ${py} roundtrip`);
  }
});

test('旋转 30° CD 矩阵下往返仍然成立', () => {
  const th = (-30 * Math.PI) / 180;
  const d = 0.02;
  const w = buildWcs(wcsHeader({
    CD1_1: d * Math.cos(th), CD1_2: -d * Math.sin(th),
    CD2_1: d * Math.sin(th), CD2_2: d * Math.cos(th),
  }));
  for (const [px, py] of [[30, 30], [120, 90], [200, 150]]) {
    const sky = pixelToSky(w, px, py);
    const back = skyToPixel(w, sky.ra, sky.dec);
    assert.ok(Math.abs(back[0] - px) < 1e-7);
    assert.ok(Math.abs(back[1] - py) < 1e-7);
  }
});

test('RA 归一化到 [0,360)；RA=0 中心附近的点正确环绕', () => {
  assert.equal(normalizeRa(0), 0);
  assert.equal(normalizeRa(-0.5), 359.5);
  assert.equal(normalizeRa(360.5), 0.5);

  const w = buildWcs(wcsHeader({ CRVAL1: 0, CRVAL2: 0 }));
  // 50 pixels west of centre at 0.01 deg/px -> RA near 359.5
  const sky = pixelToSky(w, 101 - 50, 76);
  assert.ok(sky.ra > 359, `RA wraps to ${sky.ra}`);
  const back = skyToPixel(w, sky.ra, sky.dec);
  assert.ok(Math.abs(back[0] - (101 - 50)) < 1e-7);
});

test('可见半球之外返回 null（不产生假坐标）', () => {
  const w = buildWcs(wcsHeader({ CRVAL1: 0, CRVAL2: 0, CD1_1: 5, CD2_2: 5 }));
  // A point on the opposite hemisphere cannot invert through the TAN plane.
  const back = skyToPixel(w, 180, 0);
  assert.equal(back, null);
});

test('CDELT/PC 约定被明确拒绝', () => {
  assert.throws(
    () => buildWcs(wcsHeader({ CDELT1: 0.02, CDELT2: 0.02, PC1_1: 1, PC2_2: 1 })),
    (e) => e instanceof FitsError && e.code === 'UNSUPPORTED_WCS' && /CDELT/.test(e.message)
  );
});

test('非 TAN CTYPE 与不可逆 CD 矩阵分别报错', () => {
  assert.throws(() => buildWcs(wcsHeader({ CTYPE1: 'RA---SIP' })),
    (e) => e.code === 'UNSUPPORTED_WCS');
  assert.throws(
    () => buildWcs(wcsHeader({ CD1_1: 0, CD1_2: 0, CD2_1: 0, CD2_2: 0 })),
    (e) => e.code === 'SINGULAR_CD'
  );
});
