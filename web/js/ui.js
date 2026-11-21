// The page's behaviour.
//
// Deliberately close to the macOS app's interface (src/convertly/web/
// index.html), because it is the same product: the same options in the same
// order, the same rows, the same wording. The difference is underneath --
// where that one posts the file to a local server, this converts it here.

import { convertFile } from './convert.js';
import { acceptAttribute, unsupportedReason, extOf, kindOf, isLossless } from './kinds.js';
import { decodeImage } from './decode.js';
import { humanSize, parseSize } from './sizes.js';

const $ = id => document.getElementById(id);
const drop = $('drop'), picker = $('picker'), list = $('list');
const quality = $('quality'), qval = $('qval');
const convertBtn = $('convert'), downloadAllBtn = $('downloadAll');
const resizeSel = $('resize'), targetSel = $('target'), targetCustom = $('targetCustom');

let format = 'jpg';
let items = [];
let running = false;

picker.setAttribute('accept', acceptAttribute());

const badge = name => (extOf(name) || 'file').toUpperCase().slice(0, 5);

// --- adding files ---------------------------------------------------------

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
// Don't let a stray drop navigate the page away.
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

function add(files) {
  for (const file of files) {
    const reason = unsupportedReason(file.name);
    const item = {
      file,
      // A file this build can't do gets a row saying why, not a silent skip:
      // "Word documents need the macOS app" is worth reading.
      status: reason ? 'unsupported' : 'ready',
      error: reason,
      thumbUrl: null, resultUrl: null, outName: null, outSize: 0, note: null,
    };
    item.row = buildRow(item);
    list.appendChild(item.row);
    items.push(item);
    if (!reason) loadThumb(item);
  }
  render();
}

// --- one row --------------------------------------------------------------

function buildRow(item) {
  const row = document.createElement('li');
  row.innerHTML = `
    <div class="thumb"><span class="ext"></span></div>
    <div class="info"><div class="name"></div><div class="sub2"></div></div>
    <div class="act"></div>
    <button type="button" class="remove" title="Remove" aria-label="Remove">&times;</button>`;
  row.querySelector('.ext').textContent = badge(item.file.name);
  row.querySelector('.name').textContent = item.file.name;
  row.querySelector('.remove').onclick = () => removeItem(item);
  return row;
}

function removeItem(item) {
  release(item);
  item.row.remove();
  items = items.filter(i => i !== item);
  render();
}

function release(item) {
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
  item.thumbUrl = item.resultUrl = null;
}

// --- thumbnails -----------------------------------------------------------

// A HEIC has to be fully decoded before any of it can be seen, which is the
// expensive part of converting it. Two at a time keeps a dropped folder of
// photos from making the page unusable while they all decode at once.
const THUMB_PX = 96;
let thumbActive = 0;
const thumbQueue = [];

function loadThumb(item) {
  thumbQueue.push(item);
  pumpThumbs();
}

function pumpThumbs() {
  while (thumbActive < 2 && thumbQueue.length) {
    const item = thumbQueue.shift();
    if (!items.includes(item)) continue;
    thumbActive++;
    makeThumb(item).finally(() => { thumbActive--; pumpThumbs(); });
  }
}

async function makeThumb(item) {
  if (kindOf(item.file.name) !== 'image') return;        // nothing to draw yet
  let bitmap = null;
  try {
    bitmap = await decodeImage(item.file);
    if (!items.includes(item)) return;                   // removed while we worked
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
    if (!blob || !items.includes(item)) return;
    item.thumbUrl = URL.createObjectURL(blob);
    showThumb(item, item.thumbUrl);
  } catch (_) {
    // No preview: the row keeps its file-type badge. Whether the file can be
    // converted is decided when Convert is pressed, not here.
  } finally {
    // The full-size pixels are the expensive thing to hold on to: a dozen
    // 12-megapixel photos is half a gigabyte. Dropped now, decoded again at
    // conversion time.
    bitmap?.close?.();
  }
}

function showThumb(item, url) {
  const thumb = item.row.querySelector('.thumb');
  thumb.innerHTML = '';
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  thumb.appendChild(img);
  thumb.classList.add('clickable');
  thumb.title = 'Open a bigger preview';
  thumb.onclick = () => window.open(item.resultUrl || url, '_blank');
}

// --- rendering ------------------------------------------------------------

function renderRow(item) {
  const sub = item.row.querySelector('.sub2');
  const act = item.row.querySelector('.act');
  const name = item.row.querySelector('.name');
  sub.className = 'sub2';
  act.innerHTML = '';

  if (item.status === 'ready') {
    name.textContent = item.file.name;
    sub.textContent = `${badge(item.file.name)} · ${humanSize(item.file.size)}`;
  } else if (item.status === 'converting') {
    sub.textContent = 'Converting…';
    act.appendChild(Object.assign(document.createElement('span'), { className: 'spinner' }));
  } else if (item.status === 'done') {
    name.textContent = item.outName;
    sub.textContent = '';
    sub.append(humanSize(item.file.size));
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    sub.append(arrow, humanSize(item.outSize));
    if (item.note) { sub.className = 'sub2 warn'; sub.append(` · ${item.note}`); }
    act.appendChild(button('dl', 'Download', () => save(item)));
  } else if (item.status === 'unsupported') {
    name.textContent = item.file.name;
    sub.className = 'sub2 err';
    sub.textContent = item.error;
  } else {
    name.textContent = item.file.name;
    sub.className = 'sub2 err';
    sub.textContent = item.error;
    act.appendChild(button('btn', 'Retry', () => { item.status = 'ready'; render(); convertAll(); }));
  }
}

