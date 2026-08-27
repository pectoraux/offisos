import test from "node:test";
import assert from "node:assert/strict";
import { resolveAssociation } from "../src/drafting/associative.js";
import type { DraftEntity } from "../src/drafting/entities.js";

const lineA: DraftEntity = { id: "L1", type: "line", layer: "0", from: [0, 0], to: [3000, 0] };
const lineB: DraftEntity = { id: "L2", type: "line", layer: "0", from: [0, 1000], to: [4000, 1000] };
const circle: DraftEntity = { id: "C1", type: "circle", layer: "0", center: [500, 500], radius: 250 };

test("linear association resolves from canonical entity identities", () => {
  const result = resolveAssociation({
    id: "AD1",
    kind: "linear",
    unit: "mm",
    refs: [
      { entityId: "L1", anchor: "start" },
      { entityId: "L1", anchor: "end" },
    ],
  }, [lineA]);
  assert.equal(result.status, "resolved");
  assert.equal(result.value, 3000);
});

test("associative result changes when referenced geometry changes", () => {
  const association = {
    id: "AD1",
    kind: "linear" as const,
    unit: "mm" as const,
    refs: [
      { entityId: "L1", anchor: "start" as const },
      { entityId: "L1", anchor: "end" as const },
    ],
  };
  const before = resolveAssociation(association, [lineA]);
  const after = resolveAssociation(association, [{ ...lineA, to: [3500, 0] }]);
  assert.equal(before.value, 3000);
  assert.equal(after.value, 3500);
});

test("missing references are dangling and never silently retargeted", () => {
  const result = resolveAssociation({
    id: "AD2",
    kind: "linear",
    unit: "mm",
    refs: [
      { entityId: "L1", anchor: "start" },
      { entityId: "MISSING", anchor: "end" },
    ],
  }, [lineA, lineB]);
  assert.equal(result.status, "dangling");
  assert.equal(result.value, null);
  assert.match(result.message, /MISSING/);
});

test("radius association resolves a circle from its canonical id", () => {
  const result = resolveAssociation({
    id: "RD1",
    kind: "radius",
    unit: "mm",
    refs: [{ entityId: "C1", anchor: "center" }],
  }, [circle]);
  assert.equal(result.status, "resolved");
  assert.equal(result.value, 250);
});
