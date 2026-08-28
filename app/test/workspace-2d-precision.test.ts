/**
 * CAD-PARITY-003 — the precision engine (CP3-PORT-2b).
 *
 * Pins the deterministic snap/pick/window semantics of
 * app/src/workspace/precision-2d.ts: the nine osnap modes with the fixed
 * priority order (intersection > endpoint > node > center > quadrant >
 * midpoint > perpendicular > tangent > nearest), aperture behavior, the
 * nearest fallback, deterministic picking, window vs crossing selection
 * (spline crossing via the 32-sample polyline), ortho/polar/grid/tracking
 * constraints — and double-run determinism for every query kind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRECISION,
  OSNAP_LABELS,
  constrainPoint,
  gripsOf,
  pickAt,
  resolveSnap,
  selectWindow,
  toEntities,
  type Entity,
  type OsnapMode,
  type PrecisionSettings,
} from "../src/workspace/precision-2d.js";
import type { Element } from "../src/contracts/caddocument.js";
import type { Pt } from "../src/workspace/geometry/math2d.js";

// --- Scene builders -----------------------------------------------------------

function flatEntity(id: string, props: Record<string, unknown>): Element {
  return { id, kind: "geometry", engineId: null, props: { drafting: true, layer: "0", ...props } };
}

/** The reference scene: a line, a circle, an arc and a point node. */
function sceneElements(): readonly Element[] {
  return [
    flatEntity("s-line", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }),
    flatEntity("s-circle", { type: "circle", cx: 30, cy: 0, r: 10 }),
    flatEntity("s-arc", { type: "arc", cx: 0, cy: 0, r: 20, startAngle: 0, endAngle: Math.PI / 2 }),
    flatEntity("s-point", { type: "point", x: 5, y: 5 }),
  ];
}

function settings(modes: readonly OsnapMode[], overrides: Partial<PrecisionSettings> = {}): PrecisionSettings {
  return {
    ...DEFAULT_PRECISION,
    osnapModes: modes,
    ortho: false,
    polar: false,
    gridSnap: false,
    tracking: false,
    ...overrides,
  };
}

function expectPt(actual: Pt, ex: number, ey: number, tol = 1e-9, label = "point"): void {
  assert.ok(Math.abs(actual.x - ex) <= tol, `${label}.x: expected ${ex} ±${tol}, got ${actual.x}`);
  assert.ok(Math.abs(actual.y - ey) <= tol, `${label}.y: expected ${ey} ±${tol}, got ${actual.y}`);
}

// --- The nine osnap modes -----------------------------------------------------

test("osnap endpoint: line endpoints snap from within the aperture", () => {
  const r = resolveSnap(toEntities(sceneElements()), { x: 0.4, y: -0.3 }, settings(["endpoint"]), null);
  assert.equal(r.mode, "endpoint");
  expectPt(r.point, 0, 0);
  assert.equal(r.entityId, "s-line");
});

test("osnap midpoint: the arc midpoint sits at sweep/2", () => {
  const r = resolveSnap(toEntities(sceneElements()), { x: 14.4, y: 14.0 }, settings(["midpoint"]), null);
  assert.equal(r.mode, "midpoint");
  expectPt(r.point, 20 * Math.SQRT2 / 2, 20 * Math.SQRT2 / 2, 1e-9);
  assert.equal(r.entityId, "s-arc");
});

test("osnap center: circle/arc/ellipse centers snap", () => {
  const r = resolveSnap(toEntities(sceneElements()), { x: 30.5, y: 0.5 }, settings(["center"]), null);
  assert.equal(r.mode, "center");
  expectPt(r.point, 30, 0);
  assert.equal(r.entityId, "s-circle");
});

