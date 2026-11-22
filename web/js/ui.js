// The interface, for both apps.
//
// The hosted page and the macOS app run this same file. What differs is the
// backend: the hosted page does the work here (backend-local.js), the macOS
// app hands it to its local server (backend-server.js). The page says which
// with <meta name="convertly-backend">, which server.py adds when it serves
// this page.
//
// The flow it is built around: add files and see them arrive; set what you
// want; check the result in the review pane; and download last, from there,
// once you have seen what you are keeping.

import { parseRanges, PdfError } from './pdfedit.js';
import { humanSize, parseSize } from './sizes.js';
import { kindOf, extOf, isLossless } from './kinds.js';
import { removedName, COMBINED_NAME } from './naming.js';
import { renderPage, renderedPageCount, forget } from './render.js';

const which = document.querySelector('meta[name="convertly-backend"]')?.content === 'server'
  ? './backend-server.js' : './backend-local.js';
const { backend } = await import(which);

const $ = id => document.getElementById(id);

// --- the five tools --------------------------------------------------------

const IMAGES = backend.name === 'server'
  ? 'HEIC · PNG · JPEG · TIFF · GIF · BMP · WebP'
  : 'HEIC · PNG · JPEG · GIF · BMP · WebP';
const DOCUMENTS = backend.name === 'server' ? ' · PDF · Word · Pages' : ' · PDF · Pages';

const TOOLS = {
  convert: {
    title: 'Convert', action: 'Convert', noun: 'pictures and documents',
    blurb: 'Turn photos and documents into JPG, PNG or PDF.',
    types: IMAGES + DOCUMENTS,
  },
  compress: {
    title: 'Compress', action: 'Compress', noun: 'pictures and PDFs',
    blurb: 'Get a picture or a PDF under a size limit — for the upload that only allows 1 MB.',
    types: IMAGES + ' · PDF',
  },
  resize: {
    title: 'Resize', action: 'Resize', noun: 'pictures',
    blurb: 'Cap the longest edge, keeping the shape of the picture exactly as it was.',
    types: IMAGES,
  },
  merge: {
    title: 'Merge', action: 'Merge into one', noun: 'PDFs', pdf: true,
    blurb: 'Join PDFs into one document, in the order you choose.',
    types: 'PDF only',
  },
  edit: {
    title: 'Edit', action: 'Remove pages', noun: 'PDFs', pdf: true,
    blurb: 'Take out the pages you do not want, and keep the rest.',
    types: 'PDF only',
  },
};

const EXTS = {
  image: ['heic', 'heif', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', ...(backend.name === 'server' ? ['tif', 'tiff'] : [])],
  pdf: ['pdf'],
  documents: [...(backend.name === 'server' ? ['doc', 'docx', 'rtf'] : []), 'pages', 'key', 'numbers'],
};

function acceptFor(tool) {
  const list = tool === 'convert' ? [...EXTS.image, ...EXTS.pdf, ...EXTS.documents]
    : tool === 'compress' ? [...EXTS.image, ...EXTS.pdf]
    : tool === 'resize' ? EXTS.image
    : EXTS.pdf;
  return list.map(e => `.${e}`).join(',');
}

/** Why this tool cannot take this file, or null if it can. */
function refusal(tool, name) {
  const kind = kindOf(name);
  if (TOOLS[tool].pdf) return kind === 'pdf' ? null : `${TOOLS[tool].title} works on PDFs`;
  if (tool === 'resize' && kind !== 'image') return 'Resize works on pictures';
  if (tool === 'compress' && kind !== 'image' && kind !== 'pdf') return 'Compress works on pictures and PDFs';
  return backend.refuse(name);
}

// --- state -----------------------------------------------------------------

const state = {
  tool: 'convert',
  items: [],
  selected: 0,
  view: 'original',          // 'original' | 'result' ; Edit uses 'pick' | 'result'
  frame: 0,
  merged: null,
  opts: { format: 'jpg', quality: 85, target: 1_000_000, targetText: '', edge: 1600, edgeText: '' },
  busy: false,
};
let nextId = 1;
let generation = 0;

function makeItem(file) {
  return {
    id: nextId++,
    file,
    kind: kindOf(file.name),
    addedAt: performance.now(),
    thumb: null,            // a URL, once drawn
    pages: null,            // for PDFs
    dropped: new Set(),     // Edit: pages to take out
    error: null,            // the file could not be read at all
    failed: null,           // the file was read, but this job failed on it
    working: false,
    estimate: null,
    result: null,           // { blob, url, size, name, note, kind, pages }
    source: SOURCE_SLOTS.next(),
  };
}

// Six colours, so Merge can show which file each page came from.
const SOURCE_SLOTS = { n: 0, next() { return this.n++ % 6; } };

const usable = () => state.items.filter(i => !i.error);
const selectedItem = () => state.items[state.selected] || null;
const keptPages = item => {
  const out = [];
  for (let p = 1; p <= (item.pages || 0); p++) if (!item.dropped.has(p)) out.push(p);
  return out;
};

// --- adding files ------------------------------------------------------------

function add(list) {
  const tool = TOOLS[state.tool];
  const fresh = [];
  const skipped = [];
  for (const file of list) {
    const why = refusal(state.tool, file.name);
    if (why) { skipped.push({ file, why }); continue; }
    const item = makeItem(file);
    state.items.push(item);
    fresh.push(item);
  }
  announce(fresh, skipped, tool);
  if (!fresh.length) return;
  clearResults();
  if (state.items.length === fresh.length) state.selected = 0;
  showWorkspace();
  renderAll();
  for (const item of fresh) prepare(item);
}

function announce(fresh, skipped, tool) {
  const files = n => `${n} file${n === 1 ? '' : 's'}`;
  // One reason, said once; several reasons, summed up honestly.
  const reasons = [...new Set(skipped.map(s => s.why))];
  const why = reasons.length === 1 ? reasons[0] : `${tool.title} works on ${tool.noun}`;
  if (fresh.length && skipped.length) toast(`${files(fresh.length)} added · ${skipped.length} skipped — ${why}`, true);
  else if (fresh.length) toast(`${files(fresh.length)} added`);
  else if (skipped.length === 1) toast(`${skipped[0].file.name}: ${why}`, true);
  else if (skipped.length) toast(`${files(skipped.length)} skipped — ${why}`, true);
}

/** Page count and a picture, read as soon as the row is on screen. */
async function prepare(item) {
  try {
    if (item.kind === 'pdf') {
      item.pages = await backend.pageCount(item.file);
      renderAll();
      item.thumb = await renderPage(item.file, 1, 46).catch(() => null);
    } else {
      item.thumb = await backend.picture(item.file, 96).catch(() => null);
    }
  } catch (err) {
    item.error = err instanceof PdfError || err?.message ? err.message : "Couldn't read this file";
  }
  if (!state.items.includes(item)) return;
  renderAll();
  scheduleEstimate();
}

function removeItem(item) {
  backend.forget(item.file);
  forget(item.file);
  if (item.result) { URL.revokeObjectURL(item.result.url); forget(item.result.blob); }
  const i = state.items.indexOf(item);
  state.items.splice(i, 1);
  if (!state.items.length) return startOver();
  state.selected = Math.min(state.selected, state.items.length - 1);
  clearResults();
  renderAll();
  scheduleEstimate();
}

function startOver() {
  generation++;
  state.busy = false;
  for (const item of state.items) {
    backend.forget(item.file);
    forget(item.file);
  }
  clearResults();
  state.items = [];
  state.selected = 0;
  closeReview();
  // Empty the hidden workspace too: its images point at URLs just revoked.
  for (const id of ['list', 'stage', 'strip', 'foot', 'viewSeg']) $(id).replaceChildren();
  $('work').classList.add('hidden');
  $('empty').classList.remove('hidden');
  renderGo();
}

function showWorkspace() {
  $('empty').classList.add('hidden');
  $('work').classList.remove('hidden');
}

let toastTimer = null;
function toast(text, warn = false) {
  $('toastText').textContent = text;
  $('toast').querySelector('.tick').textContent = warn ? '!' : '✓';
  $('toast').classList.toggle('warn', warn);
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), warn ? 4200 : 2400);
}

