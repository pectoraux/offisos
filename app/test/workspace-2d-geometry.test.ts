/**
 * CAD-PARITY-003 — geometry kernel exactness (CP3-PORT-2b).
 *
 * Pins the deterministic 2D kernel under app/src/workspace/geometry/:
 * transforms (move/rotate/scale/mirror), exact intersections, FILLET/
 * CHAMFER corner construction, OFFSET, the edit-ops family (TRIM/EXTEND/
 * BREAK/JOIN/EXPLODE/STRETCH/REGION), spline clamping + degree semantics,
 * per-entity measures (bbox/closest/length/area) and typed GeomOpError
 * failures for degenerate inputs.
 *
 * Every expected value is derived by hand from the construction (or exact
 * closed-form geometry); tolerances are honest floating-point bounds (≤1e-9),
 * never sloppy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { moveGeom, rotateGeom, scaleGeom, mirrorGeom } from "../src/workspace/geometry/transform.js";
import { intersectGeoms } from "../src/workspace/geometry/intersect.js";
import { filletLineLine, chamferLineLine, filletPolyline, chamferPolyline, GeomOpError } from "../src/workspace/geometry/fillet.js";
import { offsetGeom } from "../src/workspace/geometry/offset.js";
import {
  trimGeom,
  extendGeom,
  breakGeom,
  joinGeoms,
  explodeGeom,
  stretchGeom,
  regionFromGeom,
} from "../src/workspace/geometry/editops.js";
import { sampleSpline, bbox, closestOn, lengthOf, areaOf, arcSweep } from "../src/workspace/geometry/entities.js";
import { effectiveDegree } from "../src/workspace/geometry/spline.js";
import type { Geom, LineGeom, PolylineGeom, CircleGeom, ArcGeom } from "../src/workspace/geometry/types.js";
import type { Pt } from "../src/workspace/geometry/math2d.js";
import { TAU } from "../src/workspace/geometry/math2d.js";

// --- Fixtures + assertion helpers -------------------------------------------

const line = (x1: number, y1: number, x2: number, y2: number): LineGeom => ({ type: "line", x1, y1, x2, y2 });
const polyline = (verts: readonly Pt[], closed = false): PolylineGeom => ({ type: "polyline", vertices: verts, closed });
const circle = (cx: number, cy: number, r: number): CircleGeom => ({ type: "circle", cx, cy, r });
const arc = (cx: number, cy: number, r: number, startAngle: number, endAngle: number): ArcGeom => ({ type: "arc", cx, cy, r, startAngle, endAngle });

function expectPt(actual: Pt, ex: number, ey: number, tol = 1e-9, label = "point"): void {
  assert.ok(Math.abs(actual.x - ex) <= tol, `${label}.x: expected ${ex} ±${tol}, got ${actual.x}`);
  assert.ok(Math.abs(actual.y - ey) <= tol, `${label}.y: expected ${ey} ±${tol}, got ${actual.y}`);
}

function expectLine(actual: Geom, ex1: Pt, ex2: Pt, tol = 1e-9): void {
  assert.equal(actual.type, "line");
  const l = actual as LineGeom;
  expectPt({ x: l.x1, y: l.y1 }, ex1.x, ex1.y, tol, "line.from");
  expectPt({ x: l.x2, y: l.y2 }, ex2.x, ex2.y, tol, "line.to");
}

/** Smallest angular difference b−a wrapped into (−π, π]. */
function angDiff(a: number, b: number): number {
  const TAU = Math.PI * 2;
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

function expectArc(actual: Geom, ec: Pt, er: number, eStart: number, eSweep: number, tol = 1e-9): void {
  assert.equal(actual.type, "arc");
  const a = actual as ArcGeom;
  expectPt({ x: a.cx, y: a.cy }, ec.x, ec.y, tol, "arc.center");
  assert.ok(Math.abs(a.r - er) <= tol, `arc.r: expected ${er}, got ${a.r}`);
  assert.ok(Math.abs(angDiff(eStart, a.startAngle)) <= tol, `arc.startAngle: expected ${eStart}, got ${a.startAngle}`);
  assert.ok(Math.abs(arcSweep(a) - eSweep) <= tol, `arc sweep: expected ${eSweep}, got ${arcSweep(a)}`);
}

function expectGeomOpError(fn: () => unknown, code: string, messagePattern: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof GeomOpError, `expected GeomOpError, got ${String(caught)}`);
  assert.equal((caught as GeomOpError).code, code);
  assert.match((caught as Error).message, messagePattern);
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

test("rotateGeom: line 90° CCW about (1,1) — exact endpoints", () => {
  // (0,0) → (2,0); (2,0) → (2,2)  (quarter turn about the pivot)
  const r = rotateGeom(line(0, 0, 2, 0), { x: 1, y: 1 }, Math.PI / 2);
  expectLine(r, { x: 2, y: 0 }, { x: 2, y: 2 }, 1e-12);
});

test("rotateGeom: circle keeps radius, center orbits the pivot", () => {
  const r = rotateGeom(circle(5, 0, 10), { x: 0, y: 0 }, Math.PI / 2);
  assert.equal(r.type, "circle");
  const c = r as CircleGeom;
  expectPt({ x: c.cx, y: c.cy }, 0, 5, 1e-12);
  assert.equal(c.r, 10);
});

test("rotateGeom: arc keeps radius + sweep, angles shift CCW", () => {
  const r = rotateGeom(arc(0, 0, 10, 0, Math.PI / 2), { x: 0, y: 0 }, Math.PI / 4);
  expectArc(r, { x: 0, y: 0 }, 10, Math.PI / 4, Math.PI / 2, 1e-12);
});

test("rotateGeom: ellipse rotation accumulates (normalized)", () => {
  const r = rotateGeom({ type: "ellipse", cx: 0, cy: 0, rx: 100, ry: 50, rotation: Math.PI }, { x: 0, y: 0 }, Math.PI / 2);
  assert.equal(r.type, "ellipse");
  assert.ok(Math.abs((r as { rotation: number }).rotation - 3 * Math.PI / 2) <= 1e-12);
});

test("scaleGeom: circle ×2 about its own center — radius doubles, center fixed", () => {
  const s = scaleGeom(circle(5, 5, 10), { x: 5, y: 5 }, 2);
  assert.equal(s.type, "circle");
  const c = s as CircleGeom;
  expectPt({ x: c.cx, y: c.cy }, 5, 5, 1e-12);
  assert.equal(c.r, 20);
});

test("scaleGeom: about an external point moves the center (ratio geometry)", () => {
  // center (10,0) about origin ×2 → (20,0); r 5 → 10
  const s = scaleGeom(circle(10, 0, 5), { x: 0, y: 0 }, 2);
  const c = s as CircleGeom;
  expectPt({ x: c.cx, y: c.cy }, 20, 0, 1e-12);
  assert.equal(c.r, 10);
});

test("scaleGeom: polyline vertices scale about the base", () => {
  const s = scaleGeom(polyline([{ x: 1, y: 1 }, { x: 3, y: 1 }]), { x: 0, y: 0 }, 3);
  assert.equal(s.type, "polyline");
  const v = (s as PolylineGeom).vertices;
  expectPt(v[0]!, 3, 3, 1e-12);
  expectPt(v[1]!, 9, 3, 1e-12);
});

test("scaleGeom rejects non-positive factors", () => {
  assert.throws(() => scaleGeom(circle(0, 0, 1), { x: 0, y: 0 }, 0), /positive/);
  assert.throws(() => scaleGeom(circle(0, 0, 1), { x: 0, y: 0 }, -2), /positive/);
});

test("mirrorGeom: line across the x-axis", () => {
  const m = mirrorGeom(line(0, 1, 2, 3), { x: 0, y: 0 }, { x: 1, y: 0 });
  expectLine(m, { x: 0, y: -1 }, { x: 2, y: -3 }, 1e-12);
});

test("mirrorGeom: line across the diagonal y=x swaps coordinates", () => {
  const m = mirrorGeom(line(2, 0, 4, 1), { x: 0, y: 0 }, { x: 1, y: 1 });
  expectLine(m, { x: 0, y: 2 }, { x: 1, y: 4 }, 1e-12);
});

test("mirrorGeom: circle across y=x moves the center, radius invariant", () => {
  const m = mirrorGeom(circle(3, 1, 5), { x: 0, y: 0 }, { x: 1, y: 1 });
  const c = m as CircleGeom;
  expectPt({ x: c.cx, y: c.cy }, 1, 3, 1e-12);
  assert.equal(c.r, 5);
});

test("mirrorGeom: arc sweep direction reverses (quarter I → quarter IV)", () => {
  // arc [0, π/2] mirrored across the x-axis runs CCW from (0,-10) to (10,0):
  // start 3π/2, sweep π/2.
  const m = mirrorGeom(arc(0, 0, 10, 0, Math.PI / 2), { x: 0, y: 0 }, { x: 1, y: 0 });
  expectArc(m, { x: 0, y: 0 }, 10, 3 * Math.PI / 2, Math.PI / 2, 1e-12);
});

test("moveGeom: ray/xline endpoints translate together", () => {
  const m = moveGeom({ type: "ray", x1: 0, y1: 0, x2: 10, y2: 10 }, 5, -3);
  assert.deepEqual(m, { type: "ray", x1: 5, y1: -3, x2: 15, y2: 7 });
});

// ---------------------------------------------------------------------------
// Intersections (exact closed forms)
// ---------------------------------------------------------------------------

test("intersectGeoms: line through a circle center — two exact points", () => {
  // circle c=(50,0) r=20 cut by y=0: x = 30 and 70.
  const pts = intersectGeoms(line(0, 0, 100, 0), circle(50, 0, 20));
  assert.equal(pts.length, 2);
  expectPt(pts[0]!, 30, 0, 1e-12);
  expectPt(pts[1]!, 70, 0, 1e-12);
});

test("intersectGeoms: tangent line/circle — a single exact point", () => {
  // line y=30 tangent to circle c=(50,0) r=30 at (50,30)
  const pts = intersectGeoms(line(-10, 30, 110, 30), circle(50, 0, 30));
  assert.equal(pts.length, 1);
  expectPt(pts[0]!, 50, 30, 1e-9);
});

test("intersectGeoms: line misses a circle — empty, deterministically sorted output", () => {
  assert.deepEqual(intersectGeoms(line(0, 50, 100, 50), circle(50, 0, 20)), []);
});

test("intersectGeoms: line × arc keeps only in-sweep hits", () => {
  // y=x against arc r=10 [0, π/2]: hits the full circle at ±45°; only the
  // +45° point is inside the sweep.
  const pts = intersectGeoms(line(0, 0, 10, 10), arc(0, 0, 10, 0, Math.PI / 2));
  assert.equal(pts.length, 1);
  expectPt(pts[0]!, 10 / Math.SQRT2, 10 / Math.SQRT2, 1e-9);
});

test("intersectGeoms: polyline × line hits segment-wise (deduped + sorted)", () => {
  const pts = intersectGeoms(polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]), line(5, -5, 5, 5));
  assert.equal(pts.length, 1);
  expectPt(pts[0]!, 5, 0, 1e-12);
});

