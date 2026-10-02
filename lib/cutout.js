// Cutout geometry: turns a source-pixel rectangle into a sky center + tangent
// plane angular widths (exactly the quantities the export is requested with),
// and validates visibility against the TAN visible hemisphere.
import { TanWcs } from './wcs.js';
import { fail } from './errors.js';

// Tangent-plane coordinates (degrees) of (ra,dec) about pole (ra0,dec0).
function tangentAbout(raDeg, decDeg, ra0, dec0) {
  const D = Math.PI / 180;
  const ra = raDeg * D, dec = decDeg * D;
  const raR = ra0 * D, decR = dec0 * D;
  let dra = ra - raR;
  if (dra > Math.PI) dra -= 2 * Math.PI;
  if (dra < -Math.PI) dra += 2 * Math.PI;
  const cosC = Math.sin(decR) * Math.sin(dec) + Math.cos(decR) * Math.cos(dec) * Math.cos(dra);
  if (!(cosC > 1e-12)) return null;
  const xi = Math.cos(dec) * Math.sin(dra) / cosC / D;
  const eta = (Math.cos(decR) * Math.sin(dec) - Math.sin(decR) * Math.cos(dec) * Math.cos(dra)) / cosC / D;
  return [xi, eta];
}

// rect: {x0,y0,x1,y1} 0-based source pixels, may be normalized in any order.
export function describeRegion(image, rect) {
  const w = image.wcs;
  const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
  if (!(x1 - x0 >= 0.5) || !(y1 - y0 >= 0.5)) {
    throw fail('BAD_REQUEST', '切片区域小于一个像素');
  }
  if (x1 < 0 || y1 < 0 || x0 > image.width || y0 > image.height) {
    throw fail('BAD_REQUEST', '切片区域完全位于图像之外');
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const center = w.pixelToSky(cx + 0.5, cy + 0.5);
  if (!center) {
    throw fail('REGION_OUTSIDE_HEMISPHERE', '区域中心无法逆投影到天球（位于 TAN 可见半球之外）');
  }
  // Corners use pixel edges (0..width) rather than centers for exact widths.
  const edgePts = [
    [x0, y0], [x1, y0], [x1, y1], [x0, y1],
    [cx, y0], [cx, y1], [x0, cy], [x1, cy]
  ];
  let xiMin = Infinity, xiMax = -Infinity, etaMin = Infinity, etaMax = -Infinity;
  let valid = 0, clipped = false;
  for (const [px, py] of edgePts) {
    const sky = w.pixelToSky(px + 0.5, py + 0.5);
    if (!sky) { clipped = true; continue; }
    const t = tangentAbout(sky[0], sky[1], center[0], center[1]);
    if (!t) { clipped = true; continue; }
    valid++;
    xiMin = Math.min(xiMin, t[0]); xiMax = Math.max(xiMax, t[0]);
    etaMin = Math.min(etaMin, t[1]); etaMax = Math.max(etaMax, t[1]);
  }
  if (valid === 0) {
    throw fail('REGION_OUTSIDE_HEMISPHERE', '整个区域都在 TAN 可见半球之外，无法导出');
  }
  const widthDeg = xiMax - xiMin;
  const heightDeg = etaMax - etaMin;
  const sx = Math.hypot(w.cd[0][0], w.cd[1][0]);
  const sy = Math.hypot(w.cd[0][1], w.cd[1][1]);
  return {
    center: { ra: center[0], dec: center[1] },
    angularSize: { width: widthDeg, height: heightDeg },
    suggestedPixels: {
      width: Math.max(1, Math.round(widthDeg / sx)),
      height: Math.max(1, Math.round(heightDeg / sy))
    },
    sourceScale: { x: sx, y: sy },
    rect: { x0, y0, x1, y1 },
    hemisphereClipped: clipped,
    boundsInsideImage: x0 >= 0 && y0 >= 0 && x1 <= image.width && y1 <= image.height
  };
}

export function validateCutoutParams(query, image) {
  const num = (k, required = true) => {
    if (query[k] === undefined) {
      if (required) throw fail('BAD_REQUEST', `缺少参数 ${k}`);
      return undefined;
    }
    const v = Number(query[k]);
    if (!Number.isFinite(v)) throw fail('BAD_REQUEST', `参数 ${k} 必须是数字`);
    return v;
  };
  const ra = num('ra');
  const dec = num('dec');
  const wDeg = num('widthDeg');
  const hDeg = num('heightDeg');
  const outW = Math.floor(num('outW'));
  const outH = Math.floor(num('outH'));
  if (!(ra >= 0 && ra <= 360)) throw fail('BAD_REQUEST', '赤经必须在 [0,360] 度');
  if (!(dec >= -90 && dec <= 90)) throw fail('BAD_REQUEST', '赤纬必须在 [-90,90] 度');
  if (!(wDeg > 0 && hDeg > 0) || wDeg > 180 || hDeg > 180) {
    throw fail('BAD_REQUEST', '角尺寸必须为 (0,180] 度');
  }
  if (!Number.isInteger(outW) || !Number.isInteger(outH) || outW < 1 || outH < 1) {
    throw fail('BAD_REQUEST', '输出像素尺寸必须为正整数');
  }
  const MAX_SIDE = 2048;
  const MAX_PIXELS = 4_000_000;
  if (outW > MAX_SIDE || outH > MAX_SIDE || outW * outH > MAX_PIXELS) {
    throw fail('OUTPUT_TOO_LARGE', `输出尺寸过大（上限单边 ${MAX_SIDE}px、总计 ${MAX_PIXELS} 像素）`);
  }
  // A requested region whose center is not visible under the source projection
  // cannot produce meaningful pixels.
  const probe = image.wcs.skyToPixel(ra, dec);
  if (!probe) {
    throw fail('REGION_OUTSIDE_HEMISPHERE', '请求中心在源 TAN 可见半球之外');
  }
  return {
    centerSky: [ra, dec],
    angularSize: [wDeg, hDeg],
    outW, outH
  };
}

// Downsampled grayscale preview (Float32, little-endian over the wire) for an
// already materialized cutout, so the preview panel is real server pixels.
export function previewFloat32(values, w, h, maxDim = 220) {
  const scale = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
  const ow = Math.ceil(w / scale), oh = Math.ceil(h / scale);
  const out = new Float32Array(ow * oh);
  const finite = [];
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      let sum = 0, n = 0;
      for (let y = oy * scale; y < Math.min(h, (oy + 1) * scale); y++) {
        for (let x = ox * scale; x < Math.min(w, (ox + 1) * scale); x++) {
          const v = values[y * w + x];
          if (Number.isFinite(v)) { sum += v; n++; }
        }
      }
      const m = n === 0 ? NaN : sum / n;
      out[oy * ow + ox] = m;
      if (Number.isFinite(m)) finite.push(m);
    }
  }
  finite.sort((a, b) => a - b);
  const pct = (p) => finite.length ? finite[Math.round((p / 100) * (finite.length - 1))] : NaN;
  return { width: ow, height: oh, scale, values: out, vmin: pct(1), vmax: pct(99),
           nanFraction: (out.length - finite.length) / out.length };
}

export { TanWcs };
