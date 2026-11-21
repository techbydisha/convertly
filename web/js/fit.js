// Encoding a picture as JPEG, optionally resized and squeezed under a size.
//
// A port of _fit_jpeg() in src/convertly/convert.py, down to the constants and
// the wording of the notes. The Mac shells out to `sips` once per attempt and
// this draws to a canvas, but the search is the same: lower the quality first,
// because that costs no detail the eye notices, and only shrink the picture
// when compression alone cannot get under the limit.

import { humanSize } from './sizes.js';

export const MIN_QUALITY = 40;
export const MAX_FIT_ATTEMPTS = 18;
export const MIN_EDGE_PX = 120;
export const PDF_OVERHEAD = 1024;   // the wrapper a one-page image PDF adds

// Safari on iOS refuses to allocate a canvas larger than this, and returns a
// blank image rather than an error when asked. A 48-megapixel iPhone photo is
// well past it, so the picture is scaled to fit before anything else -- the
// resize is reported like any other, because that is what it is.
const AREA_LIMIT = 16_777_216;

export class FitError extends Error {}

/**
 * The size this picture is drawn at: the longest edge capped at `px` if given,
 * then the whole thing capped to an area the browser will actually allocate.
 *
 * Pictures are only ever shrunk. `sips -Z` enlarges an image smaller than the
 * limit, which would be a surprising way to "resize" a photo, so the Python
 * side clamps the limit to the source and this does the same by construction.
 */
function drawSize(width, height, px) {
  let w = width, h = height;
  if (px) {
    const longest = Math.max(w, h);
    if (px < longest) {
      const scale = px / longest;
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
    }
  }
  if (w * h > AREA_LIMIT) {
    const scale = Math.sqrt(AREA_LIMIT / (w * h));
    w = Math.max(1, Math.floor(w * scale));
    h = Math.max(1, Math.floor(h * scale));
  }
  return [w, h];
}

/**
 * A canvas to draw into.
 *
 * `alpha` is the difference between the two output formats, not a detail:
 * JPEG cannot store transparency, so a transparent picture is flattened onto
 * white -- without that it comes out black where it should be clear. PNG can
 * store it, so it must be kept.
 */
function canvasFor(width, height, { alpha = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha });
  if (!ctx) throw new FitError('This browser would not give us a canvas to draw on');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (!alpha) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  return { canvas, ctx };
}

function encodeCanvas(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new FitError('The browser could not encode this image')),
      type,
      quality,
    );
  });
}

/**
 * Encode `bitmap` as JPEG, within `maxPx` and/or under `targetBytes`.
 *
 * Returns { blob, width, height, note }, where the note describes anything
 * done to the picture beyond a plain conversion -- and nothing when nothing
 * was done, so a row never claims a resize that did not happen.
 */
