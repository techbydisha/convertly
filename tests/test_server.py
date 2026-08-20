"""HTTP routes: what each endpoint returns, and how it fails."""

import json
import struct
import unittest
import urllib.parse
from unittest import mock

from convertly import convert as conv
from convertly import server as srv

from .helpers import (
    LocalServer,
    make_image,
    make_pdf,
    requires_quicklook,
    requires_sips,
    temp_dir_count,
)


def framed(*payloads):
    """The /pdf/build body format: each part prefixed with its length."""
    return b"".join(struct.pack(">I", len(p)) + p for p in payloads)


class ServerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ctx = LocalServer()
        cls.server = cls.ctx.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.ctx.__exit__(None, None, None)

    def get(self, path, **kw):
        return self.server.request("GET", path, **kw)

    def post(self, path, body=b"", **kw):
        return self.server.request("POST", path, body=body, **kw)


class Pages(ServerCase):
    def test_index_is_served(self):
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn(b"<title>Convertly</title>", body)

    def test_health(self):
        self.assertEqual(self.get("/health")[0], 200)

    def test_unknown_paths_are_404(self):
        for path in ("/nope", "/convert", "/static/app.js"):
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 404)

    def test_unknown_post_route_is_404(self):
        self.assertEqual(self.post("/whatever", b"x")[0], 404)