// --- the file list -----------------------------------------------------------

function renderList() {
  const ul = $('list');
  ul.innerHTML = '';
  const tool = state.tool;
  state.items.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'row' + (i === state.selected && tool !== 'merge' ? ' selected' : '');
    // Rows are rebuilt as thumbnails arrive. A new row keeps its highlight by
    // resuming the animation where it had got to, rather than restarting it.
    const age = performance.now() - item.addedAt;
    if (age < 1600) {
      li.classList.add('fresh');
      li.style.animationDelay = `${-age}ms`;
    }
    li.onclick = () => select(i);

    const thumb = document.createElement('div');
    thumb.className = 'thumb' + (item.kind === 'pdf' ? ' page' : '');
    if (item.thumb) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = item.thumb;
      thumb.appendChild(img);
    } else {
      thumb.textContent = (extOf(item.file.name) || 'file').toUpperCase().slice(0, 5);
    }
    li.appendChild(thumb);

    if (tool === 'merge') {
      const dot = document.createElement('span');
      dot.className = `srcdot src-${item.source}`;
      li.appendChild(dot);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.file.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    fillSub(sub, item);
    meta.append(name, sub);
    li.appendChild(meta);

    if (tool === 'merge' && state.items.length > 1) {
      const arrows = document.createElement('div');
      arrows.className = 'arrows';
      [['▲', -1, 'Move up', i === 0], ['▼', 1, 'Move down', i === state.items.length - 1]]
        .forEach(([glyph, d, title, off]) => {
          const b = document.createElement('button');
          b.type = 'button'; b.textContent = glyph; b.title = title;
          b.disabled = off || state.busy;
          b.onclick = e => { e.stopPropagation(); move(i, d); };
          arrows.appendChild(b);
        });
      li.appendChild(arrows);
    }

    if (item.working) {
      const sp = document.createElement('span');
      sp.className = 'spinner';
      li.appendChild(sp);
    }

    const x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.innerHTML = '&times;';
    x.title = 'Remove'; x.setAttribute('aria-label', `Remove ${item.file.name}`);
    x.disabled = state.busy;
    x.onclick = e => { e.stopPropagation(); removeItem(item); };
    li.appendChild(x);
    ul.appendChild(li);
  });
}

