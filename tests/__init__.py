"""Test suite for Convertly.

Puts src/ on the import path so the tests run straight from a checkout with
`python3 -m unittest discover -s tests -t .` and no installation step.
"""

import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC = os.path.join(_ROOT, "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)
