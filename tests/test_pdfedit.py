"""PDF reading, page extraction and joining."""

import unittest
import zlib

from convertly import pdfedit

from .helpers import make_modern_pdf, make_pdf, page_texts

FIVE = ("Page one", "Page two", "Page three", "Page four", "Page five")


class PageRanges(unittest.TestCase):
    def test_accepted_forms(self):
        cases = {
            "": [1, 2, 3, 4, 5],
            "all": [1, 2, 3, 4, 5],
            "3": [3],
            "2-4": [2, 3, 4],
            "1,3,5": [1, 3, 5],
            "2-": [2, 3, 4, 5],
            "-3": [1, 2, 3],
            "1 3": [1, 3],
            "3-1": [3, 2, 1],          # reversed on purpose
            "1-2,4-5": [1, 2, 4, 5],
        }
        for spec, expected in cases.items():
            with self.subTest(spec=spec):
                self.assertEqual(pdfedit.parse_ranges(spec, 5), expected)

    def test_rejected_forms(self):
        for spec in ("0", "6", "2-9", "abc", "1-2-3", "-0"):
            with self.subTest(spec=spec):
                with self.assertRaises(pdfedit.PdfError):
                    pdfedit.parse_ranges(spec, 5)

    def test_error_messages_name_the_limit(self):
        with self.assertRaises(pdfedit.PdfError) as caught:
            pdfedit.parse_ranges("9", 5)
        self.assertIn("5 pages", str(caught.exception))


class Extraction(unittest.TestCase):
    def setUp(self):
        self.pdf = make_pdf(FIVE)

    def test_page_count(self):
        self.assertEqual(pdfedit.page_count(self.pdf), 5)

    def test_extracts_exactly_the_requested_pages(self):
        out = pdfedit.build([(self.pdf, "2-4")])
        self.assertEqual(page_texts(out), ["Page two", "Page three", "Page four"])

    def test_keeps_requested_order(self):
        out = pdfedit.build([(self.pdf, "3-1")])
        self.assertEqual(page_texts(out), ["Page three", "Page two", "Page one"])

    def test_single_page(self):
        out = pdfedit.build([(self.pdf, "5")])
        self.assertEqual(page_texts(out), ["Page five"])

    def test_discontiguous_selection(self):
        out = pdfedit.build([(self.pdf, "1,3,5")])
        self.assertEqual(page_texts(out), ["Page one", "Page three", "Page five"])

    def test_blank_spec_keeps_everything(self):
        out = pdfedit.build([(self.pdf, "")])
        self.assertEqual(page_texts(out), list(FIVE))

    def test_output_is_a_readable_pdf(self):
        out = pdfedit.build([(self.pdf, "2-3")])
        self.assertTrue(out.startswith(b"%PDF"))
        self.assertIn(b"%%EOF", out)
        self.assertEqual(pdfedit.page_count(out), 2)

    def test_repeated_extraction_is_stable(self):
        once = pdfedit.build([(self.pdf, "2-4")])
        twice = pdfedit.build([(once, "")])
        self.assertEqual(page_texts(twice), ["Page two", "Page three", "Page four"])


class Combining(unittest.TestCase):
    def test_joins_in_the_given_order(self):
        a = make_pdf(("A1", "A2"))
        b = make_pdf(("B1",))
        out = pdfedit.build([(a, ""), (b, "")])
        self.assertEqual(page_texts(out), ["A1", "A2", "B1"])

    def test_order_of_arguments_decides_order_of_pages(self):
        a, b = make_pdf(("A1",)), make_pdf(("B1",))
        self.assertEqual(page_texts(pdfedit.build([(b, ""), (a, "")])), ["B1", "A1"])

    def test_ranges_apply_per_document(self):
        a = make_pdf(("A1", "A2", "A3"))
        b = make_pdf(("B1", "B2", "B3"))
        out = pdfedit.build([(a, "2"), (b, "3,1")])
        self.assertEqual(page_texts(out), ["A2", "B3", "B1"])

    def test_same_document_twice(self):
        a = make_pdf(("A1", "A2"))
        self.assertEqual(page_texts(pdfedit.build([(a, "2"), (a, "1")])), ["A2", "A1"])


