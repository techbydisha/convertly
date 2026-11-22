# Vendored libraries

Third-party code committed here and served from this origin. Nothing is fetched
from a CDN at runtime: a CDN is a third party who can see every visitor, and
this project exists to avoid exactly that.

Each entry records what it is, why it's needed, and where it came from, so the
set can be audited and updated deliberately.

| Library | Version | Licence | Why | Source |
| --- | --- | --- | --- | --- |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | 1.23.5 | LGPL-3.0 | Decoding HEIC, which no browser does except Safari | `libheif-wasm/libheif-bundle.mjs` from the npm package, unmodified |
| [pdf.js](https://github.com/mozilla/pdf.js) | 6.5.438 | Apache-2.0 | Drawing PDF pages: thumbnails, the review pane, and PDF → image | `build/pdf.min.mjs` and `build/pdf.worker.min.mjs` from the `pdfjs-dist` npm package, unmodified |

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

## pdf.js

**Why.** A browser can show a PDF but cannot hand a page back as pixels, so
without a renderer the page could neither show you what a merge or an edit
produced nor turn a PDF into a picture. The macOS app needs no such thing —
Quick Look draws pages there — and uses pdf.js only in the page, for the same
thumbnails and the same review pane.

**Nothing is fetched.** pdf.js can download fonts, CMaps, and WebAssembly
decoders for JPEG 2000 and JBIG2. Every one of those options is left unset, so
under `connect-src 'none'` the attempt could not succeed anyway. The cost is
small and visible only in a thumbnail: a PDF that relies on non-embedded Asian
fonts, or on JPEG 2000 images, draws imperfectly. The file itself is never
touched by the renderer — only read.

**Its worker.** pdf.js does its parsing in a worker. That worker is started
through `js/worker.js` like every other, so it runs under the page's policy
(see `web/README.md` for why that matters). It is loaded only when a PDF first
needs a picture.

**No eval.** The page's CSP allows no `'unsafe-eval'`. pdf.js 6 has no
`eval` or `new Function` path in the files used here; the CSP would refuse one
if it appeared.

**Licence.** Apache-2.0; `pdfjs/LICENSE` is the package's copy.

**Integrity.** Pinned in `web-tests.yml` like libheif:

```
3a88402882cfa3e7e72c2c9b5149f52f0f88baf1c5b62aa11a41abdbc2072440  pdfjs/pdf.min.mjs
1e64c8240e54735ec5913b37acd5134747799cb8c6bb3777c70adbc01232d2aa  pdfjs/pdf.worker.min.mjs
```

## Expected additions

- **UTIF.js** — TIFF decoding, which no browser does natively.

## Adding one

1. Download a released build; do not point at a CDN.
2. Prefer a build that inlines its WebAssembly. One that fetches a `.wasm` at
   runtime cannot be used without loosening `connect-src`, which is not a
   trade this project makes.
3. Commit the file under `vendor/` and add a row above.
4. Record its SHA-256 and add the check to `.github/workflows/web-tests.yml`.
   Do not edit a vendored file — the deploy stamps cache-busting versions onto
   the references *to* it, never into it, so the hash stays true.
5. If it starts a worker, make it use a port from `js/worker.js` (pdf.js:
   `GlobalWorkerOptions.workerPort`). CI refuses `new Worker` anywhere else.
6. Note the licence. Several of these are LGPL, which has obligations when
   redistributed — check before shipping.
7. Keep `.gitignore`'s `!web/vendor/**` exception in mind: files here are
   deliberately exempt from the rule that blocks stray binaries.
