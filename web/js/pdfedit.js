// Reading and rewriting PDFs in the browser.
//
// A port of src/convertly/pdfedit.py, kept deliberately close to it: same
// classes, same method names, same tolerances, same error messages. The two
// builds are held to one shared specification, and the cheapest way to keep
// them honest is for the second one to be recognisably the first.
//
// Enough of the PDF format to pick pages out of a document and to join
// documents together: a tolerant object parser, both flavours of
// cross-reference table (classic tables and PDF 1.5 cross-reference streams,
// including the object streams they point into), and a writer that copies each
// kept page along with everything it references.
//
// Streams are copied in their original encoded form, so page content and
// images are never re-compressed -- what comes out is what went in.

import { inflate, InflateError } from './inflate.js';

export class PdfError extends Error {}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const MAX_DECOMPRESSED = 64 * 1024 * 1024;

// --- bytes ----------------------------------------------------------------

const enc = new TextEncoder();
const bytesOf = s => enc.encode(s);

/** Latin-1 text for a byte range, so ordinary regexes can be used on it. */
function latin1(bytes, start = 0, end = bytes.length) {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function indexOfBytes(hay, needle, from = 0) {
  outer:
  for (let i = Math.max(0, from); i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOfBytes(hay, needle) {
  outer:
  for (let i = hay.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function matchesAt(hay, needle, at) {
  if (at < 0 || at + needle.length > hay.length) return false;
  for (let j = 0; j < needle.length; j++) if (hay[at + j] !== needle[j]) return false;
  return true;
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// --- the object model -----------------------------------------------------

/** A PDF name such as /Page. */
export class PdfName {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
}

/** A PDF string. */
export class PdfString {
  constructor(bytes) { this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); }
}

/** An indirect reference: `12 0 R`. */
export class Ref {
  constructor(num, gen = 0) { this.num = num; this.gen = gen; }
  key() { return `${this.num},${this.gen}`; }
}

/** A stream object: its dictionary plus the raw, still-encoded bytes. */
export class PdfStream {
  constructor(dict, raw) { this.dict = dict; this.raw = raw; }
}

const isDict = v => v instanceof Map;
const nameOf = v => (v instanceof PdfName ? v.value : v === null || v === undefined ? 'None' : String(v));
const isInt = v => typeof v === 'number' && Number.isInteger(v);

// --- parsing --------------------------------------------------------------

export class Lexer {
  constructor(data, pos = 0, doc = null) {
    this.data = data; this.pos = pos; this.doc = doc;
  }

  skipWs() {
    const d = this.data, n = d.length;
    while (this.pos < n) {
      const c = d[this.pos];
      if (WS.has(c)) {
        this.pos++;
      } else if (c === 0x25) {                 // % comment runs to end of line
        while (this.pos < n && d[this.pos] !== 0x0d && d[this.pos] !== 0x0a) this.pos++;
      } else {
        return;
      }
    }
  }

  keyword(word) {
    this.skipWs();
    if (matchesAt(this.data, word, this.pos)) { this.pos += word.length; return true; }
    return false;
  }

  parse() {
    this.skipWs();
    const d = this.data;
    if (this.pos >= d.length) throw new PdfError('unexpected end of file');
    const c = d[this.pos];

    if (c === 0x2F) return this._name();                       // /Name
    if (c === 0x28) return this._literal();                    // (string)
    if (c === 0x3C) {                                          // << dict >> or <hex>
      return d[this.pos + 1] === 0x3C ? this._dict() : this._hex();
    }
    if (c === 0x5B) {                                          // [array]
      this.pos += 1;
      const out = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= d.length) throw new PdfError('unterminated array');
        if (d[this.pos] === 0x5D) { this.pos += 1; return out; }
        out.push(this.parse());
      }
    }
    if (matchesAt(d, TRUE, this.pos)) { this.pos += 4; return true; }
    if (matchesAt(d, FALSE, this.pos)) { this.pos += 5; return false; }
    if (matchesAt(d, NULL, this.pos)) { this.pos += 4; return null; }
    if (NUMERIC_START.has(c)) return this._numberOrRef();
    throw new PdfError(`unreadable object at byte ${this.pos}`);
  }

  _name() {
    this.pos += 1;
    const d = this.data, start = this.pos;
    while (this.pos < d.length && !WS.has(d[this.pos]) && !DELIM.has(d[this.pos])) this.pos++;
    let raw = d.subarray(start, this.pos);
    if (indexOfBytes(raw, HASH) >= 0) {
      const out = [];
      let i = 0;
      while (i < raw.length) {
        if (raw[i] === 0x23 && i + 2 < raw.length) {
          const hex = latin1(raw, i + 1, i + 3);
          if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out.push(parseInt(hex, 16)); i += 3; continue; }
        }
        out.push(raw[i]);
        i += 1;
      }
      raw = new Uint8Array(out);
    }
    return new PdfName(latin1(raw));
  }

  _literal() {
    this.pos += 1;
    const d = this.data, out = [];
    let depth = 1;
    const SIMPLE = { 0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
    while (this.pos < d.length) {
      const c = d[this.pos];
      if (c === 0x5C) {                                  // backslash escape
        this.pos += 1;
        if (this.pos >= d.length) break;
        const e = d[this.pos];
        if (e in SIMPLE) {
          out.push(SIMPLE[e]);
          this.pos += 1;
        } else if (e >= 0x30 && e <= 0x37) {
          let digits = '';
          while (digits.length < 3 && this.pos < d.length && d[this.pos] >= 0x30 && d[this.pos] <= 0x37) {
            digits += String.fromCharCode(d[this.pos]);
            this.pos += 1;
          }
          out.push(parseInt(digits, 8) & 0xFF);
        } else if (e === 0x0d || e === 0x0a) {           // line continuation
          this.pos += 1;
          if (e === 13 && d[this.pos] === 0x0a) this.pos += 1;
        } else {
          out.push(e);
          this.pos += 1;
        }
        continue;
      }
      if (c === 0x28) depth += 1;
      else if (c === 0x29) {
        depth -= 1;
        if (depth === 0) { this.pos += 1; return new PdfString(new Uint8Array(out)); }
      }
      out.push(c);
      this.pos += 1;
    }
    throw new PdfError('unterminated string');
  }

  _hex() {
    this.pos += 1;
    const end = indexOfBytes(this.data, GT, this.pos);
    if (end < 0) throw new PdfError('unterminated hex string');
    let digits = latin1(this.data, this.pos, end).replace(/[^0-9A-Fa-f]/g, '');
    this.pos = end + 1;
    if (digits.length % 2) digits += '0';
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.substr(i * 2, 2), 16);
    return new PdfString(out);
  }

  _numberOrRef() {
    const d = this.data, start = this.pos;
    while (this.pos < d.length && NUMERIC_BODY.has(d[this.pos])) this.pos++;
    const token = latin1(d, start, this.pos);

    if (!/^[+-]?\d+$/.test(token)) {
      // Not an integer, so it cannot be a reference -- just a number.
      const value = parseFloat(token.replace(/--/g, '-'));
      return Number.isFinite(value) ? value : 0;
    }
    const value = parseInt(token, 10);

    // "<int> <int> R" is a reference; anything else is just a number.
    const save = this.pos;
    this.skipWs();
    const gStart = this.pos;
    while (this.pos < d.length && d[this.pos] >= 0x30 && d[this.pos] <= 0x39) this.pos++;
    if (this.pos > gStart) {
      const genToken = latin1(d, gStart, this.pos);
      this.skipWs();
      if (d[this.pos] === 0x52 &&
          (this.pos + 1 >= d.length || WS.has(d[this.pos + 1]) || DELIM.has(d[this.pos + 1]))) {
        this.pos += 1;
        return new Ref(value, parseInt(genToken, 10));
      }
    }
    this.pos = save;
    return value;
  }

  _dict() {
    this.pos += 2;
    const d = this.data, out = new Map();
    for (;;) {
      this.skipWs();
      if (this.pos >= d.length) throw new PdfError('unterminated dictionary');
      if (d[this.pos] === 0x3E && d[this.pos + 1] === 0x3E) { this.pos += 2; break; }
      const key = this.parse();
      if (!(key instanceof PdfName)) continue;          // tolerate junk keys
      out.set(key.value, this.parse());
    }

    const save = this.pos;
    if (this.keyword(STREAM)) {
      if (d[this.pos] === 0x0d && d[this.pos + 1] === 0x0a) this.pos += 2;
      else if (d[this.pos] === 0x0a || d[this.pos] === 0x0d) this.pos += 1;
      return this._stream(out);
    }
    this.pos = save;
    return out;
  }

  _stream(sdict) {
    const d = this.data, start = this.pos;
    let length = sdict.get('Length');
    if (length instanceof Ref && this.doc) {
      try { length = this.doc.resolve(length); } catch { length = null; }
    }
    let raw = null;
    if (isInt(length) && length >= 0 && length <= d.length - start) {
      const tail = latin1(d, start + length, Math.min(d.length, start + length + 20));
      if (/^\s*endstream/.test(tail)) {
        raw = d.subarray(start, start + length);
        this.pos = start + length;
      }
    }
    if (raw === null) {
      // A wrong /Length is common enough that finding endstream wins.
      const end = indexOfBytes(d, ENDSTREAM, start);
      if (end < 0) throw new PdfError('unterminated stream');
      let stop = end;
      if (stop - 2 >= start && d[stop - 2] === 0x0d && d[stop - 1] === 0x0a) stop -= 2;
      else if (stop - 1 >= start && (d[stop - 1] === 0x0a || d[stop - 1] === 0x0d)) stop -= 1;
      raw = d.subarray(start, stop);
      this.pos = end;
    }
    this.keyword(ENDSTREAM);
    return new PdfStream(sdict, raw);
  }
}

const TRUE = bytesOf('true'), FALSE = bytesOf('false'), NULL = bytesOf('null');
const HASH = bytesOf('#'), GT = bytesOf('>'), STREAM = bytesOf('stream'), ENDSTREAM = bytesOf('endstream');
const NUMERIC_START = new Set([...'+-.0123456789'].map(c => c.charCodeAt(0)));
const NUMERIC_BODY = new Set([...'+-.0123456789eE'].map(c => c.charCodeAt(0)));

// --- filters --------------------------------------------------------------

function undoPredictor(data, params) {
  const predictor = params.get('Predictor') ?? 1;
  if (!isInt(predictor) || predictor < 2) return data;
  const colors = params.get('Colors') ?? 1;
  const bpc = params.get('BitsPerComponent') ?? 8;
  const columns = params.get('Columns') ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowlen = Math.ceil((columns * colors * bpc) / 8);
  if (predictor === 2) return data;                      // TIFF predictor

  const rows = [];
  let prev = new Uint8Array(rowlen);
  let i = 0;
  while (i + 1 <= data.length - 1) {
    const tag = data[i];
    i += 1;
    const row = new Uint8Array(rowlen);
    row.set(data.subarray(i, Math.min(data.length, i + rowlen)));
    i += rowlen;
    if (tag === 1) {
      for (let j = bpp; j < rowlen; j++) row[j] = (row[j] + row[j - bpp]) & 0xFF;
    } else if (tag === 2) {
      for (let j = 0; j < rowlen; j++) row[j] = (row[j] + prev[j]) & 0xFF;
    } else if (tag === 3) {
      for (let j = 0; j < rowlen; j++) {
        const left = j >= bpp ? row[j - bpp] : 0;
        row[j] = (row[j] + ((left + prev[j]) >> 1)) & 0xFF;
      }
    } else if (tag === 4) {
      for (let j = 0; j < rowlen; j++) {
        const a = j >= bpp ? row[j - bpp] : 0;
        const b = prev[j];
        const c = j >= bpp ? prev[j - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        row[j] = (row[j] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xFF;
      }
    }
    rows.push(row);
    prev = row;
  }
  return concat(rows);
}

function ascii85(data) {
  let text = latin1(data).replace(/\s/g, '');
  if (text.startsWith('<~')) text = text.slice(2);
  const end = text.indexOf('~>');
  if (end >= 0) text = text.slice(0, end);
  const out = [];
  let group = [];
  for (const ch of text) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) throw new PdfError('bad ASCII85 data');
    group.push(code);
    if (group.length === 5) {
      let n = 0;
      for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF);
      group = [];
    }
  }
  if (group.length) {
    const short = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const g of group) n = n * 85 + g;
    const four = [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    out.push(...four.slice(0, short - 1));
  }
  return new Uint8Array(out);
}

/** Decode a stream far enough to read it. Only the filters we need. */
export function decodeStream(stream, doc = null) {
  let data = stream.raw;
  let filters = stream.dict.get('Filter');
  if (doc) filters = doc.resolve(filters);
  if (filters === null || filters === undefined) return data;
  if (!Array.isArray(filters)) filters = [filters];

  let parms = stream.dict.get('DecodeParms') ?? stream.dict.get('DP') ?? null;
  if (doc) parms = doc.resolve(parms);
  if (!Array.isArray(parms)) parms = [parms];

  for (let i = 0; i < filters.length; i++) {
    const name = nameOf(doc ? doc.resolve(filters[i]) : filters[i]);
    let p = i < parms.length ? parms[i] : null;
    if (doc) p = doc.resolve(p);
    let params = isDict(p) ? p : new Map();
    if (doc) {
      const resolved = new Map();
      for (const [k, v] of params) resolved.set(k, doc.resolve(v));
      params = resolved;
    }
    if (name === 'FlateDecode' || name === 'Fl') {
      try {
        data = inflate(data, { limit: MAX_DECOMPRESSED });
      } catch (err) {
        if (err instanceof InflateError) throw new PdfError('could not decompress a stream');
        throw err;
      }
      data = undoPredictor(data, params);
    } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
      let digits = latin1(data).split('>')[0].replace(/[^0-9A-Fa-f]/g, '');
      if (digits.length % 2) digits += '0';
      const out = new Uint8Array(digits.length / 2);
      for (let j = 0; j < out.length; j++) out[j] = parseInt(digits.substr(j * 2, 2), 16);
      data = out;
    } else if (name === 'ASCII85Decode' || name === 'A85') {
      data = ascii85(data);
    } else {
      throw new PdfError(`unsupported stream filter ${name}`);
    }
  }
  return data;
}

