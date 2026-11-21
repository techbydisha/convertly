"""Format detection, conversion, thumbnails and the image-to-PDF writer."""

import unittest
from unittest import mock

from convertly import convert as conv
from convertly import pdfedit

from .helpers import (
    make_docx,
    make_noisy_image,
    make_image,
    make_iwork,
    make_pdf,
    requires_quicklook,
    requires_sips,
    temp_dir_count,
)

JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


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

    def test_image_to_png(self):
        out, ext, note = conv.convert(make_image("heic"), "p.heic", "png")
        self.assertTrue(out.startswith(PNG_MAGIC))
        self.assertEqual(ext, "png")
        self.assertIsNone(note)

    def test_png_keeps_the_source_dimensions(self):
        out, _, _ = conv.convert(make_image("heic", 300, 200), "p.heic", "png")
        self.assertEqual(conv._png_size(out), (300, 200))

    def test_png_ignores_quality_because_it_is_lossless(self):
        low, _, _ = conv.convert(make_image("heic", 300, 200), "p.heic", "png", quality=40)
        high, _, _ = conv.convert(make_image("heic", 300, 200), "p.heic", "png", quality=100)
        self.assertEqual(low, high, "quality must not change a lossless format")

    def test_png_meets_a_size_limit_by_shrinking(self):
        source = make_noisy_image("png", 1200, 900)
        out, _, note = conv.convert(source, "p.png", "png", target_bytes=120_000)
        self.assertLessEqual(len(out), 120_000)
        width, height = conv._png_size(out)
        self.assertLess(width, 1200, "the only way under the limit is a smaller picture")
        self.assertIn(f"{width}\u00d7{height}", note)

    def test_png_is_never_enlarged(self):
        source = make_image("png", 200, 150)
        out, _, note = conv.convert(source, "p.png", "png", max_px=4000)
        self.assertEqual(conv._png_size(out), (200, 150))
        self.assertIsNone(note, "nothing changed, so nothing should be claimed")

    def test_png_says_so_when_a_limit_cannot_be_met(self):
        source = make_noisy_image("png", 1200, 900)
        out, _, note = conv.convert(source, "p.png", "png", target_bytes=1200)
        self.assertIn("Could not reach the size limit", note)
        self.assertTrue(out.startswith(PNG_MAGIC), "still a usable file, just not small enough")

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


@requires_sips
class Resizing(unittest.TestCase):
    """Capping the longest edge."""

    def dimensions(self, jpeg):
        width, height, _ = conv._jpeg_size(jpeg)
        return width, height

    def test_longest_edge_is_capped(self):
        out, _, _ = conv.convert(make_image("heic", 400, 300), "p.heic", "jpg", max_px=200)
        self.assertEqual(self.dimensions(out), (200, 150))

    def test_aspect_ratio_is_kept_for_tall_images(self):
        out, _, _ = conv.convert(make_image("heic", 300, 400), "p.heic", "jpg", max_px=200)
        self.assertEqual(self.dimensions(out), (150, 200))

    def test_images_are_never_enlarged(self):
        """`sips -Z` would happily upscale; resizing must only ever shrink."""
        source = make_image("heic", 400, 300)
        out, _, note = conv.convert(source, "p.heic", "jpg", max_px=4000)
        self.assertEqual(self.dimensions(out), (400, 300))
        self.assertIsNone(note, "nothing changed, so there is nothing to report")

    def test_resize_is_reported(self):
        _, _, note = conv.convert(make_image("heic", 400, 300), "p.heic", "jpg", max_px=200)
        self.assertIn("200", note)
        self.assertIn("150", note)

    def test_resize_applies_to_pdf_output_too(self):
        out, _, _ = conv.convert(make_image("heic", 400, 300), "p.heic", "pdf", max_px=200)
        self.assertTrue(out.startswith(b"%PDF"))
        self.assertLess(len(out), len(conv.convert(make_image("heic", 400, 300),
                                                   "p.heic", "pdf")[0]))


