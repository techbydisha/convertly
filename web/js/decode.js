// Turning a file the user picked into pixels.
//
// Where the macOS app shells out to `sips`, this asks the browser. Most
// formats the browser already knows; HEIC it does not, except on Apple
// platforms where Safari borrows the system codec. So: try the browser first,
// and fall back to the vendored libheif build when it declines.
//
// Trying native first is not just a shortcut. Safari's decoder is the same one
// behind `sips`, it handles the wide-colour and 10-bit HEICs an iPhone
// actually produces, and it costs no download at all.

import { extOf } from './kinds.js';

export class DecodeError extends Error {}

const HEIF_EXTS = ['heic', 'heif'];

let worker = null;
let nextId = 1;
const pending = new Map();

function heifWorker() {
  if (worker === null) {
    worker = new Worker(new URL('./heif-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { id, error, ...rest } = event.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (error) entry.reject(new DecodeError(error));
      else entry.resolve(rest);
    };
    worker.onerror = () => {
      // The worker could not start at all (module workers unavailable, say).
      // Fail every request rather than leaving them hanging for ever.
      for (const [, entry] of pending) {
        entry.reject(new DecodeError('The HEIC decoder could not start'));
      }
      pending.clear();
      worker = false;
    };
  }
  if (worker === false) throw new DecodeError('The HEIC decoder could not start');
  return worker;
}

async function decodeHeif(file) {
  const bytes = await file.arrayBuffer();
  const id = nextId++;
  const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  heifWorker().postMessage({ id, bytes }, [bytes]);
  const { width, height, pixels } = await reply;
  return createImageBitmap(new ImageData(pixels, width, height));
}

/**
 * An ImageBitmap for a picture file, however it has to be obtained.
 *
 * Callers get dimensions from the bitmap and should close() it when done --
 * an ImageBitmap holds its pixels outside the garbage-collected heap, and a
 * batch of 12-megapixel photos adds up fast.
 */
export async function decodeImage(file) {
  const ext = extOf(file.name);
  try {
    return await createImageBitmap(file);
  } catch (err) {
    if (!HEIF_EXTS.includes(ext)) {
      throw new DecodeError(`Not a readable ${ext.toUpperCase() || 'image'} image`);
    }
  }
  // Safari decodes HEIC itself; everywhere else we do it ourselves.
  return decodeHeif(file);
}

/** Whether the browser can decode this format without the vendored decoder. */
export async function nativelyDecodes(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    bitmap.close?.();
    return true;
  } catch {
    return false;
  }
}
