/**
 * CAD-PARITY-003 — command registry + prompt-engine flows (CP3-PORT-2b).
 *
 * Pins the 18 new commands (draw: ELLIPSE/SPLINE/POINT/RAY/XLINE/REGION;
 * modify: ROTATE/SCALE/MIRROR/OFFSET/TRIM/EXTEND/STRETCH/FILLET/CHAMFER/
 * BREAK/JOIN/EXPLODE): name + alias resolution with NO collisions in the
 * merged registry, and the deterministic CommandPlans emitted by driving
 * applyPromptEvent with typed input, picks and entityPoint events — including
 * option sub-prompts (OFFSET Through, FILLET Radius), chainKeep (RAY/XLINE),
 * the Enter-accepts-default semantics, and validate2dPick rejections.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
// Import order matters for the commands.ts ↔ commands-2d.ts module cycle:
// commands.js must initialize first (it spreads COMMANDS_2D at module scope).
import { WORKSPACE_COMMANDS, WORKSPACE_COMMAND_INDEX, commandById, resolveCommand } from "../src/workspace/commands.js";
import { COMMANDS_2D, PLINE_ALIAS } from "../src/workspace/commands-2d.js";
import { applyPromptEvent, effectiveStep, IDLE_PROMPT_STATE, runCommandScript, type CommandScriptStep } from "../src/workspace/prompt-engine.js";
import type { CommandContext, CommandPlan, EntityPick, PromptValue } from "../src/workspace/types.js";
import { defaultCommandContext } from "../src/workspace/types.js";

// --- Registry ------------------------------------------------------------------

test("COMMANDS_2D: exactly the 18 CAD-PARITY-003 commands with their aliases", () => {
  assert.deepEqual(
    COMMANDS_2D.map((c) => [c.id, c.name, [...c.aliases].sort()]),
    [
      ["ellipse", "ELLIPSE", ["EL"]],
      ["spline", "SPLINE", ["SPL"]],
      ["point", "POINT", ["PO"]],
      ["ray", "RAY", []],
      ["xline", "XLINE", ["XL"]],
      ["region", "REGION", ["REG"]],
      ["rotate", "ROTATE", ["RO"]],
      ["scale", "SCALE", ["SC"]],
      ["mirror", "MIRROR", ["MI"]],
      ["offset", "OFFSET", ["O"]],
      ["trim", "TRIM", ["TR"]],
      ["extend", "EXTEND", ["EX"]],
      ["stretch", "STRETCH", ["S"]],
      ["fillet", "FILLET", ["F"]],
      ["chamfer", "CHAMFER", ["CHA"]],
      ["break", "BREAK", ["BR"]],
      ["join", "JOIN", ["J"]],
      ["explode", "EXPLODE", ["X"]],
    ],
  );
});

test("every new command + alias resolves in the MERGED registry", () => {
  for (const c of COMMANDS_2D) {
    assert.equal(resolveCommand(c.name)?.id, c.id, `name ${c.name}`);
    for (const alias of c.aliases) {
      assert.equal(resolveCommand(alias)?.id, c.id, `alias ${alias}`);
    }
  }
  // PLINE stays a POLYLINE alias (work-order vocabulary, CAD-PARITY-002 base).
  assert.equal(PLINE_ALIAS.commandId, "polyline");
  assert.equal(resolveCommand("PLINE")?.id, "polyline");
});

test("the merged WORKSPACE_COMMAND_INDEX has NO duplicate keys (alias collision check)", () => {
  // Nine legacy commands legitimately repeat their own name as an alias
  // (REDO/NEW/SAVE/OSNAP/…), so count each command's DISTINCT tokens; if any
  // TWO commands shared a token, the Map would be smaller than that total.
  const totalKeys = WORKSPACE_COMMANDS.reduce((n, c) => n + new Set([c.name.toUpperCase(), ...c.aliases.map((a) => a.toUpperCase())]).size, 0);
  assert.equal(
    WORKSPACE_COMMAND_INDEX.size,
    totalKeys,
    "every name+alias token of every command is unique across the merged registry",
  );
  // Cross-command collision scan (redundant with the size check, but precise
  // about WHICH token would collide).
  const owner = new Map<string, string>();
  for (const c of WORKSPACE_COMMANDS) {
    for (const token of [c.name.toUpperCase(), ...c.aliases.map((a) => a.toUpperCase())]) {
      const prev = owner.get(token);
      if (prev !== undefined && prev !== c.id) {
        assert.fail(`registry token '${token}' claimed by both '${prev}' and '${c.id}'`);
      }
      owner.set(token, c.id);
    }
  }
  // Spot-check that the new aliases do not collide with the legacy surface:
  // each of these previously resolved to a DIFFERENT (or no) command.
  const expected: readonly [string, string][] = [
    ["EL", "ellipse"], ["SPL", "spline"], ["PO", "point"], ["XL", "xline"], ["REG", "region"],
    ["RO", "rotate"], ["SC", "scale"], ["MI", "mirror"], ["O", "offset"], ["TR", "trim"],
    ["EX", "extend"], ["S", "stretch"], ["F", "fillet"], ["CHA", "chamfer"], ["BR", "break"],
    ["J", "join"], ["X", "explode"],
    // Legacy tokens that must keep their original meaning:
    ["E", "erase"], ["M", "move"], ["C", "circle"], ["A", "arc"], ["L", "line"], ["ST", "story"],
    ["CH", "properties"], ["PL", "polyline"],
  ];
  for (const [token, id] of expected) {
    if (token === "") continue;
    assert.equal(resolveCommand(token)?.id, id, `token '${token}'`);
  }
  // New commands appear in the merged registry exactly once each.
  for (const c of COMMANDS_2D) {
    assert.equal(WORKSPACE_COMMANDS.filter((m) => m.id === c.id).length, 1);
  }
});

// --- Prompt-engine driving helpers ----------------------------------------------

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return defaultCommandContext(overrides);
}

interface Collected {
  readonly plans: readonly CommandPlan[];
  readonly lines: readonly string[];
  readonly finalState: ReturnType<typeof runCommandScript>["state"];
}

function run(steps: readonly CommandScriptStep[], context: CommandContext = ctx()): Collected {
  const plans: CommandPlan[] = [];
  const lines: string[] = [];
  const result = runCommandScript(steps, context, (plan) => {
    plans.push(plan);
    lines.push(...plan.echo);
  });
  return { plans, lines: [...lines, ...result.lines], finalState: result.state };
}

const flatLinePick = (id: string): EntityPick => ({
  id, kind: "geometry", props: { drafting: true, type: "line", layer: "0", x1: 0, y1: 0, x2: 100, y2: 0 },
});
const flatVerticalPick = (id: string): EntityPick => ({
  id, kind: "geometry", props: { drafting: true, type: "line", layer: "0", x1: 0, y1: -50, x2: 0, y2: 50 },
});
const legacyLinePick = (id: string): EntityPick => ({
  id, kind: "geometry", props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [100, 0] },
});
const circlePick = (id: string): EntityPick => ({
  id, kind: "geometry", props: { drafting: true, type: "circle", layer: "0", cx: 50, cy: 0, r: 20 },
});

// --- Draw command flows -----------------------------------------------------------

test("ELLIPSE flow: center → axis end → other end emits entity.create with rx/ry/rotation from perpendicular distance", () => {
  const { plans } = run([
    { event: { type: "typed", text: "EL" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "pick", point: [100, 0] } },
    { event: { type: "pick", point: [0, 50] } },
  ]);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [{
    name: "entity.create",
    payload: { entities: [{ type: "ellipse", layer: "0", cx: 0, cy: 0, rx: 100, ry: 50, rotation: 0 }] },
  }]);
});

test("SPLINE flow: control points until Enter; Close appends the first point and flags closed", () => {
  const open = run([
    { event: { type: "typed", text: "SPL" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "pick", point: [10, 20] } },
    { event: { type: "pick", point: [30, 20] } },
    { event: { type: "pick", point: [40, 0] } },
    { event: { type: "enter" } },
  ]);
  assert.deepEqual(open.plans[0]!.appApi, [{
    name: "entity.create",
    payload: {
      entities: [{
        type: "spline", layer: "0", degree: 3,
        controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 0 }],
      }],
    },
  }]);

  const closed = run([
    { event: { type: "typed", text: "SPLINE" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "pick", point: [10, 20] } },
    { event: { type: "pick", point: [30, 20] } },
    { event: { type: "typed", text: "C" } },
  ]);
  assert.deepEqual(closed.plans[0]!.appApi[0]!.payload, {
    entities: [{
      type: "spline", layer: "0", degree: 3,
      controlPoints: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 0, y: 0 }],
    }],
  });
  assert.match(closed.plans[0]!.echo[0]!, /closed/);
});

test("POINT and XLINE flows emit their canonical entity.create payloads", () => {
  const point = run([
    { event: { type: "typed", text: "PO" } },
    { event: { type: "pick", point: [7, 9] } },
  ]);
  assert.deepEqual(point.plans[0]!.appApi, [{
    name: "entity.create",
    payload: { entities: [{ type: "point", layer: "0", x: 7, y: 9 }] },
  }]);
  const xline = run([
    { event: { type: "typed", text: "XL" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "pick", point: [1, 1] } },
    { event: { type: "enter" } },
  ]);
  assert.deepEqual(xline.plans[0]!.appApi, [{
    name: "entity.create",
    payload: { entities: [{ type: "xline", layer: "0", x1: 0, y1: 0, x2: 1, y2: 1 }] },
  }]);
});

test("RAY chainKeep: the base point is kept across chained through picks", () => {
  const { plans, finalState } = run([
    { event: { type: "typed", text: "RAY" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "pick", point: [10, 10] } },
    { event: { type: "pick", point: [-10, 5] } },
    { event: { type: "enter" } },
  ]);
  assert.equal(plans.length, 2, "one plan per through point");
  assert.deepEqual(plans[0]!.appApi[0]!.payload, {
    entities: [{ type: "ray", layer: "0", x1: 0, y1: 0, x2: 10, y2: 10 }],
  });
  assert.deepEqual(plans[1]!.appApi[0]!.payload, {
    entities: [{ type: "ray", layer: "0", x1: 0, y1: 0, x2: -10, y2: 5 }],
  }, "the base point is retained (chainKeep)");
  assert.deepEqual(finalState.values, {}, "Enter finishes the chain");
  assert.match(plans[1]!.echo[0]!, /base \(0,0\)/);
});

test("REGION flow: closed profile picks become a region entity.create with recomputed properties", () => {
  const { plans } = run([
    { event: { type: "typed", text: "REG" } },
    { event: { type: "entity", entity: circlePick("c1") } },
    { event: { type: "enter" } },
  ]);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [{
    name: "entity.create",
    payload: {
      entities: [{
        type: "region", layer: "0",
        boundary: { kind: "circle", cx: 50, cy: 0, r: 20 },
        area: 400 * Math.PI,
        perimeter: 40 * Math.PI,
        centroid: { x: 50, y: 0 },
      }],
    },
  }]);
});

// --- Modify command flows -----------------------------------------------------------

test("ROTATE: picked base→cursor angle becomes the payload angle (90° → π/2)", () => {
  const { plans } = run([
    { event: { type: "typed", text: "RO" } },
    { event: { type: "entity", entity: flatLinePick("a") } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "pick", point: [0, 100] } },
  ]);
  assert.equal(plans.length, 1);
  const payload = plans[0]!.appApi[0]!.payload as { op: string; ids: string[]; base: { x: number; y: number }; angle: number };
  assert.equal(payload.op, "rotate");
  assert.deepEqual(payload.ids, ["a"]);
  assert.deepEqual(payload.base, { x: 0, y: 0 });
  assert.ok(Math.abs(payload.angle - Math.PI / 2) <= 1e-15, `angle: ${payload.angle}`);
  assert.match(plans[0]!.echo[0]!, /90°/);
});

test("ROTATE: typed 45 degrees converts to radians in the payload", () => {
  const { plans } = run([
    { event: { type: "typed", text: "ROTATE" } },
    { event: { type: "entity", entity: flatLinePick("a") } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "typed", text: "45" } },
  ]);
  const payload = plans[0]!.appApi[0]!.payload as { angle: number };
  assert.ok(Math.abs(payload.angle - Math.PI / 4) <= 1e-15);
});

test("SCALE: typed factor flows through; the builder rejects non-positive factors", () => {
  const ok = run([
    { event: { type: "typed", text: "SC" } },
    { event: { type: "entity", entity: flatLinePick("a") } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "typed", text: "2" } },
  ]);
  assert.deepEqual(ok.plans[0]!.appApi, [{
    name: "entity.modify",
    payload: { op: "scale", ids: ["a"], base: { x: 0, y: 0 }, factor: 2 },
  }]);
  const bad = run([
    { event: { type: "typed", text: "SC" } },
    { event: { type: "entity", entity: flatLinePick("a") } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "typed", text: "-2" } },
  ]);
  assert.equal(bad.plans.length, 0);
  assert.ok(bad.lines.some((l) => /positive factor/i.test(l)), "builder validation cancels with guidance");
});

test("MIRROR: Enter accepts the default N (source kept); typed Y erases the source", () => {
  const keep = run([
    { event: { type: "typed", text: "MI" } },
    { event: { type: "entity", entity: flatLinePick("a") } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "pick", point: [0, 10] } },
    { event: { type: "enter" } },
  ]);
  assert.deepEqual(keep.plans[0]!.appApi, [{
    name: "entity.modify",
    payload: { op: "mirror", ids: ["a"], p1: { x: 0, y: 0 }, p2: { x: 0, y: 10 }, eraseSource: false },
  }]);
  assert.match(keep.plans[0]!.echo[0]!, /source kept/);

  const erase = run([
    { event: { type: "typed", text: "MIRROR" } },
    { event: { type: "entity", entity: flatLinePick("a") } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "pick", point: [0, 10] } },
    { event: { type: "typed", text: "Y" } },
  ]);
  const payload = erase.plans[0]!.appApi[0]!.payload as { eraseSource: boolean };
  assert.equal(payload.eraseSource, true);
  assert.match(erase.plans[0]!.echo[0]!, /source erased/);
});

test("OFFSET: typed distance flow emits the offset item", () => {
  const { plans } = run([
    { event: { type: "typed", text: "O" } },
    { event: { type: "typed", text: "10" } },
    { event: { type: "entity", entity: flatLinePick("e1") } },
    { event: { type: "pick", point: [50, 20] } },
  ]);
  assert.deepEqual(plans[0]!.appApi, [{
    name: "entity.modify",
    payload: { op: "offset", items: [{ targetId: "e1", distance: 10, side: { x: 50, y: 20 }, through: false }] },
  }]);
});

test("OFFSET Through: T opens the option sub-prompt, a point is captured, the payload carries through=true", () => {
  let state = IDLE_PROMPT_STATE;
  const step = (event: CommandScriptStep["event"], note: string): ReturnType<typeof applyPromptEvent> => {
    const r = applyPromptEvent(state, event, ctx());
    state = r.state;
    void note;
    return r;
  };

  step({ type: "typed", text: "OFFSET" }, "start");
  const afterT = step({ type: "typed", text: "T" }, "type T");
  assert.ok(state.optionCapture !== null, "the option sub-prompt is active");
  assert.deepEqual(state.optionCapture, { stepId: "distance", keyword: "T", kind: "point", prompt: "Specify through point:" });
  assert.equal(afterT.output.prompt, "Specify through point:");
  assert.deepEqual(effectiveStep(state)!.id, "opt:distance:T");
  assert.match(afterT.output.lines[0]!, /T — Through point/);

  const afterPoint = step({ type: "pick", point: [50, 30] }, "capture the through point");
  assert.equal(state.optionCapture, null, "capture completes");
  assert.equal(afterPoint.output.prompt, "Specify offset distance or [Through]:", "flow returns to the distance step");
  assert.deepEqual(state.values["opt:distance:T"], { kind: "point", point: [50, 30] });

  // Back at the distance step: a (now ignored) number completes it, then the
  // object pick and the side point finish the command.
  step({ type: "typed", text: "5" }, "type 5");
  step({ type: "entity", entity: flatLinePick("e1") }, "pick object");
  const done = step({ type: "pick", point: [50, 30] }, "side point");
  assert.ok(done.output.plan !== null);
  assert.deepEqual(done.output.plan.appApi, [{
    name: "entity.modify",
    payload: { op: "offset", items: [{ targetId: "e1", distance: 5, side: { x: 50, y: 30 }, through: true }] },
  }]);
});

test("FILLET Radius: R opens the number sub-prompt; 15 flows into the payload; Enter accepts the default 0", () => {
  const with15 = run([
    { event: { type: "typed", text: "F" } },
    { event: { type: "typed", text: "R" } },
    { event: { type: "typed", text: "15" } },
    { event: { type: "entityPoint", entity: flatLinePick("a"), point: [50, 0] } },
    { event: { type: "entityPoint", entity: flatVerticalPick("b"), point: [0, 50] } },
  ]);
  assert.equal(with15.plans.length, 1);
  assert.deepEqual(with15.plans[0]!.appApi, [{
    name: "entity.modify",
    payload: {
      op: "fillet", mode: "pair", radius: 15,
      firstId: "a", firstPick: { x: 50, y: 0 }, secondId: "b", secondPick: { x: 0, y: 50 },
    },
  }]);
  assert.deepEqual(with15.plans[0]!.echo, ["FILLET: radius 15."]);

  const def = run([
    { event: { type: "typed", text: "FILLET" } },
    { event: { type: "typed", text: "R" } },
    { event: { type: "enter" } },
    { event: { type: "entityPoint", entity: flatLinePick("a"), point: [50, 0] } },
    { event: { type: "entityPoint", entity: flatVerticalPick("b"), point: [0, 50] } },
  ]);
  const payload = def.plans[0]!.appApi[0]!.payload as { radius: number };
  assert.equal(payload.radius, 0);
  assert.deepEqual(def.plans[0]!.echo, ["FILLET: sharp corner (radius 0)."]);
});

test("CHAMFER D1/D2 option captures feed the payload", () => {
  const { plans } = run([
    { event: { type: "typed", text: "CHA" } },
    { event: { type: "typed", text: "D1" } },
    { event: { type: "typed", text: "20" } },
    { event: { type: "typed", text: "D2" } },
    { event: { type: "typed", text: "5" } },
    { event: { type: "entityPoint", entity: flatLinePick("a"), point: [50, 0] } },
    { event: { type: "entityPoint", entity: flatVerticalPick("b"), point: [0, 50] } },
  ]);
  assert.deepEqual(plans[0]!.appApi, [{
    name: "entity.modify",
    payload: {
      op: "chamfer", mode: "pair", d1: 20, d2: 5,
      firstId: "a", firstPick: { x: 50, y: 0 }, secondId: "b", secondPick: { x: 0, y: 50 },
    },
  }]);
});

test("TRIM: Enter-with-preselection at the edges step; entityPoint targets collect; Enter completes the command", () => {
  const edge = circlePick("edge-1");
  const target = flatLinePick("tgt");
  const { plans, lines, finalState } = run(
    [
      { event: { type: "typed", text: "TRIM" } },
      { event: { type: "enter" } },
      { event: { type: "entityPoint", entity: target, point: [10, 0] } },
      { event: { type: "entityPoint", entity: target, point: [90, 0] } },
      { event: { type: "enter" } },
    ],
    ctx({ currentSelection: [edge] }),
  );
  // The preselection is consumed by the edges step:
  assert.ok(lines.includes("1 found (current selection)."));
  // Both target picks are collected with their pick points:
  assert.ok(lines.includes("1 found (tgt) at (10,0)"));
  assert.ok(lines.includes("1 found (tgt) at (90,0)"));
  // Enter on the optional multiple entityPoint step completes the command
  // with the exact semantic plan:
  assert.equal(plans.length, 1, "TRIM emits its plan on Enter");
  assert.deepEqual(plans[0]!.appApi, [{
    name: "entity.modify",
    payload: {
      op: "trim",
      edges: ["edge-1"],
      trims: [
        { targetId: "tgt", pick: { x: 10, y: 0 } },
        { targetId: "tgt", pick: { x: 90, y: 0 } },
      ],
    },
  }]);
  assert.equal(finalState.commandId, null, "the command completed back to idle");
});

test("TRIM builder: the collected values produce the exact trim payload", () => {
  const trim = commandById("trim");
  assert.ok(trim?.build !== undefined);
  const plan = trim!.build!({
    edges: { kind: "entities", entities: [circlePick("edge-1")] },
    targets: { kind: "entityPoints", picks: [{ entity: flatLinePick("tgt"), point: [10, 0] }] },
  } as unknown as Record<string, PromptValue>, ctx());
  assert.deepEqual(plan.appApi, [{
    name: "entity.modify",
    payload: {
      op: "trim",
      edges: ["edge-1"],
      trims: [{ targetId: "tgt", pick: { x: 10, y: 0 } }],
    },
  }]);
  assert.deepEqual(plan.echo, ["TRIM: 1 target(s) against 1 edge(s)."]);
});

test("EXTEND builder: boundaries + targets produce the exact extend payload", () => {
  const extend = commandById("extend");
  const plan = extend!.build!({
    boundaries: { kind: "entities", entities: [flatVerticalPick("b1")] },
    targets: { kind: "entityPoints", picks: [{ entity: flatLinePick("tgt"), point: [100, 0] }] },
  } as unknown as Record<string, PromptValue>, ctx());
  assert.deepEqual(plan.appApi, [{
    name: "entity.modify",
    payload: {
      op: "extend",
      boundaries: ["b1"],
      targets: [{ targetId: "tgt", pick: { x: 100, y: 0 } }],
    },
  }]);
});

test("EXTEND engine flow: boundary entity pick, entityPoint target, Enter completes", () => {
  const boundary = flatVerticalPick("b1");
  const target = flatLinePick("tgt");
  const { plans, lines, finalState } = run(
    [
      { event: { type: "typed", text: "EX" } },
      { event: { type: "entity", entity: boundary } },
      { event: { type: "enter" } },
      { event: { type: "entityPoint", entity: target, point: [100, 0] } },
      { event: { type: "enter" } },
    ],
  );
  assert.ok(lines.includes("1 found (b1)"), "the boundary pick is collected");
  assert.ok(lines.includes("1 found (tgt) at (100,0)"), "the target pick is collected with its point");
  // Enter on the optional multiple entityPoint step completes the command:
  assert.equal(plans.length, 1, "EXTEND emits its plan on Enter");
  assert.deepEqual(plans[0]!.appApi, [{
    name: "entity.modify",
    payload: {
      op: "extend",
      boundaries: ["b1"],
      targets: [{ targetId: "tgt", pick: { x: 100, y: 0 } }],
    },
  }]);
  assert.equal(finalState.commandId, null, "the command completed back to idle");
});

test("STRETCH: two corners + displacement emit normalized winMin/winMax", () => {
  const { plans } = run([
    { event: { type: "typed", text: "S" } },
    { event: { type: "pick", point: [150, 10] } },   // corner order deliberately reversed
    { event: { type: "pick", point: [50, -10] } },
    { event: { type: "pick", point: [0, 0] } },      // base
    { event: { type: "pick", point: [0, 20] } },     // displacement base→pick
  ]);
  assert.deepEqual(plans[0]!.appApi, [{
    name: "entity.modify",
    payload: { op: "stretch", winMin: { x: 50, y: -10 }, winMax: { x: 150, y: 10 }, dx: 0, dy: 20 },
  }]);
});

test("BREAK: entityPoint pick + second point emit the break payload with both points", () => {
  const { plans } = run([
    { event: { type: "typed", text: "BR" } },
    { event: { type: "entityPoint", entity: flatLinePick("t"), point: [30, 0] } },
    { event: { type: "pick", point: [60, 0] } },
  ]);
  assert.deepEqual(plans[0]!.appApi, [{
    name: "entity.modify",
    payload: { op: "break", targetId: "t", p1: { x: 30, y: 0 }, p2: { x: 60, y: 0 } },
  }]);
});

test("JOIN and EXPLODE: multi-pick + Enter emit their payloads", () => {
  const join = run([
    { event: { type: "typed", text: "J" } },
    { event: { type: "enter" } }, // Enter consumes the current (pre)selection
  ], ctx({ currentSelection: [flatLinePick("j1"), flatLinePick("j2")] }));
  assert.deepEqual(join.plans[0]!.appApi, [{
    name: "entity.modify",
    payload: { op: "join", ids: ["j1", "j2"] },
  }]);

  const explode = run([
    { event: { type: "typed", text: "X" } },
    { event: { type: "entity", entity: flatLinePick("x1") } },
    { event: { type: "enter" } },
  ]);
  assert.deepEqual(explode.plans[0]!.appApi, [{
    name: "entity.modify",
    payload: { op: "explode", ids: ["x1"] },
  }]);
});

// --- Pick validation ---------------------------------------------------------------

test("validate2dPick: BIM and annotation picks are rejected with actionable lines and NO state pollution", () => {
  const wall: EntityPick = { id: "w1", kind: "bim", props: { bim: true, type: "bim.wall", storyId: "s", start: [0, 0], end: [2, 0], width: 240, height: 3000 } };
  const dim: EntityPick = { id: "d1", kind: "annotation", props: { type: "dim-linear", p1: [0, 0], p2: [1, 0], measured: 1 } };
  let state = IDLE_PROMPT_STATE;
  state = applyPromptEvent(state, { type: "typed", text: "RO" }, ctx()).state;
  const before = JSON.stringify(state.values);
  const r1 = applyPromptEvent(state, { type: "entity", entity: wall }, ctx());
  assert.match(r1.output.lines[0]!, /BIM elements are authored through the BIM commands/);
  const r2 = applyPromptEvent(r1.state, { type: "entity", entity: dim }, ctx());
  assert.match(r2.output.lines[0]!, /Annotations are not part of the CAD-2D modify vocabulary/);
  assert.equal(JSON.stringify(r2.state.values), before, "rejected picks leave the collected values untouched");
  assert.equal(r2.state.commandId, "rotate", "the command keeps running");
  assert.equal(r2.output.prompt, "Select objects:");
});

test("MOVE: canonical entity picks route to entity.modify; legacy picks keep drafting.move", () => {
  const canonical = run([
    { event: { type: "typed", text: "M" } },
    { event: { type: "entity", entity: flatLinePick("k1") } },
    { event: { type: "enter" } },
    { event: { type: "typed", text: "500,250" } },
    { event: { type: "typed", text: "500,250" } },
  ]);
  assert.deepEqual(canonical.plans[0]!.appApi, [
    { name: "entity.modify", payload: { op: "move", ids: ["k1"], dx: 500, dy: 250 } },
  ]);

  const mixed = run([
    { event: { type: "typed", text: "MOVE" } },
    { event: { type: "enter" } },
    { event: { type: "typed", text: "0,0" } },
    { event: { type: "typed", text: "100,0" } },
  ], ctx({ currentSelection: [legacyLinePick("legacy-1"), flatLinePick("canon-1")] }));
  assert.equal(mixed.plans[0]!.appApi.length, 2, "the selection partitions into drafting.* and entity.modify");
  assert.deepEqual(mixed.plans[0]!.appApi[0], { name: "drafting.move", payload: { ids: ["legacy-1"], dx: 100, dy: 0 } });
  assert.deepEqual(mixed.plans[0]!.appApi[1], { name: "entity.modify", payload: { op: "move", ids: ["canon-1"], dx: 100, dy: 0 } });
});

// --- Determinism ----------------------------------------------------------------------

test("determinism: the same event script produces deep-equal plans and lines (double run)", () => {
  const steps: readonly CommandScriptStep[] = [
    { event: { type: "typed", text: "EL" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "pick", point: [100, 0] } },
    { event: { type: "pick", point: [0, 50] } },
    { event: { type: "typed", text: "F" } },
    { event: { type: "typed", text: "R" } },
    { event: { type: "typed", text: "15" } },
    { event: { type: "entityPoint", entity: flatLinePick("a"), point: [50, 0] } },
    { event: { type: "entityPoint", entity: flatVerticalPick("b"), point: [0, 50] } },
    { event: { type: "typed", text: "O" } },
    { event: { type: "typed", text: "10" } },
    { event: { type: "entity", entity: circlePick("c1") } },
    { event: { type: "pick", point: [50, 30] } },
    { event: { type: "typed", text: "S" } },
    { event: { type: "pick", point: [150, 10] } },
    { event: { type: "pick", point: [50, -10] } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "pick", point: [0, 20] } },
  ];
  const context = ctx();
  const a = run(steps, context);
  const b = run(steps, context);
  assert.deepEqual(a.plans, b.plans);
  assert.deepEqual(a.lines, b.lines);
  assert.deepEqual(a.finalState, b.finalState);
});
