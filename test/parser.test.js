import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, parseHeaderBlocks, parsePrimaryImage, BLOCK, CARD } from '../lib/fits-parser.js';
import { makeCard, makeImageFits, buildRawFits } from './helpers.js';

test('卡片解析：80 字节、字符串引号与注释斜线必须区分', () => {
  const withSlashInString = makeCard('OBJECT', 'M31 / core', '目标名含斜线');
  assert.equal(withSlashInString.length, 80);
  const c1 = parseCard(withSlashInString);
  assert.equal(c1.kind, 'keyword');
  assert.equal(c1.value, 'M31 / core'); // 斜线在引号内不是注释
  assert.equal(c1.comment, '目标名含斜线');

  const doubled = parseCard(makeCard('BUNIT', "it''s"));
  assert.equal(doubled.value, "it's");

  const numeric = parseCard(makeCard('BITPIX', 16, 'bits'));
  assert.equal(numeric.value, 16);
  assert.equal(numeric.comment, 'bits');

  const floatCard = parseCard("CRVAL1  =   1.23456000000E+02 / degree".padEnd(80, ' '));
  assert.ok(Math.abs(floatCard.value - 123.456) < 1e-9);

  const dblExp = parseCard("CD1_1   =             -7.2D-6 / d exponent".padEnd(80, ' '));
  assert.ok(Math.abs(dblExp.value - -7.2e-6) < 1e-18);

  assert.equal(parseCard(''.padEnd(80, ' ')).kind, 'blank');
  assert.equal(parseCard('END'.padEnd(80, ' ')).kind, 'end');
  assert.equal(parseCard('COMMENT'.padEnd(8, ' ') + ' hello world'.padEnd(72)).kind, 'comment');
});

test('END 后按 2880 字节对齐，数据起点正确', () => {
  const buf = makeImageFits({ width: 5, height: 4, bitpix: -32 });
  // 5*4*4 = 80 data bytes -> one full 2880 header block + one data block.
  assert.equal(buf.length, BLOCK * 2);
  const { dataOffset } = parseHeaderBlocks(buf);
  assert.equal(dataOffset, BLOCK);
  const img = parsePrimaryImage(buf);
  assert.equal(img.width, 5);
  assert.equal(img.height, 4);
  assert.equal(img.data.length, 80);
});

test('大端像素读取：float 与 int16 字节序', () => {
  const fbuf = makeImageFits({
    width: 2, height: 1, bitpix: -32,
    valueFn: (x) => (x === 0 ? 3.5 : -2.25)
  });
  const fimg = parsePrimaryImage(fbuf);
  assert.equal(fimg.data.readFloatBE(0), 3.5);
  assert.equal(fimg.data.readFloatBE(4), -2.25);
  assert.equal(fimg.data.readFloatLE(0) === 3.5, false); // 证明不是小端

  const ibuf = makeImageFits({
    width: 2, height: 1, bitpix: 16,
    valueFn: (x) => (x === 0 ? 1000 : -250)
  });
  const iimg = parsePrimaryImage(ibuf);
  assert.equal(iimg.data.readInt16BE(0), 1000);
  assert.equal(iimg.data.readInt16BE(2), -250);
});

test('int16 的 BSCALE/BZERO/BLANK 与 float NaN 缺失值规则', () => {
  const buf = makeImageFits({
    width: 3, height: 1, bitpix: 16, bscale: 0.1, bzero: 3276.8, blank: -32768,
    valueFn: (x) => [100, -32768, 200][x]
  });
  const img = parsePrimaryImage(buf);
  assert.equal(img.blank, -32768);
  // Physical conversion tested through the reader module; here check header wiring.
  assert.equal(img.bscale, 0.1);
  assert.equal(img.bzero, 3276.8);

  const nanBuf = makeImageFits({
    width: 2, height: 1, bitpix: -32,
    valueFn: (x) => (x === 0 ? NaN : 1)
  });
  const nanImg = parsePrimaryImage(nanBuf);
  assert.ok(Number.isNaN(nanImg.data.readFloatBE(0)));
  assert.equal(nanImg.data.readFloatBE(4), 1);
});

test('拒绝各种畸形头（可区分错误码）', () => {
  const re = (buf, code) => assert.throws(() => parsePrimaryImage(buf), (e) => e.code === code);

  // 非 ASCII 控制字节污染一个数值（标准要求头为可打印 ASCII + 空格）
  const bad = Buffer.from(makeImageFits({ width: 2, height: 1 }));
  bad[29] = 0x00;
  re(bad, 'MALFORMED_HEADER');

  // 缺少 END（截断到半块）
  re(bad.subarray(0, 1000), 'MALFORMED_HEADER');

  // 引号未闭合
  const unclosed = buildRawFits([
    makeCard('SIMPLE', true), makeCard('BITPIX', -32), makeCard('NAXIS', 2),
    makeCard('NAXIS1', 1), makeCard('NAXIS2', 1),
    "OBJECT  = 'never closed".padEnd(80, ' ')
  ], Buffer.alloc(4));
  re(unclosed, 'MALFORMED_HEADER');

  // 空文件
  re(Buffer.alloc(0), 'EMPTY_UPLOAD');
});

