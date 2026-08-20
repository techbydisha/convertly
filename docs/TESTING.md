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
| Security | `tests/test_security.py` | Network exposure, request origin, hostile filenames and files, no persistence, no secrets |
| Browser UI | manual — see [Manual checks](#manual-checks) | Drag and drop, tab switching, previews, download behaviour |

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

At the time of writing: **87.3%** across 144 tests, in about 9 seconds.

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
- [ ] **Edit PDF**: page count is right, `2-4` produces exactly those pages, an invalid range blocks the button
- [ ] Combining two PDFs respects the ▲▼ order
- [ ] The browser console is free of errors

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

## Definition of done

A change is ready when:

- [ ] `python3 tests/coverage_report.py --min 85` passes
- [ ] New behaviour has a test asserting **content**, not just a status code
- [ ] New failure modes have a test proving they produce a clean error
- [ ] Anything touching parsing, filenames or the server has a matching row in the security table
- [ ] The manual checklist passes if the UI changed
