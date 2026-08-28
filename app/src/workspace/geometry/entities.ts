/**
 * Per-entity operations: bounds, distances, closest points, key points,
 * polyline/spline evaluation. Deterministic, shared by renderer, precision
 * engine (osnap/pick) and modify commands (CAD-PARITY-003).
 */

import {
  angleAt,
  angleInSweep,
  closestOnSegment,
  dist,
  EPS,
  normAngle,
  Pt,
  TAU,
} from "./math2d.js";
import type {
  ArcGeom,
  CircleGeom,
  EllipseGeom,
  Geom,
  LineGeom,
  PolylineGeom,
  RayGeom,
  RegionGeom,
  SplineGeom,
  XLineGeom,
} from "./types.js";
import { bsplinePoint, bsplineSampleTs } from "./spline.js";

export interface BBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function bboxOfPoints(pts: readonly Pt[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function unionBox(a: BBox | null, b: BBox): BBox {
  if (a === null) return b;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Conservative bounding box of an entity (infinite entities use the draw
 *  extent — callers clamp to the visible viewport when rendering). */
export function bbox(g: Geom, drawExtent = 1e6): BBox {
  switch (g.type) {
    case "line":
      return bboxOfPoints([
        { x: g.x1, y: g.y1 },
        { x: g.x2, y: g.y2 },
      ]);
    case "polyline":
      return bboxOfPoints(g.vertices);
    case "circle":
      return { minX: g.cx - g.r, minY: g.cy - g.r, maxX: g.cx + g.r, maxY: g.cy + g.r };
    case "arc": {
      // Endpoints + any axis crossing inside the sweep.
      const pts: Pt[] = [
        arcStart(g),
        arcEnd(g),
      ];
      for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        if (angleInSweep(a, g.startAngle, g.endAngle)) {
          pts.push({ x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) });
        }
      }
      return bboxOfPoints(pts);
    }
    case "ellipse": {
      const c = Math.cos(g.rotation);
      const s = Math.sin(g.rotation);
      // Axis-aligned extent of a rotated ellipse:
      const ex = Math.hypot(g.rx * c, g.ry * s);
      const ey = Math.hypot(g.rx * s, g.ry * c);
      return { minX: g.cx - ex, minY: g.cy - ey, maxX: g.cx + ex, maxY: g.cy + ey };
    }
    case "spline":
      return bboxOfPoints(sampleSpline(g, 64));
    case "point":
      return { minX: g.x, minY: g.y, maxX: g.x, maxY: g.y };
    case "ray":
    case "xline": {
      const p1 = { x: g.x1, y: g.y1 };
      const p2 = { x: g.x2, y: g.y2 };
      return bboxOfPoints([p1, p2, extendInfinite(g, drawExtent).p2]);
    }
    case "region":
      return bboxOfPoints(regionBoundaryPolyline(g));
  }
}

/** Line segment vertices of a polyline (with closure). */
export function polylineSegments(v: readonly Pt[], closed: boolean): readonly (readonly [Pt, Pt])[] {
  const segs: [Pt, Pt][] = [];
  for (let i = 0; i + 1 < v.length; i++) {
    segs.push([v[i]!, v[i + 1]!]);
  }
  if (closed && v.length >= 3) {
    segs.push([v[v.length - 1]!, v[0]!]);
  }
  return segs;
}

export function arcStart(a: ArcGeom): Pt {
  return { x: a.cx + a.r * Math.cos(a.startAngle), y: a.cy + a.r * Math.sin(a.startAngle) };
}

export function arcEnd(a: ArcGeom): Pt {
  return { x: a.cx + a.r * Math.cos(a.endAngle), y: a.cy + a.r * Math.sin(a.endAngle) };
}

export function arcSweep(a: ArcGeom): number {
  return normAngle(a.endAngle - a.startAngle);
}

export function rayDir(g: RayGeom | XLineGeom): Pt {
  const dx = g.x2 - g.x1;
  const dy = g.y2 - g.y1;
  const l = Math.hypot(dx, dy);
  if (l <= EPS) return { x: 1, y: 0 };
  return { x: dx / l, y: dy / l };
}

/** Extend an infinite entity to a drawable segment within `extent` of the
 *  base point. Deterministic. */
export function extendInfinite(g: RayGeom | XLineGeom, extent: number): { p1: Pt; p2: Pt } {
  const d = rayDir(g);
  const base = { x: g.x1, y: g.y1 };
  if (g.type === "ray") {
    return { p1: base, p2: { x: base.x + d.x * extent, y: base.y + d.y * extent } };
  }
  return {
    p1: { x: base.x - d.x * extent, y: base.y - d.y * extent },
    p2: { x: base.x + d.x * extent, y: base.y + d.y * extent },
  };
}

export function sampleSpline(s: SplineGeom, perSegment = 32): Pt[] {
  const ts = bsplineSampleTs(s.controlPoints.length, s.degree, perSegment);
  return ts.map((t) => bsplinePoint(s.controlPoints, s.degree, t));
}

/** Boundary of a region as a polygon (for bbox/area/pick/trim reference). */
export function regionBoundaryPolyline(r: RegionGeom): readonly Pt[] {
  const b = r.boundary;
  if (b.kind === "polyline") return b.vertices;
  if (b.kind === "circle") {
    const out: Pt[] = [];
    const n = 128;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      out.push({ x: b.cx + b.r * Math.cos(a), y: b.cy + b.r * Math.sin(a) });
    }
    return out;
  }
  // Ellipse: sample + rotate.
  const out: Pt[] = [];
  const n = 128;
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const ex = b.rx * Math.cos(a);
    const ey = b.ry * Math.sin(a);
    out.push({ x: b.cx + ex * c - ey * s, y: b.cy + ex * s + ey * c });
  }
  return out;
}

