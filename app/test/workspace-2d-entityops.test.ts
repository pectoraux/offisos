/**
 * CAD-PARITY-003 — entity-ops semantics over document-shaped elements
 * (CP3-PORT-2b).
 *
 * createEntities/modifyEntities receive CADDocument elements in BOTH storage
 * conventions (COMPAT-CAD-001 legacy vocabulary and the CAD-PARITY-003 flat
 * canonical convention — the bridge unifies them), apply the deterministic
 * kernel, and return ONE atomic applyEdits DocumentEdit per operation plus a
 * deterministic summary. Typed EntityOpError failures carry stable codes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createEntities, modifyEntities, EntityOpError, type EntityOpOutcome } from "../src/workspace/entity-ops.js";
import { GeomOpError } from "../src/workspace/geometry/fillet.js";
import type { Element, DocumentEdit } from "../src/contracts/caddocument.js";

// --- Element builders (BOTH conventions) -------------------------------------

function geomEl(id: string, props: Record<string, unknown>, layer = "0"): Element {
  return { id, kind: "geometry", engineId: null, props: { drafting: true, layer, ...props } };
}

/** COMPAT-CAD-001 legacy vocabulary. */
const legacyLine = (id: string, from: readonly number[], to: readonly number[]): Element =>
  geomEl(id, { type: "line", from: [...from], to: [...to] });
const legacyCircle = (id: string, center: readonly number[], radius: number): Element =>
  geomEl(id, { type: "circle", center: [...center], radius });
const legacyRect = (id: string, corner1: readonly number[], corner2: readonly number[]): Element =>
  geomEl(id, { type: "rectangle", corner1: [...corner1], corner2: [...corner2] });

/** CAD-PARITY-003 flat canonical convention. */
const flatLine = (id: string, x1: number, y1: number, x2: number, y2: number): Element =>
  geomEl(id, { type: "line", x1, y1, x2, y2 });
const flatCircle = (id: string, cx: number, cy: number, r: number): Element =>
  geomEl(id, { type: "circle", cx, cy, r });

const ANNOTATION: Element = {
  id: "dim-1", kind: "annotation", engineId: null,
  props: { type: "dim-linear", layer: "0", p1: [0, 0], p2: [100, 0], measured: 100 },
};
const BIM_WALL: Element = {
  id: "wall-1", kind: "bim", engineId: null,
  props: { bim: true, type: "bim.wall", storyId: "s", start: [0, 0], end: [5000, 0], width: 240, height: 3000 },
};

const layerExists = (): boolean => true;

/** The reference document: both conventions + an annotation + a BIM element. */
function docElements(): readonly Element[] {
  return [
    flatLine("l1", 0, 0, 100, 0),
    legacyLine("l2", [0, 0], [0, 100]),
    flatCircle("c1", 50, 0, 20),
    legacyRect("r1", [10, 10], [30, 20]),
    legacyCircle("c2", [200, 200], 5),
    ANNOTATION,
    BIM_WALL,
  ];
}

type ApplyEditsEdit = Extract<DocumentEdit, { type: "applyEdits" }>;

function expectOutcome(outcome: EntityOpOutcome, subEditCount: number): ApplyEditsEdit {
  assert.ok(outcome.edit !== null, `expected an edit, got summary: ${outcome.summary}`);
  assert.equal(outcome.edit.type, "applyEdits", "one op = ONE atomic applyEdits batch");
  assert.equal(outcome.edit.edits.length, subEditCount);
  return outcome.edit;
}

function expectEntityOpError(fn: () => unknown, code: string, messagePattern: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof EntityOpError, `expected EntityOpError, got ${String(caught)}`);
  assert.equal((caught as EntityOpError).code, code);
  assert.match((caught as Error).message, messagePattern);
}

// --- CREATE --------------------------------------------------------------------

