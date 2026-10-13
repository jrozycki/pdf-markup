// PDF Markup: the browser side. PDF.js draws the pages; everything the user does (page order,
// rotation, markup) lives in the model until Save, when the server applies it with PDFBox.

import * as pdfjsLib from '../pdfjs/pdf.min.mjs';
import { viewSize, baseToView, viewToBase, viewTransform, thinPath } from './geometry.js';
import * as M from './model.js';

// ---------------------------------------------------------------------------- setup

const PDFJS_BASE = new URL('../pdfjs/', import.meta.url);
const SAVE_URL = new URL('../../api/pdf/apply', import.meta.url).href;

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', PDFJS_BASE).href;
const DOC_OPTIONS = {
  cMapUrl: new URL('cmaps/', PDFJS_BASE).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('standard_fonts/', PDFJS_BASE).href,
  wasmUrl: new URL('wasm/', PDFJS_BASE).href,
  iccUrl: new URL('iccs/', PDFJS_BASE).href,
};

const HIGHLIGHT_ALPHA = 0.35; // must match the server
const THUMB_WIDTH = 132;
const MAX_CANVAS_DIM = 8192;
const MAX_CANVAS_PIXELS = 48e6;
const CSS_PX_PER_PT = 96 / 72;
const FONT_FAMILY = 'Helvetica, Arial, sans-serif';

const $ = (id) => document.getElementById(id);
const el = {
  viewer: $('viewer'), empty: $('empty'), wrap: $('pageWrap'),
  canvas: $('pageCanvas'), overlay: $('overlay'), editor: $('editor'),
  thumbs: $('thumbs'), thumbList: $('thumbList'),
  statusPage: $('statusPage'), statusMarks: $('statusMarks'), statusZoom: $('statusZoom'),
  statusFile: $('statusFile'), fileOpen: $('fileOpen'), fileInsert: $('fileInsert'),
  color: $('styleColor'), line: $('styleLine'), font: $('styleFont'), stamp: $('optStamp'),
};

const model = M.createModel();
const docs = [];                   // [{ file, pdf }], index = model page.doc
const pageProxies = new Map();     // "doc:src" -> PDF.js page
const thumbCache = new Map();      // "pageId:rot" -> canvas
let fileName = '';
let current = 0;
let layout = null;                 // geometry of the page currently on screen
const zoom = { fit: true, pxPerPt: CSS_PX_PER_PT };
let tool = 'select';
let selectedId = null;
let drag = null;                   // the pointer gesture in progress, if any
let editing = null;                // the text/note editor state, if open
let renderTask = null;
let renderToken = 0;
let thumbQueue = Promise.resolve();
let saving = false;

const style = { color: '#d32f2f', lineWidth: 2, fontSize: 14 };
const toolColors = { highlight: '#ffeb3b', rect: '#d32f2f', ink: '#d32f2f', text: '#d32f2f' };

const measureCtx = document.createElement('canvas').getContext('2d');
function measure(text, fontSize) {
  measureCtx.font = `${fontSize}px ${FONT_FAMILY}`;
  return measureCtx.measureText(text).width;
}

// ---------------------------------------------------------------------------- messages

function notify(severity, summary, detail) {
  if (typeof PF === 'function' && PF('growl')) {
    PF('growl').renderMessage({ severity, summary, detail: detail || '' });
  } else {
    console[severity === 'error' ? 'error' : 'log'](summary, detail || '');
  }
}

function fail(summary, error) {
  notify('error', summary, error && error.message ? error.message : String(error || ''));
}

// ---------------------------------------------------------------------------- opening files

async function readPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    return await pdfjsLib.getDocument({ data, ...DOC_OPTIONS }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') {
      throw new Error(`"${file.name}" is password-protected. Remove the password and try again.`);
    }
    throw new Error(`"${file.name}" could not be read as a PDF.`);
  }
}

async function pageInfos(pdf, docIndex) {
  const infos = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    if (i % 25 === 0) el.statusFile.textContent = `Reading pages… ${i} of ${pdf.numPages}`;
    const page = await pdf.getPage(i);
    pageProxies.set(`${docIndex}:${i - 1}`, page);
    const vp = page.getViewport({ scale: 1 });
    infos.push({ w: vp.width, h: vp.height, nativeRot: page.rotate });
  }
  return infos;
}

