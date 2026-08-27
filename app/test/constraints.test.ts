import test from "node:test";
import assert from "node:assert/strict";
import { makeConstraint, solveConstraints } from "../src/drafting/constraints.js";
import type { DraftEntity } from "../src/drafting/entities.js";

function line(id: string, from: [number, number], to: [number, number]): DraftEntity {
  return {
    id,
    type: "line",
    layer: "0",
    from,
    to,
  };
}

test("horizontal constraint is deterministic and reports residual", () => {
  const result = solveConstraints(
    [line("L1", [0, 0], [5, 0.000000001])],
    { tolerance: 1e-8, constraints: [makeConstraint({ id: "C1", kind: "horizontal", entityIds: ["L1"] })] },
  );
  assert.equal(result.diagnostics[0]?.status, "satisfied");
  assert.equal(result.diagnostics[0]?.residual, 1e-9);
  assert.equal(result.status, "under_constrained");
});

test("parallel and perpendicular are explicit line-pair constraints", () => {
  const parallel = solveConstraints(
    [line("L1", [0, 0], [2, 0]), line("L2", [0, 1], [4, 1])],
    { tolerance: 1e-12, constraints: [makeConstraint({ id: "P", kind: "parallel", entityIds: ["L1", "L2"] })] },
  );
  assert.equal(parallel.diagnostics[0]?.status, "satisfied");

  const perpendicular = solveConstraints(
    [line("L1", [0, 0], [2, 0]), line("L2", [0, 1], [0, 3])],
    { tolerance: 1e-12, constraints: [makeConstraint({ id: "Q", kind: "perpendicular", entityIds: ["L1", "L2"] })] },
  );
  assert.equal(perpendicular.diagnostics[0]?.status, "satisfied");
});

test("coincident point references use canonical entity ids", () => {
  const result = solveConstraints(
    [line("L1", [0, 0], [5, 0]), line("L2", [5, 0], [5, 3])],
    {
      tolerance: 1e-12,
      constraints: [makeConstraint({
        id: "C1",
        kind: "coincident",
        entityIds: ["L1", "L2"],
        points: [
          { entityId: "L1", point: "end" },
          { entityId: "L2", point: "start" },
        ],
      })],
    },
  );
  assert.equal(result.diagnostics[0]?.status, "satisfied");
  assert.equal(result.diagnostics[0]?.residual, 0);
});

test("equal and length constraints distinguish relation from target value", () => {
  const entities = [line("L1", [0, 0], [3, 0]), line("L2", [0, 1], [0, 4])];
  const result = solveConstraints(entities, {
    tolerance: 1e-12,
    constraints: [
      makeConstraint({ id: "E", kind: "equal", entityIds: ["L1", "L2"] }),
      makeConstraint({ id: "D", kind: "length", entityIds: ["L1"], value: 3 }),
    ],
  });
  assert.deepEqual(result.diagnostics.map((d) => d.status), ["satisfied", "satisfied"]);
});

test("contradictory orientation constraints are reported as over-constrained", () => {
  const result = solveConstraints(
    [line("L1", [0, 0], [5, 0])],
    {
      tolerance: 1e-12,
      constraints: [
        makeConstraint({ id: "H", kind: "horizontal", entityIds: ["L1"] }),
        makeConstraint({ id: "V", kind: "vertical", entityIds: ["L1"] }),
      ],
    },
  );
  assert.equal(result.status, "over_constrained");
});

test("tangent is explicitly unsupported for the bounded line-only solver", () => {
  const result = solveConstraints(
    [line("L1", [0, 0], [5, 0])],
    {
      tolerance: 1e-12,
      constraints: [makeConstraint({ id: "T", kind: "tangent", entityIds: ["L1", "missing-circle"] })],
    },
  );
  assert.equal(result.status, "unsatisfied");
  assert.equal(result.diagnostics[0]?.status, "invalid_reference");
});
