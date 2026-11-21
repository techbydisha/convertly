# Test strategy

Convertly parses hostile-by-default file formats and opens a network port on the
user's machine. Those two facts decide what is worth testing: **file parsing must
never corrupt data or crash the app**, and **the local server must never be a way
in**. Everything below follows from that.

## Principles

1. **Assert on content, not on shapes.** "The output has 3 pages" is weak; "the
   output contains exactly the text of pages 2, 3 and 4" is the real requirement.
   A page-count assertion passes happily on three blank pages.
2. **Verify with something other than our own code where possible.** Our PDF
   parser reading our PDF writer proves nothing. macOS ships an independent PDF
   engine (`sips`, Quick Look); use it as the oracle.
3. **Generate fixtures, never commit them.** No binary sample files live in this
   repository. They could carry personal data, and they hide what a test actually
   depends on. `tests/helpers.py` builds every fixture at run time.
4. **Tests must not touch the user's environment.** No network, no writing
   outside temp directories, and never launching another application.
5. **A bug that reaches a user becomes a test.** Regressions listed at the bottom
   of this document each correspond to a real defect found during development.

## The layers

| Layer | File | What it covers |
| --- | --- | --- |
| PDF engine | `tests/test_pdfedit.py` | Parsing, page ranges, extraction, joining, damaged files, resource limits |
| Conversion | `tests/test_convert.py` | Format detection, the conversion matrix, thumbnails, the image-to-PDF writer |
| HTTP surface | `tests/test_server.py` | Every route, status codes, headers, malformed requests, CLI parsing |
| Shared behaviour | `tests/test_shared_spec.py` | The contract both builds satisfy, from `shared/spec/*.json` |
| Security | `tests/test_security.py` | Network exposure, request origin, hostile filenames and files, no persistence, no secrets |
| Shared behaviour (browser) | `web/tests/spec.test.mjs` | The same contract, from the browser build's side |
| PDF writer port | `web/tests/pdfwrite.test.mjs` | Byte-for-byte agreement with the Python image-to-PDF writer |
| PDF engine port | `web/tests/pdfedit.test.mjs` | Byte-for-byte agreement on extracting, merging and removing pages |
| Decompression | `web/tests/inflate.test.mjs` | The synchronous inflate, against Python's `zlib` |
| Browser UI | manual — see [Manual checks](#manual-checks) | Drag and drop, tab switching, previews, download behaviour |

## The shared spec

Convertly has two front ends — the macOS app in Python and the browser build in
JavaScript — and the risk that matters is **silent divergence**: `2-4` selecting
different pages depending on which one you opened, or a file arriving with a
different name.

[`shared/spec/`](../shared/spec/) holds that contract as JSON, and both suites
run against the same cases. Neither side can drift without a test going red.

| File | Pins down |
| --- | --- |
| `page-ranges.json` | Every accepted and rejected range form |
| `output-names.json` | What produced files are called, including hostile inputs |
| `file-sizes.json` | How byte counts are shown |
| `file-kinds.json` | Which extensions are accepted, and which the browser can handle |

It earns its keep. Writing it immediately exposed a live inconsistency: 2500
bytes rendered as "2 KB" in Python and "3 KB" in JavaScript, because Python's
`round()` rounds half to even while `Math.round()` rounds half up. Python now
uses `floor(x + 0.5)`, and `file-sizes.json` pins the case so it cannot come
back.

It has now caught a second one. Writing down how a typed size is read exposed
that `1.2.3 MB` was quietly accepted as 1.2 MB in both front ends, applying a
limit nobody asked for instead of marking the field wrong. `file-sizes.json`
has a `typed` section for that, and a third: the macOS app's **Edit PDF** tab
was showing sizes in 1024-based units while its Convert tab used 1000-based
ones, so one PDF could read "1.0 MB" in one tab and "1.1 MB" in the next.

**Changing user-visible behaviour starts here**: add the case, watch both sides
fail, then fix both.

### The ports that cannot be checked by spec alone

Some of the browser build is a line-by-line port rather than a behaviour both
sides implement independently. For those, "behaves plausibly" is not enough:
`web/tests/pdfwrite.test.mjs` hands every case to the Python writer as well and
requires **identical bytes**. A PDF's cross-reference table is a list of offsets
into the file, and one wrong number produces something some readers open and
others reject — not a failure any reasonable assertion about shape would catch.

`pdfedit.py` is now ported the same way, and the same rule caught the same
class of mistake: a PDF is a graph of numbered objects whose cross-reference
table is a list of byte offsets, so an object numbered differently or a
dictionary key in another order produces a file that some readers open and
others reject. Byte-equality is the only assertion that notices.

One piece of the browser build is new code rather than a port: `inflate.js`,
because the browser only decompresses asynchronously and the PDF parser is
synchronous throughout. It is held to the same standard from the other
direction — Python compresses, JavaScript decompresses, and a thousand random
round-trips across every level and strategy must come back identical.

## Minimum coverage

These are the cases that must exist. A change to any area is not finished until
its row is still true.

### PDF engine (`pdfedit.py`)

| Area | Required cases |
| --- | --- |
| Page ranges | every accepted form (`2-4`, `1,3,5-7`, `2-`, `-3`, `3-1`, blank, `all`); every rejected form (`0`, past the end, non-numeric); error text names the real page count |
| Extraction | correct pages **by content**; requested order preserved, including reversed; single page; discontiguous selection; output re-parses |
| Joining | order follows the argument order; per-document ranges; the same document used twice |
| Formats | classic cross-reference tables **and** PDF 1.5 cross-reference streams with object streams and PNG predictors; both mixed into one output |
| Damaged input | non-PDF, truncated, bad `startxref`, corrupt `xref` keyword, every offset shifted, missing `/Root` — each either recovers or raises `PdfError`, never hangs or crashes |
| Refusals | encrypted PDFs rejected with a message naming the cause |
| Limits | decompression bombs refused; ordinary streams unaffected; deeply nested objects terminate |

### Conversion (`convert.py`)

| Area | Required cases |
| --- | --- |
| Classification | every extension in `INPUT_EXTS` classifies; unknown extensions return `None`; double extensions (`a.pdf.exe`) do not classify as PDF |
| Images | each input format to each output format; quality affects size; corrupt input raises |
| Documents | PDF→PDF copied unchanged; PDF→image warns with the true page count; single-page needs no warning; Word falls back and says so; iWork uses the embedded preview |
| Image PDFs | the original JPEG bytes are embedded (never recompressed); page orientation follows the image |
| Resizing | longest edge capped; aspect ratio kept for tall and wide images; images never enlarged; applies to PDF output too |
| Size budgets | the result fits, across several budgets; quality is spent before dimensions; dimensions shrink when quality is not enough; a file already under budget is untouched; an impossible budget returns the smallest attempt and says so; the search is bounded in time; the PDF wrapper counts against the budget |
| Thumbnails | one per supported kind; unsupported and broken input return `None`, never raise |
| Guards | unknown output format, empty input, oversized input, unsupported type |

### HTTP surface (`server.py`)

| Area | Required cases |
| --- | --- |
| Routes | every endpoint's success path; unknown paths 404 on both GET and POST |
| Status codes | 400 empty body, 413 oversized, 422 unreadable input, 500 only for genuine bugs |
| Headers | `X-Out-Name` round-trips a name with spaces; `X-Note` carries caveats; content types are correct |
| Framing | `/pdf/build`'s length-prefixed body: valid, malformed, too short, mismatched range count |
| Robustness | every handler survives an unexpected exception in the code it calls, and the server keeps serving afterwards |
| CLI | defaults, every flag, unknown flags rejected, port fallback when the preferred port is taken |
| Size options | `max_px` and `target` resize and squeeze; nonsense values are ignored rather than fatal; absent options leave the image untouched |

### Security (`tests/test_security.py`)

Each row is a threat and the test that closes it.

| Threat | Mitigation | Test |
| --- | --- | --- |
| Reachable from the network | Bind `127.0.0.1` only | `NetworkExposure` |
| DNS rebinding — a hostile site resolves its domain to `127.0.0.1` | Reject non-loopback `Host` | `test_rejects_foreign_host_header` |
| A visited web page POSTing to the local server | Reject foreign `Origin`; no `OPTIONS` handler, so preflight fails; no CORS headers | `RequestOrigin` |
| Injected markup exfiltrating data | `Content-Security-Policy` limits everything to `self` | `ResponseHeaders` |
| MIME sniffing | `X-Content-Type-Options: nosniff` | `ResponseHeaders` |
| Path traversal via the filename header | Output names are basenamed; extensions reduced to `[a-z0-9]` | `HostileFilenames` |
| Command or AppleScript injection via a filename | No shell anywhere (`shell=True`, `os.system`, `os.popen` all absent); arguments passed as lists; extension sanitised | `test_shell_metacharacters_have_no_effect`, `test_subprocesses_never_use_a_shell` |
| Response header injection (CRLF in a filename) | Header values are URL-quoted | `test_response_headers_cannot_be_injected` |
| Decompression bomb in a PDF | Hard ceiling on inflated output | `ResourceLimits` |
| Memory exhaustion by upload size | `MAX_BYTES` enforced before any work | `test_upload_size_is_capped` |
| Malicious PDFs crashing or hanging the parser | Fail with `PdfError`, bounded recursion | `test_parsers_never_raise_unexpected_exceptions` |
| Data surviving a request | Temp directories counted before and after | `NoPersistence` |
| Data leaving the machine | Imports checked by AST; the UI references no remote URLs | `NoNetworkCalls` |
| Credentials committed | Whole tree scanned for key/token/password patterns | `NoSecretsInRepo` |
| Personal files committed | No binary media may exist in the tree | `test_no_personal_files_are_committed` |

## Coverage floor

Statement coverage of `src/convertly/` must stay **at or above 85%**, measured
with the standard library only:

```bash
python3 tests/coverage_report.py --min 85
```

At the time of writing: **87.6%** across 179 tests, in about 22 seconds.

`convert.py` sits lower than the others (~81%) on purpose. The uncovered lines
are the Microsoft Word automation path, which cannot be exercised without
launching Word on the developer's machine — something the suite must never do.
Treat that code as manually tested and keep it small.

Coverage is a floor, not a goal. A patch that raises the number by testing
getters while leaving a parsing branch unverified has made things worse.

## Running the tests

```bash
python3 -m unittest discover -s tests -t .        # everything
python3 -m unittest tests.test_pdfedit -v         # one module
python3 -m unittest tests.test_security -v        # security checks alone
python3 tests/coverage_report.py --min 85         # with the coverage floor
SHOW_MISSING=1 python3 tests/coverage_report.py   # list uncovered lines
```

The browser build's tests are separate, and need Node rather than Python:

```bash
node --test web/tests/*.test.mjs                  # the browser build
python3 -m http.server -d web 8000                # run it locally to try by hand
```

Node's own test runner, so again nothing to install — but keep `python3` on the
path, or the byte-for-byte comparison against the Python PDF writer skips
instead of running.

No dependencies and no installation step: the suite adds `src/` to the import
path itself. Tests that need macOS tools skip themselves elsewhere, so the suite
is honest rather than red on other platforms.

## Manual checks

The browser UI is not automated — a real drag-and-drop, a real file picker and a
real download cannot be faked convincingly enough to be worth the machinery.
Before a release, run `python3 run.py` and confirm:

- [ ] Dragging a mixed selection (HEIC, PNG, PDF, Word) lists every file with a thumbnail
- [ ] Nothing converts until **Convert** is pressed
- [ ] Changing format or quality clears results and waits for another press
- [ ] Downloaded files open correctly and match their preview
- [ ] **Max file size** of 1 MB on a large photo produces a file under 1 MB, and the row explains what changed
- [ ] Setting a size limit shows `auto` beside the quality slider and dims it
- [ ] Choosing **PNG** shows `n/a` beside the quality slider; a PNG photo may be larger than its source, which is correct
- [ ] **Edit PDF**: page count is right, `2-4` produces exactly those pages, an invalid range blocks the button
- [ ] Combining two PDFs respects the ▲▼ order
- [ ] The browser console is free of errors

### Only in the browser build

- [ ] A Word file, a `.zip` and a `.tiff` each get a row saying *why* they are
      refused — the macOS app takes all three
- [ ] A `.pages` file converts to PDF, and to JPG is refused with an explanation
- [ ] A transparent PNG stays transparent as PNG, and flattens to **white**
      (not black) as JPG
- [ ] At phone width every label stays beside the control it names
- [ ] The network panel shows nothing beyond the page's own files

The last one is the important one. The privacy claim is `connect-src 'none'`,
and it is worth re-proving rather than assuming:

```js
navigator.sendBeacon('https://example.com/x', 'data')   // returns true -- but
```

`sendBeacon` returns `true` even when CSP refuses the request, so a bare return
value proves nothing. Listen for the violation instead, and check the network
panel stayed empty:

```js
document.addEventListener('securitypolicyviolation',
  e => console.log('blocked', e.violatedDirective, e.blockedURI));
```

`fetch`, `XMLHttpRequest`, `WebSocket` and `sendBeacon` must all report a
`connect-src` violation.

## Verifying PDF work against an independent engine

Our own parser must not be the only judge of our own output. During development
the whole suite of PDFs shipped with macOS (3030 files) was round-tripped, and a
sample was checked with Apple's PDF engine: `sips` accepted every output, Quick
Look rendered every output non-blank, and extracting page 1 rendered
byte-identical to rendering the original.

That sweep is not part of the automated suite — it depends on files outside the
repository and takes minutes rather than seconds. Re-run it by hand after any
change to `pdfedit.py`:

```bash
python3 - <<'PY'
import glob, sys
sys.path.insert(0, "src")
from convertly import pdfedit
files = glob.glob("/System/Library/**/*.pdf", recursive=True)
bad = []
for path in files:
    data = open(path, "rb").read()
    try:
        n = pdfedit.page_count(data)
        if pdfedit.page_count(pdfedit.build([(data, "")])) != n:
            bad.append(path)
    except Exception as exc:
        bad.append(f"{path}: {exc}")
print(f"{len(files)} PDFs, {len(bad)} problems")
for b in bad[:10]:
    print("  ", b)
PY
```

## Regressions that must stay covered

Each of these was a real defect. The test named beside it is the guard.

| Defect | Guard |
| --- | --- |
| Switching output format mid-conversion left files holding the previous format | Manual check 3 (the UI generation guard) |
| `MAX_BYTES` was imported by value, so the server ignored a changed limit | `test_oversized_upload_is_refused_before_conversion` |
| Quick Look ground for 90 seconds on iWork files before failing | `Thumbnails.test_iwork_thumbnail_uses_embedded_preview` |
| Word automation hung for 90 seconds behind a modal dialog | `test_word_conversion_never_launches_word_by_default` |
| A `.pages` file reported "Already a PDF" | `test_iwork_uses_the_embedded_preview` |
| `sips -Z` silently enlarged images smaller than the requested size | `test_images_are_never_enlarged` |
| `1.2.3 MB` typed as a size limit was read as 1.2 MB instead of being refused | `a size that cannot be read is refused, not guessed at` |
| The Edit PDF tab showed 1024-based sizes while the Convert tab used 1000-based | `sizes are shown as the spec says` |
| `frame-ancestors` in a `<meta>` CSP is ignored by browsers, so it protected nothing | Browser manual check — load the page in an iframe |
| A resize limit larger than the picture made the browser's fit-to-size search spend its whole attempt budget shrinking a number that changed nothing | Browser manual check — resize limit above the picture, with a size limit |

## Definition of done

A change is ready when:

- [ ] `python3 tests/coverage_report.py --min 85` passes
- [ ] `node --test web/tests/*.test.mjs` passes, if `web/` or `shared/` changed
- [ ] New behaviour has a test asserting **content**, not just a status code
- [ ] New failure modes have a test proving they produce a clean error
- [ ] Anything touching parsing, filenames or the server has a matching row in the security table
- [ ] The manual checklist passes if the UI changed
