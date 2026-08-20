"""Security properties this app must hold.

Convertly listens on a local port while a browser is open, so the realistic
threat is a web page the user visits trying to reach it, or a hostile file
being fed to the parsers. Each test here maps to a check in docs/TESTING.md.
"""

import os
import re
import socket
import struct
import unittest
import urllib.parse

from convertly import convert as conv
from convertly import server as srv

from .helpers import LocalServer, make_image, make_pdf, requires_sips, temp_dir_count

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NetworkExposure(unittest.TestCase):
    """The server must not be reachable from anywhere but this machine."""

    def test_binds_loopback_only(self):
        with LocalServer() as server:
            self.assertEqual(server.server.server_address[0], "127.0.0.1")

    def test_default_bind_address_is_loopback(self):
        with open(os.path.join(ROOT, "src", "convertly", "server.py")) as fh:
            source = fh.read()
        self.assertIn('ThreadingHTTPServer(("127.0.0.1", port)', source)
        self.assertNotIn('"0.0.0.0"', source)

    def test_not_listening_on_a_routable_address(self):
        local_ip = socket.gethostbyname(socket.gethostname())
        if local_ip.startswith("127."):
            self.skipTest("host has no non-loopback address to probe")
        with LocalServer() as server:
            with socket.socket() as probe:
                probe.settimeout(2)
                with self.assertRaises((ConnectionRefusedError, OSError)):
                    probe.connect((local_ip, server.port))


class RequestOrigin(unittest.TestCase):
    """DNS rebinding and cross-site requests."""

    @classmethod
    def setUpClass(cls):
        cls.ctx = LocalServer()
        cls.server = cls.ctx.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.ctx.__exit__(None, None, None)

    def test_rejects_foreign_host_header(self):
        """A page that points its own domain at 127.0.0.1 must be turned away."""
        for host in ("evil.example.com", "attacker.test", "convertly.evil.com"):
            with self.subTest(host=host):
                status, _, body = self.server.request("GET", "/", host=host)
                self.assertEqual(status, 403)
                self.assertIn(b"Local requests only", body)

    def test_accepts_loopback_host_names(self):
        for host in ("127.0.0.1", "localhost", f"localhost:{self.server.port}"):
            with self.subTest(host=host):
                self.assertEqual(self.server.request("GET", "/health", host=host)[0], 200)

    def test_rejects_cross_site_origin(self):
        for origin in ("https://evil.example.com", "http://attacker.test:8080"):
            with self.subTest(origin=origin):
                status, _, body = self.server.request(
                    "POST", "/pdf/info", body=make_pdf(("A",)),
                    headers={"Origin": origin})
                self.assertEqual(status, 403)
                self.assertIn(b"Cross-site", body)

    def test_allows_same_origin_requests(self):
        status, _, _ = self.server.request(
            "POST", "/pdf/info", body=make_pdf(("A",)),
            headers={"Origin": f"http://127.0.0.1:{self.server.port}"})
        self.assertEqual(status, 200)

    def test_no_preflight_handler_exists(self):
        """Without an OPTIONS handler, browsers block cross-origin POSTs."""
        self.assertFalse(hasattr(srv.Handler, "do_OPTIONS"))

    def test_no_cors_headers_are_ever_sent(self):
        _, headers, _ = self.server.request("GET", "/health")
        for header in headers:
            self.assertFalse(header.lower().startswith("access-control-"),
                             f"{header} would open this server to other sites")


class ResponseHeaders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = LocalServer()
        cls.server = cls.ctx.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.ctx.__exit__(None, None, None)

    def test_security_headers_are_present(self):
        _, headers, _ = self.server.request("GET", "/")
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(headers.get("Referrer-Policy"), "no-referrer")
        self.assertIn("default-src 'self'", headers.get("Content-Security-Policy", ""))

    def test_content_security_policy_blocks_outbound_connections(self):
        _, headers, _ = self.server.request("GET", "/")
        policy = headers["Content-Security-Policy"]
        self.assertIn("connect-src 'self'", policy)
        self.assertIn("frame-ancestors 'none'", policy)

    def test_nothing_is_cached(self):
        _, headers, _ = self.server.request("GET", "/")
        self.assertEqual(headers.get("Cache-Control"), "no-store")


