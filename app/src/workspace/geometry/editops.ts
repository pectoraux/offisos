/**
 * Editing operations (CAD-PARITY-003): TRIM, EXTEND, BREAK, JOIN, EXPLODE,
 * STRETCH and REGION construction — built on the unified entity
 * parameterization. Every function is pure and returns replacement geometry
 * (or null = delete). Typed GeomOpError failures carry stable codes for the
 * command layer to surface verbatim.
 */

import { angleAt, dist, EPS, normAngle, Pt, sub, TAU, add } from "./math2d.js";
import {
  arcEnd,
  arcStart,
  arcSweep,
  closestOn,
  polylineSegments,
  rayDir,
  regionBoundaryPolyline,
  lengthOf,
} from "./entities.js";
import { intersectGeoms } from "./intersect.js";
import {
  domainOf,
  paramOf,
  pointAtParam,
  remainingIntervals,
  subGeom,
  wrappedRemaining,
} from "./param.js";
import { polygonArea, polygonCentroid } from "./math2d.js";
import { splineToPolyline } from "./spline.js";
import { GeomOpError } from "./fillet.js";
import type { Geom, PolylineGeom, RegionBoundary, RegionGeom } from "./types.js";

/** TRIM: remove the piece of `target` (nearest to `pick`) cut by `edges`. */
export function trimGeom(
  target: Geom,
  edges: readonly Geom[],
  pick: Pt,
): Geom[] | null {
  if (target.type === "ellipse" || target.type === "spline" || target.type === "region") {
    throw new GeomOpError(`TRIM does not support ${target.type} exactly in this build`, "unsupported");
  }
  const cuts = edges.flatMap((e) => intersectGeoms(target, e));
  if (cuts.length === 0) {
    throw new GeomOpError("no cutting edges intersect the entity", "no_cut");
  }
  const domain = domainOf(target);
  const pickParam = paramOf(target, pick);
  const params = cuts.map((p) => paramOf(target, p));
  const clamped = params
    .map((p) => {
      // Wrap circle params into [0, TAU); bound line params into [0,1].
      if (target.type === "circle") return normAngle(p);
      if (target.type === "line") return Math.min(1, Math.max(0, p));
      return p;
    })
    .filter((p) => {
      if (target.type === "line") return p > 1e-7 && p < 1 - 1e-7;
      if (target.type === "ray") return p > 1e-7;
      if (target.type === "xline") return true;
      return p > 1e-7 && p < domain.hi - 1e-7;
    })
    .sort((a, b) => a - b);
  const uniq: number[] = [];
  for (const p of clamped) {
    if (uniq.length === 0 || Math.abs(p - uniq[uniq.length - 1]!) > 1e-7) uniq.push(p);
  }
  if (uniq.length === 0) {
    throw new GeomOpError("cuts fall on the entity ends — nothing to trim", "no_cut");
  }

  const closed = target.type === "circle" || (target.type === "polyline" && target.closed);
  // Interval containing the pick (wrapped domain for closed entities).
  let r1: number;
  let r2: number;
  if (closed) {
    const pp = normWrap(pickParam, domain.hi);
    const sorted = uniq.map((p) => p).sort((a, b) => a - b);
    let lo = -Infinity;
    let hi = Infinity;
    for (const p of sorted) {
      if (p <= pp + 1e-9) lo = Math.max(lo, p);
      if (p >= pp - 1e-9) hi = Math.min(hi, p);
    }
    if (lo === -Infinity) lo = sorted[sorted.length - 1]! - domain.hi;
    if (hi === Infinity) hi = sorted[0]! + domain.hi;
    r1 = lo;
    r2 = hi;
  } else {
    let lo = domain.lo;
    let hi = domain.hi;
    for (const p of uniq) {
      if (p <= pickParam + 1e-9) lo = Math.max(lo, p);
      if (p >= pickParam - 1e-9) hi = Math.min(hi, p);
    }
    r1 = lo;
    r2 = hi;
  }

  if (r2 - r1 <= 1e-7) {
    throw new GeomOpError("cut interval is degenerate", "degenerate");
  }

  // Whole-domain removal => delete.
  const total = domain.hi - domain.lo;
  if (r2 - r1 >= total - 1e-7) return null;

  if (closed) {
    const wrapped = wrappedRemaining(domain, r1, r2);
    if (wrapped === null) return null;
    const piece = subGeom(target, wrapped.lo, wrapped.hi);
    return piece !== null ? [piece] : null;
  }
  const ivs = remainingIntervals(domain, r1, r2);
  const out: Geom[] = [];
  for (const iv of ivs) {
    const piece = subGeom(target, iv.lo, iv.hi);
    if (piece !== null) out.push(piece);
  }
  return out;
}

