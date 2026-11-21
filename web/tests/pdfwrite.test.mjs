// The image-to-PDF writer, checked against the Python one byte for byte.
//
// This is a port of byte-offset arithmetic -- a PDF's cross-reference table is
// a list of positions into the file, and getting one wrong produces a file
// that some readers open and others reject. Rather than assert that the output
// "looks like a PDF", each case is handed to the original implementation as
// well and the two outputs must be identical. A port either matches or it does
// not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { jpegToPdf, jpegSize, PdfWriteError } from '../js/pdfwrite.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * A JPEG that is only a header: enough for both implementations to read the
 * dimensions out of, which is all either of them reads.
 */
function fakeJpeg(width, height, components = 3, { app0 = true } = {}) {
  const parts = [[0xFF, 0xD8]];
  if (app0) {
    parts.push([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
                0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  }
  const sof = [0xFF, 0xC0, 0x00, 8 + components * 3, 0x08,
               (height >> 8) & 0xFF, height & 0xFF,
               (width >> 8) & 0xFF, width & 0xFF,
               components];
  for (let c = 1; c <= components; c++) sof.push(c, 0x11, 0x00);
  parts.push(sof, [0xFF, 0xD9]);
  return new Uint8Array(parts.flat());
}

function pythonPdf(jpeg) {
  const out = execFileSync('python3', ['-c', `
import base64, sys
sys.path.insert(0, ${JSON.stringify(SRC)})
from convertly.convert import jpeg_to_pdf
sys.stdout.write(base64.b64encode(jpeg_to_pdf(base64.b64decode(sys.stdin.read()))).decode())
`], { input: Buffer.from(jpeg).toString('base64'), encoding: 'utf8' });
  return new Uint8Array(Buffer.from(out, 'base64'));
}

let pythonAvailable = true;
try {
  execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' });
} catch {
  pythonAvailable = false;
}

test('dimensions are read out of the frame header', () => {
  assert.deepEqual(jpegSize(fakeJpeg(100, 50)), [100, 50, 3]);
  assert.deepEqual(jpegSize(fakeJpeg(4032, 3024)), [4032, 3024, 3]);
  assert.deepEqual(jpegSize(fakeJpeg(7, 9, 1)), [7, 9, 1]);
  assert.deepEqual(jpegSize(fakeJpeg(64, 64, 4)), [64, 64, 4]);
  // No APP0 ahead of the frame: the scan must not depend on it being there.
  assert.deepEqual(jpegSize(fakeJpeg(21, 34, 3, { app0: false })), [21, 34, 3]);
});

test('a file with no frame header is refused, not guessed at', () => {
  assert.throws(() => jpegSize(new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])), PdfWriteError);
  assert.throws(() => jpegSize(new Uint8Array(40)), PdfWriteError);
});

test('the cross-reference table points at the objects it claims', () => {
  const pdf = jpegToPdf(fakeJpeg(1200, 900));
  const text = new TextDecoder('latin1').decode(pdf);

  const startxref = Number(/startxref\s+(\d+)/.exec(text)[1]);
  assert.ok(text.startsWith('%PDF-1.4'), 'no PDF header');
  assert.equal(text.slice(startxref, startxref + 4), 'xref', 'startxref misses the table');

  const rows = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
  assert.equal(rows.length, 5, 'expected five objects');
  rows.forEach((offset, index) => {
    assert.equal(text.slice(offset, offset + 7), `${index + 1} 0 obj`,
      `object ${index + 1} is not at the offset the table gives`);
  });
});

test('the page follows the picture: portrait stays portrait', () => {
  const portrait = new TextDecoder('latin1').decode(jpegToPdf(fakeJpeg(900, 1200)));
  const landscape = new TextDecoder('latin1').decode(jpegToPdf(fakeJpeg(1200, 900)));
  assert.match(portrait, /MediaBox \[0 0 612\.00 792\.00\]/);
  assert.match(landscape, /MediaBox \[0 0 792\.00 612\.00\]/);
});

test('the JPEG goes in untouched, not re-encoded', () => {
  const jpeg = fakeJpeg(300, 200);
  const pdf = jpegToPdf(jpeg);
  const haystack = new TextDecoder('latin1').decode(pdf);
  const needle = new TextDecoder('latin1').decode(jpeg);
  assert.ok(haystack.includes(needle), 'the original bytes are not in the PDF');
  assert.match(haystack, /\/Filter \/DCTDecode/);
  assert.match(haystack, new RegExp(`/Length ${jpeg.length} `));
});

test('colour space follows the component count', () => {
  const read = n => new TextDecoder('latin1').decode(jpegToPdf(fakeJpeg(10, 10, n)));
  assert.match(read(1), /\/ColorSpace \/DeviceGray/);
  assert.match(read(3), /\/ColorSpace \/DeviceRGB/);
  assert.match(read(4), /\/ColorSpace \/DeviceCMYK/);
});

test('output is identical to the Python writer', { skip: pythonAvailable ? false : 'python3 not available' }, () => {
  const cases = [
    [1200, 900, 3], [900, 1200, 3], [1000, 1000, 3],
    [4032, 3024, 3], [7, 9, 1], [64, 64, 4], [1, 1, 3], [3, 65535, 3],
  ];
  for (const [w, h, comps] of cases) {
    const jpeg = fakeJpeg(w, h, comps);
    assert.deepEqual(
      Buffer.from(jpegToPdf(jpeg)),
      Buffer.from(pythonPdf(jpeg)),
      `${w}x${h}, ${comps} component(s)`,
    );
  }
});
