// Coordinate maths shared by the viewer. No DOM access, so it can be unit tested in Node.
//
// "Base" space is the page as PDF.js reports it at rotation 0 from the user's point of view
// (the page's own /Rotate already included), in points, origin top-left, y down. Markup is
// stored in base space. "View" space is what the user sees after turning the page clockwise
// by `rot` degrees (0, 90, 180 or 270).

export function viewSize(w, h, rot) {
  return rot === 90 || rot === 270 ? { w: h, h: w } : { w, h };
}

/** Where a base-space point appears in the rotated view. (w, h) is the base page size. */
export function baseToView(x, y, w, h, rot) {
  switch (rot) {
    case 90: return [h - y, x];
    case 180: return [w - x, h - y];
    case 270: return [y, w - x];
    default: return [x, y];
  }
}

/** Inverse of baseToView. */
export function viewToBase(vx, vy, w, h, rot) {
  switch (rot) {
    case 90: return [vy, h - vx];
    case 180: return [w - vx, h - vy];
    case 270: return [w - vy, vx];
    default: return [vx, vy];
  }
}

/** Canvas 2D transform [a, b, c, d, e, f] that draws base-space shapes into the rotated view. */
export function viewTransform(w, h, rot, scale) {
  let m;
  switch (rot) {
    case 90: m = [0, 1, -1, 0, h, 0]; break;
    case 180: m = [-1, 0, 0, -1, w, h]; break;
    case 270: m = [0, -1, 1, 0, 0, w]; break;
    default: m = [1, 0, 0, 1, 0, 0];
  }
  return m.map((v) => v * scale);
}

export function normalizeRotation(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Rotates a point about the origin, clockwise on screen (y down), by `deg`. */
export function rotatePoint(x, y, deg) {
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return [x * cos - y * sin, x * sin + y * cos];
}

/** Distance from point (px, py) to the segment (ax, ay)-(bx, by). */
export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Drops points closer than `minDist` to the previous kept point, always keeping the last. */
export function thinPath(points, minDist) {
  if (points.length <= 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1]) >= minDist) {
      out.push(points[i]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
