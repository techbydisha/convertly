// The interface.
//
// One idea runs through it: the thing you came to do is the thing you pick
// first. "Get this under 1 MB" is a task, not a setting buried under a
// dropdown, so Compress and Resize are tools of their own rather than options
// on a conversion screen. Underneath, each one is still the same convertFile()
// the macOS app's server calls, with different arguments.

import { convertFile } from './convert.js';
import { build, buildWithout, pageCount, parseRanges, invertRanges, PdfError } from './pdfedit.js';
import { removedName, COMBINED_NAME } from './naming.js';
import { acceptAttribute, unsupportedReason, extOf, kindOf, isLossless } from './kinds.js';
import { decodeImage } from './decode.js';
import { encodedSize } from './fit.js';
import { humanSize, parseSize } from './sizes.js';

const $ = id => document.getElementById(id);

const IMAGE_TYPES = 'HEIC · PNG · JPEG · GIF · BMP · WebP';
const REPO = 'https://github.com/techbydisha/convertly';

const TOOLS = {
  convert: {
    title: 'Convert',
    blurb: 'Turn photos and documents into JPG, PNG or PDF. Everything happens on your device.',
    types: IMAGE_TYPES + ' · PDF · Pages',
    panel: 'opt-convert',
    action: 'Convert',
  },
  compress: {
    title: 'Compress',
    blurb: 'Get a picture under a size limit — for the upload that only allows 1 MB.',
    types: IMAGE_TYPES,
    panel: 'opt-compress',
    action: 'Compress',
  },
  resize: {
    title: 'Resize',
    blurb: 'Cap the longest edge, keeping the shape of the picture exactly as it was.',
    types: IMAGE_TYPES,
    panel: 'opt-resize',
    action: 'Resize',
  },
  merge: {
    title: 'Merge',
    blurb: 'Join PDFs into one document, in the order you choose.',
    types: 'PDF only',
    panel: 'opt-merge',
    action: 'Merge into one',
    pdf: true,
  },
  edit: {
    title: 'Edit',
    blurb: 'Remove the pages you do not want, and keep the rest.',
    types: 'PDF only',
    panel: 'opt-edit',
    action: 'Remove pages',
    pdf: true,
  },
};

const PANELS = ['opt-convert', 'opt-compress', 'opt-resize', 'opt-merge', 'opt-edit'];

const isPdfTool = () => Boolean(TOOLS[current].pdf);

let current = 'convert';
let items = [];
let running = false;
let generation = 0;

$('picker').setAttribute('accept', acceptAttribute());

const badge = name => (extOf(name) || 'file').toUpperCase().slice(0, 5);

// --- which tool ------------------------------------------------------------

function showTool(name) {
  current = TOOLS[name] ? name : 'convert';
  const spec = TOOLS[current];

  $('title').textContent = spec.title;
  $('blurb').textContent = spec.blurb;
  $('types').textContent = spec.types;
  PANELS.forEach(id => $(id).classList.toggle('hidden', id !== spec.panel));

  $('soon-banner').classList.toggle('hidden', !spec.soon);
  if (spec.soon) $('soon-text').innerHTML = spec.soon;

  [...$('nav').children].forEach(b =>
    b.setAttribute('aria-current', String(b.dataset.tool === current)));

  if (location.hash.slice(1) !== current) history.replaceState(null, '', '#' + current);

  clearResults();
  items.forEach(checkSpec);
  invalidate();
  scheduleEstimate();
}

$('nav').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (btn && !running) showTool(btn.dataset.tool);
});
window.addEventListener('hashchange', () => showTool(location.hash.slice(1)));

// --- what the chosen tool asks the converter for ---------------------------

function pickedChip(groupId, attr) {
  const on = $(groupId).querySelector('.chip[aria-pressed="true"]');
  return on ? Number(on.dataset[attr]) : null;
}

function chosenFormat() {
  const on = $('formats').querySelector('.chip[aria-pressed="true"]');
  return on ? on.dataset.fmt : 'jpg';
}

function targetBytes() {
  if ($('targetCustom').value.trim()) return parseSize($('targetCustom').value);
  return pickedChip('targets', 'bytes');
}

function maxPx() {
  const typed = $('edgeCustom').value.trim();
  if (typed) {
    const px = parseInt(typed, 10);
    return Number.isFinite(px) && px > 0 ? px : null;
  }
  return pickedChip('edges', 'px');
}

