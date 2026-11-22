# Security

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting instead: go to the **Security** tab of this
repository and choose *Report a vulnerability*. If that is unavailable, open an
issue saying only that you have a security report and asking for a contact
route — no details.

Expect an acknowledgement within a week. If the report is valid, you will be
credited in the fix unless you prefer otherwise.

## What Convertly is, in security terms

Convertly runs a small HTTP server on `127.0.0.1` while you use it, and parses
file formats that can be hostile. It is a **single-user local tool**. It is not
built to be exposed to a network, and it has no authentication, because it is
not intended to be reachable by anyone but the person running it.

**Do not put Convertly behind a public URL, a reverse proxy, or a tunnel.**
Nothing in it is designed for that.

### What it deliberately does not do

- No outbound network calls of any kind. The code imports no HTTP client, and a
  test enforces that.
- No persistent storage. Files are held in memory for one request; the temp
  directory used for decoding is deleted immediately after.
- No telemetry, analytics, crash reporting, or update checks.
- No third-party dependencies, so it has no supply chain beyond Python itself
  and the tools built into macOS.

### Protections in place

| Risk | Protection |
| --- | --- |
| Reachable over the network | Binds `127.0.0.1` only |
| DNS rebinding | Requests with a non-loopback `Host` are refused |
| A web page you visit calling the local server | Foreign `Origin` refused; no CORS headers; no `OPTIONS` handler, so browsers block cross-origin requests at preflight |
| Injected content phoning home | `Content-Security-Policy` restricted to `self` |
| Command injection through a filename | No shell is ever used; arguments are passed as lists; file extensions are reduced to `[a-z0-9]` |
| Response header injection | Header values are URL-quoted |
| Malicious PDFs | Decompression capped, recursion bounded, encrypted files refused, uploads size-limited |

These are covered by `tests/test_security.py`; see [docs/TESTING.md](docs/TESTING.md).

### The browser build

The hosted page has no server to protect, so its defence is the opposite one:
it cannot send anything. Its `<meta>` Content Security Policy sets
`connect-src 'none'`, which the browser enforces for `fetch`, XHR, WebSockets
and beacons; `web/README.md` explains the rest.

One gap was found and closed while adding pdf.js. **A worker started from its
own URL does not inherit a `<meta>` policy** — it takes the policy of its own
HTTP response, and GitHub Pages sends none — so code in such a worker could
reach the network while the page could not. The HEIC decoder had run that way
since it shipped. It made no requests (it was reviewed, and it is pinned by
hash), but the claim that the browser *enforced* the guarantee was not true of
worker code. Every worker now starts from a `blob:` URL that imports the real
module, and a `blob:` worker does inherit the page's policy; this was checked by
having one try to `fetch` and watching it be refused. CI fails any `new Worker`
outside `web/js/worker.js`.

The macOS app serves the same page with the same rules as an HTTP header,
where the only change is `connect-src 'self'`, so the page can reach the local
server and nowhere else.

### Known limitations

- Anything running as your user on your machine can reach the local port while
  Convertly is running. This is inherent to a local web UI.
- `--use-word` drives Microsoft Word through AppleScript. That is off by
  default, and Word is never launched without it.
- Conversion relies on Apple's `sips` and Quick Look. A vulnerability in those
  is outside this project's control; keep macOS updated.

## Supported versions

The latest release on the default branch is the supported version.
