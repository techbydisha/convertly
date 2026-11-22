#!/usr/bin/env python3
"""Convertly -- a local file converter and PDF editor.

Run it with:  python3 app.py

Starts a small server on 127.0.0.1 only, opens your browser, and does all the
work on this machine. Nothing is uploaded anywhere and nothing is stored: files
live in memory for the length of one request.
"""

import argparse
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import convert as convert_mod
from . import naming
from . import pdfedit
from .convert import (
    INPUT_EXTS,
    OUTPUT_FORMATS,
    ConversionError,
    convert,
    thumbnail,
)

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8765


def _find_site():
    """Where the interface lives.

    The macOS app and the hosted page run the same interface, from one copy of
    it in web/. Installed with pip, that copy is packaged as convertly/site;
    run from a checkout, it is web/ at the top of the repository.
    """
    for candidate in (os.path.join(HERE, "site"),
                      os.path.normpath(os.path.join(HERE, os.pardir, os.pardir, "web"))):
        if os.path.isfile(os.path.join(candidate, "index.html")):
            return candidate
    return os.path.join(HERE, "site")     # missing: requests for it fail cleanly


SITE = _find_site()

# The page served here does its work through this server, so it may connect
# to its own origin -- and nowhere else. Otherwise it is the hosted page's
# policy: no inline code of any kind, and workers only from this origin or
# from blob: wrappers, which inherit this policy (see web/js/worker.js).
CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; "
    "img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; "
    "form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
)

# The only files served from the site, and as what. Anything else is a 404,
# including the tests and READMEs that sit beside them.
STATIC_DIRS = ("css/", "js/", "vendor/")
STATIC_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
}

# The hosted page carries its own policy in a <meta> tag, with connect-src
# 'none'. Served here, that would block every request to this server --
# two policies apply together, so the stricter wins -- so it is removed and
# the header above stands in for it.
META_CSP = re.compile(
    r"""<meta\s[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>""",
    re.IGNORECASE)

