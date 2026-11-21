// The entry point, and the one thing that has to happen before anything else.
//
// Nobody should be running Convertly inside someone else's page: a framed copy
// can be dressed up to look like it belongs to another site. The usual way to
// refuse is CSP's frame-ancestors, but browsers honour that only as an HTTP
// header, and GitHub Pages cannot send headers. So the check is here -- and
// the interface is not even loaded when it fails, rather than loaded and then
// stopped.

if (window.top === window.self) {
  await import('./ui.js');
} else {
  document.body.textContent = 'Convertly will not run inside another page. Open it directly.';
}