function fillSub(sub, item) {
  if (item.error) { sub.classList.add('err'); sub.textContent = item.error; return; }
  if (item.failed) { sub.classList.add('err'); sub.textContent = item.failed; return; }
  if (item.working) { sub.textContent = 'Working…'; return; }

  const size = humanSize(item.file.size);
  const pages = item.kind === 'pdf'
    ? (item.pages === null ? 'reading… · ' : `${item.pages} page${item.pages === 1 ? '' : 's'} · `)
    : `${(extOf(item.file.name) || 'file').toUpperCase()} · `;
  sub.textContent = pages + size;

  const arrow = text => {
    const to = document.createElement('span'); to.className = 'to'; to.textContent = '→';
    const ok = document.createElement('span'); ok.className = 'ok'; ok.textContent = text;
    sub.append(to, ok);
  };
  if (item.result) {
    arrow(humanSize(item.result.size));
    if (item.result.note && /^Could not/.test(item.result.note)) {
      sub.classList.add('warn');
      sub.append(` · ${item.result.note}`);
    }
  } else if (state.tool === 'edit' && item.dropped.size && item.pages) {
    sub.append(` · dropping ${item.dropped.size}, keeping ${item.pages - item.dropped.size}`);
  } else if (state.tool === 'convert' && item.estimate) {
    arrow(humanSize(item.estimate));
  }
}

function select(i) {
  state.selected = i;
  if (state.tool === 'edit') {
    state.view = selectedItem()?.result ? 'result' : 'pick';
    renderOptions();
  } else {
    const at = frames().findIndex(f => f.item === state.items[i]);
    if (at >= 0) state.frame = at;
  }
  renderList();
  renderReview();
  openReview();
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.items.length) return;
  [state.items[i], state.items[j]] = [state.items[j], state.items[i]];
  clearResults();
  state.frame = 0;
  renderAll();
}

// --- options: the minimum in words, the detail behind an ⓘ --------------------

function info(html) {
  return `<span class="info"><button type="button" aria-label="More about this">i</button>`
       + `<span class="tip" role="tooltip">${html}</span></span>`;
}

function chips(attr, values, current, label) {
  return values.map(v => `<button type="button" class="chip" data-${attr}="${v}" `
    + `aria-pressed="${String(v) === String(current)}">${label(v)}</button>`).join('');
}

function renderOptions() {
  const box = $('options');
  const o = state.opts;
  const t = state.tool;

  if (t === 'convert') {
    const lossless = isLossless(o.format);
    box.innerHTML = `
      <div class="panel-label">Convert to ${info(
        '<b>JPG</b> — best for photos.<br><b>PNG</b> — keeps every pixel: best for screenshots, logos and '
        + 'anything with transparency, but larger.<br><b>PDF</b> — each picture on a page of its own.')}</div>
      <div class="chips">${chips('fmt', ['jpg', 'jpeg', 'png', 'pdf'], o.format, v => v.toUpperCase())}</div>
      <div class="slider${lossless ? ' off' : ''}" id="qbox">
        <span class="quiet">Quality</span>
        <input type="range" id="quality" min="40" max="100" step="5" value="${o.quality}" aria-label="Quality"${lossless ? ' disabled' : ''}>
        <output id="qval">${lossless ? 'n/a' : o.quality}</output>
        <span class="est hidden" id="qest"></span>
        ${info(lossless
          ? 'PNG keeps every pixel, so there is no quality to choose. The number beside it is what the file will weigh.'
          : 'Lower quality, smaller file — around 80 is invisible to the eye for a photo. The number beside it is '
          + 'what the result will actually weigh, measured by making it.')}
      </div>`;
  } else if (t === 'compress') {
    box.innerHTML = `
      <div class="panel-label">Keep it under ${info(
        'Quality is lowered first, so the picture keeps its size; it is only made smaller if that is not enough. '
        + 'A picture comes out as a JPG. In a PDF, the photographs are re-encoded and the text is left exactly as it was.')}</div>
      <div class="chips">
        ${chips('target', [200000, 500000, 1000000, 2000000, 5000000], o.targetText ? '' : o.target, v => humanSize(v).replace('.0 ', ' '))}
        <input class="field custom${o.targetText && parseSize(o.targetText) === null ? ' bad' : ''}" id="targetCustom"
               placeholder="750 KB" aria-label="Custom size limit" value="${escapeAttr(o.targetText)}">
      </div>`;
  } else if (t === 'resize') {
    box.innerHTML = `
      <div class="panel-label">Longest edge ${info(
        'The shape is always kept, and a picture is never made bigger than it already is. '
        + 'A PNG stays a PNG; anything else comes out as a JPG.')}</div>
      <div class="chips">
        ${chips('edge', [4000, 2500, 1600, 1200, 800], o.edgeText ? '' : o.edge, v => `${v} px`)}
        <input class="field custom${o.edgeText && !validEdge(o.edgeText) ? ' bad' : ''}" id="edgeCustom"
               placeholder="1080 px" aria-label="Custom longest edge" value="${escapeAttr(o.edgeText)}">
      </div>`;
  } else if (t === 'merge') {
    box.innerHTML = `
      <div class="panel-label">Order ${info(
        'Pages are joined top to bottom. Move a file with its arrows, and check the result on the right before you merge. '
        + 'Pages keep their original quality — nothing is re-compressed.')}</div>
      <p class="quiet">${usable().length < 2 ? 'Add one more PDF to merge with.' : 'Top to bottom, as shown in the preview.'}</p>`;
  } else {
    const sel = selectedItem();
    const spec = sel && sel.pages ? formatRanges([...sel.dropped]) : '';
    box.innerHTML = `
      <div class="panel-label">Pages to drop ${info(
        'Easiest: <b>click the pages</b> in the preview.<br>Or type them here:'
        + '<table><tr><td><code>3</code></td><td>page 3</td></tr>'
        + '<tr><td><code>2-4</code></td><td>pages 2, 3 and 4</td></tr>'
        + '<tr><td><code>1,7-9</code></td><td>page 1 and pages 7 to 9</td></tr>'
        + '<tr><td><code>5-</code></td><td>page 5 to the end</td></tr></table>')}</div>
      <div class="field-row"><span class="drop-word">drop</span>
        <input class="field wide" id="spec" placeholder="click pages, or type e.g. 2-4"
               aria-label="Pages to drop" value="${escapeAttr(spec)}"></div>
      <div class="err-line" id="specErr"></div>`;
  }
  box.classList.toggle('locked', state.busy);
  wireOptions();
  scheduleEstimate();
}

const escapeAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const validEdge = text => { const n = parseInt(text, 10); return Number.isFinite(n) && n > 0 && /^\s*\d+\s*(px)?\s*$/i.test(text); };

function wireOptions() {
  const box = $('options');
  box.querySelectorAll('.info > button').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const was = b.parentElement.classList.contains('open');
    document.querySelectorAll('.info.open').forEach(i => i.classList.remove('open'));
    if (!was) b.parentElement.classList.add('open');
  });
  box.querySelectorAll('.chip').forEach(c => c.onclick = () => {
    if (c.dataset.fmt) state.opts.format = c.dataset.fmt;
    if (c.dataset.target) { state.opts.target = Number(c.dataset.target); state.opts.targetText = ''; }
    if (c.dataset.edge) { state.opts.edge = Number(c.dataset.edge); state.opts.edgeText = ''; }
    settingsChanged();
    renderOptions();
  });

  const q = $('quality');
  if (q) {
    q.oninput = () => {
      state.opts.quality = Number(q.value);
      $('qval').textContent = q.value;
      scheduleEstimate();
    };
    q.onchange = settingsChanged;
  }

  const custom = (id, key, valid) => {
    const field = $(id);
    if (!field) return;
    field.oninput = () => {
      state.opts[key] = field.value.trim();
      const ok = !state.opts[key] || valid(state.opts[key]);
      field.classList.toggle('bad', !ok);
      const fallback = key === 'targetText' ? state.opts.target : state.opts.edge;
      box.querySelectorAll('.chip').forEach(c => {
        const value = Number(c.dataset.target ?? c.dataset.edge);
        c.setAttribute('aria-pressed', String(!state.opts[key] && value === fallback));
      });
      settingsChanged();
    };
  };
  custom('targetCustom', 'targetText', t => parseSize(t) !== null);
  custom('edgeCustom', 'edgeText', validEdge);

  const spec = $('spec');
  if (spec) spec.oninput = () => {
    const sel = selectedItem();
    if (!sel || !sel.pages) return;
    const text = spec.value.trim();
    $('specErr').textContent = '';
    spec.classList.remove('bad');
    if (!text) {
      sel.dropped.clear();
    } else {
      try {
        const pages = new Set(parseRanges(text, sel.pages));
        if (pages.size >= sel.pages) throw new PdfError('That would remove every page');
        sel.dropped = pages;
      } catch (err) {
        spec.classList.add('bad');
        $('specErr').textContent = err.message;
        return;
      }
    }
    settingsChanged({ keepOptions: true });
  };
}

function formatRanges(nums) {
  nums.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
    i = j;
  }
  return out.join(',');
}

function targetBytes() {
  return state.opts.targetText ? parseSize(state.opts.targetText) : state.opts.target;
}
function maxPx() {
  return state.opts.edgeText ? (validEdge(state.opts.edgeText) ? parseInt(state.opts.edgeText, 10) : null) : state.opts.edge;
}

/** Anything changed: earlier results no longer match what is selected. */
function settingsChanged({ keepOptions = false } = {}) {
  clearResults();
  renderList();
  renderReview();
  renderGo();
  if (!keepOptions) scheduleEstimate();
}

// --- what it will actually weigh (Convert) -------------------------------------
//
// Measured, not estimated: the picture is encoded at the chosen setting and the
// bytes counted, by the encoder that will produce the real file.

let estimateRun = 0;
let estimateTimer = null;
const ESTIMATE_FILES = 4;

function scheduleEstimate() {
  clearTimeout(estimateTimer);
  const box = $('qest');
  const pictures = state.items.filter(i => i.kind === 'image' && !i.error);
  if (!box || state.tool !== 'convert' || state.opts.format === 'pdf' || !pictures.length) {
    box?.classList.add('hidden');
    let changed = false;
    state.items.forEach(i => { if (i.estimate) { i.estimate = null; changed = true; } });
    if (changed) renderList();
    return;
  }
  box.classList.remove('hidden');
  box.classList.add('working');
  box.textContent = 'measuring…';
  estimateTimer = setTimeout(runEstimate, backend.name === 'server' ? 220 : 140);
}

async function runEstimate() {
  const mine = ++estimateRun;
  const { format, quality } = state.opts;
  const pictures = state.items.filter(i => i.kind === 'image' && !i.error).slice(0, ESTIMATE_FILES);
  for (const item of pictures) {
    const size = await backend.estimate(item.file, format, quality).catch(() => null);
    if (mine !== estimateRun) return;
    item.estimate = size;
  }
  if (mine !== estimateRun) return;
  const measured = pictures.filter(i => i.estimate);
  const box = $('qest');
  if (!box) return;
  if (!measured.length) { box.classList.add('hidden'); return; }
  const total = measured.reduce((n, i) => n + i.estimate, 0);
  box.classList.remove('working');
  box.textContent = measured.length > 1 ? `about ${humanSize(total)} in total` : humanSize(total);
  renderList();
}

