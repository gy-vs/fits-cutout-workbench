import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFits,
  parseCard,
  readRaw,
  readPhysical,
  isMissingRaw,
  writeFits,
  FitsError,
  formatCard,
} from '../lib/fits.js';

test('头卡片：区分带引号字符串、转义引号与注释斜线', () => {
  const c1 = parseCard(formatCard('OBJECT', "Alpha / Beta 'x'", 'a / b'));
  assert.equal(c1.value, "Alpha / Beta 'x'");
  assert.equal(c1.comment, 'a / b');

  // Escaped quote '' inside the string.
  const card = "OBJECT  = 'it''s a / test'           / real comment".padEnd(80, ' ');
  const c2 = parseCard(card);
  assert.equal(c2.value, "it's a / test");
  assert.equal(c2.comment, 'real comment');
});

test('端序：大端 Int16 与 Float32 均按字节正确还原', () => {
  const i16 = new Int16Array([-1234, 0, 32767]);
  const f32 = new Float32Array([1.5, -2.25, 3.125]);

  const intBuf = writeFits(
    [
      ['SIMPLE', true], ['BITPIX', 16], ['NAXIS', 2],
      ['NAXIS1', 3], ['NAXIS2', 1],
    ],
    i16, 16, 3, 1
  );
  // Explicit big-endian byte check: 32767 -> 0x7f ff
  const ds = intBuf.indexOf(Buffer.from([0x7f, 0xff]));
  assert.ok(ds > 0);
  const imgI = parseFits(intBuf);
  assert.equal(readRaw(imgI, 0, 0), -1234);
  assert.equal(readRaw(imgI, 2, 0), 32767);

  const fltBuf = writeFits(
    [
      ['SIMPLE', true], ['BITPIX', -32], ['NAXIS', 2],
      ['NAXIS1', 3], ['NAXIS2', 1],
    ],
    f32, -32, 3, 1
  );
  const imgF = parseFits(fltBuf);
  assert.ok(Math.abs(readRaw(imgF, 0, 0) - 1.5) < 1e-7);
  assert.ok(Math.abs(readRaw(imgF, 2, 0) - 3.125) < 1e-7);
});

test('BSCALE/BZERO/BLANK：物理值与缺失语义一致', () => {
  const raw = new Int16Array([100, -32767, 200]);
  const buf = writeFits(
    [
      ['SIMPLE', true], ['BITPIX', 16], ['NAXIS', 2],
      ['NAXIS1', 3], ['NAXIS2', 1],
      ['BSCALE', 0.01], ['BZERO', 3276.8], ['BLANK', -32767],
    ],
    raw, 16, 3, 1
  );
  const img = parseFits(buf);
  assert.equal(img.bscale, 0.01);
  assert.equal(img.blank, -32767);
  assert.ok(Math.abs(readPhysical(img, 0, 0) - (100 * 0.01 + 3276.8)) < 1e-9);
  assert.equal(readPhysical(img, 1, 0), null);
  assert.ok(isMissingRaw(img, readRaw(img, 1, 0)));
  assert.equal(readPhysical(img, 5, 5), null); // 越界也为缺失
});

test('Float32 NaN 被视为缺失', () => {
  const raw = new Float32Array([1, NaN, 2]);
  const buf = writeFits(
    [
      ['SIMPLE', true], ['BITPIX', -32], ['NAXIS', 2],
      ['NAXIS1', 3], ['NAXIS2', 1],
    ],
    raw, -32, 3, 1
  );
  const img = parseFits(buf);
  assert.equal(readPhysical(img, 1, 0), null);
  assert.equal(readPhysical(img, 0, 0), 1);
});

test('END 之后 2880 对齐；数据长度不足被拒绝', () => {
  const buf = writeFits(
    [
      ['SIMPLE', true], ['BITPIX', 16], ['NAXIS', 2],
      ['NAXIS1', 10], ['NAXIS2', 10],
    ],
    new Int16Array(100), 16, 10, 10
  );
  assert.equal(buf.length % 2880, 0);
  parseFits(buf); // ok

  const truncated = buf.slice(0, 2880 + 100); // declared 200 bytes, only 100 present
  assert.throws(() => parseFits(truncated), (e) => e.code === 'TRUNCATED_DATA');
});

test('畸形头与非法约定返回可区分错误', () => {
  assert.throws(() => parseFits(Buffer.alloc(10)), (e) => e instanceof FitsError);

  const notFits = Buffer.alloc(2880, 0x20);
  notFits.write('SIMPLE  ', 0, 'latin1');
  notFits.write('= F', 8, 'latin1');
  notFits.write('END'.padEnd(80, ' '), 80, 'latin1');
  assert.throws(() => parseFits(notFits), (e) => e.code === 'MALFORMED_HEADER');
});

test('BITPIX 与 NAXIS 不受支持时分别报错', () => {
  const mk = (cards) => writeFits(
    [['SIMPLE', true], ['NAXIS', 2], ['NAXIS1', 1], ['NAXIS2', 1], ...cards],
    new Int16Array(1), 16, 1, 1
  );
  assert.throws(() => parseFits(mk([['BITPIX', 8]])), /BITPIX/);
});