// --- the document ---------------------------------------------------------

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

export class PDF {
  constructor(data) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (indexOfBytes(this.data.subarray(0, 1024), bytesOf('%PDF')) < 0) {
      throw new PdfError("This doesn't look like a PDF");
    }
    this.xref = new Map();      // objnum -> ['off', pos] | ['stm', container, index]
    this.trailer = new Map();
    this._cache = new Map();
    this._scan = null;
    this._objstm = new Map();
    try {
      this._loadXref();
    } catch (err) {
      if (!(err instanceof PdfError)) throw err;
      this.xref = new Map();
    }
    if (this.xref.size === 0 || !this.trailer.has('Root')) this._rebuild();
    if ((this.trailer.get('Encrypt') ?? null) !== null) {
      throw new PdfError("This PDF is password-protected, so its pages can't be edited");
    }
  }

  // -- cross-reference tables

  _loadXref() {
    const idx = lastIndexOfBytes(this.data, bytesOf('startxref'));
    if (idx < 0) throw new PdfError('no startxref');
    const start = new Lexer(this.data, idx + 9, this).parse();
    if (!isInt(start)) throw new PdfError('bad startxref');

    const seen = new Set();
    let offset = start;
    while (isInt(offset) && offset >= 0 && offset < this.data.length && !seen.has(offset)) {
      seen.add(offset);
      const trailer = this._readSection(offset);
      for (const [k, v] of trailer) if (!this.trailer.has(k)) this.trailer.set(k, v);
      const hybrid = trailer.get('XRefStm');
      if (isInt(hybrid) && !seen.has(hybrid)) {
        seen.add(hybrid);
        try { this._readSection(hybrid); } catch (err) { if (!(err instanceof PdfError)) throw err; }
      }
      offset = trailer.get('Prev');
    }
  }

  _readSection(offset) {
    const lex = new Lexer(this.data, offset, this);
    lex.skipWs();
    if (matchesAt(this.data, bytesOf('xref'), lex.pos)) {
      lex.pos += 4;
      for (;;) {
        lex.skipWs();
        if (matchesAt(this.data, bytesOf('trailer'), lex.pos)) {
          lex.pos += 7;
          const trailer = lex.parse();
          return isDict(trailer) ? trailer : new Map();
        }
        const first = lex.parse();
        const count = lex.parse();
        if (!isInt(first) || !isInt(count)) return new Map();
        for (let i = 0; i < count; i++) {
          lex.skipWs();
          const entry = latin1(this.data, lex.pos, Math.min(this.data.length, lex.pos + 20));
          const m = /^(\d{1,10})\s+(\d{1,5})\s+([nf])/.exec(entry);
          if (!m) return new Map();
          lex.pos += m[0].length;
          if (m[3] === 'n' && !this.xref.has(first + i)) {
            this.xref.set(first + i, ['off', parseInt(m[1], 10)]);
          }
        }
      }
    }
    // otherwise: a cross-reference stream
    lex.parse();                      // object number
    lex.parse();                      // generation
    if (!lex.keyword(bytesOf('obj'))) throw new PdfError('bad xref stream');
    const stream = lex.parse();
    if (!(stream instanceof PdfStream)) throw new PdfError('bad xref stream');
    this._readXrefStream(stream);
    return stream.dict;
  }

  _readXrefStream(stream) {
    const d = stream.dict;
    const widths = (this.resolve(d.get('W')) || []).map(w => this.resolve(w));
    if (widths.length < 3) throw new PdfError('bad xref stream widths');
    const size = this.resolve(d.get('Size')) || 0;
    const index = (this.resolve(d.get('Index')) || [0, size]).map(i => this.resolve(i));
    const raw = decodeStream(stream, this);
    const rowlen = widths.reduce((a, b) => a + b, 0);
    if (rowlen === 0) throw new PdfError('bad xref stream');

    let pos = 0;
    const take = (width, fallback) => {
      if (width === 0) return fallback;
      let value = 0;
      for (let i = 0; i < width; i++) value = value * 256 + raw[pos + i];
      pos += width;
      return value;
    };

    for (let i = 0; i + 1 < index.length; i += 2) {
      const first = index[i], count = index[i + 1];
      if (!isInt(first) || !isInt(count)) continue;
      for (let n = 0; n < count; n++) {
        if (pos + rowlen > raw.length) return;
        const kind = take(widths[0], 1);
        const f2 = take(widths[1], 0);
        const f3 = take(widths[2], 0);
        const num = first + n;
        if (kind === 1 && !this.xref.has(num)) this.xref.set(num, ['off', f2]);
        else if (kind === 2 && !this.xref.has(num)) this.xref.set(num, ['stm', f2, f3]);
      }
    }
  }

  /** Fall back to scanning the file for `N G obj` when the tables fail. */
  _rebuild() {
    this._buildScan();
    for (const [num, offset] of this._scan) this.xref.set(num, ['off', offset]);

    if (!this.trailer.has('Root')) {
      const text = latin1(this.data);
      const re = /trailer/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        let t;
        try { t = new Lexer(this.data, m.index + 7, this).parse(); } catch { continue; }
        if (isDict(t) && t.has('Root') && !this.trailer.has('Root')) {
          this.trailer.set('Root', t.get('Root'));
          if (t.get('Encrypt')) this.trailer.set('Encrypt', t.get('Encrypt'));
        }
      }
    }
    if (!this.trailer.has('Root')) {
      for (const num of [...this.xref.keys()].sort((a, b) => a - b)) {
        let obj;
        try { obj = this.get(num); } catch { continue; }
        if (isDict(obj) && nameOf(obj.get('Type')) === 'Catalog') {
          this.trailer.set('Root', new Ref(num, 0));
          break;
        }
      }
    }
  }

  _buildScan() {
    if (this._scan !== null) return;
    this._scan = new Map();
    const text = latin1(this.data);
    const re = /(?<![0-9])(\d{1,9})\s+(\d{1,5})\s+obj\b/g;
    let m;
    while ((m = re.exec(text)) !== null) this._scan.set(parseInt(m[1], 10), m.index);
  }

  // -- objects

  get(num) {
    if (this._cache.has(num)) return this._cache.get(num);
    this._cache.set(num, null);                    // guard against cycles
    const entry = this.xref.get(num);
    let value = null;
    if (entry && entry[0] === 'off') value = this._atOffset(num, entry[1]);
    else if (entry && entry[0] === 'stm') value = this._fromObjstm(entry[1], entry[2], num);
    if (value === null) {
      this._buildScan();
      if (this._scan.has(num)) value = this._atOffset(num, this._scan.get(num));
    }
    this._cache.set(num, value);
    return value;
  }

  _atOffset(num, offset) {
    if (!(offset >= 0 && offset < this.data.length)) return null;
    const lex = new Lexer(this.data, offset, this);
    try {
      const found = lex.parse();
      lex.parse();
      if (!lex.keyword(bytesOf('obj'))) return null;
      if (found !== num) {
        this._buildScan();
        const scanned = this._scan.get(num);
        if (scanned !== undefined && scanned !== offset) return this._atOffset(num, scanned);
        return null;
      }
      return lex.parse();
    } catch (err) {
      if (err instanceof PdfError) return null;
      throw err;
    }
  }

  _fromObjstm(container, index, want) {
    if (!this._objstm.has(container)) {
      const stream = this.get(container);
      if (!(stream instanceof PdfStream)) return null;
      let body;
      try { body = decodeStream(stream, this); } catch (err) {
        if (err instanceof PdfError) return null;
        throw err;
      }
      const n = this.resolve(stream.dict.get('N')) || 0;
      const first = this.resolve(stream.dict.get('First')) || 0;
      const header = new Lexer(body, 0, this);
      const pairs = [];
      for (let i = 0; i < n; i++) {
        let num, off;
        try { num = header.parse(); off = header.parse(); } catch { break; }
        if (isInt(num) && isInt(off)) pairs.push([num, first + off]);
      }
      this._objstm.set(container, [pairs, body]);
    }
    const [pairs, body] = this._objstm.get(container);
    for (let i = 0; i < pairs.length; i++) {
      const [num, off] = pairs[i];
      if (num === want || (index === i && want === null)) {
        try { return new Lexer(body, off, this).parse(); } catch { return null; }
      }
    }
    return null;
  }

  resolve(obj, depth = 0) {
    while (obj instanceof Ref && depth < 64) {
      obj = this.get(obj.num);
      depth += 1;
    }
    return obj;
  }

  // -- pages

  /** Every page, in order, as {ref, obj, inherited}. */
  pages() {
    let found = [];
    const root = this.resolve(this.trailer.get('Root'));
    const node = isDict(root) ? this.resolve(root.get('Pages')) : null;
    if (isDict(node)) this._walk(node, new Map(), found, new Set(), 0);
    if (found.length === 0) found = this._pagesByScan();
    if (found.length === 0) throw new PdfError('No pages found in this PDF');
    return found;
  }

  _walk(node, inherited, out, seen, depth) {
    if (depth > 64 || out.length > 20000) return;
    const own = new Map(inherited);
    for (const key of INHERITED) if (node.has(key)) own.set(key, node.get(key));

    const kids = this.resolve(node.get('Kids'));
    if (nameOf(node.get('Type')) === 'Page' || (kids === null || kids === undefined) && node.has('Contents')) {
      out.push({ ref: null, obj: node, inherited: own });
      return;
    }
    if (!Array.isArray(kids)) return;
    for (const kid of kids) {
      const key = kid instanceof Ref ? kid.key() : kid;
      if (seen.has(key)) continue;
      seen.add(key);
      const child = this.resolve(kid);
      if (!isDict(child)) continue;
      const kids2 = this.resolve(child.get('Kids'));
      if (nameOf(child.get('Type')) === 'Pages' || Array.isArray(kids2)) {
        this._walk(child, own, out, seen, depth + 1);
      } else {
        const merged = new Map(own);
        for (const k of INHERITED) if (child.has(k)) merged.set(k, child.get(k));
        out.push({ ref: kid instanceof Ref ? kid : null, obj: child, inherited: merged });
      }
    }
  }

  _pagesByScan() {
    this._buildScan();
    const out = [];
    for (const num of [...this._scan.keys()].sort((a, b) => a - b)) {
      const obj = this.get(num);
      if (isDict(obj) && nameOf(obj.get('Type')) === 'Page') {
        out.push({ ref: new Ref(num, 0), obj, inherited: new Map() });
      }
    }
    return out;
  }

  pageCount() { return this.pages().length; }
}