/**
 * The arguments for one file under the current tool.
 *
 * Resize keeps a PNG a PNG, because the point of resizing a logo is not to
 * lose it to JPEG. Compress always produces a JPG, because a lossless format
 * has no quality to trade and could only meet a limit by shrinking — which is
 * what Resize is for, and saying so beats quietly doing it.
 */
function settingsFor(file) {
  if (current === 'compress') {
    return { format: 'jpg', quality: 95, maxPx: null, targetBytes: targetBytes() };
  }
  if (current === 'resize') {
    return {
      format: extOf(file.name) === 'png' ? 'png' : 'jpg',
      quality: Number($('quality').value),
      maxPx: maxPx(),
      targetBytes: null,
    };
  }
  return {
    format: chosenFormat(),
    quality: Number($('quality').value),
    maxPx: null,
    targetBytes: null,
  };
}

/** Whether the current tool has enough to act on. */
function ready() {
  if (current === 'compress') return targetBytes() !== null;
  if (current === 'resize') return maxPx() !== null;
  if (current === 'merge') {
    const usable = items.filter(i => i.pages !== null && i.status !== 'unsupported');
    return usable.length >= 2;
  }
  if (current === 'edit') {
    const usable = items.filter(i => i.pages !== null && i.status !== 'unsupported');
    return usable.length > 0
      && usable.every(i => !i.specError)
      && usable.some(i => (i.spec || '').trim());
  }
  return true;
}

/** Why the button is off, when the reason is worth saying out loud. */
function blockedReason() {
  if (running || items.length === 0) return null;
  const usable = items.filter(i => i.pages !== null && i.status !== 'unsupported');
  if (current === 'merge' && usable.length === 1) return 'Add another PDF to merge with';
  if (current === 'edit' && usable.length && !usable.some(i => (i.spec || '').trim())) {
    return 'Type which pages to remove';
  }
  if (current === 'compress' && targetBytes() === null) return 'Choose a size limit';
  if (current === 'resize' && maxPx() === null) return 'Choose a size';
  return null;
}

// --- results (Merge makes one file out of many) -------------------------

let results = [];

function clearResults() {
  results.forEach(r => URL.revokeObjectURL(r.url));
  results = [];
  $('results').innerHTML = '';
  $('resultBox').classList.add('hidden');
}

function showResult(blob, name) {
  const url = URL.createObjectURL(blob);
  results.push({ url, name });
  const row = document.createElement('li');
  row.className = 'file';
  row.innerHTML = `
    <div class="thumb"><span class="ext">PDF</span></div>
    <div class="meta"><div class="name"></div><div class="sub"></div></div>
    <div class="act"></div>`;
  row.querySelector('.name').textContent = name;
  row.querySelector('.sub').textContent = humanSize(blob.size);
  const dl = document.createElement('button');
  dl.type = 'button'; dl.className = 'dl'; dl.textContent = 'Download';
  dl.onclick = () => {
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
  };
  row.querySelector('.act').appendChild(dl);
  $('results').appendChild(row);
  $('resultBox').classList.remove('hidden');
}

// --- adding files ----------------------------------------------------------

const drop = $('drop'), picker = $('picker');
$('choose').onclick = e => { e.stopPropagation(); picker.click(); };
drop.addEventListener('click', () => picker.click());
drop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); }
});
picker.addEventListener('change', () => { add([...picker.files]); picker.value = ''; });

['dragenter', 'dragover'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => add([...e.dataTransfer.files]));
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

function add(files) {
  for (const file of files) {
    // The PDF tools take PDFs and nothing else; saying so beats a row that
    // fails later for a reason the user has to guess at.
    const reason = isPdfTool()
      ? (kindOf(file.name) === 'pdf' ? null : `${TOOLS[current].title} works on PDFs only`)
      : unsupportedReason(file.name);
    items.push({
      file,
      // A file this build can't do gets a row saying why, not a silent skip.
      status: reason ? 'unsupported' : 'ready',
      error: reason,
      row: null,
      thumbUrl: null, resultUrl: null, outName: null, outSize: 0, note: null,
      bitmap: null, estimate: null,
      pages: null, spec: '', specError: null,
    });
  }
  render();
  prepare();
}

function release(item) {
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
  item.thumbUrl = item.resultUrl = null;
  item.bitmap?.close?.();
  item.bitmap = null;
}

// --- thumbnails, and the pixels the estimate reuses ------------------------

const THUMB_PX = 96;