function normWrap(p: number, total: number): number {
  const r = p % total;
  return r < 0 ? r + total : r;
}

/** EXTEND: extend the end of `target` nearest `pick` to the nearest boundary. */
export function extendGeom(
  target: Geom,
  boundaries: readonly Geom[],
  pick: Pt,
): Geom {
  switch (target.type) {
    case "circle":
      throw new GeomOpError("circles have no ends to extend", "unsupported");
    case "ray":
    case "xline":
      throw new GeomOpError("construction entities are already infinite", "unsupported");
    case "ellipse":
    case "spline":
    case "region":
      throw new GeomOpError(`EXTEND does not support ${target.type} exactly in this build`, "unsupported");
    case "line": {
      const a = { x: target.x1, y: target.y1 };
      const b = { x: target.x2, y: target.y2 };
      const extendFromB = dist(pick, b) < dist(pick, a);
      const fixed = extendFromB ? a : b;
      const free = extendFromB ? b : a;
      const dir = sub(free, fixed);
      if (dist(free, fixed) <= EPS) throw new GeomOpError("degenerate line", "degenerate");
      // Nearest boundary hit along the extension ray from `free`.
      let bestT = Infinity;
      let bestP: Pt | null = null;
      for (const bnd of boundaries) {
        const hits = intersectGeoms(
          { type: "ray", x1: fixed.x, y1: fixed.y, x2: free.x, y2: free.y },
          bnd,
        );
        for (const h of hits) {
          const t = paramOf(
            { type: "ray", x1: fixed.x, y1: fixed.y, x2: free.x, y2: free.y },
            h,
          );
          if (t > 1 + 1e-9 && t < bestT) {
            bestT = t;
            bestP = h;
          }
        }
      }
      if (bestP === null) {
        throw new GeomOpError("no boundary intersection in the extension direction", "no_boundary");
      }
      return { type: "line", x1: fixed.x, y1: fixed.y, x2: bestP.x, y2: bestP.y };
    }
    case "arc": {
      const c = { x: target.cx, y: target.cy };
      const s = arcStart(target);
      const e = arcEnd(target);
      const sweep = arcSweep(target);
      const extendFromEnd = dist(pick, e) < dist(pick, s);
      // Directed interval semantics (Architect review): arcs run CCW from
      // start to end. Extending the END moves it CCW beyond the current end;
      // extending the START moves it BACKWARDS (CW). In both directions the
      // new end angle must land in the complementary arc (the gap between
      // the end and the start) — a boundary crossing INSIDE the current
      // sweep is never a valid extension target (it would shorten or
      // misorient the arc). The swept interval only ever GROWS and stays
      // strictly below TAU.
      const maxExtension = TAU - sweep - 1e-9;
      if (maxExtension <= 1e-9) {
        throw new GeomOpError("the arc already sweeps the full circle — nothing to extend", "no_boundary");
      }
      let bestAngle: number | null = null;
      let bestDelta = Infinity;
      for (const bnd of boundaries) {
        const hits = intersectGeoms({ type: "circle", cx: c.x, cy: c.y, r: target.r }, bnd);
        for (const h of hits) {
          const a = angleAt(c, h);
          // End-side: CCW distance from the current end to the hit.
          // Start-side: CW distance from the current start to the hit
          // (= the CCW distance from the hit back to the start).
          const delta = extendFromEnd
            ? normAngle(a - target.endAngle)
            : normAngle(target.startAngle - a);
          if (delta > 1e-9 && delta <= maxExtension && delta < bestDelta) {
            bestDelta = delta;
            bestAngle = a;
          }
        }
      }
      if (bestAngle === null) {
        throw new GeomOpError("no boundary intersection along the arc's extension", "no_boundary");
      }
      if (extendFromEnd) {
        // New sweep = sweep + bestDelta (< TAU by the bound above).
        return { ...target, endAngle: normAngle(bestAngle) };
      }
      // The start moves backwards to the hit; the end keeps its angle. The
      // new sweep normAngle(end - newStart) = sweep + bestDelta — the arc
      // grows by exactly the picked extension.
      return { ...target, startAngle: normAngle(bestAngle) };
    }
    case "polyline": {
      const total = lengthOf(target);
      const pickParam = paramOf(target, pick);
      const extendEnd = pickParam > total / 2;
      if (extendEnd) {
        const last = target.vertices[target.vertices.length - 1]!;
        const prev = target.vertices[target.vertices.length - 2]!;
        const extended = extendFreeEnd({ x1: prev.x, y1: prev.y, x2: last.x, y2: last.y }, boundaries);
        const newLast = { x: extended.x2, y: extended.y2 };
        return { ...target, vertices: [...target.vertices.slice(0, -1), newLast] };
      }
      const first = target.vertices[0]!;
      const second = target.vertices[1]!;
      const extended = extendFreeEnd({ x1: second.x, y1: second.y, x2: first.x, y2: first.y }, boundaries);
      const newFirst = { x: extended.x2, y: extended.y2 };
      return { ...target, vertices: [newFirst, ...target.vertices.slice(1)] };
    }
    case "point":
      throw new GeomOpError("points cannot be extended", "unsupported");
  }
}