test("createEntities: canonical records become addElement edits with drafting+layer props", () => {
  const o = createEntities([], layerExists, [
    { type: "ellipse", layer: "0", cx: 0, cy: 0, rx: 100, ry: 50, rotation: 0 },
    { type: "point", layer: "0", x: 7, y: 9 },
  ]);
  const edit = expectOutcome(o, 2);
  assert.equal(o.createdCount, 2);
  assert.equal(o.summary, "2 entities created");
  assert.deepEqual(edit.edits[0], {
    type: "addElement",
    element: { id: "", kind: "geometry", engineId: null, props: { drafting: true, layer: "0", type: "ellipse", cx: 0, cy: 0, rx: 100, ry: 50, rotation: 0 } },
  });
});

test("createEntities: region derived properties are recomputed — correct values accepted", () => {
  const o = createEntities([], layerExists, [{
    type: "region", layer: "0",
    boundary: { kind: "circle", cx: 3, cy: 4, r: 5 },
    area: 25 * Math.PI,
    perimeter: 10 * Math.PI,
    centroid: { x: 3, y: 4 },
  }]);
  expectOutcome(o, 1);
  assert.equal(o.createdCount, 1);
});

test("createEntities: FORGED region properties are rejected (non-forgeable derived data)", () => {
  expectEntityOpError(
    () => createEntities([], layerExists, [{
      type: "region", layer: "0",
      boundary: { kind: "circle", cx: 0, cy: 0, r: 5 },
      area: 999, perimeter: 31.41592653589793, centroid: { x: 0, y: 0 },
    }]),
    "bad_entity",
    /do not match the boundary/,
  );
});

test("createEntities typed failures: empty batch, malformed records, unknown layer", () => {
  expectEntityOpError(() => createEntities([], layerExists, []), "bad_input", /non-empty entities array/);
  expectEntityOpError(
    () => createEntities([], layerExists, [{ type: "ellipse", layer: "0", cx: 0, cy: 0, rx: 0, ry: 5, rotation: 0 }]),
    "bad_entity",
    /not a valid canonical 2D geometry record/,
  );
  expectEntityOpError(
    () => createEntities([], () => false, [{ type: "point", layer: "ghost", x: 0, y: 0 }]),
    "bad_layer",
    /layer 'ghost' does not exist/,
  );
});

// --- MOVE / COPY / ROTATE / SCALE / MIRROR --------------------------------------

test("modifyEntities move: exact canonical write-back for BOTH conventions", () => {
  const legacy = modifyEntities(docElements(), { op: "move", ids: ["l2"], dx: 5, dy: 7 });
  const edit = expectOutcome(legacy, 1);
  assert.deepEqual(edit.edits[0], {
    type: "setProps",
    elementId: "l2",
    patch: { drafting: true, layer: "0", type: "line", x1: 5, y1: 7, x2: 5, y2: 107 },
  }, "legacy {from,to} is written back as canonical {x1..y2}");
  assert.equal(legacy.summary, "1 entity moved by (5, 7)");
  assert.equal(legacy.modifiedCount, 1);

  const flat = modifyEntities(docElements(), { op: "move", ids: ["l1"], dx: 5, dy: 7 });
  assert.deepEqual(
    (expectOutcome(flat, 1).edits[0] as { patch: Record<string, unknown> }).patch,
    { drafting: true, layer: "0", type: "line", x1: 5, y1: 7, x2: 105, y2: 7 },
  );
});

test("modifyEntities move on a legacy rectangle materializes it as a closed polyline (echoed)", () => {
  const o = modifyEntities(docElements(), { op: "move", ids: ["r1"], dx: 5, dy: 7 });
  const patch = (expectOutcome(o, 1).edits[0] as { patch: Record<string, unknown> }).patch;
  assert.equal(patch.type, "polyline");
  assert.equal(patch.closed, true);
  assert.deepEqual(patch.vertices, [
    { x: 15, y: 17 }, { x: 35, y: 17 }, { x: 35, y: 27 }, { x: 15, y: 27 },
  ]);
  assert.match(o.summary, /rectangle materialized as closed polyline/);
});