async function openFile(file) {
  if (model.dirty && !window.confirm('Discard unsaved changes and open another PDF?')) return;
  const pdf = await readPdf(file);
  for (const d of docs) d.pdf.destroy();
  docs.length = 0;
  pageProxies.clear();
  thumbCache.clear();
  docs.push({ file, pdf });
  const infos = await pageInfos(pdf, 0);
  M.resetWithDocument(model, 0, infos);
  fileName = file.name;
  current = 0;
  selectedId = null;
  closeEditor();
  refreshAll();
}

async function insertFile(file) {
  if (!model.pages.length) return openFile(file);
  const pdf = await readPdf(file);
  const docIndex = docs.length;
  docs.push({ file, pdf });
  const infos = await pageInfos(pdf, docIndex);
  current = M.insertDocument(model, docIndex, infos, current);
  selectedId = null;
  refreshAll();
  notify('info', 'Pages inserted', `${infos.length} page(s) from ${file.name}. Delete any you don't need.`);
}

function proxyFor(page) {
  return pageProxies.get(`${page.doc}:${page.src}`);
}

// ---------------------------------------------------------------------------- rendering

function currentPage() {
  return model.pages[current] || null;
}

function fitScale(viewWidthPts) {
  const available = Math.max(200, el.viewer.clientWidth - 48);
  return Math.min(6, Math.max(0.05, available / viewWidthPts));
}

async function renderCurrent() {
  const page = currentPage();
  const hasDoc = !!page;
  el.empty.hidden = hasDoc;
  el.wrap.hidden = !hasDoc;
  if (!hasDoc) {
    layout = null;
    return;
  }

  const token = ++renderToken;
  if (renderTask) {
    const old = renderTask;
    renderTask = null;
    old.cancel();
    try { await old.promise; } catch (e) { /* cancelled */ }
    if (token !== renderToken) return;
  }

  const vs = viewSize(page.w, page.h, page.rot);
  const scale = zoom.fit ? fitScale(vs.w) : zoom.pxPerPt;
  zoom.pxPerPt = scale;
  const cssW = vs.w * scale;
  const cssH = vs.h * scale;
  const dpr = window.devicePixelRatio || 1;
  const k = Math.max(0.25, Math.min(dpr, MAX_CANVAS_DIM / Math.max(cssW, cssH),
    Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH))));
  layout = { w: page.w, h: page.h, rot: page.rot, scale, k, cssW, cssH };

  for (const c of [el.canvas, el.overlay]) {
    c.width = Math.max(1, Math.round(cssW * k));
    c.height = Math.max(1, Math.round(cssH * k));
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
  }
  el.wrap.style.width = `${cssW}px`;
  el.wrap.style.height = `${cssH}px`;
  drawOverlay();
  updateStatus();

  const ctx = el.canvas.getContext('2d');
  if (page.blank) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, el.canvas.width, el.canvas.height);
    return;
  }
  const viewport = proxyFor(page).getViewport({ scale: scale * k, rotation: (page.nativeRot + page.rot) % 360 });
  const task = proxyFor(page).render({ canvasContext: ctx, viewport });
  renderTask = task;
  try {
    await task.promise;
  } catch (e) {
    if (!e || e.name !== 'RenderingCancelledException') fail('This page could not be drawn', e);
  } finally {
    if (renderTask === task) renderTask = null;
  }
}

// ---------------------------------------------------------------------------- overlay drawing

function drawOverlay() {
  const ctx = el.overlay.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  const page = currentPage();
  if (!page || !layout) return;
  ctx.setTransform(...viewTransform(layout.w, layout.h, layout.rot, layout.scale * layout.k));
  for (const m of page.markups) drawMarkup(ctx, m);
  if (drag && drag.preview) drawMarkup(ctx, drag.preview);
  const selected = selectedMarkup();
  if (selected) drawSelection(ctx, selected);
}

