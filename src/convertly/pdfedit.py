"""Reading and rewriting PDFs, with no dependencies.

Enough of the PDF format to pick pages out of a document and to join documents
together: a tolerant object parser, both flavours of cross-reference table
(classic tables and PDF 1.5 cross-reference streams, including the object
streams they point into), and a writer that copies each kept page along with
everything it references.

Streams are copied in their original encoded form, so page content and images
are never re-compressed -- what comes out is what went in.
"""

import re
import zlib

WS = b"\x00\t\n\x0c\r "
DELIM = b"()<>[]{}/%"

# A few kilobytes of compressed data can expand to gigabytes. Streams we decode
# are only ever cross-reference and object streams, which are never this big,
# so a hard ceiling costs nothing and stops a malicious PDF exhausting memory.
MAX_DECOMPRESSED = 64 * 1024 * 1024


class PdfError(Exception):
    """Raised when a PDF can't be read or rewritten."""


class Name(str):
    """A PDF name such as /Page."""
    __slots__ = ()


class PdfStr(bytes):
    """A PDF string."""
    __slots__ = ()


class Ref:
    """An indirect reference: `12 0 R`."""
    __slots__ = ("num", "gen")

    def __init__(self, num, gen=0):
        self.num, self.gen = num, gen

    def key(self):
        return (self.num, self.gen)

    def __eq__(self, other):
        return isinstance(other, Ref) and self.key() == other.key()

    def __hash__(self):
        return hash(self.key())

    def __repr__(self):
        return f"Ref({self.num},{self.gen})"


class Stream:
    """A stream object: its dictionary plus the raw, still-encoded bytes."""
    __slots__ = ("dict", "raw")

    def __init__(self, d, raw):
        self.dict, self.raw = d, raw


# --- parsing --------------------------------------------------------------

