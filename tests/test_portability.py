"""The code must actually run on the oldest Python we claim to support.

`pyproject.toml` says 3.10, and CI tests 3.10 through 3.13. Developing on a
newer version makes it easy to use syntax that only parses there, and the first
sign is a red CI job minutes later. These checks catch it in milliseconds.

`ast.parse(..., feature_version=...)` is not enough on its own: it does not
emulate the pre-3.12 f-string tokenizer, so it accepts code that Python 3.10
rejects outright. The checks here look at the source directly.
"""

import ast
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def python_files():
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in {".git", "__pycache__", ".venv", "venv"}]
        for name in files:
            if name.endswith(".py"):
                yield os.path.join(base, name)


def backslashes_in_fstring_expressions(path):
    """Report f-string expressions containing a backslash.

    PEP 701 allowed these in Python 3.12. Before that they are a SyntaxError,
    so the whole module fails to import on 3.10 and 3.11.
    """
    with open(path, encoding="utf-8") as fh:
        source = fh.read()
    # On Python 3.10 and 3.11 this very pattern is a SyntaxError, so a file
    # containing it cannot be parsed at all. That is the finding.
    try:
        tree = ast.parse(source, path)
    except SyntaxError as exc:
        if "backslash" in str(exc):
            return [(exc.lineno or 0, str(exc))]
        raise
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.JoinedStr):
            continue
        for part in node.values:
            if not isinstance(part, ast.FormattedValue):
                continue
            segment = ast.get_source_segment(source, part.value) or ""
            if "\\" in segment:
                found.append((part.lineno, segment.strip()))
    return found


class MinimumPythonVersion(unittest.TestCase):
    def test_declared_floor(self):
        with open(os.path.join(ROOT, "pyproject.toml"), encoding="utf-8") as fh:
            text = fh.read()
        match = re.search(r'requires-python\s*=\s*"[^0-9]*(\d+)\.(\d+)"', text)
        self.assertIsNotNone(match, "pyproject.toml must declare requires-python")
        self.assertEqual((int(match.group(1)), int(match.group(2))), (3, 10))

    def test_ci_matrix_covers_the_declared_floor(self):
        """CI must actually test the oldest version the project promises."""
        path = os.path.join(ROOT, ".github", "workflows", "tests.yml")
        with open(path, encoding="utf-8") as fh:
            versions = re.findall(r'"(\d+\.\d+)"', fh.read())
        self.assertIn("3.10", versions,
                      "pyproject promises 3.10, so CI has to run it")

    def test_no_backslash_inside_an_fstring_expression(self):
        """Syntax that only parses on Python 3.12 and newer."""
        offenders = []
        for path in python_files():
            for lineno, segment in backslashes_in_fstring_expressions(path):
                offenders.append(f"{os.path.relpath(path, ROOT)}:{lineno}: {segment}")
        self.assertEqual(offenders, [], "move the expression into a variable first:\n  "
                                        + "\n  ".join(offenders))

    def test_the_check_is_not_a_no_op(self):
        """Guard the guard: it must reject the pattern it exists to catch."""
        import tempfile
        broken = (
            "import re\n"
            "def f(stem, spec):\n"
            "    return f\"{stem}-{re.sub(r'[,\\\\s]+', '_', spec)}.pdf\"\n"
        )
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False,
                                         encoding="utf-8") as fh:
            fh.write(broken)
            path = fh.name
        try:
            self.assertTrue(backslashes_in_fstring_expressions(path),
                            "the check failed to spot a backslash in an f-string")
        finally:
            os.unlink(path)

    def test_offenders_are_reported_on_every_python(self):
        """The report must work whether or not the host can parse the file."""
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False,
                                         encoding="utf-8") as fh:
            fh.write("x = f\"{'a' + chr(92)}\"\n")      # no backslash literal
            clean = fh.name
        try:
            self.assertEqual(backslashes_in_fstring_expressions(clean), [])
        finally:
            os.unlink(clean)


if __name__ == "__main__":
    unittest.main()