// A decoded photo is big — a 12-megapixel one is about 48 MB of pixels — and
// an honest estimate needs them at full size. So they are kept, but only up to
// a budget; past it the estimate steps aside rather than the page filling a
// phone's memory.
const PIXEL_BUDGET = 48e6;
const FILE_BUDGET = 4;

let preparing = false;

async function prepare() {
  if (preparing) return;
  preparing = true;
  try {
    for (const item of items) {
      if (item.status === 'unsupported') continue;

      if (kindOf(item.file.name) === 'pdf' && item.pages === null && item.error === null) {
        try {
          item.pages = pageCount(new Uint8Array(await item.file.arrayBuffer()));
        } catch (err) {
          item.status = 'error';
          item.error = err instanceof PdfError ? err.message : "Couldn't read this PDF";
        }
        render();
        continue;
      }
      if (item.thumbUrl) continue;
      if (kindOf(item.file.name) !== 'image') continue;

      let bitmap = null;
      try {
        bitmap = await decodeImage(item.file);
      } catch {
        continue;      // whether it converts is decided when you press the button
      }
      if (!items.includes(item)) { bitmap.close?.(); continue; }

      const scale = Math.min(1, THUMB_PX * 2 / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8));
      canvas.width = canvas.height = 0;

      if (blob && items.includes(item)) {
        item.thumbUrl = URL.createObjectURL(blob);
        showThumb(item, item.thumbUrl);
      }
      if (items.includes(item) && withinBudget(bitmap)) item.bitmap = bitmap;
      else bitmap.close?.();
    }
  } finally {
    preparing = false;
    scheduleEstimate();
  }
}

function withinBudget(bitmap) {
  const kept = items.filter(i => i.bitmap);
  if (kept.length >= FILE_BUDGET) return false;
  const used = kept.reduce((n, i) => n + i.bitmap.width * i.bitmap.height, 0);
  return used + bitmap.width * bitmap.height <= PIXEL_BUDGET;
}

function showThumb(item, url) {
  const thumb = item.row?.querySelector('.thumb');
  if (!thumb) return;
  thumb.innerHTML = '';
  const img = document.createElement('img');
  img.src = url; img.alt = '';
  thumb.appendChild(img);
  thumb.classList.add('clickable');
  thumb.title = 'Open a bigger preview';
  thumb.onclick = () => window.open(item.resultUrl || url, '_blank');
}

// --- what it will actually weigh -------------------------------------------
//
// Not a guess: the picture is encoded at the chosen setting and the result
// measured. That is cheap enough to do while the slider moves — a 1600×1200
// JPEG encodes in about 11 ms — so the number beside it is the real one.

let estimateRun = 0;
let estimateTimer = null;

function scheduleEstimate() {
  clearTimeout(estimateTimer);
  const box = $('qest');
  const measurable = items.filter(i => i.bitmap && i.status !== 'unsupported');
  // Only Convert has a setting to weigh; a PDF's size is the JPEG plus a
  // wrapper, which would be a more confusing number than a helpful one.
  if (current !== 'convert' || chosenFormat() === 'pdf' || measurable.length === 0) {
    box.classList.add('hidden');
    items.forEach(i => { i.estimate = null; });
    return;
  }
  box.classList.remove('hidden');
  box.classList.add('working');
  box.textContent = 'measuring…';
  estimateTimer = setTimeout(runEstimate, 140);   // not once per slider pixel
}

async function runEstimate() {
  const mine = ++estimateRun;
  const format = chosenFormat();
  const quality = Number($('quality').value);
  for (const item of items) {
    if (!item.bitmap) continue;
    try {
      const bytes = await encodedSize(item.bitmap, format, quality);
      if (mine !== estimateRun) return;          // a newer run has started
      item.estimate = bytes;
    } catch {
      item.estimate = null;
    }
  }
  if (mine !== estimateRun) return;

  const measured = items.filter(i => i.estimate);
  const total = measured.reduce((n, i) => n + i.estimate, 0);
  const box = $('qest');
  box.classList.remove('working');
  box.textContent = measured.length > 1
    ? `about ${humanSize(total)} in total`
    : humanSize(total);
  render();
}

// --- rows ------------------------------------------------------------------

function buildRow(item) {
  const row = document.createElement('li');
  row.className = 'file';
  row.innerHTML = `
    <div class="thumb"><span class="ext"></span></div>
    <div class="meta"><div class="name"></div><div class="sub"></div></div>
    <div class="tool"></div>
    <div class="act"></div>
    <button type="button" class="x" title="Remove" aria-label="Remove">&times;</button>`;
  row.querySelector('.ext').textContent = badge(item.file.name);
  row.querySelector('.x').onclick = () => {
    release(item);
    items = items.filter(i => i !== item);
    render();
    scheduleEstimate();
  };
  return row;
}

