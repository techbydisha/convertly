# Vendored libraries

Third-party code committed here and served from this origin. Nothing is fetched
from a CDN at runtime: a CDN is a third party who can see every visitor, and
this project exists to avoid exactly that.

Each entry records what it is, why it's needed, and where it came from, so the
set can be audited and updated deliberately.

| Library | Version | Licence | Why | Source |
| --- | --- | --- | --- | --- |
| _(none yet)_ | | | | |

## Expected additions

- **libheif** (WebAssembly) — HEIC/HEIF decoding. Browsers cannot do this
  natively except Safari, which delegates to the macOS codec. Around 1.5 MB, so
  it should load only when a HEIC file is actually opened.
- **pdf.js** — rendering PDF pages to images. Replaces Quick Look, and renders
  every page rather than only the first.
- **UTIF.js** — TIFF decoding, which no browser does natively.

## Adding one

1. Download a released build; do not point at a CDN.
2. Commit the file under `vendor/` and add a row above.
3. Note the licence. Several of these are LGPL, which has obligations when
   redistributed — check before shipping.
4. Keep `.gitignore`'s `!web/vendor/**` exception in mind: files here are
   deliberately exempt from the rule that blocks stray binaries.
