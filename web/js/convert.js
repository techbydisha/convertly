// Converting one file, the browser's half of convert().
//
// This mirrors convert() in src/convertly/convert.py: same formats, same
// notes, same refusals. Where the Mac has a tool and the browser does not,
// the refusal says which -- never a silent skip, and never a half-converted
// file handed over as if it were whole.

import { convertedName } from './naming.js';
import { OUTPUT_FORMATS, kindOf, unsupportedReason } from './kinds.js';
import { decodeImage } from './decode.js';
import { fitJpeg, fitPng, budgetFor } from './fit.js';
import { jpegToPdf } from './pdfwrite.js';
import { iworkPreview } from './unzip.js';

export class ConversionError extends Error {}

export const MAX_BYTES = 200 * 1024 * 1024;

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

async function imageToOutput(blobOrFile, name, outFormat, quality, maxPx, targetBytes) {
  const budget = budgetFor(outFormat, targetBytes);
  const bitmap = await decodeImage(new File([blobOrFile], name, { type: blobOrFile.type || '' }));
  try {
    if (outFormat === 'png') {
      const fitted = await fitPng(bitmap, { maxPx, targetBytes });
      return { blob: fitted.blob, note: fitted.note };
    }
    const fitted = await fitJpeg(bitmap, { quality, maxPx, targetBytes: budget });
    if (outFormat === 'pdf') {
      const jpeg = new Uint8Array(await fitted.blob.arrayBuffer());
      return { blob: new Blob([jpegToPdf(jpeg)], { type: MIME.pdf }), note: fitted.note };
    }
    return { blob: fitted.blob, note: fitted.note };
  } finally {
    bitmap.close?.();
  }
}

/**
 * Convert one file. Returns { blob, name, note }.
 *
 * `maxPx` caps the longest edge; `targetBytes` squeezes the result under a
 * size budget by lowering quality and, if that is not enough, the dimensions.
 * `note` is a short caveat to show the user, or null.
 */
export async function convertFile(file, { format, quality = 85, maxPx = null, targetBytes = null } = {}) {
  if (!(format in OUTPUT_FORMATS)) {
    throw new ConversionError(`Unsupported output format: ${format}`);
  }
  if (!file.size) throw new ConversionError('Empty file');
  if (file.size > MAX_BYTES) throw new ConversionError('File is larger than 200 MB');

  const refusal = unsupportedReason(file.name);
  if (refusal) throw new ConversionError(refusal);

  const kind = kindOf(file.name);
  const ext = OUTPUT_FORMATS[format];
  const name = convertedName(file.name, ext);
  quality = Math.max(1, Math.min(100, Math.round(quality)));

  if (kind === 'image') {
    const { blob, note } = await imageToOutput(file, file.name, format, quality, maxPx, targetBytes);
    return { blob, name, note };
  }

  if (kind === 'pdf') {
    if (format === 'pdf') {
      return { blob: file.slice(0, file.size, MIME.pdf), name, note: 'Already a PDF -- copied unchanged' };
    }
    // Rasterising a PDF page needs a PDF renderer; the Mac uses Quick Look.
    throw new ConversionError('Turning a PDF into an image needs the macOS app');
  }

  if (kind === 'iwork') {
    const preview = await iworkPreview(await file.arrayBuffer());
    const note = 'From the preview stored in the document';
    if (preview.kind === 'pdf') {
      if (format === 'pdf') {
        return { blob: new Blob([preview.bytes], { type: MIME.pdf }), name, note };
      }
      throw new ConversionError(
        'This document stores a PDF preview, and turning a PDF into an image needs the macOS app');
    }
    const inner = new Blob([preview.bytes], { type: 'image/jpeg' });
    const { blob } = await imageToOutput(inner, 'preview.jpg', format, quality, maxPx, targetBytes);
    return { blob, name, note };
  }

  // Word: no browser equivalent of Quick Look, and unsupportedReason() has
  // already said so. Reaching here means the lists disagree.
  throw new ConversionError('Unsupported file type');
}