class ModernPdfs(unittest.TestCase):
    """PDF 1.5 files: object streams and cross-reference streams."""

    def test_reads_xref_streams_and_object_streams(self):
        pdf = make_modern_pdf(("M1", "M2", "M3"))
        self.assertEqual(pdfedit.page_count(pdf), 3)
        self.assertEqual(page_texts(pdf), ["M1", "M2", "M3"])

    def test_extraction_from_a_modern_pdf(self):
        pdf = make_modern_pdf(("M1", "M2", "M3", "M4"))
        out = pdfedit.build([(pdf, "2-3")])
        self.assertEqual(page_texts(out), ["M2", "M3"])

    def test_mixing_old_and_new_in_one_output(self):
        out = pdfedit.build([(make_modern_pdf(("M1",)), ""), (make_pdf(("C1",)), "")])
        self.assertEqual(page_texts(out), ["M1", "C1"])


class DamagedInput(unittest.TestCase):
    """Recovery: a broken table must not mean a lost document."""

    def setUp(self):
        self.pdf = make_pdf(FIVE)

    def test_rejects_non_pdf(self):
        for junk in (b"", b"hello world", b"%PNG\r\n\x1a\n"):
            with self.subTest(junk=junk[:8]):
                with self.assertRaises(pdfedit.PdfError):
                    pdfedit.page_count(junk)

    def test_recovers_from_a_bad_startxref(self):
        broken = self.pdf.replace(b"startxref", b"startxref\n99999999 %", 1)
        self.assertEqual(pdfedit.page_count(broken), 5)

    def test_recovers_when_every_offset_is_wrong(self):
        shifted = b"\n\n\n\n" + self.pdf          # shifts all recorded offsets
        self.assertEqual(page_texts(pdfedit.build([(shifted, "2")])), ["Page two"])

    def test_recovers_from_a_corrupt_xref_keyword(self):
        broken = self.pdf.replace(b"\nxref", b"\nxrEf", 1)
        self.assertEqual(pdfedit.page_count(broken), 5)

    def test_refuses_encrypted_documents(self):
        encrypted = self.pdf.replace(b"/Root", b"/Encrypt 99 0 R /Root", 1)
        with self.assertRaises(pdfedit.PdfError) as caught:
            pdfedit.page_count(encrypted)
        self.assertIn("password", str(caught.exception).lower())


class ResourceLimits(unittest.TestCase):
    def test_decompression_bomb_is_refused(self):
        bomb = zlib.compress(b"\x00" * (128 * 1024 * 1024), 9)
        stream = pdfedit.Stream({"Filter": pdfedit.Name("FlateDecode")}, bomb)
        with self.assertRaises(pdfedit.PdfError):
            pdfedit.decode_stream(stream)

    def test_ordinary_streams_still_decode(self):
        stream = pdfedit.Stream({"Filter": pdfedit.Name("FlateDecode")},
                                zlib.compress(b"content" * 100))
        self.assertEqual(pdfedit.decode_stream(stream), b"content" * 100)

    def test_deeply_nested_objects_terminate(self):
        # A page whose resources nest far deeper than any real document.
        nested = "<< /A " * 200 + ">>" * 200
        pdf = make_pdf(("One",)).replace(b"/MediaBox", nested.encode() + b" /MediaBox", 1)
        try:
            pdfedit.build([(pdf, "")])
        except pdfedit.PdfError:
            pass                                   # refusing is fine; hanging is not


