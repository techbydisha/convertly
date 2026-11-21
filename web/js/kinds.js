// Which files are accepted, and as what.
//
// A port of the classification in src/convertly/convert.py, pinned by
// shared/spec/file-kinds.json. The lists are deliberately identical to the
// Python ones even where this build cannot handle a kind yet: a file is
// classified the same way in both builds, and whether it can be *converted*
// here is a separate question, answered by canHandle().

import { splitExt } from './naming.js';

export const IMAGE_EXTS = ['heic', 'heif', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'gif', 'bmp', 'webp'];
export const PDF_EXTS = ['pdf'];
export const WORD_EXTS = ['doc', 'docx', 'rtf'];
export const IWORK_EXTS = ['pages', 'key', 'numbers'];

export const INPUT_EXTS = [...IMAGE_EXTS, ...PDF_EXTS, ...WORD_EXTS, ...IWORK_EXTS];

export const OUTPUT_FORMATS = { jpg: 'jpg', jpeg: 'jpeg', png: 'png', pdf: 'pdf' };

// PNG stores the picture exactly, so there is no quality to trade away. A size
// limit can still be met, but only by making the picture smaller -- and the
// quality slider has to say it does not apply rather than quietly do nothing.
export const LOSSLESS_FORMATS = ['png'];

export const isLossless = format => LOSSLESS_FORMATS.includes(format);

// Decoders this build has. Everything else in IMAGE_EXTS is handled by the
// browser's own image decoding, which every browser does for these.
const NATIVE_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];

// HEIC needs the vendored WebAssembly decoder; TIFF has none yet.
const VENDORED_IMAGE_EXTS = ['heic', 'heif'];

/** image / pdf / word / iwork, or null for a file we will not guess at. */
export function kindOf(filename) {
  const ext = splitExt(filename)[1].toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (PDF_EXTS.includes(ext)) return 'pdf';
  if (WORD_EXTS.includes(ext)) return 'word';
  if (IWORK_EXTS.includes(ext)) return 'iwork';
  return null;
}

export function extOf(filename) {
  return splitExt(filename)[1].toLowerCase();
}

/**
 * Why this build cannot convert a file, or null if it can.
 *
 * Returning the reason rather than a bare false is the point: a row that says
 * "Word documents need the macOS app" is useful, and a row that silently
 * vanishes is not.
 */
export function unsupportedReason(filename) {
  const kind = kindOf(filename);
  const ext = extOf(filename);
  if (kind === null) return 'Unsupported file type';
  if (kind === 'word') return 'Word documents need the macOS app';
  if (kind === 'image' && !NATIVE_IMAGE_EXTS.includes(ext) && !VENDORED_IMAGE_EXTS.includes(ext)) {
    return `${ext.toUpperCase()} is not supported in the browser yet`;
  }
  return null;
}

export function canHandle(filename) {
  return unsupportedReason(filename) === null;
}

/** The `accept` attribute for the file picker: everything we can actually do. */
export function acceptAttribute() {
  return INPUT_EXTS.filter(e => canHandle(`x.${e}`)).map(e => `.${e}`).join(',');
}