test('拒绝不支持的 BITPIX / NAXIS / 非 primary', () => {
  const mk = (lines) => buildRawFits(lines, Buffer.alloc(4));
  assert.throws(() => parsePrimaryImage(mk([
    makeCard('SIMPLE', true), makeCard('BITPIX', 8), makeCard('NAXIS', 2),
    makeCard('NAXIS1', 1), makeCard('NAXIS2', 1)
  ])), (e) => e.code === 'UNSUPPORTED_BITPIX');

  assert.throws(() => parsePrimaryImage(mk([
    makeCard('SIMPLE', true), makeCard('BITPIX', -32), makeCard('NAXIS', 3),
    makeCard('NAXIS1', 1), makeCard('NAXIS2', 1), makeCard('NAXIS3', 1)
  ])), (e) => e.code === 'UNSUPPORTED_NAXIS');

  assert.throws(() => parsePrimaryImage(mk([
    makeCard('SIMPLE', false), makeCard('BITPIX', -32), makeCard('NAXIS', 0)
  ])), (e) => e.code === 'NOT_PRIMARY_IMAGE');
});

test('CDELT + PC 约定必须明确拒绝，不能静默导出', () => {
  const buf = buildRawFits([
    makeCard('SIMPLE', true), makeCard('BITPIX', -32), makeCard('NAXIS', 2),
    makeCard('NAXIS1', 4), makeCard('NAXIS2', 4),
    makeCard('CTYPE1', 'RA---TAN'), makeCard('CTYPE2', 'DEC--TAN'),
    makeCard('CRPIX1', 2.5), makeCard('CRPIX2', 2.5),
    makeCard('CRVAL1', 10), makeCard('CRVAL2', 20),
    makeCard('CDELT1', -0.01), makeCard('CDELT2', 0.01),
    makeCard('PC1_1', 1), makeCard('PC1_2', 0),
    makeCard('PC2_1', 0), makeCard('PC2_2', 1)
  ], Buffer.alloc(4 * 16));
  assert.throws(() => parsePrimaryImage(buf), (e) => e.code === 'UNSUPPORTED_WCS_CONVENTION');
  assert.match(
    (() => { try { parsePrimaryImage(buf); } catch (e) { return e.message; } })(),
    /CDELT/
  );
});

test('非 TAN 投影、缺 WCS、非法值均被拒绝', () => {
  const base = { width: 2, height: 2, bitpix: -32 };
  assert.throws(() => parsePrimaryImage(makeImageFits({ ...base, ctype1: 'RA---SIN' })),
    (e) => e.code === 'UNSUPPORTED_PROJECTION');
  // Blank out the whole CRVAL1 card so the keyword is genuinely absent.
  const buf = makeImageFits(base);
  const h = buf.subarray(0, BLOCK).toString('latin1');
  const idx = h.indexOf('CRVAL1');
  const cardStart = Math.floor(idx / 80) * 80;
  const copy = Buffer.from(buf);
  copy.write(' '.repeat(80), cardStart, 'latin1');
  assert.throws(() => parsePrimaryImage(copy), (e) => e.code === 'MISSING_WCS');
});

test('尺寸乘积溢出与数据截断', () => {
  const huge = buildRawFits([
    makeCard('SIMPLE', true), makeCard('BITPIX', -32), makeCard('NAXIS', 2),
    makeCard('NAXIS1', 1000000), makeCard('NAXIS2', 1000000),
    makeCard('CTYPE1', 'RA---TAN'), makeCard('CTYPE2', 'DEC--TAN'),
    makeCard('CRPIX1', 1), makeCard('CRPIX2', 1),
    makeCard('CRVAL1', 0), makeCard('CRVAL2', 0),
    makeCard('CD1_1', 1), makeCard('CD1_2', 0),
    makeCard('CD2_1', 0), makeCard('CD2_2', 1)
  ], Buffer.alloc(4));
  assert.throws(() => parsePrimaryImage(huge), (e) => e.code === 'TRUNCATED_DATA' || e.code === 'DIMENSION_PRODUCT_OVERFLOW');

  const truncated = makeImageFits({ width: 100, height: 100 }).subarray(0, BLOCK + 100);
  assert.throws(() => parsePrimaryImage(truncated), (e) => e.code === 'TRUNCATED_DATA');
});