function move(item, delta) {
  const i = items.indexOf(item);
  const j = i + delta;
  if (j < 0 || j >= items.length) return;
  items.splice(j, 0, items.splice(i, 1)[0]);
  // Re-appending in the new order is what actually reorders the list.
  const list = $('list');
  items.forEach(it => it.row && list.appendChild(it.row));
  clearResults();
  render();
}

/** The per-row control a PDF tool needs: order for Merge, pages for Edit. */
function fillRowTool(item) {
  const box = item.row.querySelector('.tool');
  box.innerHTML = '';
  if (item.status === 'unsupported' || item.error && item.pages === null) return;

  if (current === 'merge' && items.length > 1) {
    const arrows = document.createElement('div');
    arrows.className = 'arrows';
    const i = items.indexOf(item);
    for (const [label, delta, title, disabled] of [
      ['\u25B2', -1, 'Move up', i === 0],
      ['\u25BC', 1, 'Move down', i === items.length - 1],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.disabled = disabled || running;
      b.onclick = () => move(item, delta);
      arrows.appendChild(b);
    }
    box.appendChild(arrows);
    return;
  }

  if (current === 'edit') {
    // The word before the box, so the box cannot be read the wrong way round.
    // "2-4" sitting on its own is just as readable as "keep these".
    const label = document.createElement('span');
    label.className = 'drop-label';
    label.textContent = 'drop';
    box.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field pages-field';
    input.placeholder = 'e.g. 2-4';
    input.setAttribute('aria-label', `Pages to remove from ${item.file.name}`);
    input.value = item.spec;
    input.disabled = running;
    input.oninput = () => {
      item.spec = input.value;
      checkSpec(item);
      input.classList.toggle('bad', Boolean(item.specError));
      clearResults();
      fillRow(item);
      renderActions();
    };
    box.appendChild(input);
  }
}

/** Validate what was typed against this file's real page count, as you type. */
function checkSpec(item) {
  item.specError = null;
  const typed = (item.spec || '').trim();
  if (!typed || item.pages === null) return;
  try {
    invertRanges(typed, item.pages);
  } catch (err) {
    item.specError = err instanceof PdfError ? err.message : 'Not a page range';
  }
}

function fillRow(item) {
  fillRowTool(item);
  const sub = item.row.querySelector('.sub');
  const act = item.row.querySelector('.act');
  const name = item.row.querySelector('.name');
  sub.className = 'sub';
  act.innerHTML = '';

  if (item.status === 'ready') {
    name.textContent = item.file.name;
    if (isPdfTool()) {
      if (item.specError) {
        sub.className = 'sub err';
        sub.textContent = item.specError;
      } else {
        const pages = item.pages === null
          ? 'reading…'
          : `${item.pages} page${item.pages > 1 ? 's' : ''}`;
        const typed = (item.spec || '').trim();
        const left = current === 'edit' && typed && item.pages !== null
          ? ` · ${invertRanges(typed, item.pages).length} left`
          : '';
        sub.textContent = `${pages} · ${humanSize(item.file.size)}${left}`;
      }
      return;
    }
    sub.textContent = `${badge(item.file.name)} · ${humanSize(item.file.size)}`;
    if (item.estimate) {
      const to = document.createElement('span');
      to.className = 'to'; to.textContent = '→';
      const est = document.createElement('span');
      est.className = 'est-inline'; est.textContent = humanSize(item.estimate);
      sub.append(to, est);
    }
  } else if (item.status === 'working') {
    name.textContent = item.file.name;
    sub.textContent = 'Working…';
    act.appendChild(Object.assign(document.createElement('span'), { className: 'spinner' }));
  } else if (item.status === 'done') {
    name.textContent = item.outName;
    sub.textContent = '';
    sub.append(humanSize(item.file.size));
    const to = document.createElement('span');
    to.className = 'to'; to.textContent = '→';
    sub.append(to, humanSize(item.outSize));
    if (item.note) { sub.className = 'sub warn'; sub.append(` · ${item.note}`); }
    const dl = document.createElement('button');
    dl.type = 'button'; dl.className = 'dl'; dl.textContent = 'Download';
    dl.onclick = () => save(item);
    act.appendChild(dl);
  } else {
    name.textContent = item.file.name;
    sub.className = 'sub err';
    sub.textContent = item.error;
    if (item.status === 'error') {
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'ghost'; retry.textContent = 'Retry';
      retry.onclick = () => { item.status = 'ready'; render(); run(); };
      act.appendChild(retry);
    }
  }
}

function render() {
  const list = $('list');
  for (const item of items) {
    if (!item.row) {
      item.row = buildRow(item);
      if (item.thumbUrl) showThumb(item, item.thumbUrl);
    }
    if (item.row.parentNode !== list) list.appendChild(item.row);
    fillRow(item);
  }
  [...list.children].forEach(row => {
    if (!items.some(i => i.row === row)) row.remove();
  });

  const pending = items.filter(i => i.status === 'ready' || i.status === 'error').length;
  const done = items.filter(i => i.status === 'done').length;

  $('files').classList.toggle('hidden', items.length === 0);
  $('count').textContent = items.length
    ? `${items.length} file${items.length > 1 ? 's' : ''}${done ? ` · ${done} done` : ''}`
    : '';

  renderActions();
  PANELS.forEach(id => $(id).classList.toggle('locked', running));
}

function renderActions() {
  const pending = items.filter(i => i.status === 'ready' || i.status === 'error').length;
  const done = items.filter(i => i.status === 'done').length;
  const go = $('go');
  const blocked = blockedReason();
  go.disabled = running || items.length === 0 || !ready();
  go.textContent = running
    ? 'Working…'
    : blocked ? blocked
    : (current !== 'merge' && pending === 0 && done) ? 'Done'
    : TOOLS[current].action;
  $('downloadAll').classList.toggle('hidden', done < 2);
}

// --- options ---------------------------------------------------------------

function chipGroup(id, after) {
  $(id).addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip || running) return;
    [...$(id).querySelectorAll('.chip')].forEach(c =>
      c.setAttribute('aria-pressed', String(c === chip)));
    if (after) after();
    invalidate();
  });
}

