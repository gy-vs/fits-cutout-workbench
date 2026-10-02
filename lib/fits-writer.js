// Writer for standalone primary-image FITS files (BITPIX=-32, NAXIS=2).
// Output is a fresh, self-contained file readable by astropy/cfitsio/ds9:
// primary header with relocated WCS reference, float32 big-endian pixels,
// NaN gaps preserved, 2880-byte block padding after END.
import { BLOCK, CARD } from './fits-parser.js';

export function formatCard(keyword, value, comment = null) {
  const key = keyword.padEnd(8, ' ');
  let body;
  if (typeof value === 'boolean') {
    // FITS: value indicator at col 9, T/F at col 30 (0-based index 29).
    body = `= ${(value ? 'T' : 'F').padStart(20, ' ')}`;
  } else if (typeof value === 'number') {
    let s;
    if (Number.isInteger(value) && Math.abs(value) < 1e9) {
      s = String(value);
    } else {
      s = formatFloat(value);
    }
    if (s.length > 20) s = formatFloat(value, true);
    body = `= ${s.padStart(20, ' ')}`;
  } else if (typeof value === 'string') {
    // Opening quote at col 11 (index 10); pad string to at least 8 chars.
    const v = value.length >= 8 ? value.slice(0, 68) : value.padEnd(8, ' ');
    body = `= '${v}'`;
    body = body.padEnd(30, ' ');
  } else {
    body = ''.padEnd(30, ' ');
  }
  let card = (key + body).slice(0, 30);
  if (comment) {
    card += (' / ' + comment).slice(0, 50);
  }
  if (card.length > CARD) throw new Error(`卡片超长: ${keyword} (${card.length})`);
  return card.padEnd(CARD, ' ');
}

function formatFloat(v, exponential = false) {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Inf' : '-Inf';
  let s = exponential ? v.toExponential(12) : (Math.abs(v) >= 1e7 || (v !== 0 && Math.abs(v) < 1e-4)
    ? v.toExponential(10) : String(v));
  // FITS accepts E or D exponent.
  return s.length <= 20 ? s : v.toExponential(8);
}

function commentCard(name, text) {
  return (name.padEnd(8, ' ') + ' ' + text).slice(0, CARD).padEnd(CARD, ' ');
}

export function writeFloatFits({ values, width, height, wcs, history = [] }) {
  if (values.length !== width * height) throw new Error('像素数与尺寸不符');
  const cards = [];
  cards.push(formatCard('SIMPLE', true, 'FITS standard'));
  cards.push(formatCard('BITPIX', -32, 'IEEE single precision float'));
  cards.push(formatCard('NAXIS', 2));
  cards.push(formatCard('NAXIS1', width));
  cards.push(formatCard('NAXIS2', height));
  cards.push(formatCard('EXTEND', false));
  cards.push(formatCard('CTYPE1', 'RA---TAN', 'WCS: gnomonic projection'));
  cards.push(formatCard('CTYPE2', 'DEC--TAN', 'WCS: gnomonic projection'));
  cards.push(formatCard('CRPIX1', wcs.crpix[0], 'relocated to cutout center'));
  cards.push(formatCard('CRPIX2', wcs.crpix[1]));
  cards.push(formatCard('CRVAL1', wcs.crval[0], '[deg] center RA'));
  cards.push(formatCard('CRVAL2', wcs.crval[1], '[deg] center Dec'));
  cards.push(formatCard('CD1_1', wcs.cd[0][0], '[deg/pix] rotation+scale'));
  cards.push(formatCard('CD1_2', wcs.cd[0][1]));
  cards.push(formatCard('CD2_1', wcs.cd[1][0]));
  cards.push(formatCard('CD2_2', wcs.cd[1][1]));
  cards.push(formatCard('RADESYS', 'ICRS'));
  cards.push(formatCard('BUNIT', 'pixel'));
  for (const h of history) cards.push(commentCard('HISTORY', String(h).slice(0, 71)));
  cards.push(commentCard('COMMENT', 'NaN marks missing source pixels (BLANK/BSCALE applied)').slice(0, CARD));
  cards.push(commentCard('END', ''));
  // Replace the END card: END must be exactly "END" + spaces, no value indicator.
  cards[cards.length - 1] = 'END'.padEnd(CARD, ' ');

  const headerBuf = Buffer.concat(cards.map((c) => Buffer.from(c, 'latin1')));
  const headerPadded = padTo(headerBuf, BLOCK, 0x20);

  const dataBuf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    dataBuf.writeFloatBE(Number.isFinite(v) ? v : NaN, i * 4);
  }
  const dataPadded = padTo(dataBuf, BLOCK, 0);
  return Buffer.concat([headerPadded, dataPadded]);
}

function padTo(buf, multiple, fill) {
  const rem = buf.length % multiple;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(multiple - rem, fill)]);
}

// Header size rounded to a 2880 boundary (for tests/inspection).
export function headerBlockSize(cardCount) {
  return Math.ceil(cardCount * CARD / BLOCK) * BLOCK;
}