function drawMarkup(ctx, m) {
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = m.lineWidth || 2;
  switch (m.type) {
    case 'highlight':
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.fillRect(m.x, m.y, m.width, m.height);
      break;
    case 'rect':
      ctx.lineJoin = 'miter';
      ctx.strokeRect(m.x, m.y, m.width, m.height);
      break;
    case 'ink':
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      m.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      break;
    case 'text':
      ctx.translate(m.x, m.y);
      ctx.rotate(((m.angle || 0) * Math.PI) / 180);
      ctx.font = `${m.fontSize}px ${FONT_FAMILY}`;
      ctx.textBaseline = 'alphabetic';
      String(m.text || '').split('\n').forEach((line, i) => {
        ctx.fillText(line, 0, (M.ASCENT + i * M.LINE_HEIGHT) * m.fontSize);
      });
      break;
    case 'note':
      ctx.fillStyle = '#ffd54f';
      ctx.strokeStyle = '#5d4a00';
      ctx.lineWidth = 1;
      ctx.fillRect(m.x, m.y, M.NOTE_SIZE, M.NOTE_SIZE);
      ctx.strokeRect(m.x, m.y, M.NOTE_SIZE, M.NOTE_SIZE);
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        ctx.moveTo(m.x + 4, m.y + 6 + i * 4);
        ctx.lineTo(m.x + M.NOTE_SIZE - 4, m.y + 6 + i * 4);
      }
      ctx.stroke();
      break;
    default:
      break;
  }
  ctx.restore();
}

function drawSelection(ctx, m) {
  const px = 1 / layout.scale; // one screen pixel, in points
  ctx.save();
  ctx.strokeStyle = '#1f6feb';
  ctx.lineWidth = 1.5 * px;
  ctx.setLineDash([5 * px, 3 * px]);
  if (m.type === 'text') {
    const { w, h } = M.textSize(m, measure);
    ctx.translate(m.x, m.y);
    ctx.rotate(((m.angle || 0) * Math.PI) / 180);
    ctx.strokeRect(-3 * px, -3 * px, w + 6 * px, h + 6 * px);
  } else {
    const b = M.markupBounds(m, measure);
    ctx.strokeRect(b.x - 4 * px, b.y - 4 * px, b.w + 8 * px, b.h + 8 * px);
  }
  ctx.restore();
}

function selectedMarkup() {
  const page = currentPage();
  return page && selectedId ? M.findMarkup(model, current, selectedId) : null;
}

// ---------------------------------------------------------------------------- thumbnails

const thumbObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbObserver.unobserve(entry.target);
      const page = model.pages[Number(entry.target.dataset.index)];
      const canvas = entry.target.querySelector('canvas');
      if (page && canvas) queueThumb(page, canvas);
    }
  }, { root: el.thumbs, rootMargin: '300px 0px' })
  : null;

function renderThumbList() {
  if (thumbObserver) thumbObserver.disconnect();
  el.thumbList.replaceChildren();
  model.pages.forEach((page, i) => {
    const li = document.createElement('li');
    li.dataset.index = String(i);
    li.draggable = true;
    li.tabIndex = 0;
    li.setAttribute('aria-label', `Page ${i + 1}`);
    if (i === current) li.classList.add('current');

    const vs = viewSize(page.w, page.h, page.rot);
    const canvas = document.createElement('canvas');
    canvas.style.width = `${THUMB_WIDTH}px`;
    canvas.style.height = `${Math.round((vs.h / vs.w) * THUMB_WIDTH)}px`;
    canvas.width = THUMB_WIDTH;
    canvas.height = Math.round((vs.h / vs.w) * THUMB_WIDTH);

    const label = document.createElement('span');
    label.className = 'thumb-label';
    label.textContent = String(i + 1);
    li.append(canvas, label);
    el.thumbList.append(li);

    if (thumbObserver) thumbObserver.observe(li); else queueThumb(page, canvas);
  });
}

function queueThumb(page, canvas) {
  thumbQueue = thumbQueue.then(() => renderThumb(page, canvas)).catch(() => { /* thumbnails are best effort */ });
}

async function renderThumb(page, canvas) {
  const key = `${page.id}:${page.rot}`;
  let source = thumbCache.get(key);
  if (!source) {
    const vs = viewSize(page.w, page.h, page.rot);
    const scale = (THUMB_WIDTH * Math.min(2, window.devicePixelRatio || 1)) / vs.w;
    source = document.createElement('canvas');
    source.width = Math.max(1, Math.ceil(vs.w * scale));
    source.height = Math.max(1, Math.ceil(vs.h * scale));
    const ctx = source.getContext('2d');
    if (page.blank) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, source.width, source.height);
    } else {
      const proxy = proxyFor(page);
      const viewport = proxy.getViewport({ scale, rotation: (page.nativeRot + page.rot) % 360 });
      source.width = Math.ceil(viewport.width);
      source.height = Math.ceil(viewport.height);
      await proxy.render({ canvasContext: source.getContext('2d'), viewport }).promise;
    }
    thumbCache.set(key, source);
  }
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext('2d').drawImage(source, 0, 0);
}

