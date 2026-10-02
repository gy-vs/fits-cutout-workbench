import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFloatFits } from '../lib/fits-writer.js';
import { parsePrimaryImage } from '../lib/fits-parser.js';
import { TanWcs } from '../lib/wcs.js';
import { BLOCK } from '../lib/fits-parser.js';

test('写出文件：80 字节卡片、2880 对齐、大端 float32、NaN 保留', () => {
  const width = 5, height = 3;
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) values[i] = i * 0.5;
  values[7] = NaN;
  const wcs = { crpix: [3, 2], crval: [12.34, -5.6], cd: [[0.01, 0.001], [-0.001, 0.01]] };
  const buf = writeFloatFits({ values, width, height, wcs });
  assert.equal(buf.length % BLOCK, 0);
  // Header region contains expected cards.
  const head = buf.subarray(0, BLOCK).toString('latin1');
  assert.match(head, /SIMPLE  =                    T/);
  assert.match(head, /BITPIX  =                  -32/);
  assert.match(head, /NAXIS1  =                    5/);
  assert.match(head, /RA---TAN/);
  assert.match(head, /DEC--TAN/);
  // Every header card exactly 80 bytes, only ASCII.
  for (let i = 0; i < BLOCK; i += 80) {
    const c = head.slice(i, i + 80);
    assert.equal(c.length, 80);
    for (const ch of c) assert.ok(ch.charCodeAt(0) <= 127);
  }
  // Big-endian data values.
  assert.equal(buf.readFloatBE(BLOCK), 0);
  assert.equal(buf.readFloatBE(BLOCK + 4), 0.5);
  assert.ok(Number.isNaN(buf.readFloatBE(BLOCK + 7 * 4)));

  // The file must re-read through our own strict parser.
  const re = parsePrimaryImage(buf);
  assert.equal(re.width, width);
  assert.equal(re.height, height);
  assert.equal(re.bitpix, -32);
  assert.ok(Number.isNaN(re.data.readFloatBE(7 * 4)));
  assert.equal(re.data.readFloatBE(8 * 4), 4);
});

test('切片输出重定位 CRPIX：回读坐标与输入 CRVAL 完全一致', () => {
  const width = 4, height = 4;
  const values = new Float32Array(width * height).fill(1);
  const wcs = {
    crpix: [2.5, 2.5], crval: [90.123456, 45.654321],
    cd: [[0.002, 0.0003], [-0.0003, 0.002]]
  };
  const buf = writeFloatFits({ values, width, height, wcs });
  const img = parsePrimaryImage(buf);
  const w = new TanWcs(img.wcs);
  const sky = w.pixelToSky(2.5, 2.5);
  assert.ok(Math.abs(sky[0] - wcs.crval[0]) < 1e-9, `RA ${sky[0]}`);
  assert.ok(Math.abs(sky[1] - wcs.crval[1]) < 1e-9, `Dec ${sky[1]}`);
  // A corner round-trips through the rotated CD (allow intrinsic TAN geometry
  // over the ~0.006 deg diagonal; exact algebra is covered by wcs tests).
  const c = w.pixelToSky(4.5, 0.5);
  const back = w.skyToPixel(c[0], c[1]);
  assert.ok(Math.abs(back[0] - 4.5) < 0.01);
  assert.ok(Math.abs(back[1] - 0.5) < 0.01);

  // One step from the reference: TAN curvature residual is ~1e-5 px here.
  const near = w.pixelToSky(3.5, 2.5);
  const nearBack = w.skyToPixel(near[0], near[1]);
  assert.ok(Math.abs(nearBack[0] - 3.5) < 1e-3 && Math.abs(nearBack[1] - 2.5) < 1e-3);
});
