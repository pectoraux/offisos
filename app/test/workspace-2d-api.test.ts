/**
 * CAD-PARITY-003 — App API end-to-end with the DummyAdapterBundle
 * (CP3-PORT-2b).
 *
 * Drives the real AppApiHandler: entity.create with the six new canonical
 * types (minted ids, canonical props, ONE revision per batch), the
 * entity.modify happy paths with exact resulting geometry, exact undo
 * restoration, the precision.snap/pick/window queries over the same shared
 * modules the renderers run (including hidden-layer filtering and double-run
 * determinism), and the typed bad-payload rejections.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import type { CADDocumentSnapshot, Element } from "../src/contracts/caddocument.js";
import type { CommandQueryResponse, OkResult } from "../src/contracts/app-api.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "cp3-e2e",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cad-parity-003-tests",
};

function make(): AppApiHandler {
  return AppApiHandler.create(CONFIG);
}

async function cmd(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "command", name: name as never, payload });
}
async function q(h: AppApiHandler, name: string, payload: unknown): Promise<CommandQueryResponse> {
  return h.handle({ type: "query", name: name as never, payload });
}
function val<T>(r: CommandQueryResponse): T {
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r).slice(0, 300)}`);
  return (r as OkResult).value as T;
}
function errCode(r: CommandQueryResponse): string {
  assert.equal(r.ok, false);
  return (r as { code: string }).code;
}

async function state(h: AppApiHandler): Promise<CADDocumentSnapshot> {
  return val<CADDocumentSnapshot>(await q(h, "document.getState", {}));
}

async function elementById(h: AppApiHandler, id: string): Promise<Element> {
  const s = await state(h);
  const found = s.elements.find((e) => e.id === id);
  assert.ok(found !== undefined, `element ${id} should exist`);
  return found;
}

const propsOf = (e: Element): Record<string, unknown> => e.props as Record<string, unknown>;

const lineCoords = (p: Record<string, unknown>): Record<string, number> =>
  ({ x1: p.x1 as number, y1: p.y1 as number, x2: p.x2 as number, y2: p.y2 as number });

// --- entity.create: the six new types --------------------------------------------

test("entity.create: all six new types in ONE batch — minted ids, canonical props, one revision", async () => {
  const h = make();
  const before = (await state(h)).version.version_number;
  assert.equal(before, 1, "documents start at the root revision");

  const r = val<{ applied: boolean; created: string[]; summary: string }>(await cmd(h, "entity.create", {
    entities: [
      { type: "ellipse", layer: "0", cx: 0, cy: 0, rx: 100, ry: 50, rotation: 0 },
      { type: "spline", layer: "0", controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 0 }], degree: 3 },
      { type: "point", layer: "0", x: 5, y: 5 },
      { type: "ray", layer: "0", x1: 0, y1: 0, x2: 10, y2: 10 },
      { type: "xline", layer: "0", x1: 0, y1: 0, x2: 0, y2: 1 },
      { type: "region", layer: "0", boundary: { kind: "circle", cx: 3, cy: 4, r: 5 }, area: 25 * Math.PI, perimeter: 10 * Math.PI, centroid: { x: 3, y: 4 } },
    ],
  }));
  assert.equal(r.applied, true);
  assert.deepEqual(r.created, ["el-000001", "el-000002", "el-000003", "el-000004", "el-000005", "el-000006"],
    "one atomic batch mints consecutive canonical ids");
  assert.equal(r.summary, "6 entities created");

  const after = await state(h);
  assert.equal(after.version.version_number, before + 1, "ONE revision per batch (one undo entry)");
  assert.equal(after.elements.length, 6);

  assert.deepEqual(propsOf(await elementById(h, "el-000001")), {
    drafting: true, layer: "0", type: "ellipse", cx: 0, cy: 0, rx: 100, ry: 50, rotation: 0,
  }, "the snapshot stores canonical flat props");
  assert.deepEqual(propsOf(await elementById(h, "el-000003")), {
    drafting: true, layer: "0", type: "point", x: 5, y: 5,
  });
  const region = propsOf(await elementById(h, "el-000006"));
  assert.equal(region.type, "region");
  assert.ok(Math.abs((region.area as number) - 25 * Math.PI) <= 1e-9);
  assert.ok(Math.abs((region.perimeter as number) - 10 * Math.PI) <= 1e-9);
  assert.deepEqual(region.centroid, { x: 3, y: 4 });

  // Forged/malformed creates are typed rejections that leave the document untouched.
  const versionBeforeBad = (await state(h)).version.version_number;
  assert.equal(errCode(await cmd(h, "entity.create", {
    entities: [{ type: "region", layer: "0", boundary: { kind: "circle", cx: 0, cy: 0, r: 5 }, area: 999, perimeter: 31.41592653589793, centroid: { x: 0, y: 0 } }],
  })), "bad_entity", "forged region derived properties are rejected");
  assert.equal(errCode(await cmd(h, "entity.create", {})), "bad_payload", "missing entities array");
  assert.equal(errCode(await cmd(h, "entity.create", { entities: [{ type: "ellipse", layer: "0", cx: 0, cy: 0, rx: 0, ry: 5, rotation: 0 }] })), "bad_entity");
  assert.equal((await state(h)).version.version_number, versionBeforeBad, "failed creates bump nothing");
});

test("entity.create: same command sequence on two handlers → identical content hash (determinism)", async () => {
  const run = async (): Promise<string> => {
    const h = make();
    val(await cmd(h, "entity.create", { entities: [{ type: "spline", layer: "0", controlPoints: [{ x: 0, y: 0 }, { x: 5, y: 9 }], degree: 1 }] }));
    val(await cmd(h, "entity.modify", { op: "rotate", ids: ["el-000001"], base: { x: 0, y: 0 }, angle: Math.PI / 2 }));
    return h.currentContentHash();
  };
  assert.equal(await run(), await run());
});

// --- entity.modify happy paths -----------------------------------------------------

test("entity.modify: rotate/scale/mirror/offset with exact resulting geometry", async () => {
  const h = make();
  val(await cmd(h, "entity.create", { entities: [
    { type: "ellipse", layer: "0", cx: 0, cy: 0, rx: 100, ry: 50, rotation: 0 }, // el-000001
    { type: "circle", layer: "0", cx: 50, cy: 0, r: 20 },                        // el-000002
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 },                  // el-000003
  ] }));

  // rotate the ellipse by 90°: rotation becomes π/2 exactly.
  val(await cmd(h, "entity.modify", { op: "rotate", ids: ["el-000001"], base: { x: 0, y: 0 }, angle: Math.PI / 2 }));
  const rot = propsOf(await elementById(h, "el-000001"));
  assert.ok(Math.abs((rot.rotation as number) - Math.PI / 2) <= 1e-12);
  assert.equal((await state(h)).version.version_number, 3, "one revision per modify command");

  // scale the circle ×2 about its center: r 20 → 40.
  val(await cmd(h, "entity.modify", { op: "scale", ids: ["el-000002"], base: { x: 50, y: 0 }, factor: 2 }));
  const scaled = propsOf(await elementById(h, "el-000002"));
  assert.deepEqual({ cx: scaled.cx, cy: scaled.cy, r: scaled.r }, { cx: 50, cy: 0, r: 40 });

  // mirror the line across the y-axis, erasing the source.
  val(await cmd(h, "entity.modify", { op: "mirror", ids: ["el-000003"], p1: { x: 0, y: 0 }, p2: { x: 0, y: 10 }, eraseSource: true }));
  assert.deepEqual(lineCoords(propsOf(await elementById(h, "el-000003"))), { x1: 0, y1: 0, x2: -100, y2: 0 });

  // offset the scaled circle outward by 10: r 40 → 50 as a NEW entity.
  const offset = val<{ created: number; summary: string }>(await cmd(h, "entity.modify", {
    op: "offset", items: [{ targetId: "el-000002", distance: 10, side: { x: 0, y: 60 }, through: false }],
  }));
  assert.equal(offset.created, 1);
  const offsetEl = propsOf(await elementById(h, "el-000004"));
  assert.deepEqual({ cx: offsetEl.cx, cy: offsetEl.cy, r: offsetEl.r }, { cx: 50, cy: 0, r: 50 });
});

test("entity.modify: trim/extend/fillet/break/join/explode happy paths", async () => {
  const h = make();
  val(await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 },    // el-000001 target
    { type: "circle", layer: "0", cx: 50, cy: 0, r: 20 },          // el-000002 cutting edge
  ] }));

  // trim: remove the piece nearest the pick (10,0) → line becomes (30,0)-(100,0).
  val(await cmd(h, "entity.modify", { op: "trim", edges: ["el-000002"], trims: [{ targetId: "el-000001", pick: { x: 10, y: 0 } }] }));
  assert.deepEqual(lineCoords(propsOf(await elementById(h, "el-000001"))), { x1: 30, y1: 0, x2: 100, y2: 0 });

  // extend: boundary wall at x=150 grows the line to exactly (150,0).
  val(await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 150, y1: -50, x2: 150, y2: 50 }] })); // el-000003
  val(await cmd(h, "entity.modify", { op: "extend", boundaries: ["el-000003"], targets: [{ targetId: "el-000001", pick: { x: 100, y: 0 } }] }));
  assert.deepEqual(lineCoords(propsOf(await elementById(h, "el-000001"))), { x1: 30, y1: 0, x2: 150, y2: 0 });

  // fillet: perpendicular corner with r=15 → trimmed lines + a new arc entity.
  val(await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 200, y1: 0, x2: 300, y2: 0 },   // el-000004
    { type: "line", layer: "0", x1: 200, y1: -50, x2: 200, y2: 50 }, // el-000005
  ] }));
  const fillet = val<{ summary: string }>(await cmd(h, "entity.modify", {
    op: "fillet", mode: "pair", radius: 15,
    firstId: "el-000004", firstPick: { x: 250, y: 0 }, secondId: "el-000005", secondPick: { x: 200, y: 50 },
  }));
  assert.equal(fillet.summary, "fillet radius 15 applied");
  const arc = propsOf(await elementById(h, "el-000006"));
  assert.ok(Math.abs((arc.cx as number) - 215) <= 1e-9 && Math.abs((arc.cy as number) - 15) <= 1e-9 && Math.abs((arc.r as number) - 15) <= 1e-9);

  // break: remove [30,60] from a fresh line → two pieces.
  val(await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 100, x2: 100, y2: 100 }] })); // el-000007
  const broken = val<{ summary: string; created: number }>(await cmd(h, "entity.modify", {
    op: "break", targetId: "el-000007", p1: { x: 30, y: 100 }, p2: { x: 60, y: 100 },
  }));
  assert.equal(broken.summary, "broken into 2 pieces");
  assert.deepEqual(lineCoords(propsOf(await elementById(h, "el-000007"))), { x1: 0, y1: 100, x2: 30, y2: 100 });
  assert.deepEqual(lineCoords(propsOf(await elementById(h, "el-000008"))), { x1: 60, y1: 100, x2: 100, y2: 100 });

  // join: two collinear TOUCHING lines become one; the second source is removed.
  val(await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 200, x2: 30, y2: 200 },  // el-000009
    { type: "line", layer: "0", x1: 30, y1: 200, x2: 100, y2: 200 }, // el-000010
  ] }));
  const joined = val<{ summary: string; removed: number }>(await cmd(h, "entity.modify", { op: "join", ids: ["el-000009", "el-000010"] }));
  assert.equal(joined.summary, "joined into one line");
  assert.equal(joined.removed, 1);
  const j = propsOf(await elementById(h, "el-000009"));
  assert.deepEqual({ x1: j.x1, y1: j.y1, x2: j.x2, y2: j.y2 }, { x1: 0, y1: 200, x2: 100, y2: 200 });
  assert.equal((await state(h)).elements.some((e) => e.id === "el-000010"), false);

  // join: collinear lines with a GAP are a typed join_failed — the API never
  // fabricates the missing span (Architect review).
  const gapPair = val<{ created: string[] }>(await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 250, x2: 30, y2: 250 },
    { type: "line", layer: "0", x1: 50, y1: 250, x2: 100, y2: 250 },
  ] }));
  const gapRes = await cmd(h, "entity.modify", { op: "join", ids: gapPair.created });
  assert.equal(errCode(gapRes), "join_failed", "disconnected collinear lines are a typed join_failed");
  assert.match((gapRes as { message: string }).message, /gap/i, "the failure names the gap");

  // explode: a closed canonical polyline becomes its four segments.
  const rectCreate = val<{ created: string[] }>(await cmd(h, "entity.create", { entities: [
    { type: "polyline", layer: "0", vertices: [{ x: 0, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 350 }, { x: 0, y: 350 }], closed: true },
  ] }));
  const rectId = rectCreate.created[0]!;
  const beforeExplode = (await state(h)).elements;
  const exploded = val<{ summary: string; created: number; removed: number }>(await cmd(h, "entity.modify", { op: "explode", ids: [rectId] }));
  assert.equal(exploded.summary, "1 entity exploded");
  // Counts are edit-derived: 4 segments created, 1 polyline removed.
  assert.equal(exploded.created, 4);
  assert.equal(exploded.removed, 1);
  const afterExplode = await state(h);
  assert.equal(afterExplode.elements.some((e) => e.id === rectId), false, "the polyline is gone");
  assert.equal(afterExplode.elements.length, beforeExplode.length + 3, "4 segments in, 1 polyline out");
  const beforeIds = new Set(beforeExplode.map((e) => e.id));
  const fresh = afterExplode.elements.filter((e) => !beforeIds.has(e.id));
  const segOf = (e: Element): [number, number, number, number] => {
    const p = e.props as { x1: number; y1: number; x2: number; y2: number };
    return [p.x1, p.y1, p.x2, p.y2];
  };
  const byFirst = (a: readonly number[], b: readonly number[]): number => (a[0]! - b[0]!) || (a[1]! - b[1]!);
  assert.deepEqual(
    fresh.map(segOf).sort(byFirst),
    ([[0, 300, 100, 300], [0, 350, 0, 300], [100, 300, 100, 350], [100, 350, 0, 350]] as const)
      .map((s) => [...s] as [number, number, number, number])
      .sort(byFirst),
    "exactly the four rectangle edges, walking the closed vertex ring",
  );

  // stretch (direct API form): only the endpoint inside the window moves.
  const st = val<{ created: string[] }>(await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 400, x2: 100, y2: 400 }] }));
  const stretchId = st.created[0]!;
  val(await cmd(h, "entity.modify", { op: "stretch", ids: [stretchId], winMin: { x: 50, y: 390 }, winMax: { x: 150, y: 410 }, dx: 0, dy: 20 }));
  assert.deepEqual(lineCoords(propsOf(await elementById(h, stretchId))), { x1: 0, y1: 400, x2: 100, y2: 420 });
});

test("entity.modify: undo restores the previous snapshot EXACTLY (deep-equal elements)", async () => {
  const h = make();
  val(await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 },
    { type: "circle", layer: "0", cx: 50, cy: 0, r: 20 },
  ] }));
  const before = (await state(h)).elements;

  val(await cmd(h, "entity.modify", { op: "trim", edges: ["el-000002"], trims: [{ targetId: "el-000001", pick: { x: 50, y: 0 } }] }));
  const after = (await state(h)).elements;
  assert.equal(after.length, 3, "the middle-pick trim split the line into two");
  assert.notDeepEqual(after, before);

  const undo = val<{ snapshot: CADDocumentSnapshot }>(await cmd(h, "document.undo", {}));
  assert.deepEqual(undo.snapshot.elements, before, "one undo restores the pre-command elements exactly");
  assert.equal(undo.snapshot.version.version_number, 2);
});

test("entity.modify typed failures surface stable error codes", async () => {
  const h = make();
  val(await cmd(h, "entity.create", { entities: [{ type: "line", layer: "0", x1: 0, y1: 0, x2: 10, y2: 0 }] }));
  assert.equal(errCode(await cmd(h, "entity.modify", { op: "move", ids: ["el-999999"], dx: 1, dy: 1 })), "bad_id");
  assert.equal(errCode(await cmd(h, "entity.modify", { op: "scale", ids: ["el-000001"], base: { x: 0, y: 0 }, factor: -1 })), "bad_factor");
  assert.equal(errCode(await cmd(h, "entity.modify", {})), "bad_payload");
  // Unknown ops are rejected deterministically (the entity-ops dispatch is
  // exhaustive; a forged op string falls through and is caught + typed).
  const unknown1 = await cmd(h, "entity.modify", { op: "frobnicate", ids: [] });
  const unknown2 = await cmd(h, "entity.modify", { op: "frobnicate", ids: [] });
  assert.equal(unknown1.ok, false);
  assert.equal(unknown2.ok, false);
  assert.deepEqual(unknown1, unknown2, "the forged-op rejection is deterministic");
});

// --- precision queries ---------------------------------------------------------------

async function precisionScene(h: AppApiHandler): Promise<void> {
  val(await cmd(h, "entity.create", { entities: [
    { type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 },     // el-000001 (long: crosses the test window)
    { type: "line", layer: "0", x1: 50, y1: -5, x2: 50, y2: 5 },     // el-000002 (short: fully inside the test window)
    { type: "circle", layer: "0", cx: 200, cy: 0, r: 30 },           // el-000003
    { type: "point", layer: "0", x: 45, y: 3 },                      // el-000004 (inside the test window)
  ] }));
}

test("precision.snap: exact snap point + mode over the known scene", async () => {
  const h = make();
  await precisionScene(h);

  // endpoint of el-000001 near (0.4, -0.2)
  const endpoint = val<{ point: { x: number; y: number }; mode: string | null; entityId: string | null }>(await q(h, "precision.snap", {
    cursor: [0.4, -0.2],
    settings: { osnapModes: ["endpoint"] },
  }));
  assert.equal(endpoint.mode, "endpoint");
  assert.deepEqual(endpoint.point, { x: 0, y: 0 });
  assert.equal(endpoint.entityId, "el-000001");

  // intersection of the two lines at (50,0) beats the endpoints
  const inter = val<{ point: { x: number; y: number }; mode: string | null; otherEntityId?: string }>(await q(h, "precision.snap", {
    cursor: [50, 0],
    settings: { osnapModes: ["endpoint", "midpoint", "intersection"] },
  }));
  assert.equal(inter.mode, "intersection");
  assert.deepEqual(inter.point, { x: 50, y: 0 });
  assert.equal(inter.otherEntityId, "el-000002");

  // node: the point entity
  const node = val<{ mode: string | null; point: { x: number; y: number } }>(await q(h, "precision.snap", {
    cursor: [45.4, 3.3],
    settings: { osnapModes: ["node"] },
  }));
  assert.equal(node.mode, "node");
  assert.deepEqual(node.point, { x: 45, y: 3 });

  // center of the circle
  const center = val<{ mode: string | null; point: { x: number; y: number } }>(await q(h, "precision.snap", {
    cursor: [200.5, 0.4],
    settings: { osnapModes: ["center"] },
  }));
  assert.equal(center.mode, "center");
  assert.deepEqual(center.point, { x: 200, y: 0 });

  // no modes → raw cursor passes through
  const raw = val<{ mode: string | null; point: { x: number; y: number } }>(await q(h, "precision.snap", {
    cursor: [33, 33],
    settings: { osnapModes: [] },
  }));
  assert.equal(raw.mode, null);
  assert.deepEqual(raw.point, { x: 33, y: 33 });
});

test("precision.pick: deterministic id + type under the cursor", async () => {
  const h = make();
  await precisionScene(h);
  const line = val<{ id: string | null; type?: string }>(await q(h, "precision.pick", { cursor: [25, 1], aperture: 5 }));
  assert.deepEqual(line, { id: "el-000001", type: "line", layer: "0" });
  const circle = val<{ id: string | null; type?: string }>(await q(h, "precision.pick", { cursor: [230, 0], aperture: 5 }));
  assert.equal(circle.id, "el-000003");
  const none = val<{ id: string | null }>(await q(h, "precision.pick", { cursor: [500, 500], aperture: 5 }));
  assert.equal(none.id, null);
});

test("precision.window: window vs crossing ids; determinism double-run", async () => {
  const h = make();
  await precisionScene(h);
  // Window fully containing the vertical line and the point, crossing the
  // horizontal line's right part, outside the circle.
  const win = val<{ ids: string[] }>(await q(h, "precision.window", { mode: "window", min: [40, -10], max: [60, 10] }));
  assert.deepEqual(win.ids, ["el-000002", "el-000004"], "the horizontal line crosses the border → NOT selected");
  const crossing = val<{ ids: string[] }>(await q(h, "precision.window", { mode: "crossing", min: [40, -10], max: [60, 10] }));
  assert.deepEqual(crossing.ids, ["el-000001", "el-000002", "el-000004"]);

  // Determinism: every query run twice deep-equals.
  for (const payload of [
    { mode: "window", min: [40, -10], max: [60, 10] },
    { mode: "crossing", min: [40, -10], max: [60, 10] },
    { mode: "crossing", min: [-100, -100], max: [300, 100] },
  ] as const) {
    assert.deepEqual(await q(h, "precision.window", payload), await q(h, "precision.window", payload));
  }
  assert.deepEqual(
    await q(h, "precision.snap", { cursor: [50, 0], settings: { osnapModes: ["endpoint", "intersection"] } }),
    await q(h, "precision.snap", { cursor: [50, 0], settings: { osnapModes: ["endpoint", "intersection"] } }),
  );
  assert.deepEqual(await q(h, "precision.pick", { cursor: [25, 1] }), await q(h, "precision.pick", { cursor: [25, 1] }));
});

test("precision queries: hidden layers are neither pickable nor snappable", async () => {
  const h = make();
  await precisionScene(h);
  const layer = val<{ layerId: string }>(await cmd(h, "drafting.addLayer", { name: "hidden-2d" }));
  assert.equal(layer.layerId, "ly-000001");
  val(await cmd(h, "drafting.updateLayer", { layerId: layer.layerId, patch: { visible: false } }));
  val(await cmd(h, "entity.create", { entities: [{ type: "point", layer: layer.layerId, x: 25, y: 0 }] })); // el-000005 (hidden)

  // Not picked (the visible line 1 unit away is):
  const pick = val<{ id: string | null }>(await q(h, "precision.pick", { cursor: [25, 0.2], aperture: 5 }));
  assert.equal(pick.id, "el-000001", "the hidden point loses to the visible line");

  // Not snapped even in node-only mode at its exact position:
  const snap = val<{ mode: string | null; point: { x: number; y: number } }>(await q(h, "precision.snap", {
    cursor: [25, 0],
    settings: { osnapModes: ["node"] },
  }));
  assert.equal(snap.mode, null);
  assert.deepEqual(snap.point, { x: 25, y: 0 });

  // Not selected by a window that contains it:
  const win = val<{ ids: string[] }>(await q(h, "precision.window", { mode: "window", min: [20, -5], max: [30, 5] }));
  assert.deepEqual(win.ids, [], "the hidden point is not selectable");
});

test("precision queries: bad payloads are typed rejections", async () => {
  const h = make();
  assert.equal(errCode(await q(h, "precision.snap", {})), "bad_payload");
  assert.equal(errCode(await q(h, "precision.snap", { cursor: [1] })), "bad_payload");
  assert.equal(errCode(await q(h, "precision.snap", { cursor: ["a", "b"] })), "bad_payload");
  assert.equal(errCode(await q(h, "precision.pick", {})), "bad_payload");
  assert.equal(errCode(await q(h, "precision.pick", { cursor: [0, 0, 0] })), "bad_payload");
  assert.equal(errCode(await q(h, "precision.window", { mode: "circle", min: [0, 0], max: [1, 1] })), "bad_payload");
  assert.equal(errCode(await q(h, "precision.window", { mode: "window", min: [0, 0] })), "bad_payload");
  // Unknown osnap modes are dropped (not fatal):
  const snap = val<{ mode: string | null }>(await q(h, "precision.snap", { cursor: [0, 0], settings: { osnapModes: ["endpoint", "frobnicate"] } }));
  assert.equal(snap.mode, null);
});