test("osnap quadrant: the four circle quadrants snap", () => {
  const ents = toEntities([flatEntity("q-circle", { type: "circle", cx: 30, cy: 0, r: 10 })]);
  for (const [cursor, expected] of [
    [{ x: 39.5, y: 0.2 }, { x: 40, y: 0 }],
    [{ x: 29.7, y: 9.6 }, { x: 30, y: 10 }],
    [{ x: 20.4, y: 0.4 }, { x: 20, y: 0 }],
    [{ x: 30.6, y: -9.7 }, { x: 30, y: -10 }],
  ] as const) {
    const r = resolveSnap(ents, cursor, settings(["quadrant"]), null);
    assert.equal(r.mode, "quadrant");
    expectPt(r.point, expected.x, expected.y, 1e-9);
    assert.equal(r.entityId, "q-circle");
  }
});

test("osnap quadrant: arc quadrants only inside the sweep; coincident quadrant ties break by entity id", () => {
  // Arc c=(0,0) r=20 over [0, π/2]: quadrants at (20,0) and (0,20) only.
  const ents = toEntities([flatEntity("q-arc", { type: "arc", cx: 0, cy: 0, r: 20, startAngle: 0, endAngle: Math.PI / 2 })]);
  const r = resolveSnap(ents, { x: 0.3, y: 19.7 }, settings(["quadrant"]), null);
  assert.equal(r.mode, "quadrant");
  expectPt(r.point, 0, 20, 1e-9);

  // A circle whose leftmost quadrant (20,0) coincides with the arc's start
  // quadrant: equal distance + equal mode → the smaller entity id wins.
  const both = toEntities([
    flatEntity("z-arc", { type: "arc", cx: 0, cy: 0, r: 20, startAngle: 0, endAngle: Math.PI / 2 }),
    flatEntity("a-circle", { type: "circle", cx: 30, cy: 0, r: 10 }),
  ]);
  const tie = resolveSnap(both, { x: 20.4, y: 0.4 }, settings(["quadrant"]), null);
  expectPt(tie.point, 20, 0, 1e-9);
  assert.equal(tie.entityId, "a-circle", "'a-circle' < 'z-arc' breaks the quadrant tie");
});

test("osnap intersection: the exact crossing of two entities beats everything at distance 0", () => {
  const ents = toEntities([
    flatEntity("h", { type: "line", x1: 0, y1: 5, x2: 10, y2: 5 }),
    flatEntity("v", { type: "line", x1: 5, y1: 0, x2: 5, y2: 10 }),
    flatEntity("d3", { type: "line", x1: 5, y1: 5, x2: 9, y2: 9 }), // endpoint AT the crossing
  ]);
  const r = resolveSnap(ents, { x: 5, y: 5 }, settings(["endpoint", "midpoint", "intersection"]), null);
  assert.equal(r.mode, "intersection", "intersection outranks endpoint and midpoint at equal distance");
  expectPt(r.point, 5, 5, 1e-12);
  assert.equal(r.entityId, "h");
  assert.equal(r.otherEntityId, "v");
});

test("osnap priority: endpoint beats midpoint at exactly equal cursor distance", () => {
  // Cursor (2.5, 5): |(0,0)| and |(5,0)| (midpoint) are both hypot(2.5, 5).
  const ents = toEntities([flatEntity("m-line", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 })]);
  const r = resolveSnap(ents, { x: 2.5, y: 5 }, settings(["endpoint", "midpoint"], { aperture: 6 }), null);
  assert.equal(r.mode, "endpoint");
  expectPt(r.point, 0, 0);
});

test("osnap priority: node beats center; quadrant beats midpoint", () => {
  // node vs center: a point entity sitting at a circle's center.
  const ents = toEntities([
    flatEntity("c", { type: "circle", cx: 5, cy: 5, r: 3 }),
    flatEntity("p", { type: "point", x: 5, y: 5 }),
  ]);
  const r = resolveSnap(ents, { x: 5, y: 5 }, settings(["node", "center"]), null);
  assert.equal(r.mode, "node");
  assert.equal(r.entityId, "p");

  // quadrant vs midpoint: circle quadrant coincides with a line's midpoint.
  const ents2 = toEntities([
    flatEntity("c2", { type: "circle", cx: 0, cy: 0, r: 10 }),
    flatEntity("l2", { type: "line", x1: 0, y1: 0, x2: 20, y2: 0 }),
  ]);
  const r2 = resolveSnap(ents2, { x: 10, y: 0 }, settings(["quadrant", "midpoint"]), null);
  assert.equal(r2.mode, "quadrant");
  expectPt(r2.point, 10, 0);
  assert.equal(r2.entityId, "c2");
});