function extendFreeEnd(
  seg: { x1: number; y1: number; x2: number; y2: number },
  boundaries: readonly Geom[],
): { x2: number; y2: number } {
  // Extend the segment beyond its second endpoint to the nearest boundary.
  const a = { x: seg.x1, y: seg.y1 };
  const b = { x: seg.x2, y: seg.y2 };
  let bestT = Infinity;
  let bestP: Pt | null = null;
  for (const bnd of boundaries) {
    const hits = intersectGeoms(
      { type: "ray", x1: a.x, y1: a.y, x2: b.x, y2: b.y },
      bnd,
    );
    for (const h of hits) {
      const t = paramOf({ type: "ray", x1: a.x, y1: a.y, x2: b.x, y2: b.y }, h);
      if (t > 1 + 1e-9 && t < bestT) {
        bestT = t;
        bestP = h;
      }
    }
  }
  if (bestP === null) throw new GeomOpError("no boundary intersection in the extension direction", "no_boundary");
  return { x2: bestP.x, y2: bestP.y };
}

/** BREAK: remove the parameter interval [p1, p2] (p2 null = split at p1). */
export function breakGeom(target: Geom, p1: Pt, p2: Pt | null): Geom[] | null {
  if (target.type === "ellipse" || target.type === "spline" || target.type === "region" || target.type === "point") {
    throw new GeomOpError(`BREAK does not support ${target.type} in this build`, "unsupported");
  }
  const domain = domainOf(target);
  const t1 = clampParam(target, paramOf(target, p1), domain);
  if (p2 === null) {
    // Split at a single point.
    if (t1 <= domain.lo + 1e-7 || t1 >= domain.hi - 1e-7) {
      throw new GeomOpError("break point is on the entity end", "degenerate");
    }
    const first = subGeom(target, domain.lo, t1);
    const second = subGeom(target, t1, domain.hi);
    const out = [first, second].filter((g): g is Geom => g !== null);
    return out.length > 0 ? out : null;
  }
  const t2 = clampParam(target, paramOf(target, p2), domain);
  const lo = Math.min(t1, t2);
  const hi = Math.max(t1, t2);
  const closed = target.type === "circle" || (target.type === "polyline" && target.closed);
  if (closed) {
    // Remove the interval that runs from t1 to t2 in the CCW direction
    // (AutoCAD removes the portion going CCW from the first pick).
    const ccwLo = t1;
    const ccwHi = t2 < t1 ? t2 + domain.hi : t2;
    if (ccwHi - ccwLo >= domain.hi - 1e-7) {
      // Everything removed.
      return null;
    }
    if (ccwHi - ccwLo <= 1e-7) {
      // Single point: split.
      const first = subGeom(target, domain.lo, ccwLo);
      const second = subGeom(target, ccwLo, domain.hi);
      const out = [first, second].filter((g): g is Geom => g !== null);
      return out.length > 0 ? out : null;
    }
    const wrapped = wrappedRemaining(domain, ccwLo, ccwHi);
    if (wrapped === null) return null;
    const piece = subGeom(target, wrapped.lo, wrapped.hi);
    return piece !== null ? [piece] : null;
  }
  if (hi - lo >= domain.hi - domain.lo - 1e-7) return null;
  if (hi - lo <= 1e-7) {
    // Degenerate: split at the point.
    const first = subGeom(target, domain.lo, lo);
    const second = subGeom(target, lo, domain.hi);
    const out = [first, second].filter((g): g is Geom => g !== null);
    return out.length > 0 ? out : null;
  }
  const ivs = remainingIntervals(domain, lo, hi);
  const out: Geom[] = [];
  for (const iv of ivs) {
    const piece = subGeom(target, iv.lo, iv.hi);
    if (piece !== null) out.push(piece);
  }
  return out;
}

