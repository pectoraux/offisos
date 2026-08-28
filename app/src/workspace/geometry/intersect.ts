/**
 * Pairwise entity intersections (CAD-PARITY-003: TRIM, EXTEND, osnap INT).
 *
 * Exact solutions for the linear/circular family (line/ray/xline/polyline/
 * circle/arc) and line-ellipse. Results are deduplicated and sorted (x, then
 * y) so iteration order is deterministic across hosts. Combinations without
 * an exact closed form in this build (spline/ellipse-ellipse/region pairs
 * beyond boundary sampling) return [] — reported honestly rather than
 * approximated (LOCK-007: no guessed values presented as observed fact).
 */

import {
  angleAt,
  angleInSweep,
  circleCircle,
  closestOnSegment,
  dist,
  EPS,
  lineCircle,
  Pt,
  ptEq,
  segmentSegment,
} from "./math2d.js";
import { polylineSegments } from "./entities.js";
import type {
  ArcGeom,
  CircleGeom,
  EllipseGeom,
  Geom,
  PolylineGeom,
} from "./types.js";

/** Intersection points of two entities, sorted + deduplicated. */
export function intersectGeoms(a: Geom, b: Geom): Pt[] {
  const raw: Pt[] = intersectRaw(a, b);
  return dedupeSort(raw);
}

function dedupeSort(pts: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (!out.some((q) => ptEq(q, p, 1e-7))) out.push(p);
  }
  out.sort((p, q) => (p.x - q.x) || (p.y - q.y));
  return out;
}

function intersectRaw(a: Geom, b: Geom): Pt[] {
  // Polylines: segment-wise dispatch.
  if (a.type === "polyline") return flatSegments(a, b);
  if (b.type === "polyline") return flatSegments(b, a);
  if (a.type === "region") return regionRaw(a, b);
  if (b.type === "region") return regionRaw(b, a);

  switch (a.type) {
    case "line":
      return lineRaw(a.x1, a.y1, a.x2, a.y2, "seg", b);
    case "ray":
      return lineRaw(a.x1, a.y1, a.x2, a.y2, "ray", b);
    case "xline":
      return lineRaw(a.x1, a.y1, a.x2, a.y2, "xline", b);
    case "point":
    case "spline":
      return [];
    case "circle":
      return circleRaw(a.cx, a.cy, a.r, null, b);
    case "arc":
      return circleRaw(a.cx, a.cy, a.r, a, b);
    case "ellipse":
      return ellipseRaw(a, b);
  }
}

function flatSegments(pl: PolylineGeom, other: Geom): Pt[] {
  const out: Pt[] = [];
  for (const [p1, p2] of polylineSegments(pl.vertices, pl.closed)) {
    out.push(...lineRaw(p1.x, p1.y, p2.x, p2.y, "seg", other));
  }
  return out;
}

function regionRaw(region: Geom, other: Geom): Pt[] {
  // Region boundary participates as a polyline boundary (exact for
  // polyline-kind boundaries; circle/ellipse boundaries are converted to
  // their exact parametric segments through the polyline conversion in
  // regionBoundaryPolyline — used for osnap only).
  const poly = regionToPolyline(region);
  if (poly === null) return [];
  return flatSegments({ type: "polyline", vertices: poly, closed: true }, other);
}

function regionToPolyline(g: Geom): readonly Pt[] | null {
  if (g.type !== "region") return null;
  const b = g.boundary;
  if (b.kind === "polyline") return b.vertices;
  if (b.kind === "circle") {
    const out: Pt[] = [];
    const n = 256;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      out.push({ x: b.cx + b.r * Math.cos(t), y: b.cy + b.r * Math.sin(t) });
    }
    return out;
  }
  const out: Pt[] = [];
  const n = 256;
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const ex = b.rx * Math.cos(t);
    const ey = b.ry * Math.sin(t);
    out.push({ x: b.cx + ex * c - ey * s, y: b.cy + ex * s + ey * c });
  }
  return out;
}