// --- writing --------------------------------------------------------------

function fmtNumber(v) {
  if (Number.isInteger(v)) return bytesOf(String(v));
  let text = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return bytesOf(text || '0');
}

function fmtName(name) {
  let out = '/';
  for (const ch of bytesOf(name)) {
    if (ch < 0x21 || ch > 0x7E || DELIM.has(ch) || ch === 0x23) {
      out += '#' + ch.toString(16).toUpperCase().padStart(2, '0');
    } else {
      out += String.fromCharCode(ch);
    }
  }
  return bytesOf(out);
}

function fmtString(bytes) {
  const out = [0x28];
  for (const ch of bytes) {
    if (ch === 0x28 || ch === 0x29 || ch === 0x5C) out.push(0x5C, ch);
    else if (ch === 13) out.push(0x5C, 0x72);
    else out.push(ch);
  }
  out.push(0x29);
  return new Uint8Array(out);
}

export function serialize(value) {
  if (value === null || value === undefined) return bytesOf('null');
  if (value === true) return bytesOf('true');
  if (value === false) return bytesOf('false');
  if (value instanceof PdfName) return fmtName(value.value);
  if (value instanceof Ref) return bytesOf(`${value.num} ${value.gen} R`);
  if (value instanceof PdfString) return fmtString(value.bytes);
  if (value instanceof Uint8Array) return fmtString(value);
  if (typeof value === 'number') return fmtNumber(value);
  if (Array.isArray(value)) {
    const parts = [bytesOf('[')];
    value.forEach((v, i) => {
      if (i) parts.push(bytesOf(' '));
      parts.push(serialize(v));
    });
    parts.push(bytesOf(']'));
    return concat(parts);
  }
  if (value instanceof PdfStream) {
    const d = new Map(value.dict);
    d.set('Length', value.raw.length);
    return concat([serialize(d), bytesOf('\nstream\n'), value.raw, bytesOf('\nendstream')]);
  }
  if (isDict(value)) {
    const parts = [bytesOf('<<')];
    for (const [k, v] of value) {
      parts.push(fmtName(String(k)), bytesOf(' '), serialize(v));
    }
    parts.push(bytesOf('>>'));
    return concat(parts);
  }
  return bytesOf('null');
}

