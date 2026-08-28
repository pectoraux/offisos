/**
 * FILLET + CHAMFER (CAD-PARITY-003).
 *
 * Exact line-line corner construction (angle bisector; radius 0 = sharp
 * corner by extend/trim). The Polyline option applies the corner at every
 * vertex: CHAMFER stays a single polyline (vertex replacement is exact);
 * FILLET splits corners into separate arc entities because this build's
 * polylines carry straight segments only (documented divergence, surfaced in
 * the command output). Circle/arc pairs report a typed limitation instead of
 * an approximate result (LOCK-007).
 */

import {
  angleAt,
  dist,
  dot,
  EPS,
  lineLine,
  norm,
  normAngle,
  Pt,
  sub,
  add,
  mul,
  TAU,
} from "./math2d.js";
import type { ArcGeom, Geom, LineGeom, PolylineGeom } from "./types.js";

/** Line-family shape (the fillet/chamfer supported inputs). */
type Lineish = LineGeom | { type: "ray" | "xline"; x1: number; y1: number; x2: number; y2: number };

export class GeomOpError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface CornerResult {
  /** Trimmed/extended first entity (null when fully consumed). */
  readonly a: Geom | null;
  /** Trimmed/extended second entity (null when fully consumed). */
  readonly b: Geom | null;
  /** Fillet arc (null for radius 0 and for chamfers). */
  readonly arc: ArcGeom | null;
  /** Chamfer segment (chamfer only). */
  readonly chamfer: LineGeom | null;
}

function asInfiniteLine(g: Geom): { p: Pt; d: Pt } | null {
  if (g.type === "line" || g.type === "ray" || g.type === "xline") {
    return { p: { x: g.x1, y: g.y1 }, d: { x: g.x2 - g.x1, y: g.y2 - g.y1 } };
  }
  return null;
}

function lineEnds(l: Lineish): [Pt, Pt] {
  return [
    { x: l.x1, y: l.y1 },
    { x: l.x2, y: l.y2 },
  ];
}

/** Trim/extend a bounded line to end at `to` on the corner side, keeping the
 *  far endpoint (max projection onto the arm direction from X). */
function trimLineTo(l: Lineish, X: Pt, arm: Pt, to: Pt): LineGeom | null {
  const [e1, e2] = lineEnds(l);
  const p1 = dot(sub(e1, X), arm);
  const p2 = dot(sub(e2, X), arm);
  const kept = p1 >= p2 ? e1 : e2;
  if (dist(kept, to) <= 1e-7) return null;
  return { type: "line", x1: kept.x, y1: kept.y, x2: to.x, y2: to.y };
}

/** Arm direction of the infinite line towards the pick. */
function armTowards(l: { p: Pt; d: Pt }, X: Pt, pick: Pt): Pt {
  const u = norm(sub(pick, X));
  const dl = norm(l.d);
  return dot(u, dl) >= 0 ? dl : mul(dl, -1);
}

export function filletLineLine(a: Geom, b: Geom, pickA: Pt, pickB: Pt, r: number): CornerResult {
  const la = asInfiniteLine(a);
  const lb = asInfiniteLine(b);
  if (la === null || lb === null) {
    throw new GeomOpError("fillet corners in this build need two lines (circle/arc pairs: typed limitation)", "unsupported_pair");
  }
  const X = lineLine(la.p, la.d, lb.p, lb.d);
  if (X === null) throw new GeomOpError("lines are parallel — no corner to fillet", "parallel");
  const uA = armTowards(la, X, pickA);
  const uB = armTowards(lb, X, pickB);
  const la2 = a as Lineish;
  const lb2 = b as Lineish;
  if (r <= EPS) {
    return { a: trimLineTo(la2, X, uA, X), b: trimLineTo(lb2, X, uB, X), arc: null, chamfer: null };
  }
  const cos = Math.max(-1, Math.min(1, dot(uA, uB)));
  const theta = Math.acos(cos);
  const half = theta / 2;
  if (half <= EPS || Math.PI - half <= EPS) {
    throw new GeomOpError("cannot fillet collinear arms", "degenerate");
  }
  const bis = norm(add(uA, uB));
  const cDist = r / Math.sin(half);
  const tDist = r / Math.tan(half);
  const C = add(X, mul(bis, cDist));
  const tA = add(X, mul(uA, tDist));
  const tB = add(X, mul(uB, tDist));
  return {
    a: trimLineTo(la2, X, uA, tA),
    b: trimLineTo(lb2, X, uB, tB),
    arc: arcBetween(tA, tB, C, X),
    chamfer: null,
  };
}

export function chamferLineLine(
  a: Geom,
  b: Geom,
  pickA: Pt,
  pickB: Pt,
  d1: number,
  d2: number,
): CornerResult {
  const la = asInfiniteLine(a);
  const lb = asInfiniteLine(b);
  if (la === null || lb === null) {
    throw new GeomOpError("chamfer corners in this build need two lines", "unsupported_pair");
  }
  const X = lineLine(la.p, la.d, lb.p, lb.d);
  if (X === null) throw new GeomOpError("lines are parallel — no corner to chamfer", "parallel");
  const uA = armTowards(la, X, pickA);
  const uB = armTowards(lb, X, pickB);
  const cA = add(X, mul(uA, d1));
  const cB = add(X, mul(uB, d2));
  return {
    a: trimLineTo(a as Lineish, X, uA, cA),
    b: trimLineTo(b as Lineish, X, uB, cB),
    arc: null,
    chamfer: { type: "line", x1: cA.x, y1: cA.y, x2: cB.x, y2: cB.y },
  };
}

/** Arc from tA to tB around C whose midpoint stays nearest `ref` (the
 *  corner) — the arc that fills the corner. */
