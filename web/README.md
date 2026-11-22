# Convertly in the browser

Live at **<https://techbydisha.github.io/convertly/>**, published from this
directory by [`pages.yml`](../.github/workflows/pages.yml) on every change.

The hosted build. Same product as the macOS app, running entirely inside the
page: files are read by JavaScript on the device and never sent anywhere,
because there is no server behind it — GitHub Pages serves static files only.

## Status

**Pictures work.** HEIC, PNG, JPEG, GIF, BMP and WebP convert to JPG, JPEG,
PNG or PDF; resizing and fitting under a size limit work; Pages, Keynote and
Numbers convert to PDF from the preview stored inside them.

PNG output keeps every pixel, so the quality slider shows `n/a` and
transparency survives — converting the same file to JPG flattens it onto white
instead. A size limit still applies, but with nothing to trade away the only
way under it is a smaller picture, which the row reports.

**PDFs work.** Merging documents in an order you choose, removing pages from
one, and compressing one by re-encoding the photographs inside it. The engine
is a port of `pdfedit.py`, and its output is checked byte-for-byte against the
original.

**PDF → image works**, drawn by pdf.js: the first page, as on the Mac, with
a note saying how many pages the PDF has. Every page appears in the review
pane, so a PDF can be checked by looking at it.

**Not yet:** TIFF. Word documents are not coming — Quick Look has no browser
equivalent.

## How your files stay yours

The page cannot open a network connection. That is not a promise in a README,
it is `connect-src 'none'` in the Content Security Policy, and the browser
enforces it: `fetch`, `XMLHttpRequest`, `WebSocket` and `navigator.sendBeacon`
are all refused. A bug, a careless change or a hostile dependency cannot send a
picture anywhere, because the capability is not there to misuse.

That is only possible because the HEIC decoder's WebAssembly is inlined into
its module rather than fetched at runtime. It costs about half a megabyte more
to download and buys an absolute guarantee instead of a careful promise.

**Workers need care, and get it.** A policy set in a `<meta>` tag covers the
page, but a worker loaded from its own URL takes its policy from *its own*
response headers — and GitHub Pages sends none. Such a worker can `fetch`
freely while the page cannot; this was measured, not assumed. So no code here
calls `new Worker(url)` directly. `js/worker.js` starts each one from a
`blob:` URL whose only line imports the real module, and a `blob:` worker
inherits the policy of the page that made it. The HEIC decoder and pdf.js both
run that way, and CI fails any other `new Worker`.

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

## One interface, two engines

The macOS app serves **this directory** — the same `index.html`, the same
`css/` and `js/` — so there is one interface to change, not two. What differs
is who does the work:

- `js/backend-local.js` does it in the page (this build).
- `js/backend-server.js` posts it to the Mac's local server, which has `sips`,
  Quick Look and Word to call on.

`ui.js` loads one or the other. The Mac's server marks its copy of the page
with `<meta name="convertly-backend" content="server">`, and swaps this page's
`<meta>` policy for its own header (the same rules, except `connect-src
'self'`, so the page can reach that server and nothing else).

The flow is the same on both: drop files, pick settings, press the green
button, then **review** the result in the side panel — every page of a PDF,
original beside result for a picture — and only then download.

## How it differs from the macOS app

| | macOS app | Browser build |
| --- | --- | --- |
| Images | `sips` | the browser's own decoder, or libheif (WebAssembly) for HEIC |
| iWork files | the preview inside the document | the same, read with `DecompressionStream` |
| PDF → image | Quick Look, first page | pdf.js, first page |
| Page thumbnails and review | pdf.js in the page | pdf.js |
| PDF pages / joining | `pdfedit.py` | the same engine, ported — byte-identical output |
| Decompression | `zlib` | `js/inflate.js`, because the browser's is asynchronous |
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
│   ├── ui.js           the interface, shared with the macOS app
│   ├── backend-local.js   the work done in the page
│   ├── backend-server.js  the work posted to the Mac's server
│   ├── render.js       PDF pages as pictures, via pdf.js
│   ├── worker.js       the one way to start a worker (see above)
│   ├── convert.js      one file in, one file out -- mirrors convert()
│   ├── decode.js       pixels, natively or via the worker
│   ├── heif-worker.js  libheif, off the main thread
│   ├── fit.js          resize and the fit-to-size search
│   ├── pdfwrite.js     a JPEG wrapped in a one-page PDF
│   ├── unzip.js        just enough ZIP to read an iWork preview
│   ├── pdfedit.js      reading and rewriting PDFs -- a port of pdfedit.py
│   ├── inflate.js      synchronous DEFLATE, which the browser does not offer
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

`http.server` lets the browser cache modules, so after editing a file a reload
can run the old one against new markup. Use a hard reload, or the
`browser build (no cache)` entry in `.claude/launch.json`, which sends
`Cache-Control: no-store`.

## Deploying

`pages.yml` publishes a copy of this directory, not the directory itself: in
the copy, `.github/scripts/stamp_version.py` adds `?v=<commit>` to every
script and stylesheet reference. GitHub Pages caches each file for about ten
minutes on its own, so without that a visitor just after a deploy could get
the new `index.html` with an old `ui.js`, and a broken page. The source keeps
plain names, which is what the Mac app serves.

## Tests

```bash
node --test web/tests/*.test.mjs
```

No dependencies — Node's own test runner. `spec.test.mjs` reads the same JSON
the Python suite does. `pdfwrite.test.mjs` and `pdfedit.test.mjs` hand every
case to the Python implementation as well and demand byte-identical output, so
neither port can drift. `inflate.test.mjs` checks the decompressor against
Python's `zlib` across every level and strategy, and a thousand random
round-trips.
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

- Vendored into `vendor/` (libheif, pdf.js), committed, and served from this origin. No CDNs, no
  `npm install` at build time, no runtime downloads from anyone else.
- Each library recorded in [`vendor/README.md`](vendor/README.md) with its
  version, licence and where it came from, and its hash checked in CI.
- No bundler, no framework, no build step. The page should stay readable as
  source, the way the macOS app's UI is.