function clearChips(id) {
  [...$(id).querySelectorAll('.chip')].forEach(c => c.setAttribute('aria-pressed', 'false'));
}

chipGroup('formats', () => { syncFormat(); scheduleEstimate(); });
chipGroup('targets', () => { $('targetCustom').value = ''; $('targetCustom').classList.remove('bad'); });
chipGroup('edges',   () => { $('edgeCustom').value = ''; $('edgeCustom').classList.remove('bad'); });

$('targetCustom').addEventListener('input', () => {
  const typed = $('targetCustom').value.trim();
  if (typed) clearChips('targets');
  $('targetCustom').classList.toggle('bad', !!typed && parseSize(typed) === null);
  render();
});
$('targetCustom').addEventListener('change', invalidate);

$('edgeCustom').addEventListener('input', () => {
  const typed = $('edgeCustom').value.trim();
  if (typed) clearChips('edges');
  const px = parseInt(typed, 10);
  $('edgeCustom').classList.toggle('bad', !!typed && !(Number.isFinite(px) && px > 0));
  render();
});
$('edgeCustom').addEventListener('change', invalidate);

$('quality').addEventListener('input', () => {
  if ($('qval').value !== 'n/a') $('qval').value = $('quality').value;
  scheduleEstimate();
});
$('quality').addEventListener('change', invalidate);

function syncFormat() {
  const format = chosenFormat();
  // PNG keeps every pixel, so there is no quality to choose — the readout has
  // to say that rather than sit there doing nothing.
  const lossless = isLossless(format);
  $('qbox').classList.toggle('off', lossless);
  $('qbox').title = lossless ? 'PNG keeps every pixel, so there is no quality to choose' : '';
  $('qval').value = lossless ? 'n/a' : $('quality').value;
  $('fmt-note').textContent =
    format === 'png'
      ? 'PNG keeps every pixel. Best for screenshots, logos and anything with transparency — expect photographs to come out larger than the JPEG they came from.'
      : format === 'pdf'
        ? 'The picture is placed on a page at the quality you choose, and embedded without being compressed a second time.'
        : 'JPG is right for photographs. PNG keeps every pixel — better for screenshots and logos, but larger.';
}

function invalidate() {
  // Settings changed, so earlier results no longer match what is selected.
  // Nothing re-runs until the button is pressed again.
  for (const item of items) {
    if (item.status !== 'done') continue;
    if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    item.resultUrl = null;
    item.outName = null;
    item.note = null;
    item.status = 'ready';
    if (item.thumbUrl) showThumb(item, item.thumbUrl);
  }
  render();
}