test("osnap node: point entities snap as nodes", () => {
  const r = resolveSnap(toEntities(sceneElements()), { x: 5.2, y: 5.1 }, settings(["node"]), null);
  assert.equal(r.mode, "node");
  expectPt(r.point, 5, 5);
  assert.equal(r.entityId, "s-point");
});

test("osnap nearest: closest-on-curve fallback within half the aperture", () => {
  const ents = toEntities([flatEntity("n-line", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 })]);
  const r = resolveSnap(ents, { x: 5, y: 3 }, settings(["nearest"]), null);
  assert.equal(r.mode, "nearest");
  expectPt(r.point, 5, 0, 1e-9);
  assert.equal(r.entityId, "n-line");
  // Beyond half the aperture → raw cursor.
  const far = resolveSnap(ents, { x: 5, y: 6 }, settings(["nearest"], { aperture: 10 }), null);
  assert.equal(far.mode, null);
  expectPt(far.point, 5, 6, 1e-12);
  // Nearest picks the CLOSEST entity: a point at distance 2 beats the line at 3.
  const withPoint = toEntities([
    flatEntity("n-line", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }),
    flatEntity("n-point", { type: "point", x: 5, y: 5 }),
  ]);
  const nearest = resolveSnap(withPoint, { x: 5, y: 3 }, settings(["nearest"]), null);
  assert.equal(nearest.entityId, "n-point");
  expectPt(nearest.point, 5, 5, 1e-12);
});

test("osnap perpendicular: foot of the perpendicular from the last point", () => {
  const ents = toEntities([flatEntity("p-line", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 })]);
  const r = resolveSnap(ents, { x: 5, y: 1 }, settings(["perpendicular"]), { x: 5, y: 7 });
  assert.equal(r.mode, "perpendicular");
  expectPt(r.point, 5, 0);
  assert.equal(r.entityId, "p-line");
});

test("osnap tangent: tangent points from the last point onto the circle", () => {
  const ents = toEntities([flatEntity("t-circle", { type: "circle", cx: 0, cy: 0, r: 10 })]);
  // From (20,0): tangent points at angles ±acos(10/20)=±60°.
  const r = resolveSnap(ents, { x: 6, y: 8 }, settings(["tangent"]), { x: 20, y: 0 });
  assert.equal(r.mode, "tangent");
  expectPt(r.point, 5, 5 * Math.sqrt(3), 1e-9);
  assert.equal(r.entityId, "t-circle");
});

test("osnap: with no modes enabled the raw cursor passes through", () => {
  const r = resolveSnap(toEntities(sceneElements()), { x: 3, y: 3 }, settings([]), null);
  assert.equal(r.mode, null);
  assert.equal(r.entityId, null);
  expectPt(r.point, 3, 3, 1e-15);
});

test("aperture boundary: exactly at the aperture snaps, just beyond does not", () => {
  const ents = toEntities([flatEntity("a-line", { type: "line", x1: 0, y1: 0, x2: 0, y2: 20 })]);
  const at = resolveSnap(ents, { x: 10, y: 0 }, settings(["endpoint", "midpoint"], { aperture: 10 }), null);
  assert.equal(at.mode, "endpoint", "distance 10 == aperture 10 → inside");
  expectPt(at.point, 0, 0);
  const beyond = resolveSnap(ents, { x: 10.5, y: 0 }, settings(["endpoint", "midpoint"], { aperture: 10 }), null);
  assert.equal(beyond.mode, null);
  expectPt(beyond.point, 10.5, 0, 1e-15);
});

