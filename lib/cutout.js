/**
 * WCS-aware cutout generation.
 *
 * Sampling strategy (defined precisely so output and preview always agree):
 *   1. The output image is a north-up TAN projection centred on the
 *      requested sky position. Its scale is derived from the requested
 *      angular field of view divided into the requested pixel count, so
 *      one output pixel covers widthDeg/outW × heightDeg/outH degrees.
 *   2. For every OUTPUT pixel centre we evaluate its sky position and
 *      invert through the SOURCE WCS (source TAN + CD). The nearest source
 *      pixel (half-to-even rounding, floor(i+0.5)) supplies the value.
 *      This "output-centred nearest neighbour" keeps original values and
 *      missing-value semantics intact; pixels outside the source array,
 *      or on the back side of the source tangent hemisphere, are missing.
 *
 * Relocation: output CRPIX points at the output centre, never reusing the
 * original CRPIX, so exported coordinates cannot drift.
 */

import { FitsError, writeFits, isMissingRaw } from './fits.js';
import { pixelToSky, skyToPixel, deg2rad, tanToSky } from './wcs.js';
import { rawView } from './fits.js';
import { rasterizeGray, finiteRange, pngFromValues } from './render.js';

export const MAX_OUTPUT_EDGE = 4096;

export function validateCutoutRequest(req) {
  const errs = [];
  const num = (name, v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const ra = num('ra', req.ra);
  const dec = num('dec', req.dec);
  const widthDeg = num('widthDeg', req.widthDeg);
  const heightDeg = num('heightDeg', req.heightDeg);
  const outW = Math.trunc(req.outW);
  const outH = Math.trunc(req.outH);

  if (!(ra >= 0 && ra < 360)) errs.push('中心赤经必须在 [0, 360) 度内');
  if (!(dec >= -90 && dec <= 90)) errs.push('中心赤纬必须在 [-90, 90] 度内');
  if (!(widthDeg > 0 && widthDeg < 180)) errs.push('角宽必须在 (0, 180) 度内');
  if (!(heightDeg > 0 && heightDeg < 180)) errs.push('角高必须在 (0, 180) 度内');
  if (!(outW > 0 && outW <= MAX_OUTPUT_EDGE)) errs.push(`输出宽须为 1..${MAX_OUTPUT_EDGE} 像素`);
  if (!(outH > 0 && outH <= MAX_OUTPUT_EDGE)) errs.push(`输出高须为 1..${MAX_OUTPUT_EDGE} 像素`);
  if (errs.length) throw new FitsError('BAD_CUTOUT', errs.join('；'));
  return { ra, dec, widthDeg, heightDeg, outW, outH };
}

/**
 * Resample a cutout. Returns a Float64Array of physical values
 * (NaN = missing) and per-class pixel counts.
 */
export function resampleCutout(image, wcs, req) {
  const { ra, dec, widthDeg, heightDeg, outW, outH } = req;
  const values = new Float64Array(outW * outH);
  const raw = rawView(image);
  let valid = 0;
  let missingSource = 0; // source BLANK/NaN
  let outside = 0; // sky not covered by source pixel grid
  let offHemisphere = 0; // inverse TAN put the point on the far hemisphere

  // North-up output CD: x to the east (increasing RA offset), y north.
  const scaleX = widthDeg / outW;
  const scaleY = heightDeg / outH;
  const crpixOut = [(outW + 1) / 2, (outH + 1) / 2];

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const idx = oy * outW + ox;
      const dRa = (ox + 1 - crpixOut[0]) * scaleX;
      const dDec = (oy + 1 - crpixOut[1]) * scaleY;
      // Local tangent-plane shift around centre (small-angle sin(lat) factor
      // absorbed by the true inverse TAN performed on the source side).
      const sky = shiftCenter(ra, dec, dRa, dDec);
      const sp = skyToPixel(wcs, sky.ra, sky.dec);
      if (!sp) {
        values[idx] = NaN;
        offHemisphere++;
        continue;
      }
      // nearest source pixel: 1-based sp -> 0-based index
      const sx = Math.floor(sp[0] - 0.5);
      const sy = Math.floor(sp[1] - 0.5);
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) {
        values[idx] = NaN;
        outside++;
        continue;
      }
      const r = raw[sy * image.width + sx];
      if (isMissingRaw(image, r)) {
        values[idx] = NaN;
        missingSource++;
        continue;
      }
      values[idx] = r * image.bscale + image.bzero;
      valid++;
    }
  }

  return {
    values,
    valid,
    missingSource,
    outside,
    offHemisphere,
    scaleX,
    scaleY,
    crpixOut,
  };
}

/**
 * Position of an output pixel on the sky. The output is a north-up TAN
 * projection centred on (raDeg, decDeg), so a pixel offset of
 * (dRaDeg, dDecDeg) is an (xi, eta) displacement in that tangent plane;
 * inverting that gnomonic projection gives its exact sky position. That
 * position is then projected through the SOURCE WCS during resampling.
 */
function shiftCenter(raDeg, decDeg, dRaDeg, dDecDeg) {
  return tanToSky(deg2rad(dRaDeg), deg2rad(dDecDeg), raDeg, decDeg);
}