function markCurrentThumb() {
  el.thumbList.querySelectorAll('li').forEach((li) => {
    const isCurrent = Number(li.dataset.index) === current;
    li.classList.toggle('current', isCurrent);
    if (isCurrent && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
  });
}

// Thumbnail clicks and drag-to-reorder
el.thumbList.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) goToPage(Number(li.dataset.index));
});
el.thumbList.addEventListener('keydown', (e) => {
  const li = e.target.closest('li');
  if (li && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    goToPage(Number(li.dataset.index));
  }
});

let dragFrom = -1;
el.thumbList.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  dragFrom = Number(li.dataset.index);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom));
  li.classList.add('dragging');
});
el.thumbList.addEventListener('dragend', () => {
  dragFrom = -1;
  clearDropMarks();
  el.thumbList.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
});
el.thumbList.addEventListener('dragover', (e) => {
  if (dragFrom < 0) return;
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  clearDropMarks();
  const rect = li.getBoundingClientRect();
  li.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
});
el.thumbList.addEventListener('drop', (e) => {
  if (dragFrom < 0) return;
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  const before = li.classList.contains('drop-before');
  let to = Number(li.dataset.index) + (before ? 0 : 1);
  if (dragFrom < to) to -= 1;
  const from = dragFrom;
  dragFrom = -1;
  clearDropMarks();
  if (M.movePage(model, from, to)) {
    current = to;
    refreshAll();
  }
});

function clearDropMarks() {
  el.thumbList.querySelectorAll('.drop-before, .drop-after').forEach((n) => {
    n.classList.remove('drop-before', 'drop-after');
  });
}

// ---------------------------------------------------------------------------- refresh helpers

function clampCurrent() {
  current = Math.max(0, Math.min(model.pages.length - 1, current));
  if (!model.pages.length) current = 0;
}

/** After any change to the page list. */
function refreshAll() {
  clampCurrent();
  if (selectedId && !selectedMarkup()) selectedId = null;
  renderThumbList();
  renderCurrent();
  updateStatus();
}

/** After a change to markup only. */
function refreshMarkup() {
  if (selectedId && !selectedMarkup()) selectedId = null;
  drawOverlay();
  updateStatus();
}

function goToPage(i) {
  if (i < 0 || i >= model.pages.length || i === current) return;
  commitEditor();
  current = i;
  selectedId = null;
  markCurrentThumb();
  renderCurrent();
  updateStatus();
}

function setDisabled(node, disabled) {
  node.disabled = disabled;
  node.classList.toggle('ui-state-disabled', disabled);
}

function updateStatus() {
  const page = currentPage();
  const n = model.pages.length;
  el.statusPage.textContent = page ? `Page ${current + 1} of ${n}` : 'No document';
  el.statusMarks.textContent = page ? `${page.markups.length} markup${page.markups.length === 1 ? '' : 's'} on this page` : '';
  el.statusZoom.textContent = page ? `${Math.round((zoom.pxPerPt / CSS_PX_PER_PT) * 100)}%` : '';
  el.statusFile.textContent = page ? `${fileName}${model.dirty ? ' (unsaved changes)' : ''}` : '';

  const hasDoc = !!page;
  document.querySelectorAll('.needs-doc').forEach((b) => setDisabled(b, !hasDoc || saving));
  document.querySelectorAll('.act-undo').forEach((b) => setDisabled(b, !model.undo.length));
  document.querySelectorAll('.act-redo').forEach((b) => setDisabled(b, !model.redo.length));
  document.querySelectorAll('.act-prev').forEach((b) => setDisabled(b, !hasDoc || current === 0));
  document.querySelectorAll('.act-next').forEach((b) => setDisabled(b, !hasDoc || current >= n - 1));
  document.querySelectorAll('.act-del-markup').forEach((b) => setDisabled(b, !selectedId));
  document.querySelectorAll('.tool-btn').forEach((b) => {
    const active = b.classList.contains(`tool-${tool}`);
    b.classList.toggle('tool-active', active);
    b.classList.toggle('ui-state-active', active);
  });
  el.overlay.className = `overlay tool-${tool}`;
}