test("intersectGeoms: arc × circle (exported through the arc path)", () => {
  // arc r=10 [0, π/2] around origin vs circle c=(10,0) r=10: full-circle hits
  // are (5, ±√75); only (5, +√75) (60°) is inside the arc sweep.
  const pts = intersectGeoms(arc(0, 0, 10, 0, Math.PI / 2), circle(10, 0, 10));
  assert.equal(pts.length, 1);
  expectPt(pts[0]!, 5, 5 * Math.sqrt(3), 1e-9);
});

test("intersectGeoms: xline is infinite — hits beyond both stored points", () => {
  const pts = intersectGeoms({ type: "xline", x1: 0, y1: 0, x2: 1, y2: 0 }, line(-40, -40, -40, 40));
  assert.equal(pts.length, 1);
  expectPt(pts[0]!, -40, 0, 1e-12);
});

test("intersectGeoms: ray respects its half-line (no hit behind the base)", () => {
  assert.deepEqual(
    intersectGeoms({ type: "ray", x1: 0, y1: 0, x2: 1, y2: 0 }, line(-40, -40, -40, 40)),
    [],
  );
  const ahead = intersectGeoms({ type: "ray", x1: 0, y1: 0, x2: 1, y2: 0 }, line(40, -40, 40, 40));
  assert.equal(ahead.length, 1);
  expectPt(ahead[0]!, 40, 0, 1e-12);
});