class HostileFilenames(unittest.TestCase):
    """The filename arrives in a header and is fully attacker-controlled."""

    @classmethod
    def setUpClass(cls):
        cls.ctx = LocalServer()
        cls.server = cls.ctx.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.ctx.__exit__(None, None, None)

    NASTY = [
        "../../../../etc/passwd.heic",
        "..\\..\\windows\\system32\\evil.heic",
        "/etc/passwd.heic",
        'a";do shell script "touch /tmp/pwned";".heic',
        "a$(touch /tmp/pwned).heic",
        "a`touch /tmp/pwned`.heic",
        "a\x00truncated.heic",
    ]

    def test_output_name_never_escapes_its_directory(self):
        for name in self.NASTY:
            with self.subTest(name=name):
                status, headers, _ = self.server.request(
                    "POST", "/convert?format=jpg", body=b"junk",
                    headers={"X-Filename": urllib.parse.quote(name)})
                out = urllib.parse.unquote(headers.get("X-Out-Name", ""))
                self.assertNotIn("/", out)
                self.assertNotIn("\\", out)
                self.assertNotIn("..", out)

    def test_shell_metacharacters_have_no_effect(self):
        marker = "/tmp/pwned"
        if os.path.exists(marker):
            os.remove(marker)
        for name in self.NASTY:
            self.server.request("POST", "/convert?format=jpg", body=b"junk",
                                headers={"X-Filename": urllib.parse.quote(name)})
        self.assertFalse(os.path.exists(marker),
                         "a filename managed to run a shell command")

    def test_extension_is_reduced_to_safe_characters(self):
        for raw, expected in [("a.heic", "heic"), ("a.HEIC", "heic"),
                              ('a.he"ic', "heic"), ("a.he;ic", "heic"),
                              ("a.he/ic", "bin"),        # no extension after the slash
                              ("a.", "bin"), ("a", "bin"), ("a.\u00e9xt", "xt")]:
            with self.subTest(raw=raw):
                with conv._workspace(b"x", raw) as (tmpdir, src):
                    self.assertEqual(os.path.basename(src), f"input.{expected}")
                    self.assertEqual(os.path.dirname(src), tmpdir)

    def test_response_headers_cannot_be_injected(self):
        status, headers, _ = self.server.request(
            "POST", "/convert?format=jpg", body=b"junk",
            headers={"X-Filename": urllib.parse.quote("evil\r\nX-Injected: yes.heic")})
        self.assertNotIn("X-Injected", headers)


class HostileFiles(unittest.TestCase):
    """Parsers must fail safely on files built to break them."""

    def test_parsers_never_raise_unexpected_exceptions(self):
        from convertly import pdfedit
        samples = [
            b"", b"%PDF", b"%PDF-1.4\n" + b"\x00" * 500,
            b"%PDF-1.4\ntrailer<</Root 1 0 R>>startxref\n-1\n%%EOF",
            b"%PDF-1.4\n1 0 obj\n<< /Kids [1 0 R] /Type /Pages >>\nendobj\n"  # self-reference
            b"trailer<</Root 1 0 R>>\nstartxref\n9\n%%EOF",
            b"%PDF-1.4\n" + b"((((((((((" * 200,
            b"%PDF-1.4\n1 0 obj\n<< /Length 999999999 >>\nstream\nshort\nendstream",
        ]
        for sample in samples:
            with self.subTest(sample=sample[:24]):
                try:
                    pdfedit.page_count(sample)
                except pdfedit.PdfError:
                    pass                                    # the expected outcome
                except RecursionError:
                    self.fail("unbounded recursion on hostile input")

    def test_upload_size_is_capped(self):
        self.assertLessEqual(conv.MAX_BYTES, 512 * 1024 * 1024)

    def test_subprocesses_never_use_a_shell(self):
        """Command injection is impossible if no shell is involved."""
        for name in ("convert.py", "pdfedit.py", "server.py"):
            with open(os.path.join(ROOT, "src", "convertly", name)) as fh:
                source = fh.read()
            with self.subTest(module=name):
                self.assertNotIn("shell=True", source)
                self.assertNotIn("os.system", source)
                self.assertNotIn("os.popen", source)

    def test_external_commands_are_absolute_or_looked_up_safely(self):
        with open(os.path.join(ROOT, "src", "convertly", "convert.py")) as fh:
            self.assertIn("shutil.which", fh.read())


class NoPersistence(unittest.TestCase):
    """'Use as you go': nothing may survive a request."""

    @requires_sips
    def test_no_scratch_directories_survive(self):
        before = temp_dir_count()
        with LocalServer() as server:
            server.request("POST", "/convert?format=pdf", body=make_image("heic"),
                           headers={"X-Filename": "p.heic"})
            server.request("POST", "/pdf/build",
                           body=struct.pack(">I", len(make_pdf(("A", "B")))) + make_pdf(("A", "B")))
        self.assertEqual(temp_dir_count(), before)

    def test_source_never_writes_outside_a_temp_directory(self):
        """Uploads may only ever be written into mkdtemp() directories."""
        with open(os.path.join(ROOT, "src", "convertly", "convert.py")) as fh:
            source = fh.read()
        writes = re.findall(r'open\(([^,]+),\s*"wb"\)', source)
        for target in writes:
            with self.subTest(target=target):
                self.assertTrue(
                    any(k in target for k in ("dst", "src", "png_path", "pdf_path", "path")),
                    f"unexpected write target: {target}")
        self.assertIn("shutil.rmtree(tmpdir, ignore_errors=True)", source)

    def test_no_database_or_upload_directory_is_used(self):
        for name in ("convert.py", "pdfedit.py", "server.py"):
            with open(os.path.join(ROOT, "src", "convertly", name)) as fh:
                source = fh.read()
            with self.subTest(module=name):
                for smell in ("sqlite3", "shelve", "pickle", "uploads/"):
                    self.assertNotIn(smell, source)


