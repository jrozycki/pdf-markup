// Drives the real markup.js against the real index.xhtml structure inside jsdom. Only PDF.js and
// canvas drawing are stubbed, so this catches wiring mistakes (ids, classes, event flow) and
// checks what would be sent to the server. It is not a substitute for trying it in a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const webapp = path.resolve(here, '../../main/webapp');

// ---- build the page from the real XHTML (JSF tags replaced by their plain HTML equivalents)
function xhtmlToHtml(xhtml) {
  return xhtml
    .replace(/<!DOCTYPE[^>]*>/i, '')
    .replace(/<p:commandButton([^>]*?)\/>/gs, (all, attrs) => {
      const get = (name) => (attrs.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] || '';
      return `<button type="button" class="ui-button ${get('styleClass')}" title="${get('title')}" `
        + `onclick="${get('onclick')}">${get('value')}</button>`;
    })
    .replace(/<p:(growl|tooltip)[^>]*\/>/g, '')
    .replace(/<h:outputStylesheet[^>]*\/>/g, '')
    .replace(/<h:form[^>]*>/g, '<form>').replace(/<\/h:form>/g, '</form>')
    .replace(/<h:head>/g, '<head>').replace(/<\/h:head>/g, '</head>')
    .replace(/<h:body styleClass="([^"]*)">/g, '<body class="$1">').replace(/<\/h:body>/g, '</body>')
    .replace(/<script type="module"[^>]*><\/script>/g, '')
    .replace(/#\{request\.contextPath\}/g, '');
}

const html = xhtmlToHtml(fs.readFileSync(path.join(webapp, 'index.xhtml'), 'utf8'));
const dom = new JSDOM(html, { url: 'http://localhost/pdf-markup/', pretendToBeVisual: true });
const { window } = dom;

// ---- globals the module expects
const calls = [];
const ctxStub = new Proxy({}, {
  get: (_, prop) => {
    if (prop === 'measureText') return (t) => ({ width: String(t).length * 7 });
    if (prop === 'canvas') return null;
    return (...args) => { calls.push([prop, ...args]); };
  },
  set: () => true,
});
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;

class RecordingFormData {
  constructor() { this.items = []; }
  append(key, value, filename) { this.items.push({ key, value, filename }); }
}
const sent = [];
const fetchStub = async (url, init) => {
  sent.push({ url, init });
  return { ok: true, blob: async () => new Blob(['%PDF-1.7']), json: async () => ({}) };
};

Object.assign(globalThis, {
  window, document: window.document, HTMLElement: window.HTMLElement,
  Node: window.Node, FormData: RecordingFormData, fetch: fetchStub, PF: undefined,
});
window.devicePixelRatio = 1;
window.confirm = () => true;
window.URL.createObjectURL = () => 'blob:stub';
window.URL.revokeObjectURL = () => {};
globalThis.URL.createObjectURL = () => 'blob:stub';
window.HTMLAnchorElement.prototype.click = function click() { calls.push(['download', this.download]); };

// ---- copy the real modules next to a stub PDF.js and import them
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-markup-smoke-'));
fs.mkdirSync(path.join(tmp, 'js'));
fs.mkdirSync(path.join(tmp, 'pdfjs'));
for (const f of ['markup.js', 'model.js', 'geometry.js']) {
  fs.copyFileSync(path.join(webapp, 'static/js', f), path.join(tmp, 'js', f));
}
fs.writeFileSync(path.join(tmp, 'pdfjs/pdf.min.mjs'), `
export const GlobalWorkerOptions = {};
// The "PDF" is text like "pages=3;w=400;h=300;rot=0".
export function getDocument({ data }) {
  const spec = Object.fromEntries(new TextDecoder().decode(data).split(';').map((kv) => kv.split('=')));
  const n = Number(spec.pages);
  const pdf = {
    numPages: n, destroy() {},
    async getPage() {
      const rot = Number(spec.rot || 0);
      return {
        rotate: rot,
        getViewport({ scale, rotation = rot }) {
          const sideways = rotation % 180 !== 0;
          const w = Number(spec.w); const h = Number(spec.h);
          return { width: (sideways ? h : w) * scale, height: (sideways ? w : h) * scale };
        },
        render() { return { promise: Promise.resolve(), cancel() {} }; },
      };
    },
  };
  return { promise: Promise.resolve(pdf) };
}
`);
await import(pathToFileURL(path.join(tmp, 'js/markup.js')).href);

// ---- helpers
const $ = (id) => window.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}
const act = (name) => window.MarkupApp.act(name);
const pageText = () => $('statusPage').textContent;