// ---------------------------------------------------------------------------- tools and pointer input

function setTool(name) {
  commitEditor();
  tool = name;
  selectedId = name === 'select' ? selectedId : null;
  if (toolColors[name]) {
    style.color = toolColors[name];
    el.color.value = style.color;
  }
  drawOverlay();
  updateStatus();
}

function basePoint(e) {
  const r = el.overlay.getBoundingClientRect();
  return viewToBase((e.clientX - r.left) / layout.scale, (e.clientY - r.top) / layout.scale,
    layout.w, layout.h, layout.rot);
}

function tolerance() {
  return 6 / layout.scale; // six screen pixels, in points
}

el.overlay.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !layout) return;
  if (editing) commitEditor();
  const page = currentPage();
  const [x, y] = basePoint(e);

  if (tool === 'select') {
    const hit = M.hitTest(page, x, y, tolerance(), measure);
    selectedId = hit ? hit.id : null;
    drag = hit ? { kind: 'move', id: hit.id, start: [x, y], last: [x, y], moved: false } : null;
  } else if (tool === 'highlight' || tool === 'rect') {
    drag = {
      kind: 'shape', start: [x, y],
      preview: { type: tool, x, y, width: 0, height: 0, color: style.color, lineWidth: style.lineWidth },
    };
  } else if (tool === 'ink') {
    const points = [[x, y]];
    drag = { kind: 'ink', points, preview: { type: 'ink', points, color: style.color, lineWidth: style.lineWidth } };
  } else if (tool === 'text' || tool === 'note') {
    openEditor(tool, x, y, null);
    e.preventDefault();
  }
  if (drag && el.overlay.setPointerCapture) el.overlay.setPointerCapture(e.pointerId);
  drawOverlay();
  updateStatus();
});

el.overlay.addEventListener('pointermove', (e) => {
  if (!layout) return;
  const [x, y] = basePoint(e);
  if (!drag) {
    if (tool === 'select') {
      el.overlay.style.cursor = M.hitTest(currentPage(), x, y, tolerance(), measure) ? 'move' : '';
    }
    return;
  }
  if (drag.kind === 'move') {
    if (!drag.moved) {
      if (Math.hypot(x - drag.start[0], y - drag.start[1]) * layout.scale < 3) return;
      M.checkpoint(model);
      drag.moved = true;
    }
    const m = M.findMarkup(model, current, drag.id);
    if (m) M.translateMarkup(m, x - drag.last[0], y - drag.last[1]);
    drag.last = [x, y];
  } else if (drag.kind === 'shape') {
    drag.preview.width = x - drag.start[0];
    drag.preview.height = y - drag.start[1];
  } else if (drag.kind === 'ink') {
    drag.points.push([x, y]);
  }
  drawOverlay();
});

