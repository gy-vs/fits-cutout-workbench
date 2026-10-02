/**
 * Code-generated small FITS images used both by the test suite and by the
 * page's "载入样本" button — no external observatory data needed.
 */

import { writeFits } from './fits.js';

const W = 201;
const H = 151;

/**
 * A rotated, north-ish TAN image centred near RA=10°, Dec=20°:
 *   - BITPIX 16, BSCALE 0.01, BZERO 3276.8, BLANK -32767
 *   - a bright gaussian "source" near the centre, a gradient, a grid of
 *     dim point sources, and a missing-data band (raw BLANK rows)
 *   - CD matrix is a rigid 30° rotation so RA/Dec axes are not aligned
 *     with pixel rows/columns
 */
export function makeSampleInt16() {
  const n = W * H;
  const raw = new Int16Array(n);
  const BSCALE = 0.01;
  const BZERO = 3276.8;
  const BLANK = -32767;
  const toRaw = (phys) => Math.round((phys - BZERO) / BSCALE);

  const crpix = [101.5, 76.5];
  const crval = [10, 20];
  const th = (-30 * Math.PI) / 180;
  const d = 0.02; // degrees/pixel before rotation
  // CD rows: (xi, eta) in deg. Standard FITS orientation (Dec increases with row).
  const cd = [
    [d * Math.cos(th), -d * Math.sin(th)],
    [d * Math.sin(th), d * Math.cos(th)],
  ];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // missing band: physical rows 60..64 in the image
      if (y >= 60 && y <= 64) {
        raw[y * W + x] = BLANK;
        continue;
      }
      let phys = 100 + 0.15 * x - 0.1 * y;
      // main gaussian source, offset from CRPIX by (+15, -10) pixels
      const dx = x - (crpix[0] - 1 + 15);
      const dy = y - (crpix[1] - 1 - 10);
      phys += 4000 * Math.exp(-(dx * dx + dy * dy) / (2 * 5 * 5));
      // faint grid of point sources
      if (x % 40 === 12 && y % 30 === 10) phys += 600;
      let r = toRaw(phys);
      if (r < -32767) r = -32766; // keep BLANK distinguishable
      if (r > 32767) r = 32767;
      raw[y * W + x] = r;
    }
  }

  const cards = [
    ['SIMPLE', true, 'standard FITS'],
    ['BITPIX', 16, '16-bit integer'],
    ['NAXIS', 2, ''],
    ['NAXIS1', W, 'width'],
    ['NAXIS2', H, 'height'],
    ['BSCALE', BSCALE, 'physical = raw*BSCALE+BZERO'],
    ['BZERO', BZERO, ''],
    ['BLANK', BLANK, 'missing value'],
    ['CRPIX1', crpix[0], ''],
    ['CRPIX2', crpix[1], ''],
    ['CRVAL1', crval[0], 'RA deg'],
    ['CRVAL2', crval[1], 'Dec deg'],
    ['CD1_1', cd[0][0], 'rotation -30 deg'],
    ['CD1_2', cd[0][1], ''],
    ['CD2_1', cd[1][0], ''],
    ['CD2_2', cd[1][1], ''],
    ['CTYPE1', 'RA---TAN', 'gnomonic'],
    ['CTYPE2', 'DEC--TAN', 'gnomonic'],
    ['CUNIT1', 'deg', ''],
    ['CUNIT2', 'deg', ''],
    ['RADESYS', 'ICRS', ''],
    ['OBJECT', "Alpha / Beta 'field'", 'string containing quote and slash'],
    ['EXAMPLE', 42, 'comment / containing / slashes'],
  ];
  return { fits: writeFits(cards, raw, 16, W, H), width: W, height: H, crval, crpix, cd };
}

/**
 * Float32 sample whose centre is exactly on RA=0 so cutouts straddle the
 * RA zero meridian. Missing values are float NaN.
 */
export function makeSampleFloat32() {
  const n = W * H;
  const raw = new Float32Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x === 0 || x === W - 1 || y === 0 || y === H - 1) {
        raw[y * W + x] = NaN;
        continue;
      }
      let v = 50 + 0.2 * (x - W / 2);
      const dx = x - W / 2;
      const dy = y - H / 2;
      v += 900 * Math.exp(-(dx * dx + dy * dy) / (2 * 8 * 8));
      raw[y * W + x] = v;
    }
  }
  const cards = [
    ['SIMPLE', true, ''],
    ['BITPIX', -32, '32-bit float'],
    ['NAXIS', 2, ''],
    ['NAXIS1', W, ''],
    ['NAXIS2', H, ''],
    ['CRPIX1', (W + 1) / 2, ''],
    ['CRPIX2', (H + 1) / 2, ''],
    ['CRVAL1', 0.0, 'centre exactly on RA 0'],
    ['CRVAL2', 0.0, 'on the equator'],
    ['CD1_1', 0.01, ''],
    ['CD1_2', 0, ''],
    ['CD2_1', 0, ''],
    ['CD2_2', 0.01, ''],
    ['CTYPE1', 'RA---TAN', ''],
    ['CTYPE2', 'DEC--TAN', ''],
    ['CUNIT1', 'deg', ''],
    ['CUNIT2', 'deg', ''],
    ['RADESYS', 'ICRS', ''],
  ];
  return { fits: writeFits(cards, raw, -32, W, H), width: W, height: H, crval: [0, 0] };
}

/** Header-only pathological builders for error tests. */
export function makeFitsWithCards(cards, bitpix = 16, w = 1, h = 1) {
  const raw = new Int16Array(w * h);
  const all = [
    ['SIMPLE', true, ''],
    ['BITPIX', bitpix, ''],
    ['NAXIS', 2, ''],
    ['NAXIS1', w, ''],
    ['NAXIS2', h, ''],
    ...cards,
  ];
  return writeFits(all, raw, 16, w, h);
}