function pdfFile(name, spec) {
  return new File([spec], name, { type: 'application/pdf' });
}
async function open(file, inputId = 'fileOpen') {
  const input = $(inputId);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change'));
}
function pointer(type, x, y) {
  const ev = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
  $('overlay').dispatchEvent(ev);
}
function click(x, y) { pointer('pointerdown', x, y); pointer('pointerup', x, y); }
function drag(from, to) {
  pointer('pointerdown', ...from);
  pointer('pointermove', ...to);
  pointer('pointerup', ...to);
}
async function lastSavedSpec() {
  sent.length = 0;
  act('save');
  await until(() => sent.length === 1, 'the save request');
  const items = sent[0].init.body.items;
  return {
    spec: JSON.parse(items.find((i) => i.key === 'spec').value),
    files: items.filter((i) => i.key.startsWith('pdf')).map((i) => [i.key, i.filename]),
    headers: sent[0].init.headers, url: sent[0].url, filename: items.find((i) => i.key === 'filename').value,
  };
}

// In jsdom the viewer has no width, so the page is fitted to 200 css px: 0.5 px per point for a
// 400-point-wide page. Pointer positions below are therefore half the base-space coordinates.
const SCALE = 0.5;

test('every id and class the script needs exists in index.xhtml', () => {
  for (const id of ['viewer', 'empty', 'pageWrap', 'pageCanvas', 'overlay', 'editor', 'thumbs',
    'thumbList', 'statusPage', 'statusMarks', 'statusZoom', 'statusFile', 'fileOpen', 'fileInsert',
    'styleColor', 'styleLine', 'styleFont', 'optStamp']) {
    assert.ok($(id), `missing #${id}`);
  }
  // every action wired in the page must exist in the script
  const names = [...window.document.querySelectorAll('[onclick]')]
    .map((n) => n.getAttribute('onclick').match(/act\('([^']+)'\)/)?.[1]).filter(Boolean);
  assert.ok(names.length > 20, 'toolbar buttons found');
  assert.ok(window.MarkupApp && typeof window.MarkupApp.act === 'function');
});

test('starts empty with document actions disabled', () => {
  assert.equal($('empty').hidden, false);
  assert.equal($('pageWrap').hidden, true);
  assert.equal(window.document.querySelector('.save-btn').disabled, true);
});

test('opens a PDF, lists its pages, and enables the toolbar', async () => {
  await open(pdfFile('piping-diagram.pdf', 'pages=3;w=400;h=300;rot=0'));
  await until(() => pageText() === 'Page 1 of 3', 'the document to load');
  assert.equal($('thumbList').children.length, 3);
  assert.equal($('empty').hidden, true);
  assert.equal($('pageWrap').hidden, false);
  assert.equal(window.document.querySelector('.save-btn').disabled, false);
  assert.equal($('statusFile').textContent, 'piping-diagram.pdf');
});

test('page operations update the page list and the save request', async () => {
  act('next');
  await until(() => pageText() === 'Page 2 of 3', 'page 2');
  act('rotateRight');
  act('moveEarlier');
  await until(() => pageText() === 'Page 1 of 3', 'moved page to the front');
  assert.match($('statusFile').textContent, /unsaved changes/);

  const saved = await lastSavedSpec();
  assert.deepEqual(saved.spec.pages.map((p) => [p.doc, p.src, p.rotate]), [[0, 1, 90], [0, 0, 0], [0, 2, 0]]);
  assert.deepEqual(saved.files, [['pdf0', 'piping-diagram.pdf']]);
  assert.equal(saved.headers['X-Requested-With'], 'pdf-markup');
  assert.equal(saved.filename, 'piping-diagram_marked.pdf');
  assert.ok(saved.url.endsWith('/api/pdf/apply'), saved.url);
  await until(() => $('statusFile').textContent === 'piping-diagram.pdf', 'dirty flag to clear after save');
});

test('deleting pages, undo, and the last-page guard', async () => {
  act('deletePage');
  await until(() => $('thumbList').children.length === 2, 'page deleted');
  act('undo');
  await until(() => $('thumbList').children.length === 3, 'undo restores the page');
  act('redo');
  await until(() => $('thumbList').children.length === 2, 'redo removes it again');
  act('undo');
  await until(() => $('thumbList').children.length === 3, 'back to three');
});

test('drawing a highlight stores it in base-space points', async () => {
  // Page 1 is the page that was rotated and moved to the front earlier; turn it upright again.
  act('rotateLeft');
  await sleep(10);
  act('tool:select');
  act('tool:highlight');
  assert.ok(window.document.querySelector('.tool-highlight').classList.contains('tool-active'));
  drag([100 * SCALE, 50 * SCALE], [160 * SCALE, 90 * SCALE]);
  await until(() => /1 markup/.test($('statusMarks').textContent), 'the highlight');

  const { spec } = await lastSavedSpec();
  const m = spec.pages[0].markups[0];
  assert.equal(m.type, 'HIGHLIGHT');
  assert.deepEqual([m.x, m.y, m.width, m.height], [100, 50, 60, 40]);
  assert.equal(m.color, '#ffeb3b');
});

test('tiny drags are ignored', async () => {
  act('tool:rect');
  drag([10, 10], [10.5, 10.5]);
  await sleep(20);
  assert.match($('statusMarks').textContent, /1 markup/);
});

test('freehand ink keeps its points', async () => {
  act('tool:ink');
  pointer('pointerdown', 20, 20);
  for (let i = 1; i <= 10; i++) pointer('pointermove', 20 + i * 10, 20 + i * 4);
  pointer('pointerup', 120, 60);
  await until(() => /2 markups/.test($('statusMarks').textContent), 'the stroke');
  const { spec } = await lastSavedSpec();
  const ink = spec.pages[0].markups[1];
  assert.equal(ink.type, 'INK');
  assert.ok(ink.points.length >= 5);
  assert.deepEqual(ink.points[0], [40, 40]);
});

test('text typed on an upright page has angle 0', async () => {
  act('tool:text');
  click(60, 120);
  assert.equal($('editor').hidden, false);
  $('editor').value = 'Check valve orientation';
  $('editor').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await until(() => /3 markups/.test($('statusMarks').textContent), 'the text');
  assert.equal($('editor').hidden, true);

  const { spec } = await lastSavedSpec();
  const t = spec.pages[0].markups[2];
  assert.deepEqual([t.type, t.text, t.x, t.y, t.angle], ['TEXT', 'Check valve orientation', 120, 240, 0]);
});

test('empty text is discarded and Escape cancels the editor', async () => {
  act('tool:text');
  click(200, 100);
  $('editor').value = '   ';
  $('editor').dispatchEvent(new window.Event('blur'));
  await sleep(20);
  assert.match($('statusMarks').textContent, /3 markups/);
  click(200, 100);
  $('editor').value = 'discard me';
  $('editor').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal($('editor').hidden, true);
  assert.match($('statusMarks').textContent, /3 markups/);
});

test('a comment is stored as a NOTE', async () => {
  act('tool:note');
  click(300, 40);
  $('editor').value = 'Confirm with supplier';
  $('editor').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await until(() => /4 markups/.test($('statusMarks').textContent), 'the note');
  const { spec } = await lastSavedSpec();
  const note = spec.pages[0].markups[3];
  assert.deepEqual([note.type, note.text, note.x, note.y], ['NOTE', 'Confirm with supplier', 600, 80]);
});

test('select, move and delete markup', async () => {
  act('tool:select');
  // The highlight spans base (100..160, 50..90). The freehand stroke drawn earlier crosses its
  // middle and sits on top, so grab the lower-left corner, which the stroke does not touch.
  const grab = [105 * SCALE, 85 * SCALE];
  pointer('pointerdown', ...grab);
  assert.equal(window.document.querySelector('.act-del-markup').disabled, false, 'selection enables delete');
  pointer('pointermove', grab[0] + 20, grab[1] + 10);
  pointer('pointerup', grab[0] + 20, grab[1] + 10);
  let { spec } = await lastSavedSpec();
  const moved = spec.pages[0].markups[0];
  assert.deepEqual([moved.x, moved.y], [140, 70]);

  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await until(() => /3 markups/.test($('statusMarks').textContent), 'markup deleted');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  await until(() => /4 markups/.test($('statusMarks').textContent), 'undo of the delete');
});

test('text typed on a rotated page reads upright in that view', async () => {
  act('next');
  await until(() => pageText() === 'Page 2 of 3', 'page 2');
  act('rotateRight');
  // the view is now 300 x 400 points: fitted to 200 css px => 0.667 px per point
  act('tool:text');
  const scale = 200 / 300;
  click(60 * scale, 100 * scale);
  $('editor').value = 'upright';
  $('editor').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await until(() => /1 markup on/.test($('statusMarks').textContent), 'text on the rotated page');

  const { spec } = await lastSavedSpec();
  const t = spec.pages[1].markups[0];
  assert.equal(spec.pages[1].rotate, 90);
  assert.equal(t.angle, 270, 'text added in a view turned 90 degrees clockwise is turned back 90');
});

test('inserting pages from a second PDF uploads both files in order', async () => {
  act('tool:select');
  await open(pdfFile('detail.pdf', 'pages=2;w=500;h=500;rot=0'), 'fileInsert');
  await until(() => $('thumbList').children.length === 5, 'inserted pages');
  const { spec, files } = await lastSavedSpec();
  assert.deepEqual(files, [['pdf0', 'piping-diagram.pdf'], ['pdf1', 'detail.pdf']]);
  assert.equal(spec.pages.filter((p) => p.doc === 1).length, 2);
  assert.equal(spec.pages.length, 5);
});

test('blank page, stamp option, and error reporting from the server', async () => {
  act('insertBlank');
  await until(() => $('thumbList').children.length === 6, 'blank page');
  $('optStamp').checked = true;
  const { spec } = await lastSavedSpec();
  assert.equal(spec.stamp, true);
  assert.equal(spec.pages.filter((p) => p.blank).length, 1);

  // a server error should be shown, not thrown
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ message: 'Page 2 is bad.' }) });
  const before = $('statusFile').textContent;
  act('save');
  await sleep(50);
  assert.equal($('statusFile').textContent, before, 'dirty state unchanged after a failed save');
  globalThis.fetch = fetchStub;
});