function clampParam(g: Geom, p: number, domain: { lo: number; hi: number }): number {
  if (g.type === "circle") return normWrap(p, domain.hi);
  if (g.type === "line") return Math.min(1, Math.max(0, p));
  if (g.type === "arc") return Math.min(domain.hi, Math.max(0, p));
  if (g.type === "ray") return Math.max(0, p);
  return p;
}

/** JOIN: combine entities when geometrically possible. */
export function joinGeoms(entities: readonly Geom[]): Geom {
  if (entities.length < 2) throw new GeomOpError("join needs at least two entities", "bad_input");
  const types = new Set(entities.map((e) => e.type));

  if (types.size === 1 && entities[0]!.type === "line") {
    return joinLines(entities as Extract<Geom, { type: "line" }>[]);
  }
  if (types.size === 1 && (entities[0]!.type === "arc" || entities[0]!.type === "circle")) {
    return joinArcs(entities);
  }
  // Polyline-anchored join: polyline absorbs lines/arcs/polylines that
  // connect end-to-end.
  if (entities.some((e) => e.type === "polyline")) {
    return joinIntoPolyline(entities);
  }
  throw new GeomOpError("these entities cannot be joined (collinear lines, same-circle arcs, or end-continuous polylines only)", "no_join");
}

function joinLines(lines: readonly (Geom & { type: "line" })[]): Geom {
  // All must be collinear.
  const first = lines[0]!;
  const a = { x: first.x1, y: first.y1 };
  const dir = sub({ x: first.x2, y: first.y2 }, a);
  const l = Math.hypot(dir.x, dir.y);
  if (l <= EPS) throw new GeomOpError("degenerate line", "degenerate");
  const u = { x: dir.x / l, y: dir.y / l };
  const tol = 1e-6 * Math.max(1, l);
  // Project every line onto the shared direction (collinearity required).
  const intervals = lines.map((ln) => {
    const p1 = { x: ln.x1, y: ln.y1 };
    const p2 = { x: ln.x2, y: ln.y2 };
    const t1 = (p1.x - a.x) * u.x + (p1.y - a.y) * u.y;
    const t2 = (p2.x - a.x) * u.x + (p2.y - a.y) * u.y;
    // Collinearity check: perpendicular distance < tol.
    const perp1 = Math.abs((p1.x - a.x) * u.y - (p1.y - a.y) * u.x);
    const perp2 = Math.abs((p2.x - a.x) * u.y - (p2.y - a.y) * u.x);
    if (perp1 > tol || perp2 > tol) {
      throw new GeomOpError("lines are not collinear", "no_join");
    }
    return { lo: Math.min(t1, t2), hi: Math.max(t1, t2) };
  });
  // The projected intervals must form ONE CONTIGUOUS span: JOIN combines
  // collinear lines that touch or overlap — it never fabricates the span
  // between disconnected pieces (Architect review: canonical modify
  // operations must not invent geometry). A gap is a typed failure.
  const sorted = [...intervals].sort((x, y) => x.lo - y.lo || x.hi - y.hi);
  let lo = sorted[0]!.lo;
  let hi = sorted[0]!.hi;
  for (const iv of sorted.slice(1)) {
    if (iv.lo > hi + tol) {
      throw new GeomOpError(
        "collinear lines have a gap — JOIN cannot fabricate the missing span (draw the span or move the endpoints together first)",
        "no_join",
      );
    }
    hi = Math.max(hi, iv.hi);
  }
  if (hi - lo <= EPS) throw new GeomOpError("degenerate join", "degenerate");
  return {
    type: "line",
    x1: a.x + u.x * lo,
    y1: a.y + u.y * lo,
    x2: a.x + u.x * hi,
    y2: a.y + u.y * hi,
  };
}

