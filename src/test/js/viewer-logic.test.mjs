import test from 'node:test';
import assert from 'node:assert/strict';

import * as g from '../../main/webapp/static/js/geometry.js';
import * as m from '../../main/webapp/static/js/model.js';

const ROTS = [0, 90, 180, 270];
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const measure = (text, fs) => text.length * fs * 0.5;

test('viewToBase inverts baseToView for every rotation', () => {
  for (const rot of ROTS) {
    const [vx, vy] = g.baseToView(130, 70, 400, 300, rot);
    const [bx, by] = g.viewToBase(vx, vy, 400, 300, rot);
    near(bx, 130); near(by, 70);
  }
});

test('baseToView matches the values the Java engine tests expect', () => {
  // Same numbers as PdfEditServiceTest.markupFollowsUserRotation on a 400 x 300 page.
  assert.deepEqual(g.baseToView(130, 70, 400, 300, 90), [230, 130]);
  assert.deepEqual(g.baseToView(130, 70, 400, 300, 180), [270, 230]);
  assert.deepEqual(g.baseToView(130, 70, 400, 300, 270), [70, 270]);
});

test('viewTransform agrees with baseToView', () => {
  for (const rot of ROTS) {
    const s = 1.7;
    const [a, b, c, d, e, f] = g.viewTransform(400, 300, rot, s);
    const [vx, vy] = g.baseToView(130, 70, 400, 300, rot);
    near(a * 130 + c * 70 + e, vx * s);
    near(b * 130 + d * 70 + f, vy * s);
  }
});

test('viewSize swaps for sideways views', () => {
  assert.deepEqual(g.viewSize(400, 300, 90), { w: 300, h: 400 });
  assert.deepEqual(g.viewSize(400, 300, 180), { w: 400, h: 300 });
});

test('thinPath keeps endpoints and drops near-duplicates', () => {
  const pts = [[0, 0], [0.1, 0], [0.2, 0], [5, 0], [5.1, 0], [10, 0]];
  assert.deepEqual(g.thinPath(pts, 1), [[0, 0], [5, 0], [10, 0]]);
});

function docWith(n, doc = 0) {
  const model = m.createModel();
  m.resetWithDocument(model, doc, Array.from({ length: n }, () => ({ w: 400, h: 300, nativeRot: 0 })));
  return model;
}

test('rotate, delete, move and undo/redo', () => {
  const model = docWith(4);
  const ids = model.pages.map((p) => p.id);

  m.rotatePage(model, 1, 90);
  m.rotatePage(model, 1, 90);
  m.rotatePage(model, 2, -90);
  assert.equal(model.pages[1].rot, 180);
  assert.equal(model.pages[2].rot, 270);

  m.movePage(model, 0, 3);
  assert.deepEqual(model.pages.map((p) => p.id), [ids[1], ids[2], ids[3], ids[0]]);

  assert.equal(m.deletePage(model, 0), true);
  assert.equal(model.pages.length, 3);

  m.undo(model); // delete
  m.undo(model); // move
  assert.deepEqual(model.pages.map((p) => p.id), ids);
  m.redo(model);
  assert.deepEqual(model.pages.map((p) => p.id), [ids[1], ids[2], ids[3], ids[0]]);
  assert.equal(model.dirty, true);
});

test('cannot delete the last page', () => {
  const model = docWith(1);
  assert.equal(m.deletePage(model, 0), false);
  assert.equal(model.pages.length, 1);
});

test('opening a document starts clean', () => {
  const model = docWith(2);
  m.rotatePage(model, 0, 90);
  assert.equal(model.dirty, true);
  m.resetWithDocument(model, 0, [{ w: 10, h: 10, nativeRot: 0 }]);
  assert.equal(model.dirty, false);
  assert.equal(model.undo.length, 0);
});

test('markup moves with its page and survives undo', () => {
  const model = docWith(3);
  const mk = m.addMarkup(model, 2, { type: 'rect', x: 10, y: 10, width: 50, height: 20, lineWidth: 2, color: '#f00' });
  m.movePage(model, 2, 0);
  assert.equal(model.pages[0].markups[0].id, mk.id);
  m.undo(model);
  assert.equal(model.pages[2].markups[0].id, mk.id);
});