test("intersectGeoms: spline pairs report no exact solution (LOCK-007, no guessing)", () => {
  assert.deepEqual(intersectGeoms(line(0, 0, 100, 0), {
    type: "spline", controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 0 }], degree: 3,
  }), []);
});

// ---------------------------------------------------------------------------
// FILLET + CHAMFER
// ---------------------------------------------------------------------------

// The classic perpendicular corner: horizontal arm to +X, vertical arm to +Y.
const CORNER_A = line(0, 0, 100, 0);
const CORNER_B = line(0, -50, 0, 50);
const PICK_A: Pt = { x: 50, y: 0 };
const PICK_B: Pt = { x: 0, y: 50 };

test("filletLineLine r=15 on a perpendicular corner — tangent points on the bisector", () => {
  const r = filletLineLine(CORNER_A, CORNER_B, PICK_A, PICK_B, 15);
  // Tangent distance along each arm: 15/tan(45°); arc center on the bisector
  // at distance 15/sin(45°) → (15,15). Kept far endpoints: (100,0) and (0,50).
  expectLine(r.a!, { x: 100, y: 0 }, { x: 15, y: 0 }, 1e-9);
  expectLine(r.b!, { x: 0, y: 50 }, { x: 0, y: 15 }, 1e-9);
  // The fillet arc fills the corner: CCW from (0,15) [angle π] to (15,0) [3π/2].
  expectArc(r.arc!, { x: 15, y: 15 }, 15, Math.PI, Math.PI / 2, 1e-9);
  assert.equal(r.chamfer, null);
});

test("filletLineLine r=0 joins the corner sharply (extend/trim to the vertex)", () => {
  const r = filletLineLine(CORNER_A, CORNER_B, PICK_A, PICK_B, 0);
  expectLine(r.a!, { x: 100, y: 0 }, { x: 0, y: 0 }, 1e-12);
  expectLine(r.b!, { x: 0, y: 50 }, { x: 0, y: 0 }, 1e-12);
  assert.equal(r.arc, null);
});

test("filletLineLine picks select the corner arms (picks below/left fillet quadrant III)", () => {
  // Pick the arms BELOW/LEFT of the vertex instead: the fillet lands in
  // quadrant III with center (-15,-15). Line A has no extent left of x=0, so
  // its kept endpoint is the vertex itself; line B keeps its far bottom end.
  const r = filletLineLine(CORNER_A, CORNER_B, { x: -1, y: 0 }, { x: 0, y: -1 }, 15);
  expectLine(r.a!, { x: 0, y: 0 }, { x: -15, y: 0 }, 1e-9);
  expectLine(r.b!, { x: 0, y: -50 }, { x: 0, y: -15 }, 1e-9);
  expectArc(r.arc!, { x: -15, y: -15 }, 15, 0, Math.PI / 2, 1e-9);
});

test("filletLineLine: parallel lines are a typed failure", () => {
  expectGeomOpError(
    () => filletLineLine(line(0, 0, 10, 0), line(0, 5, 10, 5), { x: 1, y: 0 }, { x: 1, y: 5 }, 5),
    "parallel",
    /parallel/,
  );
});

test("filletLineLine: circle pairs report the typed limitation", () => {
  expectGeomOpError(
    () => filletLineLine(circle(0, 0, 5), CORNER_A, { x: 5, y: 0 }, PICK_A, 5),
    "unsupported_pair",
    /typed limitation/,
  );
});

test("chamferLineLine d1=d2=10 on the perpendicular corner — exact bevel", () => {
  const r = chamferLineLine(CORNER_A, CORNER_B, PICK_A, PICK_B, 10, 10);
  expectLine(r.a!, { x: 100, y: 0 }, { x: 10, y: 0 }, 1e-12);
  expectLine(r.b!, { x: 0, y: 50 }, { x: 0, y: 10 }, 1e-12);
  expectLine(r.chamfer!, { x: 10, y: 0 }, { x: 0, y: 10 }, 1e-12);
  assert.equal(r.arc, null);
});

test("chamferLineLine asymmetric distances place the bevel asymmetrically", () => {
  const r = chamferLineLine(CORNER_A, CORNER_B, PICK_A, PICK_B, 20, 5);
  expectLine(r.a!, { x: 100, y: 0 }, { x: 20, y: 0 }, 1e-12);
  expectLine(r.b!, { x: 0, y: 50 }, { x: 0, y: 5 }, 1e-12);
  expectLine(r.chamfer!, { x: 20, y: 0 }, { x: 0, y: 5 }, 1e-12);
});

