// Wrapping a JPEG in a one-page PDF.
//
// A port of jpeg_to_pdf() in src/convertly/convert.py. The JPEG's own bytes
// are embedded with /DCTDecode, so the image is never recompressed -- a PDF
// made here holds exactly the picture the user looked at.

export class PdfWriteError extends Error {}

const PAGE_W = 612.0;      // US Letter, in points
const PAGE_H = 792.0;
const MARGIN = 18.0;

/** [width, height, components] read from the JPEG's frame header. */
export function jpegSize(jpeg) {
  const view = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
  let i = 2;   // skip SOI
  while (i < view.length - 9) {
    if (view[i] !== 0xFF) { i += 1; continue; }
    const marker = view[i + 1];
    // Standalone markers carry no length field.
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      i += 2;
      continue;
    }
    const length = (view[i + 2] << 8) | view[i + 3];
    // SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      const height = (view[i + 5] << 8) | view[i + 6];
      const width = (view[i + 7] << 8) | view[i + 8];
      return [width, height, view[i + 9]];
    }
    i += 2 + length;
  }
  throw new PdfWriteError('Could not read image dimensions');
}

const ascii = s => new TextEncoder().encode(s);

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A one-page PDF holding this JPEG, scaled to fit a Letter page. */
export function jpegToPdf(jpeg) {
  const bytes = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
  const [width, height, comps] = jpegSize(bytes);
  const colorspace = { 1: '/DeviceGray', 3: '/DeviceRGB', 4: '/DeviceCMYK' }[comps] || '/DeviceRGB';

  // Page follows the image's orientation, image is scaled to fit inside it.
  const [pageW, pageH] = height >= width ? [PAGE_W, PAGE_H] : [PAGE_H, PAGE_W];
  const scale = Math.min((pageW - 2 * MARGIN) / width, (pageH - 2 * MARGIN) / height);
  const drawW = width * scale, drawH = height * scale;
  const offX = (pageW - drawW) / 2, offY = (pageH - drawH) / 2;

  const content = ascii(
    `q ${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${offX.toFixed(2)} ${offY.toFixed(2)} cm /Im0 Do Q\n`
  );

  const objects = [
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
    ),
    concat([
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace ${colorspace} /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${bytes.length} >>`
      ),
      ascii('\nstream\n'), bytes, ascii('\nendstream'),
    ]),
    concat([
      ascii(`<< /Length ${content.length} >>`),
      ascii('\nstream\n'), content, ascii('endstream'),
    ]),
  ];

  const parts = [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A,
                                 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])];   // %PDF-1.4 + binary marker
  const offsets = [];
  let at = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(at);
    const chunk = concat([ascii(`${index + 1} 0 obj\n`), body, ascii('\nendobj\n')]);
    parts.push(chunk);
    at += chunk.length;
  });

  const xrefAt = at;
  const rows = ['0000000000 65535 f \n'];
  for (const offset of offsets) {
    rows.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  }
  parts.push(ascii(
    `xref\n0 ${objects.length + 1}\n` + rows.join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`
  ));

  return concat(parts);
}
