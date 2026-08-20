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
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import convert as convert_mod
from . import pdfedit
from .convert import (
    INPUT_EXTS,
    OUTPUT_FORMATS,
    ConversionError,
    convert,
    thumbnail,
)

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
DEFAULT_PORT = 8765

MIME = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
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
        # Everything the page needs is inline and local; this stops any
        # injected markup from reaching the network.
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; "
            "connect-src 'self'; form-action 'none'; frame-ancestors 'none'; "
            "base-uri 'none'",
        )
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
            try:
                with open(os.path.join(WEB, "index.html"), "rb") as fh:
                    body = fh.read()
            except OSError:
                self._send(500, b"index.html is missing")
                return
            self._send(200, body, "text/html; charset=utf-8")
        elif path == "/health":
            self._send(200, b"ok")
        else:
            self._send(404, b"Not found")

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
            self.do_preview()
        elif parsed.path == "/pdf/info":
            self.do_pdf_info()
        elif parsed.path == "/pdf/build":
            self.do_pdf_build()
        else:
            self._send(404, b"Not found")

    def do_preview(self):
        """A small JPEG thumbnail so the user can see what they dropped."""
        data = self._read_body()
        if data is None:
            return
        try:
            thumb = thumbnail(data, self._filename())
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

    def do_pdf_build(self):
        """Build one PDF from page ranges of the uploaded PDFs, in order.

        The body is each file prefixed by its 4-byte big-endian length, which
        keeps several files in one request without needing a multipart parser.
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

        try:
            result = pdfedit.build(list(zip(parts, ranges)))
        except pdfedit.PdfError as exc:
            self._send(422, str(exc).encode("utf-8"))
            return
        except Exception as exc:
            self._send(500, f"Could not build the PDF: {exc}".encode("utf-8"))
            return
        self._send(200, result, "application/pdf")

    def do_convert(self, query):
        out_format = (query.get("format", ["jpg"])[0] or "jpg").lower()
        try:
            quality = int(query.get("quality", ["85"])[0])
        except ValueError:
            quality = 85

        if out_format not in OUTPUT_FORMATS:
            self._send(400, b"Unsupported output format")
            return

        data = self._read_body()
        if data is None:
            return

        name = self._filename()
        stem = os.path.splitext(os.path.basename(name))[0] or "file"

        try:
            result, ext, note = convert(data, name, out_format, quality)
        except ConversionError as exc:
            self._send(422, str(exc).encode("utf-8"))
            return
        except Exception as exc:  # unexpected: fail one file, not the whole app
            self._send(500, f"Conversion failed: {exc}".encode("utf-8"))
            return

        headers = {"X-Out-Name": urllib.parse.quote(f"{stem}.{ext}")}
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

    print(f"\n  Convertly is running at {url}")
    print("  Images, PDFs, Word and iWork files  ->  jpg, jpeg, pdf")
    print("  Plus: pull pages out of a PDF, or join PDFs together")
    print(f"  ({len(INPUT_EXTS)} input types)")
    print("  Everything stays on this machine. Press Ctrl+C to stop.\n")

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