test("deterministic tie-break: equal distance + equal mode → smaller entity id wins", () => {
  const ents: Entity[] = toEntities([
    flatEntity("z-line", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }),
    flatEntity("a-line", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }),
  ]);
  const r = resolveSnap(ents, { x: 0, y: 0 }, settings(["endpoint"]), null);
  assert.equal(r.entityId, "a-line", "id order (not insertion order) breaks resolveSnap ties");
});

test("OSNAP_LABELS covers exactly the nine modes in registry order", () => {
  assert.deepEqual(Object.keys(OSNAP_LABELS), [
    "endpoint", "midpoint", "center", "quadrant", "intersection", "node", "nearest", "perpendicular", "tangent",
  ]);
  assert.equal(new Set(Object.values(OSNAP_LABELS)).size, 9);
});

// --- Deterministic picking ----------------------------------------------------

test("pickAt: the closest entity wins; ties break by insertion order", () => {
  const ents = toEntities([
    flatEntity("pick-line", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }),
    flatEntity("pick-circle", { type: "circle", cx: 0, cy: 20, r: 5 }),
  ]);
  const line = pickAt(ents, { x: 5, y: 1 }, 10);
  assert.equal(line?.id, "pick-line", "line distance 1 beats circle distance ~15");
  const circle = pickAt(ents, { x: 0, y: 15 }, 10);
  assert.equal(circle?.id, "pick-circle", "on the circle rim beats 15-away line");
  assert.equal(pickAt(ents, { x: 50, y: 50 }, 10), null, "nothing within the aperture");

  const tied = toEntities([
    flatEntity("t-b", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }),
    flatEntity("t-a", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }),
  ]);
  const tie = pickAt(tied, { x: 5, y: 0 }, 5);
  assert.equal(tie?.id, "t-b", "pickAt ties keep the FIRST entity in array order");
});

test("pickAt: point entities are pickable at their exact position", () => {
  const ents = toEntities([flatEntity("pt", { type: "point", x: 4, y: 4 })]);
  assert.equal(pickAt(ents, { x: 4.2, y: 4.1 }, 1)?.id, "pt");
  assert.equal(pickAt(ents, { x: 4.2, y: 4.1 }, 0.2), null);
});

// --- Window / crossing selection ----------------------------------------------

function windowSceneElements(): readonly Element[] {
  return [
    flatEntity("w-in", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }),          // fully inside
    flatEntity("w-cross", { type: "line", x1: 5, y1: 0, x2: 20, y2: 0 }),       // crosses the border
    flatEntity("w-out", { type: "line", x1: 20, y1: 0, x2: 30, y2: 0 }),        // fully outside
    flatEntity("w-small-circle", { type: "circle", cx: 5, cy: 0, r: 1 }),       // fully inside
    flatEntity("w-big-circle", { type: "circle", cx: 0, cy: 0, r: 100 }),       // contains the box
    flatEntity("w-pt", { type: "point", x: 2, y: 2 }),                          // inside
    flatEntity("w-spline", { type: "spline", controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 50 }, { x: 20, y: 0 }], degree: 2 }), // enters the box
  ];
}

function windowScene(): readonly Entity[] {
  return toEntities(windowSceneElements());
}

const BOX = { mode: "window" as const, min: { x: -5, y: -5 }, max: { x: 15, y: 5 } };

test("selectWindow window mode: only fully contained entities are selected", () => {
  const ids = selectWindow(windowScene(), BOX);
  assert.deepEqual(ids, ["w-in", "w-small-circle", "w-pt"], "a line crossing the border is NOT selected in window mode");
});

test("selectWindow crossing mode: any intersection selects (border crossers, box-inside-circle, spline via sampling)", () => {
  const ids = selectWindow(windowScene(), { ...BOX, mode: "crossing" });
  assert.deepEqual(ids, [
    "w-in", "w-cross", "w-small-circle", "w-big-circle", "w-pt", "w-spline",
  ], "w-out stays unselected; the spline is detected through its 32-sample polyline");
});

