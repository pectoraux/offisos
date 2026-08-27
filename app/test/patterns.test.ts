import test from "node:test";
import assert from "node:assert/strict";
import { instancePositions, linearArray, makeSymbolDefinition, makeSymbolInstance, mirrorPoint, validatePattern } from "../src/drafting/patterns.js";
import type { DraftEntity } from "../src/drafting/entities.js";

const sample: DraftEntity = { id: "L1", type: "line", layer: "0", from: [0, 0], to: [10, 0] };

test("symbol definitions enforce stable non-empty identity and unique entity ids", () => {
  const def = makeSymbolDefinition("blk-door", "Door", [sample]);
  assert.equal(def.id, "blk-door");
  assert.equal(def.entities.length, 1);
  assert.throws(() => makeSymbolDefinition("", "Door", [sample]));
  assert.throws(() => makeSymbolDefinition("blk", "Door", [sample, sample]));
});

test("symbol instances preserve canonical definition relationship", () => {
  const inst = makeSymbolInstance("blk-door-1", "blk-door", [100, 200], Math.PI / 2, 2);
  assert.deepEqual(instancePositions(inst), [[100, 200]]);
  assert.deepEqual(instancePositions(inst, { count: 3, dx: 500, dy: 0 }), [[100, 200], [600, 200], [1100, 200]]);
});

test("linear arrays are deterministic and preserve source at index zero", () => {
  assert.deepEqual(linearArray([10, 20], { count: 4, dx: 25, dy: 5 }), [[10, 20], [35, 25], [60, 30], [85, 35]]);
  assert.deepEqual(validatePattern({ count: 1, dx: 0, dy: 0 }), { count: 1, dx: 0, dy: 0 });
  assert.throws(() => validatePattern({ count: 0, dx: 1, dy: 1 }));
  assert.throws(() => validatePattern({ count: 2.5, dx: 1, dy: 1 }));
});

test("mirror is exact for horizontal and vertical construction axes", () => {
  assert.deepEqual(mirrorPoint([4, 3], "x", 10), [4, 17]);
  assert.deepEqual(mirrorPoint([4, 3], "y", 10), [16, 3]);
});
