# Vendored libraries

Third-party code committed here and served from this origin. Nothing is fetched
from a CDN at runtime: a CDN is a third party who can see every visitor, and
this project exists to avoid exactly that.

Each entry records what it is, why it's needed, and where it came from, so the
set can be audited and updated deliberately.

| Library | Version | Licence | Why | Source |
| --- | --- | --- | --- | --- |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | 1.23.5 | LGPL-3.0 | Decoding HEIC, which no browser does except Safari | `libheif-wasm/libheif-bundle.mjs` from the npm package, unmodified |

## libheif

**Why the bundled build.** The package offers a small loader plus a separate
1.5 MB `.wasm` file, or one 2.0 MB module with the WebAssembly inlined. The
inlined one is used, although it is larger, because fetching the `.wasm` at
runtime would mean allowing `connect-src 'self'` — and the page's whole
guarantee is `connect-src 'none'`. Half a megabyte is a fair price for the
difference between "does not upload anything" and "cannot upload anything".

It is loaded only when a HEIC file is actually opened, and in a worker, so it
costs nothing until it is needed and never blocks the page when it is.

**Licence.** libheif is LGPL-3.0 and this project is MIT. The two coexist here
the way the LGPL intends: the library is included as a separate, unmodified
file, loaded dynamically, and not built into anything. `LICENSE` is the
package's copy of the LGPL and `LICENSE.libheif` is upstream libheif's own
notice, which also covers the MIT-licensed sample code and wrappers. If the
library is ever patched rather than used as shipped, read the LGPL's terms on
modified versions before publishing.

**Integrity.** `web-tests.yml` checks the file's SHA-256 on every change. A
decoder that has been swapped or tampered with is the one dependency that could
quietly break the privacy promise, so it is pinned rather than trusted.

```
095194187be00d3e36335b8ad7f5552d70655e5e2159486d7d36cd4daa47bba9  libheif/libheif-bundle.mjs
```

## Expected additions

- **pdf.js** — rendering PDF pages to images. Replaces Quick Look, and renders
  every page rather than only the first.
- **UTIF.js** — TIFF decoding, which no browser does natively.

## Adding one

1. Download a released build; do not point at a CDN.
2. Prefer a build that inlines its WebAssembly. One that fetches a `.wasm` at
   runtime cannot be used without loosening `connect-src`, which is not a
   trade this project makes.
3. Commit the file under `vendor/` and add a row above.
4. Record its SHA-256 and add the check to `.github/workflows/web-tests.yml`.
5. Note the licence. Several of these are LGPL, which has obligations when
   redistributed — check before shipping.
6. Keep `.gitignore`'s `!web/vendor/**` exception in mind: files here are
   deliberately exempt from the rule that blocks stray binaries.