test("modifyEntities copy: addElement edits on the source layer; legacy sources copy canonically", () => {
  const o = modifyEntities(docElements(), { op: "copy", ids: ["l2", "r1"], dx: 10, dy: 0 });
  const edit = expectOutcome(o, 2);
  assert.equal(o.createdCount, 2);
  assert.equal(o.summary, "2 copies created");
  const first = edit.edits[0] as { type: string; element: { props: Record<string, unknown> } };
  assert.equal(first.type, "addElement");
  assert.deepEqual(first.element.props, { drafting: true, layer: "0", type: "line", x1: 10, y1: 0, x2: 10, y2: 100 });
});

/** Numeric prop accessor for canonical patches (noUncheckedIndexedAccess-safe). */
function numProp(props: Record<string, unknown>, key: string): number {
  const v = props[key];
  assert.equal(typeof v, "number", `props.${key} should be a number`);
  return v as number;
}

function expectNear(actual: number, expected: number, tol = 1e-9, label = "value"): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected} ±${tol}, got ${actual}`);
}

test("modifyEntities rotate: canonical geometry rotation + rectangle echo", () => {
  const o = modifyEntities(docElements(), { op: "rotate", ids: ["c1", "r1"], base: { x: 0, y: 0 }, angle: Math.PI / 2 });
  const edit = expectOutcome(o, 2);
  const circlePatch = (edit.edits[0] as { patch: Record<string, unknown> }).patch;
  expectNear(numProp(circlePatch, "cx"), 0);
  expectNear(numProp(circlePatch, "cy"), 50);
  expectNear(numProp(circlePatch, "r"), 20, 1e-12);
  assert.match(o.summary, /2 entities rotated 90\.00°/);
  assert.match(o.summary, /rectangle materialized as closed polyline/);
});

test("modifyEntities scale: factor multiplies geometry about the base", () => {
  const o = modifyEntities(docElements(), { op: "scale", ids: ["c1"], base: { x: 50, y: 0 }, factor: 2 });
  const patch = (expectOutcome(o, 1).edits[0] as { patch: Record<string, unknown> }).patch;
  assert.deepEqual({ cx: patch.cx, cy: patch.cy, r: patch.r }, { cx: 50, cy: 0, r: 40 });
  assert.equal(o.summary, "1 entity scaled ×2.0000");
});

test("modifyEntities mirror: eraseSource=false keeps the source (addElement); true replaces it", () => {
  const keep = modifyEntities(docElements(), { op: "mirror", ids: ["l1"], p1: { x: 0, y: 0 }, p2: { x: 0, y: 10 }, eraseSource: false });
  const keepEdit = expectOutcome(keep, 1);
  assert.equal(keepEdit.edits[0]!.type, "addElement");
  assert.deepEqual(
    (keepEdit.edits[0] as { element: { props: Record<string, unknown> } }).element.props,
    { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: -100, y2: 0 },
  );
  assert.equal(keep.summary, "1 entity mirrored (source kept)");
  assert.equal(keep.createdCount, 1);

  const erase = modifyEntities(docElements(), { op: "mirror", ids: ["l1"], p1: { x: 0, y: 0 }, p2: { x: 0, y: 10 }, eraseSource: true });
  const eraseEdit = expectOutcome(erase, 1);
  assert.equal(eraseEdit.edits[0]!.type, "setProps");
  assert.deepEqual(
    (eraseEdit.edits[0] as { patch: Record<string, unknown> }).patch,
    { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: -100, y2: 0 },
  );
  assert.equal(erase.modifiedCount, 1);
});

// --- OFFSET / TRIM / EXTEND ------------------------------------------------------

test("modifyEntities offset: distance mode offsets to the picked side", () => {
  const o = modifyEntities(docElements(), { op: "offset", items: [{ targetId: "l1", distance: 10, side: { x: 50, y: 10 }, through: false }] });
  const edit = expectOutcome(o, 1);
  assert.deepEqual(
    (edit.edits[0] as { element: { props: Record<string, unknown> } }).element.props,
    { drafting: true, layer: "0", type: "line", x1: 0, y1: 10, x2: 100, y2: 10 },
  );
  assert.equal(o.createdCount, 1);
});

test("modifyEntities offset: through=true derives the distance from the picked point", () => {
  const o = modifyEntities(docElements(), { op: "offset", items: [{ targetId: "l1", distance: 0, side: { x: 50, y: 30 }, through: true }] });
  const edit = expectOutcome(o, 1);
  assert.deepEqual(
    (edit.edits[0] as { element: { props: Record<string, unknown> } }).element.props,
    { drafting: true, layer: "0", type: "line", x1: 0, y1: 30, x2: 100, y2: 30 },
  );
});

test("modifyEntities offset typed failures: through-point on the curve; kernel errors surface typed", () => {
  expectEntityOpError(
    () => modifyEntities(docElements(), { op: "offset", items: [{ targetId: "l1", distance: 0, side: { x: 50, y: 0 }, through: true }] }),
    "offset_failed",
    /through point is on the curve/,
  );
  // Offset that exceeds the arc radius is a kernel-level typed error caught
  // and wrapped into the offset failure.
  const doc = [...docElements(), geomEl("a1", { type: "arc", cx: 0, cy: 0, r: 10, startAngle: 0, endAngle: Math.PI / 2 })];
  expectEntityOpError(
    () => modifyEntities(doc, { op: "offset", items: [{ targetId: "a1", distance: 20, side: { x: 0, y: 5 }, through: false }] }),
    "offset_failed",
    /offset exceeds radius/,
  );
});

test("modifyEntities trim: circle cuts the line at the picked piece; implied all-edges when edges=[]", () => {
  const explicit = modifyEntities(docElements(), { op: "trim", edges: ["c1"], trims: [{ targetId: "l1", pick: { x: 10, y: 0 } }] });
  assert.deepEqual(
    (expectOutcome(explicit, 1).edits[0] as { patch: Record<string, unknown> }).patch,
    { drafting: true, layer: "0", type: "line", x1: 30, y1: 0, x2: 100, y2: 0 },
    "the piece nearest the pick (left) is removed",
  );

  // edges=[] implies "every other canonical entity is an edge" (AutoCAD Enter).
  const implied = modifyEntities(docElements(), { op: "trim", edges: [], trims: [{ targetId: "l1", pick: { x: 10, y: 0 } }] });
  assert.deepEqual(
    (expectOutcome(implied, 1).edits[0] as { patch: Record<string, unknown> }).patch,
    { drafting: true, layer: "0", type: "line", x1: 30, y1: 0, x2: 100, y2: 0 },
  );
});

test("modifyEntities trim: middle pick splits the entity (replace + add)", () => {
  const o = modifyEntities(docElements(), { op: "trim", edges: ["c1"], trims: [{ targetId: "l1", pick: { x: 50, y: 0 } }] });
  const edit = expectOutcome(o, 2);
  assert.equal(edit.edits[0]!.type, "setProps");
  assert.deepEqual((edit.edits[0] as { patch: Record<string, unknown> }).patch, {
    drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 30, y2: 0,
  });
  assert.equal(edit.edits[1]!.type, "addElement");
  assert.deepEqual((edit.edits[1] as { element: { props: Record<string, unknown> } }).element.props, {
    drafting: true, layer: "0", type: "line", x1: 70, y1: 0, x2: 100, y2: 0,
  });
});

test("modifyEntities trim typed failure: no cutting intersections → trim_failed with skip message", () => {
  expectEntityOpError(
    () => modifyEntities(docElements(), { op: "trim", edges: ["c2"], trims: [{ targetId: "l1", pick: { x: 50, y: 0 } }] }),
    "trim_failed",
    /l1: no cutting edges intersect the entity/,
  );
  // Cut exactly on the entity end: nothing removable.
  expectEntityOpError(
    () => modifyEntities(docElements(), { op: "trim", edges: ["l2"], trims: [{ targetId: "l1", pick: { x: 50, y: 0 } }] }),
    "trim_failed",
    /cuts fall on the entity ends/,
  );
});

test("modifyEntities extend: line extends to the boundary (exact new endpoint)", () => {
  const doc = [...docElements(), flatLine("b1", 100, -50, 100, 50)];
  const target = flatLine("short", 0, 0, 50, 0);
  const o = modifyEntities([...doc, target], { op: "extend", boundaries: ["b1"], targets: [{ targetId: "short", pick: { x: 50, y: 0 } }] });
  assert.deepEqual(
    (expectOutcome(o, 1).edits[0] as { patch: Record<string, unknown> }).patch,
    { drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0 },
  );
  assert.equal(o.summary, "1 entity extended");
});

test("modifyEntities extend typed failure: no boundary in the extension direction", () => {
  expectEntityOpError(
    () => modifyEntities(docElements(), { op: "extend", boundaries: ["l2"], targets: [{ targetId: "l1", pick: { x: 100, y: 0 } }] }),
    "extend_failed",
    /no boundary intersection in the extension direction/,
  );
});

// --- STRETCH / FILLET / CHAMFER / BREAK ------------------------------------------

test("modifyEntities stretch: only entities with vertices inside the window change; unchanged ones are untouched", () => {
  const doc = [...docElements(), flatLine("s1", 0, 0, 100, 0), flatLine("s2", 0, 200, 100, 200)];
  const o = modifyEntities(doc, { op: "stretch", ids: ["s1", "s2"], winMin: { x: 50, y: -10 }, winMax: { x: 150, y: 10 }, dx: 0, dy: 20 });
  const edit = expectOutcome(o, 1);
  assert.equal((edit.edits[0] as { elementId: string }).elementId, "s1");
  assert.deepEqual((edit.edits[0] as { patch: Record<string, unknown> }).patch, {
    drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 20,
  });
  assert.equal(o.summary, "1 entity stretched");
  assert.equal(o.modifiedCount, 1);
});

test("modifyEntities fillet pair: exact trimmed lines + the corner arc in one batch", () => {
  const o = modifyEntities(docElements(), {
    op: "fillet", mode: "pair", radius: 15,
    firstId: "l1", firstPick: { x: 50, y: 0 }, secondId: "l2", secondPick: { x: 0, y: 50 },
  });
  const edit = expectOutcome(o, 3);
  assert.equal(edit.edits[0]!.type, "setProps");
  assert.equal(edit.edits[1]!.type, "setProps");
  assert.equal(edit.edits[2]!.type, "addElement");
  const a = (edit.edits[0] as { patch: Record<string, unknown> }).patch;
  const b = (edit.edits[1] as { patch: Record<string, unknown> }).patch;
  expectNear(numProp(a, "x1"), 100);
  expectNear(numProp(a, "y1"), 0);
  expectNear(numProp(a, "x2"), 15);
  expectNear(numProp(a, "y2"), 0);
  expectNear(numProp(b, "x1"), 0);
  expectNear(numProp(b, "y1"), 100);
  expectNear(numProp(b, "x2"), 0);
  expectNear(numProp(b, "y2"), 15);
  const arcProps = (edit.edits[2] as { element: { props: Record<string, unknown> } }).element.props;
  expectNear(numProp(arcProps, "cx"), 15);
  expectNear(numProp(arcProps, "cy"), 15);
  expectNear(numProp(arcProps, "r"), 15);
  assert.equal(o.summary, "fillet radius 15 applied");
});

test("modifyEntities fillet pair on a non-line-pair: the kernel's typed limitation propagates", () => {
  // The kernel GeomOpError (unsupported_pair) is NOT swallowed by opFillet —
  // it surfaces verbatim to the command layer (typed message + code).
  let caught: unknown;
  try {
    modifyEntities(docElements(), {
      op: "fillet", mode: "pair", radius: 15,
      firstId: "c1", firstPick: { x: 70, y: 0 }, secondId: "l1", secondPick: { x: 50, y: 0 },
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof GeomOpError, `expected GeomOpError, got ${String(caught)}`);
  assert.equal((caught as GeomOpError).code, "unsupported_pair");
  assert.match((caught as Error).message, /typed limitation/);
});

test("modifyEntities fillet polyline: rectangle-polyline splits into segments + corner arcs", () => {
  const doc = [...docElements(), geomEl("pl1", { type: "polyline", vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], closed: false })];
  const o = modifyEntities(doc, { op: "fillet", mode: "polyline", radius: 15, polylineId: "pl1" });
  // remove + 2 straight pieces + 1 corner arc.
  const edit = expectOutcome(o, 4);
  assert.equal(edit.edits[0]!.type, "removeElement");
  assert.equal((edit.edits[0] as { elementId: string }).elementId, "pl1");
  assert.equal(edit.edits.filter((e) => e.type === "addElement").length, 3);
  assert.match(o.summary, /polyline filleted: 2 segments \+ 1 corner arc/);
  assert.equal(o.removedCount, 1);
  assert.equal(o.createdCount, 3);
});

test("modifyEntities chamfer pair + polyline", () => {
  const pair = modifyEntities(docElements(), {
    op: "chamfer", mode: "pair", d1: 10, d2: 10,
    firstId: "l1", firstPick: { x: 50, y: 0 }, secondId: "l2", secondPick: { x: 0, y: 50 },
  });
  const edit = expectOutcome(pair, 3);
  assert.deepEqual((edit.edits[2] as { element: { props: Record<string, number> } }).element.props, {
    drafting: true, layer: "0", type: "line", x1: 10, y1: 0, x2: 0, y2: 10,
  });
  assert.equal(pair.summary, "chamfer 10 × 10 applied");

  const doc = [...docElements(), geomEl("pl2", { type: "polyline", vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], closed: false })];
  const poly = modifyEntities(doc, { op: "chamfer", mode: "polyline", d1: 10, d2: 10, polylineId: "pl2" });
  const patch = (expectOutcome(poly, 1).edits[0] as { patch: Record<string, unknown> }).patch;
  assert.deepEqual(patch.vertices, [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 100, y: 10 }, { x: 100, y: 50 }]);
  assert.equal(poly.summary, "polyline chamfered (10 × 10)");
});

test("modifyEntities break: two pieces (replace + add) with exact coordinates", () => {
  const o = modifyEntities(docElements(), { op: "break", targetId: "l1", p1: { x: 30, y: 0 }, p2: { x: 60, y: 0 } });
  const edit = expectOutcome(o, 2);
  assert.deepEqual((edit.edits[0] as { patch: Record<string, unknown> }).patch, {
    drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 30, y2: 0,
  });
  assert.deepEqual((edit.edits[1] as { element: { props: Record<string, unknown> } }).element.props, {
    drafting: true, layer: "0", type: "line", x1: 60, y1: 0, x2: 100, y2: 0,
  });
  assert.equal(o.summary, "broken into 2 pieces");
});

// --- JOIN / EXPLODE / setGeometry ---------------------------------------------------

test("modifyEntities join: collinear lines merge; sources removed in the same batch", () => {
  const doc = [...docElements(), flatLine("j1", 0, 0, 30, 0), flatLine("j2", 50, 0, 100, 0)];
  const o = modifyEntities(doc, { op: "join", ids: ["j1", "j2"] });
  const edit = expectOutcome(o, 2);
  assert.deepEqual((edit.edits[0] as { patch: Record<string, unknown> }).patch, {
    drafting: true, layer: "0", type: "line", x1: 0, y1: 0, x2: 100, y2: 0,
  });
  assert.equal(edit.edits[1]!.type, "removeElement");
  assert.equal((edit.edits[1] as { elementId: string }).elementId, "j2");
  assert.equal(o.summary, "joined into one line");
  assert.equal(o.removedCount, 1);
});

test("modifyEntities explode: legacy rectangle explodes into its 4 canonical segments", () => {
  const o = modifyEntities(docElements(), { op: "explode", ids: ["r1"] });
  const edit = expectOutcome(o, 5);
  assert.equal(edit.edits[0]!.type, "removeElement");
  const segs = edit.edits.slice(1).map((e) => (e as { element: { props: Record<string, number> } }).element.props);
  assert.deepEqual(segs.map((p) => [p.x1, p.y1, p.x2, p.y2]), [
    [10, 10, 30, 10], [30, 10, 30, 20], [30, 20, 10, 20], [10, 20, 10, 10],
  ]);
  assert.equal(o.summary, "1 entity exploded");
});

test("modifyEntities setGeometry: validated canonical replacement", () => {
  const o = modifyEntities(docElements(), { op: "setGeometry", id: "l1", geom: { type: "line", x1: 1, y1: 2, x2: 3, y2: 4 } });
  assert.deepEqual(
    (expectOutcome(o, 1).edits[0] as { patch: Record<string, unknown> }).patch,
    { drafting: true, layer: "0", type: "line", x1: 1, y1: 2, x2: 3, y2: 4 },
  );
  // A non-round-trippable record is rejected.
  expectEntityOpError(
    () => modifyEntities(docElements(), { op: "setGeometry", id: "l1", geom: { type: "circle", cx: 0, cy: 0, r: -1 } as never }),
    "bad_entity",
    /well-formed canonical record/,
  );
});

// --- Typed failures over the element world ------------------------------------------

test("modifyEntities typed failures: bad ids, annotations, BIM, bad factor, degenerate mirror axis", () => {
  expectEntityOpError(
    () => modifyEntities(docElements(), { op: "move", ids: ["el-999999"], dx: 1, dy: 1 }),
    "bad_id",
    /entity 'el-999999' does not exist/,
  );
  expectEntityOpError(
    () => modifyEntities(docElements(), { op: "move", ids: ["dim-1"], dx: 1, dy: 1 }),
    "bad_entity",
    /not part of the 2D drawing vocabulary/,
  );
  expectEntityOpError(
    () => modifyEntities(docElements(), { op: "move", ids: ["wall-1"], dx: 1, dy: 1 }),
    "bad_entity",
    /not part of the 2D drawing vocabulary/,
  );
  expectEntityOpError(
    () => modifyEntities(docElements(), { op: "scale", ids: ["l1"], base: { x: 0, y: 0 }, factor: 0 }),
    "bad_factor",
    /scale factor must be positive/,
  );
  expectEntityOpError(
    () => modifyEntities(docElements(), { op: "mirror", ids: ["l1"], p1: { x: 1, y: 1 }, p2: { x: 1, y: 1 }, eraseSource: true }),
    "degenerate",
    /two distinct points/,
  );
  expectEntityOpError(
    () => modifyEntities(docElements(), { op: "join", ids: ["l1"] }),
    "bad_input",
    /at least two entities/,
  );
});

test("modifyEntities: layer metadata is preserved on canonical write-back", () => {
  const doc = [geomEl("w1", { type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }, "ly-000002")];
  const o = modifyEntities(doc, { op: "move", ids: ["w1"], dx: 1, dy: 1 });
  assert.equal((expectOutcome(o, 1).edits[0] as { patch: Record<string, unknown> }).patch.layer, "ly-000002");
});

// --- Determinism ----------------------------------------------------------------------

test("determinism: the same op over the same elements produces deep-equal edits + summaries (double run)", () => {
  const ops: Parameters<typeof modifyEntities>[1][] = [
    { op: "move", ids: ["l1", "r1"], dx: 5, dy: 7 },
    { op: "rotate", ids: ["c1"], base: { x: 0, y: 0 }, angle: Math.PI / 3 },
    { op: "offset", items: [{ targetId: "l1", distance: 10, side: { x: 50, y: 10 }, through: false }] },
    { op: "trim", edges: ["c1"], trims: [{ targetId: "l1", pick: { x: 50, y: 0 } }] },
    { op: "explode", ids: ["r1"] },
  ];
  for (const op of ops) {
    const a = modifyEntities(docElements(), op);
    const b = modifyEntities(docElements(), op);
    assert.deepEqual(a, b, `modifyEntities is not deterministic for op '${(op as { op: string }).op}'`);
  }
  const ca = createEntities([], layerExists, [{ type: "point", layer: "0", x: 1, y: 2 }]);
  const cb = createEntities([], layerExists, [{ type: "point", layer: "0", x: 1, y: 2 }]);
  assert.deepEqual(ca, cb);
});