function button(cls, text, onclick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

function render() {
  items.forEach(renderRow);
  const pending = items.filter(i => i.status === 'ready' || i.status === 'error').length;
  const done = items.filter(i => i.status === 'done').length;

  $('listhead').classList.toggle('hidden', items.length === 0);
  $('actions').classList.toggle('hidden', items.length === 0);
  $('count').textContent = items.length
    ? `${items.length} file${items.length > 1 ? 's' : ''}${done ? ` · ${done} converted` : ''}`
    : '';

  convertBtn.disabled = running || pending === 0;
  convertBtn.textContent = running
    ? 'Converting…'
    : pending === 0 && done
      ? `Converted to ${format.toUpperCase()}`
      : `Convert ${pending} file${pending === 1 ? '' : 's'} to ${format.toUpperCase()}`;
  downloadAllBtn.classList.toggle('hidden', done < 2);
  $('options').classList.toggle('locked', running);
  $('options2').classList.toggle('locked', running);
}

// --- options --------------------------------------------------------------

$('formats').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn || running) return;
  format = btn.dataset.fmt;
  [...e.currentTarget.children].forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  syncOptions();
  invalidate();
});
quality.addEventListener('input', () => { qval.value = quality.value; });
quality.addEventListener('change', invalidate);

function targetBytes() {
  if (targetSel.value === 'custom') return parseSize(targetCustom.value);
  return targetSel.value ? Number(targetSel.value) : null;
}

function syncOptions() {
  const custom = targetSel.value === 'custom';
  targetCustom.classList.toggle('hidden', !custom);
  if (custom) targetCustom.classList.toggle('bad', !parseSize(targetCustom.value));
  const target = targetBytes();
  resizeSel.classList.toggle('set', !!resizeSel.value);
  targetSel.classList.toggle('set', !!targetSel.value);
  // Two reasons the slider can stop applying, and they are different things,
  // so the readout says which: PNG keeps every pixel and has no quality to
  // set at all, while a size budget picks the best quality that fits for you.
  const lossless = isLossless(format);
  $('qualityBox').classList.toggle('off', lossless || !!target);
  $('qualityBox').title = lossless
    ? 'PNG keeps every pixel, so there is no quality to choose'
    : target
      ? 'With a size limit, the best quality that fits is chosen for you'
      : '';
  qval.value = lossless ? 'n/a' : target ? 'auto' : quality.value;
}

[resizeSel, targetSel].forEach(el => el.addEventListener('change', () => {
  syncOptions();
  invalidate();
}));
targetCustom.addEventListener('input', syncOptions);
targetCustom.addEventListener('change', invalidate);

function invalidate() {
  // Settings changed, so previous results no longer match what's selected.
  // Nothing re-converts until Convert is pressed again.
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

// --- converting -----------------------------------------------------------

convertBtn.onclick = () => convertAll();

// Which settings a batch was started with. A format changed mid-run would
// otherwise leave earlier rows holding the previous format's file while the
// controls say something else -- the exact bug this guards against on the Mac.
let generation = 0;

async function convertAll() {
  if (running) return;
  running = true;
  const mine = ++generation;
  const settings = {
    format,
    // A budget searches for the best quality that fits, so it needs headroom
    // above the slider's value rather than the slider's value itself.
    quality: targetBytes() ? 95 : Number(quality.value),
    maxPx: resizeSel.value ? Number(resizeSel.value) : null,
    targetBytes: targetBytes(),
  };
  render();
  try {
    for (const item of items) {
      if (generation !== mine) return;
      if (item.status !== 'ready' && item.status !== 'error') continue;
      item.status = 'converting';
      renderRow(item);
      // Let the row and its spinner paint before the next file ties up the
      // main thread encoding.
      await new Promise(r => setTimeout(r, 0));
      await convertOne(item, settings);
      renderRow(item);
    }
  } finally {
    if (generation === mine) {
      running = false;
      render();
    }
  }
}

async function convertOne(item, settings) {
  try {
    const { blob, name, note } = await convertFile(item.file, settings);
    if (!items.includes(item)) return;
    if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    item.resultUrl = URL.createObjectURL(blob);
    item.outName = name;
    item.outSize = blob.size;
    item.note = note;
    item.status = 'done';
    // Show the converted image itself, so what you see is what downloads.
    if (blob.type === 'image/jpeg') showThumb(item, item.resultUrl);
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

downloadAllBtn.onclick = async () => {
  for (const item of items.filter(i => i.status === 'done')) {
    save(item);
    await new Promise(r => setTimeout(r, 250));   // browsers dislike bursts
  }
};

$('clear').onclick = () => {
  generation++;                 // abandon a run in progress
  items.forEach(release);
  items = [];
  thumbQueue.length = 0;
  list.innerHTML = '';
  render();
};

syncOptions();
render();

window.addEventListener('pagehide', () => items.forEach(release));
