// Celestial WCS for the supported subset: 2-D, RA/DEC, gnomonic (TAN),
// linear transform given by a CD matrix (degrees per pixel).
//
// Conventions (FITS WCS Paper II, gnomonic/TAN):
//   pixel coords are 1-based; array element j spans [j+1, j+2) and its center
//   is at FITS pixel coordinate j+1 (e.g. the first pixel center is 1.0)
//   intermediate:  p = CD * (pixel - CRPIX)          (degrees on tangent plane)
//   sky -> plane and plane -> sky use the standard TAN equations below.
// All angular math is done in radians internally.
import { fail } from './errors.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export class TanWcs {
  constructor({ crpix, crval, cd }, width = null, height = null) {
    this.crpix = crpix.slice();
    this.crval = crval.slice(); // degrees [RA, Dec]
    this.cd = cd.map((row) => row.slice());
    this.det = this.cd[0][0] * this.cd[1][1] - this.cd[0][1] * this.cd[1][0];
    if (!Number.isFinite(this.det) || Math.abs(this.det) < 1e-30) {
      throw fail('SINGULAR_CD_MATRIX', 'CD 矩阵不可逆（行列式为零或接近零）');
    }
    this.invCd = [
      [ this.cd[1][1] / this.det, -this.cd[0][1] / this.det],
      [-this.cd[1][0] / this.det,  this.cd[0][0] / this.det]
    ];
    this.width = width;
    this.height = height;
    this.ra0 = crval[0] * D2R;
    this.dec0 = crval[1] * D2R;
  }

  // pixel (1-based, may be fractional) -> [RA deg, Dec deg] or null when the
  // forward TAN ray has no sky intersection. For TAN every finite plane point
  // maps, but points near/beyond the hemisphere opposite the pole are invalid;
  // gnomonic can only show the hemisphere containing CRVAL.
  pixelToSky(px, py) {
    const dx = px - this.crpix[0];
    const dy = py - this.crpix[1];
    const p1 = (this.cd[0][0] * dx + this.cd[0][1] * dy) * D2R;
    const p2 = (this.cd[1][0] * dx + this.cd[1][1] * dy) * D2R;
    const rho2 = p1 * p1 + p2 * p2;
    const rho = Math.sqrt(rho2);
    const c = Math.atan(rho);
    const sinC = Math.sin(c);
    const cosC = Math.cos(c);
    const dec = Math.asin(cosC * Math.sin(this.dec0) +
      (rho === 0 ? 0 : p2 * sinC * Math.cos(this.dec0) / rho));
    const ra = mod2pi(this.ra0 +
      Math.atan2(p1 * sinC, rho * Math.cos(this.dec0) * cosC +
        (rho === 0 ? 0 : p2 * Math.sin(this.dec0) * sinC)));
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
    // TAN cannot reach the antipodal hemisphere; reject numerically degenerate.
    if (Math.cos(this.dec0) * Math.cos(dec) *
        Math.cos(ra - this.ra0) + Math.sin(this.dec0) * Math.sin(dec) < -1e-9) {
      return null;
    }
    return [ra * R2D, dec * R2D];
  }

  // [RA deg, Dec deg] -> pixel (1-based) or null when the sky point lies on or
  // beyond the visible hemisphere boundary (cos c <= 0).
  skyToPixel(raDeg, decDeg) {
    const ra = raDeg * D2R;
    const dec = decDeg * D2R;
    const dra = normalizeDelta(ra - this.ra0);
    const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
    const sinDec0 = Math.sin(this.dec0), cosDec0 = Math.cos(this.dec0);
    const cosC = sinDec0 * sinDec + cosDec0 * cosDec * Math.cos(dra);
    if (!(cosC > 1e-12)) return null; // on / beyond the hemisphere edge
    const xi = (cosDec * Math.sin(dra)) / cosC;
    const eta = (cosDec0 * sinDec - sinDec0 * cosDec * Math.cos(dra)) / cosC;
    const p1 = xi * R2D;
    const p2 = eta * R2D;
    // [dx,dy] = invCD * [p1,p2]
    const dx = this.invCd[0][0] * p1 + this.invCd[0][1] * p2;
    const dy = this.invCd[1][0] * p1 + this.invCd[1][1] * p2;
    return [this.crpix[0] + dx, this.crpix[1] + dy];
  }

  // Bounding sky region covered by a rectangle of output pixels.
  // Returns null for sky points that fail inverse projection.
  skyBoundsOfPixelRect(x0, y0, x1, y1, samples = 24) {
    let raMin = Infinity, raMax = -Infinity;
    let decMin = Infinity, decMax = -Infinity;
    let validCount = 0;
    const sampleAt = (fx, fy) => {
      // corner convention: pixel centers sampled; add half-pixel border points
      const sky = this.pixelToSky(fx, fy);
      if (!sky) return;
      validCount++;
      const u = unwrap(sky[0], this.crval[0]);
      raMin = Math.min(raMin, u); raMax = Math.max(raMax, u);
      decMin = Math.min(decMin, sky[1]); decMax = Math.max(decMax, sky[1]);
    };
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const fx = x0 + (x1 - x0) * t;
      const fy = y0 + (y1 - y0) * t;
      sampleAt(fx, y0); sampleAt(fx, y1);
      sampleAt(x0, fy); sampleAt(x1, fy);
    }
    if (validCount === 0) return null;
    return {
      raMin, raMax, decMin, decMax,
      raCenter: wrap360((raMin + raMax) / 2),
      decCenter: (decMin + decMax) / 2
    };
  }
}

export function mod2pi(a) {
  let v = a % (2 * Math.PI);
  if (v < 0) v += 2 * Math.PI;
  return v;
}
export function wrap360(deg) {
  let v = deg % 360;
  if (v < 0) v += 360;
  return v;
}
// Smallest signed angle of (a - b) in radians, range (-pi, pi].
export function normalizeDelta(a) {
  let v = a % (2 * Math.PI);
  if (v > Math.PI) v -= 2 * Math.PI;
  if (v <= -Math.PI) v += 2 * Math.PI;
  return v;
}
// Unwrap RA relative to a reference so lines crossing RA=0 stay continuous.
export function unwrap(raDeg, refDeg) {
  let v = raDeg;
  while (v - refDeg > 180) v -= 360;
  while (v - refDeg < -180) v += 360;
  return v;
}

// "Nice" grid step in degrees aiming for ~4-9 intervals across the span.
export function niceStep(spanDeg) {
  const raw = spanDeg / 6;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const candidates = [0.25, 0.5, 1, 2, 2.5, 5, 10].map((m) => m * pow);
  for (const c of candidates) if (c >= raw) return c;
  return 10 * pow;
}