// --- the button ---------------------------------------------------------------

function ready() {
  const files = usable();
  if (!files.length) return false;
  if (state.tool === 'compress') return targetBytes() !== null;
  if (state.tool === 'resize') return maxPx() !== null;
  if (state.tool === 'merge') return files.filter(i => i.pages).length >= 2;
  if (state.tool === 'edit') return files.some(i => i.dropped.size);
  return true;
}

function blockedReason() {
  const files = usable();
  if (state.tool === 'merge' && files.length < 2) return 'Add another PDF to merge with';
  if (state.tool === 'edit' && files.length && !files.some(i => i.dropped.size)) return 'Pick pages to drop';
  if (state.tool === 'compress' && targetBytes() === null) return 'Choose a size limit';
  if (state.tool === 'resize' && maxPx() === null) return 'Choose a size';
  return null;
}

function finished() {
  if (state.tool === 'merge') return Boolean(state.merged);
  const files = usable();
  if (state.tool === 'edit') return files.some(i => i.result) && files.filter(i => i.dropped.size).every(i => i.result);
  return files.length > 0 && files.every(i => i.result || i.failed);
}

function renderGo() {
  const go = $('go');
  const note = $('doneNote');
  const done = finished() && !state.busy;
  // Before any early return: a button disabled while working must come back,
  // or "Start over" silently stops working the moment a job finishes.
  $('reset').disabled = state.busy;
  // Finished. Beside a side panel, say where the result is. On a phone the
  // button reopens the sheet, because that is where Download lives.
  const sheet = isNarrow();
  note.classList.toggle('hidden', !(done && !sheet));
  go.classList.toggle('hidden', done && !sheet);
  if (done) {
    $('doneText').textContent = 'Done — check the result on the right, then download.';
    go.disabled = false;
    go.textContent = 'Review & download';
    go.dataset.review = '1';
    return;
  }
  delete go.dataset.review;
  const why = state.busy ? null : blockedReason();
  const count = usable().length;
  go.disabled = state.busy || !ready();
  go.textContent = state.busy ? 'Working…'
    : why || `${TOOLS[state.tool].action}${count > 1 && !TOOLS[state.tool].pdf ? ` ${count} files` : ''}`;
}

// --- the review pane --------------------------------------------------------------

function frames() {
  const t = state.tool;
  const files = usable();
  if (t === 'merge') {
    const out = [];
    if (state.merged) {
      // The pages of the real merged file, labelled with where each came from.
      let n = 0;
      for (const { item, pages } of state.merged.sources) {
        for (let p = 1; p <= pages; p++) out.push({ blob: state.merged.blob, page: ++n, from: item });
      }
    } else {
      for (const item of files) {
        for (let p = 1; p <= (item.pages || 0); p++) out.push({ blob: item.file, page: p, from: item });
      }
    }
    return out;
  }
  if (t === 'edit') {
    const sel = selectedItem();
    if (!sel || sel.error || !sel.pages) return [];
    const kept = keptPages(sel);
    return sel.result
      ? kept.map((was, i) => ({ blob: sel.result.blob, page: i + 1, was, item: sel }))
      : kept.map(was => ({ blob: sel.file, page: was, was, item: sel }));
  }
  const out = [];
  for (const item of files) {
    const result = state.view === 'result' && item.result;
    if (result && item.result.kind === 'image') {
      out.push({ url: item.result.url, item, photo: true });
    } else if (result) {
      const n = item.result.pages || 1;
      for (let p = 1; p <= n; p++) out.push({ blob: item.result.blob, page: p, of: n, item });
    } else if (item.kind === 'pdf') {
      const n = item.pages || 1;
      for (let p = 1; p <= n; p++) out.push({ blob: item.file, page: p, of: n, item });
    } else {
      out.push({ picture: item, item, photo: item.kind === 'image' });
    }
  }
  return out;
}

function frameUrl(f, width) {
  if (f.url) return Promise.resolve(f.url);
  if (f.blob) return renderPage(f.blob, f.page, width);
  return backend.picture(f.picture.file, width >= 400 ? 1200 : 160);
}

let drawToken = 0;