test('hit testing: ink, rect outline, highlight, note and rotated text', () => {
  const model = docWith(1);
  const page = model.pages[0];
  const ink = m.addMarkup(model, 0, { type: 'ink', points: [[10, 10], [110, 10]], lineWidth: 2, color: '#00f' });
  const rect = m.addMarkup(model, 0, { type: 'rect', x: 50, y: 50, width: 100, height: 60, lineWidth: 2, color: '#0a0' });
  const hl = m.addMarkup(model, 0, { type: 'highlight', x: 200, y: 50, width: 60, height: 20, color: '#ff0' });
  const note = m.addMarkup(model, 0, { type: 'note', x: 300, y: 200, text: 'x' });
  // 10 chars at 20pt -> 100 wide, 24 tall, rotated 90 degrees clockwise about (200, 150)
  const text = m.addMarkup(model, 0, { type: 'text', x: 200, y: 150, text: '0123456789', fontSize: 20, angle: 90 });

  assert.equal(m.hitTest(page, 60, 11, 3, measure).id, ink.id);
  assert.equal(m.hitTest(page, 60, 30, 3, measure), null);
  assert.equal(m.hitTest(page, 100, 50, 3, measure).id, rect.id);   // on the outline
  assert.equal(m.hitTest(page, 100, 80, 3, measure), null);         // hollow inside
  assert.equal(m.hitTest(page, 230, 60, 3, measure).id, hl.id);     // inside the highlight
  assert.equal(m.hitTest(page, 310, 210, 3, measure).id, note.id);
  // rotated 90 degrees clockwise: the block extends downwards from the anchor and to its left
  assert.equal(m.hitTest(page, 190, 200, 3, measure).id, text.id);
  assert.equal(m.hitTest(page, 260, 150, 3, measure), null);
});

test('bounds of rotated text cover the rotated block', () => {
  const b = m.markupBounds({ type: 'text', x: 200, y: 150, text: '0123456789', fontSize: 20, angle: 90 }, measure);
  near(b.x, 200 - 24); near(b.y, 150); near(b.w, 24); near(b.h, 100);
});

test('translateMarkup moves ink points and positioned markup', () => {
  const ink = { type: 'ink', points: [[0, 0], [5, 5]] };
  m.translateMarkup(ink, 10, 20);
  assert.deepEqual(ink.points, [[10, 20], [15, 25]]);
  const note = { type: 'note', x: 1, y: 2 };
  m.translateMarkup(note, 3, 4);
  assert.deepEqual([note.x, note.y], [4, 6]);
});

test('save payload maps documents to upload slots and keeps order and rotation', () => {
  const model = docWith(2, 0);
  const other = [{ w: 600, h: 600, nativeRot: 0 }, { w: 600, h: 600, nativeRot: 90 }];
  m.insertDocument(model, 1, other, 0);        // pages: d0p0, d1p0, d1p1, d0p1
  m.insertBlank(model, 3, 500, 400);           // ... then a blank
  m.rotatePage(model, 1, 90);
  m.deletePage(model, 2);                      // drop d1p1
  m.addMarkup(model, 0, { type: 'text', x: 5, y: 6, text: 'hi', fontSize: 12, color: '#000', angle: 0, extra: 'ignored' });

  const { spec, docOrder } = m.buildSavePayload(model, { stamp: true });
  assert.deepEqual(docOrder, [0, 1]);
  assert.equal(spec.stamp, true);
  assert.deepEqual(spec.pages.map((p) => [p.blank ? 'blank' : p.doc, p.src, p.rotate]),
    [[0, 0, 0], [1, 0, 90], [0, 1, 0], ['blank', undefined, 0]]);
  assert.equal(spec.pages[0].markups[0].type, 'TEXT');
  assert.equal(spec.pages[0].markups[0].extra, undefined);
  assert.equal(spec.pages[3].blankWidth, 500);
});

test('save payload still uploads the base file when only blank pages and inserted pages remain', () => {
  const model = docWith(1, 0);
  m.insertDocument(model, 1, [{ w: 100, h: 100, nativeRot: 0 }], 0);
  m.deletePage(model, 0);                      // the only base page is gone
  const { spec, docOrder } = m.buildSavePayload(model);
  assert.deepEqual(docOrder, [1]);
  assert.equal(spec.pages[0].doc, 0);          // re-indexed to upload slot 0
});