/** Closest point on an entity to p, with distance. `drawExtent` bounds
 *  infinite entities. */
export function closestOn(g: Geom, p: Pt, drawExtent = 1e6): { point: Pt; d: number } {
  switch (g.type) {
    case "line":
    case "ray":
    case "xline": {
      if (g.type === "line") {
        const r = closestOnSegment(p, { x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 });
        return { point: r.point, d: r.d };
      }
      const { p1, p2 } = extendInfinite(g, drawExtent);
      const r = closestOnSegment(p, p1, p2);
      return { point: r.point, d: r.d };
    }
    case "polyline": {
      let best: { point: Pt; d: number } = { point: p, d: Infinity };
      for (const [a, b] of polylineSegments(g.vertices, g.closed)) {
        const r = closestOnSegment(p, a, b);
        if (r.d < best.d) best = { point: r.point, d: r.d };
      }
      return best;
    }
    case "circle": {
      const a = angleAt({ x: g.cx, y: g.cy }, p);
      const point = { x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) };
      return { point, d: dist(point, p) };
    }
    case "arc": {
      const a = angleAt({ x: g.cx, y: g.cy }, p);
      if (angleInSweep(a, g.startAngle, g.endAngle)) {
        const point = { x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) };
        return { point, d: dist(point, p) };
      }
      const s = arcStart(g);
      const e = arcEnd(g);
      const ds = dist(s, p);
      const de = dist(e, p);
      return ds <= de ? { point: s, d: ds } : { point: e, d: de };
    }
    case "ellipse": {
      // Newton refinement of closest point on the parametric ellipse
      // (deterministic fixed iteration count, same result on every host).
      const c = Math.cos(g.rotation);
      const s = Math.sin(g.rotation);
      const local = {
        x: (p.x - g.cx) * c + (p.y - g.cy) * s,
        y: -(p.x - g.cx) * s + (p.y - g.cy) * c,
      };
      let t = Math.atan2(local.y / Math.max(g.ry, EPS), local.x / Math.max(g.rx, EPS));
      for (let iter = 0; iter < 8; iter++) {
        const ca = Math.cos(t);
        const sa = Math.sin(t);
        const px = g.rx * ca;
        const py = g.ry * sa;
        const dx = px - local.x;
        const dy = py - local.y;
        const dpx = -g.rx * sa;
        const dpy = g.ry * ca;
        const grad = 2 * (dx * dpx + dy * dpy);
        const hess = 2 * (dpx * dpx + dpy * dpy);
        if (Math.abs(hess) < EPS) break;
        const step = grad / hess;
        t -= step;
        if (Math.abs(step) < 1e-12) break;
      }
      const lp = { x: g.rx * Math.cos(t), y: g.ry * Math.sin(t) };
      const point = {
        x: g.cx + lp.x * c - lp.y * s,
        y: g.cy + lp.x * s + lp.y * c,
      };
      return { point, d: dist(point, p) };
    }
    case "spline": {
      let best: { point: Pt; d: number } = { point: p, d: Infinity };
      const ts = bsplineSampleTs(g.controlPoints.length, g.degree, 24);
      let prev: Pt | null = null;
      for (const t of ts) {
        const q = bsplinePoint(g.controlPoints, g.degree, t);
        if (prev !== null) {
          const r = closestOnSegment(p, prev, q);
          if (r.d < best.d) best = { point: r.point, d: r.d };
        }
        prev = q;
      }
      return best;
    }
    case "point":
      return { point: { x: g.x, y: g.y }, d: dist({ x: g.x, y: g.y }, p) };
    case "region": {
      const poly = regionBoundaryPolyline(g);
      let best: { point: Pt; d: number } = { point: p, d: Infinity };
      for (const [a, b] of polylineSegments(poly, true)) {
        const r = closestOnSegment(p, a, b);
        if (r.d < best.d) best = { point: r.point, d: r.d };
      }
      return best;
    }
  }
}

