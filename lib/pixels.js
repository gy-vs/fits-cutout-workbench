// Pixel access and resampling with one consistent missing-value rule used by
// both the on-screen sampling and the exported file:
//   BITPIX=16: stored value == BLANK -> NaN; otherwise physical = raw*BSCALE+BZERO
//   BITPIX=-32: NaN stored floats -> NaN
// The export is always written as BITPIX=-32 physical values with NaN gaps,
// so BSCALE/BZERO/BLANK semantics survive the round trip.
//
// Single coordinate convention everywhere in this module: FITS 1-based pixel
// coordinates, identical to what the WCS code uses. Array column j (0-based)
// occupies [j, j+1) and its center is at pixel coordinate j+1. To read array
// element j, call the reader with the integer j+1.

// Reader takes FITS 1-based (possibly fractional) pixel coordinates. Integer
// values j+1 land exactly on array element j (floor(j+1)-1 = j).
export function makePixelReader(image) {
  const { width, height, bitpix, data, bscale, bzero, blank } = image;
  const readAt = (ix, iy) => {
    // ix,iy are 0-based array indices.
    if (bitpix === 16) {
      const raw = data.readInt16BE((iy * width + ix) * 2);
      if (blank !== null && raw === blank) return NaN;
      return raw * bscale + bzero;
    }
    return data.readFloatBE((iy * width + ix) * 4); // NaN propagates
  };
  return function atFitsPixel(px, py) {
    // FITS pixel coords: subtract 1 then take the containing array element.
    const ix = Math.floor(px - 1), iy = Math.floor(py - 1);
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return NaN;
    return readAt(ix, iy);
  };
}

// Nearest-neighbor read at fractional FITS pixel coordinates.
export function sampleNearest(reader, px, py, width, height) {
  const ix = Math.floor(px + 0.5) - 1, iy = Math.floor(py + 0.5) - 1;
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return NaN;
  return reader(ix + 1, iy + 1);
}

// Bilinear interpolation at fractional FITS 1-based pixel coordinates.
// Defined policy (single strategy used for export and any off-grid sampling):
//   - centers outside [1,width]x[1,height] -> NaN (no extrapolation)
//   - each non-finite neighbor carries zero weight; weights renormalize
//   - if all four neighbors are missing -> NaN
export function resampleBilinear(reader, px, py, width, height) {
  // Convert to 0-based continuous sample coordinate with pixel j centered at j.
  const x = px - 1, y = py - 1;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  // On the far border clamp to the last available pair of neighbors.
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0, fy = y - y0;
  const w = [
    (1 - fx) * (1 - fy), fx * (1 - fy),
    (1 - fx) * fy, fx * fy
  ];
  const xs = [x0, x1, x0, x1];
  const ys = [y0, y0, y1, y1];
  let acc = 0, wsum = 0;
  for (let i = 0; i < 4; i++) {
    const v = reader(xs[i] + 1, ys[i] + 1); // back to FITS coords
    if (Number.isFinite(v)) { acc += v * w[i]; wsum += w[i]; }
  }
  if (wsum === 0) return NaN;
  return acc / wsum;
}

// Block-average overview (max dimension capped). Returns Float32 values plus
// robust vmin/vmax (1st/99th percentile of finite block means). Missing-only
// blocks are NaN so the UI can paint a distinct "no data" color.
export function buildOverview(image, maxDim = 512) {
  const reader = makePixelReader(image);
  const scale = Math.max(1, Math.ceil(Math.max(image.width, image.height) / maxDim));
  const ow = Math.ceil(image.width / scale);
  const oh = Math.ceil(image.height / scale);
  const out = new Float32Array(ow * oh);
  const finite = [];
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      const x0 = ox * scale, y0 = oy * scale;
      const x1 = Math.min(image.width, x0 + scale);
      const y1 = Math.min(image.height, y0 + scale);
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = reader(x + 1, y + 1); // 0-based array -> FITS coords
          if (Number.isFinite(v)) { sum += v; n++; }
        }
      }
      const m = n === 0 ? NaN : sum / n;
      out[oy * ow + ox] = m;
      if (Number.isFinite(m)) finite.push(m);
    }
  }
  finite.sort((a, b) => a - b);
  const pct = (p) => finite.length === 0 ? NaN :
    finite[Math.min(finite.length - 1, Math.max(0, Math.round((p / 100) * (finite.length - 1))))];
  return {
    width: ow, height: oh, scale, values: out,
    vmin: pct(1), vmax: pct(99),
    finiteCount: finite.length, nanCount: out.length - finite.length
  };
}

