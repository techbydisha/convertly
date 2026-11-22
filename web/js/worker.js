// Starting a Web Worker that is bound by the page's privacy policy.
//
// The page's guarantee is `connect-src 'none'` in a <meta> Content Security
// Policy. A worker started from its own URL -- new Worker('/js/x.js') -- does
// NOT inherit that policy: it takes its policy from the HTTP headers of its
// own script, and GitHub Pages sends none. Measured, not assumed: a worker
// loaded that way made a network request that the page itself could not.
//
// A worker started from a blob: URL is different -- it inherits the policy of
// the page that made it. So every worker here is a one-line blob whose only
// job is to import the real worker module. Everything that runs inside it,
// including vendored code like libheif and pdf.js, is then held to
// connect-src 'none' by the browser, not by our good intentions.
//
// This needs worker-src to allow blob:, which grants nothing new: code able to
// build the blob is already running in the page, and the worker it makes is
// under the same policy as the page.
//
// This is the only place in the browser build that may call `new Worker`.
// web-tests.yml enforces that.

/** A module worker running `moduleUrl`, under this page's Content Security Policy. */
export function sandboxedWorker(moduleUrl) {
  const url = new URL(moduleUrl, import.meta.url).href;
  const source = `import ${JSON.stringify(url)};`;
  // Deliberately never revoked. The worker fetches its script asynchronously,
  // and revoking straight after the constructor races that fetch in some
  // browsers. A worker is made once per page, so this is a few bytes, kept.
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  return new Worker(blobUrl, { type: 'module' });
}