class Lexer:
    def __init__(self, data, pos=0, doc=None):
        self.data, self.pos, self.doc = data, pos, doc

    def skip_ws(self):
        d, n = self.data, len(self.data)
        while self.pos < n:
            c = d[self.pos]
            if c in WS:
                self.pos += 1
            elif c == 0x25:  # % comment runs to end of line
                while self.pos < n and d[self.pos] not in b"\r\n":
                    self.pos += 1
            else:
                return

    def keyword(self, word: bytes) -> bool:
        self.skip_ws()
        if self.data[self.pos:self.pos + len(word)] == word:
            self.pos += len(word)
            return True
        return False

    def parse(self):
        self.skip_ws()
        d = self.data
        if self.pos >= len(d):
            raise PdfError("unexpected end of file")
        c = d[self.pos]

        if c == 0x2F:                     # /Name
            return self._name()
        if c == 0x28:                     # (string)
            return self._literal()
        if c == 0x3C:                     # << dict >> or <hex>
            if d[self.pos + 1:self.pos + 2] == b"<":
                return self._dict()
            return self._hex()
        if c == 0x5B:                     # [array]
            self.pos += 1
            out = []
            while True:
                self.skip_ws()
                if self.pos >= len(d):
                    raise PdfError("unterminated array")
                if d[self.pos] == 0x5D:
                    self.pos += 1
                    return out
                out.append(self.parse())
        if d[self.pos:self.pos + 4] == b"true":
            self.pos += 4
            return True
        if d[self.pos:self.pos + 5] == b"false":
            self.pos += 5
            return False
        if d[self.pos:self.pos + 4] == b"null":
            self.pos += 4
            return None
        if c in b"+-.0123456789":
            return self._number_or_ref()
        raise PdfError(f"unreadable object at byte {self.pos}")

    def _name(self):
        self.pos += 1
        d, start = self.data, self.pos
        while self.pos < len(d) and d[self.pos] not in WS and d[self.pos] not in DELIM:
            self.pos += 1
        raw = d[start:self.pos]
        if b"#" in raw:
            out = bytearray()
            i = 0
            while i < len(raw):
                if raw[i] == 0x23 and i + 2 < len(raw):
                    try:
                        out.append(int(raw[i + 1:i + 3], 16))
                        i += 3
                        continue
                    except ValueError:
                        pass
                out.append(raw[i])
                i += 1
            raw = bytes(out)
        return Name(raw.decode("latin-1"))

    def _literal(self):
        self.pos += 1
        d, out, depth = self.data, bytearray(), 1
        while self.pos < len(d):
            c = d[self.pos]
            if c == 0x5C:                                  # backslash escape
                self.pos += 1
                if self.pos >= len(d):
                    break
                e = d[self.pos]
                simple = {0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12}
                if e in simple:
                    out.append(simple[e])
                    self.pos += 1
                elif e in b"01234567":
                    digits = b""
                    while len(digits) < 3 and self.pos < len(d) and d[self.pos] in b"01234567":
                        digits += d[self.pos:self.pos + 1]
                        self.pos += 1
                    out.append(int(digits, 8) & 0xFF)
                elif e in b"\r\n":                          # line continuation
                    self.pos += 1
                    if e == 13 and d[self.pos:self.pos + 1] == b"\n":
                        self.pos += 1
                else:
                    out.append(e)
                    self.pos += 1
                continue
            if c == 0x28:
                depth += 1
            elif c == 0x29:
                depth -= 1
                if depth == 0:
                    self.pos += 1
                    return PdfStr(bytes(out))
            out.append(c)
            self.pos += 1
        raise PdfError("unterminated string")

    def _hex(self):
        self.pos += 1
        end = self.data.find(b">", self.pos)
        if end < 0:
            raise PdfError("unterminated hex string")
        digits = re.sub(rb"[^0-9A-Fa-f]", b"", self.data[self.pos:end])
        self.pos = end + 1
        if len(digits) % 2:
            digits += b"0"
        return PdfStr(bytes.fromhex(digits.decode("ascii")))

    def _number_or_ref(self):
        d, start = self.data, self.pos
        while self.pos < len(d) and d[self.pos] in b"+-.0123456789eE":
            self.pos += 1
        token = d[start:self.pos]
        try:
            value = int(token)
        except ValueError:
            try:
                value = float(token.replace(b"--", b"-"))
            except ValueError:
                value = 0
            return value

        # "<int> <int> R" is a reference; anything else is just a number.
        save = self.pos
        self.skip_ws()
        g_start = self.pos
        while self.pos < len(d) and d[self.pos] in b"0123456789":
            self.pos += 1
        if self.pos > g_start:
            gen_token = d[g_start:self.pos]
            self.skip_ws()
            if d[self.pos:self.pos + 1] == b"R" and (
                self.pos + 1 >= len(d)
                or d[self.pos + 1] in WS
                or d[self.pos + 1] in DELIM
            ):
                self.pos += 1
                return Ref(value, int(gen_token))
        self.pos = save
        return value

    def _dict(self):
        self.pos += 2
        d, out = self.data, {}
        while True:
            self.skip_ws()
            if self.pos >= len(d):
                raise PdfError("unterminated dictionary")
            if d[self.pos:self.pos + 2] == b">>":
                self.pos += 2
                break
            key = self.parse()
            if not isinstance(key, Name):
                continue                       # tolerate junk keys
            out[str(key)] = self.parse()

        save = self.pos
        if self.keyword(b"stream"):
            if d[self.pos:self.pos + 2] == b"\r\n":
                self.pos += 2
            elif d[self.pos:self.pos + 1] in (b"\n", b"\r"):
                self.pos += 1
            return self._stream(out)
        self.pos = save
        return out

    def _stream(self, sdict):
        d, start = self.data, self.pos
        length = sdict.get("Length")
        if isinstance(length, Ref) and self.doc is not None:
            try:
                length = self.doc.resolve(length)
            except PdfError:
                length = None
        raw = None
        if isinstance(length, int) and 0 <= length <= len(d) - start:
            tail = d[start + length:start + length + 20]
            if re.match(rb"\s*endstream", tail):
                raw = d[start:start + length]
                self.pos = start + length
        if raw is None:
            # A wrong /Length is common enough that finding endstream wins.
            end = d.find(b"endstream", start)
            if end < 0:
                raise PdfError("unterminated stream")
            raw = d[start:end]
            if raw.endswith(b"\r\n"):
                raw = raw[:-2]
            elif raw.endswith(b"\n") or raw.endswith(b"\r"):
                raw = raw[:-1]
            self.pos = end
        self.keyword(b"endstream")
        return Stream(sdict, raw)


