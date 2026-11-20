# Convertly in the browser

The hosted build. Same product as the macOS app, running entirely inside the
page: files are read by JavaScript on the device and never sent anywhere,
because there is no server behind it — GitHub Pages serves static files only.

## Status

Skeleton. `index.html` carries the Content Security Policy and the design
tokens; the conversion code is being ported from `src/convertly/`.

## How it differs from the macOS app

| | macOS app | Browser build |
| --- | --- | --- |
| Images | `sips` | libheif (WebAssembly) for HEIC, canvas for the rest |
| PDF → image | Quick Look, first page only | pdf.js, **every** page |
| PDF pages / joining | `pdfedit.py` | the same logic in JavaScript |
| Word documents | Quick Look | **not supported** — no browser equivalent |
| Reach | one Mac | any device with a browser |

## Behaviour is pinned, not reimplemented by eye

Both builds must behave identically — `2-4` selects the same pages, a converted
file gets the same name, a size renders the same way. The cases live in
[`../shared/spec/`](../shared/spec/) and both suites run against them. Read that
directory before changing anything user-visible.

## Dependencies

The macOS app has none, and that is enforced in CI. This build cannot make the
same promise — decoding HEIC in a browser needs a WebAssembly library. The rule
here is narrower:

- Vendored into `vendor/`, committed, and served from this origin. No CDNs, no
  `npm install` at build time, no runtime downloads from anyone else.
- Each library recorded in [`vendor/README.md`](vendor/README.md) with its
  version, licence and where it came from.
- No bundler, no framework, no build step. The page should stay readable as
  source, the way the macOS app's UI is.

## Running it locally

It is static, so anything that serves a directory works:

```bash
python3 -m http.server -d web 8000
```

Then open `http://localhost:8000`. Note that the CSP is stricter than the local
app's, so a mistake that reaches for the network fails loudly here.