/** Build the relocated output WCS header cards. */
export function outputWcsCards(req, s) {
  const { ra, dec, outW, outH } = req;
  return [
    ['CRPIX1', s.crpixOut[0], 'ref pixel (relocated to cutout centre)'],
    ['CRPIX2', s.crpixOut[1], ''],
    ['CRVAL1', ra, 'RA of cutout centre (deg)'],
    ['CRVAL2', dec, 'Dec of cutout centre (deg)'],
    ['CD1_1', s.scaleX, 'east-west degrees per output column'],
    ['CD1_2', 0, 'north-up output grid'],
    ['CD2_1', 0, ''],
    ['CD2_2', s.scaleY, 'north-south degrees per output row'],
    ['CTYPE1', 'RA---TAN', 'gnomonic'],
    ['CTYPE2', 'DEC--TAN', 'gnomonic'],
    ['CUNIT1', 'deg', ''],
    ['CUNIT2', 'deg', ''],
    ['RADESYS', 'ICRS', ''],
  ];
}

/** Assemble a standalone FITS file for a cutout, preserving missing semantics. */
export function writeCutoutFits(image, req, s) {
  const { outW, outH } = req;
  const cards = [
    ['SIMPLE', true, 'standard FITS'],
    ['BITPIX', image.bitpix, 'same storage type as source'],
    ['NAXIS', 2, 'two-dimensional image'],
    ['NAXIS1', outW, 'width'],
    ['NAXIS2', outH, 'height'],
  ];

  if (image.bitpix === 16) {
    const n = outW * outH;
    const raw = new Int16Array(n);
    const invBscale = image.bscale === 0 ? 1 : 1 / image.bscale;
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) {
        raw[i] = image.blank ?? -32768;
        continue;
      }
      let r = Math.round((v - image.bzero) * invBscale);
      if (r < -32768) r = -32768;
      if (r > 32767) r = 32767;
      raw[i] = r;
    }
    cards.push(['BSCALE', image.bscale, '']);
    cards.push(['BZERO', image.bzero, '']);
    cards.push(['BLANK', image.blank ?? -32768, 'missing value']);
    cards.push(...outputWcsCards(req, s));
    return writeFits(cards, raw, 16, outW, outH);
  }

  const raw = new Float32Array(outW * outH);
  for (let i = 0; i < raw.length; i++) raw[i] = Number.isFinite(s.values[i]) ? s.values[i] : NaN;
  cards.push(...outputWcsCards(req, s));
  return writeFits(cards, raw, -32, outW, outH);
}

/** Render the small PNG preview of a cutout and return its display stats. */
export function renderCutoutPreview(req, s, maxLongSide = 300) {
  const { outW, outH } = req;
  const ratio = Math.max(outW, outH) / maxLongSide;
  const pw = Math.max(1, Math.round(outW / ratio));
  const ph = Math.max(1, Math.round(outH / ratio));
  const small = new Float64Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(outW - 1, Math.floor((x + 0.5) * outW / pw));
      const sy = Math.min(outH - 1, Math.floor((y + 0.5) * outH / ph));
      small[y * pw + x] = s.values[sy * outW + sx];
    }
  }
  const range = finiteRange(small) || { vmin: 0, vmax: 1 };
  const png = pngFromValues(small, pw, ph, range.vmin, range.vmax);
  return { png, width: pw, height: ph, vmin: range.vmin, vmax: range.vmax };
}

/* --------------- rectangle (0-based pixels) -> sky box --------------- */

/**
 * Sky footprint of a source-pixel rectangle used to prefill the form when
 * the user drags a region. Pixel corners are evaluated at pixel CENTRES.
 */
export function rectangleSky(wcs, x0, y0, x1, y1) {
  const fx = Math.min(x0, x1);
  const fy = Math.min(y0, y1);
  const fx2 = Math.max(x0, x1);
  const fy2 = Math.max(y0, y1);
  // Bounds are 0-based half-open [x0,x1); the first/last pixel CENTRES in
  // 1-based FITS coordinates are x0+1 and x1 (similarly for y).
  const corners = [
    pixelToSky(wcs, fx + 1, fy + 1),
    pixelToSky(wcs, fx2, fy + 1),
    pixelToSky(wcs, fx + 1, fy2),
    pixelToSky(wcs, fx2, fy2),
  ];
  if (corners.some((c) => !c)) {
    throw new FitsError('RECT_NOT_PROJECTABLE', '所选矩形的角点超出源图 TAN 可见半球，无法给出可靠角尺寸');
  }
  const cx = (fx + fx2) / 2;
  const cy = (fy + fy2) / 2;
  const cSky = pixelToSky(wcs, cx + 1, cy + 1);
  if (!cSky) {
    throw new FitsError('RECT_NOT_PROJECTABLE', '矩形中心超出 TAN 可见半球');
  }
  // Angular extent: max corner separation along east/north around centre,
  // via gnomonic intermediate coordinates relative to the centre.
  let east = 0;
  let north = 0;
  for (const c of corners) {
    const d = intermediateOffset(cSky.ra, cSky.dec, c.ra, c.dec);
    east = Math.max(east, Math.abs(d.xi));
    north = Math.max(north, Math.abs(d.eta));
  }
  return {
    pixelBounds: { x0: fx, y0: fy, x1: fx2, y1: fy2 },
    center: { ra: cSky.ra, dec: cSky.dec },
    widthDeg: 2 * east,
    heightDeg: 2 * north,
  };
}

/** Offset (deg) of a sky point relative to a tangent point, via TAN plane. */
function intermediateOffset(ra0Deg, dec0Deg, raDeg, decDeg) {
  const ra0 = deg2rad(ra0Deg);
  const dec0 = deg2rad(dec0Deg);
  const ra = deg2rad(raDeg);
  const dec = deg2rad(decDeg);
  const cosc =
    Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
  if (cosc <= 1e-12) return { xi: NaN, eta: NaN };
  const xi = Math.cos(dec) * Math.sin(ra - ra0) / cosc;
  const eta =
    (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosc;
  return { xi: (xi * 180) / Math.PI, eta: (eta * 180) / Math.PI };
}

export { rasterizeGray };
