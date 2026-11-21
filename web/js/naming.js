// What Convertly calls the files it produces.
//
// A port of src/convertly/naming.py, not a second opinion. Both are pinned by
// shared/spec/output-names.json and both test suites run against it, so if
// these drift apart a test goes red.
//
// The filename comes from the user's own device, but it still gets scrubbed:
// path separators, control characters and leading dots never survive into a
// produced name.

export const COMBINED_NAME = 'combined.pdf';
export const FALLBACK_STEM = 'file';

/** The last path segment, treating both separators as separators. */
export function basename(filename) {
  return String(filename ?? '').split(/[\\/]/).pop();
}

/**
 * Split a name into [stem, extension-without-dot], the way Python's
 * os.path.splitext does.
 *
 * The subtle part is leading dots: `.heic` is a hidden file with no extension,
 * not a file of type heic. Python knows this and the obvious lastIndexOf('.')
 * does not, which is exactly the kind of difference that would let the two
 * builds disagree about whether a file is supported.
 */
export function splitExt(filename) {
  const base = basename(filename);
  const lead = base.length - base.replace(/^\.+/, '').length;
  const dot = base.lastIndexOf('.');
  if (dot < lead) return [base, ''];
  return [base.slice(0, dot), base.slice(dot + 1)];
}

/** The usable part of a filename: no directories, no extension, no tricks. */
export function stemOf(filename) {
  const stem = splitExt(filename)[0]
    .replace(/[\x00-\x1f\x7f]/g, '')   // control characters
    .trim()
    .replace(/^\.+|\.+$/g, '')         // leading and trailing dots
    .trim();
  return stem || FALLBACK_STEM;
}

/** The name of a converted file: `photo.heic` + `jpg` -> `photo.jpg`. */
export function convertedName(filename, ext) {
  return `${stemOf(filename)}.${ext}`;
}

/**
 * The name of a PDF with pages taken out.
 *
 * `Report.pdf` minus `2-4` becomes `Report-without-2-4.pdf`. Naming it after
 * what was removed beats naming it after what is left: "1,5-10" is accurate
 * and tells you nothing, while "without 2-4" is what you asked for.
 */
export function removedName(filename, spec) {
  const stem = stemOf(filename);
  const trimmed = String(spec ?? '').trim();
  if (!trimmed) return `${stem}-copy.pdf`;
  return `${stem}-without-${trimmed.replace(/[,\s]+/g, '_')}.pdf`;
}

/**
 * The name of pages pulled out of a PDF.
 *
 * `Annual Report.pdf` with `2-4` becomes `Annual Report-pages-2-4.pdf`;
 * an empty range means the whole document, so it is a copy.
 */
export function extractName(filename, spec) {
  const stem = stemOf(filename);
  const trimmed = String(spec ?? '').trim();
  if (!trimmed) return `${stem}-copy.pdf`;
  return `${stem}-pages-${trimmed.replace(/[,\s]+/g, '_')}.pdf`;
}