@requires_sips
class SizeBudget(unittest.TestCase):
    """Squeezing a file under a maximum size -- the upload-limit case."""

    def setUp(self):
        self.photo = make_noisy_image("heic", 500, 400)

    def test_result_fits_the_budget(self):
        for budget in (200_000, 100_000, 50_000, 20_000):
            with self.subTest(budget=budget):
                out, _, note = conv.convert(self.photo, "p.heic", "jpg",
                                            target_bytes=budget)
                self.assertLessEqual(len(out), budget,
                                     f"{len(out)} bytes exceeds the {budget} budget: {note}")

    def test_quality_is_lowered_before_dimensions_are(self):
        """A mild budget should keep full size and just compress harder."""
        full, _, _ = conv.convert(self.photo, "p.heic", "jpg", quality=95)
        budget = int(len(full) * 0.7)
        out, _, note = conv.convert(self.photo, "p.heic", "jpg", quality=95,
                                    target_bytes=budget)
        self.assertLessEqual(len(out), budget)
        self.assertEqual(conv._jpeg_size(out)[:2], conv._jpeg_size(full)[:2])
        self.assertIn("uality", note)

    def test_dimensions_shrink_when_quality_is_not_enough(self):
        out, _, note = conv.convert(self.photo, "p.heic", "jpg", target_bytes=15_000)
        self.assertLessEqual(len(out), 15_000)
        self.assertLess(conv._jpeg_size(out)[0], 500)
        self.assertIn("Resized", note)

    def test_a_file_already_under_the_budget_is_left_alone(self):
        plain, _, _ = conv.convert(make_image("heic", 80, 60), "p.heic", "jpg")
        out, _, note = conv.convert(make_image("heic", 80, 60), "p.heic", "jpg",
                                    target_bytes=5_000_000)
        self.assertEqual(out, plain)
        self.assertIsNone(note)

    def test_impossible_budget_returns_the_smallest_and_says_so(self):
        out, _, note = conv.convert(self.photo, "p.heic", "jpg", target_bytes=1200)
        self.assertTrue(out.startswith(JPEG_MAGIC), "a usable image is still returned")
        self.assertIn("Could not reach", note)

    def test_the_search_is_bounded(self):
        """An impossible budget must not loop forever."""
        import time
        start = time.time()
        conv.convert(self.photo, "p.heic", "jpg", target_bytes=1000)
        self.assertLess(time.time() - start, 30)

    def test_budget_and_resize_together(self):
        out, _, _ = conv.convert(self.photo, "p.heic", "jpg",
                                 max_px=300, target_bytes=20_000)
        self.assertLessEqual(len(out), 20_000)
        self.assertLessEqual(conv._jpeg_size(out)[0], 300)

    def test_pdf_output_respects_the_budget_including_its_wrapper(self):
        budget = 60_000
        out, _, _ = conv.convert(self.photo, "p.heic", "pdf", target_bytes=budget)
        self.assertTrue(out.startswith(b"%PDF"))
        self.assertLessEqual(len(out), budget,
                             "the PDF wrapper must be counted against the budget")

    @requires_quicklook
    def test_budget_applies_to_rendered_documents(self):
        out, _, note = conv.convert(make_pdf(("One", "Two")), "d.pdf", "jpg",
                                    target_bytes=25_000)
        self.assertLessEqual(len(out), 25_000)
        self.assertIn("First page only", note)

    def test_sizes_are_reported_in_decimal_units(self):
        """Finder and upload limits both mean 1 MB = 1,000,000 bytes."""
        self.assertEqual(conv._human_size(1_000_000), "1.0 MB")
        self.assertEqual(conv._human_size(500_000), "500 KB")


@requires_sips
class CompressingPdfs(unittest.TestCase):
    """Making a PDF smaller by re-encoding the photographs inside it."""

    def photo_pdf(self, width=1200, height=900):
        jpeg, _, _ = conv.convert(make_noisy_image("png", width, height),
                                  "p.png", "jpg", quality=95)
        return conv.jpeg_to_pdf(jpeg)

    def test_recompress_jpeg_returns_smaller_bytes_and_new_size(self):
        jpeg, _, _ = conv.convert(make_noisy_image("png", 800, 600), "p.png", "jpg", quality=95)
        made = conv.recompress_jpeg(jpeg, 40, 400)
        self.assertIsNotNone(made)
        data, width, height = made
        self.assertLess(len(data), len(jpeg))
        self.assertEqual(max(width, height), 400)

    def test_recompress_jpeg_never_enlarges(self):
        jpeg, _, _ = conv.convert(make_image("png", 200, 150), "p.png", "jpg", quality=90)
        _, width, height = conv.recompress_jpeg(jpeg, 90, 4000)
        self.assertEqual((width, height), (200, 150))

    def test_meets_a_size_limit(self):
        pdf = self.photo_pdf()
        for target in (400_000, 120_000, 30_000):
            with self.subTest(target=target):
                made, note = conv.fit_pdf(pdf, target_bytes=target, quality=95)
                self.assertLessEqual(len(made), target)
                self.assertIn("re-encoded", note)

    def test_the_result_is_still_a_readable_pdf(self):
        made, _ = conv.fit_pdf(self.photo_pdf(), target_bytes=200_000, quality=95)
        self.assertTrue(made.startswith(b"%PDF"))
        self.assertEqual(pdfedit.page_count(made), 1)

    def test_a_text_pdf_says_there_is_nothing_to_compress(self):
        with self.assertRaises(conv.ConversionError) as caught:
            conv.fit_pdf(make_pdf(("One", "Two")), target_bytes=500)
        self.assertIn("not photographs", str(caught.exception))

    def test_no_target_at_a_quality_that_cannot_shrink_says_so(self):
        """The first attempt failing is not the same as nothing being there."""
        pdf = self.photo_pdf()
        with self.assertRaises(conv.ConversionError) as caught:
            conv.fit_pdf(pdf, quality=100)
        self.assertIn("size limit", str(caught.exception))

    def test_an_impossible_limit_hands_back_the_smallest_it_managed(self):
        made, note = conv.fit_pdf(self.photo_pdf(), target_bytes=900, quality=95)
        self.assertIn("Could not reach", note)
        self.assertTrue(made.startswith(b"%PDF"))

    def test_convert_routes_a_pdf_with_a_target_to_compression(self):
        pdf = self.photo_pdf()
        made, ext, note = conv.convert(pdf, "Scan.pdf", "pdf", quality=95, target_bytes=250_000)
        self.assertEqual(ext, "pdf")
        self.assertLessEqual(len(made), 250_000)
        self.assertIn("re-encoded", note)

    def test_convert_without_a_target_still_copies_unchanged(self):
        pdf = self.photo_pdf()
        made, _, note = conv.convert(pdf, "Scan.pdf", "pdf")
        self.assertEqual(made, pdf)
        self.assertIn("Already a PDF", note)