function arcBetween(tA: Pt, tB: Pt, C: Pt, ref: Pt): ArcGeom {
  const a0 = angleAt(C, tA);
  const a1 = angleAt(C, tB);
  const ccw = normAngle(a1 - a0);
  const midCCW = a0 + ccw / 2;
  const midCW = a1 + (TAU - ccw) / 2;
  const pCCW = { x: C.x + Math.cos(midCCW), y: C.y + Math.sin(midCCW) };
  const pCW = { x: C.x + Math.cos(midCW), y: C.y + Math.sin(midCW) };
  const useCCW = dist(pCCW, ref) <= dist(pCW, ref);
  const r = dist(C, tA);
  return useCCW
    ? { type: "arc", cx: C.x, cy: C.y, r, startAngle: a0, endAngle: normAngle(a1) }
    : { type: "arc", cx: C.x, cy: C.y, r, startAngle: a1, endAngle: normAngle(a0) };
}

/** FILLET Polyline option: fillet every vertex; corners are emitted as arc
 *  entities and the polyline is split at the tangent points (this build's
 *  polylines carry straight segments only). */
export function filletPolyline(pl: PolylineGeom, r: number): { pieces: PolylineGeom[]; arcs: ArcGeom[] } {
  const pieces: PolylineGeom[] = [];
  const arcs: ArcGeom[] = [];
  const verts = pl.vertices;
  const n = verts.length;

  // Pass 1: resolve every (interior) corner; record its tangent points.
  // A closed polyline fillets EVERY vertex (the chain wraps); an open one
  // keeps its first/last vertices (AutoCAD-class semantics).
  interface Corner {
    readonly tA: Pt;
    readonly tB: Pt;
  }
  const cornerAt: (Corner | null)[] = new Array<Corner | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    const interior = pl.closed ? true : i > 0 && i < n - 1;
    if (!interior) continue;
    const vPrev = verts[(i - 1 + n) % n]!;
    const v = verts[i]!;
    const vNext = verts[(i + 1) % n]!;
    const segA: LineGeom = { type: "line", x1: vPrev.x, y1: vPrev.y, x2: v.x, y2: v.y };
    const segB: LineGeom = { type: "line", x1: v.x, y1: v.y, x2: vNext.x, y2: vNext.y };
    try {
      const res = filletLineLine(segA, segB, vPrev, vNext, r);
      if (res.arc !== null && res.a !== null && res.b !== null) {
        cornerAt[i] = {
          tA: { x: (res.a as LineGeom).x2, y: (res.a as LineGeom).y2 },
          tB: { x: (res.b as LineGeom).x2, y: (res.b as LineGeom).y2 },
        };
        arcs.push(res.arc);
      }
    } catch {
      // Radius does not fit this corner — the vertex stays sharp.
    }
  }

  const firstCorner = cornerAt.findIndex((c) => c !== null);
  if (firstCorner === -1) {
    // No corner accepted the radius — the polyline is returned unchanged.
    return { pieces: [pl], arcs };
  }

  // Pass 2: emit the straight pieces between consecutive corners. For a
  // CLOSED polyline the walk wraps back to the first corner's tangent A —
  // the wrap-around piece (e.g. a rectangle's left edge) is emitted like
  // every other piece (regression: it used to be dropped).
  if (pl.closed) {
    let current: Pt[] = [cornerAt[firstCorner]!.tB];
    for (let k = 1; k < n; k++) {
      const i = (firstCorner + k) % n;
      const corner = cornerAt[i]!;
      if (corner !== null) {
        current.push(corner.tA);
        pieces.push({ type: "polyline", vertices: current, closed: false });
        current = [corner.tB];
      } else {
        current.push(verts[i]!);
      }
    }
    current.push(cornerAt[firstCorner]!.tA);
    pieces.push({ type: "polyline", vertices: current, closed: false });
    return { pieces, arcs };
  }

  let current: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const corner = cornerAt[i]!;
    if (corner !== null) {
      current.push(corner.tA);
      if (current.length >= 2) {
        pieces.push({ type: "polyline", vertices: current, closed: false });
      }
      current = [corner.tB];
    } else {
      current.push(verts[i]!);
    }
  }
  if (current.length >= 2) pieces.push({ type: "polyline", vertices: current, closed: false });
  return { pieces, arcs };
}

/** CHAMFER Polyline option: every interior vertex replaced by the two
 *  chamfer points (exact — stays a single polyline). */
export function chamferPolyline(pl: PolylineGeom, d1: number, d2: number): PolylineGeom {
  const verts = pl.vertices;
  const n = verts.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const interior = pl.closed ? true : i > 0 && i < n - 1;
    const vPrev = verts[(i - 1 + n) % n]!;
    const v = verts[i]!;
    const vNext = verts[(i + 1) % n]!;
    if (!interior) {
      out.push(v);
      continue;
    }
    const segA: LineGeom = { type: "line", x1: vPrev.x, y1: vPrev.y, x2: v.x, y2: v.y };
    const segB: LineGeom = { type: "line", x1: v.x, y1: v.y, x2: vNext.x, y2: vNext.y };
    try {
      const res = chamferLineLine(segA, segB, vPrev, vNext, d1, d2);
      if (res.a !== null && res.b !== null) {
        out.push({ x: (res.a as LineGeom).x2, y: (res.a as LineGeom).y2 });
        out.push({ x: (res.b as LineGeom).x2, y: (res.b as LineGeom).y2 });
        continue;
      }
      out.push(v);
    } catch {
      out.push(v);
    }
  }
  if (out.length < 2) return pl;
  return { type: "polyline", vertices: out, closed: pl.closed };
}
