/**
 * Coordinate-grid generation performed entirely server-side.
 *
 * Grid lines are true constant-RA meridians and constant-Dec parallels on
 * the sky, projected back into source *pixel* coordinates through the
 * (possibly rotated, near-hemisphere-edge) source TAN/CD WCS. Segments
 * that fail inverse projection (the back of the tangent sphere) break
 * the polyline instead of being drawn outside the visible hemisphere.
 *
 * RA ranges are kept in an *unwrapped* frame centred on CRVAL1, so grids
 * that straddle the RA=0/360 meridian come out correctly.
 */

import { skyToPixel, pixelToSky, deg2rad, rad2deg } from './wcs.js';

const SAMPLES_PER_LINE = 96;

function raOffset(raDeg, ra0Deg) {
  let d = raDeg - ra0Deg;
  d = ((d + 180) % 360 + 360) % 360 - 180;
  return d;
}

function niceStep(spanDeg) {
  const rough = spanDeg / 6;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const n = rough / pow;
  let f;
  if (n < 1.5) f = 1;
  else if (n < 3.5) f = 2;
  else if (n < 7.5) f = 5;
  else f = 10;
  return f * pow;
}

/** Sky extent of the image in unwrapped RA offset (relative to CRVAL) and Dec. */
export function footprint(wcs, width, height, samples = 24) {
  const ra0 = wcs.crval[0];
  let dRaMin = Infinity;
  let dRaMax = -Infinity;
  let decMin = Infinity;
  let decMax = -Infinity;
  let any = false;
  for (let iy = 0; iy <= samples; iy++) {
    for (let ix = 0; ix <= samples; ix++) {
      const px = 1 + (ix / samples) * width;
      const py = 1 + (iy / samples) * height;
      const s = pixelToSky(wcs, px, py);
      if (!s) continue;
      any = true;
      const off = raOffset(s.ra, ra0);
      if (off < dRaMin) dRaMin = off;
      if (off > dRaMax) dRaMax = off;
      if (s.dec < decMin) decMin = s.dec;
      if (s.dec > decMax) decMax = s.dec;
    }
  }
  if (!any) return null;
  return { raCenter: ra0, dRaMin, dRaMax, decMin, decMax };
}

function roundTick(v, step) {
  const digits = step >= 1 ? 4 : Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(v.toFixed(digits));
}

/**
 * Grid polylines in 0-based source pixel coordinates plus labels.
 * lines: [{type:'ra'|'dec', value, points:[x,y,...]}] (NaN pair = pen-up)
 * labels:[{x,y,text}]
 */
export function buildGrid(wcs, width, height) {
  const fp = footprint(wcs, width, height, 22);
  if (!fp) return { lines: [], labels: [], stepRa: null, stepDec: null, footprint: null };

  const spanRa = Math.max(fp.dRaMax - fp.dRaMin, 1e-9);
  const spanDec = Math.max(fp.decMax - fp.decMin, 1e-9);
  const stepRa = niceStep(spanRa);
  const stepDec = niceStep(spanDec);

  const lines = [];
  const labels = [];

  const project = (ra, dec) => {
    const p = skyToPixel(wcs, ra, dec);
    if (!p) return null;
    return [p[0] - 1, p[1] - 1];
  };

  const emit = (type, value, skyAt, labelSky, labelText) => {
    const points = [];
    let cur = [];
    for (let i = 0; i <= SAMPLES_PER_LINE; i++) {
      const { ra, dec } = skyAt(i / SAMPLES_PER_LINE);
      const p = project(ra, dec);
      if (!p) {
        if (cur.length) {
          points.push(...cur);
          cur = [];
        }
        points.push(NaN, NaN);
        continue;
      }
      cur.push(p[0], p[1]);
    }
    if (cur.length) points.push(...cur);
    lines.push({ type, value, points });
    if (labelSky) {
      const lp = project(labelSky.ra, labelSky.dec);
      if (lp) labels.push({ x: lp[0], y: lp[1], text: labelText });
    }
  };

  const normRa = (deg) => ((deg % 360) + 360) % 360;

  // Constant-Declination parallels (RA varies across the unwrapped range).
  for (let dec = Math.ceil(fp.decMin / stepDec) * stepDec;
    dec <= fp.decMax + 1e-9;
    dec += stepDec) {
    const tick = roundTick(dec, stepDec);
    emit(
      'dec',
      tick,
      (t) => ({ ra: normRa(fp.raCenter + fp.dRaMin + t * spanRa), dec }),
      { ra: normRa(fp.raCenter), dec },
      `${formatSignedDeg(tick)}°`
    );
  }

  // Constant-RA meridians (Dec varies); ticks chosen on the unwrapped axis.
  for (let off = Math.ceil(fp.dRaMin / stepRa) * stepRa;
    off <= fp.dRaMax + 1e-9;
    off += stepRa) {
    const ra = normRa(fp.raCenter + off);
    emit(
      'ra',
      roundTick(ra, stepRa),
      (t) => ({ ra, dec: fp.decMin + t * spanDec }),
      { ra, dec: (fp.decMin + fp.decMax) / 2 },
      `${formatRa(ra)}`
    );
  }

  return { lines, labels, stepRa, stepDec, footprint: fp };
}

export function formatRa(deg) {
  const h = deg / 15;
  const hh = Math.floor(h);
  const mF = (h - hh) * 60;
  const mm = Math.floor(mF);
  const ss = (mF - mm) * 60;
  return `${pad(hh)}h${pad(mm)}m${ss.toFixed(1).padStart(4, '0')}s`;
}

export function formatSignedDeg(deg) {
  return deg.toFixed(Math.max(0, -Math.floor(Math.log10(1)) + 2));
}

export function formatDecDms(deg) {
  const sign = deg < 0 ? '-' : '+';
  const a = Math.abs(deg);
  const dd = Math.floor(a);
  const mF = (a - dd) * 60;
  const mm = Math.floor(mF);
  const ss = (mF - mm) * 60;
  return `${sign}${pad(dd)}°${pad(mm)}′${ss.toFixed(1).padStart(4, '0')}″`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export { deg2rad, rad2deg };