/** Total length of an entity (infinite entities: draw extent double span). */
export function lengthOf(g: Geom, drawExtent = 1e6): number {
  switch (g.type) {
    case "line":
      return dist({ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 });
    case "polyline": {
      let l = 0;
      for (const [a, b] of polylineSegments(g.vertices, g.closed)) l += dist(a, b);
      return l;
    }
    case "circle":
      return TAU * g.r;
    case "arc":
      return arcSweep(g) * g.r;
    case "ellipse":
      // Ramanujan approximation (deterministic; documented).
      const h = ((g.rx - g.ry) / (g.rx + g.ry)) ** 2;
      return Math.PI * (g.rx + g.ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    case "spline": {
      const pts = sampleSpline(g, 24);
      let l = 0;
      for (let i = 0; i + 1 < pts.length; i++) l += dist(pts[i]!, pts[i + 1]!);
      return l;
    }
    case "point":
      return 0;
    case "ray":
      return drawExtent;
    case "xline":
      return 2 * drawExtent;
    case "region":
      return g.perimeter;
  }
}

/** Center of an entity (for osnap CEN + properties display). */
export function centerOf(g: Geom): Pt {
  switch (g.type) {
    case "line":
    case "ray":
    case "xline":
      return { x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 };
    case "polyline": {
      if (g.vertices.length === 0) return { x: 0, y: 0 };
      let sx = 0;
      let sy = 0;
      for (const v of g.vertices) {
        sx += v.x;
        sy += v.y;
      }
      return { x: sx / g.vertices.length, y: sy / g.vertices.length };
    }
    case "circle":
    case "arc":
    case "ellipse":
      return { x: g.cx, y: g.cy };
    case "spline": {
      const pts = g.controlPoints;
      let sx = 0;
      let sy = 0;
      for (const v of pts) {
        sx += v.x;
        sy += v.y;
      }
      return { x: sx / pts.length, y: sy / pts.length };
    }
    case "point":
      return { x: g.x, y: g.y };
    case "region":
      return g.centroid;
  }
}

/** Area of a closed entity (regions: stored; circles/ellipses/closed plines:
 *  computed). Open entities: 0. */
export function areaOf(g: Geom): number {
  switch (g.type) {
    case "region":
      return g.area;
    case "circle":
      return Math.PI * g.r * g.r;
    case "ellipse":
      return Math.PI * g.rx * g.ry;
    case "polyline":
      return g.closed ? polygonSignedArea(g.vertices) : 0;
    default:
      return 0;
  }
}

function polygonSignedArea(v: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < v.length; i++) {
    const p = v[i]!;
    const q = v[(i + 1) % v.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}
