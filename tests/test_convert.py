"""Format detection, conversion, thumbnails and the image-to-PDF writer."""

import unittest
from unittest import mock

from convertly import convert as conv

from .helpers import (
    make_docx,
    make_image,
    make_iwork,
    make_pdf,
    requires_quicklook,
    requires_sips,
    temp_dir_count,
)

JPEG_MAGIC = b"\xff\xd8\xff"


def no_word():
    """Word must never be launched by the test suite."""
    return mock.patch.object(conv, "_word_responsive", return_value=False)


class FileKinds(unittest.TestCase):
    def test_classification(self):
        cases = {
            "a.heic": "image", "a.HEIC": "image", "a.png": "image", "a.jpeg": "image",
            "a.tif": "image", "a.webp": "image",
            "a.pdf": "pdf", "a.PDF": "pdf",
            "a.docx": "word", "a.doc": "word", "a.rtf": "word",
            "a.pages": "iwork", "a.key": "iwork", "a.numbers": "iwork",
            "a.zip": None, "a.exe": None, "a": None, "": None, "a.pdf.exe": None,
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(conv.kind(name), expected)

    def test_every_advertised_extension_classifies(self):
        for ext in conv.INPUT_EXTS:
            with self.subTest(ext=ext):
                self.assertIsNotNone(conv.kind(f"x.{ext}"))


class Guards(unittest.TestCase):
    def test_rejects_unknown_output_format(self):
        with self.assertRaises(conv.ConversionError):
            conv.convert(b"data", "a.png", "gif")

    def test_rejects_empty_input(self):
        with self.assertRaises(conv.ConversionError):
            conv.convert(b"", "a.png", "jpg")

    def test_rejects_oversized_input(self):
        with mock.patch.object(conv, "MAX_BYTES", 10):
            with self.assertRaises(conv.ConversionError) as caught:
                conv.convert(b"x" * 11, "a.png", "jpg")
        self.assertIn("larger than", str(caught.exception))

    def test_rejects_unsupported_type(self):
        with self.assertRaises(conv.ConversionError):
            conv.convert(b"data", "a.zip", "jpg")


@requires_sips
class Images(unittest.TestCase):
    def test_heic_to_jpeg(self):
        out, ext, note = conv.convert(make_image("heic"), "p.heic", "jpg")
        self.assertTrue(out.startswith(JPEG_MAGIC))
        self.assertEqual(ext, "jpg")
        self.assertIsNone(note)

    def test_png_and_jpeg_inputs(self):
        for fmt in ("png", "jpeg"):
            with self.subTest(fmt=fmt):
                out, _, _ = conv.convert(make_image(fmt), f"p.{fmt}", "jpg")
                self.assertTrue(out.startswith(JPEG_MAGIC))

    def test_jpeg_extension_differs_only_in_name(self):
        _, ext, _ = conv.convert(make_image("heic"), "p.heic", "jpeg")
        self.assertEqual(ext, "jpeg")

    def test_image_to_pdf(self):
        out, ext, _ = conv.convert(make_image("heic"), "p.heic", "pdf")
        self.assertTrue(out.startswith(b"%PDF"))
        self.assertEqual(ext, "pdf")

    def test_quality_changes_size(self):
        low, _, _ = conv.convert(make_image("heic", 300, 200), "p.heic", "jpg", quality=40)
        high, _, _ = conv.convert(make_image("heic", 300, 200), "p.heic", "jpg", quality=100)
        self.assertLess(len(low), len(high))

    def test_corrupt_image_is_reported(self):
        with self.assertRaises(conv.ConversionError):
            conv.convert(b"not an image at all", "p.heic", "jpg")

    def test_no_temp_directories_are_left_behind(self):
        before = temp_dir_count()
        conv.convert(make_image("heic"), "p.heic", "pdf")
        try:
            conv.convert(b"broken", "p.heic", "jpg")
        except conv.ConversionError:
            pass
        self.assertEqual(temp_dir_count(), before)


class Documents(unittest.TestCase):
    def test_pdf_to_pdf_is_copied_unchanged(self):
        source = make_pdf(("One", "Two"))
        out, ext, note = conv.convert(source, "d.pdf", "pdf")
        self.assertEqual(out, source)
        self.assertEqual(ext, "pdf")
        self.assertIn("unchanged", note)

    @requires_quicklook
    @requires_sips
    def test_pdf_to_image_warns_about_extra_pages(self):
        out, _, note = conv.convert(make_pdf(("One", "Two", "Three")), "d.pdf", "jpg")
        self.assertTrue(out.startswith(JPEG_MAGIC))
        self.assertIn("First page only", note)
        self.assertIn("3 pages", note)

    @requires_quicklook
    @requires_sips
    def test_single_page_pdf_needs_no_warning(self):
        _, _, note = conv.convert(make_pdf(("Only",)), "d.pdf", "jpg")
        self.assertIsNone(note)

    @requires_quicklook
    @requires_sips
    def test_word_without_word_running_falls_back_and_says_so(self):
        with no_word():
            out, ext, note = conv.convert(make_docx(), "d.docx", "pdf")
        self.assertTrue(out.startswith(b"%PDF"))
        self.assertIn("First page only", note)

    def test_word_conversion_never_launches_word_by_default(self):
        self.assertFalse(conv.USE_WORD, "Word must be opt-in")

    @requires_sips
    def test_iwork_uses_the_embedded_preview(self):
        with no_word():
            out, ext, note = conv.convert(make_iwork(make_pdf(("Slide",))), "d.pages", "pdf")
        self.assertTrue(out.startswith(b"%PDF"))
        self.assertIn("preview", note.lower())

    def test_iwork_without_a_preview_is_reported_clearly(self):
        import io
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("Index/Document.iwa", b"x")
        with self.assertRaises(conv.ConversionError) as caught:
            conv.convert(buf.getvalue(), "d.pages", "pdf")
        self.assertIn("Pages", str(caught.exception))


class ImagePdfWriter(unittest.TestCase):
    @requires_sips
    def test_wraps_a_jpeg_without_recompressing_it(self):
        jpeg, _, _ = conv.convert(make_image("heic"), "p.heic", "jpg")
        pdf = conv.jpeg_to_pdf(jpeg)
        self.assertIn(jpeg, pdf, "the original JPEG bytes should be embedded as-is")
        self.assertIn(b"/DCTDecode", pdf)

    @requires_sips
    def test_page_follows_image_orientation(self):
        wide, _, _ = conv.convert(make_image("heic", 200, 100), "p.heic", "jpg")
        tall, _, _ = conv.convert(make_image("heic", 100, 200), "p.heic", "jpg")
        self.assertIn(b"[0 0 792.00 612.00]", conv.jpeg_to_pdf(wide))   # landscape
        self.assertIn(b"[0 0 612.00 792.00]", conv.jpeg_to_pdf(tall))   # portrait

    def test_rejects_data_that_is_not_a_jpeg(self):
        with self.assertRaises(conv.ConversionError):
            conv.jpeg_to_pdf(b"definitely not a jpeg")


@requires_sips
class Thumbnails(unittest.TestCase):
    def test_image_thumbnail(self):
        thumb = conv.thumbnail(make_image("heic"), "p.heic")
        self.assertTrue(thumb.startswith(JPEG_MAGIC))

    @requires_quicklook
    def test_pdf_thumbnail(self):
        self.assertTrue(conv.thumbnail(make_pdf(("One",)), "d.pdf").startswith(JPEG_MAGIC))

    def test_iwork_thumbnail_uses_embedded_preview(self):
        self.assertTrue(conv.thumbnail(make_iwork(), "d.pages").startswith(JPEG_MAGIC))

    def test_unsupported_and_broken_input_returns_none(self):
        self.assertIsNone(conv.thumbnail(b"data", "a.zip"))
        self.assertIsNone(conv.thumbnail(b"", "a.png"))
        self.assertIsNone(conv.thumbnail(b"broken", "a.heic"))


if __name__ == "__main__":
    unittest.main()
