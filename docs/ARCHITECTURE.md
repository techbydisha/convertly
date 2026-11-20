# Architecture

Convertly is a local web app: a small Python server, a single HTML page, and two
modules that do the real work. It has no dependencies and no build step.

```
browser  ──HTTP──▶  server.py  ──▶  convert.py  ──▶  sips / Quick Look
(one page)          (routes)    └─▶  pdfedit.py  (pure Python)
```

## Why a local web app

A browser gives drag-and-drop, file pickers, previews and downloads for free,
and works the same on every Mac. The alternative — a native app — would mean a
build toolchain, code signing, and a much larger thing to maintain for the same
result.

The cost is an open port, which is why the server is careful about who it talks
to (see [SECURITY.md](../SECURITY.md)).

## The modules

### `server.py`

Routes, and nothing else. Each handler reads a body, calls into `convert` or
`pdfedit`, and turns exceptions into status codes:

| Route | Purpose |
| --- | --- |
| `GET /` | the one HTML page |
| `GET /health` | used by tests and CI |
| `POST /convert` | one file in, one converted file out |
| `POST /preview` | one file in, a small JPEG thumbnail out |
| `POST /pdf/info` | page count for a PDF |
| `POST /pdf/build` | page ranges of one or more PDFs, joined into one |

Uploads are sent as **raw request bodies** rather than multipart forms. Python
3.13 removed the `cgi` module, so multipart would mean hand-writing a parser;
raw bodies need none. The filename travels in an `X-Filename` header.

`/pdf/build` needs several files in one request, so its body is each file
prefixed with a 4-byte big-endian length. That is a few lines on each side and
avoids a multipart parser entirely.

A useful side effect: custom headers and the `application/octet-stream` content
type both make these requests "non-simple", so a browser must send a CORS
preflight first. There is no `OPTIONS` handler, so cross-origin requests fail
before they reach any code.

### `convert.py`

Everything that turns one format into another, built on tools already in macOS:

- **Images** — `sips`, Apple's own decoder. It reads HEIC correctly, applies
  orientation, and is fast.
- **Documents** — Quick Look (`qlmanage`) renders the first page of a PDF, Word
  file or RTF at about 200 dpi.
- **iWork files** — Pages, Keynote and Numbers store a PDF preview inside their
  own documents. Unzipping that is instant and needs no Apple apps installed,
  which matters because Quick Look grinds for ninety seconds on these files when
  the apps are missing.
- **Word, optionally** — only Word itself produces a true multi-page PDF. It is
  used only when already running and responsive, checked with a five-second
  probe, because a modal dialog in Word blocks AppleScript indefinitely.
  `--use-word` allows launching it.

**Fitting a size budget.** When a maximum file size is asked for, `_fit_jpeg`
searches for the best image that fits. A JPEG's size falls off with quality long
before detail becomes objectionable, so quality is searched first — a binary
search between the requested quality and a floor of 40. Only if the floor is
still too large are the pixel dimensions reduced, scaled by the square root of
how far over budget the attempt was (file size tracks pixel count, so the square
root is the right first guess). Each attempt is one `sips` run, and the whole
search is capped at 18 of them; a 12 MP photo typically settles in under two
seconds.

Two details that are easy to get wrong: `sips -Z` *enlarges* an image smaller
than the limit, so the requested size is clamped to the source; and a PDF wraps
its JPEG in about a kilobyte of structure, which has to come out of the budget
or the finished PDF misses it.

Conversions return `(bytes, extension, note)`. The `note` carries any caveat —
"First page only (3 pages in the PDF)" — which becomes the amber text on the
file's row. Nothing is ever silently partial.

Image-to-PDF is written by hand (`jpeg_to_pdf`): a JPEG can be embedded in a PDF
as a `DCTDecode` stream exactly as it is, so the output is a wrapper around the
original bytes with no second round of compression.

### `pdfedit.py`

A PDF reader and writer in pure Python, because page extraction and joining need
to understand an existing file rather than just emit one. It covers:

- **Objects** — a tolerant lexer for dictionaries, arrays, names, strings,
  numbers, references and streams.
- **Cross-reference tables** — classic tables and PDF 1.5 cross-reference
  streams, including the object streams they point into and the PNG predictors
  they are compressed with. Modern PDFs from Word or Chrome use the latter.
- **Recovery** — when a table is wrong, the file is scanned for `N G obj`
  markers and the structure rebuilt. Broken offsets are common in the wild, and
  a damaged table should not mean a lost document.
- **Writing** — each kept page is copied along with everything it references,
  renumbered into a fresh document. Streams are copied in their original encoded
  form, so images and text are never re-compressed.

Two details worth knowing:

- A page copy stops at links to *other* pages. Without that, an annotation
  pointing at page 5 would drag page 5's whole object graph into a file that is
  supposed to contain only pages 2 to 4.
- Decompression is capped. Cross-reference and object streams are never large,
  so a hard ceiling costs nothing and stops a malicious PDF exhausting memory.

Encrypted PDFs are refused rather than mangled.

### `web/index.html`

The entire interface: markup, styles and script in one file, no framework and no
build step. Two tabs share the file-row layout and the thumbnail logic.

Thumbnails come from the server because a browser cannot decode HEIC or render a
PDF page. After a conversion the thumbnail is swapped for the converted image
itself, so what the user sees is what downloads.

The one subtle piece is the **generation counter**. Conversions are asynchronous,
and changing the format while one is in flight used to leave that file holding
the previous format. Every conversion captures the counter when it starts;
changing a setting increments it; a result arriving with a stale counter is
discarded and re-run.

## Deliberate limits

- **macOS only.** The conversion layer is `sips` and Quick Look. A Linux port
  would need different tools behind the same interface in `convert.py`.
- **First page only, for PDF and Word to images.** macOS has no built-in
  multi-page rasteriser — `sips` renders page 1 at 72 dpi, Quick Look at ~200
  dpi, and neither reaches page 2. Doing this properly needs a rendering library
  such as `pypdfium2`, the one dependency with a standing case for it.
- **No persistence.** There is no history, no queue and no cache. Files exist in
  memory for one request.