/** Collects pages from one or more documents into a new PDF. */
export class Builder {
  static CATALOG = 1;
  static PAGES = 2;

  constructor() {
    this.bodies = new Map();
    this.next = 3;
    this.pageObjects = [];
  }

  _alloc() { return this.next++; }

  /** Append `wanted` (1-based page numbers) from `doc`, in that order. */
  add(doc, wanted) {
    const pages = doc.pages();
    const selected = new Set();
    for (const n of wanted) {
      const ref = pages[n - 1].ref;
      if (ref !== null) selected.add(ref.key());
    }
    const memo = new Map();
    for (const n of wanted) {
      const page = pages[n - 1];
      const num = this._alloc();
      if (page.ref !== null) memo.set(page.ref.key(), num);

      const merged = new Map(page.obj);
      for (const [k, v] of page.inherited) if (!merged.has(k)) merged.set(k, v);
      merged.delete('Parent');

      const body = new Map();
      for (const [k, v] of merged) body.set(k, this._copy(doc, v, memo, selected));
      body.set('Type', new PdfName('Page'));
      body.set('Parent', new Ref(Builder.PAGES, 0));
      if (!body.has('MediaBox')) body.set('MediaBox', [0, 0, 612, 792]);
      this.bodies.set(num, body);
      this.pageObjects.push(num);
    }
  }