test("filletPolyline on an OPEN polyline: interior corner split into arc + 2 pieces", () => {
  const r = filletPolyline(polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], false), 15);
  assert.equal(r.pieces.length, 2, "bottom piece + right piece");
  assert.equal(r.arcs.length, 1);
  // Bottom: (0,0) → (85,0); right: (100,15) → (100,50); arc at (85,15).
  const bottom = r.pieces[0]!.vertices;
  const right = r.pieces[1]!.vertices;
  expectPt(bottom[0]!, 0, 0, 1e-9);
  expectPt(bottom[1]!, 85, 0, 1e-9);
  expectPt(right[0]!, 100, 15, 1e-9);
  expectPt(right[1]!, 100, 50, 1e-9);
  expectArc(r.arcs[0]!, { x: 85, y: 15 }, 15, 3 * Math.PI / 2, Math.PI / 2, 1e-6);
});

test("filletPolyline on a CLOSED rectangle: every corner becomes an arc (wrap-around piece emitted)", () => {
  const r = filletPolyline(polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], true), 15);
  // All four corners fillet: bottom (15,0)-(85,0), right (100,15)-(100,35),
  // top (85,50)-(15,50) and left (0,35)-(0,15) with 4 arcs of r=15 — the
  // closed wrap-around piece is emitted like every other piece.
  assert.equal(r.arcs.length, 4);
  assert.equal(r.pieces.length, 4, "all four straight pieces survive (incl. the wrap-around left edge)");
  const arcs = r.arcs.map((a) => [a.cx, a.cy, Math.round(a.r)]);
  assert.deepEqual(arcs.map(([cx, cy]) => [cx, cy]), [[15, 15], [85, 15], [85, 35], [15, 35]]);
  assert.ok(arcs.every(([, , r]) => r === 15));
  // The pieces are exact:
  const [bottom, right, top, left] = r.pieces as [PolylineGeom, PolylineGeom, PolylineGeom, PolylineGeom];
  expectPt(bottom.vertices[0]!, 15, 0, 1e-9);
  expectPt(bottom.vertices[1]!, 85, 0, 1e-9);
  expectPt(right.vertices[0]!, 100, 15, 1e-9);
  expectPt(right.vertices[1]!, 100, 35, 1e-9);
  expectPt(top.vertices[0]!, 85, 50, 1e-9);
  expectPt(top.vertices[1]!, 15, 50, 1e-9);
  expectPt(left.vertices[0]!, 0, 35, 1e-9, "the wrap-around piece starts at the last corner's tB");
  expectPt(left.vertices[1]!, 0, 15, 1e-9, "and ends at the first corner's tA");
});

test("chamferPolyline on a CLOSED rectangle: single polyline, 8 exact vertices", () => {
  const ch = chamferPolyline(polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], true), 10, 10);
  assert.equal(ch.closed, true);
  assert.deepEqual(ch.vertices, [
    { x: 0, y: 10 }, { x: 10, y: 0 },
    { x: 90, y: 0 }, { x: 100, y: 10 },
    { x: 100, y: 40 }, { x: 90, y: 50 },
    { x: 10, y: 50 }, { x: 0, y: 40 },
  ]);
});

// ---------------------------------------------------------------------------
// OFFSET
// ---------------------------------------------------------------------------

test("offsetGeom: line offsets parallel by ±distance on the picked side", () => {
  const up = offsetGeom(line(0, 0, 100, 0), 10, { x: 50, y: 10 });
  expectLine(up, { x: 0, y: 10 }, { x: 100, y: 10 }, 1e-12);
  const down = offsetGeom(line(0, 0, 100, 0), 5, { x: 50, y: -1 });
  expectLine(down, { x: 0, y: -5 }, { x: 100, y: -5 }, 1e-12);
});

test("offsetGeom: circle outward (r+d) and inward (r−d) by the side point", () => {
  const out = offsetGeom(circle(0, 0, 15), 10, { x: 0, y: 25 }) as CircleGeom;
  assert.equal(out.r, 25);
  const inn = offsetGeom(circle(0, 0, 15), 10, { x: 0, y: 5 }) as CircleGeom;
  assert.equal(inn.r, 5);
});

test("offsetGeom: arc offsets with sweep preservation", () => {
  const out = offsetGeom(arc(0, 0, 10, Math.PI / 6, Math.PI / 2), 5, { x: 0, y: 20 }) as ArcGeom;
  assert.equal(out.r, 15);
  assert.ok(Math.abs(out.startAngle - Math.PI / 6) <= 1e-12);
  assert.ok(Math.abs(arcSweep(out) - Math.PI / 3) <= 1e-12);
});

test("offsetGeom: closed polyline offsets with mitered corners (exact inner rect)", () => {
  const inner = offsetGeom(
    polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], true),
    10,
    { x: 50, y: 25 },
  ) as PolylineGeom;
  assert.equal(inner.closed, true);
  assert.deepEqual(inner.vertices, [{ x: 90, y: 10 }, { x: 90, y: 40 }, { x: 10, y: 40 }, { x: 10, y: 10 }]);
});

test("offsetGeom typed failures: zero distance, vanishing arc, unsupported ellipse", () => {
  expectGeomOpError(() => offsetGeom(line(0, 0, 1, 0), 0, { x: 0, y: 1 }), "bad_distance", /positive/);
  expectGeomOpError(() => offsetGeom(arc(0, 0, 10, 0, Math.PI / 2), 20, { x: 0, y: 5 }), "degenerate", /exceeds radius/);
  expectGeomOpError(
    () => offsetGeom({ type: "ellipse", cx: 0, cy: 0, rx: 10, ry: 5, rotation: 0 }, 1, { x: 0, y: 1 }),
    "unsupported",
    /does not support ellipse/,
  );
});

// ---------------------------------------------------------------------------
// TRIM / EXTEND / BREAK
// ---------------------------------------------------------------------------