test("selectWindow: a spline that stays inside the box is selected in BOTH modes", () => {
  const ents = toEntities([
    flatEntity("inside-spline", { type: "spline", controlPoints: [{ x: 6, y: 20 }, { x: 7, y: 21 }, { x: 8, y: 20 }], degree: 2 }),
    flatEntity("outside-spline", { type: "spline", controlPoints: [{ x: 100, y: 100 }, { x: 110, y: 120 }, { x: 120, y: 100 }], degree: 2 }),
  ]);
  const sel = { mode: "window" as const, min: { x: 5, y: 10 }, max: { x: 15, y: 40 } };
  assert.deepEqual(selectWindow(ents, sel), ["inside-spline"]);
  assert.deepEqual(selectWindow(ents, { ...sel, mode: "crossing" }), ["inside-spline"]);
});

test("selectWindow: infinite entities are never fully inside (window) but cross", () => {
  const ents = toEntities([
    flatEntity("xln", { type: "xline", x1: 0, y1: 0, x2: 1, y2: 0 }),
    flatEntity("ray", { type: "ray", x1: 0, y1: 0, x2: 0, y2: 1 }),
  ]);
  const sel = { mode: "window" as const, min: { x: -10, y: -10 }, max: { x: 10, y: 10 } };
  assert.deepEqual(selectWindow(ents, sel), []);
  assert.deepEqual(selectWindow(ents, { ...sel, mode: "crossing" }), ["xln", "ray"]);
});

// --- Constraints ---------------------------------------------------------------

test("constrainPoint ortho: snaps to the nearer axis, distance preserved", () => {
  const r = constrainPoint({ x: 10, y: 3 }, { x: 0, y: 0 }, settings([], { ortho: true }));
  const d = Math.hypot(10, 3);
  expectPt(r.point, d, 0, 1e-12);
  assert.ok(Math.abs((r.angle ?? 0)) <= 1e-12, "horizontal axis angle 0");
  assert.equal(r.paths.length, 1);
  assert.equal(r.paths[0]!.kind, "horizontal");
});

test("constrainPoint polar: 45° increments capture within the 10° tolerance", () => {
  const s = settings([], { polar: true, polarAnglesDeg: [0, 45, 90, 135, 180, 225, 270, 315] });
  // (10,10) is exactly 45°: stays 45°.
  const exact = constrainPoint({ x: 10, y: 10 }, { x: 0, y: 0 }, s);
  assert.ok(Math.abs((exact.angle ?? 0) - Math.PI / 4) <= 1e-12);
  expectPt(exact.point, 10, 10, 1e-9);
  // (10,9) is ~42°: captured to 45° with the distance preserved.
  const captured = constrainPoint({ x: 10, y: 9 }, { x: 0, y: 0 }, s);
  assert.ok(Math.abs((captured.angle ?? 0) - Math.PI / 4) <= 1e-12);
  const d = Math.hypot(10, 9);
  expectPt(captured.point, d / Math.SQRT2, d / Math.SQRT2, 1e-9);
  // (10,3) is ~17°: outside the 10° capture band → unconstrained.
  const free = constrainPoint({ x: 10, y: 3 }, { x: 0, y: 0 }, s);
  assert.equal(free.angle, null);
  expectPt(free.point, 10, 3, 1e-15);
});

test("constrainPoint grid: rounds to the grid pitch", () => {
  const s = settings([], { gridSnap: true, gridSize: 10 });
  const r = constrainPoint({ x: 12, y: 27 }, null, s);
  expectPt(r.point, 10, 30, 1e-12);
});

test("constrainPoint tracking: aligns with acquired points within the aperture", () => {
  const s = settings([], { tracking: true, aperture: 10 });
  const r = constrainPoint({ x: 11, y: 50 }, { x: 0, y: 0 }, s, [{ x: 10, y: 20 }]);
  expectPt(r.point, 10, 50, 1e-12);
  assert.equal(r.paths.some((p) => p.kind === "vertical" && p.through.x === 10 && p.through.y === 20), true);
  // 6 away in x > aperture/2 = 5 → no tracking capture.
  const no = constrainPoint({ x: 16, y: 50 }, { x: 0, y: 0 }, s, [{ x: 10, y: 20 }]);
  expectPt(no.point, 16, 50, 1e-12);
});