// Materialize a resampled output grid.
import { TanWcs } from './wcs.js';
//   centerSky: [ra, dec] degrees, angularSize: [wDeg, hDeg] (tangent plane)
//   outW/outH: output pixel dimensions
// Returns { values:Float32Array, outW, outH, srcCorners:[4][2] 0-based,
//           finiteCount, nanCount, wcsOutput }
// srcCorners are source pixel coords (fractional 1-based FITS pixels) of the
// four output corners (TL, TR, BR, BL); missing samples are NaN.
export async function materializeCutout({ image, centerSky, angularSize, outW, outH, onProgress }) {
  const reader = makePixelReader(image);
  const src = image.wcs instanceof TanWcs ? image.wcs : new TanWcs(image.wcs, image.width, image.height);
  const ra0 = centerSky[0], dec0 = centerSky[1];
  // Orientation: output pixel axes follow the source CD axes. The source pixel
  // scale along each axis (deg/pixel) is the CD column norm:
  const sx = Math.hypot(src.cd[0][0], src.cd[1][0]);
  const sy = Math.hypot(src.cd[0][1], src.cd[1][1]);
  // Output CD matrix: col0 maps outX -> tangent direction of source +x axis,
  // scaled so the requested angular width fits exactly into outW pixels.
  const outScaleX = angularSize[0] / outW;
  const outScaleY = angularSize[1] / outH;
  const ux = [src.cd[0][0] / sx, src.cd[1][0] / sx]; // unit dir of source x
  const uy = [src.cd[0][1] / sy, src.cd[1][1] / sy]; // unit dir of source y
  const outCd = [
    [ux[0] * outScaleX, uy[0] * outScaleY],
    [ux[1] * outScaleX, uy[1] * outScaleY]
  ];
  // Output WCS with reference pixel at the exact output center.
  const outWcs = {
    crpix: [outW / 2 + 0.5, outH / 2 + 0.5],
    crval: [ra0, dec0],
    cd: outCd
  };
  const out = new Float32Array(outW * outH);
  let finiteCount = 0;

  // Map each OUTPUT array element to sky and then to source FITS pixels.
  // Element (ox,oy) is the pixel whose 1-based FITS coordinate is (ox+1.5,
  // oy+1.5): element j spans [j+1, j+2) with its center at j+1.5. The output
  // reference pixel CRPIX is therefore at the center of the grid by design.
  const outTan = new TanWcs(outWcs);
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const sky = outTan.pixelToSky(ox + 1.5, oy + 1.5);
      let v = NaN;
      if (sky) {
        const sp = src.skyToPixel(sky[0], sky[1]);
        if (sp) {
          // sp are FITS 1-based pixel coords — pass directly to the sampler.
          v = resampleBilinear(reader, sp[0], sp[1], image.width, image.height);
        }
      }
      out[oy * outW + ox] = v;
      if (Number.isFinite(v)) finiteCount++;
    }
    if (onProgress && oy % 16 === 0) {
      onProgress((oy + 1) / outH);
      // Yield periodically so a newer request can bump the session seq and the
      // server can reject this (now stale) computation with a 409.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (onProgress && onProgress.cancelled) break;
  }

  // Grid edge corners in FITS pixel coords: element j spans [j+1, j+2), so
  // the full grid spans [1,1]..[outW+1,outH+1]. Return 0-based source pixel
  // coords (subtract 1) for the client overlay.
  const cornerOut = [[1, 1], [outW + 1, 1], [outW + 1, outH + 1], [1, outH + 1]];
  const srcCorners = cornerOut.map(([px, py]) => {
    const sky = outTan.pixelToSky(px, py);
    if (!sky) return null;
    const sp = src.skyToPixel(sky[0], sky[1]);
    return sp ? [sp[0] - 1, sp[1] - 1] : null;
  });

  return {
    values: out, outW, outH, srcCorners,
    finiteCount, nanCount: out.length - finiteCount,
    wcsOutput: outWcs
  };
}