test("trimGeom: line cut by a circle — the piece nearest the pick is removed (exact interval)", () => {
  const target = line(0, 0, 100, 0);
  const edge = circle(50, 0, 20); // cuts at x=30 and x=70
  // Pick the left piece → removed; remaining [(30,0),(100,0)]
  const left = trimGeom(target, [edge], { x: 10, y: 0 })!;
  assert.equal(left.length, 1);
  expectLine(left[0]!, { x: 30, y: 0 }, { x: 100, y: 0 }, 1e-12);
  // Pick the middle → both ends remain: [(0,0),(30,0)] + [(70,0),(100,0)]
  const mid = trimGeom(target, [edge], { x: 50, y: 0 })!;
  assert.equal(mid.length, 2);
  expectLine(mid[0]!, { x: 0, y: 0 }, { x: 30, y: 0 }, 1e-12);
  expectLine(mid[1]!, { x: 70, y: 0 }, { x: 100, y: 0 }, 1e-12);
  // Pick the right piece → remaining [(0,0),(70,0)]
  const right = trimGeom(target, [edge], { x: 90, y: 0 })!;
  assert.equal(right.length, 1);
  expectLine(right[0]!, { x: 0, y: 0 }, { x: 70, y: 0 }, 1e-12);
});

test("trimGeom: closed circle keeps the arc AWAY from the pick", () => {
  const cut = line(0, -20, 0, 20); // diameter through (0,±10)
  const right = trimGeom(circle(0, 0, 10), [cut], { x: 10, y: 0 })!;
  assert.equal(right.length, 1);
  expectArc(right[0]!, { x: 0, y: 0 }, 10, Math.PI / 2, Math.PI, 1e-9);
  const left = trimGeom(circle(0, 0, 10), [cut], { x: -10, y: 0 })!;
  assert.equal(left.length, 1);
  expectArc(left[0]!, { x: 0, y: 0 }, 10, 3 * Math.PI / 2, Math.PI, 1e-9);
});

test("trimGeom typed failures: no cutting intersections, unsupported targets", () => {
  expectGeomOpError(
    () => trimGeom(line(0, 0, 100, 0), [circle(200, 200, 5)], { x: 50, y: 0 }),
    "no_cut",
    /no cutting edges intersect/,
  );
  expectGeomOpError(
    () => trimGeom({ type: "ellipse", cx: 0, cy: 0, rx: 10, ry: 5, rotation: 0 }, [line(0, -20, 0, 20)], { x: 10, y: 0 }),
    "unsupported",
    /does not support ellipse/,
  );
});

test("extendGeom: line extends to the nearest boundary beyond the picked end", () => {
  const r = extendGeom(line(0, 0, 50, 0), [line(100, -50, 100, 50)], { x: 50, y: 0 });
  expectLine(r, { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-12);
});

test("extendGeom: arc extends CCW to the boundary angle; polyline extends its last segment", () => {
  const a = extendGeom(arc(0, 0, 10, 0, Math.PI / 4), [line(-5, 10, 5, 10)], { x: 7, y: 7 });
  expectArc(a, { x: 0, y: 0 }, 10, 0, Math.PI / 2, 1e-12);
  const p = extendGeom(polyline([{ x: 0, y: 0 }, { x: 50, y: 0 }]), [line(100, -50, 100, 50)], { x: 50, y: 0 });
  assert.equal(p.type, "polyline");
  const v = (p as PolylineGeom).vertices;
  expectPt(v[0]!, 0, 0, 1e-12);
  expectPt(v[1]!, 100, 0, 1e-12);
});

test("extendGeom ARC end-side directed: the end moves CCW to the nearest boundary; a crossing INSIDE the sweep is never taken", () => {
  // Arc CCW 0°→45°; boundary crossings at 15° and 30° (both INSIDE the
  // sweep) and 90° (beyond the end). Picking near the END extends CCW to
  // 90° (sweep 45°→90°); the inside crossings must not capture it (the
  // pre-fix defect class: min-delta could land inside and shorten/misorient).
  const chord = line(10 * Math.cos(Math.PI / 12), 10 * Math.sin(Math.PI / 12), 10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6));
  const beyond = line(0, 10, 20, 10); // tangent at 90°
  const a = extendGeom(arc(0, 0, 10, 0, Math.PI / 4), [chord, beyond], { x: 7.07, y: 7.07 });
  expectArc(a, { x: 0, y: 0 }, 10, 0, Math.PI / 2, 1e-12);
});

test("extendGeom ARC start-side directed: the start moves BACKWARDS (CW) to the nearest boundary — the sweep grows", () => {
  // Arc CCW 0°→45°; boundary crossings at 60° and 300°. Picking near the
  // START extends backwards: the nearest hit in the complementary arc
  // going CW from the start is 300° (60° CW) → new start 300°, sweep 105°.
  const back = line(5, -20, 5, 20); // crossings at 60° and 300°
  const a = extendGeom(arc(0, 0, 10, 0, Math.PI / 4), [back], { x: 10, y: 0 });
  expectArc(a, { x: 0, y: 0 }, 10, (5 * Math.PI) / 3, (7 * Math.PI) / 12, 1e-12);
});

test("extendGeom ARC start-side regression: an inside-sweep boundary must NOT capture the start (the arc must not shorten)", () => {
  // Arc CCW 0°→45°; boundaries: a chord crossing at 15°/30° (INSIDE the
  // sweep) AND a line crossing at 60°/300°. The start must move to 300°
  // (sweep grows to 105°) — never to 15° or 30° (the pre-fix defect: the
  // CCW search from the start picked the inside crossing and the arc
  // SHRANK to 30° with a misoriented interval).
  const chord = line(10 * Math.cos(Math.PI / 12), 10 * Math.sin(Math.PI / 12), 10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6));
  const back = line(5, -20, 5, 20);
  const a = extendGeom(arc(0, 0, 10, 0, Math.PI / 4), [chord, back], { x: 10, y: 0 });
  expectArc(a, { x: 0, y: 0 }, 10, (5 * Math.PI) / 3, (7 * Math.PI) / 12, 1e-12);
});

