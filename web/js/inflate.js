// DEFLATE, decompressed synchronously.
//
// The browser has DecompressionStream, but it is asynchronous, and the PDF
// parser this serves is synchronous from top to bottom — the same shape as
// src/convertly/pdfedit.py, which is the point. Threading async through a
// recursive object parser would make the two builds diverge structurally for
// no behavioural gain, so the one genuinely missing primitive is supplied
// here instead.
//
// Only cross-reference streams and object streams are ever decompressed;
// page content and images are copied in their original encoded form and
// never pass through this. RFC 1950 (zlib) and RFC 1951 (deflate).

export class InflateError extends Error {}

// A few kilobytes can expand to gigabytes, and we only ever inflate small
// bookkeeping streams, so a hard ceiling costs nothing and stops a malicious
// PDF exhausting memory.
export const MAX_OUTPUT = 64 * 1024 * 1024;

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35,
  43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257,
  385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
  9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Raised when the input runs out mid-symbol; the caller keeps what decoded. */
class Truncated extends Error {}

class BitReader {
  constructor(bytes, at = 0) {
    this.bytes = bytes;
    this.pos = at;
    this.bit = 0;       // bits already consumed from bytes[pos]
  }
  /** One bit, least-significant first, as DEFLATE packs them. */
  read1() {
    if (this.pos >= this.bytes.length) throw new Truncated();
    const value = (this.bytes[this.pos] >> this.bit) & 1;
    if (++this.bit === 8) { this.bit = 0; this.pos++; }
    return value;
  }
  read(n) {
    let value = 0;
    for (let i = 0; i < n; i++) value |= this.read1() << i;
    return value;
  }
  align() {
    if (this.bit) { this.bit = 0; this.pos++; }
  }
}

/**
 * A canonical Huffman decoder built from code lengths.
 *
 * Stored as the count of codes at each bit length plus the symbols in
 * canonical order, which is all decoding needs and avoids building a table
 * the size of the alphabet.
 */
function huffman(lengths) {
  const MAX_BITS = 15;
  const counts = new Int32Array(MAX_BITS + 1);
  for (const len of lengths) if (len) counts[len]++;

  const offsets = new Int32Array(MAX_BITS + 2);
  for (let bits = 1; bits <= MAX_BITS; bits++) {
    offsets[bits + 1] = offsets[bits] + counts[bits];
  }
  const symbols = new Int32Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    if (lengths[sym]) symbols[offsets[lengths[sym]]++] = sym;
  }
  return { counts, symbols };
}

function decodeSymbol(reader, table) {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= reader.read1();
    const count = table.counts[len];
    if (code - first < count) return table.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new InflateError('bad Huffman code');
}

let FIXED_LIT = null, FIXED_DIST = null;
function fixedTables() {
  if (!FIXED_LIT) {
    const lit = new Uint8Array(288);
    lit.fill(8, 0, 144); lit.fill(9, 144, 256); lit.fill(7, 256, 280); lit.fill(8, 280, 288);
    FIXED_LIT = huffman(lit);
    FIXED_DIST = huffman(new Uint8Array(30).fill(5));
  }
  return [FIXED_LIT, FIXED_DIST];
}

class Output {
  constructor(limit) {
    this.buf = new Uint8Array(Math.min(limit, 1 << 16));
    this.len = 0;
    this.limit = limit;
  }
  room(n) {
    if (this.len + n <= this.buf.length) return;
    if (this.len + n > this.limit) throw new InflateError('stream is too large to decompress safely');
    let size = this.buf.length || 1024;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(Math.min(size, this.limit));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  push(byte) { this.room(1); this.buf[this.len++] = byte; }
  copy(distance, length) {
    if (distance > this.len) throw new InflateError('bad back-reference');
    this.room(length);
    let from = this.len - distance;
    for (let i = 0; i < length; i++) this.buf[this.len++] = this.buf[from++];
  }
  bytes() { return this.buf.slice(0, this.len); }
}

function dynamicTables(reader) {
  const hlit = reader.read(5) + 257;
  const hdist = reader.read(5) + 1;
  const hclen = reader.read(4) + 4;

  const clLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clLengths[CODE_LENGTH_ORDER[i]] = reader.read(3);
  const clTable = huffman(clLengths);

  const lengths = new Uint8Array(hlit + hdist);
  let i = 0;
  while (i < lengths.length) {
    const sym = decodeSymbol(reader, clTable);
    if (sym < 16) {
      lengths[i++] = sym;
    } else if (sym === 16) {
      if (i === 0) throw new InflateError('bad code lengths');
      const prev = lengths[i - 1];
      let repeat = 3 + reader.read(2);
      while (repeat-- && i < lengths.length) lengths[i++] = prev;
    } else if (sym === 17) {
      let repeat = 3 + reader.read(3);
      while (repeat-- && i < lengths.length) lengths[i++] = 0;
    } else {
      let repeat = 11 + reader.read(7);
      while (repeat-- && i < lengths.length) lengths[i++] = 0;
    }
  }
  return [huffman(lengths.subarray(0, hlit)), huffman(lengths.subarray(hlit))];
}

/**
 * Inflate a raw DEFLATE stream.
 *
 * Truncated input returns what decoded cleanly rather than throwing, because
 * slightly malformed streams are common in real PDFs and the Python side is
 * deliberately tolerant of them in the same way.
 */
export function inflateRaw(bytes, { limit = MAX_OUTPUT, at = 0 } = {}) {
  const reader = new BitReader(bytes, at);
  const out = new Output(limit);
  try {
    for (;;) {
      const last = reader.read1();
      const type = reader.read(2);

      if (type === 0) {
        reader.align();
        if (reader.pos + 4 > bytes.length) throw new Truncated();
        const len = bytes[reader.pos] | (bytes[reader.pos + 1] << 8);
        reader.pos += 4;                       // length, then its complement
        for (let i = 0; i < len; i++) {
          if (reader.pos >= bytes.length) throw new Truncated();
          out.push(bytes[reader.pos++]);
        }
      } else if (type === 1 || type === 2) {
        const [lit, dist] = type === 1 ? fixedTables() : dynamicTables(reader);
        for (;;) {
          const sym = decodeSymbol(reader, lit);
          if (sym < 256) { out.push(sym); continue; }
          if (sym === 256) break;
          const li = sym - 257;
          if (li >= LENGTH_BASE.length) throw new InflateError('bad length code');
          const length = LENGTH_BASE[li] + reader.read(LENGTH_EXTRA[li]);
          const di = decodeSymbol(reader, dist);
          if (di >= DIST_BASE.length) throw new InflateError('bad distance code');
          out.copy(DIST_BASE[di] + reader.read(DIST_EXTRA[di]), length);
        }
      } else {
        throw new InflateError('bad block type');
      }
      if (last) break;
    }
  } catch (err) {
    // Out of input: hand back what we got, as the Python side does.
    if (!(err instanceof Truncated)) throw err;
  }
  return out.bytes();
}

/** Inflate a zlib-wrapped stream (RFC 1950), tolerating a missing header. */
export function inflate(bytes, { limit = MAX_OUTPUT } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < 2) return new Uint8Array(0);
  // CMF/FLG: low nibble 8 is deflate, and the pair is a multiple of 31.
  const looksZlib = (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0;
  return inflateRaw(data, { limit, at: looksZlib ? 2 : 0 });
}
