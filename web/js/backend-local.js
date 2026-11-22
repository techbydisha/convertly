// The hosted app's backend: everything happens in this page.
//
// The interface (ui.js) never calls the engine directly. It calls a backend,
// and there are two: this one, and backend-server.js, which the macOS app uses
// to hand work to sips, Quick Look and Word. Both answer the same questions,
// so the same interface runs on both -- and the two apps cannot drift apart
// the way two copies of an interface did.

import { convertFile } from './convert.js';
import { build, buildWithout, pageCount } from './pdfedit.js';
import { decodeImage } from './decode.js';
import { encodedSize } from './fit.js';
import { kindOf, unsupportedReason } from './kinds.js';
import { iworkPreview } from './unzip.js';
import { renderPage } from './render.js';

const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());

// --- pictures of non-PDF files, for the list and the review pane ------------

const pictures = new WeakMap();   // File -> Map(px -> Promise<url>)

async function drawPicture(file, px) {
  const kind = kindOf(file.name);
  if (kind === 'iwork') {
    const preview = await iworkPreview(await file.arrayBuffer());
    if (preview.kind === 'pdf') {
      return renderPage(new Blob([preview.bytes], { type: 'application/pdf' }), 1, px);
    }
    file = new File([preview.bytes], 'preview.jpg', { type: 'image/jpeg' });
  } else if (kind !== 'image') {
    throw new Error('no picture for this kind of file');
  }
  const bitmap = await decodeImage(file);
  try {
    const scale = Math.min(1, px / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error('could not draw a picture');
    return URL.createObjectURL(blob);
  } finally {
    bitmap.close?.();
  }
}

// --- decoded pixels, kept for the size readout --------------------------------
//
// An honest size estimate encodes the real picture, so it needs the full-size
// pixels. A 12-megapixel photo is about 48 MB of them, so they are kept only
// up to a budget; past it the estimate steps aside rather than filling a
// phone's memory.

const PIXEL_BUDGET = 48e6;
const FILE_BUDGET = 4;
const bitmaps = new Map();        // File -> Promise<ImageBitmap | null>

function bitmapFor(file) {
  if (bitmaps.has(file)) return bitmaps.get(file);
  if (kindOf(file.name) !== 'image' || bitmaps.size >= FILE_BUDGET) return Promise.resolve(null);
  const made = decodeImage(file).then(async bitmap => {
    let used = 0;
    for (const [other, p] of bitmaps) {
      if (other === file) continue;
      const b = await p;
      if (b) used += b.width * b.height;
    }
    if (used + bitmap.width * bitmap.height > PIXEL_BUDGET) {
      bitmap.close?.();
      return null;
    }
    return bitmap;
  }).catch(() => null);
  bitmaps.set(file, made);
  return made;
}

export const backend = {
  name: 'local',
  place: 'this device',
  placeShort: 'your device',
  how: 'Convertly does the work inside your browser, on your own computer. '
     + 'Your photos and documents are never sent over the internet — not to us, '
     + 'not to anyone — so there is no copy anywhere for someone else to open.',

  /** Why this file cannot be converted here, or null if it can. */
  refuse: name => unsupportedReason(name),

  convert: (file, settings) => convertFile(file, settings),

  async pageCount(blob) {
    return pageCount(await bytesOf(blob));
  },

  async merge(files) {
    const parts = [];
    for (const f of files) parts.push([await bytesOf(f), '']);
    return new Blob([build(parts)], { type: 'application/pdf' });
  },

  async removePages(file, spec) {
    return new Blob([buildWithout([[await bytesOf(file), spec]])], { type: 'application/pdf' });
  },

  /** A picture of an image or an iWork file, `px` on its longest edge. */
  picture(file, px) {
    let sizes = pictures.get(file);
    if (!sizes) { sizes = new Map(); pictures.set(file, sizes); }
    if (!sizes.has(px)) {
      const made = drawPicture(file, px);
      sizes.set(px, made);
      made.catch(() => sizes.delete(px));
    }
    return sizes.get(px);
  },

  /** What this file would weigh as `format` at `quality`, or null if unknown. */
  async estimate(file, format, quality) {
    const bitmap = await bitmapFor(file);
    if (!bitmap) return null;
    return encodedSize(bitmap, format, quality);
  },

  /** Let go of anything held for this file. */
  forget(file) {
    const sizes = pictures.get(file);
    if (sizes) {
      for (const p of sizes.values()) p.then(u => URL.revokeObjectURL(u), () => {});
      pictures.delete(file);
    }
    const b = bitmaps.get(file);
    if (b) {
      bitmaps.delete(file);
      b.then(bm => bm?.close?.());
    }
  },
};