function endDrag(e, cancelled) {
  if (!drag) return;
  const finished = drag;
  drag = null;
  if (e && el.overlay.releasePointerCapture) {
    try { el.overlay.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  }
  if (!cancelled) {
    if (finished.kind === 'shape') {
      const p = finished.preview;
      if (Math.abs(p.width) >= 2 && Math.abs(p.height) >= 2) {
        M.addMarkup(model, current, {
          type: p.type, x: Math.min(p.x, p.x + p.width), y: Math.min(p.y, p.y + p.height),
          width: Math.abs(p.width), height: Math.abs(p.height), color: p.color, lineWidth: p.lineWidth,
        });
      }
    } else if (finished.kind === 'ink') {
      const points = thinPath(finished.points, 0.6 / layout.scale);
      if (points.length >= 2) {
        M.addMarkup(model, current, { type: 'ink', points, color: style.color, lineWidth: style.lineWidth });
      }
    }
  }
  refreshMarkup();
  updateStatus();
}

el.overlay.addEventListener('pointerup', (e) => endDrag(e, false));
el.overlay.addEventListener('pointercancel', (e) => endDrag(e, true));

el.overlay.addEventListener('dblclick', (e) => {
  if (tool !== 'select' || !layout) return;
  const [x, y] = basePoint(e);
  const hit = M.hitTest(currentPage(), x, y, tolerance(), measure);
  if (hit && (hit.type === 'text' || hit.type === 'note')) {
    selectedId = hit.id;
    openEditor(hit.type, hit.x, hit.y, hit);
  }
});

// ---------------------------------------------------------------------------- text / comment editor

function openEditor(type, x, y, existing) {
  const [vx, vy] = baseToView(x, y, layout.w, layout.h, layout.rot);
  const size = type === 'text' ? (existing ? existing.fontSize : style.fontSize) : 13;
  editing = { type, x, y, id: existing ? existing.id : null };
  el.editor.hidden = false;
  el.editor.value = existing ? existing.text || '' : '';
  el.editor.placeholder = type === 'note' ? 'Comment' : 'Text';
  el.editor.style.left = `${vx * layout.scale}px`;
  el.editor.style.top = `${vy * layout.scale}px`;
  el.editor.style.fontSize = `${size * layout.scale}px`;
  el.editor.style.color = type === 'text' ? (existing ? existing.color : style.color) : '#222';
  // Focus after the click has finished, or the browser's own focus handling steals it back.
  setTimeout(() => { if (editing) el.editor.focus(); }, 0);
}

function closeEditor() {
  editing = null;
  el.editor.hidden = true;
  el.editor.value = '';
}

function commitEditor() {
  if (!editing) return;
  const state = editing;
  const text = el.editor.value.replace(/\s+$/, '');
  closeEditor();
  const page = currentPage();
  if (!page || !text) return;
  if (state.id) {
    M.updateMarkup(model, current, state.id, { text });
  } else if (state.type === 'text') {
    const m = M.addMarkup(model, current, {
      type: 'text', x: state.x, y: state.y, text, fontSize: style.fontSize, color: style.color,
      // Text typed while looking at a rotated page should read upright in that view.
      angle: (360 - page.rot) % 360,
    });
    selectedId = m.id;
  } else {
    const m = M.addMarkup(model, current, { type: 'note', x: state.x, y: state.y, text, color: '#ffd54f' });
    selectedId = m.id;
  }
  refreshMarkup();
}

el.editor.addEventListener('blur', () => commitEditor());
el.editor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') {
    closeEditor();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    commitEditor();
  }
});

// ---------------------------------------------------------------------------- style controls

function applyStyleToSelection(fields) {
  const m = selectedMarkup();
  if (!m) return;
  const allowed = {};
  if ('color' in fields) allowed.color = fields.color;
  if ('lineWidth' in fields && (m.type === 'rect' || m.type === 'ink')) allowed.lineWidth = fields.lineWidth;
  if ('fontSize' in fields && m.type === 'text') allowed.fontSize = fields.fontSize;
  if (Object.keys(allowed).length) {
    M.updateMarkup(model, current, m.id, allowed);
    refreshMarkup();
  }
}

el.color.addEventListener('input', () => {
  style.color = el.color.value;
  if (toolColors[tool]) toolColors[tool] = style.color;
  applyStyleToSelection({ color: style.color });
});
el.line.addEventListener('change', () => {
  style.lineWidth = Number(el.line.value);
  applyStyleToSelection({ lineWidth: style.lineWidth });
});
el.font.addEventListener('change', () => {
  style.fontSize = Number(el.font.value);
  applyStyleToSelection({ fontSize: style.fontSize });
});

// ---------------------------------------------------------------------------- zoom

function setZoom(factor) {
  zoom.fit = false;
  zoom.pxPerPt = Math.min(12, Math.max(0.05, zoom.pxPerPt * factor));
  commitEditor();
  renderCurrent();
}

el.viewer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !currentPage()) return;
  e.preventDefault();
  setZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (zoom.fit && currentPage()) renderCurrent(); }, 150);
});

// ---------------------------------------------------------------------------- saving

function outputName() {
  const base = (docs[0] ? docs[0].file.name : fileName || 'document').replace(/\.pdf$/i, '');
  return `${base}_marked.pdf`;
}

