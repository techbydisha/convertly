# Convertly in the browser

The hosted build. Same product as the macOS app, running entirely inside the
page: files are read by JavaScript on the device and never sent anywhere,
because there is no server behind it — GitHub Pages serves static files only.

## Status

**Pictures work.** HEIC, PNG, JPEG, GIF, BMP and WebP convert to JPG, JPEG or
PDF; resizing and fitting under a size limit work; Pages, Keynote and Numbers
convert to PDF from the preview stored inside them.

**Not yet:** editing PDFs, turning a PDF into images, and TIFF. Word documents
are not coming — Quick Look has no browser equivalent.

## How your files stay yours

The page cannot open a network connection. That is not a promise in a README,
it is `connect-src 'none'` in the Content Security Policy, and the browser
enforces it: `fetch`, `XMLHttpRequest`, `WebSocket` and `navigator.sendBeacon`
are all refused. A bug, a careless change or a hostile dependency cannot send a
picture anywhere, because the capability is not there to misuse.

That is only possible because the HEIC decoder's WebAssembly is inlined into
its module rather than fetched at runtime. It costs about half a megabyte more
to download and buys an absolute guarantee instead of a careful promise.

Three other things follow from the same idea:

- **No `'unsafe-inline'` for scripts.** All the page's code is in `js/` and
  `css/`, so nothing inline has to be trusted.
- **No framing.** A framed copy can be dressed up to look like it belongs to
  someone else's site. CSP's `frame-ancestors` would say so, but browsers
  honour it only as an HTTP header and GitHub Pages cannot send one — so
  `js/app.js` refuses to load the interface inside a frame.
- **No referrer.** Following the link out of the page tells the other site
  nothing about where you came from.

The deploy workflow re-checks all of this and refuses to publish if any of it
has been weakened.

## How it differs from the macOS app

| | macOS app | Browser build |
| --- | --- | --- |
| Images | `sips` | the browser's own decoder, or libheif (WebAssembly) for HEIC |
| iWork files | the preview inside the document | the same, read with `DecompressionStream` |
| PDF → image | Quick Look, first page only | not yet — will be pdf.js, **every** page |
| PDF pages / joining | `pdfedit.py` | not yet — the same logic in JavaScript |
| Word documents | Quick Look | **not supported** — no browser equivalent |
| Reach | one Mac | any device with a browser |

HEIC is tried natively first and only then handed to libheif. Safari on Apple
devices decodes HEIC itself, using the same system codec `sips` uses — so on
the hardware these photos come from, the fast path is also the best one.

## Behaviour is pinned, not reimplemented by eye

Both builds must behave identically — `2-4` selects the same pages, a converted
file gets the same name, a size renders the same way. The cases live in
[`../shared/spec/`](../shared/spec/) and both suites run against them. Read that
directory before changing anything user-visible.

## Layout

```
web/
├── index.html          the page: markup and the Content Security Policy
├── css/app.css         the look, shared with the macOS app's interface
├── js/
│   ├── app.js          entry point; refuses to run inside a frame
│   ├── ui.js           the interface
│   ├── convert.js      one file in, one file out -- mirrors convert()
│   ├── decode.js       pixels, natively or via the worker
│   ├── heif-worker.js  libheif, off the main thread
│   ├── fit.js          resize and the fit-to-size search
│   ├── pdfwrite.js     a JPEG wrapped in a one-page PDF
│   ├── unzip.js        just enough ZIP to read an iWork preview
│   ├── naming.js       what produced files are called
│   ├── sizes.js        how sizes are shown and read
│   └── kinds.js        which files are accepted, and as what
├── tests/              the spec suite, run by node --test
└── vendor/             third-party code, committed and served from here
```

## Running it locally

It is static, so anything that serves a directory works:

```bash
python3 -m http.server -d web 8000
```

Then open `http://localhost:8000`. Opening `index.html` as a file will not
work: ES modules and workers need a real origin. Note that the CSP is stricter
than the local app's, so a mistake that reaches for the network fails loudly.

## Tests

```bash
node --test web/tests/*.test.mjs
```

No dependencies — Node's own test runner. `spec.test.mjs` reads the same JSON
the Python suite does; `pdfwrite.test.mjs` hands every case to the Python
writer as well and demands byte-identical output, so the port cannot drift.
Install nothing, but do have `python3` on the path or that comparison skips.

Everything tested there is pure logic. The canvas and WebAssembly half needs a
real browser and is checked by hand.

**If you benchmark the fit-to-size search, measure in a real browser.** In an
automated one, `canvas.toBlob`'s callback can carry a large fixed latency —
about a second per call regardless of image size, in the one used to develop
this — which makes the search look a hundred times slower than it is. The
encoder itself took 11 ms for a 1600×1200 JPEG there; `toDataURL` encodes
synchronously and is a good way to measure the real cost.

## Dependencies

The macOS app has none, and that is enforced in CI. This build cannot make the
same promise — decoding HEIC in a browser needs a WebAssembly library. The rule
here is narrower:

- Vendored into `vendor/`, committed, and served from this origin. No CDNs, no
  `npm install` at build time, no runtime downloads from anyone else.
- Each library recorded in [`vendor/README.md`](vendor/README.md) with its
  version, licence and where it came from, and its hash checked in CI.
- No bundler, no framework, no build step. The page should stay readable as
  source, the way the macOS app's UI is.