function renderReview() {
  const t = state.tool;
  const seg = $('viewSeg');
  const anyResult = state.items.some(i => i.result);

  if (t === 'merge') {
    seg.innerHTML = '';
    $('rtitle').textContent = state.merged ? 'Merged document' : 'How it will be merged';
  } else if (t === 'edit') {
    if (!['pick', 'result'].includes(state.view)) state.view = 'pick';
    seg.innerHTML = `<button type="button" data-v="pick" aria-pressed="${state.view === 'pick'}">Choose pages</button>`
                  + `<button type="button" data-v="result" aria-pressed="${state.view === 'result'}">What's left</button>`;
    $('rtitle').textContent = '';
  } else {
    if (!['original', 'result'].includes(state.view) || (state.view === 'result' && !anyResult)) state.view = 'original';
    seg.innerHTML = `<button type="button" data-v="original" aria-pressed="${state.view === 'original'}">Original</button>`
                  + `<button type="button" data-v="result" aria-pressed="${state.view === 'result'}"${anyResult ? '' : ' disabled'}>Result</button>`;
    $('rtitle').textContent = '';
  }
  seg.querySelectorAll('button').forEach(b => b.onclick = () => {
    state.view = b.dataset.v;
    state.frame = 0;
    renderReview();
  });

  const stage = $('stage');
  const strip = $('strip');
  stage.innerHTML = '';
  strip.innerHTML = '';
  stage.classList.remove('top');
  const token = ++drawToken;

  if (t === 'edit' && state.view === 'pick') {
    renderGrid(stage, token);
    strip.classList.add('hidden');
    renderFoot();
    return;
  }
  strip.classList.remove('hidden');

  const list = frames();
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'stage-note';
    p.textContent = state.items.length ? 'Reading your files…' : 'Your files will show here.';
    stage.appendChild(p);
    strip.classList.add('hidden');
    renderFoot();
    return;
  }
  state.frame = Math.max(0, Math.min(state.frame, list.length - 1));
  const f = list[state.frame];

  const prev = navButton('‹', 'Previous', state.frame === 0, () => step(-1));
  const next = navButton('›', 'Next', state.frame === list.length - 1, () => step(1));
  const img = document.createElement('img');
  img.alt = '';
  img.className = 'frame loading' + (f.photo ? ' photo' : '');
  stage.append(prev, img, next);
  frameUrl(f, 420).then(url => {
    if (token !== drawToken) return;
    img.src = url;
    img.classList.remove('loading');
  }, () => {
    if (token !== drawToken) return;
    img.classList.remove('loading');
    img.alt = 'No preview available';
  });

  const cap = document.createElement('div');
  cap.className = 'caption';
  cap.textContent = caption(f, list);
  stage.appendChild(cap);

  renderStrip(strip, list, token);
  renderFoot();
}

function caption(f, list) {
  const t = state.tool;
  const n = list.length;
  if (t === 'merge') return `Page ${state.frame + 1} of ${n} · from ${f.from.file.name}`;
  if (t === 'edit') return `Page ${state.frame + 1} of ${n} · was page ${f.was}`;
  const files = usable();
  const at = files.indexOf(f.item) + 1;
  const name = state.view === 'result' && f.item.result ? f.item.result.name : f.item.file.name;
  const pages = f.of > 1 ? ` · page ${f.page} of ${f.of}` : '';
  return `${files.length > 1 ? `${at} of ${files.length} · ` : ''}${name}${pages}`;
}

function navButton(glyph, label, off, onclick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'nav-btn';
  b.textContent = glyph;
  b.setAttribute('aria-label', label);
  b.disabled = off;
  b.onclick = onclick;
  return b;
}

// Pictures in the strip and the page grid are drawn when scrolled into view,
// so a 200-page PDF does not draw 200 pages to show eight.
let lazy = null;
function watch(el, load) {
  if (!lazy) {
    lazy = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        lazy.unobserve(e.target);
        e.target.__load?.();
      }
    }, { rootMargin: '200px' });
  }
  el.__load = load;
  lazy.observe(el);
}