MIME = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "pdf": "application/pdf",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "Convertly"
    protocol_version = "HTTP/1.1"

    # --- helpers -----------------------------------------------------------

    def _send(self, code, body=b"", content_type="text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")

    def _local_only(self):
        """Only accept same-machine, same-origin requests.

        The Host check defeats DNS rebinding, where a hostile page resolves its
        own domain to 127.0.0.1 to reach this server. The Origin check stops a
        page on another site from POSTing here (browsers already require a
        preflight for these requests, and no OPTIONS handler answers one, so
        this is a second lock on the same door).
        """
        host = self.headers.get("Host", "").split(":")[0].strip("[]")
        if host not in self.LOCAL_HOSTS:
            self._send(403, b"Local requests only")
            return False
        origin = self.headers.get("Origin")
        if origin and origin != "null":
            if urllib.parse.urlparse(origin).hostname not in self.LOCAL_HOSTS:
                self._send(403, b"Cross-site requests are not allowed")
                return False
        return True

    def log_message(self, fmt, *args):  # quieter console
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)

    # --- routes ------------------------------------------------------------

    def do_GET(self):
        if not self._local_only():
            return
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._send_index()
        elif path == "/health":
            self._send(200, b"ok")
        elif path.startswith(tuple("/" + d for d in STATIC_DIRS)):
            self._send_static(path)
        else:
            self._send(404, b"Not found")

    def _send_index(self):
        """The shared page, told to use this server, under this server's policy."""
        try:
            with open(os.path.join(SITE, "index.html"), encoding="utf-8") as fh:
                html = fh.read()
        except OSError:
            self._send(500, b"index.html is missing")
            return
        html, removed = META_CSP.subn("", html, count=1)
        if not removed:
            # Not fatal -- the header still applies -- but a page that has
            # dropped its own policy is a change worth noticing.
            sys.stderr.write("warning: index.html has no <meta> policy to replace\n")
        html = html.replace(
            "<head>", '<head>\n<meta name="convertly-backend" content="server">', 1)
        self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")

    def _send_static(self, path):
        """A file from the site: only css/, js/ and vendor/, only by type, never outside it."""
        relative = urllib.parse.unquote(path).lstrip("/")
        # Checked before anything touches the filesystem: realpath() raises on
        # an embedded NUL, which crashed the handler until a test sent one.
        if "\0" in relative or not relative.startswith(STATIC_DIRS):
            self._send(404, b"Not found")
            return
        root = os.path.realpath(SITE)
        try:
            full = os.path.realpath(os.path.join(root, relative))
        except (ValueError, OSError):
            self._send(404, b"Not found")
            return
        kind = STATIC_TYPES.get(os.path.splitext(full)[1].lower())
        if not full.startswith(root + os.sep) or kind is None or not os.path.isfile(full):
            self._send(404, b"Not found")
            return
        try:
            with open(full, "rb") as fh:
                body = fh.read()
        except OSError:
            self._send(404, b"Not found")
            return
        self._send(200, body, kind)

    def _read_body(self):
        """Read the uploaded bytes, or send an error and return None."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._send(400, b"No file data")
            return None
        if length > convert_mod.MAX_BYTES:
            self._send(413, b"File is too large")
            return None
        return self.rfile.read(length)

    def _filename(self):
        return urllib.parse.unquote(self.headers.get("X-Filename", "file"))

    def do_POST(self):
        if not self._local_only():
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/convert":
            self.do_convert(urllib.parse.parse_qs(parsed.query))
        elif parsed.path == "/preview":
            self.do_preview(urllib.parse.parse_qs(parsed.query))
        elif parsed.path == "/pdf/info":
            self.do_pdf_info()
        elif parsed.path == "/pdf/build":
            self.do_pdf_build(urllib.parse.parse_qs(parsed.query))
        else:
            self._send(404, b"Not found")

    def do_preview(self, query=None):
        """A JPEG of what was dropped: a thumbnail for the list, or with `px`,
        a picture big enough for the review pane."""
        px = self._positive_int(query or {}, "px", 1600) or 240
        px = max(60, px)
        data = self._read_body()
        if data is None:
            return
        try:
            thumb = thumbnail(data, self._filename(), px)
        except Exception:
            thumb = None
        if not thumb:
            self._send(204)  # no preview available; the UI falls back to an icon
            return
        self._send(200, thumb, "image/jpeg")

    def do_pdf_info(self):
        """How many pages a PDF has, so the UI can check page ranges."""
        data = self._read_body()
        if data is None:
            return
        try:
            pages = pdfedit.page_count(data)
        except pdfedit.PdfError as exc:
            self._send(422, str(exc).encode("utf-8"))
            return
        except Exception:
            self._send(422, b"This PDF could not be read")
            return
        self._send(200, json.dumps({"pages": pages}).encode(), "application/json")

    def do_pdf_build(self, query=None):
        """Build one PDF from page ranges of the uploaded PDFs, in order.

        The body is each file prefixed by its 4-byte big-endian length, which
        keeps several files in one request without needing a multipart parser.

        `mode=remove` reads each range as the pages to take *out* rather than
        the pages to keep, which is what the Edit tab asks for.
        """
        body = self._read_body()
        if body is None:
            return
        parts, pos = [], 0
        while pos + 4 <= len(body):
            size = int.from_bytes(body[pos:pos + 4], "big")
            pos += 4
            if size < 0 or pos + size > len(body):
                self._send(400, b"Malformed request")
                return
            parts.append(body[pos:pos + size])
            pos += size
        if not parts:
            self._send(400, b"No PDFs sent")
            return

        try:
            ranges = json.loads(urllib.parse.unquote(self.headers.get("X-Ranges", "[]")))
        except ValueError:
            ranges = []
        if len(ranges) != len(parts):
            ranges = [""] * len(parts)

        mode = ((query or {}).get("mode", ["keep"])[0] or "keep").lower()
        if mode not in ("keep", "remove"):
            self._send(400, b"Unknown mode")
            return
        make = pdfedit.build_without if mode == "remove" else pdfedit.build

        try:
            result = make(list(zip(parts, ranges)))
        except pdfedit.PdfError as exc:
            self._send(422, str(exc).encode("utf-8"))
            return
        except Exception as exc:
            self._send(500, f"Could not build the PDF: {exc}".encode("utf-8"))
            return
        self._send(200, result, "application/pdf")

    @staticmethod
    def _positive_int(query, key, limit):
        """A bounded positive integer from the query string, or None."""
        raw = query.get(key, [""])[0]
        try:
            value = int(raw)
        except ValueError:
            return None
        return value if 0 < value <= limit else None

    def do_convert(self, query):
        out_format = (query.get("format", ["jpg"])[0] or "jpg").lower()
        try:
            quality = int(query.get("quality", ["85"])[0])
        except ValueError:
            quality = 85
        max_px = self._positive_int(query, "max_px", 20000)
        target_bytes = self._positive_int(query, "target", convert_mod.MAX_BYTES)

        if out_format not in OUTPUT_FORMATS:
            self._send(400, b"Unsupported output format")
            return

        data = self._read_body()
        if data is None:
            return

        name = self._filename()

        try:
            result, ext, note = convert(data, name, out_format, quality,
                                        max_px, target_bytes)
        except ConversionError as exc:
            self._send(422, str(exc).encode("utf-8"))
            return
        except Exception as exc:  # unexpected: fail one file, not the whole app
            self._send(500, f"Conversion failed: {exc}".encode("utf-8"))
            return

        headers = {"X-Out-Name": urllib.parse.quote(naming.converted_name(name, ext))}
        if note:
            headers["X-Note"] = urllib.parse.quote(note)
        self._send(200, result, MIME[out_format], headers)


def free_port(preferred):
    for port in (preferred, 0):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return sock.getsockname()[1]
            except OSError:
                continue
    raise SystemExit("Could not bind a local port")


def build_parser():
    """Command-line options, separated out so the tests can check them."""
    parser = argparse.ArgumentParser(
        prog="convertly",
        description="Convert images and documents, and edit PDFs, entirely on this machine.",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"port to listen on (default {DEFAULT_PORT})")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    parser.add_argument("--verbose", action="store_true", help="log every request")
    parser.add_argument(
        "--use-word", action="store_true",
        help="let Word launch to export Word files as full multi-page PDFs",
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    convert_mod.USE_WORD = args.use_word

    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}/"
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True

    # flush=True so the address is visible immediately even when the output is
    # redirected to a file rather than a terminal.
    print(f"\n  Convertly is running at {url}", flush=True)
    print("  Images, PDFs, Word and iWork files  ->  jpg, jpeg, pdf", flush=True)
    print("  Resize pictures or fit them under a size limit", flush=True)
    print("  Pull pages out of a PDF, or join PDFs together", flush=True)
    print(f"  ({len(INPUT_EXTS)} input types)", flush=True)
    print("  Everything stays on this machine. Press Ctrl+C to stop.\n", flush=True)

    if not args.no_browser:
        threading.Thread(target=lambda: (time.sleep(0.4), webbrowser.open(url)), daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.\n")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