  _copy(doc, value, memo, selected, depth = 0) {
    if (depth > 96) return null;
    if (value instanceof Ref) {
      const key = value.key();
      if (memo.has(key)) return new Ref(memo.get(key), 0);
      const target = doc.resolve(value);
      if (target === null || target === undefined) return null;
      // Never drag in a page we didn't ask for (an annotation may link to one).
      const probe = target instanceof PdfStream ? target.dict : target;
      if (isDict(probe) && nameOf(probe.get('Type')) === 'Page' && !selected.has(key)) return null;
      const num = this._alloc();
      memo.set(key, num);
      this.bodies.set(num, this._copy(doc, target, memo, selected, depth + 1));
      return new Ref(num, 0);
    }
    if (value instanceof PdfStream) {
      const d = new Map();
      for (const [k, v] of value.dict) {
        if (k !== 'Length') d.set(k, this._copy(doc, v, memo, selected, depth + 1));
      }
      return new PdfStream(d, value.raw);
    }
    if (isDict(value)) {
      const d = new Map();
      for (const [k, v] of value) {
        if (k !== 'Parent') d.set(k, this._copy(doc, v, memo, selected, depth + 1));
      }
      return d;
    }
    if (Array.isArray(value)) {
      return value.map(v => this._copy(doc, v, memo, selected, depth + 1));
    }
    return value;
  }

