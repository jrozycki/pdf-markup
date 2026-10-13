// The editable document: page order, per-page rotation and markup, with undo/redo.
// No DOM or PDF.js access, so it can be unit tested in Node.

import { distanceToSegment, normalizeRotation, rotatePoint } from './geometry.js';

export const ASCENT = 0.8;       // top of a text line to its baseline, as a fraction of font size
export const LINE_HEIGHT = 1.2;
export const NOTE_SIZE = 20;
const MAX_UNDO = 100;

export function createModel() {
  return { pages: [], undo: [], redo: [], dirty: false, nextId: 1 };
}

function newId(model) {
  return model.nextId++;
}

// ------------------------------------------------------------------ undo / redo

export function checkpoint(model) {
  model.undo.push(structuredClone(model.pages));
  if (model.undo.length > MAX_UNDO) model.undo.shift();
  model.redo.length = 0;
  model.dirty = true;
}

/** Drops the most recent checkpoint, for gestures that turned out not to change anything. */
export function discardCheckpoint(model) {
  model.undo.pop();
}

export function undo(model) {
  if (!model.undo.length) return false;
  model.redo.push(structuredClone(model.pages));
  model.pages = model.undo.pop();
  model.dirty = true;
  return true;
}

export function redo(model) {
  if (!model.redo.length) return false;
  model.undo.push(structuredClone(model.pages));
  model.pages = model.redo.pop();
  model.dirty = true;
  return true;
}

// ------------------------------------------------------------------ pages

/** Replaces the whole document with the pages of a freshly opened file. */
export function resetWithDocument(model, docIndex, infos) {
  model.pages = infos.map((info, src) => makePage(model, docIndex, src, info));
  model.undo.length = 0;
  model.redo.length = 0;
  model.dirty = false;
}

/** Inserts all pages of another file after `afterIndex`. Returns the index of the first. */
export function insertDocument(model, docIndex, infos, afterIndex) {
  checkpoint(model);
  const pages = infos.map((info, src) => makePage(model, docIndex, src, info));
  model.pages.splice(afterIndex + 1, 0, ...pages);
  return afterIndex + 1;
}

export function insertBlank(model, afterIndex, w, h) {
  checkpoint(model);
  model.pages.splice(afterIndex + 1, 0, {
    id: newId(model), doc: -1, src: -1, blank: true,
    w, h, nativeRot: 0, rot: 0, markups: [],
  });
  return afterIndex + 1;
}

function makePage(model, doc, src, info) {
  return {
    id: newId(model), doc, src, blank: false,
    w: info.w, h: info.h, nativeRot: info.nativeRot || 0, rot: 0, markups: [],
  };
}

export function rotatePage(model, index, delta) {
  checkpoint(model);
  const page = model.pages[index];
  page.rot = normalizeRotation(page.rot + delta);
}

/** Removes a page. Returns false (and does nothing) if it is the last one. */
export function deletePage(model, index) {
  if (model.pages.length <= 1) return false;
  checkpoint(model);
  model.pages.splice(index, 1);
  return true;
}

/** Moves the page at `from` so it ends up at index `to`. */
export function movePage(model, from, to) {
  if (from === to || from < 0 || to < 0 || from >= model.pages.length || to >= model.pages.length) {
    return false;
  }
  checkpoint(model);
  const [page] = model.pages.splice(from, 1);
  model.pages.splice(to, 0, page);
  return true;
}

// ------------------------------------------------------------------ markup

export function addMarkup(model, pageIndex, markup) {
  checkpoint(model);
  const m = { id: newId(model), ...markup };
  model.pages[pageIndex].markups.push(m);
  return m;
}

export function removeMarkup(model, pageIndex, markupId) {
  const list = model.pages[pageIndex].markups;
  const i = list.findIndex((m) => m.id === markupId);
  if (i < 0) return false;
  checkpoint(model);
  list.splice(i, 1);
  return true;
}

export function clearMarkups(model, pageIndex) {
  if (!model.pages[pageIndex].markups.length) return false;
  checkpoint(model);
  model.pages[pageIndex].markups = [];
  return true;
}

export function findMarkup(model, pageIndex, markupId) {
  return model.pages[pageIndex].markups.find((m) => m.id === markupId) || null;
}

export function translateMarkup(m, dx, dy) {
  if (m.type === 'ink') {
    m.points = m.points.map(([x, y]) => [x + dx, y + dy]);
  } else {
    m.x += dx;
    m.y += dy;
  }
}

/** Replaces a markup's editable fields, with an undo step. */
export function updateMarkup(model, pageIndex, markupId, fields) {
  const m = findMarkup(model, pageIndex, markupId);
  if (!m) return false;
  checkpoint(model);
  Object.assign(m, fields);
  return true;
}

