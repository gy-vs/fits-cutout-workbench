// Server-side graticule generation: RA/Dec lines sampled in sky space and
// inverse-projected to source pixel coordinates, so every grid line the page
// draws comes from the same WCS code as the pixel/sky readouts and exports.
import { niceStep, unwrap, wrap360 } from './wcs.js';

// image: parsed descriptor with wcs TanWcs
// Returns { raLines:[{deg,points:[x,y|null]}], decLines:[...], bounds, steps }
// Coordinates are 0-based source pixels; null separates moved segments so the
// client can break the polyline at the visible-hemisphere edge.
export function buildGraticule(image, { targetLines = 7, edgeSamples = 40 } = {}) {
  const w = image.wcs;
  const { width, height } = image;

  // Estimate sky span from border samples (robust to rotation / RA wrap).
  let ras = [], decs = [];
  for (let i = 0; i <= edgeSamples; i++) {
    const t = i / edgeSamples;
    const pts = [
      [0.5 + t * (width - 1), 0.5],
      [0.5 + t * (width - 1), height - 0.5],
      [0.5, 0.5 + t * (height - 1)],
      [width - 0.5, 0.5 + t * (height - 1)]
    ];
    for (const [px, py] of pts) {
      const sky = w.pixelToSky(px, py);
      if (sky) {
        ras.push(unwrap(sky[0], w.crval[0]));
        decs.push(sky[1]);
      }
    }
  }
  if (ras.length < 2) {
    return { raLines: [], decLines: [], bounds: null, steps: { ra: null, dec: null } };
  }
  ras.sort((a, b) => a - b); decs.sort((a, b) => a - b);
  const raLo = ras[0], raHi = ras[ras.length - 1];
  const decLo = decs[0], decHi = decs[decs.length - 1];
  const raSpan = Math.max(1e-9, raHi - raLo);
  const decSpan = Math.max(1e-9, decHi - decLo);
  const raStep = niceStep(raSpan / targetLines * 6);
  const decStep = niceStep(decSpan / targetLines * 6);

  // Pad sampling region in sky space well beyond the image so clipping is done
  // by inverse projection instead of guessing.
  const padRa = raSpan * 0.8 + raStep * 2;
  const padDec = decSpan * 0.8 + decStep * 2;
  const decMin = Math.max(-90, decLo - padDec);
  const decMax = Math.min(90, decHi + padDec);

  const raStart = Math.ceil((raLo - padRa) / raStep) * raStep;
  const raEnd = Math.floor((raHi + padRa) / raStep) * raStep;
  const decStart = Math.ceil(decMin / decStep) * decStep;
  const decEnd = Math.floor(decMax / decStep) * decStep;

  const N = 96; // samples per graticule line

  const raLines = [];
  for (let ra = raStart; ra <= raEnd + 1e-9; ra += raStep) {
    const points = [];
    for (let i = 0; i <= N; i++) {
      const dec = decMin + (decMax - decMin) * (i / N);
      points.push(inv(w, wrap360(ra), dec));
    }
    raLines.push({ deg: wrap360(ra), points });
  }
  const decLines = [];
  for (let dec = decStart; dec <= decEnd + 1e-9; dec += decStep) {
    const points = [];
    for (let i = 0; i <= N; i++) {
      const raU = raLo - padRa + (2 * padRa + raSpan) * (i / N);
      points.push(inv(w, wrap360(raU), dec));
    }
    decLines.push({ deg: dec, points });
  }
  return {
    raLines, decLines,
    bounds: { raLo, raHi, decLo, decHi },
    steps: { ra: raStep, dec: decStep }
  };
}

function inv(w, ra, dec) {
  const p = w.skyToPixel(ra, dec);
  if (!p) return null;
  return [p[0] - 1, p[1] - 1]; // to 0-based pixels
}

// Clip a graticule polyline to the source image rectangle, splitting on nulls.
// Returns an array of arrays of [x,y] for client drawing convenience.
export function clipGraticule(lines, width, height) {
  const out = [];
  for (const line of lines) {
    let seg = [];
    const flush = () => { if (seg.length >= 2) out.push({ deg: line.deg, points: seg }); seg = []; };
    for (const p of line.points) {
      if (!p) { flush(); continue; }
      const [x, y] = p;
      if (x < -2 || y < -2 || x > width + 1 || y > height + 1) { flush(); continue; }
      seg.push([x, y]);
    }
    flush();
  }
  return out;
}