  build() {
    if (this.pageObjects.length === 0) throw new PdfError('No pages selected');

    const catalog = new Map();
    catalog.set('Type', new PdfName('Catalog'));
    catalog.set('Pages', new Ref(Builder.PAGES, 0));
    this.bodies.set(Builder.CATALOG, catalog);

    const pages = new Map();
    pages.set('Type', new PdfName('Pages'));
    pages.set('Kids', this.pageObjects.map(n => new Ref(n, 0)));
    pages.set('Count', this.pageObjects.length);
    this.bodies.set(Builder.PAGES, pages);

    const parts = [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x37, 0x0A,
                                   0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])];
    let at = parts[0].length;
    const offsets = new Map();
    for (let num = 1; num < this.next; num++) {
      if (!this.bodies.has(num)) continue;
      offsets.set(num, at);
      const chunk = concat([bytesOf(`${num} 0 obj\n`), serialize(this.bodies.get(num)), bytesOf('\nendobj\n')]);
      parts.push(chunk);
      at += chunk.length;
    }

    const size = this.next;
    const xrefAt = at;
    let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let num = 1; num < size; num++) {
      table += offsets.has(num)
        ? `${String(offsets.get(num)).padStart(10, '0')} 00000 n \n`
        : '0000000000 65535 f \n';
    }
    table += `trailer\n<< /Size ${size} /Root ${Builder.CATALOG} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    parts.push(bytesOf(table));
    return concat(parts);
  }
}

// --- page ranges ----------------------------------------------------------

/** Turn "2-4", "1,3,5-7", "2-" or "" into a list of 1-based page numbers. */
export function parseRanges(spec, total) {
  const text = String(spec ?? '').trim().toLowerCase();
  if (!text || text === 'all') {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const out = [];
  for (const chunk of text.split(/[,\s]+/)) {
    if (!chunk) continue;
    let start, end;
    const m = /^(\d*)\s*[-–:]\s*(\d*)$/.exec(chunk);
    if (m) {
      start = m[1] ? parseInt(m[1], 10) : 1;
      end = m[2] ? parseInt(m[2], 10) : total;
    } else if (/^\d+$/.test(chunk)) {
      start = end = parseInt(chunk, 10);
    } else {
      throw new PdfError(`Can't read page range “${chunk}”`);
    }
    if (start < 1 || end < 1) throw new PdfError('Page numbers start at 1');
    if (start > total || end > total) {
      throw new PdfError(`This PDF only has ${total} page${total > 1 ? 's' : ''}`);
    }
    if (start <= end) for (let n = start; n <= end; n++) out.push(n);
    else for (let n = start; n >= end; n--) out.push(n);
  }
  if (out.length === 0) throw new PdfError('No pages selected');
  return out;
}