// ------------------------------------------------------------------ geometry of markup

/**
 * Size of a text block in points. `measure(text, fontSize)` returns the width of one line.
 */
export function textSize(m, measure) {
  const lines = String(m.text || '').split('\n');
  let w = 0;
  for (const line of lines) w = Math.max(w, measure(line, m.fontSize));
  return { w, h: lines.length * LINE_HEIGHT * m.fontSize };
}

/**
 * Axis-aligned bounds {x, y, w, h} in base space. For rotated text this is the bounds of the
 * rotated block.
 */
export function markupBounds(m, measure) {
  switch (m.type) {
    case 'highlight':
    case 'rect':
      return { x: Math.min(m.x, m.x + m.width), y: Math.min(m.y, m.y + m.height),
        w: Math.abs(m.width), h: Math.abs(m.height) };
    case 'ink': {
      const xs = m.points.map((p) => p[0]);
      const ys = m.points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case 'note':
      return { x: m.x, y: m.y, w: NOTE_SIZE, h: NOTE_SIZE };
    case 'text': {
      const { w, h } = textSize(m, measure);
      const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([cx, cy]) => {
        const [rx, ry] = rotatePoint(cx, cy, m.angle || 0);
        return [m.x + rx, m.y + ry];
      });
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    default:
      return { x: 0, y: 0, w: 0, h: 0 };
  }
}

/**
 * Finds the topmost markup under (x, y) in base space. `tolerance` is in points.
 * Highlights and rectangles are selectable by their outline or, for highlights, inside.
 */
export function hitTest(page, x, y, tolerance, measure) {
  for (let i = page.markups.length - 1; i >= 0; i--) {
    const m = page.markups[i];
    if (hitsMarkup(m, x, y, tolerance, measure)) return m;
  }
  return null;
}

function hitsMarkup(m, x, y, tol, measure) {
  switch (m.type) {
    case 'highlight': {
      const b = markupBounds(m);
      return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
    }
    case 'rect': {
      const b = markupBounds(m);
      const near = m.lineWidth / 2 + tol;
      const inside = x >= b.x - near && x <= b.x + b.w + near && y >= b.y - near && y <= b.y + b.h + near;
      const deep = x > b.x + near && x < b.x + b.w - near && y > b.y + near && y < b.y + b.h - near;
      return inside && !deep;
    }
    case 'ink': {
      const near = m.lineWidth / 2 + tol;
      for (let i = 1; i < m.points.length; i++) {
        const [ax, ay] = m.points[i - 1];
        const [bx, by] = m.points[i];
        if (distanceToSegment(x, y, ax, ay, bx, by) <= near) return true;
      }
      return false;
    }
    case 'note':
      return x >= m.x - tol && x <= m.x + NOTE_SIZE + tol && y >= m.y - tol && y <= m.y + NOTE_SIZE + tol;
    case 'text': {
      // Move the point into the text's own (unrotated) frame, then test the plain box.
      const [lx, ly] = rotatePoint(x - m.x, y - m.y, -(m.angle || 0));
      const { w, h } = textSize(m, measure);
      return lx >= -tol && lx <= w + tol && ly >= -tol && ly <= h + tol;
    }
    default:
      return false;
  }
}

// ------------------------------------------------------------------ saving

const SERVER_FIELDS = ['type', 'x', 'y', 'width', 'height', 'points', 'text', 'fontSize',
  'lineWidth', 'color', 'angle'];

function toServerMarkup(m) {
  const out = {};
  for (const key of SERVER_FIELDS) {
    if (m[key] !== undefined) out[key] = m[key];
  }
  out.type = String(m.type).toUpperCase();
  return out;
}

/**
 * Builds the request for the server: the edit spec plus `docOrder`, the document indexes
 * (as used by the model) in the order their files must be uploaded as pdf0, pdf1, ...
 */
export function buildSavePayload(model, options = {}) {
  const used = [...new Set(model.pages.filter((p) => !p.blank).map((p) => p.doc))]
    .sort((a, b) => a - b);
  if (!used.length) used.push(0);
  const index = new Map(used.map((doc, i) => [doc, i]));

  const pages = model.pages.map((p) => {
    const markups = p.markups.map(toServerMarkup);
    if (p.blank) {
      return { blank: true, blankWidth: p.w, blankHeight: p.h, rotate: p.rot, markups };
    }
    return { doc: index.get(p.doc), src: p.src, rotate: p.rot, markups };
  });
  return { spec: { pages, stamp: !!options.stamp }, docOrder: used };
}
