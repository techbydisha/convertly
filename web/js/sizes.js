// How a byte count is shown, and how a typed size is read back.
//
// Pinned by shared/spec/file-sizes.json. Sizes are decimal -- 1 MB is
// 1,000,000 bytes -- because that is what Finder shows and what upload limits
// mean when they say "1 MB".

/**
 * A byte count as the user sees it.
 *
 * Rounds half up via floor(x + 0.5). That is written out rather than left to
 * Math.round because the Python side has to produce the same string, and
 * Python's round() rounds half to even: round(2500/1000) is 2 there and 3
 * here. Both now use this formula.
 */
export function humanSize(count) {
  if (count < 1_000_000) {
    return `${Math.max(1, Math.floor(count / 1000 + 0.5))} KB`;
  }
  return `${(count / 1_000_000).toFixed(1)} MB`;
}

/**
 * Read a size the user typed: `750 KB`, `1.5 MB`, `900000 B`, or a bare
 * number meaning KB. Returns bytes, or null if it makes no sense.
 */
export function parseSize(text) {
  // One decimal point, not "as many digits and dots as you like": a loose
  // [\d.,]+ here read "1.2.3 MB" as 1.2 MB and converted to a limit the user
  // never asked for, rather than marking the field as wrong.
  const m = String(text ?? '').trim().toLowerCase()
    .match(/^([\d,]*\.?\d+)\s*(g|m|k|b|gb|mb|kb|bytes?)?$/);
  if (!m) return null;
  const value = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(value) || value <= 0) return null;
  const unit = (m[2] || 'kb').replace(/^bytes?$/, 'b');
  const scale = { b: 1, k: 1e3, kb: 1e3, m: 1e6, mb: 1e6, g: 1e9, gb: 1e9 }[unit];
  const bytes = Math.round(value * scale);
  return bytes >= 1000 ? bytes : null;   // below 1 KB is never achievable
}
