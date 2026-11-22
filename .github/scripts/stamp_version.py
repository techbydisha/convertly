"""Give every file the deployed page loads a version in its URL.

GitHub Pages caches each file for about ten minutes, separately. Just after a
deploy a browser can therefore hold the new index.html and an old ui.js --
and the old code, run against the new markup, breaks the page outright. The
cure is to make each deploy's files different URLs: index.html is the only
file fetched by its plain name, and it names the rest with ?v=<commit>.

Run on the copy being uploaded, never on the repository: the source keeps
plain relative names, which is what the macOS app (and anyone reading it)
uses. Vendored files are not edited -- their hashes are pinned -- but the
references *to* them are stamped like any other.

    python3 .github/scripts/stamp_version.py <site-dir> <version>
"""

import pathlib
import re
import sys

# A quoted relative path to a script, written as a string literal: covers
# `import ... from './x.js'`, `import('./x.js')` and `new URL('./x.js', ...)`.
SPECIFIER = re.compile(r"""(["'])(\.{1,2}/[^"'?#\s]+\.m?js)\1""")
# The two files index.html pulls in itself.
ENTRY = re.compile(r"""((?:src|href)=")((?:js|css)/[^"?#]+\.(?:js|css))(")""")


def stamp(site: pathlib.Path, version: str) -> int:
    if not re.fullmatch(r"[0-9A-Za-z]+", version):
        raise SystemExit(f"refusing an odd version string: {version!r}")
    changed = 0

    index = site / "index.html"
    html = index.read_text(encoding="utf-8")
    html, n = ENTRY.subn(lambda m: f"{m[1]}{m[2]}?v={version}{m[3]}", html)
    if n < 2:
        raise SystemExit("index.html no longer names js/app.js and css/app.css")
    index.write_text(html, encoding="utf-8")
    changed += n

    for path in sorted((site / "js").glob("*.js")):
        text = path.read_text(encoding="utf-8")
        text, n = SPECIFIER.subn(lambda m: f"{m[1]}{m[2]}?v={version}{m[1]}", text)
        if n:
            path.write_text(text, encoding="utf-8")
            changed += n
    return changed


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    count = stamp(pathlib.Path(sys.argv[1]), sys.argv[2])
    print(f"stamped {count} references with ?v={sys.argv[2]}")