class RemovingPages(unittest.TestCase):
    """The inverse of extraction: say what goes, keep the rest."""

    def test_inverts_a_selection(self):
        self.assertEqual(pdfedit.invert_ranges("2-4", 10), [1, 5, 6, 7, 8, 9, 10])
        self.assertEqual(pdfedit.invert_ranges("1", 3), [2, 3])
        self.assertEqual(pdfedit.invert_ranges("1,3", 4), [2, 4])

    def test_blank_removes_nothing(self):
        """Opposite reason to parse_ranges, same answer: nothing was asked for."""
        self.assertEqual(pdfedit.invert_ranges("", 3), [1, 2, 3])
        self.assertEqual(pdfedit.invert_ranges("   ", 3), [1, 2, 3])

    def test_refuses_to_leave_nothing(self):
        with self.assertRaises(pdfedit.PdfError) as caught:
            pdfedit.invert_ranges("1-3", 3)
        self.assertIn("every page", str(caught.exception))

    def test_a_bad_range_is_still_a_bad_range(self):
        for spec in ("9", "0", "two"):
            with self.subTest(spec=spec), self.assertRaises(pdfedit.PdfError):
                pdfedit.invert_ranges(spec, 3)

    def test_build_without_keeps_the_rest_in_order(self):
        made = pdfedit.build_without([(make_pdf(FIVE), "2-3")])
        self.assertEqual(page_texts(made), ["Page one", "Page four", "Page five"])

    def test_build_without_handles_a_modern_pdf(self):
        made = pdfedit.build_without([(make_modern_pdf(("A", "B", "C")), "2")])
        self.assertEqual(pdfedit.page_count(made), 2)

    def test_removing_nothing_produces_the_whole_document(self):
        made = pdfedit.build_without([(make_pdf(FIVE), "")])
        self.assertEqual(page_texts(made), list(FIVE))


class Serialisation(unittest.TestCase):
    def test_names_with_specials_are_escaped(self):
        self.assertEqual(pdfedit.serialize(pdfedit.Name("A B")), b"/A#20B")

    def test_strings_are_escaped(self):
        self.assertEqual(pdfedit.serialize(pdfedit.PdfStr(b"a(b)c")), b"(a\\(b\\)c)")

    def test_references_and_numbers(self):
        self.assertEqual(pdfedit.serialize(pdfedit.Ref(7, 0)), b"7 0 R")
        self.assertEqual(pdfedit.serialize(2.50), b"2.5")
        self.assertEqual(pdfedit.serialize(3), b"3")


if __name__ == "__main__":
    unittest.main()


class ObjectParsing(unittest.TestCase):
    """The lexer, exercised on the shapes real PDFs contain."""

    def parse(self, raw):
        return pdfedit.Lexer(raw).parse()

    def test_numbers(self):
        self.assertEqual(self.parse(b"42"), 42)
        self.assertEqual(self.parse(b"-3.5"), -3.5)
        self.assertEqual(self.parse(b"+7"), 7)
        self.assertEqual(self.parse(b".5"), 0.5)

    def test_names_including_escapes(self):
        self.assertEqual(self.parse(b"/Type"), pdfedit.Name("Type"))
        self.assertEqual(self.parse(b"/A#20B"), pdfedit.Name("A B"))

    def test_strings(self):
        self.assertEqual(self.parse(b"(hello)"), b"hello")
        self.assertEqual(self.parse(rb"(a\(nested\) b)"), b"a(nested) b")
        self.assertEqual(self.parse(rb"(line\nbreak)"), b"line\nbreak")
        self.assertEqual(self.parse(rb"(\101)"), b"A")            # octal escape
        self.assertEqual(self.parse(b"(outer (inner) done)"), b"outer (inner) done")

    def test_hex_strings(self):
        self.assertEqual(self.parse(b"<48656C6C6F>"), b"Hello")
        self.assertEqual(self.parse(b"<48 65>"), b"He")
        self.assertEqual(self.parse(b"<486>"), b"H`")             # odd digit is padded

    def test_arrays_and_dictionaries(self):
        self.assertEqual(self.parse(b"[1 2 3]"), [1, 2, 3])
        self.assertEqual(self.parse(b"<< /A 1 /B (x) >>"), {"A": 1, "B": b"x"})
        self.assertEqual(self.parse(b"[[1] [2]]"), [[1], [2]])

    def test_references_versus_plain_numbers(self):
        self.assertEqual(self.parse(b"12 0 R"), pdfedit.Ref(12, 0))
        self.assertEqual(self.parse(b"[1 2]"), [1, 2])            # not a reference

    def test_booleans_null_and_comments(self):
        self.assertIs(self.parse(b"true"), True)
        self.assertIs(self.parse(b"false"), False)
        self.assertIsNone(self.parse(b"null"))
        self.assertEqual(self.parse(b"% a comment\n99"), 99)

    def test_unreadable_input_raises(self):
        for raw in (b"", b")", b"@@"):
            with self.subTest(raw=raw):
                with self.assertRaises(pdfedit.PdfError):
                    self.parse(raw)