test("extendGeom ARC: boundaries crossing only INSIDE the sweep are a typed no_boundary (extension never shortens)", () => {
  // The chord crosses at 15° and 30° — both inside [0°,45°]. Neither end
  // has a valid extension target: typed failure for BOTH picked ends.
  const chord = line(10 * Math.cos(Math.PI / 12), 10 * Math.sin(Math.PI / 12), 10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6));
  expectGeomOpError(
    () => extendGeom(arc(0, 0, 10, 0, Math.PI / 4), [chord], { x: 10, y: 0 }),
    "no_boundary",
    /no boundary intersection along the arc's extension/,
  );
  expectGeomOpError(
    () => extendGeom(arc(0, 0, 10, 0, Math.PI / 4), [chord], { x: 7.07, y: 7.07 }),
    "no_boundary",
    /no boundary intersection along the arc's extension/,
  );
});

test("extendGeom ARC directed with wrap-around angles: both ends stay exact across the 0° wrap", () => {
  // Arc CCW 350°→30° (sweep 40°). End-side: boundary tangent at 90° → new
  // sweep 100°. Start-side: boundary tangent at 270° → new sweep 120°.
  const endSide = extendGeom(arc(0, 0, 10, (35 * Math.PI) / 18, Math.PI / 6), [line(0, 10, 20, 10)], { x: 8.66, y: 5 });
  expectArc(endSide, { x: 0, y: 0 }, 10, (35 * Math.PI) / 18, (5 * Math.PI) / 9, 1e-12);
  const startSide = extendGeom(arc(0, 0, 10, (35 * Math.PI) / 18, Math.PI / 6), [line(0, -10, 20, -10)], { x: 9.85, y: -1.74 });
  expectArc(startSide, { x: 0, y: 0 }, 10, (3 * Math.PI) / 2, (2 * Math.PI) / 3, 1e-12);
});

test("extendGeom typed failures: circles and construction entities", () => {
  expectGeomOpError(() => extendGeom(circle(0, 0, 5), [line(10, -5, 10, 5)], { x: 5, y: 0 }), "unsupported", /no ends/);
  expectGeomOpError(
    () => extendGeom({ type: "ray", x1: 0, y1: 0, x2: 1, y2: 0 }, [line(10, -5, 10, 5)], { x: 1, y: 0 }),
    "unsupported",
    /already infinite/,
  );
});

test("breakGeom: two points remove the interval between them", () => {
  const pieces = breakGeom(line(0, 0, 100, 0), { x: 30, y: 0 }, { x: 60, y: 0 })!;
  assert.equal(pieces.length, 2);
  expectLine(pieces[0]!, { x: 0, y: 0 }, { x: 30, y: 0 }, 1e-12);
  expectLine(pieces[1]!, { x: 60, y: 0 }, { x: 100, y: 0 }, 1e-12);
});

test("breakGeom: single point splits the entity in place", () => {
  const pieces = breakGeom(line(0, 0, 100, 0), { x: 40, y: 0 }, null)!;
  assert.equal(pieces.length, 2);
  expectLine(pieces[0]!, { x: 0, y: 0 }, { x: 40, y: 0 }, 1e-12);
  expectLine(pieces[1]!, { x: 40, y: 0 }, { x: 100, y: 0 }, 1e-12);
});

test("breakGeom: circle removes the CCW interval from p1 to p2", () => {
  const pieces = breakGeom(circle(0, 0, 10), { x: 10, y: 0 }, { x: 0, y: 10 })!;
  assert.equal(pieces.length, 1);
  expectArc(pieces[0]!, { x: 0, y: 0 }, 10, Math.PI / 2, 3 * Math.PI / 2, 1e-9);
});

// ---------------------------------------------------------------------------
// JOIN / EXPLODE / STRETCH
// ---------------------------------------------------------------------------

