// Test helpers: build FITS byte buffers and malformed variants in-memory.
import { writeFloatFits } from '../lib/fits-writer.js';

export const CARD = 80;
export const BLOCK = 2880;

export function makeCard(keyword, value, comment = '') {
  const key = keyword.padEnd(8, ' ');
  let val;
  if (typeof value === 'boolean') val = `= ${value ? 'T' : 'F'}`.padEnd(20, ' ');
  else if (typeof value === 'number') {
    const s = Number.isInteger(value) ? String(value) : String(value).toUpperCase();
    val = `= ${s.padStart(20, ' ')}`;
  } else {
    val = `= '${value.padEnd(8, ' ')}'`.padEnd(30, ' ');
  }
  let line = (key + val).slice(0, 30);
  if (comment) line += ` / ${comment}`;
  return line.slice(0, CARD).padEnd(CARD, ' ');
}

export function buildRawFits(cardLines, dataBuf) {
  const all = cardLines.concat(['END'.padEnd(CARD, ' ')]);
  let hbuf = Buffer.concat(all.map((c) => Buffer.from(c, 'latin1')));
  const hpad = hbuf.length % BLOCK ? BLOCK - (hbuf.length % BLOCK) : 0;
  hbuf = Buffer.concat([hbuf, Buffer.alloc(hpad, 0x20)]);
  let dbuf = dataBuf;
  const dpad = dbuf.length % BLOCK ? BLOCK - (dbuf.length % BLOCK) : 0;
  dbuf = Buffer.concat([dbuf, Buffer.alloc(dpad, 0)]);
  return Buffer.concat([hbuf, dbuf]);
}

export function makeImageFits({
  width = 24, height = 18, bitpix = -32,
  crval = [120.5, 30.25],
  crpix = [12.5, 9.5],
  cd = [[0.01, 0.002], [-0.002, 0.01]],
  bscale = 1, bzero = 0, blank = null,
  ctype1 = 'RA---TAN', ctype2 = 'DEC--TAN',
  valueFn = (x, y) => 10 + x + y * 0.5,
  extra = []
} = {}) {
  const lines = [
    makeCard('SIMPLE', true),
    makeCard('BITPIX', bitpix),
    makeCard('NAXIS', 2),
    makeCard('NAXIS1', width),
    makeCard('NAXIS2', height),
    makeCard('CTYPE1', ctype1),
    makeCard('CTYPE2', ctype2),
    makeCard('CRPIX1', crpix[0]),
    makeCard('CRPIX2', crpix[1]),
    makeCard('CRVAL1', crval[0]),
    makeCard('CRVAL2', crval[1]),
    makeCard('CD1_1', cd[0][0]), makeCard('CD1_2', cd[0][1]),
    makeCard('CD2_1', cd[1][0]), makeCard('CD2_2', cd[1][1])
  ];
  let data;
  if (bitpix === -32) {
    data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = valueFn(x, y, width, height);
      data.writeFloatBE(Number.isNaN(v) ? NaN : v, (y * width + x) * 4);
    }
  } else {
    data = Buffer.alloc(width * height * 2);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = valueFn(x, y, width, height);
      data.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(v))), (y * width + x) * 2);
    }
    lines.push(makeCard('BSCALE', bscale), makeCard('BZERO', bzero));
    if (blank !== null) lines.push(makeCard('BLANK', blank));
  }
  lines.push(...extra);
  return buildRawFits(lines, data);
}

// Build a cutout-shaped output file via the real writer (for round-trip tests).
export function writeCutout({ values, width, height, wcs }) {
  return writeFloatFits({ values, width, height, wcs });
}
