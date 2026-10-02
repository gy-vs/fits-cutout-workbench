import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrimaryImage } from '../lib/fits-parser.js';
import {
  makePixelReader, resampleBilinear, buildOverview, materializeCutout
} from '../lib/pixels.js';
import { TanWcs } from '../lib/wcs.js';
import { makeImageFits } from './helpers.js';

test('像素读取：BSCALE/BZERO/BLANK 与 float NaN 的统一物理值/缺失规则', () => {
  const ibuf = makeImageFits({
    width: 3, height: 1, bitpix: 16, bscale: 0.5, bzero: 100, blank: -32768,
    valueFn: (x) => [10, -32768, 20][x]
  });
  const img = parsePrimaryImage(ibuf);
  const r = makePixelReader(img);
  // reader 采用 FITS 1 基像素坐标：数组列 j 的中心是 j+1。
  assert.ok(Math.abs(r(1, 1) - (10 * 0.5 + 100)) < 1e-9); // 105
  assert.ok(Number.isNaN(r(2, 1)));                         // BLANK -> NaN
  assert.ok(Math.abs(r(3, 1) - (20 * 0.5 + 100)) < 1e-9); // 110

  const fbuf = makeImageFits({
    width: 2, height: 1, bitpix: -32,
    valueFn: (x) => (x === 0 ? NaN : 42)
  });
  const rf = makePixelReader(parsePrimaryImage(fbuf));
  assert.ok(Number.isNaN(rf(1, 1)));
  assert.equal(rf(2, 1), 42);
});

test('双线性重采样：整数网格点等于原值，半像素为均值，越界与全缺失为 NaN', () => {
  const buf = makeImageFits({
    width: 3, height: 1, bitpix: -32,
    valueFn: (x) => [0, 10, 20][x]
  });
  const r = makePixelReader(parsePrimaryImage(buf));
  // FITS 坐标：第 2 个像素中心在 x=2，值 10。
  assert.equal(resampleBilinear(r, 2, 1, 3, 1), 10);
  // 第 1、2 个像素正中间 -> 均值 5。
  assert.equal(resampleBilinear(r, 1.5, 1, 3, 1), 5);
  // 越界（中心点必须在 [1,3] 内）。
  assert.ok(Number.isNaN(resampleBilinear(r, 0.9, 1, 3, 1)));
  assert.ok(Number.isNaN(resampleBilinear(r, 3.1, 1, 3, 1)));

  // 缺失邻居权重归零：[NaN, 100] 正中间 -> 100。
  const nbuf = makeImageFits({
    width: 2, height: 1, bitpix: -32,
    valueFn: (x) => (x === 0 ? NaN : 100)
  });
  const nr = makePixelReader(parsePrimaryImage(nbuf));
  assert.equal(resampleBilinear(nr, 1.5, 1, 2, 1), 100);
  // 全部缺失 -> NaN。
  const allNan = makeImageFits({ width: 2, height: 1, bitpix: -32, valueFn: () => NaN });
  const ar = makePixelReader(parsePrimaryImage(allNan));
  assert.ok(Number.isNaN(resampleBilinear(ar, 1.5, 1, 2, 1)));
});

test('概览降采样：混合块按有效值平均、全缺失块为 NaN、给出分位范围', () => {
  const buf = makeImageFits({
    width: 10, height: 10, bitpix: -32,
    valueFn: (x) => (x === 9 ? NaN : x + 1) // 最后一列为 NaN
  });
  const ov = buildOverview(parsePrimaryImage(buf), 5);
  assert.equal(ov.width, 5);
  assert.ok(ov.scale >= 2);
  // 最后一块覆盖源列 8,9：仅列 8 有效，均值 = 9。
  const mixed = ov.values[ov.width - 1];
  assert.ok(Math.abs(mixed - 9) < 1e-6, `mixed block mean ${mixed}`);
  assert.ok(Number.isFinite(ov.vmin) && Number.isFinite(ov.vmax));
  assert.ok(ov.vmax >= ov.vmin);

  const allGone = makeImageFits({ width: 8, height: 8, bitpix: -32, valueFn: () => NaN });
  const ov2 = buildOverview(parsePrimaryImage(allGone), 4);
  assert.equal(ov2.nanCount, ov2.width * ov2.height);
  assert.ok(Number.isNaN(ov2.vmin));
});

test('切片（1:1 区域）：WCS 参考点重定位、中心值取自源中心、坐标往返一致', async () => {
  const w = 24, h = 18;
  const buf = makeImageFits({
    width: w, height: h,
    crval: [50, 20], crpix: [12.5, 9.5], cd: [[0.01, 0], [0, 0.01]],
    valueFn: (x, y) => 100 + x + y * 2
  });
  const img = parsePrimaryImage(buf);
  const wcs = new TanWcs(img.wcs);
  // 以源像素（0 基数组坐标）(10, 8) 为中心切 8x6 区域。
  const cx = 10, cy = 8;
  const outW = 8, outH = 6;
  const sky = wcs.pixelToSky(cx + 1, cy + 1); // FITS 坐标
  const result = await materializeCutout({
    image: img, centerSky: sky, angularSize: [0.08, 0.06],
    outW, outH
  });
  assert.equal(result.values.length, outW * outH);
  // 输出 CRPIX 位于输出网格中心，不再沿用原图 CRPIX。
  assert.ok(Math.abs(result.wcsOutput.crpix[0] - (outW / 2 + 0.5)) < 1e-9);
  assert.ok(Math.abs(result.wcsOutput.crpix[1] - (outH / 2 + 0.5)) < 1e-9);
  assert.deepEqual(result.wcsOutput.crval, sky);

  // 输出 CRPIX 位置回算的天球必须就是请求中心。
  const outWcs = new TanWcs(result.wcsOutput);
  const backSky = outWcs.pixelToSky(result.wcsOutput.crpix[0], result.wcsOutput.crpix[1]);
  assert.ok(Math.abs(backSky[0] - sky[0]) < 1e-9);
  assert.ok(Math.abs(backSky[1] - sky[1]) < 1e-9);

  // 该天球在源图中恰为像素 (10,8) 中心，输出参考像素采样值应等于源物理值。
  // 输出 CRPIX=4.5,3.5（FITS 坐标），其所在数组元素的 0 基索引 = floor(4.5-1.5)=3。
  const reader = makePixelReader(img);
  const expected = reader(cx + 1, cy + 1);
  const crJ = Math.floor(result.wcsOutput.crpix[0] - 1.5);
  const crI = Math.floor(result.wcsOutput.crpix[1] - 1.5);
  const got = result.values[crI * outW + crJ];
  assert.ok(Math.abs(got - expected) < 1e-3, `center value ${got} vs ${expected}`);
});

test('重采样到不同输出网格仍保持物理值尺度与缺失语义', async () => {
  const buf = makeImageFits({
    width: 30, height: 20,
    crval: [0, 0], crpix: [15.5, 10.5], cd: [[0.01, 0], [0, 0.01]],
    valueFn: (x) => (x >= 14 && x <= 16 ? NaN : 5 + x * 0.3)
  });
  const img = parsePrimaryImage(buf);
  const wcs = new TanWcs(img.wcs);
  const sky = wcs.pixelToSky(15.5, 10.5);
  // 降采样网格：同样角范围、更少像素。
  const result = await materializeCutout({
    image: img, centerSky: sky, angularSize: [0.1, 0.08], outW: 10, outH: 8
  });
  assert.equal(result.outW, 10);
  assert.ok(result.nanCount > 0, '缺失带必须作为 NaN 保留');
  assert.ok(result.finiteCount > result.values.length * 0.7);
});
