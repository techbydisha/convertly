// Making a PDF smaller.
//
// A port of fit_pdf() in src/convertly/convert.py. A PDF's size is almost
// always the photographs inside it -- a page of text is a few kilobytes of
// drawing instructions -- so compressing one means finding those images and
// encoding them again, and leaving everything else exactly as it was.
//
// The search is the same shape as the one for a single picture: lower the
// quality first, because that costs no detail the eye notices, and only make
// the images smaller when compression alone cannot get under the limit.

import { PDF, compress, jpegImages, PdfError } from './pdfedit.js';
import { jpegSize } from './pdfwrite.js';
import { humanSize } from './sizes.js';
import { MIN_QUALITY, MAX_FIT_ATTEMPTS, MIN_EDGE_PX } from './fit.js';

/**
 * Re-encode one JPEG smaller. Returns [bytes, width, height], or null.
 *
 * Handed to pdfedit's compress(), which keeps that module free of any image
 * library and this one unaware of PDF structure.
 */
export async function recompressJpeg(jpeg, quality, maxPx) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  } catch {
    return null;                     // not a JPEG this browser can read
  }
  try {
    let w = bitmap.width, h = bitmap.height;
    if (maxPx) {
      const longest = Math.max(w, h);
      if (maxPx < longest) {
        const scale = maxPx / longest;
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality / 100));
    canvas.width = canvas.height = 0;
    if (!blob) return null;
    return [new Uint8Array(await blob.arrayBuffer()), w, h];
  } finally {
    bitmap.close?.();
  }
}

/**
 * Make a PDF smaller, optionally under a byte budget.
 *
 * Returns { bytes, note }. Throws when there is nothing to compress, because
 * handing back an identical file and calling it compressed is a lie the user
 * would only discover later.
 */
export async function fitPdf(data, { targetBytes = null, quality = 60, maxPx = null } = {}) {
  const doc = new PDF(data);
  const pages = doc.pages();

  // Where the shrink loop starts. Using an arbitrary number here would spend
  // the attempt budget capping images at sizes larger than they already are.
  let longest = 0;
  for (const stream of jpegImages(doc, pages).values()) {
    try {
      const [w, h] = jpegSize(stream.raw);
      longest = Math.max(longest, w, h);
    } catch { /* unreadable header: it just does not raise the ceiling */ }
  }

  const describe = (changed, q, px) => {
    if (!changed) return 'Already as small as re-encoding can make it';
    const parts = [`${changed} image${changed > 1 ? 's' : ''} re-encoded`];
    if (px) parts.push(`capped at ${px}px`);
    parts.push(`quality ${q}`);
    return parts.join(', ');
  };

  if (jpegImages(doc, pages).size === 0) {
    throw new PdfError(
      'Nothing in this PDF can be compressed — its size is text and layout, '
      + 'not photographs');
  }

  const [first, changed] = await compress(data, recompressJpeg, quality, maxPx);
  if (!targetBytes) {
    if (!changed) {
      // Re-encoding at this quality made every image larger, so nothing was
      // swapped. Saying "nothing can be compressed" here would be wrong -- a
      // lower quality would shrink it.
      throw new PdfError(
        'This PDF is already as small as re-encoding at this quality can make '
        + 'it — set a size limit to compress it further');
    }
    return { bytes: first, note: describe(changed, quality, maxPx) };
  }
  if (first.length <= targetBytes) {
    return { bytes: first, note: describe(changed, quality, maxPx) };
  }

  const attempts = [{ size: first.length, bytes: first, q: quality, px: maxPx }];
  let px = maxPx;
  while (attempts.length < MAX_FIT_ATTEMPTS) {
    let low = MIN_QUALITY, high = quality, best = null;
    while (low <= high && attempts.length < MAX_FIT_ATTEMPTS) {
      const mid = Math.floor((low + high) / 2);
      const [made, hit] = await compress(data, recompressJpeg, mid, px);
      attempts.push({ size: made.length, bytes: made, q: mid, px });
      if (made.length <= targetBytes) { best = { made, mid, hit }; low = mid + 1; }
      else high = mid - 1;
    }
    if (best) return { bytes: best.made, note: describe(best.hit, best.mid, px) };

    const atFloor = attempts.filter(a => a.q === MIN_QUALITY).map(a => a.size);
    const floorSize = atFloor.length ? Math.min(...atFloor) : first.length;
    const scale = Math.sqrt(targetBytes / floorSize) * 0.92;
    const base = px || longest;
    if (!base) break;                  // no readable image: nothing to shrink
    const nextPx = Math.max(MIN_EDGE_PX, Math.floor(base * Math.min(scale, 0.9)));
    if (px !== null && nextPx >= px) break;
    px = nextPx;
  }

  const smallest = attempts.reduce((a, b) => (b.size < a.size ? b : a));
  return {
    bytes: smallest.bytes,
    note: `Could not reach the size limit -- smallest is ${humanSize(smallest.size)}`,
  };
}