export async function fitJpeg(bitmap, { quality = 85, maxPx = null, targetBytes = null } = {}) {
  const srcW = bitmap.width, srcH = bitmap.height;
  if (!srcW || !srcH) throw new FitError('This image has no size');

  // Resolve the limit against the picture once, up front, the way the Python
  // side clamps max_px to the source. Without this the shrink loop below would
  // start from a limit larger than the image -- "longest edge 4000" on a
  // 480-pixel photo -- and spend its budget of attempts shrinking a number
  // that changes nothing, then report it could not reach the size limit.
  const [startW, startH] = drawSize(srcW, srcH, maxPx);
  const startPx = Math.max(startW, startH);

  const attempts = [];

  async function encode(px, q) {
    const [w, h] = drawSize(srcW, srcH, px);
    const { canvas, ctx } = canvasFor(w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await encodeCanvas(canvas, 'image/jpeg', q / 100);
    // Let the backing store go before the next attempt allocates another.
    canvas.width = canvas.height = 0;
    const attempt = { size: blob.size, px, q, blob, width: w, height: h };
    attempts.push(attempt);
    return attempt;
  }

  /** Say only what actually changed, comparing against the source. */
  function describe(attempt) {
    const parts = [];
    if (attempt.width !== srcW || attempt.height !== srcH) {
      parts.push(`Resized to ${attempt.width}×${attempt.height}`);
    }
    if (attempt.q < quality) {
      parts.push(parts.length ? `quality ${attempt.q}` : `Quality lowered to ${attempt.q}`);
    }
    return parts.length ? parts.join(', ') : null;
  }

  const done = a => ({ blob: a.blob, width: a.width, height: a.height, note: describe(a) });

  const first = await encode(startPx, quality);
  if (!targetBytes || first.size <= targetBytes) return done(first);

  // Too big. Lower quality at this size, then shrink, and repeat.
  let px = startPx;
  while (attempts.length < MAX_FIT_ATTEMPTS) {
    let low = MIN_QUALITY, high = quality, best = null;
    while (low <= high && attempts.length < MAX_FIT_ATTEMPTS) {
      const mid = Math.floor((low + high) / 2);
      const attempt = await encode(px, mid);
      if (attempt.size <= targetBytes) {
        best = attempt;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best) return done(best);

    // A JPEG's size tracks its pixel count, so scale by the square root of
    // how far over budget the smallest attempt at this size was.
    //
    // This overshoots: it tends to settle on a smaller picture than the budget
    // actually required. The Python side has the same heuristic and the same
    // weakness, so leave them in step -- improving it is a change to both.
    const floorSizes = attempts.filter(a => a.q === MIN_QUALITY).map(a => a.size);
    const floorSize = floorSizes.length ? Math.min(...floorSizes) : 1;
    const scale = Math.sqrt(targetBytes / floorSize) * 0.92;
    const nextPx = Math.max(MIN_EDGE_PX, Math.floor(px * Math.min(scale, 0.9)));
    if (nextPx >= px || (nextPx <= MIN_EDGE_PX && px <= MIN_EDGE_PX)) break;
    px = nextPx;
  }

  // Couldn't reach the target: hand back the smallest we managed and say so.
  const smallest = attempts.reduce((a, b) => (b.size < a.size ? b : a));
  return {
    blob: smallest.blob,
    width: smallest.width,
    height: smallest.height,
    note: `Could not reach the size limit -- smallest is `
      + `${humanSize(smallest.size)} at ${smallest.width}×${smallest.height}`,
  };
}

/**
 * Encode `bitmap` as PNG, within `maxPx` and/or under `targetBytes`.
 *
 * A port of _fit_png() in src/convertly/convert.py. PNG keeps every pixel, so
 * unlike fitJpeg there is nothing to trade away: the only way under a size
 * limit is a smaller picture. That makes the search simpler rather than
 * harder -- a PNG only grows with its pixel count, so the largest edge that
 * fits can be bisected for directly.
 */
export async function fitPng(bitmap, { maxPx = null, targetBytes = null } = {}) {
  const srcW = bitmap.width, srcH = bitmap.height;
  if (!srcW || !srcH) throw new FitError('This image has no size');

  const [startW, startH] = drawSize(srcW, srcH, maxPx);
  const startPx = Math.max(startW, startH);
  const attempts = [];

  async function encode(px) {
    const [w, h] = drawSize(srcW, srcH, px);
    const { canvas, ctx } = canvasFor(w, h, { alpha: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await encodeCanvas(canvas, 'image/png');
    canvas.width = canvas.height = 0;
    const attempt = { size: blob.size, blob, width: w, height: h };
    attempts.push(attempt);
    return attempt;
  }

  function describe(attempt) {
    return (attempt.width !== srcW || attempt.height !== srcH)
      ? `Resized to ${attempt.width}×${attempt.height}`
      : null;
  }
  const done = a => ({ blob: a.blob, width: a.width, height: a.height, note: describe(a) });

  const first = await encode(startPx);
  if (!targetBytes || first.size <= targetBytes) return done(first);

  let best = null, low = MIN_EDGE_PX, high = startPx;
  while (low <= high && attempts.length < MAX_FIT_ATTEMPTS) {
    const mid = Math.floor((low + high) / 2);
    const attempt = await encode(mid);
    if (attempt.size <= targetBytes) {
      best = attempt;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best) return done(best);

  // Couldn't reach the target: hand back the smallest we managed and say so.
  const smallest = attempts.reduce((a, b) => (b.size < a.size ? b : a));
  return {
    blob: smallest.blob,
    width: smallest.width,
    height: smallest.height,
    note: `Could not reach the size limit -- smallest is `
      + `${humanSize(smallest.size)} at ${smallest.width}×${smallest.height}`,
  };
}

/** A PDF wraps the JPEG, so the image itself gets a slightly smaller budget. */
export function budgetFor(outFormat, targetBytes) {
  if (!targetBytes || outFormat !== 'pdf') return targetBytes;
  return Math.max(1024, targetBytes - PDF_OVERHEAD);
}

/** Combine caveats into one line, dropping the empty ones. */
export function joinNotes(...notes) {
  return notes.filter(Boolean).join(' · ') || null;
}
