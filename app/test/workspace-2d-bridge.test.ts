/**
 * CAD-PARITY-003 — the geometry bridge (CP3-PORT-2b).
 *
 * Both storage conventions must decode to the SAME canonical Geom view:
 *  - the COMPAT-CAD-001 drafting vocabulary ({drafting, type, layer, from/to |
 *    points | center/radius | corner1/corner2}), and
 *  - the CAD-PARITY-003 flat canonical vocabulary (geometry/types.ts).
 * plus propsFromGeom round-trips and LOCK-007 null decoding for elements
 * outside the 2D vocabulary (annotations, BIM entities, malformed props).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  geomFromElement,
  isCanonicalEntity,
  isDraftingGeometry,
  isRectangleElement,
  layerOfElement,
  propsFromGeom,
} from "../src/workspace/geometry/bridge.js";
import type { Element } from "../src/contracts/caddocument.js";
import type { Geom } from "../src/workspace/geometry/types.js";

function el(props: Record<string, unknown>, kind: Element["kind"] = "geometry"): Element {
  return { id: "el-000001", kind, engineId: null, props };
}

// --- line: both conventions → identical canonical geometry -------------------

test("bridge: legacy line {from,to} and flat line {x1..y2} decode to the identical LineGeom", () => {
  const legacy = geomFromElement(el({ drafting: true, type: "line", layer: "0", from: [10, 20], to: [30, 40] }));
  const flat = geomFromElement(el({ drafting: true, type: "line", layer: "0", x1: 10, y1: 20, x2: 30, y2: 40 }));
  assert.deepEqual(legacy, { type: "line", x1: 10, y1: 20, x2: 30, y2: 40 });
  assert.deepEqual(legacy, flat, "both conventions produce ONE canonical view");
});

test("bridge: canonical flat fields win when both conventions are present", () => {
  const g = geomFromElement(el({
    drafting: true, type: "line", layer: "0",
    from: [0, 0], to: [1, 1], // legacy fields present but ignored
    x1: 5, y1: 6, x2: 7, y2: 8,
  }));
  assert.deepEqual(g, { type: "line", x1: 5, y1: 6, x2: 7, y2: 8 });
});

// --- polyline / circle / arc -------------------------------------------------

test("bridge: legacy polyline {points,closed} ↔ flat {vertices,closed}", () => {
  const legacy = geomFromElement(el({ drafting: true, type: "polyline", layer: "0", points: [[0, 0], [10, 0], [10, 10]], closed: true }));
  const flat = geomFromElement(el({
    drafting: true, type: "polyline", layer: "0",
    vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true,
  }));
  assert.deepEqual(legacy, {
    type: "polyline",
    vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    closed: true,
  });
  assert.deepEqual(legacy, flat);
});

test("bridge: legacy circle {center,radius} ↔ flat {cx,cy,r}", () => {
  const legacy = geomFromElement(el({ drafting: true, type: "circle", layer: "0", center: [5, -3], radius: 12 }));
  const flat = geomFromElement(el({ drafting: true, type: "circle", layer: "0", cx: 5, cy: -3, r: 12 }));
  assert.deepEqual(legacy, { type: "circle", cx: 5, cy: -3, r: 12 });
  assert.deepEqual(legacy, flat);
});

test("bridge: legacy arc {center,radius,startAngle,endAngle} ↔ flat arc", () => {
  const legacy = geomFromElement(el({ drafting: true, type: "arc", layer: "0", center: [0, 0], radius: 8, startAngle: 0.5, endAngle: 2.1 }));
  const flat = geomFromElement(el({ drafting: true, type: "arc", layer: "0", cx: 0, cy: 0, r: 8, startAngle: 0.5, endAngle: 2.1 }));
  assert.deepEqual(legacy, { type: "arc", cx: 0, cy: 0, r: 8, startAngle: 0.5, endAngle: 2.1 });
  assert.deepEqual(legacy, flat);
});

// --- rectangle materialization ----------------------------------------------

test("bridge: rectangle {corner1,corner2} materializes as a closed 4-vertex polyline", () => {
  const g = geomFromElement(el({ drafting: true, type: "rectangle", layer: "0", corner1: [10, 10], corner2: [30, 20] }));
  assert.deepEqual(g, {
    type: "polyline",
    vertices: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 20 }, { x: 10, y: 20 }],
    closed: true,
  });
});

test("bridge: rectangle corners in reverse order still walk a closed rectangle", () => {
  const g = geomFromElement(el({ drafting: true, type: "rectangle", layer: "0", corner1: [30, 20], corner2: [10, 10] }));
  assert.deepEqual(g, {
    type: "polyline",
    vertices: [{ x: 30, y: 20 }, { x: 10, y: 20 }, { x: 10, y: 10 }, { x: 30, y: 10 }],
    closed: true,
  });
  // Same world rectangle as the canonical orientation (as a point set).
  const a = geomFromElement(el({ drafting: true, type: "rectangle", layer: "0", corner1: [10, 10], corner2: [30, 20] })) as {
    vertices: readonly { x: number; y: number }[];
  };
  assert.deepEqual(
    [...(g as { vertices: { x: number; y: number }[] }).vertices].sort((p, q) => p.x - q.x || p.y - q.y),
    [...a.vertices].sort((p, q) => p.x - q.x || p.y - q.y),
  );
});

// --- propsFromGeom round-trip -------------------------------------------------

test("bridge: propsFromGeom → geomFromElement round-trips every geometry type", () => {
  const samples: readonly Geom[] = [
    { type: "line", x1: 0, y1: 0, x2: 100, y2: 50 },
    { type: "polyline", vertices: [{ x: 0, y: 0 }, { x: 1, y: 2 }], closed: false },
    { type: "circle", cx: 3, cy: 4, r: 5 },
    { type: "arc", cx: 0, cy: 0, r: 10, startAngle: 0, endAngle: Math.PI / 2 },
    { type: "ellipse", cx: 0, cy: 0, rx: 100, ry: 50, rotation: 0.3 },
    { type: "spline", controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }], degree: 2 },
    { type: "point", x: 7, y: 9 },
    { type: "ray", x1: 0, y1: 0, x2: 10, y2: 10 },
    { type: "xline", x1: 0, y1: 0, x2: 0, y2: 1 },
    {
      type: "region",
      boundary: { kind: "circle", cx: 3, cy: 4, r: 5 },
      area: 25 * Math.PI,
      perimeter: 10 * Math.PI,
      centroid: { x: 3, y: 4 },
    },
  ];
  for (const g of samples) {
    const props = propsFromGeom(g);
    assert.equal(props.drafting, true, "the drafting marker is always written");
    assert.equal(props.type, g.type);
    const back = geomFromElement(el(props));
    assert.deepEqual(back, g, `round-trip failed for ${g.type}`);
  }
});

test("bridge: propsFromGeom carries the layer when given and omits it when not", () => {
  const withLayer = propsFromGeom({ type: "point", x: 1, y: 2 }, "ly-000007");
  assert.equal(withLayer.layer, "ly-000007");
  const without = propsFromGeom({ type: "point", x: 1, y: 2 });
  assert.equal("layer" in without, false, "no layer key when omitted (exactOptionalPropertyTypes semantics)");
});

// --- LOCK-007: null decoding outside the 2D vocabulary -----------------------

test("bridge: dimensions decode to null in both storages", () => {
  assert.equal(geomFromElement(el({ type: "dim-linear", p1: [0, 0], p2: [1, 0], measured: 1 }, "annotation")), null);
  // Even when (incorrectly) stored with kind "geometry" but no drafting marker:
  assert.equal(geomFromElement(el({ type: "dim-radius", target: "c1", measured: 5 })), null);
});

test("bridge: BIM entities decode to null", () => {
  assert.equal(
    geomFromElement(el({ bim: true, type: "bim.wall", storyId: "s", start: [0, 0], end: [5000, 0], width: 240, height: 3000 }, "bim")),
    null,
  );
});

test("bridge: malformed drafting props decode to null (no guessing)", () => {
  assert.equal(geomFromElement(el({ drafting: true, type: "line", from: "oops", to: [1, 2] })), null);
  assert.equal(geomFromElement(el({ drafting: true, type: "line", from: [0, 0] })), null, "missing to");
  assert.equal(geomFromElement(el({ drafting: true, type: "circle", center: [0, 0], radius: -5 })), null, "negative radius");
  assert.equal(geomFromElement(el({ drafting: true, type: "circle", center: [0, 0] })), null, "missing radius");
  assert.equal(geomFromElement(el({ drafting: true, type: "polyline", points: [] })), null, "empty points");
  assert.equal(geomFromElement(el({ drafting: true, type: "polyline", points: [[0, 0]] })), null, "single point");
  assert.equal(geomFromElement(el({ drafting: true, type: "rectangle", corner1: [0, 0] })), null, "missing corner2");
  assert.equal(geomFromElement(el({ drafting: true, type: "hyperbola" })), null, "unknown type");
  assert.equal(geomFromElement(el({ drafting: true, type: "ellipse", cx: 0, cy: 0, rx: 0, ry: 5, rotation: 0 })), null, "degenerate ellipse");
  assert.equal(geomFromElement(el({ type: "line", x1: 0, y1: 0, x2: 1, y2: 1 })), null, "no drafting marker → not drafting geometry");
});

// --- classification helpers ---------------------------------------------------

test("bridge: isDraftingGeometry / isCanonicalEntity / isRectangleElement", () => {
  const legacyLine = el({ drafting: true, type: "line", layer: "0", from: [0, 0], to: [1, 1] });
  const flatLine = el({ drafting: true, type: "line", layer: "0", x1: 0, y1: 0, x2: 1, y2: 1 });
  const rect = el({ drafting: true, type: "rectangle", layer: "0", corner1: [0, 0], corner2: [1, 1] });
  const dim = el({ type: "dim-linear", p1: [0, 0], p2: [1, 0] }, "annotation");
  const wall = el({ bim: true, type: "bim.wall" }, "bim");
  assert.equal(isDraftingGeometry(legacyLine), true);
  assert.equal(isDraftingGeometry(flatLine), true);
  assert.equal(isDraftingGeometry(rect), true);
  assert.equal(isDraftingGeometry(dim), false);
  assert.equal(isDraftingGeometry(wall), false);
  // Canonical = drafting + decodable through the flat convention: legacy
  // rectangles are NOT canonical-flat (they materialize instead).
  assert.equal(isCanonicalEntity(flatLine), true);
  assert.equal(isCanonicalEntity(legacyLine), false, "legacy vocabulary is bridged, not canonical-flat");
  assert.equal(isCanonicalEntity(rect), false);
  assert.equal(isCanonicalEntity(dim), false);
  assert.equal(isRectangleElement(rect), true);
  assert.equal(isRectangleElement(legacyLine), false);
});

test("bridge: layerOfElement defaults to '0' and reads the stored layer", () => {
  assert.equal(layerOfElement(el({ drafting: true, type: "line", from: [0, 0], to: [1, 1] })), "0");
  assert.equal(layerOfElement(el({ drafting: true, type: "line", layer: "ly-000002", from: [0, 0], to: [1, 1] })), "ly-000002");
  assert.equal(layerOfElement(el({ drafting: true, type: "line", layer: "", from: [0, 0], to: [1, 1] })), "0", "empty layer falls back to '0'");
});