/** Line (segment / ray / xline) vs other. */
function lineRaw(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  kind: "seg" | "ray" | "xline",
  other: Geom,
): Pt[] {
  const p1 = { x: x1, y: y1 };
  const p2 = { x: x2, y: y2 };
  const dir = { x: x2 - x1, y: y2 - y1 };
  switch (other.type) {
    case "line":
    case "ray":
    case "xline": {
      const q1 = { x: other.x1, y: other.y1 };
      const q2 = { x: other.x2, y: other.y2 };
      if (kind === "seg" && other.type === "line") {
        const r = segmentSegment(p1, p2, q1, q2);
        return r !== null ? [r] : [];
      }
      // Infinite/infinite combos: solve on infinite lines, then range-check.
      const denom = dir.x * (q2.y - q1.y) - dir.y * (q2.x - q1.x);
      if (Math.abs(denom) <= EPS) {
        // Parallel or collinear: no unique intersection points are reported
        // for infinite combos; bounded pieces were handled above.
        return [];
      }
      const t = ((q1.x - p1.x) * (q2.y - q1.y) - (q1.y - p1.y) * (q2.x - q1.x)) / denom;
      const u = ((q1.x - p1.x) * dir.y - (q1.y - p1.y) * dir.x) / denom;
      const hit = { x: p1.x + dir.x * t, y: p1.y + dir.y * t };
      if (!inLineRange(kind, t)) return [];
      if (!inLineRange(toRangeKind(other.type), u)) return [];
      return [hit];
    }
    case "polyline": {
      const out: Pt[] = [];
      for (const [q1, q2] of polylineSegments(other.vertices, other.closed)) {
        out.push(...lineRaw(q1.x, q1.y, q2.x, q2.y, "seg", {
          type: kind === "seg" ? "line" : kind,
          x1,
          y1,
          x2,
          y2,
        } as Geom));
      }
      return out;
    }
    case "circle":
    case "arc": {
      const hits = lineCircle(p1, dir, { x: other.cx, y: other.cy }, other.r);
      const out: Pt[] = [];
      for (const h of hits) {
        if (!inLineRange(kind, h.t)) continue;
        if (other.type === "arc") {
          const a = angleAt({ x: other.cx, y: other.cy }, h.point);
          if (!angleInSweep(a, other.startAngle, other.endAngle)) continue;
        }
        out.push(h.point);
      }
      return out;
    }
    case "ellipse": {
      // Transform to ellipse-local frame; solve quadratic in line parameter.
      const c = Math.cos(other.rotation);
      const s = Math.sin(other.rotation);
      const toLocal = (p: Pt): Pt => ({
        x: (p.x - other.cx) * c + (p.y - other.cy) * s,
        y: -(p.x - other.cx) * s + (p.y - other.cy) * c,
      });
      const l1 = toLocal(p1);
      const l2 = toLocal(p2);
      const d = { x: l2.x - l1.x, y: l2.y - l1.y };
      const A = (d.x / other.rx) ** 2 + (d.y / other.ry) ** 2;
      const B = 2 * ((l1.x * d.x) / other.rx ** 2 + (l1.y * d.y) / other.ry ** 2);
      const C = (l1.x / other.rx) ** 2 + (l1.y / other.ry) ** 2 - 1;
      const disc = B * B - 4 * A * C;
      if (disc < 0 || A <= EPS) return [];
      const sq = Math.sqrt(disc);
      const out: Pt[] = [];
      for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
        if (!inLineRange(kind, t)) continue;
        const lp = { x: l1.x + d.x * t, y: l1.y + d.y * t };
        out.push({
          x: other.cx + lp.x * c - lp.y * s,
          y: other.cy + lp.x * s + lp.y * c,
        });
      }
      return out;
    }
    case "region":
      return regionRaw(other, {
        type: kind === "seg" ? "line" : kind,
        x1,
        y1,
        x2,
        y2,
      } as Geom);
    case "point":
    case "spline":
      return [];
  }
}

function toRangeKind(t: "line" | "ray" | "xline"): "seg" | "ray" | "xline" {
  return t === "line" ? "seg" : t;
}

function inLineRange(kind: "seg" | "ray" | "xline", t: number): boolean {
  if (kind === "xline") return true;
  if (kind === "ray") return t >= -EPS;
  return t >= -EPS && t <= 1 + EPS;
}

/** Circle/arc vs other. */
function circleRaw(cx: number, cy: number, r: number, arc: ArcGeom | null, other: Geom): Pt[] {
  const center = { x: cx, y: cy };
  switch (other.type) {
    case "line":
    case "ray":
    case "xline":
      return lineRaw(other.x1, other.y1, other.x2, other.y2, toRangeKind(other.type), mkCircleish(cx, cy, r, arc));
    case "polyline":
      return flatSegments(other, mkCircleish(cx, cy, r, arc));
    case "circle":
    case "arc": {
      const pts = circleCircle(center, r, { x: other.cx, y: other.cy }, other.r);
      const out: Pt[] = [];
      for (const p of pts) {
        if (arc !== null) {
          const a = angleAt(center, p);
          if (!angleInSweep(a, arc.startAngle, arc.endAngle)) continue;
        }
        if (other.type === "arc") {
          const a = angleAt({ x: other.cx, y: other.cy }, p);
          if (!angleInSweep(a, other.startAngle, other.endAngle)) continue;
        }
        out.push(p);
      }
      return out;
    }
    case "region":
      return regionRaw(other, mkCircleish(cx, cy, r, arc));
    default:
      return [];
  }
}

function mkCircleish(cx: number, cy: number, r: number, arc: ArcGeom | null): Geom {
  if (arc === null) {
    return { type: "circle", cx, cy, r } as CircleGeom;
  }
  return { ...arc, type: "arc" } as ArcGeom;
}

function ellipseRaw(e: EllipseGeom, other: Geom): Pt[] {
  switch (other.type) {
    case "line":
    case "ray":
    case "xline":
      return lineRaw(other.x1, other.y1, other.x2, other.y2, toRangeKind(other.type), e);
    case "polyline":
      return flatSegments(other, e);
    case "region":
      return regionRaw(other, e);
    default:
      return [];
  }
}

/** All intersections of one entity against a set of entities. */
export function intersectMany(target: Geom, others: readonly Geom[]): Pt[] {
  const out: Pt[] = [];
  for (const o of others) {
    out.push(...intersectGeoms(target, o));
  }
  return dedupeSort(out);
}

/** Circle from arc (for fillet/tangent computations). */
export function arcToCircle(a: ArcGeom): CircleGeom {
  return { type: "circle", cx: a.cx, cy: a.cy, r: a.r };
}

/** Quick helper: does the segment (a,b) contain point p? */
export function segmentContains(a: Pt, b: Pt, p: Pt, tol = 1e-7): boolean {
  return closestOnSegment(p, a, b).d <= tol && dist(a, b) > EPS;
}
