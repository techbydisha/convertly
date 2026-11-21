"""The contract both front ends must satisfy.

Convertly has two implementations -- the local macOS app in Python and the
browser build in JavaScript -- and they have to behave identically. The cases
live in shared/spec/*.json so that neither side can drift without a test going
red. A JavaScript suite loads the same files.

Adding a case here is how user-visible behaviour is changed: add it, watch both
sides fail, then fix both.
"""

import json
import os
import unittest

from convertly import naming, pdfedit
from convertly.convert import (
    INPUT_EXTS, LOSSLESS_FORMATS, OUTPUT_FORMATS, _human_size, kind)

SPEC_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "shared", "spec")


def load(name):
    with open(os.path.join(SPEC_DIR, name), encoding="utf-8") as fh:
        return json.load(fh)


class SpecFilesThemselves(unittest.TestCase):
    """The spec is only useful if it is present and loadable from both sides."""

    EXPECTED = ["page-ranges.json", "file-sizes.json", "output-names.json", "file-kinds.json"]

    def test_every_spec_file_exists_and_parses(self):
        for name in self.EXPECTED:
            with self.subTest(name=name):
                self.assertTrue(os.path.exists(os.path.join(SPEC_DIR, name)),
                                f"{name} is missing -- the JavaScript side loads it too")
                self.assertIsInstance(load(name), dict)

    def test_every_case_explains_what_it_pins_down(self):
        """Each file carries a description, so the contract is readable."""
        for name in self.EXPECTED:
            with self.subTest(name=name):
                self.assertIn("description", load(name))


class PageRanges(unittest.TestCase):
    def test_valid_ranges_resolve_as_specified(self):
        for case in load("page-ranges.json")["valid"]:
            with self.subTest(spec=case["spec"], total=case["total"]):
                self.assertEqual(
                    pdfedit.parse_ranges(case["spec"], case["total"]),
                    case["pages"],
                    case.get("why", ""))

    def test_invalid_ranges_are_refused_with_a_useful_message(self):
        for case in load("page-ranges.json")["invalid"]:
            with self.subTest(spec=case["spec"], total=case["total"]):
                with self.assertRaises(pdfedit.PdfError) as caught:
                    pdfedit.parse_ranges(case["spec"], case["total"])
                self.assertIn(case["message_contains"].lower(),
                              str(caught.exception).lower(),
                              f"message was: {caught.exception}")


class FileSizes(unittest.TestCase):
    def test_sizes_render_as_specified(self):
        for case in load("file-sizes.json")["cases"]:
            with self.subTest(bytes=case["bytes"]):
                self.assertEqual(_human_size(case["bytes"]), case["text"],
                                 case.get("why", ""))

    def test_rounding_is_half_up_not_bankers(self):
        """Python's round() would say 2 KB for 2500 bytes; JavaScript says 3."""
        self.assertEqual(_human_size(2500), "3 KB")
        self.assertEqual(_human_size(3500), "4 KB")


class OutputNames(unittest.TestCase):
    def test_converted_names(self):
        for case in load("output-names.json")["converted"]:
            with self.subTest(input=case["input"]):
                self.assertEqual(naming.converted_name(case["input"], case["ext"]),
                                 case["name"], case.get("why", ""))

    def test_extracted_names(self):
        for case in load("output-names.json")["extracted"]:
            with self.subTest(input=case["input"], spec=case["spec"]):
                self.assertEqual(naming.extract_name(case["input"], case["spec"]),
                                 case["name"], case.get("why", ""))

    def test_combined_name(self):
        self.assertEqual(naming.COMBINED_NAME, load("output-names.json")["combined_name"])

    def test_fallback_stem(self):
        self.assertEqual(naming.FALLBACK_STEM, load("output-names.json")["fallback_stem"])

    def test_produced_names_are_always_safe(self):
        """Whatever arrives, the result is a plain filename."""
        for case in load("output-names.json")["converted"]:
            name = naming.converted_name(case["input"], case["ext"])
            with self.subTest(input=case["input"]):
                for forbidden in ("/", "\\", "..", "\x00"):
                    self.assertNotIn(forbidden, name)


class FileKinds(unittest.TestCase):
    def test_extensions_classify_as_specified(self):
        for case in load("file-kinds.json")["cases"]:
            with self.subTest(name=case["name"]):
                self.assertEqual(kind(case["name"]), case["kind"], case.get("why", ""))

    def test_spec_covers_every_accepted_extension(self):
        """A new input format must be added to the spec, so the web build sees it."""
        covered = {os.path.splitext(c["name"])[1].lstrip(".").lower()
                   for c in load("file-kinds.json")["cases"] if c["kind"]}
        self.assertEqual(set(INPUT_EXTS) - covered, set(),
                         "these accepted extensions are missing from file-kinds.json")

    def test_output_formats_match(self):
        spec = {f["format"]: f["extension"] for f in load("file-kinds.json")["output_formats"]}
        self.assertEqual(spec, OUTPUT_FORMATS)

    def test_removed_page_names_match(self):
        for case in load("output-names.json")["removed"]:
            with self.subTest(input=case["input"], spec=case["spec"]):
                self.assertEqual(naming.removed_name(case["input"], case["spec"]), case["name"])

    def test_lossless_formats_match(self):
        spec = load("file-kinds.json")["lossless_formats"]["formats"]
        self.assertEqual(sorted(spec), sorted(LOSSLESS_FORMATS))

    def test_every_lossless_format_is_a_real_output_format(self):
        for fmt in LOSSLESS_FORMATS:
            self.assertIn(fmt, OUTPUT_FORMATS)

    def test_word_is_marked_as_local_only(self):
        """The browser build cannot render Word files; the spec must say so."""
        support = load("file-kinds.json")["browser_support"]
        self.assertFalse(support["word"])
        self.assertTrue(support["image"] and support["pdf"] and support["iwork"])


if __name__ == "__main__":
    unittest.main()