function joinArcs(arcs: readonly Geom[]): Geom {
  const asArcs = arcs.filter((a): a is Extract<Geom, { type: "arc" }> => a.type === "arc");
  if (asArcs.length !== arcs.length) {
    throw new GeomOpError("join circles with circles is not defined; use arcs", "no_join");
  }
  const first = asArcs[0]!;
  const c = { x: first.cx, y: first.cy };
  for (const a of asArcs.slice(1)) {
    if (dist({ x: a.cx, y: a.cy }, c) > 1e-6 || Math.abs(a.r - first.r) > 1e-6) {
      throw new GeomOpError("arcs are not on the same circle", "no_join");
    }
  }
  // Contiguity on the shared circle (same rule as joinLines: JOIN never
  // fabricates the arc between disconnected pieces). Cut the circle at the
  // first arc's start (a boundary point, never interior to any interval),
  // unwrap every arc to [t, t + sweep] with t in [0, TAU), sort by t and
  // walk: each interval must touch or overlap the accumulated span.
  const tol = 1e-7;
  const cut = normAngle(asArcs[0]!.startAngle);
  const intervals = asArcs
    .map((a) => {
      const t = normAngle(normAngle(a.startAngle) - cut);
      return { t, w: arcSweep(a) };
    })
    .sort((x, y) => x.t - y.t);
  let hi = 0;
  for (const iv of intervals) {
    if (iv.t > hi + tol) {
      throw new GeomOpError(
        "arcs on the same circle have a gap — JOIN cannot fabricate the missing arc (draw the arc or move the endpoints together first)",
        "no_join",
      );
    }
    hi = Math.max(hi, iv.t + iv.w);
  }
  if (hi >= TAU - 1e-7) {
    // Contiguous coverage of the full circle.
    return { type: "circle", cx: c.x, cy: c.y, r: first.r };
  }
  const sweep = hi;
  if (sweep <= 1e-7) throw new GeomOpError("arcs do not overlap or touch", "no_join");
  const start = cut;
  return { type: "arc", cx: c.x, cy: c.y, r: first.r, startAngle: start, endAngle: normAngle(start + sweep) };
}

function joinIntoPolyline(entities: readonly Geom[]): PolylineGeom {
  // Start from the polyline (or first entity), repeatedly absorb the entity
  // whose endpoint matches a free end (within tolerance).
  const remaining = [...entities];
  const plIdx = remaining.findIndex((e) => e.type === "polyline");
  let current: Pt[] = [...(remaining[plIdx]! as PolylineGeom).vertices];
  remaining.splice(plIdx, 1);
  const TOL = 1e-6;
  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    for (let i = 0; i < remaining.length; i++) {
      const e = remaining[i]!;
      const pts = geomEndpointChain(e);
      if (pts === null) continue;
      // Try append at the end.
      const endPt = current[current.length - 1]!;
      if (dist(endPt, pts[0]!) <= TOL) {
        current = [...current, ...pts.slice(1)];
        remaining.splice(i, 1);
        progress = true;
        break;
      }
      if (dist(endPt, pts[pts.length - 1]!) <= TOL) {
        current = [...current, ...[...pts].reverse().slice(1)];
        remaining.splice(i, 1);
        progress = true;
        break;
      }
      // Try prepend at the start.
      const startPt = current[0]!;
      if (dist(startPt, pts[pts.length - 1]!) <= TOL) {
        current = [...pts.slice(0, -1), ...current];
        remaining.splice(i, 1);
        progress = true;
        break;
      }
      if (dist(startPt, pts[0]!) <= TOL) {
        current = [...[...pts].reverse().slice(0, -1), ...current];
        remaining.splice(i, 1);
        progress = true;
        break;
      }
    }
  }
  if (remaining.length > 0) {
    throw new GeomOpError("some entities do not connect end-to-end", "no_join");
  }
  if (current.length < 2) throw new GeomOpError("degenerate join", "degenerate");
  return { type: "polyline", vertices: current, closed: false };
}

function geomEndpointChain(g: Geom): readonly Pt[] | null {
  switch (g.type) {
    case "line":
      return [{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }];
    case "polyline":
      return g.vertices;
    case "arc":
      return [arcStart(g), arcEnd(g)];
    default:
      return null;
  }
}

/** EXPLODE: polyline -> segments, region -> boundary, spline -> polyline
 *  approximation (documented), others -> typed failure. */