/**
 * The pages left when `spec` says what to take *out*.
 *
 * The inverse of parseRanges, and deliberately not the same default: an empty
 * selection means "remove nothing" here, where in parseRanges it means "keep
 * everything". Both come out as the whole document, but for opposite reasons.
 */
export function invertRanges(spec, total) {
  const text = String(spec ?? '').trim();
  if (!text) return Array.from({ length: total }, (_, i) => i + 1);
  const drop = new Set(parseRanges(text, total));
  const kept = [];
  for (let n = 1; n <= total; n++) if (!drop.has(n)) kept.push(n);
  if (kept.length === 0) throw new PdfError('That would remove every page');
  return kept;
}

export function pageCount(data) {
  return new PDF(data).pageCount();
}

/** parts: [[pdfBytes, rangeSpec]] -> one PDF with those pages, in order. */
export function build(parts) {
  const builder = new Builder();
  for (const [data, spec] of parts) {
    const doc = new PDF(data);
    builder.add(doc, parseRanges(spec, doc.pageCount()));
  }
  return builder.build();
}

/** Like build(), but each spec says which pages to remove. */
export function buildWithout(parts) {
  const builder = new Builder();
  for (const [data, spec] of parts) {
    const doc = new PDF(data);
    builder.add(doc, invertRanges(spec, doc.pageCount()));
  }
  return builder.build();
}
