/**
 * Server-side rasterization of pixel data into RGBA preview PNGs.
 * All numbers used here are *physical* values (BSCALE/BZERO applied);
 * missing values are NaN and render fully transparent.
 */

import { rawView, isMissingRaw } from './fits.js';
import { encodePng } from './png.js';

/** Convert a physical Float64Array grid (NaN=missing) into RGBA bytes. */
export function rasterizeGray(values, width, height, vmin, vmax) {
  const out = Buffer.alloc(width * height * 4);
  const span = vmax - vmin || 1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const o = i * 4;
    if (!Number.isFinite(v)) {
      out[o + 3] = 0; // transparent: missing / outside / off-hemisphere
      continue;
    }
    let t = (v - vmin) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    // gamma 0.8 keeps faint sources visible
    t = Math.pow(t, 0.8);
    const g = Math.round(t * 255);
    out[o] = g;
    out[o + 1] = g;
    out[o + 2] = g;
    out[o + 3] = 255;
  }
  return out;
}

export function pngFromValues(values, width, height, vmin, vmax) {
  return encodePng(rasterizeGray(values, width, height, vmin, vmax), width, height);
}

/** Robust min/max over finite values; returns null when none exist. */
export function finiteRange(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (lo === Infinity) return null;
  return { vmin: lo, vmax: hi };
}

/**
 * Build a small physical-value grid of the whole source image by
 * nearest-neighbour sampling on a regular stride. The mapping from
 * overview pixels to source pixels is returned so the client can ask
 * the server for exact sky coordinates of overview/screen positions.
 */
export function buildOverview(image, maxLongSide = 320) {
  const ratio = Math.max(image.width, image.height) / maxLongSide;
  const w = Math.max(1, Math.round(image.width / ratio));
  const h = Math.max(1, Math.round(image.height / ratio));
  const raw = rawView(image);
  const values = new Float64Array(w * h);
  for (let oy = 0; oy < h; oy++) {
    const sy = Math.min(image.height - 1, Math.floor((oy + 0.5) * image.height / h));
    for (let ox = 0; ox < w; ox++) {
      const sx = Math.min(image.width - 1, Math.floor((ox + 0.5) * image.width / w));
      const r = raw[sy * image.width + sx];
      values[oy * w + ox] = isMissingRaw(image, r) ? NaN : r * image.bscale + image.bzero;
    }
  }
  const range = finiteRange(values) || { vmin: 0, vmax: 1 };
  const png = pngFromValues(values, w, h, range.vmin, range.vmax);
  return { png, width: w, height: h, vmin: range.vmin, vmax: range.vmax };
}
