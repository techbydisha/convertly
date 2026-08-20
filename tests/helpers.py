"""Fixtures and utilities shared by the tests.

Every fixture is built on the fly -- no binary test files are committed, so the
repository stays free of anything that could carry personal data.
"""

import http.client
import os
import re
import shutil
import socket
import tempfile
import threading
import unittest
import zlib
from http.server import ThreadingHTTPServer

from convertly import pdfedit
from convertly.server import Handler

HAS_SIPS = shutil.which("sips") is not None
HAS_QUICKLOOK = shutil.which("qlmanage") is not None

requires_sips = unittest.skipUnless(HAS_SIPS, "needs macOS `sips`")
requires_quicklook = unittest.skipUnless(HAS_QUICKLOOK, "needs macOS `qlmanage`")


# --- PDF fixtures ---------------------------------------------------------

def make_pdf(labels=("Page one",), classic=True):
    """A valid multi-page PDF with one line of text per page."""
    n = len(labels)
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", None]
    kids = " ".join(f"{3 + i} 0 R" for i in range(n))
    objs[1] = f"<< /Type /Pages /Kids [{kids}] /Count {n} >>"
    for i in range(n):
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Contents {3 + n + i} 0 R /Resources << /Font << /F1 {3 + 2 * n} 0 R >> >> >>"
        )
    for label in labels:
        body = f"BT /F1 30 Tf 72 700 Td ({label}) Tj ET"
        objs.append(f"<< /Length {len(body)} >>\nstream\n{body}\nendstream")
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = "%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n"
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets)
    out += (f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_at}\n%%EOF\n")
    return out.encode("latin-1")


def make_modern_pdf(labels=("Modern one", "Modern two")):
    """A PDF 1.5 file: objects in an object stream, plus a cross-reference
    stream with a PNG predictor -- what Word and Chrome produce."""
    n = len(labels)
    page_nums = [3 + i for i in range(n)]
    content_nums = [3 + n + i for i in range(n)]
    font_n = 3 + 2 * n
    objstm_n, xref_n = font_n + 1, font_n + 2

    packed = {1: b"<< /Type /Catalog /Pages 2 0 R >>"}
    kids = b" ".join(f"{p} 0 R".encode() for p in page_nums)
    packed[2] = b"<< /Type /Pages /Kids [" + kids + f"] /Count {n} >>".encode()
    for pn, cn in zip(page_nums, content_nums):
        packed[pn] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {cn} 0 R "
            f"/Resources << /Font << /F1 {font_n} 0 R >> >> >>"
        ).encode()
    packed[font_n] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

    pairs, body = b"", b""
    for num, ser in packed.items():
        pairs += f"{num} {len(body)} ".encode()
        body += ser + b"\n"
    compressed = zlib.compress(pairs + body)

    out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for cn, label in zip(content_nums, labels):
        raw = f"BT /F1 30 Tf 72 700 Td ({label}) Tj ET".encode()
        offsets[cn] = len(out)
        out += f"{cn} 0 obj\n<< /Length {len(raw)} >>\nstream\n".encode() + raw + b"\nendstream\nendobj\n"
    offsets[objstm_n] = len(out)
    out += (f"{objstm_n} 0 obj\n<< /Type /ObjStm /N {len(packed)} /First {len(pairs)} "
            f"/Filter /FlateDecode /Length {len(compressed)} >>\nstream\n").encode()
    out += compressed + b"\nendstream\nendobj\n"

    size = xref_n + 1
    rows = [bytes([0]) + (0).to_bytes(4, "big") + (65535).to_bytes(2, "big")]
    for num in range(1, size):
        if num in offsets:
            rows.append(bytes([1]) + offsets[num].to_bytes(4, "big") + (0).to_bytes(2, "big"))
        elif num in packed:
            rows.append(bytes([2]) + objstm_n.to_bytes(4, "big")
                        + list(packed).index(num).to_bytes(2, "big"))
        else:
            rows.append(bytes([0]) + (0).to_bytes(4, "big") + (0).to_bytes(2, "big"))
    xref_at = len(out)
    rows[xref_n] = bytes([1]) + xref_at.to_bytes(4, "big") + (0).to_bytes(2, "big")

    rowlen = 7
    prev, predicted = bytearray(rowlen), bytearray()
    for row in rows:                                   # PNG "Up" filter
        predicted += bytes([2]) + bytes((row[j] - prev[j]) & 0xFF for j in range(rowlen))
        prev = bytearray(row)
    xcomp = zlib.compress(bytes(predicted))
    out += (f"{xref_n} 0 obj\n<< /Type /XRef /Size {size} /W [1 4 2] /Root 1 0 R "
            f"/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns {rowlen} >> "
            f"/Length {len(xcomp)} >>\nstream\n").encode() + xcomp + b"\nendstream\nendobj\n"
    out += f"startxref\n{xref_at}\n%%EOF\n".encode()
    return bytes(out)


