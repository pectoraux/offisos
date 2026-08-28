/**
 * 2D math primitives for the CAD 2D drafting kernel (CAD-PARITY-003).
 *
 * Pure, host-agnostic, deterministic. No Node/Browser APIs — this module is
 * imported identically by the Web host renderer, the shared prompt engine,
 * and the server-side App API handler (Web/Electron parity by construction).
 */

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export const EPS = 1e-9;
export const TAU = Math.PI * 2;

export function pt(x: number, y: number): Pt {
  return { x, y };
}

export function isPt(v: unknown): v is Pt {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as Pt).x === "number" && typeof (v as Pt).y === "number" &&
    Number.isFinite((v as Pt).x) && Number.isFinite((v as Pt).y)
  );
}

export function eq(a: number, b: number, tol = EPS): boolean {
  return Math.abs(a - b) <= tol;
}

export function ptEq(a: Pt, b: Pt, tol = EPS): boolean {
  return eq(a.x, b.x, tol) && eq(a.y, b.y, tol);
}

export function add(a: Pt, b: Pt): Pt {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function mul(a: Pt, k: number): Pt {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Pt, b: Pt): number {
  return a.x * b.y - a.y * b.x;
}

export function len(a: Pt): number {
  return Math.hypot(a.x, a.y);
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function norm(a: Pt): Pt {
  const l = len(a);
  if (l <= EPS) return { x: 0, y: 0 };
  return { x: a.x / l, y: a.y / l };
}

export function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Angle of vector in [0, TAU). */
export function angleOf(v: Pt): number {
  const a = Math.atan2(v.y, v.x);
  return a < 0 ? a + TAU : a;
}

/** Smallest signed difference b-a in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export function fromPolar(origin: Pt, angle: number, radius: number): Pt {
  return { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
}

export function rotatePt(p: Pt, about: Pt, angle: number): Pt {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c };
}

export function scalePt(p: Pt, about: Pt, factor: number): Pt {
  return { x: about.x + (p.x - about.x) * factor, y: about.y + (p.y - about.y) * factor };
}

/** Mirror p about the line (a, b). */
export function mirrorPt(p: Pt, a: Pt, b: Pt): Pt {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 <= EPS) return { ...p };
  const ap = sub(p, a);
  const t = dot(ap, ab) / l2;
  const proj = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { x: 2 * proj.x - p.x, y: 2 * proj.y - p.y };
}

/** Normalize angle into [0, TAU). */
export function normAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** Clamp v into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Round to a fixed number of decimals (for stable display + fuzzy compare). */
export function round(v: number, decimals = 9): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Project point p onto the infinite line through a with direction d.
 *  Returns t (parameter along d) and the projected point. */
export function projectOnLine(p: Pt, a: Pt, d: Pt): { t: number; point: Pt } {
  const l2 = dot(d, d);
  if (l2 <= EPS) return { t: 0, point: a };
  const t = dot(sub(p, a), d) / l2;
  return { t, point: { x: a.x + d.x * t, y: a.y + d.y * t } };
}

/** Point-segment distance + closest point. */
export function closestOnSegment(p: Pt, a: Pt, b: Pt): { point: Pt; t: number; d: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 <= EPS) return { point: a, t: 0, d: dist(p, a) };
  const t = clamp(dot(sub(p, a), ab) / l2, 0, 1);
  const point = lerp(a, b, t);
  return { point, t, d: dist(p, point) };
}

/** Line-line intersection of infinite lines (a1,d1) and (a2,d2).
 *  Returns null when parallel. */
export function lineLine(a1: Pt, d1: Pt, a2: Pt, d2: Pt): Pt | null {
  const denom = cross(d1, d2);
  if (Math.abs(denom) <= EPS) return null;
  const t = cross(sub(a2, a1), d2) / denom;
  return { x: a1.x + d1.x * t, y: a1.y + d1.y * t };
}