// --- doing the work --------------------------------------------------------

$('go').onclick = () => run();

async function run() {
  if (running || !ready()) return;
  running = true;
  const mine = ++generation;
  clearResults();
  render();
  try {
    if (current === 'merge') { await runMerge(); return; }
    if (current === 'edit') { await runEdit(); return; }
    for (const item of items) {
      if (generation !== mine) return;
      if (item.status !== 'ready' && item.status !== 'error') continue;
      item.status = 'working';
      fillRow(item);
      await new Promise(r => setTimeout(r, 0));   // let the spinner paint
      await one(item);
      fillRow(item);
    }
  } finally {
    if (generation === mine) {
      running = false;
      render();
    }
  }
}

/** Every usable PDF, joined in list order, as one file. */
async function runMerge() {
  const usable = items.filter(i => i.pages !== null && i.status !== 'unsupported');
  try {
    const parts = [];
    for (const item of usable) {
      parts.push([new Uint8Array(await item.file.arrayBuffer()), '']);
    }
    const merged = build(parts);
    showResult(new Blob([merged], { type: 'application/pdf' }), COMBINED_NAME);
    for (const item of usable) {
      item.status = 'ready';
      item.note = null;
    }
  } catch (err) {
    const message = err instanceof PdfError ? err.message : 'These PDFs could not be merged';
    for (const item of usable) { item.status = 'error'; item.error = message; }
  }
}

/** Each PDF loses the pages named on its own row, and keeps the rest. */
async function runEdit() {
  for (const item of items) {
    if (item.pages === null || item.status === 'unsupported') continue;
    const typed = (item.spec || '').trim();
    if (!typed) continue;                    // nothing asked of this one
    item.status = 'working';
    fillRow(item);
    await new Promise(r => setTimeout(r, 0));
    try {
      const data = new Uint8Array(await item.file.arrayBuffer());
      const made = buildWithout([[data, typed]]);
      const kept = invertRanges(typed, item.pages);
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
      const blob = new Blob([made], { type: 'application/pdf' });
      item.resultUrl = URL.createObjectURL(blob);
      item.outName = removedName(item.file.name, typed);
      item.outSize = blob.size;
      item.note = `${item.pages - kept.length} removed, ${kept.length} kept`;
      item.status = 'done';
    } catch (err) {
      item.status = 'error';
      item.error = err instanceof PdfError ? err.message : "Couldn't edit this PDF";
    }
    fillRow(item);
  }
}

async function one(item) {
  try {
    const { blob, name, note } = await convertFile(item.file, settingsFor(item.file));
    if (!items.includes(item)) return;
    if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    item.resultUrl = URL.createObjectURL(blob);
    item.outName = name;
    item.outSize = blob.size;
    item.note = note;
    item.status = 'done';
    // Show the result itself, so what you see is what downloads.
    if (blob.type === 'image/jpeg' || blob.type === 'image/png') showThumb(item, item.resultUrl);
    else if (item.thumbUrl) showThumb(item, item.thumbUrl);
  } catch (err) {
    item.status = 'error';
    item.error = err?.message || "Couldn't read this file";
  }
}

function save(item) {
  const a = document.createElement('a');
  a.href = item.resultUrl;
  a.download = item.outName;
  a.click();
}

$('downloadAll').onclick = async () => {
  for (const item of items.filter(i => i.status === 'done')) {
    save(item);
    await new Promise(r => setTimeout(r, 250));   // browsers dislike bursts
  }
};

$('clear').onclick = () => {
  generation++;
  estimateRun++;
  items.forEach(release);
  items = [];
  $('list').innerHTML = '';
  $('qest').classList.add('hidden');
  clearResults();
  render();
};

// --- the privacy badge explains itself -------------------------------------

const promise = $('promise'), pop = $('promisePop');
function setPop(open) {
  pop.hidden = !open;
  promise.setAttribute('aria-expanded', String(open));
}
promise.addEventListener('click', e => { e.stopPropagation(); setPop(pop.hidden); });
promise.addEventListener('mouseenter', () => setPop(true));
pop.addEventListener('mouseleave', () => setPop(false));
document.addEventListener('click', e => { if (!e.target.closest('.promise-wrap')) setPop(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setPop(false); });

// --- start -----------------------------------------------------------------

syncFormat();
showTool(location.hash.slice(1) || 'convert');

window.addEventListener('pagehide', () => items.forEach(release));