test("constrainPoint without a base point leaves the point free (grid still applies)", () => {
  const r = constrainPoint({ x: 7, y: 7 }, null, settings([]));
  expectPt(r.point, 7, 7, 1e-15);
  assert.equal(r.angle, null);
});

// --- Grips ---------------------------------------------------------------------

test("gripsOf: line has 2 vertex grips + midpoint; circle has center + 4 radius grips", () => {
  const line = toEntities([flatEntity("g-line", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 })])[0]!;
  const lg = gripsOf(line);
  assert.deepEqual(lg.map((g) => [g.kind, g.point.x, g.point.y]), [
    ["vertex", 0, 0], ["vertex", 10, 0], ["mid", 5, 0],
  ]);
  const circle = toEntities([flatEntity("g-circle", { type: "circle", cx: 30, cy: 0, r: 10 })])[0]!;
  const cg = gripsOf(circle);
  assert.equal(cg.length, 5);
  assert.deepEqual(cg[0], { entityId: "g-circle", index: -1, point: { x: 30, y: 0 }, kind: "center" });
  assert.deepEqual(cg.slice(1).map((g) => [g.point.x, g.point.y]), [[40, 0], [30, 10], [20, 0], [30, -10]]);
});

// --- toEntities: both conventions, one view -------------------------------------

test("toEntities: both storage conventions resolve to the same canonical entity view", () => {
  const legacy: Element = {
    id: "legacy-1", kind: "geometry", engineId: null,
    props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [10, 0] },
  };
  const flat = flatEntity("flat-1", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 });
  const nonGeom: Element = { id: "dim", kind: "annotation", engineId: null, props: { type: "dim-linear" } };
  const bim: Element = { id: "w", kind: "bim", engineId: null, props: { bim: true, type: "bim.wall" } };
  const ents = toEntities([legacy, flat, nonGeom, bim]);
  assert.equal(ents.length, 2, "annotations and BIM elements are skipped");
  assert.deepEqual(ents[0]!.geom, ents[1]!.geom, "legacy and flat decode identically");
  assert.deepEqual(ents[0], { id: "legacy-1", geom: { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }, layer: "0", color: null, linetype: "Continuous" });
});

// --- Determinism: every query kind run twice → deep-equal -----------------------

test("determinism: resolveSnap/pickAt/selectWindow/constrainPoint are pure (double-run deep-equal)", () => {
  const ents = windowScene();
  const s = settings(["endpoint", "midpoint", "center", "quadrant", "intersection", "node", "nearest"], { aperture: 8 });
  const cursors: readonly Pt[] = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 30, y: 10 }, { x: 12, y: 2 }, { x: -3, y: 4 }];
  for (const cursor of cursors) {
    assert.deepEqual(resolveSnap(ents, cursor, s, null), resolveSnap(ents, cursor, s, null));
    assert.deepEqual(resolveSnap(ents, cursor, s, { x: 20, y: 20 }), resolveSnap(ents, cursor, s, { x: 20, y: 20 }));
  }
  assert.deepEqual(pickAt(ents, { x: 4, y: 1 }, 6), pickAt(ents, { x: 4, y: 1 }, 6));
  assert.deepEqual(selectWindow(ents, BOX), selectWindow(ents, BOX));
  assert.deepEqual(selectWindow(ents, { ...BOX, mode: "crossing" }), selectWindow(ents, { ...BOX, mode: "crossing" }));
  const cs = settings([], { polar: true, ortho: false });
  assert.deepEqual(constrainPoint({ x: 10, y: 9 }, { x: 0, y: 0 }, cs), constrainPoint({ x: 10, y: 9 }, { x: 0, y: 0 }, cs));
  const allElements = [...sceneElements(), ...windowSceneElements()];
  assert.deepEqual(toEntities(allElements), toEntities(allElements));
});
