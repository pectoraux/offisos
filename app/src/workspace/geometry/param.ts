/**
 * Unified entity parameterization + interval extraction (CAD-PARITY-003).
 *
 * TRIM, BREAK and "break at point" all reduce to: parameterize the entity,
 * project cut points to parameters, remove a parameter interval, and rebuild
 * the surviving pieces. Bounded linear entities become lines, circular
 * entities become arcs, unbounded tails stay rays — matching AutoCAD's
 * conversion behavior.
 *
 * Supported: line, ray, xline, circle, arc, polyline. Others report a typed
 * unsupported failure at the command layer (LOCK-007 honest limitation).
 */

import { angleAt, dist, EPS, normAngle, Pt, TAU } from "./math2d.js";
import {
  arcStart,
  arcSweep,
  polylineSegments,
  rayDir,
} from "./entities.js";
import type { Geom, PolylineGeom } from "./types.js";

export interface ParamDomain {
  readonly lo: number;
  readonly hi: number;
}

export function domainOf(g: Geom): ParamDomain {
  switch (g.type) {
    case "line":
      return { lo: 0, hi: 1 };
    case "ray":
      return { lo: 0, hi: Infinity };
    case "xline":
      return { lo: -Infinity, hi: Infinity };
    case "circle":
      return { lo: 0, hi: TAU };
    case "arc":
      return { lo: 0, hi: arcSweep(g) };
    case "polyline":
      return { lo: 0, hi: lengthOfPolyline(g) };
    default:
      return { lo: 0, hi: 0 };
  }
}

function lengthOfPolyline(g: PolylineGeom): number {
  let l = 0;
  for (const [a, b] of polylineSegments(g.vertices, g.closed)) l += dist(a, b);
  return l;
}

/** Parameter of the on-curve point nearest p (exact projection families). */
export function paramOf(g: Geom, p: Pt): number {
  switch (g.type) {
    case "line": {
      const a = { x: g.x1, y: g.y1 };
      const d = { x: g.x2 - g.x1, y: g.y2 - g.y1 };
      const l2 = d.x * d.x + d.y * d.y;
      if (l2 <= EPS) return 0;
      const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2;
      return Math.min(1, Math.max(0, t));
    }
    case "ray":
    case "xline": {
      const a = { x: g.x1, y: g.y1 };
      const d = rayDir(g);
      return (p.x - a.x) * d.x + (p.y - a.y) * d.y;
    }
    case "circle":
      return normAngle(angleAt({ x: g.cx, y: g.cy }, p));
    case "arc":
      return normAngle(angleAt({ x: g.cx, y: g.cy }, p) - g.startAngle);
    case "polyline": {
      let acc = 0;
      let best = 0;
      let bestD = Infinity;
      for (const [a, b] of polylineSegments(g.vertices, g.closed)) {
        const ab = { x: b.x - a.x, y: b.y - a.y };
        const l2 = ab.x * ab.x + ab.y * ab.y;
        let t = 0;
        if (l2 > EPS) {
          t = Math.min(1, Math.max(0, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2));
        }
        const q = { x: a.x + ab.x * t, y: a.y + ab.y * t };
        const d = dist(q, p);
        if (d < bestD) {
          bestD = d;
          best = acc + t * Math.sqrt(l2);
        }
        acc += Math.sqrt(l2);
      }
      return best;
    }
    default:
      return 0;
  }
}

/** Point on the entity at parameter t. */
export function pointAtParam(g: Geom, t: number): Pt {
  switch (g.type) {
    case "line":
      return { x: g.x1 + (g.x2 - g.x1) * t, y: g.y1 + (g.y2 - g.y1) * t };
    case "ray":
    case "xline": {
      const d = rayDir(g);
      return { x: g.x1 + d.x * t, y: g.y1 + d.y * t };
    }
    case "circle": {
      const a = t;
      return { x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) };
    }
    case "arc": {
      const a = g.startAngle + t;
      return { x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) };
    }
    case "polyline":
      return polylinePointAt(g, t);
    default:
      return { x: 0, y: 0 };
  }
}