# --- filters --------------------------------------------------------------

def _undo_predictor(data: bytes, params: dict) -> bytes:
    predictor = params.get("Predictor", 1)
    if not isinstance(predictor, int) or predictor < 2:
        return data
    colors = params.get("Colors", 1)
    bpc = params.get("BitsPerComponent", 8)
    columns = params.get("Columns", 1)
    bpp = max(1, (colors * bpc + 7) // 8)
    rowlen = (columns * colors * bpc + 7) // 8
    if predictor == 2:                       # TIFF predictor
        return data
    out = bytearray()
    prev = bytearray(rowlen)
    i = 0
    while i + 1 <= len(data) - 1:
        tag = data[i]
        i += 1
        row = bytearray(data[i:i + rowlen])
        if len(row) < rowlen:
            row.extend(b"\x00" * (rowlen - len(row)))
        i += rowlen
        if tag == 1:
            for j in range(bpp, rowlen):
                row[j] = (row[j] + row[j - bpp]) & 0xFF
        elif tag == 2:
            for j in range(rowlen):
                row[j] = (row[j] + prev[j]) & 0xFF
        elif tag == 3:
            for j in range(rowlen):
                left = row[j - bpp] if j >= bpp else 0
                row[j] = (row[j] + ((left + prev[j]) >> 1)) & 0xFF
        elif tag == 4:
            for j in range(rowlen):
                a = row[j - bpp] if j >= bpp else 0
                b = prev[j]
                c = prev[j - bpp] if j >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                row[j] = (row[j] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
        out += row
        prev = row
    return bytes(out)


def _inflate(data: bytes) -> bytes:
    """Decompress, refusing to produce more than MAX_DECOMPRESSED bytes."""
    obj = zlib.decompressobj()
    try:
        out = obj.decompress(data, MAX_DECOMPRESSED)
    except zlib.error:
        # Truncated or slightly malformed streams are common in the wild;
        # keep whatever decoded cleanly before the error.
        obj = zlib.decompressobj()
        try:
            out = obj.decompress(data[:MAX_DECOMPRESSED], MAX_DECOMPRESSED)
        except zlib.error:
            raise PdfError("could not decompress a stream")
    if obj.unconsumed_tail:
        raise PdfError("a stream in this PDF is too large to decompress safely")
    return out


def _ascii85(data: bytes) -> bytes:
    data = re.sub(rb"\s", b"", data)
    if data.startswith(b"<~"):
        data = data[2:]
    end = data.find(b"~>")
    if end >= 0:
        data = data[:end]
    import base64
    return base64.a85decode(data)


def decode_stream(stream: Stream, doc=None) -> bytes:
    """Decode a stream far enough to read it. Only the filters we need."""
    data = stream.raw
    filters = stream.dict.get("Filter")
    if doc is not None:
        filters = doc.resolve(filters)
    if filters is None:
        return data
    if not isinstance(filters, list):
        filters = [filters]
    parms = stream.dict.get("DecodeParms") or stream.dict.get("DP")
    if doc is not None:
        parms = doc.resolve(parms)
    if not isinstance(parms, list):
        parms = [parms]
    for i, f in enumerate(filters):
        name = str(doc.resolve(f) if doc is not None else f)
        p = parms[i] if i < len(parms) else None
        if doc is not None:
            p = doc.resolve(p)
        p = p if isinstance(p, dict) else {}
        if doc is not None:
            p = {k: doc.resolve(v) for k, v in p.items()}
        if name in ("FlateDecode", "Fl"):
            data = _inflate(data)
            data = _undo_predictor(data, p)
        elif name in ("ASCIIHexDecode", "AHx"):
            digits = re.sub(rb"[^0-9A-Fa-f]", b"", data.split(b">")[0])
            if len(digits) % 2:
                digits += b"0"
            data = bytes.fromhex(digits.decode("ascii"))
        elif name in ("ASCII85Decode", "A85"):
            data = _ascii85(data)
        else:
            raise PdfError(f"unsupported stream filter {name}")
    return data


# --- the document ---------------------------------------------------------

class PDF:
    def __init__(self, data: bytes):
        if b"%PDF" not in data[:1024]:
            raise PdfError("This doesn't look like a PDF")
        self.data = data
        self.xref = {}            # objnum -> ("off", pos) | ("stm", container, index)
        self.trailer = {}
        self._cache = {}
        self._scan = None
        self._objstm = {}
        try:
            self._load_xref()
        except PdfError:
            self.xref = {}
        if not self.xref or "Root" not in self.trailer:
            self._rebuild()
        if self.trailer.get("Encrypt") is not None:
            raise PdfError("This PDF is password-protected, so its pages can't be edited")

    # -- cross-reference tables

    def _load_xref(self):
        idx = self.data.rfind(b"startxref")
        if idx < 0:
            raise PdfError("no startxref")
        lex = Lexer(self.data, idx + 9, self)
        start = lex.parse()
        if not isinstance(start, int):
            raise PdfError("bad startxref")
        seen = set()
        offset = start
        while isinstance(offset, int) and 0 <= offset < len(self.data) and offset not in seen:
            seen.add(offset)
            trailer = self._read_section(offset)
            for k, v in trailer.items():
                self.trailer.setdefault(k, v)
            hybrid = trailer.get("XRefStm")
            if isinstance(hybrid, int) and hybrid not in seen:
                seen.add(hybrid)
                try:
                    self._read_section(hybrid)
                except PdfError:
                    pass
            offset = trailer.get("Prev")

    def _read_section(self, offset) -> dict:
        lex = Lexer(self.data, offset, self)
        lex.skip_ws()
        if self.data[lex.pos:lex.pos + 4] == b"xref":
            lex.pos += 4
            while True:
                lex.skip_ws()
                if self.data[lex.pos:lex.pos + 7] == b"trailer":
                    lex.pos += 7
                    trailer = lex.parse()
                    return trailer if isinstance(trailer, dict) else {}
                first = lex.parse()
                count = lex.parse()
                if not isinstance(first, int) or not isinstance(count, int):
                    return {}
                for i in range(count):
                    lex.skip_ws()
                    entry = self.data[lex.pos:lex.pos + 20]
                    m = re.match(rb"(\d{1,10})\s+(\d{1,5})\s+([nf])", entry)
                    if not m:
                        return {}
                    lex.pos += m.end()
                    if m.group(3) == b"n":
                        self.xref.setdefault(first + i, ("off", int(m.group(1))))
        # otherwise: a cross-reference stream
        lex.parse()          # object number
        lex.parse()          # generation
        if not lex.keyword(b"obj"):
            raise PdfError("bad xref stream")
        stream = lex.parse()
        if not isinstance(stream, Stream):
            raise PdfError("bad xref stream")
        self._read_xref_stream(stream)
        return stream.dict

    def _read_xref_stream(self, stream: Stream):
        d = stream.dict
        widths = [self.resolve(w) for w in self.resolve(d.get("W")) or []]
        if len(widths) < 3:
            raise PdfError("bad xref stream widths")
        size = self.resolve(d.get("Size")) or 0
        index = self.resolve(d.get("Index")) or [0, size]
        index = [self.resolve(i) for i in index]
        raw = decode_stream(stream, self)
        rowlen = sum(widths)
        if rowlen == 0:
            raise PdfError("bad xref stream")
        pos = 0

        def take(width, default):
            nonlocal pos
            if width == 0:
                return default
            value = int.from_bytes(raw[pos:pos + width], "big")
            pos += width
            return value

        for i in range(0, len(index) - 1, 2):
            first, count = index[i], index[i + 1]
            if not isinstance(first, int) or not isinstance(count, int):
                continue
            for n in range(count):
                if pos + rowlen > len(raw):
                    return
                kind = take(widths[0], 1)
                f2 = take(widths[1], 0)
                f3 = take(widths[2], 0)
                num = first + n
                if kind == 1:
                    self.xref.setdefault(num, ("off", f2))
                elif kind == 2:
                    self.xref.setdefault(num, ("stm", f2, f3))

    def _rebuild(self):
        """Fall back to scanning the file for `N G obj` when the tables fail."""
        self._build_scan()
        for num, offset in self._scan.items():
            self.xref[num] = ("off", offset)
        if "Root" not in self.trailer:
            for m in re.finditer(rb"trailer", self.data):
                try:
                    t = Lexer(self.data, m.end(), self).parse()
                except PdfError:
                    continue
                if isinstance(t, dict) and "Root" in t:
                    self.trailer.setdefault("Root", t["Root"])
                    self.trailer.setdefault("Encrypt", t.get("Encrypt")) if t.get("Encrypt") else None
        if "Root" not in self.trailer:
            for num in sorted(self.xref):
                try:
                    obj = self.get(num)
                except PdfError:
                    continue
                if isinstance(obj, dict) and str(obj.get("Type")) == "Catalog":
                    self.trailer["Root"] = Ref(num, 0)
                    break

    def _build_scan(self):
        if self._scan is None:
            self._scan = {}
            for m in re.finditer(rb"(?<![0-9])(\d{1,9})\s+(\d{1,5})\s+obj\b", self.data):
                self._scan[int(m.group(1))] = m.start()

    # -- objects

    def get(self, num, gen=0):
        if num in self._cache:
            return self._cache[num]
        self._cache[num] = None                      # guard against cycles
        entry = self.xref.get(num)
        value = None
        if entry and entry[0] == "off":
            value = self._at_offset(num, entry[1])
        elif entry and entry[0] == "stm":
            value = self._from_objstm(entry[1], entry[2], num)
        if value is None:
            self._build_scan()
            if num in self._scan:
                value = self._at_offset(num, self._scan[num])
        self._cache[num] = value
        return value

    def _at_offset(self, num, offset):
        if not (0 <= offset < len(self.data)):
            return None
        lex = Lexer(self.data, offset, self)
        try:
            found = lex.parse()
            lex.parse()
            if not lex.keyword(b"obj"):
                return None
            if found != num:
                self._build_scan()
                if self._scan.get(num) not in (None, offset):
                    return self._at_offset(num, self._scan[num])
                return None
            return lex.parse()
        except PdfError:
            return None

    def _from_objstm(self, container, index, want):
        pairs = self._objstm.get(container)
        if pairs is None:
            stream = self.get(container)
            if not isinstance(stream, Stream):
                return None
            try:
                body = decode_stream(stream, self)
            except PdfError:
                return None
            n = self.resolve(stream.dict.get("N")) or 0
            first = self.resolve(stream.dict.get("First")) or 0
            header = Lexer(body, 0, self)
            pairs = []
            for _ in range(n):
                try:
                    num = header.parse()
                    off = header.parse()
                except PdfError:
                    break
                if isinstance(num, int) and isinstance(off, int):
                    pairs.append((num, first + off))
            self._objstm[container] = (pairs, body)
        pairs, body = self._objstm[container]
        for i, (num, off) in enumerate(pairs):
            if num == want or (index == i and want is None):
                try:
                    return Lexer(body, off, self).parse()
                except PdfError:
                    return None
        return None

    def resolve(self, obj, depth=0):
        while isinstance(obj, Ref) and depth < 64:
            obj = self.get(obj.num, obj.gen)
            depth += 1
        return obj

    # -- pages

    INHERITED = ("Resources", "MediaBox", "CropBox", "Rotate")

    def pages(self):
        """Every page, in order, as {ref, obj, inherited}."""
        found = []
        root = self.resolve(self.trailer.get("Root"))
        node = self.resolve(root.get("Pages")) if isinstance(root, dict) else None
        if isinstance(node, dict):
            self._walk(node, {}, found, set(), 0)
        if not found:
            found = self._pages_by_scan()
        if not found:
            raise PdfError("No pages found in this PDF")
        return found

    def _walk(self, node, inherited, out, seen, depth):
        if depth > 64 or len(out) > 20000:
            return
        inherited = dict(inherited)
        for key in self.INHERITED:
            if key in node:
                inherited[key] = node[key]
        kids = self.resolve(node.get("Kids"))
        if str(node.get("Type")) == "Page" or (kids is None and "Contents" in node):
            out.append({"ref": None, "obj": node, "inherited": inherited})
            return
        if not isinstance(kids, list):
            return
        for kid in kids:
            key = kid.key() if isinstance(kid, Ref) else id(kid)
            if key in seen:
                continue
            seen.add(key)
            child = self.resolve(kid)
            if not isinstance(child, dict):
                continue
            kids2 = self.resolve(child.get("Kids"))
            if str(child.get("Type")) == "Pages" or isinstance(kids2, list):
                self._walk(child, inherited, out, seen, depth + 1)
            else:
                merged = dict(inherited)
                for k in self.INHERITED:
                    if k in child:
                        merged[k] = child[k]
                out.append({
                    "ref": kid if isinstance(kid, Ref) else None,
                    "obj": child,
                    "inherited": merged,
                })

    def _pages_by_scan(self):
        self._build_scan()
        out = []
        for num in sorted(self._scan):
            obj = self.get(num)
            if isinstance(obj, dict) and str(obj.get("Type")) == "Page":
                out.append({"ref": Ref(num, 0), "obj": obj, "inherited": {}})
        return out

    def page_count(self):
        return len(self.pages())


# --- writing --------------------------------------------------------------

def _fmt_number(v):
    if isinstance(v, int):
        return str(v).encode("ascii")
    text = f"{v:.6f}".rstrip("0").rstrip(".")
    return (text or "0").encode("ascii")


def _fmt_name(name: str) -> bytes:
    out = bytearray(b"/")
    for ch in name.encode("latin-1", "replace"):
        if ch < 0x21 or ch > 0x7E or ch in DELIM or ch == 0x23:
            out += f"#{ch:02X}".encode("ascii")
        else:
            out.append(ch)
    return bytes(out)


def _fmt_string(s: bytes) -> bytes:
    out = bytearray(b"(")
    for ch in s:
        if ch in (0x28, 0x29, 0x5C):
            out += b"\\" + bytes([ch])
        elif ch == 13:
            out += b"\\r"
        else:
            out.append(ch)
    out += b")"
    return bytes(out)


def serialize(value) -> bytes:
    if value is None:
        return b"null"
    if value is True:
        return b"true"
    if value is False:
        return b"false"
    if isinstance(value, Name):
        return _fmt_name(str(value))
    if isinstance(value, Ref):
        return f"{value.num} {value.gen} R".encode("ascii")
    if isinstance(value, PdfStr):
        return _fmt_string(bytes(value))
    if isinstance(value, bytes):
        return _fmt_string(value)
    if isinstance(value, (int, float)):
        return _fmt_number(value)
    if isinstance(value, list):
        return b"[" + b" ".join(serialize(v) for v in value) + b"]"
    if isinstance(value, dict):
        parts = bytearray(b"<<")
        for k, v in value.items():
            parts += _fmt_name(str(k)) + b" " + serialize(v)
        parts += b">>"
        return bytes(parts)
    if isinstance(value, Stream):
        d = dict(value.dict)
        d["Length"] = len(value.raw)
        return serialize(d) + b"\nstream\n" + value.raw + b"\nendstream"
    return b"null"


class Builder:
    """Collects pages from one or more documents into a new PDF."""

    CATALOG, PAGES = 1, 2

    def __init__(self):
        self.bodies = {}
        self.next = 3
        self.page_objects = []

    def _alloc(self):
        num = self.next
        self.next += 1
        return num

    def add(self, doc: PDF, wanted):
        """Append `wanted` (1-based page numbers) from `doc`, in that order."""
        pages = doc.pages()
        selected = set()
        for n in wanted:
            ref = pages[n - 1]["ref"]
            if ref is not None:
                selected.add(ref.key())
        memo = {}
        for n in wanted:
            page = pages[n - 1]
            num = self._alloc()
            if page["ref"] is not None:
                memo[page["ref"].key()] = num
            merged = dict(page["obj"])
            for k, v in page["inherited"].items():
                merged.setdefault(k, v)
            merged.pop("Parent", None)
            body = {k: self._copy(doc, v, memo, selected) for k, v in merged.items()}
            body["Type"] = Name("Page")
            body["Parent"] = Ref(self.PAGES, 0)
            if "MediaBox" not in body:
                body["MediaBox"] = [0, 0, 612, 792]
            self.bodies[num] = body
            self.page_objects.append(num)

    def _copy(self, doc, value, memo, selected, depth=0):
        if depth > 96:
            return None
        if isinstance(value, Ref):
            key = value.key()
            if key in memo:
                return Ref(memo[key], 0)
            target = doc.resolve(value)
            if target is None:
                return None
            # Never drag in a page we didn't ask for (an annotation may link to one).
            probe = target.dict if isinstance(target, Stream) else target
            if isinstance(probe, dict) and str(probe.get("Type")) == "Page" and key not in selected:
                return None
            num = self._alloc()
            memo[key] = num
            self.bodies[num] = self._copy(doc, target, memo, selected, depth + 1)
            return Ref(num, 0)
        if isinstance(value, Stream):
            return Stream({k: self._copy(doc, v, memo, selected, depth + 1)
                           for k, v in value.dict.items() if k != "Length"}, value.raw)
        if isinstance(value, dict):
            return {k: self._copy(doc, v, memo, selected, depth + 1)
                    for k, v in value.items() if k != "Parent"}
        if isinstance(value, list):
            return [self._copy(doc, v, memo, selected, depth + 1) for v in value]
        return value

    def build(self) -> bytes:
        if not self.page_objects:
            raise PdfError("No pages selected")
        self.bodies[self.CATALOG] = {"Type": Name("Catalog"), "Pages": Ref(self.PAGES, 0)}
        self.bodies[self.PAGES] = {
            "Type": Name("Pages"),
            "Kids": [Ref(n, 0) for n in self.page_objects],
            "Count": len(self.page_objects),
        }
        out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = {}
        for num in range(1, self.next):
            if num not in self.bodies:
                continue
            offsets[num] = len(out)
            out += f"{num} 0 obj\n".encode("ascii") + serialize(self.bodies[num]) + b"\nendobj\n"
        size = self.next
        xref_at = len(out)
        out += f"xref\n0 {size}\n".encode("ascii") + b"0000000000 65535 f \n"
        for num in range(1, size):
            if num in offsets:
                out += f"{offsets[num]:010d} 00000 n \n".encode("ascii")
            else:
                out += b"0000000000 65535 f \n"
        out += (
            f"trailer\n<< /Size {size} /Root {self.CATALOG} 0 R >>\n"
            f"startxref\n{xref_at}\n%%EOF\n"
        ).encode("ascii")
        return bytes(out)


# --- page ranges ----------------------------------------------------------

def parse_ranges(spec: str, total: int):
    """Turn "2-4", "1,3,5-7", "2-" or "" into a list of 1-based page numbers."""
    spec = (spec or "").strip().lower()
    if not spec or spec == "all":
        return list(range(1, total + 1))
    out = []
    for chunk in re.split(r"[,\s]+", spec):
        if not chunk:
            continue
        m = re.fullmatch(r"(\d*)\s*[-–:]\s*(\d*)", chunk)
        if m:
            start = int(m.group(1)) if m.group(1) else 1
            end = int(m.group(2)) if m.group(2) else total
        elif chunk.isdigit():
            start = end = int(chunk)
        else:
            raise PdfError(f"Can't read page range “{chunk}”")
        if start < 1 or end < 1:
            raise PdfError("Page numbers start at 1")
        if start > total or end > total:
            raise PdfError(f"This PDF only has {total} page{'s' if total > 1 else ''}")
        out.extend(range(start, end + 1) if start <= end else range(start, end - 1, -1))
    if not out:
        raise PdfError("No pages selected")
    return out


def invert_ranges(spec: str, total: int):
    """The pages left when `spec` says what to take *out*.

    The inverse of parse_ranges, and deliberately not the same default: an
    empty selection means "remove nothing" here, where in parse_ranges it
    means "keep everything". Both come out as the whole document, but for
    opposite reasons.
    """
    spec = (spec or "").strip()
    if not spec:
        return list(range(1, total + 1))
    drop = set(parse_ranges(spec, total))
    kept = [n for n in range(1, total + 1) if n not in drop]
    if not kept:
        raise PdfError("That would remove every page")
    return kept


def page_count(data: bytes) -> int:
    return PDF(data).page_count()


def build(parts) -> bytes:
    """parts: [(pdf_bytes, range_spec)] -> one PDF with those pages, in order."""
    builder = Builder()
    for data, spec in parts:
        doc = PDF(data)
        builder.add(doc, parse_ranges(spec, doc.page_count()))
    return builder.build()


def build_without(parts) -> bytes:
    """Like build(), but each spec says which pages to remove."""
    builder = Builder()
    for data, spec in parts:
        doc = PDF(data)
        builder.add(doc, invert_ranges(spec, doc.page_count()))
    return builder.build()