export function explodeGeom(g: Geom): Geom[] {
  switch (g.type) {
    case "polyline": {
      const out: Geom[] = [];
      for (const [a, b] of polylineSegments(g.vertices, g.closed)) {
        out.push({ type: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
      if (out.length === 0) throw new GeomOpError("empty polyline", "degenerate");
      return out;
    }
    case "region": {
      const b = g.boundary;
      if (b.kind === "polyline") {
        return [{ type: "polyline", vertices: b.vertices, closed: true }];
      }
      if (b.kind === "circle") {
        return [{ type: "circle", cx: b.cx, cy: b.cy, r: b.r }];
      }
      return [{ type: "ellipse", cx: b.cx, cy: b.cy, rx: b.rx, ry: b.ry, rotation: b.rotation }];
    }
    case "spline": {
      // Deterministic documented approximation (32 samples per span).
      return [{ type: "polyline", vertices: splineToPolyline(g.controlPoints, g.degree, 32), closed: false }];
    }
    default:
      throw new GeomOpError(`${g.type} has nothing to explode`, "unsupported");
  }
}

/** STRETCH: move every vertex/control point/center inside the crossing
 *  window by (dx, dy); radii and orientations are preserved. */
export function stretchGeom(g: Geom, winMin: Pt, winMax: Pt, dx: number, dy: number): Geom {
  const inside = (p: Pt): boolean =>
    p.x >= Math.min(winMin.x, winMax.x) - 1e-9 &&
    p.x <= Math.max(winMin.x, winMax.x) + 1e-9 &&
    p.y >= Math.min(winMin.y, winMax.y) - 1e-9 &&
    p.y <= Math.max(winMin.y, winMax.y) + 1e-9;
  const mv = (p: Pt): Pt => (inside(p) ? { x: p.x + dx, y: p.y + dy } : p);
  switch (g.type) {
    case "line":
    case "ray":
    case "xline": {
      const p1 = mv({ x: g.x1, y: g.y1 });
      const p2 = mv({ x: g.x2, y: g.y2 });
      return { ...g, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }
    case "polyline":
      return { ...g, vertices: g.vertices.map(mv) };
    case "circle":
    case "arc":
    case "ellipse": {
      const c = mv({ x: g.cx, y: g.cy });
      return { ...g, cx: c.x, cy: c.y };
    }
    case "spline":
      return { ...g, controlPoints: g.controlPoints.map(mv) };
    case "point":
      return { ...g, ...mv({ x: g.x, y: g.y }) };
    case "region": {
      const c = mv(g.centroid);
      return {
        ...g,
        boundary: stretchBoundary(g, mv),
        centroid: c,
      };
    }
  }
}

function stretchBoundary(r: RegionGeom, mv: (p: Pt) => Pt): RegionBoundary {
  const b = r.boundary;
  if (b.kind === "polyline") {
    return { kind: "polyline", vertices: b.vertices.map(mv) };
  }
  const c = mv({ x: b.cx, y: b.cy });
  if (b.kind === "circle") {
    return { kind: "circle", cx: c.x, cy: c.y, r: b.r };
  }
  return { kind: "ellipse", cx: c.x, cy: c.y, rx: b.rx, ry: b.ry, rotation: b.rotation };
}

/** REGION: build a region entity from a closed boundary entity. */
export function regionFromGeom(g: Geom): RegionGeom {
  switch (g.type) {
    case "circle":
      return {
        type: "region",
        boundary: { kind: "circle", cx: g.cx, cy: g.cy, r: g.r },
        area: Math.PI * g.r * g.r,
        perimeter: TAU * g.r,
        centroid: { x: g.cx, y: g.cy },
      };
    case "ellipse":
      return {
        type: "region",
        boundary: { kind: "ellipse", cx: g.cx, cy: g.cy, rx: g.rx, ry: g.ry, rotation: g.rotation },
        area: Math.PI * g.rx * g.ry,
        perimeter: lengthOf(g),
        centroid: { x: g.cx, y: g.cy },
      };
    case "polyline": {
      if (!g.closed || g.vertices.length < 3) {
        throw new GeomOpError("region needs a closed polyline with 3+ vertices", "not_closed");
      }
      return {
        type: "region",
        boundary: { kind: "polyline", vertices: g.vertices },
        area: Math.abs(polygonArea(g.vertices)),
        perimeter: lengthOf(g),
        centroid: polygonCentroid(g.vertices),
      };
    }
    case "region":
      return g;
    default:
      throw new GeomOpError(`REGION needs a closed circle, ellipse or polyline (got ${g.type})`, "unsupported");
  }
}

/** Closest-point helper re-export for command previews. */
export { closestOn, pointAtParam, rayDir, add };