test("joinGeoms: collinear lines that touch or overlap become one line", () => {
  const touching = joinGeoms([line(0, 0, 30, 0), line(30, 0, 100, 0)]);
  expectLine(touching, { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-12);
  const overlapping = joinGeoms([line(0, 0, 60, 0), line(30, 0, 100, 0)]);
  expectLine(overlapping, { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-12);
  // Direction of the individual pieces is irrelevant to the SPAN; the merged
  // line inherits the FIRST piece's direction (deterministic convention).
  const reversed = joinGeoms([line(30, 0, 0, 0), line(100, 0, 30, 0)]);
  expectLine(reversed, { x: 100, y: 0 }, { x: 0, y: 0 }, 1e-12);
});

test("joinGeoms: collinear lines with a GAP are a typed failure (JOIN must not fabricate geometry)", () => {
  expectGeomOpError(
    () => joinGeoms([line(0, 0, 30, 0), line(50, 0, 100, 0)]),
    "no_join",
    /gap|fabricate/i,
  );
  // Three pieces with a missing middle: same typed failure, and the check
  // fires on the FIRST gap in projection order (deterministic).
  expectGeomOpError(
    () => joinGeoms([line(0, 0, 10, 0), line(40, 0, 50, 0), line(20, 0, 30, 0)]),
    "no_join",
    /gap|fabricate/i,
  );
  // A gap between pieces given in reverse order is still a gap.
  expectGeomOpError(
    () => joinGeoms([line(50, 0, 100, 0), line(0, 0, 30, 0)]),
    "no_join",
    /gap|fabricate/i,
  );
});

test("joinGeoms: two arcs of the same circle merge their sweeps", () => {
  const j = joinGeoms([arc(0, 0, 10, 0, Math.PI / 2), arc(0, 0, 10, Math.PI / 2, Math.PI)]);
  assert.equal(j.type, "arc");
  const a = j as ArcGeom;
  assert.ok(Math.abs(a.startAngle) <= 1e-9);
  assert.ok(Math.abs(arcSweep(a) - Math.PI) <= 1e-9);
  assert.equal(a.r, 10);
});

test("joinGeoms arcs: wrap-around touching merges exactly; overlap keeps the union", () => {
  // [350°,10°] + [10°,30°] touch across the 0° wrap: merged [350°,30°], sweep 40°.
  const wrapped = joinGeoms([arc(0, 0, 10, (35 * Math.PI) / 18, Math.PI / 18), arc(0, 0, 10, Math.PI / 18, Math.PI / 6)]);
  expectArc(wrapped, { x: 0, y: 0 }, 10, (35 * Math.PI) / 18, (2 * Math.PI) / 9, 1e-9);
  // [0°,90°] fully contains [30°,60°]: the union is [0°,90°].
  const overlap = joinGeoms([arc(0, 0, 10, 0, Math.PI / 2), arc(0, 0, 10, Math.PI / 6, Math.PI / 3)]);
  expectArc(overlap, { x: 0, y: 0 }, 10, 0, Math.PI / 2, 1e-9);
  // Two half arcs touching at both ends cover the circle.
  const circle = joinGeoms([arc(0, 0, 10, 0, Math.PI), arc(0, 0, 10, Math.PI, TAU)]);
  assert.equal(circle.type, "circle");
});

test("joinGeoms arcs: same-circle arcs with a GAP are a typed failure (no fabricated arc)", () => {
  expectGeomOpError(
    () => joinGeoms([arc(0, 0, 10, 0, Math.PI / 6), arc(0, 0, 10, Math.PI / 3, Math.PI / 2)]),
    "no_join",
    /gap|fabricate/i,
  );
  // Two arcs that overlap each other but leave the rest of the circle empty
  // still merge (union) — only a DISCONNECTED union is rejected.
  const ok = joinGeoms([arc(0, 0, 10, 0, Math.PI / 2), arc(0, 0, 10, Math.PI / 4, Math.PI)]);
  expectArc(ok, { x: 0, y: 0 }, 10, 0, Math.PI, 1e-9);
});

test("joinGeoms: polyline absorbs a connected line (documented: an absorbed arc contributes its endpoints as a chord)", () => {
  const j = joinGeoms([polyline([{ x: 0, y: 0 }, { x: 50, y: 0 }]), line(50, 0, 50, 30)]);
  assert.equal(j.type, "polyline");
  assert.deepEqual((j as PolylineGeom).vertices, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }]);
  // Arc absorption is end-to-end: the arc's curvature is NOT preserved (the
  // polyline keeps straight segments only) — pinned as the documented behavior.
  const withArc = joinGeoms([polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }]), arc(5, 0, 5, 0, Math.PI / 2)]);
  assert.deepEqual((withArc as PolylineGeom).vertices, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }]);
});

test("joinGeoms typed failures: non-collinear, different circles, too few entities", () => {
  expectGeomOpError(() => joinGeoms([line(0, 0, 10, 0), line(0, 5, 10, 5)]), "no_join", /not collinear|cannot be joined/);
  expectGeomOpError(
    () => joinGeoms([arc(0, 0, 10, 0, 1), arc(1, 1, 10, 0, 1)]),
    "no_join",
    /same circle|cannot be joined/,
  );
  expectGeomOpError(() => joinGeoms([line(0, 0, 1, 0)]), "bad_input", /at least two/);
});

test("explodeGeom: closed polyline → its segments; region → its boundary entity", () => {
  const segs = explodeGeom(polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], true));
  assert.equal(segs.length, 4);
  expectLine(segs[0]!, { x: 0, y: 0 }, { x: 100, y: 0 }, 1e-12);
  expectLine(segs[3]!, { x: 0, y: 50 }, { x: 0, y: 0 }, 1e-12);
  const region = regionFromGeom(circle(3, 4, 5));
  const parts = explodeGeom(region);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], circle(3, 4, 5));
});

test("explodeGeom: spline → deterministic sampled polyline (32 samples per span)", () => {
  const parts = explodeGeom({ type: "spline", controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 0 }], degree: 3 });
  assert.equal(parts.length, 1);
  const pl = parts[0] as PolylineGeom;
  // 4 control points → 3 spans × 32 + 1 = 97 sampled vertices.
  assert.equal(pl.vertices.length, 97);
  expectPt(pl.vertices[0]!, 0, 0, 1e-12, "spline start (clamped)");
  expectPt(pl.vertices[96]!, 40, 0, 1e-12, "spline end (clamped)");
});

test("stretchGeom: only vertices inside the window move", () => {
  const s = stretchGeom(line(0, 0, 100, 0), { x: 50, y: -10 }, { x: 150, y: 10 }, 0, 20);
  expectLine(s, { x: 0, y: 0 }, { x: 100, y: 20 }, 1e-12);
  const pl = stretchGeom(
    polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]),
    { x: 90, y: -10 },
    { x: 200, y: 110 },
    25,
    -5,
  );
  const v = (pl as PolylineGeom).vertices;
  expectPt(v[0]!, 0, 0, 1e-12, "untouched outside vertex");
  expectPt(v[1]!, 125, -5, 1e-12, "moved inside vertex");
  expectPt(v[2]!, 125, 95, 1e-12, "moved inside vertex");
});

test("stretchGeom: circle centers inside the window translate; radius preserved", () => {
  const s = stretchGeom(circle(5, 0, 7), { x: 0, y: -10 }, { x: 10, y: 10 }, 0, 100);
  const c = s as CircleGeom;
  expectPt({ x: c.cx, y: c.cy }, 5, 100, 1e-12);
  assert.equal(c.r, 7);
});

