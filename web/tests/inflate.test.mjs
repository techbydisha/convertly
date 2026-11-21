// The synchronous inflate, checked against the thing it has to agree with.
//
// This is the one piece of the PDF engine that is new code rather than a port,
// so it is not tested by reasoning about it. Python compresses, JavaScript
// decompresses, and the bytes must match — across compression levels,
// strategies and data that exercises every block type DEFLATE has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { inflate, inflateRaw, InflateError } from '../js/inflate.js';

let pythonAvailable = true;
try {
  execFileSync('python3', ['-c', 'import zlib'], { stdio: 'ignore' });
} catch {
  pythonAvailable = false;
}

/** Ask Python to zlib-compress these exact bytes. */
function compress(bytes, { level = 6, raw = false, strategy = 'Z_DEFAULT_STRATEGY' } = {}) {
  const out = execFileSync('python3', ['-c', `
import base64, sys, zlib
data = base64.b64decode(sys.stdin.read())
c = zlib.compressobj(${level}, zlib.DEFLATED, ${raw ? -15 : 15}, 9, zlib.${strategy})
sys.stdout.write(base64.b64encode(c.compress(data) + c.flush()).decode())
`], { input: Buffer.from(bytes).toString('base64'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return new Uint8Array(Buffer.from(out, 'base64'));
}

// --- the sample data -------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function samples() {
  const made = [];
  made.push(['empty', new Uint8Array(0)]);
  made.push(['one byte', new Uint8Array([42])]);
  made.push(['all zeros 100k', new Uint8Array(100_000)]);

  // Incompressible: forces stored blocks.
  const noise = new Uint8Array(70_000);
  const r1 = rng(7);
  for (let i = 0; i < noise.length; i++) noise[i] = (r1() * 256) | 0;
  made.push(['random noise', noise]);

  // Highly repetitive: long back-references, including distance 1.
  made.push(['repeated byte run', new Uint8Array(50_000).fill(0xAB)]);

  const text = new TextEncoder().encode(
    'obj endobj stream endstream /Type /Page /Kids /Count 12 0 R '.repeat(3000));
  made.push(['pdf-ish text', text]);

  // A small alphabet, which pushes the dynamic Huffman path hard.
  const narrow = new Uint8Array(40_000);
  const r2 = rng(99);
  for (let i = 0; i < narrow.length; i++) narrow[i] = r2() < 0.5 ? 0 : 1;
  made.push(['two symbols', narrow]);

  // Mixed structure, like a real cross-reference stream.
  const mixed = new Uint8Array(30_000);
  const r3 = rng(1234);
  for (let i = 0; i < mixed.length; i++) {
    mixed[i] = i % 7 === 0 ? (r3() * 256) | 0 : (i % 251);
  }
  made.push(['structured', mixed]);

  // Every byte value, in order and reversed.
  const ramp = new Uint8Array(256 * 40);
  for (let i = 0; i < ramp.length; i++) ramp[i] = i % 256;
  made.push(['byte ramp', ramp]);

  return made;
}

// --- the tests -------------------------------------------------------------

test('matches Python zlib across levels and data', { skip: pythonAvailable ? false : 'python3 not available' }, () => {
  for (const [label, data] of samples()) {
    for (const level of [0, 1, 6, 9]) {
      const packed = compress(data, { level });
      const got = inflate(packed);
      assert.deepEqual(Buffer.from(got), Buffer.from(data), `${label} at level ${level}`);
    }
  }
});

test('handles every DEFLATE strategy', { skip: pythonAvailable ? false : 'python3 not available' }, () => {
  const data = samples().find(s => s[0] === 'structured')[1];
  for (const strategy of ['Z_DEFAULT_STRATEGY', 'Z_FILTERED', 'Z_HUFFMAN_ONLY', 'Z_RLE', 'Z_FIXED']) {
    const got = inflate(compress(data, { strategy }));
    assert.deepEqual(Buffer.from(got), Buffer.from(data), strategy);
  }
});

test('reads raw deflate with no zlib header', { skip: pythonAvailable ? false : 'python3 not available' }, () => {
  const data = new TextEncoder().encode('/Root 1 0 R /Size 9 '.repeat(500));
  const got = inflateRaw(compress(data, { raw: true }));
  assert.deepEqual(Buffer.from(got), Buffer.from(data));
});

test('a thousand random round-trips', { skip: pythonAvailable ? false : 'python3 not available' }, () => {
  // Generated in one Python call rather than a thousand, then each one checked.
  const blob = execFileSync('python3', ['-c', `
import base64, random, sys, zlib
random.seed(20261121)
parts = []
for i in range(1000):
    n = random.randint(0, 3000)
    mode = i % 4
    if mode == 0:
        data = bytes(random.getrandbits(8) for _ in range(n))
    elif mode == 1:
        data = bytes(random.choice(b'AB \\n') for _ in range(n))
    elif mode == 2:
        data = (b'page ' * (n // 5 + 1))[:n]
    else:
        data = bytes((j * 7) % 256 for j in range(n))
    packed = zlib.compress(data, random.randint(0, 9))
    parts.append(base64.b64encode(data).decode() + ':' + base64.b64encode(packed).decode())
sys.stdout.write('\\n'.join(parts))
`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

  let checked = 0;
  for (const line of blob.split('\n')) {
    const [wantB64, packedB64] = line.split(':');
    const want = Buffer.from(wantB64, 'base64');
    const got = Buffer.from(inflate(new Uint8Array(Buffer.from(packedB64, 'base64'))));
    assert.deepEqual(got, want, `round-trip ${checked}`);
    checked++;
  }
  assert.equal(checked, 1000);
});

test('truncated input returns what decoded, as the Python side does', { skip: pythonAvailable ? false : 'python3 not available' }, () => {
  const data = new TextEncoder().encode('X'.repeat(20_000) + 'tail');
  const packed = compress(data);
  const cut = packed.slice(0, Math.floor(packed.length * 0.6));
  const got = inflate(cut);
  assert.ok(got.length > 0, 'should salvage something');
  assert.ok(got.length < data.length, 'should not invent the rest');
  assert.deepEqual(Buffer.from(got), Buffer.from(data.subarray(0, got.length)),
    'what came back must be a true prefix, not corruption');
});

test('refuses a decompression bomb instead of exhausting memory', () => {
  // 50 MB of zeros compresses to a few kilobytes.
  const zeros = new Uint8Array(50 * 1024 * 1024);
  const packed = pythonAvailable ? compress(zeros, { level: 9 }) : null;
  if (!packed) return;
  assert.throws(() => inflate(packed, { limit: 1024 * 1024 }), InflateError);
  // The real ceiling lets it through, so the limit is what refused it.
  assert.equal(inflate(packed).length, zeros.length);
});

test('garbage is rejected, not silently accepted', () => {
  assert.deepEqual(inflate(new Uint8Array(0)), new Uint8Array(0));
  // A valid-looking zlib header followed by an impossible block type.
  assert.throws(() => inflate(new Uint8Array([0x78, 0x9c, 0x07, 0x00])), InflateError);
});