def page_texts(data):
    """The text drawn on each page, for asserting which pages survived."""
    doc = pdfedit.PDF(data)
    out = []
    for page in doc.pages():
        contents = doc.resolve(page["obj"].get("Contents"))
        chunks = contents if isinstance(contents, list) else [contents]
        blob = b""
        for chunk in chunks:
            chunk = doc.resolve(chunk)
            if isinstance(chunk, pdfedit.Stream):
                try:
                    blob += pdfedit.decode_stream(chunk, doc)
                except pdfedit.PdfError:
                    pass
        words = [w.decode("latin-1").strip() for w in re.findall(rb"\((.*?)\)", blob)]
        out.append(" ".join(w for w in words if w))
    return out


# --- image fixtures -------------------------------------------------------

_image_cache = {}


def make_image(fmt="heic", width=64, height=48):
    """A real image in the requested format, produced by `sips`."""
    key = (fmt, width, height)
    if key in _image_cache:
        return _image_cache[key]
    if not HAS_SIPS:
        raise unittest.SkipTest("needs macOS `sips`")
    pixels = bytearray()
    for y in range(height):
        for x in range(width):
            pixels += bytes(((x * 255) // width, (y * 255) // height, 128))
    tmpdir = tempfile.mkdtemp(prefix="convertly-test-")
    try:
        ppm = os.path.join(tmpdir, "src.ppm")
        with open(ppm, "wb") as fh:
            fh.write(b"P6\n%d %d\n255\n" % (width, height) + bytes(pixels))
        dst = os.path.join(tmpdir, "out." + fmt)
        import subprocess
        proc = subprocess.run(
            ["sips", "-s", "format", {"jpg": "jpeg"}.get(fmt, fmt), ppm, "--out", dst],
            capture_output=True,
        )
        if proc.returncode != 0 or not os.path.exists(dst):
            raise unittest.SkipTest(f"sips cannot produce {fmt} here")
        with open(dst, "rb") as fh:
            _image_cache[key] = fh.read()
        return _image_cache[key]
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def make_docx(paragraphs=("Heading", "Body text")):
    """A minimal but structurally valid .docx."""
    import zipfile
    import io
    types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
             '<Default Extension="xml" ContentType="application/xml"/>'
             '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
             'officedocument.wordprocessingml.document.main+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f'<w:body>{body}</w:body></w:document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", doc)
    return buf.getvalue()


def make_iwork(inner_pdf=None):
    """A .pages-style bundle carrying the PDF preview iWork apps embed."""
    import zipfile
    import io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("QuickLook/Preview.pdf", inner_pdf or make_pdf(("iWork page",)))
        z.writestr("Index/Document.iwa", b"\x00binary")
    return buf.getvalue()


# --- a running server -----------------------------------------------------

class LocalServer:
    """Runs the real request handler on a loopback port for the test."""

    def __init__(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.server = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, method, path, body=None, headers=None, host=None, timeout=120):
        """Send a request, controlling the Host header exactly."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            conn.putheader("Host", host if host is not None else f"127.0.0.1:{self.port}")
            conn.putheader("Content-Length", str(len(body or b"")))
            for key, value in (headers or {}).items():
                conn.putheader(key, value)
            conn.endheaders()
            if body:
                conn.send(body)
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()


def temp_dir_count():
    """How many of our scratch directories exist right now."""
    root = tempfile.gettempdir()
    try:
        return len([n for n in os.listdir(root) if n.startswith("convertly-")])
    except OSError:
        return 0
