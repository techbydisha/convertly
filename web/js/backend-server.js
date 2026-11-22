// The macOS app's backend: the work is done by the local server.
//
// Same questions as backend-local.js, answered by posting to server.py, which
// has sips, Quick Look and Microsoft Word to call on -- so it takes TIFF and
// Word files the browser cannot, and its JPEGs come from Apple's encoder.
//
// The server only ever listens on this machine and refuses requests from any
// other origin; see SECURITY.md. Nothing here can reach anywhere else either:
// the page's policy allows connections to its own origin and no other.

import { kindOf } from './kinds.js';

async function post(path, body, headers = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });
  if (!res.ok) throw new Error((await res.text()) || `Error ${res.status}`);
  return res;
}

const named = file => ({ 'X-Filename': encodeURIComponent(file.name) });

/** Several files in one request: each prefixed by its 4-byte length. */
function framed(files) {
  const parts = [];
  for (const f of files) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, f.size, false);
    parts.push(len, f);
  }
  return new Blob(parts);
}

function query(settings) {
  const q = new URLSearchParams({ format: settings.format, quality: String(settings.quality ?? 85) });
  if (settings.maxPx) q.set('max_px', String(settings.maxPx));
  if (settings.targetBytes) q.set('target', String(settings.targetBytes));
  return q;
}

const pictures = new WeakMap();

export const backend = {
  name: 'server',
  place: 'this Mac',
  placeShort: 'your Mac',
  how: 'Convertly does the work on your own Mac, in a program running there. '
     + 'Your photos and documents are never sent over the internet — not to us, '
     + 'not to anyone — so there is no copy anywhere for someone else to open.',

  /** The Mac takes every kind Convertly knows, Word and TIFF included. */
  refuse: name => (kindOf(name) ? null : 'Unsupported file type'),

  async convert(file, settings) {
    const res = await post(`/convert?${query(settings)}`, file, named(file));
    const blob = await res.blob();
    const note = res.headers.get('X-Note');
    return {
      blob,
      name: decodeURIComponent(res.headers.get('X-Out-Name') || 'converted'),
      note: note ? decodeURIComponent(note) : null,
    };
  },

  async pageCount(blob) {
    return (await (await post('/pdf/info', blob)).json()).pages;
  },

  async merge(files) {
    const res = await post('/pdf/build', framed(files),
      { 'X-Ranges': encodeURIComponent(JSON.stringify(files.map(() => ''))) });
    return res.blob();
  },

  async removePages(file, spec) {
    const res = await post('/pdf/build?mode=remove', framed([file]),
      { 'X-Ranges': encodeURIComponent(JSON.stringify([spec])) });
    return res.blob();
  },

  /** A picture of an image, Word or iWork file, drawn by sips or Quick Look. */
  picture(file, px) {
    let sizes = pictures.get(file);
    if (!sizes) { sizes = new Map(); pictures.set(file, sizes); }
    if (!sizes.has(px)) {
      const made = post(`/preview?px=${px}`, file, named(file)).then(async res => {
        if (res.status !== 200) throw new Error('no preview');
        return URL.createObjectURL(await res.blob());
      });
      sizes.set(px, made);
      made.catch(() => sizes.delete(px));
    }
    return sizes.get(px);
  },

  /**
   * The size of the real result, from the real encoder. An estimate from the
   * browser's encoder would describe a file this app will never produce.
   */
  async estimate(file, format, quality) {
    if (kindOf(file.name) !== 'image') return null;
    try {
      return (await backend.convert(file, { format, quality })).blob.size;
    } catch {
      return null;
    }
  },

  forget(file) {
    const sizes = pictures.get(file);
    if (sizes) {
      for (const p of sizes.values()) p.then(u => URL.revokeObjectURL(u), () => {});
      pictures.delete(file);
    }
  },
};
