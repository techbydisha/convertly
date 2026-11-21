// The browser build, checked against the shared behaviour spec.
//
// These are the same cases tests/test_shared_spec.py runs against the Python
// build. Neither suite restates them: both read shared/spec/, so a change to
// user-visible behaviour has to be made in one place and satisfied in two.
//
//   node --test web/tests/
//
// Everything tested here is pure logic, which is why it runs in Node with no
// browser involved. The canvas and WebAssembly parts cannot be, and are
// checked in a real browser instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { stemOf, convertedName, extractName, removedName, splitExt,
         COMBINED_NAME, FALLBACK_STEM } from '../js/naming.js';
import { humanSize, parseSize } from '../js/sizes.js';
import { kindOf, canHandle, unsupportedReason, OUTPUT_FORMATS, INPUT_EXTS,
         LOSSLESS_FORMATS, isLossless } from '../js/kinds.js';

const spec = name => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../shared/spec/${name}.json`, import.meta.url)), 'utf8'));

const names = spec('output-names');
const sizes = spec('file-sizes');
const kinds = spec('file-kinds');
const ranges = spec('page-ranges');

// --- output names ---------------------------------------------------------

test('converted names match the spec', () => {
  for (const c of names.converted) {
    assert.equal(convertedName(c.input, c.ext), c.name,
      `${JSON.stringify(c.input)} + ${c.ext}${c.why ? ` (${c.why})` : ''}`);
  }
});

test('extracted-page names match the spec', () => {
  for (const c of names.extracted) {
    assert.equal(extractName(c.input, c.spec), c.name,
      `${JSON.stringify(c.input)} with ${JSON.stringify(c.spec)}`);
  }
});

test('removed-page names match the spec', () => {
  for (const c of names.removed) {
    assert.equal(removedName(c.input, c.spec), c.name,
      `${JSON.stringify(c.input)} minus ${JSON.stringify(c.spec)}`);
  }
});

test('the spec and the code agree on the constants', () => {
  assert.equal(COMBINED_NAME, names.combined_name);
  assert.equal(FALLBACK_STEM, names.fallback_stem);
});

test('a name is never a path', () => {
  for (const nasty of ['../../etc/passwd.heic', '/etc/passwd.heic', 'C:\\windows\\evil.png',
                       'a/b/../c.png', './../x.png']) {
    const produced = convertedName(nasty, 'jpg');
    assert.ok(!/[\\/]/.test(produced), `${nasty} produced ${produced}`);
    assert.ok(!produced.startsWith('.'), `${nasty} produced ${produced}`);
  }
});

test('a name always has something before the extension', () => {
  for (const empty of ['', '.', '..', '...', '   ', '/', '\\', '/.', '\u0000']) {
    assert.equal(convertedName(empty, 'jpg'), `${FALLBACK_STEM}.jpg`, JSON.stringify(empty));
  }
});

// splitExt is the piece most likely to drift from Python's os.path.splitext,
// and a disagreement there changes which files each build accepts.
test('splitExt follows os.path.splitext', () => {
  const cases = [
    ['photo.heic', ['photo', 'heic']],
    ['a.b.c.png', ['a.b.c', 'png']],
    ['noext', ['noext', '']],
    ['.heic', ['.heic', '']],          // a hidden file, not a HEIC
    ['..heic', ['..heic', '']],
    ['.a.heic', ['.a', 'heic']],
    ['a.', ['a', '']],
    ['', ['', '']],
    ['dir/photo.heic', ['photo', 'heic']],
  ];
  for (const [input, want] of cases) {
    assert.deepEqual(splitExt(input), want, JSON.stringify(input));
  }
});

// --- sizes ----------------------------------------------------------------

test('sizes are shown as the spec says', () => {
  for (const c of sizes.cases) {
    assert.equal(humanSize(c.bytes), c.text,
      `${c.bytes} bytes${c.why ? ` (${c.why})` : ''}`);
  }
});

test('rounding is half up, not half to even', () => {
  // The case that caught a real disagreement between the two builds: Python's
  // round() gave "2 KB" here while JavaScript's Math.round gave "3 KB".
  assert.equal(humanSize(2500), '3 KB');
  assert.equal(humanSize(1500), '2 KB');
  assert.equal(humanSize(3500), '4 KB');
});

test('typed sizes are read as the spec says', () => {
  for (const c of sizes.typed.accepted) {
    assert.equal(parseSize(c.text), c.bytes,
      `${JSON.stringify(c.text)}${c.why ? ` (${c.why})` : ''}`);
  }
});

test('a size that cannot be read is refused, not guessed at', () => {
  for (const c of sizes.typed.refused) {
    assert.equal(parseSize(c.text), null,
      `${JSON.stringify(c.text)}${c.why ? ` (${c.why})` : ''}`);
  }
});

// --- file kinds -----------------------------------------------------------

test('files are classified as the spec says', () => {
  for (const c of kinds.cases) {
    assert.equal(kindOf(c.name), c.kind,
      `${JSON.stringify(c.name)}${c.why ? ` (${c.why})` : ''}`);
  }
});

test('output formats match the spec', () => {
  const fromSpec = Object.fromEntries(kinds.output_formats.map(f => [f.format, f.extension]));
  assert.deepEqual(OUTPUT_FORMATS, fromSpec);
});

test('lossless formats match the spec', () => {
  assert.deepEqual([...LOSSLESS_FORMATS].sort(), [...kinds.lossless_formats.formats].sort());
});

test('a lossless format is a real output format, and the flag agrees', () => {
  for (const fmt of LOSSLESS_FORMATS) {
    assert.ok(fmt in OUTPUT_FORMATS, `${fmt} is not an output format`);
    assert.equal(isLossless(fmt), true);
  }
  // The per-format "lossless" flag in the spec and the list must not disagree.
  for (const f of kinds.output_formats) {
    assert.equal(isLossless(f.format), Boolean(f.lossless), f.format);
  }
  assert.equal(isLossless('jpg'), false);
});

test('what this build supports matches what the spec claims for it', () => {
  const support = kinds.browser_support;
  // Every kind marked unsupported must be refused, with a reason that says so.
  for (const [kind, supported] of Object.entries(support)) {
    if (kind === 'note') continue;
    const examples = kinds.cases.filter(c => c.kind === kind).map(c => c.name);
    assert.ok(examples.length, `the spec has no example of kind ${kind}`);
    if (supported) {
      assert.ok(examples.some(canHandle),
        `${kind} is marked supported but no example of it can be handled`);
    } else {
      for (const name of examples) {
        assert.equal(canHandle(name), false, `${name} should be refused here`);
        assert.match(unsupportedReason(name), /macOS app/,
          `${name} should be refused with a reason that points somewhere useful`);
      }
    }
  }
});

test('a refusal always explains itself', () => {
  for (const ext of [...INPUT_EXTS, 'zip', 'exe', 'tiff']) {
    const reason = unsupportedReason(`x.${ext}`);
    if (reason !== null) {
      assert.ok(reason.length > 10 && /[a-z]/.test(reason), `${ext}: ${reason}`);
    }
  }
  assert.equal(unsupportedReason('a.zip'), 'Unsupported file type');
});

// --- not ported yet -------------------------------------------------------

// Page ranges are now covered for real, in pdfedit.test.mjs, against the same
// file. This only guards the link between them.
test('page ranges are covered by the PDF engine suite', () => {
  assert.ok(ranges.valid.length > 0 && ranges.invalid.length > 0,
    'shared/spec/page-ranges.json should hold both accepted and refused cases');
});