class StreamFilters(unittest.TestCase):
    def decode(self, filter_name, raw, **extra):
        d = {"Filter": pdfedit.Name(filter_name)}
        d.update(extra)
        return pdfedit.decode_stream(pdfedit.Stream(d, raw))

    def test_no_filter_returns_raw_bytes(self):
        self.assertEqual(pdfedit.decode_stream(pdfedit.Stream({}, b"plain")), b"plain")

    def test_ascii_hex(self):
        self.assertEqual(self.decode("ASCIIHexDecode", b"48656C6C6F>"), b"Hello")

    def test_ascii85(self):
        import base64
        self.assertEqual(self.decode("ASCII85Decode", base64.a85encode(b"Hello")), b"Hello")

    def test_flate(self):
        self.assertEqual(self.decode("FlateDecode", zlib.compress(b"data")), b"data")

    def test_filter_chain(self):
        import base64
        raw = base64.a85encode(zlib.compress(b"chained"))
        stream = pdfedit.Stream(
            {"Filter": [pdfedit.Name("ASCII85Decode"), pdfedit.Name("FlateDecode")]}, raw)
        self.assertEqual(pdfedit.decode_stream(stream), b"chained")

    def test_unsupported_filter_is_reported(self):
        with self.assertRaises(pdfedit.PdfError):
            self.decode("JBIG2Decode", b"x")

    def test_corrupt_flate_stream_is_reported(self):
        with self.assertRaises(pdfedit.PdfError):
            self.decode("FlateDecode", b"not compressed at all")


class Predictors(unittest.TestCase):
    def test_no_predictor_passes_through(self):
        self.assertEqual(pdfedit._undo_predictor(b"abc", {}), b"abc")
        self.assertEqual(pdfedit._undo_predictor(b"abc", {"Predictor": 1}), b"abc")

    def test_tiff_predictor_is_left_alone(self):
        self.assertEqual(pdfedit._undo_predictor(b"abc", {"Predictor": 2}), b"abc")

    def test_png_up_predictor(self):
        rows = [bytes([1, 2, 3]), bytes([5, 5, 5])]
        encoded, prev = bytearray(), bytes(3)
        for row in rows:
            encoded += bytes([2]) + bytes((row[i] - prev[i]) & 0xFF for i in range(3))
            prev = row
        decoded = pdfedit._undo_predictor(bytes(encoded),
                                          {"Predictor": 12, "Columns": 3, "Colors": 1})
        self.assertEqual(decoded, b"".join(rows))

    def test_png_sub_and_average_and_paeth_do_not_crash(self):
        for tag in (0, 1, 3, 4):
            with self.subTest(tag=tag):
                data = bytes([tag, 10, 20, 30]) * 2
                out = pdfedit._undo_predictor(data, {"Predictor": 12, "Columns": 3})
                self.assertEqual(len(out), 6)
