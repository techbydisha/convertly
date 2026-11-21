// Just enough ZIP to read one file out of an archive.
//
// Pages, Keynote and Numbers documents are ZIP archives with a PDF preview
// inside, which is how both builds convert them without any Apple app being
// involved. Reading that one entry needs a central directory walk and inflate,
// and the browser already has inflate in DecompressionStream -- so this stays
// a dependency-free 80 lines rather than a vendored ZIP library.

export class ZipError extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Map of entry name -> { method, offset, compressedSize, size }. */
export function readDirectory(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // The end-of-central-directory record is last, but a trailing comment can
  // push it back by up to 64 KB, so scan for it rather than assuming.
  let eocd = -1;
  const earliest = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('This file is not a readable archive');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (at === 0xffffffff || count === 0xffff) {
    throw new ZipError('This archive uses ZIP64, which is not supported here');
  }

  const decoder = new TextDecoder();
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) {
      throw new ZipError('This archive is damaged');
    }
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    entries.set(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)), {
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The bytes of one entry, inflated if it is deflated. */
export async function readEntry(buffer, entry) {
  const view = new DataView(buffer);
  if (view.getUint32(entry.offset, true) !== LOCAL) {
    throw new ZipError('This archive is damaged');
  }
  const nameLen = view.getUint16(entry.offset + 26, true);
  const extraLen = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buffer, start, entry.compressedSize);

  if (entry.method === 0) return raw.slice();
  if (entry.method !== 8) {
    throw new ZipError(`This archive uses compression method ${entry.method}, which is not supported`);
  }
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The preview Pages/Keynote/Numbers stores inside its own document.
 *
 * Returns { bytes, kind: 'pdf' | 'image' }. Mirrors _iwork_preview() in
 * src/convertly/convert.py, including the order it looks in.
 */
export async function iworkPreview(buffer) {
  let entries;
  try {
    entries = readDirectory(buffer);
  } catch (err) {
    throw new ZipError('This iWork file could not be opened');
  }
  for (const want of ['QuickLook/Preview.pdf', 'preview.pdf', 'Preview.pdf']) {
    if (entries.has(want)) {
      return { bytes: await readEntry(buffer, entries.get(want)), kind: 'pdf' };
    }
  }
  for (const [name, entry] of entries) {
    const lower = name.toLowerCase();
    if (lower.endsWith('quicklook/preview.jpg') || lower.endsWith('preview.jpg')) {
      return { bytes: await readEntry(buffer, entry), kind: 'image' };
    }
  }
  throw new ZipError('No preview stored in this file -- export it from Pages instead');
}