function renderStrip(strip, list, token) {
  if (list.length < 2) { strip.classList.add('hidden'); return; }
  list.forEach((f, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = (f.photo ? 'photo ' : '') + (i === state.frame ? 'on' : '');
    b.setAttribute('aria-label', `Show ${i + 1} of ${list.length}`);
    const slot = document.createElement('span');
    slot.className = 'slot';
    b.appendChild(slot);
    b.onclick = () => go(i);
    strip.appendChild(b);
    watch(b, () => frameUrl(f, 52).then(url => {
      if (token !== drawToken) return;
      const img = document.createElement('img');
      img.alt = ''; img.src = url;
      b.replaceChildren(img);
    }, () => {}));
    if (i === state.frame) requestAnimationFrame(() => b.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  });
}

function renderGrid(stage, token) {
  stage.classList.add('top');
  const sel = selectedItem();
  if (!sel || !sel.pages) {
    const p = document.createElement('p');
    p.className = 'stage-note';
    p.textContent = sel?.error || 'Reading the pages…';
    stage.appendChild(p);
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (let p = 1; p <= sel.pages; p++) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile' + (sel.dropped.has(p) ? ' dropped' : '');
    tile.setAttribute('aria-pressed', String(sel.dropped.has(p)));
    tile.setAttribute('aria-label', `Page ${p}${sel.dropped.has(p) ? ', will be dropped' : ''}`);
    tile.innerHTML = `<div class="pic"></div><div class="num">${sel.dropped.has(p) ? 'dropping ' : ''}page ${p}</div>`;
    tile.onclick = () => togglePage(sel, p);
    grid.appendChild(tile);
    watch(tile, () => renderPage(sel.file, p, 150).then(url => {
      if (token !== drawToken) return;
      const img = document.createElement('img');
      img.alt = ''; img.src = url;
      tile.querySelector('.pic').replaceChildren(img);
    }, () => {}));
  }
  stage.appendChild(grid);
}

function togglePage(item, p) {
  if (state.busy) return;
  if (item.dropped.has(p)) item.dropped.delete(p);
  else if (item.dropped.size + 1 >= item.pages) { toast('At least one page has to stay', true); return; }
  else item.dropped.add(p);
  const field = $('spec');
  if (field) { field.value = formatRanges([...item.dropped]); field.classList.remove('bad'); $('specErr').textContent = ''; }
  const top = $('stage').scrollTop;
  settingsChanged({ keepOptions: true });
  $('stage').scrollTop = top;
}

function go(i) {
  const list = frames();
  state.frame = Math.max(0, Math.min(list.length - 1, i));
  const f = list[state.frame];
  if (f?.item && state.tool !== 'merge' && state.tool !== 'edit') {
    const at = state.items.indexOf(f.item);
    if (at !== state.selected) { state.selected = at; renderList(); }
  }
  renderReview();
}
const step = d => go(state.frame + d);

// Download is the last step, and it lives where you checked the result.
function renderFoot() {
  const foot = $('foot');
  const t = state.tool;
  foot.innerHTML = '';
  const wait = html => { const d = document.createElement('div'); d.className = 'wait'; d.innerHTML = html; foot.appendChild(d); };
  const facts = text => { const s = document.createElement('span'); s.className = 'facts'; s.textContent = text; foot.appendChild(s); };

  if (t === 'merge') {
    if (state.merged) {
      facts(`${COMBINED_NAME} · ${humanSize(state.merged.size)}`);
      foot.appendChild(cta('Download merged PDF', () => save(state.merged.url, COMBINED_NAME)));
    } else {
      wait(usable().length < 2 ? 'Add another PDF to merge with.'
        : 'Check the order above, then press <b>Merge into one</b>.');
    }
    return;
  }

  const done = state.items.filter(i => i.result);
  if (!done.length) {
    wait(t === 'edit'
      ? `${state.view === 'result' ? 'This is what you will get.' : 'Click the pages you want gone.'} Then press <b>Remove pages</b> to make the file.`
      : `Press <b>${TOOLS[t].action}</b> to see the result here before you download it.`);
    return;
  }
  const sel = selectedItem();
  if (sel?.result) {
    facts(`${humanSize(sel.file.size)} → ${humanSize(sel.result.size)}${sel.result.note ? ` · ${sel.result.note}` : ''}`);
  }
  if (done.length > 1) {
    foot.appendChild(cta(`Download all ${done.length}`, async () => {
      for (const i of done) { save(i.result.url, i.result.name); await new Promise(r => setTimeout(r, 250)); }
    }));
    if (sel?.result) {
      const one = document.createElement('button');
      one.type = 'button'; one.className = 'ghost'; one.textContent = 'Just this one';
      one.onclick = () => save(sel.result.url, sel.result.name);
      foot.appendChild(one);
    }
  } else {
    const only = sel?.result ? sel : done[0];
    foot.appendChild(cta('Download', () => save(only.result.url, only.result.name)));
  }
}

function cta(label, onclick) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'cta'; b.textContent = label; b.onclick = onclick;
  return b;
}

function save(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
}

function clearResults() {
  for (const item of state.items) {
    if (item.result) { URL.revokeObjectURL(item.result.url); forget(item.result.blob); }
    item.result = null;
    item.failed = null;
  }
  if (state.merged) { URL.revokeObjectURL(state.merged.url); forget(state.merged.blob); state.merged = null; }
  if (state.view === 'result' && state.tool !== 'edit') state.view = 'original';
}

// --- review as a side panel, or a sheet on a phone -----------------------------

const narrowQuery = matchMedia('(max-width: 900px)');
const isNarrow = () => narrowQuery.matches;
function openReview() {
  if (!isNarrow()) return;
  $('review').classList.add('open');
  $('backdrop').classList.add('open');
}
function closeReview() {
  $('review').classList.remove('open');
  $('backdrop').classList.remove('open');
}
function syncNarrow() {
  document.body.classList.toggle('narrow', isNarrow());
  if (!isNarrow()) closeReview();
  renderGo();
}
narrowQuery.addEventListener('change', syncNarrow);
$('close').onclick = closeReview;
$('backdrop').onclick = closeReview;
$('peek').onclick = () => { renderReview(); $('review').classList.add('open'); $('backdrop').classList.add('open'); };

// --- doing the work --------------------------------------------------------------

function settingsFor(item) {
  const o = state.opts;
  if (state.tool === 'compress') {
    // A PDF stays a PDF: its photographs are re-encoded in place.
    return { format: item.kind === 'pdf' ? 'pdf' : 'jpg', quality: 95, targetBytes: targetBytes() };
  }
  if (state.tool === 'resize') {
    // A PNG stays a PNG, because the point of resizing a logo is not to lose it to JPEG.
    return { format: extOf(item.file.name) === 'png' ? 'png' : 'jpg', quality: o.quality, maxPx: maxPx() };
  }
  return { format: o.format, quality: o.quality };
}

async function resultOf(blob, name, note) {
  const kind = blob.type === 'application/pdf' || /\.pdf$/i.test(name) ? 'pdf' : 'image';
  const pages = kind === 'pdf' ? await renderedPageCount(blob).catch(() => 1) : null;
  return { blob, url: URL.createObjectURL(blob), size: blob.size, name, note, kind, pages };
}

