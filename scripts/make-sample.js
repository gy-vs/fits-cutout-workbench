// Generates small, self-contained FITS test images WITHOUT external data:
//   samples/sample_float.fits  BITPIX=-32, rotated CD matrix, NaN gaps,
//                              centered away from RA=0 by default plus a
//                              RA-wrap variant
//   samples/sample_int16.fits  BITPIX=16 with BSCALE/BZERO/BLANK
// These let anyone verify headers, big-endian pixel order, WCS round trips and
// cutout re-reading with no observatory data at hand.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCK = 2880, CARD = 80;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'samples');
mkdirSync(OUT, { recursive: true });

function card(keyword, value, comment = '') {
  const key = keyword.padEnd(8, ' ');
  let val;
  if (typeof value === 'boolean') val = `= ${value ? 'T' : 'F'}`.padEnd(20, ' ');
  else if (typeof value === 'number') {
    let s = Number.isInteger(value) ? String(value) : value.toString().toUpperCase();
    val = `= ${s.padStart(20, ' ')}`;
  } else {
    val = `= '${value.padEnd(8, ' ')}'`.padEnd(30, ' ');
  }
  let line = (key + val).slice(0, 30);
  if (comment) line += ` / ${comment}`;
  return line.slice(0, CARD).padEnd(CARD, ' ');
}
function textCard(k, t) {
  return (k.padEnd(8, ' ') + '  ' + t).slice(0, CARD).padEnd(CARD, ' ');
}
function buildFits(headerCards, dataBuf, bitpix) {
  const must = [
    card('SIMPLE', true, 'conforms to FITS standard'),
    card('BITPIX', bitpix),
    card('NAXIS', 2),
    card('NAXIS1', dataBuf._w),
    card('NAXIS2', dataBuf._h)
  ];
  const all = must.concat(headerCards);
  all.push('END'.padEnd(CARD, ' '));
  let hbuf = Buffer.concat(all.map((c) => Buffer.from(c, 'latin1')));
  hbuf = pad(hbuf, BLOCK, 0x20);
  return Buffer.concat([hbuf, pad(dataBuf, BLOCK, 0)]);
}
function pad(b, m, fill) {
  const r = b.length % m;
  return r === 0 ? b : Buffer.concat([b, Buffer.alloc(m - r, fill)]);
}

function wcsCards({ crval, crpix, cd }) {
  return [
    card('CTYPE1', 'RA---TAN'),
    card('CTYPE2', 'DEC--TAN'),
    card('CRPIX1', crpix[0]),
    card('CRPIX2', crpix[1]),
    card('CRVAL1', crval[0]),
    card('CRVAL2', crval[1]),
    card('CD1_1', cd[0][0]), card('CD1_2', cd[0][1]),
    card('CD2_1', cd[1][0]), card('CD2_2', cd[1][1]),
    card('RADESYS', 'ICRS')
  ];
}

// Smooth + structured synthetic sky so bilinear resampling is testable.
function skyValue(x, y, w, h) {
  const u = (x - w / 2) / w, v = (y - h / 2) / h;
  const g1 = 100 * Math.exp(-((u - 0.22) ** 2 + (v + 0.15) ** 2) / 0.012);
  const g2 = 60 * Math.exp(-((u + 0.3) ** 2 + (v - 0.25) ** 2) / 0.03);
  const gradient = 10 + 40 * (u + 0.5);
  const stripes = 5 * Math.sin(x * 0.35) * Math.cos(y * 0.27);
  return gradient + g1 + g2 + stripes;
}

function makeFloat(w, h, opts = {}) {
  const buf = Buffer.alloc(w * h * 4);
  buf._w = w; buf._h = h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = skyValue(x, y, w, h);
      // A missing-data strip and a small hole.
      if (opts.gaps && (x === Math.floor(w * 0.7) ||
          (Math.abs(x - w * 0.4) < 2 && Math.abs(y - h * 0.6) < 2))) v = NaN;
      buf.writeFloatBE(v, (y * w + x) * 4);
    }
  }
  const angle = (opts.rotationDeg ?? 25) * Math.PI / 180;
  const scale = opts.scaleDeg ?? 0.01; // deg/pixel
  const cd = [
    [Math.cos(angle) * scale, Math.sin(angle) * scale],
    [-Math.sin(angle) * scale, Math.cos(angle) * scale]
  ];
  const cards = wcsCards({
    crval: [opts.ra0 ?? 187.7, opts.dec0 ?? 12.3],
    crpix: [w / 2 + 0.5, h / 2 + 0.5],
    cd
  }).concat([card('BUNIT', 'Jy/beam')]);
  return buildFits(cards, buf, -32);
}

function makeInt16(w, h, opts = {}) {
  const BSCALE = 0.1, BZERO = 3276.8; // physical = raw*0.1 + 3276.8 -> range ~ 0..6553
  const BLANK = -32768;
  const raw = Buffer.alloc(w * h * 2);
  raw._w = w; raw._h = h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r;
      if (opts.gaps && x === Math.floor(w * 0.6)) r = BLANK;
      else {
        const phys = skyValue(x, y, w, h) + 100;
        r = Math.round((phys - BZERO) / BSCALE);
        r = Math.max(-32767, Math.min(32767, r));
      }
      raw.writeInt16BE(r, (y * w + x) * 2);
    }
  }
  const angle = (opts.rotationDeg ?? -15) * Math.PI / 180;
  const scale = opts.scaleDeg ?? 0.02;
  const cd = [
    [Math.cos(angle) * scale, -Math.sin(angle) * scale],
    [Math.sin(angle) * scale, Math.cos(angle) * scale]
  ];
  const cards = wcsCards({
    crval: [opts.ra0 ?? 83.5, opts.dec0 ?? -4.2],
    crpix: [w / 2 + 0.5, h / 2 + 0.5],
    cd
  }).concat([
    card('BSCALE', BSCALE), card('BZERO', BZERO),
    card('BLANK', BLANK), card('BUNIT', 'K')
  ]);
  return buildFits(cards, raw, 16);
}

// Variant centered exactly on RA=0 to exercise wrap handling.
function makeRaWrap() {
  return makeFloat(48, 40, { ra0: 0, dec0: 0, rotationDeg: 10, gaps: true });
}

const floatFits = makeFloat(96, 72, { gaps: true });
const intFits = makeInt16(64, 48, { gaps: true });
const wrapFits = makeRaWrap();
writeFileSync(join(OUT, 'sample_float.fits'), floatFits);
writeFileSync(join(OUT, 'sample_int16.fits'), intFits);
writeFileSync(join(OUT, 'sample_ra0_wrap.fits'), wrapFits);
console.log(`wrote samples/sample_float.fits (${floatFits.length} bytes)`);
console.log(`wrote samples/sample_int16.fits (${intFits.length} bytes)`);
console.log(`wrote samples/sample_ra0_wrap.fits (${wrapFits.length} bytes)`);