class NoNetworkCalls(unittest.TestCase):
    """The whole point: nothing may leave the machine."""

    FORBIDDEN = {"urllib.request", "urllib.error", "http.client", "requests",
                 "httpx", "smtplib", "ftplib", "telnetlib", "asyncio"}

    # Everything the app is allowed to import. A new name here should be a
    # deliberate decision, which is the point of pinning the list.
    ALLOWED = {"argparse", "base64", "contextlib", "glob", "http.server", "io",
               "json", "os", "re", "shutil", "socket", "struct", "subprocess",
               "sys", "tempfile", "threading", "time", "unittest", "urllib.parse",
               "webbrowser", "zipfile", "zlib"}

    @staticmethod
    def imported_modules(path):
        import ast
        with open(path, encoding="utf-8") as fh:
            tree = ast.parse(fh.read(), path)
        found = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                found.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                found.add(node.module)
        return found

    def test_no_outbound_network_libraries_are_used(self):
        for name in ("convert.py", "pdfedit.py", "server.py", "__init__.py", "__main__.py"):
            path = os.path.join(ROOT, "src", "convertly", name)
            with self.subTest(module=name):
                self.assertEqual(self.imported_modules(path) & self.FORBIDDEN, set())

    def test_only_expected_modules_are_imported(self):
        """Also catches a third-party dependency being added by accident."""
        for name in ("convert.py", "pdfedit.py", "server.py", "__init__.py", "__main__.py"):
            path = os.path.join(ROOT, "src", "convertly", name)
            with self.subTest(module=name):
                unexpected = self.imported_modules(path) - self.ALLOWED
                self.assertEqual(unexpected, set(), f"unexpected imports: {unexpected}")

    def test_page_loads_no_remote_resources(self):
        with open(os.path.join(ROOT, "src", "convertly", "web", "index.html")) as fh:
            page = fh.read()
        for smell in ("http://", "https://", "//cdn", "integrity="):
            self.assertNotIn(smell, page,
                             f"the UI must not reference {smell} -- it has to work offline")


class NoSecretsInRepo(unittest.TestCase):
    """Nothing credential-shaped may be committed."""

    SKIP_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules", ".pytest_cache"}
    PATTERNS = [
        (r"(?i)api[_-]?key\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}", "API key"),
        (r"(?i)secret\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}", "secret"),
        (r"(?i)password\s*[:=]\s*['\"][^'\"]{6,}", "password"),
        (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private key"),
        (r"ghp_[A-Za-z0-9]{30,}", "GitHub token"),
        (r"AKIA[0-9A-Z]{16}", "AWS key"),
        (r"sk-[A-Za-z0-9]{32,}", "API token"),
    ]

    def test_no_credentials_anywhere_in_the_tree(self):
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in self.SKIP_DIRS]
            for filename in filenames:
                path = os.path.join(dirpath, filename)
                if os.path.getsize(path) > 2_000_000:
                    continue
                try:
                    with open(path, encoding="utf-8", errors="ignore") as fh:
                        text = fh.read()
                except OSError:
                    continue
                for pattern, label in self.PATTERNS:
                    # This test file necessarily contains the patterns themselves.
                    if path == os.path.abspath(__file__):
                        continue
                    with self.subTest(path=os.path.relpath(path, ROOT), label=label):
                        self.assertIsNone(re.search(pattern, text),
                                          f"possible {label} in {path}")

    def test_no_personal_files_are_committed(self):
        """Sample media could carry personal data; fixtures are generated instead."""
        risky = {".heic", ".jpg", ".jpeg", ".png", ".pdf", ".docx", ".pages", ".key"}
        found = []
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in self.SKIP_DIRS]
            for filename in filenames:
                if os.path.splitext(filename)[1].lower() in risky:
                    found.append(os.path.relpath(os.path.join(dirpath, filename), ROOT))
        self.assertEqual(found, [], f"binary sample files found: {found}")


if __name__ == "__main__":
    unittest.main()