@requires_sips
class ConvertEndpoint(ServerCase):
    def test_converts_and_names_the_result(self):
        status, headers, body = self.post(
            "/convert?format=jpg", make_image("heic"),
            headers={"X-Filename": urllib.parse.quote("My Photo.heic")})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        self.assertEqual(urllib.parse.unquote(headers["X-Out-Name"]), "My Photo.jpg")
        self.assertTrue(body.startswith(b"\xff\xd8\xff"))

    def test_pdf_output(self):
        status, headers, body = self.post(
            "/convert?format=pdf", make_image("heic"),
            headers={"X-Filename": "p.heic"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/pdf")
        self.assertTrue(body.startswith(b"%PDF"))

    @requires_quicklook
    def test_notes_are_passed_back_as_a_header(self):
        status, headers, _ = self.post(
            "/convert?format=jpg", make_pdf(("A", "B", "C")),
            headers={"X-Filename": "d.pdf"})
        self.assertEqual(status, 200)
        self.assertIn("First page only", urllib.parse.unquote(headers["X-Note"]))

    def test_missing_body_is_rejected(self):
        self.assertEqual(self.post("/convert?format=jpg", b"")[0], 400)

    def test_unknown_format_is_rejected(self):
        status, _, body = self.post("/convert?format=tiff", b"x",
                                    headers={"X-Filename": "p.heic"})
        self.assertEqual(status, 400)
        self.assertIn(b"Unsupported", body)

    def test_unreadable_file_gives_422_not_500(self):
        status, _, body = self.post("/convert?format=jpg", b"junk",
                                    headers={"X-Filename": "p.heic"})
        self.assertEqual(status, 422)
        self.assertTrue(body)

    def test_unsupported_type_gives_422(self):
        self.assertEqual(self.post("/convert?format=jpg", b"junk",
                                   headers={"X-Filename": "a.zip"})[0], 422)

    def test_bad_quality_value_falls_back_to_default(self):
        self.assertEqual(self.post("/convert?format=jpg&quality=abc", make_image("heic"),
                                   headers={"X-Filename": "p.heic"})[0], 200)


@requires_sips
class PreviewEndpoint(ServerCase):
    def test_returns_a_jpeg_thumbnail(self):
        status, headers, body = self.post("/preview", make_image("heic"),
                                          headers={"X-Filename": "p.heic"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        self.assertTrue(body.startswith(b"\xff\xd8\xff"))

    def test_no_preview_available_is_204_not_an_error(self):
        self.assertEqual(self.post("/preview", b"junk",
                                   headers={"X-Filename": "a.zip"})[0], 204)
        self.assertEqual(self.post("/preview", b"junk",
                                   headers={"X-Filename": "p.heic"})[0], 204)


class PdfInfoEndpoint(ServerCase):
    def test_reports_page_count(self):
        status, headers, body = self.post("/pdf/info", make_pdf(("A", "B", "C")))
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers["Content-Type"])
        self.assertEqual(json.loads(body)["pages"], 3)

    def test_non_pdf_is_422(self):
        status, _, body = self.post("/pdf/info", b"not a pdf")
        self.assertEqual(status, 422)
        self.assertIn(b"PDF", body)

    def test_empty_body_is_400(self):
        self.assertEqual(self.post("/pdf/info", b"")[0], 400)


class PdfBuildEndpoint(ServerCase):
    def setUp(self):
        self.five = make_pdf(("One", "Two", "Three", "Four", "Five"))

    def build(self, payloads, ranges):
        return self.post(
            "/pdf/build", framed(*payloads),
            headers={"X-Ranges": urllib.parse.quote(json.dumps(ranges))})

    def test_extracts_a_range(self):
        status, headers, body = self.build([self.five], ["2-4"])
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/pdf")
        from convertly import pdfedit
        self.assertEqual(pdfedit.page_count(body), 3)

    def test_combines_several_documents(self):
        status, _, body = self.build([self.five, self.five], ["1", "5"])
        self.assertEqual(status, 200)
        from convertly import pdfedit
        self.assertEqual(pdfedit.page_count(body), 2)

    def test_out_of_range_is_422_with_a_readable_message(self):
        status, _, body = self.build([self.five], ["99"])
        self.assertEqual(status, 422)
        self.assertIn(b"only has 5 pages", body)

    def test_bad_pdf_is_422(self):
        self.assertEqual(self.build([b"junk"], [""])[0], 422)

    def test_missing_ranges_header_defaults_to_all_pages(self):
        status, _, body = self.post("/pdf/build", framed(self.five))
        self.assertEqual(status, 200)
        from convertly import pdfedit
        self.assertEqual(pdfedit.page_count(body), 5)

    def test_malformed_framing_is_rejected(self):
        body = struct.pack(">I", 999999) + b"short"
        self.assertEqual(self.post("/pdf/build", body)[0], 400)

    def test_empty_body_is_rejected(self):
        self.assertEqual(self.post("/pdf/build", b"")[0], 400)


class Housekeeping(ServerCase):
    @requires_sips
    def test_requests_leave_no_temporary_files(self):
        before = temp_dir_count()
        self.post("/convert?format=pdf", make_image("heic"), headers={"X-Filename": "p.heic"})
        self.post("/preview", make_image("heic"), headers={"X-Filename": "p.heic"})
        self.post("/convert?format=jpg", b"junk", headers={"X-Filename": "p.heic"})
        self.assertEqual(temp_dir_count(), before)

    def test_oversized_upload_is_refused_before_conversion(self):
        with mock.patch.object(conv, "MAX_BYTES", 32):
            status, _, _ = self.post("/pdf/info", b"x" * 64)
        self.assertEqual(status, 413)

    def test_one_bad_request_does_not_stop_the_server(self):
        self.post("/convert?format=jpg", b"junk", headers={"X-Filename": "p.heic"})
        self.assertEqual(self.get("/health")[0], 200)


if __name__ == "__main__":
    unittest.main()


class CommandLine(unittest.TestCase):
    def test_defaults(self):
        args = srv.build_parser().parse_args([])
        self.assertEqual(args.port, srv.DEFAULT_PORT)
        self.assertFalse(args.no_browser)
        self.assertFalse(args.use_word)
        self.assertFalse(args.verbose)

    def test_flags(self):
        args = srv.build_parser().parse_args(
            ["--port", "9999", "--no-browser", "--use-word", "--verbose"])
        self.assertEqual(args.port, 9999)
        self.assertTrue(args.no_browser and args.use_word and args.verbose)

    def test_rejects_unknown_flags(self):
        import contextlib
        import io as _io
        with contextlib.redirect_stderr(_io.StringIO()):      # argparse prints usage
            with self.assertRaises(SystemExit):
                srv.build_parser().parse_args(["--upload-to-cloud"])

    def test_free_port_returns_a_usable_port(self):
        port = srv.free_port(0)
        self.assertGreater(port, 0)

    def test_free_port_falls_back_when_preferred_is_taken(self):
        import socket as sk
        with sk.socket() as taken:
            taken.bind(("127.0.0.1", 0))
            busy = taken.getsockname()[1]
            taken.listen(1)
            self.assertNotEqual(srv.free_port(busy), busy)


class ErrorHandling(ServerCase):
    """Unexpected failures must produce a status code, never a crash."""

    def test_missing_index_file_reports_cleanly(self):
        with mock.patch.object(srv, "WEB", "/nonexistent/dir"):
            status, _, body = self.get("/")
        self.assertEqual(status, 500)
        self.assertIn(b"index.html", body)

    def test_unparsable_content_length_is_rejected(self):
        status, _, _ = self.server.request(
            "POST", "/pdf/info", body=b"", headers={"Content-Length": "not-a-number"})
        self.assertEqual(status, 400)

    def test_thumbnail_crash_becomes_no_preview(self):
        with mock.patch.object(srv, "thumbnail", side_effect=RuntimeError("boom")):
            status, _, _ = self.post("/preview", b"data", headers={"X-Filename": "a.png"})
        self.assertEqual(status, 204)

    def test_page_count_crash_becomes_422(self):
        with mock.patch.object(srv.pdfedit, "page_count", side_effect=RuntimeError("boom")):
            status, _, body = self.post("/pdf/info", make_pdf(("A",)))
        self.assertEqual(status, 422)
        self.assertIn(b"could not be read", body)

    def test_pdf_build_crash_becomes_500(self):
        with mock.patch.object(srv.pdfedit, "build", side_effect=RuntimeError("boom")):
            status, _, body = self.post("/pdf/build", framed(make_pdf(("A",))))
        self.assertEqual(status, 500)
        self.assertIn(b"Could not build", body)

    def test_conversion_crash_becomes_500(self):
        with mock.patch.object(srv, "convert", side_effect=RuntimeError("boom")):
            status, _, body = self.post("/convert?format=jpg", b"data",
                                        headers={"X-Filename": "a.png"})
        self.assertEqual(status, 500)
        self.assertIn(b"Conversion failed", body)

    def test_body_too_short_to_frame_is_rejected(self):
        status, _, body = self.post("/pdf/build", b"ab")
        self.assertEqual(status, 400)
        self.assertIn(b"No PDFs sent", body)

    def test_invalid_ranges_header_falls_back_to_all_pages(self):
        status, _, body = self.post("/pdf/build", framed(make_pdf(("A", "B"))),
                                    headers={"X-Ranges": "not-json"})
        self.assertEqual(status, 200)
        from convertly import pdfedit
        self.assertEqual(pdfedit.page_count(body), 2)

    def test_wrong_number_of_ranges_falls_back_to_all_pages(self):
        status, _, body = self.post(
            "/pdf/build", framed(make_pdf(("A", "B")), make_pdf(("C",))),
            headers={"X-Ranges": urllib.parse.quote(json.dumps(["1"]))})
        self.assertEqual(status, 200)
        from convertly import pdfedit
        self.assertEqual(pdfedit.page_count(body), 3)