async function run() {
  if ($('go').dataset.review) {
    renderReview();
    $('review').classList.add('open');
    $('backdrop').classList.add('open');
    return;
  }
  if (state.busy || !ready()) return;
  state.busy = true;
  const mine = ++generation;
  clearResults();
  renderAll();

  try {
    if (state.tool === 'merge') {
      const files = usable().filter(i => i.pages);
      try {
        const blob = await backend.merge(files.map(i => i.file));
        if (mine !== generation) return;
        state.merged = {
          blob, url: URL.createObjectURL(blob), size: blob.size,
          sources: files.map(item => ({ item, pages: item.pages })),
        };
        state.frame = 0;
      } catch (err) {
        toast(err?.message || 'These PDFs could not be merged', true);
      }
    } else if (state.tool === 'edit') {
      for (const item of usable()) {
        if (!item.dropped.size) continue;
        item.working = true; renderList();
        const spec = formatRanges([...item.dropped]);
        try {
          const blob = await backend.removePages(item.file, spec);
          if (mine !== generation) return;
          item.result = await resultOf(new Blob([blob], { type: 'application/pdf' }),
            removedName(item.file.name, spec), `${item.dropped.size} dropped, ${item.pages - item.dropped.size} kept`);
        } catch (err) {
          item.failed = err?.message || "Couldn't edit this PDF";
        }
        item.working = false;
        renderList();
      }
      state.view = 'result';
    } else {
      for (const item of usable()) {
        item.working = true; renderList();
        try {
          const { blob, name, note } = await backend.convert(item.file, settingsFor(item));
          if (mine !== generation) return;
          item.result = await resultOf(blob, name, note);
        } catch (err) {
          item.failed = err?.message || "Couldn't convert this file";
        }
        item.working = false;
        renderList();
      }
      state.view = 'result';
      const first = frames().findIndex(f => f.item === selectedItem());
      state.frame = Math.max(0, first);
    }
  } finally {
    if (mine === generation) {
      state.busy = false;
      renderAll();
      if (finished()) openReview();
    }
  }
}
$('go').onclick = run;

// --- tools, picking, dropping ----------------------------------------------------

function setTool(name) {
  if (!TOOLS[name] || state.busy) return;
  const changing = name !== state.tool;
  state.tool = name;
  const t = TOOLS[name];
  $('title').textContent = t.title;
  $('wtitle').textContent = t.title;
  $('blurb').textContent = t.blurb;
  $('types').textContent = t.types;
  $('picker').setAttribute('accept', acceptFor(name));
  [...$('nav').children].forEach(b => b.setAttribute('aria-current', String(b.dataset.tool === name)));
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  if (changing) {
    // Files that this tool cannot take would only confuse it: start fresh,
    // but keep the ones it can.
    const keep = state.items.filter(i => !refusal(name, i.file.name));
    if (keep.length !== state.items.length) {
      for (const i of state.items) if (!keep.includes(i)) { backend.forget(i.file); forget(i.file); }
      state.items = keep;
      state.selected = 0;
    }
    clearResults();
    state.view = name === 'edit' ? 'pick' : 'original';
    state.frame = 0;
    if (!state.items.length) startOver();
  }
  renderAll();
}

function renderAll() {
  if (!state.items.length) { renderGo(); return; }
  renderList();
  // A thumbnail arriving must not steal focus from a field being typed in.
  if (!$('options').contains(document.activeElement)) renderOptions();
  else $('options').classList.toggle('locked', state.busy);
  renderReview();
  renderGo();
  [...$('nav').children].forEach(b => { b.disabled = state.busy && b.dataset.tool !== state.tool; });
}

$('nav').onclick = e => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); };
window.addEventListener('hashchange', () => setTool(location.hash.slice(1)));

const picker = $('picker');
$('choose').onclick = e => { e.stopPropagation(); picker.click(); };
$('reset').onclick = startOver;
picker.onchange = () => { add([...picker.files]); picker.value = ''; };

const drop = $('drop');
drop.onclick = () => picker.click();
drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } };
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { e.stopPropagation(); add([...e.dataTransfer.files]); });

const addStrip = $('addStrip');
addStrip.onclick = () => picker.click();
addStrip.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } };

// Once there are files, dragging more over the page lights up the Add more
// strip, so it is obvious where they go -- and a drop anywhere still counts.
// Counting enter/leave stops it flickering as the pointer crosses children.
let dragDepth = 0;
const working = () => !$('work').classList.contains('hidden');
const carriesFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => {
  if (!working() || !carriesFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (working() && e.dataTransfer?.files?.length) add([...e.dataTransfer.files]);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeReview();
    setPop(false);
    document.querySelectorAll('.info.open').forEach(i => i.classList.remove('open'));
    return;
  }
  if (!working() || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
  if (e.key === 'ArrowRight') step(1);
  if (e.key === 'ArrowLeft') step(-1);
});
document.addEventListener('click', e => {
  if (!e.target.closest('.info')) document.querySelectorAll('.info.open').forEach(i => i.classList.remove('open'));
});

// --- the privacy badge, in this app's words --------------------------------------

document.querySelectorAll('.where').forEach(el => { el.textContent = backend.place; });
document.querySelectorAll('.where-short').forEach(el => { el.textContent = backend.placeShort; });
$('promiseHow').textContent = backend.how;

const promise = $('promise');
const pop = $('promisePop');
function setPop(open) {
  pop.hidden = !open;
  promise.setAttribute('aria-expanded', String(open));
}
promise.onclick = e => { e.stopPropagation(); setPop(pop.hidden); };
promise.onmouseenter = () => setPop(true);
pop.onmouseleave = () => setPop(false);
document.addEventListener('click', e => { if (!e.target.closest('.promise-wrap')) setPop(false); });

// --- start -----------------------------------------------------------------------

syncNarrow();
setTool(TOOLS[location.hash.slice(1)] ? location.hash.slice(1) : 'convert');

window.addEventListener('pagehide', () => {
  for (const item of state.items) { backend.forget(item.file); forget(item.file); }
  clearResults();
});