function polylinePointAt(g: PolylineGeom, s: number): Pt {
  let acc = 0;
  for (const [a, b] of polylineSegments(g.vertices, g.closed)) {
    const l = dist(a, b);
    if (s <= acc + l || l <= EPS) {
      if (l <= EPS) return a;
      const t = (s - acc) / l;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    acc += l;
  }
  return g.vertices[g.vertices.length - 1] ?? { x: 0, y: 0 };
}

/** Build the geometry of parameter interval [t1, t2] (t1 <= t2). Unbounded
 *  tails become rays; bounded intervals become line/arc/polyline. Returns
 *  null for degenerate (zero-length / zero-sweep) intervals. */
export function subGeom(g: Geom, t1: number, t2: number): Geom | null {
  if (t2 - t1 <= LENGTH_EPS) return null;
  switch (g.type) {
    case "line":
    case "ray":
    case "xline": {
      const p1 = pointAtParam(g, t1);
      const p2 = pointAtParam(g, t2);
      if (dist(p1, p2) <= LENGTH_EPS) return null;
      return { type: "line", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }
    case "circle":
    case "arc": {
      const sweep = t2 - t1;
      if (Math.abs(sweep) <= ANGLE_EPS) return null;
      const start = g.type === "circle" ? t1 : g.startAngle + t1;
      if (sweep >= TAU - ANGLE_EPS) {
        // Full circle piece of a circle stays a circle.
        return { type: "circle", cx: g.cx, cy: g.cy, r: g.r };
      }
      return {
        type: "arc",
        cx: g.cx,
        cy: g.cy,
        r: g.r,
        startAngle: normAngle(start),
        endAngle: normAngle(start + sweep),
      };
    }
    case "polyline":
      return subPolyline(g, t1, t2);
    default:
      return null;
  }
}

const LENGTH_EPS = 1e-7;
const ANGLE_EPS = 1e-9;

function subPolyline(g: PolylineGeom, s1: number, s2: number): Geom | null {
  const total = lengthOfPolyline(g);
  const verts: Pt[] = [];
  verts.push(polylinePointAt(g, s1));
  let acc = 0;
  const inInterval = (p: number): boolean => {
    // Wrapped path membership: p, or p + total, lies strictly in (s1, s2).
    if (s1 < s2) return p > s1 + LENGTH_EPS && p < s2 - LENGTH_EPS;
    return p > s1 + LENGTH_EPS || p < s2 - LENGTH_EPS;
  };
  for (const [a, b] of polylineSegments(g.vertices, g.closed)) {
    const l = dist(a, b);
    const segEnd = acc + l;
    if (l > EPS && inInterval(segEnd)) {
      verts.push(b);
    }
    acc = segEnd;
  }
  const tail = polylinePointAt(g, s2);
  if (dist(tail, verts[verts.length - 1]!) > LENGTH_EPS) verts.push(tail);
  const unique: Pt[] = [];
  for (const v of verts) {
    if (unique.length === 0 || dist(unique[unique.length - 1]!, v) > LENGTH_EPS) unique.push(v);
  }
  if (unique.length < 2) return null;
  return { type: "polyline", vertices: unique, closed: false };
}

/** Sorted parameter intervals that REMAIN after removing [r1, r2]. */
export function remainingIntervals(
  domain: ParamDomain,
  r1: number,
  r2: number,
): readonly { lo: number; hi: number }[] {
  const out: { lo: number; hi: number }[] = [];
  if (r1 > domain.lo + LENGTH_EPS) out.push({ lo: domain.lo, hi: Math.min(r1, domain.hi) });
  if (r2 < domain.hi - LENGTH_EPS) out.push({ lo: Math.max(r2, domain.lo), hi: domain.hi });
  return out.filter((iv) => iv.hi - iv.lo > LENGTH_EPS);
}

/** For CLOSED entities (circle, closed polyline) the remainder of removing
 *  the CCW interval [r1, r2] is the single wrapped interval [r2, r1 + L]. */
export function wrappedRemaining(
  domain: ParamDomain,
  r1: number,
  r2: number,
): { lo: number; hi: number } | null {
  const lo = r2;
  const hi = r1 + domain.hi;
  if (hi - lo <= LENGTH_EPS || hi - lo >= domain.hi - LENGTH_EPS) {
    // Removed everything or nothing meaningful.
    if (hi - lo >= domain.hi - LENGTH_EPS) return null;
    return null;
  }
  return { lo, hi };
}

/** Arc start point helper re-export (used by command layer for previews). */
export { arcStart };
