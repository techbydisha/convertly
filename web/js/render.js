// Drawing PDF pages, so a PDF can be checked by looking at it.
//
// pdf.js does the drawing. It is vendored in ../vendor/pdfjs, loaded only when
// a PDF first needs a picture, and its worker is started through
// sandboxedWorker() so that it runs under the page's connect-src 'none' --
// a worker loaded from its own URL would not.
//
// Nothing here fetches. The document is handed over as bytes, and the options
// that would make pdf.js download fonts, CMaps or WebAssembly decoders are
// left unset. The cost is honest and small: a few PDFs that rely on
// non-embedded Asian fonts or JPEG 2000 images draw imperfectly in a
// thumbnail. The file itself is never touched by this module -- it only reads.

import { sandboxedWorker } from './worker.js';

let library = null;

function pdfjs() {
  if (!library) {
    library = import('../vendor/pdfjs/pdf.min.mjs').then(lib => {
      lib.GlobalWorkerOptions.workerPort = sandboxedWorker('../vendor/pdfjs/pdf.worker.min.mjs');
      return lib;
    });
  }
  return library;
}

// One open document per Blob, and one cache of drawn pages per document, so a
// page drawn for the list is not drawn again for the preview.
const docs = new WeakMap();     // Blob -> Promise<PDFDocumentProxy>
const drawn = new WeakMap();    // Blob -> Map(key -> Promise<url>)

function open(blob) {
  let doc = docs.get(blob);
  if (!doc) {
    doc = (async () => {
      const lib = await pdfjs();
      // A fresh copy: pdf.js transfers the buffer to its worker.
      const data = new Uint8Array(await blob.arrayBuffer());
      return lib.getDocument({ data, useSystemFonts: true, enableXfa: false, verbosity: 0 }).promise;
    })();
    docs.set(blob, doc);
    // A PDF that cannot be opened must not stay cached as a rejection forever.
    doc.catch(() => docs.delete(blob));
  }
  return doc;
}

/** How many pages pdf.js sees -- used only as a fallback for counting. */
export async function renderedPageCount(blob) {
  return (await open(blob)).numPages;
}

// Drawing is CPU-heavy and a long document asks for many pages at once, so
// only a couple run together; the rest wait their turn in the order asked.
const LIMIT = 2;
let active = 0;
const queue = [];
function schedule(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < LIMIT && queue.length) {
    const { job, resolve, reject } = queue.shift();
    active++;
    job().then(resolve, reject).finally(() => { active--; pump(); });
  }
}

/**
 * A picture of one page, as an object URL, `width` CSS pixels wide.
 *
 * Cached per document. Rejects if the PDF cannot be drawn -- a password, say
 * -- and callers fall back to a plain badge, as they did before this existed.
 */
export function renderPage(blob, pageNumber, width) {
  let cache = drawn.get(blob);
  if (!cache) { cache = new Map(); drawn.set(blob, cache); }
  const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
  const key = `${pageNumber}|${Math.round(width * ratio)}`;
  if (cache.has(key)) return cache.get(key);

  const made = schedule(async () => {
    const doc = await open(blob);
    const page = await doc.getPage(pageNumber);
    try {
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (width * ratio) / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      // White, explicitly: a transparent page would come out black as JPEG.
      await page.render({ canvas, viewport, background: '#ffffff' }).promise;
      const jpeg = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.86));
      canvas.width = canvas.height = 0;
      if (!jpeg) throw new Error('could not encode the page');
      return URL.createObjectURL(jpeg);
    } finally {
      page.cleanup();
    }
  });
  cache.set(key, made);
  made.catch(() => cache.delete(key));
  return made;
}

/**
 * One page as an ImageBitmap, `longest` pixels on its longest edge.
 *
 * For converting a PDF to an image, which is a different job from a
 * thumbnail: the pixels go straight on to the JPEG or PNG encoder, so the
 * page is compressed once, not twice. Not cached -- it is made to be used.
 */
export async function renderPageBitmap(blob, pageNumber, longest) {
  const doc = await open(blob);
  const page = await doc.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = longest / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    await page.render({ canvas, viewport, background: '#ffffff' }).promise;
    const bitmap = await createImageBitmap(canvas);
    canvas.width = canvas.height = 0;
    return bitmap;
  } finally {
    page.cleanup();
  }
}

/** Let a document go: its drawn pages and its open handle. */
export async function forget(blob) {
  const cache = drawn.get(blob);
  if (cache) {
    drawn.delete(blob);
    for (const url of cache.values()) url.then(u => URL.revokeObjectURL(u), () => {});
  }
  const doc = docs.get(blob);
  if (doc) {
    docs.delete(blob);
    try { (await doc).destroy(); } catch { /* it never opened */ }
  }
}