async function save() {
  if (saving || !model.pages.length) return;
  commitEditor();
  saving = true;
  updateStatus();
  try {
    const { spec, docOrder } = M.buildSavePayload(model, { stamp: el.stamp.checked });
    const form = new FormData();
    form.append('spec', JSON.stringify(spec));
    form.append('filename', outputName());
    docOrder.forEach((docIndex, slot) => {
      form.append(`pdf${slot}`, docs[docIndex].file, docs[docIndex].file.name);
    });

    const response = await fetch(SAVE_URL, {
      method: 'POST', body: form, credentials: 'same-origin',
      headers: { 'X-Requested-With': 'pdf-markup' },
    });
    if (!response.ok) {
      let message = 'The PDF could not be saved.';
      try { message = (await response.json()).message || message; } catch (e) { /* not JSON */ }
      throw new Error(message);
    }
    downloadBlob(await response.blob(), outputName());
    model.dirty = false;
    notify('info', 'Saved', `Downloaded ${outputName()}. The original file was not changed.`);
  } catch (e) {
    if (e && e.name === 'NotReadableError') {
      fail('Could not save', new Error('The original file can no longer be read. It may have been moved or replaced. Open it again.'));
    } else {
      fail('Could not save', e);
    }
  } finally {
    saving = false;
    updateStatus();
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------------------- toolbar actions

const actions = {
  open: () => el.fileOpen.click(),
  save,
  undo: () => { if (M.undo(model)) { clampCurrent(); refreshAll(); } },
  redo: () => { if (M.redo(model)) { clampCurrent(); refreshAll(); } },
  rotateLeft: () => { M.rotatePage(model, current, -90); refreshAll(); },
  rotateRight: () => { M.rotatePage(model, current, 90); refreshAll(); },
  deletePage: () => {
    if (!M.deletePage(model, current)) {
      notify('warn', 'Cannot delete', 'A document needs at least one page.');
      return;
    }
    selectedId = null;
    refreshAll();
    notify('info', 'Page deleted', 'Press Ctrl+Z to bring it back.');
  },
  moveEarlier: () => { if (M.movePage(model, current, current - 1)) { current -= 1; refreshAll(); } },
  moveLater: () => { if (M.movePage(model, current, current + 1)) { current += 1; refreshAll(); } },
  insertBlank: () => {
    const page = currentPage();
    current = M.insertBlank(model, current, page.w, page.h);
    refreshAll();
  },
  insertPdf: () => el.fileInsert.click(),
  clearMarkup: () => { if (M.clearMarkups(model, current)) refreshMarkup(); },
  deleteMarkup: () => {
    if (selectedId && M.removeMarkup(model, current, selectedId)) {
      selectedId = null;
      refreshMarkup();
    }
  },
  zoomIn: () => setZoom(1.25),
  zoomOut: () => setZoom(1 / 1.25),
  zoomFit: () => { zoom.fit = true; commitEditor(); renderCurrent(); },
  prev: () => goToPage(current - 1),
  next: () => goToPage(current + 1),
};

function act(name) {
  try {
    if (name.startsWith('tool:')) {
      setTool(name.slice(5));
      return undefined;
    }
    const fn = actions[name];
    if (!fn) throw new Error(`Unknown action: ${name}`);
    const result = fn();
    updateStatus();
    return result;
  } catch (e) {
    fail('Something went wrong', e);
    return undefined;
  }
}

window.MarkupApp = { act };

// ---------------------------------------------------------------------------- file inputs, drag and drop, keyboard

function pickPdf(files) {
  return Array.from(files || []).find((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf') || null;
}

el.fileOpen.addEventListener('change', async () => {
  const file = pickPdf(el.fileOpen.files);
  el.fileOpen.value = '';
  if (file) {
    try { await openFile(file); } catch (e) { fail('Could not open the PDF', e); }
  }
});

el.fileInsert.addEventListener('change', async () => {
  const file = pickPdf(el.fileInsert.files);
  el.fileInsert.value = '';
  if (file) {
    try { await insertFile(file); } catch (e) { fail('Could not insert pages', e); }
  }
});

function hasFiles(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
    document.body.classList.add('file-drop');
  }
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('file-drop');
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.remove('file-drop');
  const file = pickPdf(e.dataTransfer.files);
  if (!file) {
    notify('warn', 'Not a PDF', 'Drop a .pdf file.');
    return;
  }
  try {
    await (model.pages.length ? insertFile(file) : openFile(file));
  } catch (err) {
    fail('Could not open the PDF', err);
  }
});

document.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    act(e.shiftKey ? 'redo' : 'undo');
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    act('redo');
  } else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    act('save');
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
    e.preventDefault();
    act('deleteMarkup');
  } else if (e.key === 'PageDown') {
    e.preventDefault();
    act('next');
  } else if (e.key === 'PageUp') {
    e.preventDefault();
    act('prev');
  } else if (e.key === 'Escape') {
    selectedId = null;
    if (tool !== 'select') setTool('select'); else refreshMarkup();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (model.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

updateStatus();
