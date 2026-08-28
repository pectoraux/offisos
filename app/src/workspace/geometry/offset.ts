/**
 * OFFSET (CAD-PARITY-003). Lines/rays/xlines offset parallel towards the
 * side point; circles/arcs grow or shrink depending on which side of the rim
 * the side point lies; polylines offset per-segment with mitered corners
 * (AutoCAD's polyline offset join behavior). Ellipses/splines/regions
 * report a typed limitation (no exact offset exists in this build).
 */

import { cross, dist, EPS, lineLine, mul, norm, Pt, sub } from "./math2d.js";
import { polylineSegments } from "./entities.js";
import type { Geom, PolylineGeom } from "./types.js";
import { GeomOpError } from "./fillet.js";

export function offsetGeom(g: Geom, distance: number, side: Pt): Geom {
  if (distance <= EPS) throw new GeomOpError("offset distance must be positive", "bad_distance");
  switch (g.type) {
    case "line":
    case "ray":
    case "xline": {
      const a = { x: g.x1, y: g.y1 };
      const b = { x: g.x2, y: g.y2 };
      const dir = norm(sub(b, a));
      const n = { x: -dir.y, y: dir.x };
      const s = Math.sign(cross(dir, sub(side, a))) || 1;
      const off = mul(n, s * distance);
      return {
        ...g,
        x1: a.x + off.x,
        y1: a.y + off.y,
        x2: b.x + off.x,
        y2: b.y + off.y,
      };
    }
    case "circle":
    case "arc": {
      const outward = dist(side, { x: g.cx, y: g.cy }) > g.r;
      const r = outward ? g.r + distance : g.r - distance;
      if (r <= EPS) {
        throw new GeomOpError("offset exceeds radius — the arc would vanish", "degenerate");
      }
      return { ...g, r };
    }
    case "polyline":
      return offsetPolyline(g, distance, side);
    default:
      throw new GeomOpError(
        `OFFSET does not support ${g.type} exactly in this build (no approximate offsets)`,
        "unsupported",
      );
  }
}

function offsetPolyline(pl: PolylineGeom, distance: number, side: Pt): PolylineGeom {
  const segs = [...polylineSegments(pl.vertices, pl.closed)];
  if (segs.length === 0) throw new GeomOpError("empty polyline", "bad_entity");
  if (segs.length === 1) {
    const seg = segs[0]!;
    const a = seg[0]!;
    const b = seg[1]!;
    const dir = norm(sub(b, a));
    const n = { x: -dir.y, y: dir.x };
    const s = Math.sign(cross(dir, sub(side, a!))) || 1;
    const off = mul(n, s * distance);
    return {
      type: "polyline",
      vertices: [
        { x: a!.x + off.x, y: a!.y + off.y },
        { x: b!.x + off.x, y: b!.y + off.y },
      ],
      closed: false,
    };
  }

  // Per-segment offset lines (infinite, through offset endpoints).
  interface OffSeg {
    readonly p: Pt;
    readonly d: Pt;
    readonly a: Pt;
    readonly b: Pt;
  }
  const offs: OffSeg[] = segs.map(([a, b]) => {
    const dir = sub(b!, a!);
    const nd = norm(dir);
    const n = { x: -nd.y, y: nd.x };
    const s = Math.sign(cross(nd, sub(side, a!))) || 1;
    const off = mul(n, s * distance);
    return {
      p: { x: a!.x + off.x, y: a!.y + off.y },
      d: dir,
      a: { x: a!.x + off.x, y: a!.y + off.y },
      b: { x: b!.x + off.x, y: b!.y + off.y },
    };
  });

  // Miter joints between consecutive offset segments.
  const m = offs.length;
  const jointAt = (i: number): Pt => {
    const cur = offs[i]!;
    const nxt = offs[(i + 1) % m]!;
    const P = lineLine(cur.p, cur.d, nxt.p, nxt.d);
    if (P !== null) return P;
    // Parallel consecutive segments (collinear path): joint = shared offset
    // endpoint.
    return cur.b;
  };

  const vertices: Pt[] = [];
  if (!pl.closed) {
    vertices.push(offs[0]!.a);
    for (let i = 0; i < m - 1; i++) {
      vertices.push(jointAt(i));
    }
    vertices.push(offs[m - 1]!.b);
  } else {
    for (let i = 0; i < m; i++) {
      vertices.push(jointAt(i));
    }
  }
  // Dedupe near-identical consecutive vertices.
  const unique: Pt[] = [];
  for (const v of vertices) {
    if (unique.length === 0 || dist(unique[unique.length - 1]!, v) > 1e-7) unique.push(v);
  }
  if (pl.closed && unique.length > 1 && dist(unique[0]!, unique[unique.length - 1]!) <= 1e-7) {
    unique.pop();
  }
  if (unique.length < 2) throw new GeomOpError("offset degenerated", "degenerate");
  return { type: "polyline", vertices: unique, closed: pl.closed };
}
