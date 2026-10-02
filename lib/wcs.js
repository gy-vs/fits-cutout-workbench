/**
 * WCS (world coordinate system) support for gnomonic (TAN) projections
 * described by CRPIX/CRVAL plus a CD matrix.
 *
 * Conventions explicitly NOT supported and rejected by buildWcs():
 *   - CDELT* / CDELT*a + PC matrix (the old CROTA2 convention likewise)
 *   - SIP polynomial distortions (CTYPE ending -SIP) or other projections
 *   - non-degree CUNIT values
 *
 * Pixel coordinates here are 1-based FITS indices at the API boundary
 * (CRPIX style); callers using 0-based array indices subtract 1 first.
 */

import { FitsError } from './fits.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const HALFPI = Math.PI / 2;

export function deg2rad(d) {
  return d * D2R;
}
export function rad2deg(r) {
  return r * R2D;
}

/** Normalize an angle in degrees to [0, 360). */
export function normalizeRa(deg) {
  let v = deg % 360;
  if (v < 0) v += 360;
  return v;
}

/**
 * Extract and validate the WCS description.
 * wcs = { crpix:[x,y] (1-based FITS), crval:[ra,dec] deg, cd:[[..],[..]] }
 */
export function buildWcs(header) {
  // Reject CDELT/PC/CROTA conventions rather than mis-labelling coordinates.
  const unsupported = [];
  for (const key of ['CDELT1', 'CDELT2', 'PC1_1', 'PC1_2', 'PC2_1', 'PC2_2', 'CROTA1', 'CROTA2']) {
    if (key in header) unsupported.push(key);
  }
  if (unsupported.length) {
    throw new FitsError(
      'UNSUPPORTED_WCS',
      `不支持 CDELT/PC/CROTA 坐标约定（发现 ${unsupported.join(', ')}），本工作台仅接受 CD 矩阵；请先在天文工具中转换为 CD 矩阵`
    );
  }

  const ctype1 = String(header.CTYPE1 ?? '').trim();
  const ctype2 = String(header.CTYPE2 ?? '').trim();
  if (!ctype1 && !ctype2 && header.CRVAL1 === undefined && header.CRPIX1 === undefined) {
    throw new FitsError('UNSUPPORTED_WCS', '头中没有 WCS 信息（缺少 CRPIX/CRVAL/CD 与 CTYPE）');
  }
  if (ctype1 !== 'RA---TAN' || ctype2 !== 'DEC--TAN') {
    throw new FitsError(
      'UNSUPPORTED_WCS',
      `仅支持 TAN 投影的 RA---TAN / DEC--TAN，文件为 ${ctype1 || '?'} / ${ctype2 || '?'}`
    );
  }

  for (const key of ['CRPIX1', 'CRPIX2', 'CRVAL1', 'CRVAL2', 'CD1_1', 'CD1_2', 'CD2_1', 'CD2_2']) {
    const v = header[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new FitsError('UNSUPPORTED_WCS', `WCS 关键字 ${key} 缺失或不是有限数值`);
    }
  }

  const cunit1 = header.CUNIT1 !== undefined ? String(header.CUNIT1).trim() : 'deg';
  const cunit2 = header.CUNIT2 !== undefined ? String(header.CUNIT2).trim() : 'deg';
  const isDeg = (u) => u === '' || u === 'deg' || u === 'degree' || u === 'degrees';
  if (!isDeg(cunit1) || !isDeg(cunit2)) {
    throw new FitsError(
      'UNSUPPORTED_WCS',
      `仅支持以度为单位的 CUNIT，文件为 ${cunit1 || '?'} / ${cunit2 || '?'}`
    );
  }

  const cd = [
    [header.CD1_1, header.CD1_2],
    [header.CD2_1, header.CD2_2],
  ];
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) {
    throw new FitsError('SINGULAR_CD', `CD 矩阵不可逆（行列式 = ${det}），无法在像素与天球坐标间转换`);
  }
  const cdInv = [
    [cd[1][1] / det, -cd[0][1] / det],
    [-cd[1][0] / det, cd[0][0] / det],
  ];

  return {
    crpix: [header.CRPIX1, header.CRPIX2],
    crval: [normalizeRa(header.CRVAL1), header.CRVAL2],
    cd,
    cdInv,
    det,
  };
}

/* ------------------------- TAN projection ------------------------- */

/**
 * Intermediate world coordinates (xi, eta in radians) -> sky (ra, dec deg).
 * Pure gnomonic projection (WCS Paper II, phi0=0), derived from the
 * tangent-plane basis at CRVAL: p = c + xi*e_east + eta*e_north, then
 * normalized onto the sphere. Note the inverse direction is always
 * defined — the whole plane maps onto the open front hemisphere, and
 * c·p = 1 guarantees that — so there is no far-side failure here.
 */
export function tanToSky(xi, eta, ra0Deg, dec0Deg) {
  const ra0 = deg2rad(ra0Deg);
  const dec0 = deg2rad(dec0Deg);
  const rho = Math.hypot(1, xi, eta);
  const sinD = (Math.sin(dec0) + Math.cos(dec0) * eta) / rho;
  const dec = Math.asin(Math.max(-1, Math.min(1, sinD)));
  const ra = ra0 + Math.atan2(xi, Math.cos(dec0) - Math.sin(dec0) * eta);
  return { ra: normalizeRa(rad2deg(ra)), dec: rad2deg(dec) };
}

/**
 * Sky (ra, dec deg) -> tangent plane (xi, eta radians).
 * Returns null for points not projectable onto this tangent plane
 * (cosine of angular distance from CRVAL must be positive).
 */
export function skyToTan(raDeg, decDeg, ra0Deg, dec0Deg) {
  const ra = deg2rad(raDeg);
  const dec = deg2rad(decDeg);
  const ra0 = deg2rad(ra0Deg);
  const dec0 = deg2rad(dec0Deg);
  const cosc =
    Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
  if (cosc <= 1e-12) return null;
  const xi = (Math.cos(dec) * Math.sin(ra - ra0)) / cosc;
  const eta =
    (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosc;
  return { xi, eta };
}

/**
 * Pixel (1-based FITS coordinates) -> sky degrees.
 * Returns {ra, dec} or null if the point falls off the tangent hemisphere.
 */
export function pixelToSky(wcs, px, py) {
  const u = px - wcs.crpix[0];
  const v = py - wcs.crpix[1];
  const xiDeg = wcs.cd[0][0] * u + wcs.cd[0][1] * v;
  const etaDeg = wcs.cd[1][0] * u + wcs.cd[1][1] * v;
  return tanToSky(xiDeg * D2R, etaDeg * D2R, wcs.crval[0], wcs.crval[1]);
}

/**
 * Sky degrees -> pixel (1-based FITS coordinates).
 * Returns null when the point is on the back side of the tangent sphere.
 */
export function skyToPixel(wcs, raDeg, decDeg) {
  const t = skyToTan(raDeg, decDeg, wcs.crval[0], wcs.crval[1]);
  if (!t) return null;
  const xiDeg = t.xi * R2D;
  const etaDeg = t.eta * R2D;
  const u = wcs.cdInv[0][0] * xiDeg + wcs.cdInv[0][1] * etaDeg;
  const v = wcs.cdInv[1][0] * xiDeg + wcs.cdInv[1][1] * etaDeg;
  return [wcs.crpix[0] + u, wcs.crpix[1] + v];
}

/** Convenience wrapper using 0-based array indices. */
export function indexToSky(wcs, x0, y0) {
  return pixelToSky(wcs, x0 + 1, y0 + 1);
}
