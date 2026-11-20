# Contributing to Convertly

Thanks for taking a look. Convertly is a small, deliberately simple tool, and
the aim is to keep it that way.

## The two rules that shape everything

1. **Nothing leaves the user's machine.** No network calls, no telemetry, no
   remote assets in the UI — not even a web font. If a change needs the network,
   it does not belong here.
2. **No dependencies in the macOS app.** It runs on the Python standard library
   plus tools that ship with macOS. "There is nothing to install" is a feature,
   not an accident, and CI enforces it. A dependency is not forbidden forever,
   but adding one needs an argument in the pull request for why the problem
   cannot be solved without it.

   The browser build in `web/` cannot make the same promise — decoding HEIC in a
   browser needs a WebAssembly library. Its narrower rule is in
   [`web/vendor/README.md`](web/vendor/README.md): vendored and committed, never
   a CDN, no bundler, no build step.

3. **Both builds behave identically.** Anything user-visible — page ranges,
   filenames, size formatting, which files are accepted — is pinned in
   [`shared/spec/`](shared/spec/) and tested on both sides. Change the spec
   first, then make both satisfy it.

## Getting set up

```bash
git clone https://github.com/<owner>/convertly.git
cd convertly
python3 run.py          # starts the app; no install step
```

You need macOS and Python 3.10 or newer. That is the whole setup.

## Before you open a pull request

```bash
python3 tests/coverage_report.py --min 85
```

That runs the full suite and enforces the coverage floor. It takes about ten
seconds and needs no dependencies.

If you changed the browser UI, also walk through the manual checklist in
[docs/TESTING.md](docs/TESTING.md#manual-checks) — drag and drop and downloads
are not automated.

## What a good change looks like

- **Tests assert content, not shape.** "Three pages came out" passes on three
  blank pages. Assert *which* pages, by their content. See
  [docs/TESTING.md](docs/TESTING.md) for the standard.
- **Fixtures are generated, never committed.** `tests/helpers.py` builds PDFs,
  images and documents at run time. Please do not add binary sample files: they
  can carry personal data, and `.gitignore` blocks them on purpose.
- **Failures are explained to the user.** An error the UI shows should say what
  went wrong in plain words. "Not a readable HEIC image" beats passing through
  `sips`'s own "Try 'sips --help'".
- **Nothing is silently partial.** If a conversion can only do part of the job —
  the first page of a long document, say — the result must say so. Look at how
  the `note` value flows from `convert()` to the row in the UI.
- **Comments explain why, not what.** The existing code comments the surprising
  parts: why Quick Look has a timeout, why the ignore-cache in the coverage
  script matters. Match that.

## Code style

Plain Python, no formatter enforced. Follow what is already there: four spaces,
lines around 95 characters, double quotes, docstrings on modules and non-obvious
functions. Prefer a clear twenty-line function over a clever five-line one.

The UI is one HTML file with inline CSS and JavaScript
(`src/convertly/web/index.html`). That is intentional — it keeps the whole
interface readable in one place and needs no build step. Please do not introduce
a bundler, a framework, or a package manager.

## Where things live

```
src/convertly/
  server.py     HTTP routes and the CLI
  convert.py    format detection, conversion, thumbnails, image→PDF
  pdfedit.py    PDF parsing, page extraction, joining
  web/          the user interface, one file
tests/          the test suite and the coverage report
docs/           test strategy and architecture notes
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit
together and why the odd-looking decisions were made.

## Reporting bugs

Open an issue using the bug report form. The details it asks for — macOS
version, what kind of file, what the row in the UI said — are what make a bug
reproducible.

**Never attach a personal file to an issue.** If a specific document triggers a
bug, describe it instead: how many pages, what produced it, whether it is
scanned. If you can reproduce it with a file you are happy to share publicly,
say so.

## Security problems

Do not open a public issue. See [SECURITY.md](SECURITY.md).