/** Segment-segment intersection (proper + touching endpoints). */
export function segmentSegment(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d1 = sub(a2, a1);
  const d2 = sub(b2, b1);
  const denom = cross(d1, d2);
  if (Math.abs(denom) > EPS) {
    const t = cross(sub(b1, a1), d2) / denom;
    const u = cross(sub(b1, a1), d1) / denom;
    if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) {
      return lerp(a1, a2, clamp(t, 0, 1));
    }
    return null;
  }
  // Parallel/collinear: check endpoint-on-segment touches.
  for (const [p, s1, s2] of [
    [a1, b1, b2],
    [a2, b1, b2],
    [b1, a1, a2],
    [b2, a1, a2],
  ] as const) {
    if (closestOnSegment(p, s1, s2).d <= 1e-7) return p;
  }
  return null;
}

/** Intersections of infinite line (origin o, direction d) with circle
 *  (center c, radius r). Sorted along the line by t. */
export function lineCircle(o: Pt, d: Pt, c: Pt, r: number): { t: number; point: Pt }[] {
  const f = sub(o, c);
  const a = dot(d, d);
  const b = 2 * dot(f, d);
  const cc = dot(f, f) - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0 || a <= EPS) return [];
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  return [t1, t2].map((t) => ({ t, point: { x: o.x + d.x * t, y: o.y + d.y * t } }));
}

/** Circle-circle intersections. Empty/one/two points. */
export function circleCircle(c1: Pt, r1: number, c2: Pt, r2: number): Pt[] {
  const d = dist(c1, c2);
  if (d <= EPS || d > r1 + r2 + EPS || d < Math.abs(r1 - r2) - EPS) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  if (h2 < 0) return [];
  const h = Math.sqrt(Math.max(0, h2));
  const m = { x: c1.x + (a * (c2.x - c1.x)) / d, y: c1.y + (a * (c2.y - c1.y)) / d };
  const res: Pt[] = [
    { x: m.x + (h * (c2.y - c1.y)) / d, y: m.y - (h * (c2.x - c1.x)) / d },
    { x: m.x - (h * (c2.y - c1.y)) / d, y: m.y + (h * (c2.x - c1.x)) / d },
  ];
  if (ptEq(res[0]!, res[1]!, 1e-9)) return [res[0]!];
  return res;
}

/** Angle of a point on a circle center c (atan2 based, [0, TAU)). */
export function angleAt(c: Pt, p: Pt): number {
  return normAngle(Math.atan2(p.y - c.y, p.x - c.x));
}

/** Is angle `a` within the CCW sweep [start, end]? Handles wrap-around. */
export function angleInSweep(a: number, start: number, end: number): boolean {
  const s = normAngle(start);
  const e = normAngle(end);
  const x = normAngle(a);
  if (eq(s, e, 1e-12)) return true; // degenerate full sweep
  if (s < e) return x >= s - 1e-12 && x <= e + 1e-12;
  return x >= s - 1e-12 || x <= e + 1e-12;
}

/** Point on circle at angle. */
export function circlePoint(c: Pt, r: number, angle: number): Pt {
  return { x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) };
}

/** Area of a simple polygon (shoelace). Positive when CCW. */
export function polygonArea(vertices: readonly Pt[]): number {
  let a = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const p = vertices[i]!;
    const q = vertices[(i + 1) % n]!;
    a += cross(p, q);
  }
  return a / 2;
}

/** Centroid of a simple polygon. */
export function polygonCentroid(vertices: readonly Pt[]): Pt {
  const n = vertices.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n === 1) return { ...vertices[0]! };
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const p = vertices[i]!;
    const q = vertices[(i + 1) % n]!;
    const f = cross(p, q);
    a += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  a /= 2;
  if (Math.abs(a) <= EPS) {
    // Degenerate: average vertices.
    let sx = 0;
    let sy = 0;
    for (const v of vertices) {
      sx += v.x;
      sy += v.y;
    }
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}
