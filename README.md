# Convertly

A local file converter and PDF editor for macOS. Convert images and documents to
**JPG**, **JPEG**, **PNG** or **PDF**, resize pictures to fit a size limit, pull pages out
of a PDF, and join PDFs together.

Everything runs on your own device. Nothing is uploaded, nothing is stored, and
there is nothing to install.

## Two ways to run it

| | [macOS app](#install) | [Browser build](https://techbydisha.github.io/convertly/) |
| --- | --- | --- |
| Where | your Mac | any device, in the browser |
| Files | never leave the machine | never leave the browser — the page cannot open a network connection |
| Pictures → JPG / JPEG / PNG / PDF | yes | yes |
| Resize, and fit under a size limit | yes | yes |
| Pages, Keynote, Numbers | yes | yes, to PDF |
| Merge PDFs, remove pages | yes | yes |
| PDF pages as images | first page | not yet |
| TIFF | yes | not yet |
| Word documents | yes | no — `qlmanage` has no browser equivalent |
| Install | nothing | nothing |

Both are in this repository and must behave identically: the same page ranges,
the same filenames, the same sizes. Those rules are pinned in
[`shared/spec/`](shared/spec/) and both test suites run against them.

The macOS app is the complete one. The browser build does pictures — which is
most of the daily use — on a phone as well as a Mac, and needs nothing
installed: **<https://techbydisha.github.io/convertly/>**. Its source is in
[`web/`](web/).

---

## Install

You need **macOS** and **Python 3.10 or newer** (`python3 -V` to check — recent
macOS ships a suitable version).

```bash
git clone https://github.com/techbydisha/convertly.git
cd convertly
python3 run.py
```

That's the whole installation. Convertly uses only the Python standard library
and tools already built into macOS, so there are no packages to install and no
build step.

Your browser opens at `http://127.0.0.1:8765/`. Press `Ctrl+C` in the terminal to
stop it.

**Prefer double-clicking?** Open the folder in Finder and double-click
**`Convertly.command`**.

**Prefer a command?** `pip install .` adds a `convertly` command that starts it
from anywhere.

---

## Use

### Converting files

1. Drag files onto the drop zone, or click it to browse. Several at once is fine.
2. Each file appears under **Your files** with a thumbnail, so you can see what
   you picked. Click a thumbnail for a bigger preview, or **×** to remove it.
3. Choose a format and quality, then press **Convert**.
4. Each row shows the result — its new name and size — with a **Download**
   button. **Download all** saves the batch; **Clear** empties the list.

### Making a picture smaller

*"The upload only allows 1 MB and my photo is 5 MB."*

Set **Max file size** to `1 MB` and press **Convert**. Convertly finds the best
image that fits: it compresses harder first, and only shrinks the dimensions if
compression alone isn't enough. The row tells you what it did — for example
`5.0 MB → 991 KB · Resized to 1994×1495, quality 61`.

Sizes are shown the way Finder shows them (1 MB = 1,000,000 bytes), which is
what upload limits normally mean.

- **Max file size** — presets from 200 KB to 10 MB, or **Custom…** to type your
  own (`750 KB`, `1.5 MB`, `900000 B`; a bare number means KB). While a size
  limit is set, quality is chosen automatically and the slider shows `auto`.
- **Resize** — cap the longest edge instead, if you know the dimensions you
  want. Pictures are only ever shrunk, never enlarged.

You can use both together: *longest edge 1600 px, and under 500 KB*. If a limit
turns out to be impossible, you still get the smallest version Convertly could
make, and the row says so rather than pretending it worked.

Nothing converts until you press **Convert**. Changing the format or quality
afterwards clears the results and waits for you to press it again, so what you
download always matches what is selected. After converting, the thumbnail shows
the *converted* image: what you see is what you get.

### Editing PDFs

The **Edit PDF** tab keeps the pages you want and joins documents together.

1. Drop in one or more PDFs. Each shows its page count and a preview.
2. In the **Pages** box, say what to keep — leave it blank for all, or:

   | You type | You get |
   | --- | --- |
   | `2-4` | pages 2, 3 and 4 |
   | `1,3,5-7` | pages 1, 3, 5, 6 and 7 |
   | `2-` | page 2 to the end |
   | `-3` | the start through page 3 |
   | `3-1` | pages 3, 2, 1 — in that order |

   Ranges are checked as you type against the real page count.
3. With one PDF, **Extract pages** saves your selection. With several,
   **Combine … into one** joins them in list order (▲▼ to reorder), and
   **Save each separately** keeps them apart.

Page content and images are copied in their original compressed form, so nothing
is re-encoded and quality is preserved exactly. Password-protected PDFs are
refused with a clear message rather than mangled.

---

## What it accepts

| Input | → JPG / JPEG | → PNG ⁴ | → PDF |
| --- | --- | --- | --- |
| HEIC, HEIF, PNG, JPEG, TIFF, GIF, BMP, WebP | full quality | every pixel kept | image embedded on a page |
| PDF | first page, ~200 dpi ¹ | first page, ~200 dpi ¹ | copied unchanged |
| Word (`.docx`, `.doc`, `.rtf`) | first page ¹ ² | first page ¹ ² | first page ¹ ², or a full export ² |
| Pages, Keynote, Numbers | from the document's stored preview ³ | same ³ | same ³ |

¹ **First page only.** macOS has no built-in multi-page rasteriser, so
converting a document *to an image* covers page one. Rows say so, with the real
page count — you are never silently handed part of a document.

² **Word files.** Only Word itself can produce a true multi-page PDF. Convertly
uses it only when it is *already running and responsive*: it never launches Word
behind your back, and if Word is busy or showing a dialog it falls back to a
rendered first page within a few seconds instead of hanging. Start with
`python3 run.py --use-word` to let it launch Word when needed.

³ **iWork files.** Pages, Keynote and Numbers store a PDF preview inside their
own documents, and that is what gets used — no Apple apps required. Documents
saved without one can't be converted; export them from Pages instead.

⁴ **PNG is lossless**, so the quality slider doesn't apply and shows `n/a`.
Expect photographs to come out *larger* than the JPEG they came from — that is
the trade, and it's the right choice for screenshots, logos and anything with
sharp edges or transparency, which JPEG smudges. Transparency is preserved;
converting the same file to JPG flattens it onto white instead. A size limit
still works, but the only way to meet it is a smaller picture, so the row says
what it had to do.

---

## Options

```bash
python3 run.py --port 9000     # use a different port
python3 run.py --no-browser    # don't open a browser window
python3 run.py --use-word      # allow launching Word for full document exports
python3 run.py --verbose       # log each request
```

---

## Privacy and security

Convertly exists so that converting a personal photo or document doesn't mean
uploading it to a website.

- **No network calls.** The code imports no HTTP client, and a test enforces it.
- **No storage.** Files live in memory for one request; the temp directory used
  for decoding is deleted immediately after. There is no history or cache.
- **No dependencies**, so no supply chain beyond Python and macOS itself.
- **Local only.** The server binds `127.0.0.1`, refuses requests with a
  non-loopback `Host` (which defeats DNS rebinding), and refuses cross-site
  requests.

Do not expose Convertly through a tunnel or reverse proxy — it is a single-user
local tool with no authentication. Full detail in [SECURITY.md](SECURITY.md).

---

## Project layout

```
convertly/
├── run.py                  start the macOS app without installing anything
├── Convertly.command       double-clickable launcher for Finder
├── src/convertly/
│   ├── server.py           HTTP routes and the command line
│   ├── convert.py          format detection, conversion, thumbnails, image→PDF
│   ├── pdfedit.py          PDF parsing, page extraction, joining
│   ├── naming.py           what produced files are called
│   └── web/index.html      the macOS app's interface, one file
├── web/                    the browser build, deployed to GitHub Pages
│   ├── js/                 the conversion code, as ES modules
│   ├── tests/              its share of the shared spec, run by node --test
│   └── vendor/             libheif, committed rather than loaded from a CDN
├── shared/spec/            behaviour both builds must satisfy
├── tests/                  the test suite and a dependency-free coverage report
└── docs/
    ├── TESTING.md          test strategy and the coverage floor
    └── ARCHITECTURE.md     how the pieces fit, and why
```

Under the hood: `sips` decodes images, Quick Look renders document pages, and
the PDF reading and writing is plain Python.

---

## Development

```bash
python3 tests/coverage_report.py --min 85     # full suite plus the coverage floor
python3 -m unittest discover -s tests -t .    # just the tests
node --test web/tests/*.test.mjs              # the browser build
python3 -m http.server -d web 8000            # run the browser build locally
```

The Python side runs on the standard library alone; the browser tests use
Node's own test runner, with nothing to install. See [CONTRIBUTING.md](CONTRIBUTING.md)
to get started and [docs/TESTING.md](docs/TESTING.md) for what a good test looks
like here.

---

## Roadmap

- **Finishing the browser build** — PDF pages as images, and TIFF. Both need a
  vendored renderer or decoder; the PDF editing engine is already ported.
- **Leaving a file alone when it already fits** — a JPEG is re-encoded even
  when it is already smaller than the size limit asked for, which can make it
  slightly *larger*. Both builds do this.
- **A less cautious fit-to-size search** — when compression alone cannot meet
  a size limit, the dimensions are reduced by a square-root estimate that
  overshoots, so the picture ends up smaller than the budget required. Both
  builds share the heuristic, so both would improve together.
- **Resizing to exact dimensions** (e.g. 1080×1080 with cropping) — today the
  longest edge is capped and the aspect ratio always kept.
- **Rotating or reordering pages within a PDF** — `pdfedit.Builder` already
  copies pages in any order, so both are small additions.
- **Combining images into a single PDF** — convert each to PDF, then join them
  in the Edit PDF tab; a one-step version is a natural next step.
- **Every page of a PDF as images** — the one real gap. It needs a rendering
  library such as `pypdfium2`, since macOS ships no multi-page rasteriser. This
  is the one case with a standing argument for a first dependency.

---

## License

[MIT](LICENSE).
