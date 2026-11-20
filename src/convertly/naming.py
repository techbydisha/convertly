"""What Convertly calls the files it produces.

The browser build has to produce identical names to the local app, so these
rules are pinned by shared/spec/output-names.json and tested against both.

The filename arrives from the page in a header and is entirely untrusted, so
every path separator, control character and leading dot is stripped before the
name is handed back.
"""

import os
import re

COMBINED_NAME = "combined.pdf"
FALLBACK_STEM = "file"


def stem_of(filename: str) -> str:
    """The usable part of a filename: no directories, no extension, no tricks."""
    # Split on both separators: a Windows-style path is still just a name here.
    name = re.split(r"[\\/]", filename or "")[-1]
    stem = os.path.splitext(name)[0]
    stem = re.sub(r"[\x00-\x1f\x7f]", "", stem)      # control characters
    stem = stem.strip().strip(".").strip()           # leading/trailing dots
    return stem or FALLBACK_STEM


def converted_name(filename: str, ext: str) -> str:
    """The name of a converted file: `photo.heic` + `jpg` -> `photo.jpg`."""
    return f"{stem_of(filename)}.{ext}"


def extract_name(filename: str, spec: str) -> str:
    """The name of pages pulled out of a PDF.

    `Annual Report.pdf` with `2-4` becomes `Annual Report-pages-2-4.pdf`;
    an empty range means the whole document, so it is a copy.
    """
    stem = stem_of(filename)
    spec = (spec or "").strip()
    if not spec:
        return f"{stem}-copy.pdf"
    # Kept out of the f-string: a backslash inside an f-string expression is a
    # syntax error before Python 3.12, and this project supports 3.10.
    tidy = re.sub(r"[,\s]+", "_", spec)
    return f"{stem}-pages-{tidy}.pdf"