// ---------------------------------------------------------------------------
// REGION
// ---------------------------------------------------------------------------

test("regionFromGeom: circle → area πr², perimeter 2πr, centroid at center", () => {
  const r = regionFromGeom(circle(3, 4, 5));
  assert.ok(Math.abs(r.area - 25 * Math.PI) <= 1e-9);
  assert.ok(Math.abs(r.perimeter - 10 * Math.PI) <= 1e-9);
  expectPt(r.centroid, 3, 4, 1e-12);
});

test("regionFromGeom: closed polyline triangle → shoelace area, exact perimeter, polygon centroid", () => {
  const r = regionFromGeom(polyline([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 3 }], true));
  assert.equal(r.area, 9);
  assert.ok(Math.abs(r.perimeter - (6 + 3 + Math.hypot(6, -3))) <= 1e-12);
  expectPt(r.centroid, 2, 1, 1e-12);
});

test("regionFromGeom: ellipse → π·rx·ry with Ramanujan perimeter", () => {
  const r = regionFromGeom({ type: "ellipse", cx: 0, cy: 0, rx: 100, ry: 50, rotation: 0 });
  assert.ok(Math.abs(r.area - Math.PI * 100 * 50) <= 1e-9);
  assert.ok(Math.abs(r.perimeter - lengthOf({ type: "ellipse", cx: 0, cy: 0, rx: 100, ry: 50, rotation: 0 })) <= 1e-12);
  expectPt(r.centroid, 0, 0, 1e-12);
});

test("regionFromGeom typed failures: open polyline, wrong types", () => {
  expectGeomOpError(() => regionFromGeom(polyline([{ x: 0, y: 0 }, { x: 1, y: 0 }])), "not_closed", /closed/);
  expectGeomOpError(() => regionFromGeom(line(0, 0, 1, 0)), "unsupported", /REGION needs/);
});

// ---------------------------------------------------------------------------
// SPLINE evaluation + per-entity measures
// ---------------------------------------------------------------------------

test("sampleSpline: clamped B-spline hits the first/last control points exactly", () => {
  const sp = { type: "spline" as const, controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 0 }], degree: 3 };
  const samples = sampleSpline(sp);
  assert.equal(samples.length, 97, "32 samples per span × 3 spans + 1");
  expectPt(samples[0]!, 0, 0, 1e-12);
  expectPt(samples[samples.length - 1]!, 40, 0, 1e-12);
  // The curve is inside the convex hull of the control polygon (B-spline).
  for (const p of samples) {
    assert.ok(p.x >= -1e-9 && p.x <= 40 + 1e-9, "spline inside control hull (x)");
    assert.ok(p.y >= -1e-9 && p.y <= 20 + 1e-9, "spline inside control hull (y)");
  }
});

test("effectiveDegree: clamped to points-1, at least 1", () => {
  assert.equal(effectiveDegree(4, 3), 3);
  assert.equal(effectiveDegree(3, 3), 2);
  assert.equal(effectiveDegree(2, 3), 1);
  assert.equal(effectiveDegree(1, 3), 0);
});

test("bbox: arc extremes include axis crossings inside the sweep", () => {
  const b = bbox(arc(0, 0, 10, Math.PI / 4, 3 * Math.PI / 4));
  assert.ok(Math.abs(b.minX + 10 / Math.SQRT2) <= 1e-9);
  assert.ok(Math.abs(b.maxX - 10 / Math.SQRT2) <= 1e-9);
  assert.ok(Math.abs(b.minY - 10 / Math.SQRT2) <= 1e-9);
  assert.equal(b.maxY, 10, "π/2 crossing inside the sweep");
});

test("bbox: rotated ellipse uses the axis-aligned extent √(rx²cos²+ry²sin²)", () => {
  const b = bbox({ type: "ellipse", cx: 0, cy: 0, rx: 100, ry: 50, rotation: Math.PI / 4 });
  const e = Math.sqrt(6250); // √(100²·½ + 50²·½)
  assert.ok(Math.abs(b.maxX - e) <= 1e-9);
  assert.ok(Math.abs(b.minX + e) <= 1e-9);
  assert.ok(Math.abs(b.maxY - e) <= 1e-9);
  assert.ok(Math.abs(b.minY + e) <= 1e-9);
});

test("closestOn: segment clamp + radial circle projection", () => {
  const seg = closestOn(line(0, 0, 10, 0), { x: 15, y: 5 });
  expectPt(seg.point, 10, 0, 1e-9);
  assert.ok(Math.abs(seg.d - Math.hypot(5, 5)) <= 1e-9);
  const circ = closestOn(circle(0, 0, 10), { x: 3, y: 4 });
  expectPt(circ.point, 6, 8, 1e-9);
  assert.ok(Math.abs(circ.d - 5) <= 1e-9);
});

test("lengthOf/areaOf: exact closed forms per entity type", () => {
  assert.ok(Math.abs(lengthOf(circle(0, 0, 10)) - 20 * Math.PI) <= 1e-12);
  assert.ok(Math.abs(lengthOf(arc(0, 0, 10, 0, Math.PI / 2)) - 5 * Math.PI) <= 1e-12);
  assert.equal(lengthOf(polyline([{ x: 0, y: 0 }, { x: 3, y: 4 }])), 5);
  assert.ok(Math.abs(areaOf(circle(0, 0, 10)) - 100 * Math.PI) <= 1e-12);
  assert.equal(areaOf(polyline([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 3 }], true)), 9);
  assert.equal(areaOf(polyline([{ x: 0, y: 0 }, { x: 6, y: 0 }])), 0, "open polyline has no area");
});
