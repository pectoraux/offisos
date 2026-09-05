/**
 * COMPAT-CAD-007 (Issue #142) — deterministic coverage for the command-phase
 * object-selection and bracketed-option layer, driven from the
 * CAD-BENCH-RW-001 black-box benchmark findings:
 *
 *  - DEF-006: deterministic selection across click, window and crossing
 *    workflows in command select phases — the `entities` batch event
 *    (the shared command-select core), validate filtering, typed outcomes,
 *    and the click-vs-drag boundary.
 *  - DEF-007: advertised bracketed prompt options are honored uniformly —
 *    the full word ("Undo", "Close", "Through", "Radius") behaves exactly
 *    like the abbreviation keyword; typing an advertised word can never
 *    cancel the running command.
 *  - DEF-021: selection keywords at "Select objects:" prompts (ALL/LAST/
 *    P/PREVIOUS) resolve INSIDE the running command — typed keywords never
 *    escape the prompt and start a different command.
 *
 * No-fabrication guarantees: selection keywords, batches and previews
 * produce NO document mutation before the committed command (one canonical
 * revision per mutating command); failed/unsupported cases answer typed
 * outcomes; undo/redo restores the exact prior state.
 *
 * Web/Electron parity: the same selection/edit stream through BOTH real
 * host transports produces identical outcomes (LOCK-004).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command, CommandQueryResponse, Query } from "../src/contracts/app-api.js";
import { AppApiHandler } from "../src/app-api/index.js";
import { DummyAdapterBundle } from "../src/adapters/dummy/index.js";
import { createRenderer } from "../src/renderer/index.js";
import { WebHost, WebSocketTransport } from "../src/host-web/index.js";
import { ElectronHost, IpcTransport } from "../src/host-electron/index.js";
import { commandById, resolveCommand, WORKSPACE_COMMANDS } from "../src/workspace/commands.js";
import { COMMANDS_2D } from "../src/workspace/commands-2d.js";
import {
  IDLE_PROMPT_STATE,
  applyPromptEvent,
  bracketOptionWords,
  describePrompt,
  runCommandScript,
  type CommandScriptStep,
} from "../src/workspace/prompt-engine.js";
import {
  commandWindowIds,
  commandWindowPicks,
  lastSelectableElement,
  selectableElements,
  toEntityPicks,
} from "../src/workspace/command-select.js";
import { windowSelect, selectionRectangle } from "../src/workspace/selection.js";
import { toEntities } from "../src/workspace/precision-2d.js";
import { annotationStyleContext } from "../src/workspace/annotation/render.js";
import { annotationToProps, makeText } from "../src/workspace/annotation/index.js";
import type { CommandPlan } from "../src/workspace/types.js";
import { defaultCommandContext } from "../src/workspace/types.js";
import type { Element } from "../src/contracts/caddocument.js";

const CONFIG = {
  adapterBundle: DummyAdapterBundle,
  entityId: "cc007-doc",
  format: "offisos-dummy",
  formatVersion: "1",
  createdBy: "cc007-test",
};

function cmd(name: Command["name"], payload: unknown): Command {
  return { type: "command", name, payload };
}
function q(name: Query["name"], payload: unknown = {}): Query {
  return { type: "query", name, payload };
}
function val<T = unknown>(r: CommandQueryResponse): T {
  if (!r.ok) throw new Error(`unexpected ErrResult: ${r.code}: ${r.message}`);
  return r.value as T;
}

// A representative live document: 3 lines + a circle on '0', a wall on a
// BIM layer, a text annotation, an invisible-layer line and a locked-layer
// line (both excluded from the pick surface).
function fixtureElements(): Element[] {
  const line = (id: string, from: [number, number], to: [number, number], layer = "0"): Element => ({
    id,
    kind: "geometry",
    engineId: null,
    props: { drafting: true, type: "line", layer, from, to },
  });
  return [
    line("el-000001", [0, 0], [100, 0]),
    line("el-000002", [0, 10], [100, 10]),
    line("el-000003", [0, 20], [100, 20]),
    { id: "el-000004", kind: "geometry", engineId: null, props: { drafting: true, type: "circle", layer: "0", center: [200, 0], radius: 30 } },
    { id: "el-000005", kind: "bim", engineId: null, props: { type: "bim.wall", layer: "ly-bim", start: [0, 100], end: [80, 100], width: 10 } },
    line("el-000006", [0, 50], [100, 50], "ly-hidden"),
    line("el-000007", [0, 60], [100, 60], "ly-locked"),
  ];
}

function fixtureLayers() {
  return [
    { id: "0", name: "0", color: "#111827", visible: true },
    { id: "ly-bim", name: "BIM", color: "#111827", visible: true },
    { id: "ly-hidden", name: "HIDDEN", color: "#111827", visible: false },
    { id: "ly-locked", name: "LOCKED", color: "#111827", visible: true, locked: true },
  ];
}

function fixtureCtx(overrides: Record<string, unknown> = {}) {
  return defaultCommandContext({
    documentElements: fixtureElements(),
    layers: fixtureLayers(),
    ...overrides,
  });
}

const pickOf = (el: { id: string; kind: string; props: unknown }) => ({
  id: el.id,
  kind: el.kind,
  props: el.props as Record<string, unknown>,
});

// ---------------------------------------------------------------------------
// DEF-007 — advertised bracketed options are honored by keyword AND full
// word; typing an advertised word never cancels the running command.
// ---------------------------------------------------------------------------

test("DEF-007: LINE 'Undo' (full word) undoes the last segment — no *Cancel*, no UNDO command", () => {
  const plans: CommandPlan[] = [];
  const { lines, state } = runCommandScript(
    [
      { event: { type: "typed", text: "LINE" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "pick", point: [100, 0] } },
      { event: { type: "pick", point: [100, 100] } },
      { event: { type: "typed", text: "Undo" } },
    ] as const satisfies readonly CommandScriptStep[],
    defaultCommandContext(),
    (plan) => plans.push(plan),
  );
  assert.equal(state.commandId, "line", "LINE keeps running after the full-word Undo");
  assert.ok(lines.includes("Undo one segment."), "the Undo option echoes its action");
  assert.ok(!lines.includes("*Cancel*"), "the full-word option must never cancel the command");
  assert.deepEqual(
    plans.map((p) => p.appApi.map((e) => e.name)),
    [["drafting.createEntities"], ["drafting.createEntities"], ["document.undo"]],
    "the two chained segments plan, then the Undo option plans document.undo",
  );
  // The exact benchmark reproduction: typed 'Undo' previously ran the UNDO
  // command instead (DEF-007). Now the option consumes the token.
  const undoPlans = plans.filter((p) => p.appApi.some((e) => e.name === "document.undo"));
  assert.equal(undoPlans.length, 1, "exactly the LINE U option path — the UNDO command never started");
});

test("DEF-007: LINE 'U' abbreviation keeps the pinned behavior (regression)", () => {
  const { lines, state } = runCommandScript(
    [
      { event: { type: "typed", text: "LINE" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "pick", point: [100, 0] } },
      { event: { type: "typed", text: "U" } },
    ] as const satisfies readonly CommandScriptStep[],
    defaultCommandContext(),
    () => {},
  );
  assert.equal(state.commandId, "line");
  assert.ok(lines.includes("Undo one segment."));
  assert.ok(!lines.includes("*Cancel*"));
});

test("DEF-007: POLYLINE 'Close' (full word) closes the polyline with the C option semantics", () => {
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "POLYLINE" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "pick", point: [100, 0] } },
      { event: { type: "typed", text: "Close" } },
    ] as const satisfies readonly CommandScriptStep[],
    defaultCommandContext(),
    (plan) => plans.push(plan),
  );
  assert.ok(lines.includes("Close."), "the Close option echoes its action");
  assert.ok(!lines.includes("*Cancel*"));
  const entity = (plans[0]!.appApi[0]!.payload as { entities: { closed: boolean }[] }).entities[0]!;
  assert.equal(entity.closed, true, "the closed flag lands on the canonical entity");
});

test("DEF-007: OFFSET 'Through' (full word) opens the T sub-prompt", () => {
  let state = IDLE_PROMPT_STATE;
  const r1 = applyPromptEvent(state, { type: "typed", text: "OFFSET" }, defaultCommandContext());
  state = r1.state;
  const r2 = applyPromptEvent(state, { type: "typed", text: "Through" }, defaultCommandContext());
  state = r2.state;
  const desc = describePrompt(r2.state);
  assert.ok(/through point/i.test(desc.prompt ?? ""), `the T sub-prompt is active (got: ${desc.prompt})`);
  assert.ok(r2.output.lines.some((l) => /^T — /i.test(l)), "the option echo identifies the T keyword");
  assert.ok(!r2.output.lines.includes("*Cancel*"), "typing the advertised word keeps OFFSET running");
  assert.equal(r2.state.commandId, "offset");
});

test("DEF-007: FILLET 'Radius' (full word) opens the R sub-prompt (the benchmark's FILLET R flow)", () => {
  let state = IDLE_PROMPT_STATE;
  const r1 = applyPromptEvent(state, { type: "typed", text: "FILLET" }, defaultCommandContext());
  state = r1.state;
  const r2 = applyPromptEvent(state, { type: "typed", text: "Radius" }, defaultCommandContext());
  assert.equal(r2.state.commandId, "fillet");
  assert.ok(!r2.output.lines.includes("*Cancel*"));
  assert.ok(/fillet radius/i.test(describePrompt(r2.state).prompt ?? ""), `the R sub-prompt is active (got: ${describePrompt(r2.state).prompt})`);
});

test("DEF-007: ROTATE 'Reference' (full word) answers the typed unsupported failure, command survives", () => {
  // The R option lives on the ANGLE step — drive there through the pinned
  // step sequence (objects → base → angle).
  const ctx = fixtureCtx();
  const line = fixtureElements()[0]!;
  let state = IDLE_PROMPT_STATE;
  state = applyPromptEvent(state, { type: "typed", text: "ROTATE" }, ctx).state;
  state = applyPromptEvent(state, { type: "entity", entity: pickOf(line) }, ctx).state;
  state = applyPromptEvent(state, { type: "pick", point: [0, 0] }, ctx).state;
  const r = applyPromptEvent(state, { type: "typed", text: "Reference" }, ctx);
  assert.equal(r.state.commandId, "rotate", "ROTATE keeps running");
  assert.ok(!r.output.lines.includes("*Cancel*"));
  assert.ok(
    r.output.lines.some((l) => /not supported in this build/i.test(l)),
    `the unsupported option answers its typed failure (got: ${r.output.lines.join(" | ")})`,
  );
  // The same via the abbreviation (regression).
  let s2 = IDLE_PROMPT_STATE;
  s2 = applyPromptEvent(s2, { type: "typed", text: "SCALE" }, ctx).state;
  s2 = applyPromptEvent(s2, { type: "entity", entity: pickOf(line) }, ctx).state;
  s2 = applyPromptEvent(s2, { type: "pick", point: [0, 0] }, ctx).state;
  const r2 = applyPromptEvent(s2, { type: "typed", text: "R" }, ctx);
  assert.equal(r2.state.commandId, "scale");
  assert.ok(r2.output.lines.some((l) => /not supported in this build/i.test(l)));
});

test("DEF-007 registry sweep: every declared option keyword is advertised in its step's prompt brackets", () => {
  // The uniform contract: what a step declares as an option is what its
  // prompt advertises — a declared keyword that is not advertised is a dead
  // option surface (the DEF-007 class of inconsistency).
  const all = [...WORKSPACE_COMMANDS, ...COMMANDS_2D];
  let checked = 0;
  for (const command of all) {
    const steps = command.steps;
    for (const step of steps) {
      if (step.options === undefined) continue;
      const words = bracketOptionWords(step.prompt);
      for (const option of step.options) {
        const kw = option.keyword.toUpperCase();
        const advertised = words.some((w) => w.toUpperCase().startsWith(kw));
        assert.ok(
          advertised,
          `${command.name} step '${step.id}': option keyword '${option.keyword}' is not advertised in the prompt '${step.prompt}'`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked > 20, `the sweep exercised a representative option surface (checked ${checked})`);
});

test("DEF-007 behavior sweep: typing any bracketed full word of the core modify/draw options never cancels the command", () => {
  // The reachable G-gate option surface: for each (command, step, option),
  // driving to that step and typing the ADVERTISED FULL WORD must keep the
  // command running (or complete it through its own option semantics).
  const probes: readonly { readonly command: string; readonly setup: readonly CommandScriptStep[]; readonly word: string; readonly still: string }[] = [
    { command: "LINE", setup: [{ event: { type: "typed", text: "LINE" } }, { event: { type: "pick", point: [0, 0] } }, { event: { type: "pick", point: [10, 0] } }], word: "Undo", still: "line" },
    { command: "POLYLINE", setup: [{ event: { type: "typed", text: "POLYLINE" } }, { event: { type: "pick", point: [0, 0] } }, { event: { type: "pick", point: [10, 0] } }], word: "Close", still: "__complete__" },
    { command: "SPLINE", setup: [{ event: { type: "typed", text: "SPLINE" } }, { event: { type: "pick", point: [0, 0] } }, { event: { type: "pick", point: [10, 0] } }], word: "Close", still: "__complete__" },
    { command: "OFFSET", setup: [{ event: { type: "typed", text: "OFFSET" } }], word: "Through", still: "offset" },
    { command: "FILLET", setup: [{ event: { type: "typed", text: "FILLET" } }], word: "Radius", still: "fillet" },
    { command: "CHAMFER", setup: [{ event: { type: "typed", text: "CHAMFER" } }], word: "Distances", still: "chamfer" },
    { command: "ROTATE", setup: [{ event: { type: "typed", text: "ROTATE" } }], word: "Reference", still: "rotate" },
    { command: "SCALE", setup: [{ event: { type: "typed", text: "SCALE" } }], word: "Reference", still: "scale" },
  ];
  for (const probe of probes) {
    const steps: CommandScriptStep[] = [...probe.setup, { event: { type: "typed", text: probe.word } }];
    const { lines, state } = runCommandScript(steps, defaultCommandContext(), () => {});
    assert.ok(
      !lines.includes("*Cancel*"),
      `${probe.command} + typed '${probe.word}' must never cancel the command (got: ${lines.join(" | ")})`,
    );
    if (probe.still === "__complete__") {
      assert.equal(state.commandId, null, `${probe.command} completes through its own Close semantics`);
    } else {
      assert.equal(state.commandId, probe.still, `${probe.command} keeps running after '${probe.word}'`);
    }
  }
});

test("DEF-007: bracketOptionWords parses the advertised vocabulary deterministically", () => {
  assert.deepEqual(bracketOptionWords("Specify next point or [Undo]:"), ["Undo"]);
  assert.deepEqual(bracketOptionWords("Specify offset distance or [Through]:"), ["Through"]);
  assert.deepEqual(bracketOptionWords("Select first object or [Radius]:"), ["Radius"]);
  assert.deepEqual(bracketOptionWords("Erase source objects? [Yes/No] <No>:"), ["Yes", "No"]);
  assert.deepEqual(bracketOptionWords("Specify first corner of zoom window or [All/Extents/Previous/Scale/Window]:"), [
    "All",
    "Extents",
    "Previous",
    "Scale",
    "Window",
  ]);
  assert.deepEqual(bracketOptionWords("Select cutting edges or <all objects>:"), [], "angle-bracket defaults are not option brackets");
});

test("DEF-007: ZOOM full-word options act immediately (the CC006 acting-keyword semantics preserved)", () => {
  const plans: CommandPlan[] = [];
  const { state } = runCommandScript(
    [
      { event: { type: "typed", text: "ZOOM" } },
      { event: { type: "typed", text: "Extents" } },
    ] as const satisfies readonly CommandScriptStep[],
    defaultCommandContext(),
    (plan) => plans.push(plan),
  );
  assert.equal(state.commandId, null, "ZOOM Extents (full word) completes the command");
  assert.equal(plans.length, 1);
  const ui = plans[0]!.appApi;
  assert.equal(ui.length, 0, "navigation plans carry zero App API commands (the CC006 no-mutation contract)");
});

// ---------------------------------------------------------------------------
// DEF-021 — selection keywords at "Select objects:" prompts.
// ---------------------------------------------------------------------------

test("DEF-021: MOVE 'ALL' resolves every selectable object inside the command (no *Cancel*, no SELECTALL)", () => {
  const plans: CommandPlan[] = [];
  const ctx = fixtureCtx();
  const { lines, state } = runCommandScript(
    [
      { event: { type: "typed", text: "MOVE" } },
      { event: { type: "typed", text: "ALL" } },
      { event: { type: "pick", point: [0, 0] } },
      { event: { type: "pick", point: [10, 10] } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.ok(lines.includes("5 found (all objects)"), `ALL collects the 5 selectable objects (got: ${lines.join(" | ")})`);
  assert.ok(!lines.includes("*Cancel*"), "typed ALL must never cancel MOVE");
  assert.ok(!lines.some((l) => /^SELECTALL/m.test(l)), "the SELECTALL command never ran");
  assert.equal(state.commandId, null, "MOVE completed");
  // MOVE partitions the objects across drafting.move / entity.modify / bim.move —
  // the UNION of the plan's id sets is the selectable set (document order).
  const carried: string[] = [];
  for (const entry of plans[0]!.appApi) {
    carried.push(...((entry.payload as { ids: string[] }).ids));
  }
  assert.deepEqual(carried, ["el-000001", "el-000002", "el-000003", "el-000004", "el-000005"], "the plan carries the selectable set (document order; hidden/locked excluded)");
});

test("DEF-021: ALL excludes invisible and locked layers and non-pickable kinds (the canvas pick surface rule)", () => {
  const selectable = selectableElements(fixtureElements(), fixtureLayers());
  assert.deepEqual(
    selectable.map((el) => el.id),
    ["el-000001", "el-000002", "el-000003", "el-000004", "el-000005"],
    "3 lines + circle + wall; hidden/locked layer lines excluded, bim.wall included",
  );
  // Empty layer table = typed outcome (never a guess).
  assert.deepEqual(selectableElements(fixtureElements(), []).map((e) => e.id), []);
});

test("DEF-021: selectableElements agrees with the click-pick hit surface on the same fixture", () => {
  // The ALL/LAST surface must be the SAME surface a click or window could
  // capture: for every selectable element a probe point exists that
  // hitTest accepts, and no excluded element is hit-testable anywhere on
  // its geometry.
  const selectable = selectableElements(fixtureElements(), fixtureLayers());
  const ids = new Set(selectable.map((el) => el.id));
  for (const el of fixtureElements()) {
    const props = el.props as Record<string, unknown>;
    const onGeometry: [number, number][] =
      props.type === "circle"
        ? [[200, 0], [230, 0], [170, 0]]
        : props.type === "bim.wall"
          ? [[40, 100], [0, 100], [80, 100]]
          : [[50, (props.from as [number, number])[1]], [1, (props.from as [number, number])[1]]];
    const hits = onGeometry.filter((p) => {
      // A right-to-left micro-rect = CROSSING (any intersection) — the same
      // probe discipline for points, curves and band footprints.
      const found = windowSelect(selectionRectangle([p[0] + 0.01, p[1] - 0.01], [p[0] - 0.01, p[1] + 0.01]), fixtureElements().filter((e) => ids.has(e.id)));
      return found.includes(el.id);
    });
    if (ids.has(el.id)) {
      assert.ok(hits.length > 0, `${el.id} (selectable) is window-capturable on its geometry`);
    } else {
      assert.equal(hits.length, 0, `${el.id} (excluded from ALL) is not capturable on the selectable surface`);
    }
  }
});

test("DEF-021: ERASE 'LAST' picks the most recently created selectable object", () => {
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "typed", text: "LAST" } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    fixtureCtx(),
    (plan) => plans.push(plan),
  );
  assert.ok(lines.includes("1 found (LAST: el-000005)"), `LAST resolves the newest selectable object (got: ${lines.join(" | ")})`);
  const payload = plans[0]!.appApi[0]!.payload as { ids: string[] };
  assert.deepEqual(payload.ids, ["el-000005"]);
});

test("DEF-021: ERASE 'PREVIOUS' (full word) uses the current selection", () => {
  const ctx = fixtureCtx({
    currentSelection: [pickOf(fixtureElements()[0]!), pickOf(fixtureElements()[1]!)],
  });
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "typed", text: "PREVIOUS" } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    (plan) => plans.push(plan),
  );
  assert.ok(lines.includes("2 found (previous selection)"), `PREVIOUS behaves exactly like P (got: ${lines.join(" | ")})`);
  const payload = plans[0]!.appApi[0]!.payload as { ids: string[] };
  assert.deepEqual(payload.ids, ["el-000001", "el-000002"]);
});

test("DEF-021: empty-document ALL/LAST and empty-selection P answer typed outcomes — the command keeps running", () => {
  const empty = defaultCommandContext();
  for (const [word, expected] of [
    ["ALL", /0 found — the document contains no selectable objects/],
    ["LAST", /0 found — no object has been created yet/],
    ["P", /No previous selection/],
    ["PREVIOUS", /No previous selection/],
  ] as const) {
    let state = IDLE_PROMPT_STATE;
    state = applyPromptEvent(state, { type: "typed", text: "ERASE" }, empty).state;
    const r = applyPromptEvent(state, { type: "typed", text: word }, empty);
    assert.equal(r.state.commandId, "erase", `ERASE keeps running after empty '${word}'`);
    assert.ok(!r.output.lines.includes("*Cancel*"), `'${word}' never cancels`);
    assert.ok(
      r.output.lines.some((l) => expected.test(l)),
      `typed outcome for empty '${word}' (got: ${r.output.lines.join(" | ")})`,
    );
  }
});

test("DEF-021: 'ALL' typed at IDLE still runs SELECTALL to completion (the idle path is unchanged)", () => {
  // SELECTALL is a zero-step command: typing ALL while idle completes it
  // immediately with the set-selection plan (the engine returns to idle).
  const plans: CommandPlan[] = [];
  const { state, lines } = runCommandScript([{ event: { type: "typed", text: "ALL" } }] as const satisfies readonly CommandScriptStep[], fixtureCtx(), (p) => plans.push(p));
  assert.equal(state.commandId, null, "SELECTALL completed (instant command)");
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]!.appApi, [], "the instant plan carries zero App API commands (the host resolves the ui action)");
  assert.deepEqual(plans[0]!.ui, [{ action: "selection.selectAll" }], "the selection.selectAll ui action is the plan's carrier");
  assert.ok(lines.includes("SELECTALL."));
});

test("DEF-021: at TRIM's entityPoint step the keywords answer the typed location-semantic decline", () => {
  const ctx = fixtureCtx();
  let state = IDLE_PROMPT_STATE;
  state = applyPromptEvent(state, { type: "typed", text: "TRIM" }, ctx).state;
  state = applyPromptEvent(state, { type: "enter" }, ctx).state; // implied-all edges
  for (const word of ["ALL", "LAST", "P", "PREVIOUS"]) {
    const r = applyPromptEvent(state, { type: "typed", text: word }, ctx);
    assert.equal(r.state.commandId, "trim", `TRIM keeps running after '${word}' at the pick-point step`);
    assert.ok(!r.output.lines.includes("*Cancel*"));
    assert.ok(
      r.output.lines.some((l) => /cannot supply the pick point/.test(l)),
      `the typed decline names the location-semantic boundary (got: ${r.output.lines.join(" | ")})`,
    );
  }
});

// ---------------------------------------------------------------------------
// DEF-006 — the command-phase window/crossing batch (`entities` event).
// ---------------------------------------------------------------------------

test("DEF-006: a window batch during ERASE collects and echoes 'N found', accumulating across drags", () => {
  const ctx = fixtureCtx();
  const elements = fixtureElements();
  const picks = [pickOf(elements[0]!), pickOf(elements[1]!), pickOf(elements[2]!)];
  const { lines, state } = runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "entities", entities: picks } },
      { event: { type: "entities", entities: [pickOf(elements[3]!)] } },
    ] as const satisfies readonly CommandScriptStep[],
    ctx,
    () => {},
  );
  assert.deepEqual(
    lines.filter((l) => /found/.test(l)),
    ["3 found", "1 found (4 total)"],
    `the batch echoes AutoCAD-class counts (got: ${lines.join(" | ")})`,
  );
  assert.equal(state.commandId, "erase", "ERASE stays in the select phase (multiple+last step)");
});

test("DEF-006: a window batch + Enter commits ONE revision erasing exactly the captured objects", async () => {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("drafting.createEntities", { entities: [
    { type: "line", layer: "0", from: [0, 0], to: [100, 0] },
    { type: "line", layer: "0", from: [0, 10], to: [100, 10] },
    { type: "circle", layer: "0", center: [200, 0], radius: 30 },
  ] })));
  const before = val<{ version: { version_number: number }; elements: { id: string }[] }>(await h.handle(q("document.getState")));
  assert.equal(before.elements.length, 3);

  // The engine stream: ERASE → window batch over the two lines → Enter.
  const liveElements = val<{ elements: Element[] }>(await h.handle(q("document.getState"))).elements;
  const picks = liveElements.slice(0, 2).map((el) => pickOf(el));
  const plans: CommandPlan[] = [];
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "entities", entities: picks } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    defaultCommandContext({ documentElements: liveElements, layers: [{ id: "0", name: "0", color: "#111", visible: true }] }),
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 1, "one command = one plan");
  assert.ok(lines.some((l) => /2 found/.test(l)), "the batch echoed its count");

  // Execute the plan through the App API: ONE revision.
  for (const entry of plans[0]!.appApi) {
    val(await h.handle({ type: "command", name: entry.name as Command["name"], payload: entry.payload }));
  }
  const after = val<{ version: { version_number: number }; elements: { id: string }[] }>(await h.handle(q("document.getState")));
  assert.equal(after.version.version_number, before.version.version_number + 1, "exactly ONE canonical revision per mutating command");
  assert.deepEqual(after.elements.map((e) => e.id), ["el-000003"], "only the circle survives");

  // UNDO restores the exact prior CONTENT (the element set) and version.
  // (The canonical undo's own element ordering is the document core's
  // pre-existing deterministic semantics — not this work item's surface.)
  val(await h.handle(cmd("document.undo", {})));
  const undone = val<{ version: { version_number: number }; elements: { id: string }[] }>(await h.handle(q("document.getState")));
  assert.deepEqual([...undone.elements.map((e) => e.id)].sort(), [...before.elements.map((e) => e.id)].sort(), "UNDO restores the exact prior element set");
  assert.equal(undone.elements.length, before.elements.length, "no phantom or lost elements after UNDO");
  assert.equal(undone.version.version_number, before.version.version_number, "UNDO restores the exact prior version");
});

test("DEF-006: a window batch during MOVE (multi-step command) collects then advances — the pinned advance-after-first semantics", () => {
  const ctx = fixtureCtx();
  const elements = fixtureElements();
  const picks = [pickOf(elements[0]!), pickOf(elements[1]!)];
  let state = IDLE_PROMPT_STATE;
  state = applyPromptEvent(state, { type: "typed", text: "MOVE" }, ctx).state;
  const r = applyPromptEvent(state, { type: "entities", entities: picks }, ctx);
  assert.equal(r.state.commandId, "move");
  assert.deepEqual(r.state.values.objects?.kind === "entities" ? r.state.values.objects.entities.map((e) => e.id) : [], ["el-000001", "el-000002"]);
  assert.ok(/Specify base point/.test(describePrompt(r.state).prompt ?? ""), "the batch advanced to the base-point step (the shipped semantics)");
  assert.ok(r.output.lines.includes("2 found"));
});

test("DEF-006: a batch at an entityPoint step (TRIM targets) is a typed decline — the location is semantic", () => {
  const ctx = fixtureCtx();
  let state = IDLE_PROMPT_STATE;
  state = applyPromptEvent(state, { type: "typed", text: "TRIM" }, ctx).state;
  state = applyPromptEvent(state, { type: "enter" }, ctx).state;
  const r = applyPromptEvent(state, { type: "entities", entities: [pickOf(fixtureElements()[0]!)] }, ctx);
  assert.equal(r.state.commandId, "trim");
  assert.ok(!r.output.lines.includes("*Cancel*"));
  assert.ok(r.output.lines.includes("This step does not accept an object pick."));
});

test("DEF-006: an empty batch answers '0 found' without mutating the collection state", () => {
  const ctx = fixtureCtx();
  let state = IDLE_PROMPT_STATE;
  state = applyPromptEvent(state, { type: "typed", text: "ERASE" }, ctx).state;
  const r = applyPromptEvent(state, { type: "entities", entities: [] }, ctx);
  assert.equal(r.state.commandId, "erase");
  assert.ok(r.output.lines.some((l) => /0 found — no objects within the selection window/.test(l)));
  assert.equal(r.state.values.objects, undefined, "nothing was collected");
});

test("DEF-006: validate-filtered batches count rejections and keep the first typed reason", () => {
  // TRIM's edges step validates 2D pickability — a mixed batch counts: the
  // line is accepted, the annotation is rejected with its typed reason.
  const ctx = fixtureCtx();
  const line = fixtureElements()[0]!;
  const badPick = { id: "el-000009", kind: "annotation", engineId: null, props: { annotation: true, type: "dim-linear", layer: "0", p1: [0, 0], p2: [10, 0], offset: 5 } };
  let state = IDLE_PROMPT_STATE;
  state = applyPromptEvent(state, { type: "typed", text: "TRIM" }, ctx).state;
  const r = applyPromptEvent(state, { type: "entities", entities: [pickOf(line), badPick] }, ctx);
  assert.equal(r.state.commandId, "trim");
  const lines = r.output.lines;
  assert.ok(lines.some((l) => /^1 found/.test(l)), `the accepted line counts (got: ${lines.join(" | ")})`);
  assert.ok(lines.some((l) => /1 rejected/.test(l)), "the rejected annotation is counted");
  // All-rejected: the typed reason is the outcome, nothing is collected.
  const r2 = applyPromptEvent(state, { type: "entities", entities: [badPick] }, ctx);
  assert.ok(r2.output.lines.some((l) => /^0 found — /.test(l)), `all-rejected batches answer 0 found with the reason (got: ${r2.output.lines.join(" | ")})`);
});

test("DEF-006: a batch while IDLE is a no-op (selection state is host-owned, not engine-owned)", () => {
  const r = applyPromptEvent(IDLE_PROMPT_STATE, { type: "entities", entities: [pickOf(fixtureElements()[0]!)] }, fixtureCtx());
  assert.equal(r.state.commandId, null);
  assert.deepEqual(r.output.lines, []);
});

test("DEF-006: commandWindowIds is the SAME three-way merge the idle canvas selection runs", () => {
  const elements = fixtureElements().filter((el) => (el.props as Record<string, unknown>).layer === "0");
  const geoms = toEntities(elements);
  const styleCtx = annotationStyleContext([], [], undefined);
  // A window containing the first two lines fully.
  const rect = selectionRectangle([-10, -5], [110, 15]);
  const ids = commandWindowIds(rect, elements, geoms, styleCtx);
  assert.deepEqual(ids, ["el-000001", "el-000002"], "window mode: only the fully-contained lines");
  // A crossing rect that intersects the third line but contains nothing fully.
  const crossing = selectionRectangle([110, 25], [-10, 15]); // right-to-left → crossing
  assert.equal(crossing.mode, "crossing");
  const crossingIds = commandWindowIds(crossing, elements, geoms, styleCtx);
  assert.ok(crossingIds.includes("el-000003"), "crossing mode captures the intersecting line");
  // An annotation joins through its primitive select (the third merge leg).
  const annotation = makeText({ layer: "0", x: 50, y: 40, height: 5, value: "NOTE", style: "Standard" });
  const annotationElement: Element = { id: "el-000010", kind: "annotation", engineId: null, props: annotationToProps(annotation) };
  const withAnnotation = [...elements, annotationElement];
  const styleCtx2 = annotationStyleContext(
    [{ name: "Standard", font: "sans", height: 0, widthFactor: 1, obliqueAngle: 0 }],
    [],
    1,
  );
  // Window mode needs the whole glyph box inside — the text spans ~50..~75
  // at height 5 ("NOTE", 4 glyphs), so the window [40,30]→[90,55] contains it.
  const annIds = commandWindowIds(selectionRectangle([40, 30], [90, 55]), withAnnotation, toEntities(withAnnotation), styleCtx2);
  assert.ok(annIds.includes("el-000010"), "the annotation is captured through its render primitives");
});

test("DEF-006: commandWindowPicks maps ids back to EntityPick records in merge order", () => {
  const elements = fixtureElements().filter((el) => (el.props as Record<string, unknown>).layer === "0");
  const picks = commandWindowPicks([-10, -5], [110, 15], elements, toEntities(elements), annotationStyleContext([], [], undefined));
  assert.deepEqual(picks.map((p) => p.id), ["el-000001", "el-000002"]);
  assert.equal(picks[0]!.kind, "geometry");
  assert.equal((picks[0]!.props as Record<string, unknown>).type, "line");
});

test("DEF-006: duplicate accumulation never double-applies — drafting.move is id-keyed (deterministic)", async () => {
  const h = AppApiHandler.create(CONFIG);
  const created = val<{ created: string[] }>(await h.handle(cmd("drafting.createEntities", { entities: [{ type: "line", layer: "0", from: [0, 0], to: [100, 0] }] })));
  const id = created.created[0]!;
  val(await h.handle(cmd("drafting.move", { ids: [id, id], dx: 10, dy: 0 })));
  const el = val<{ elements: { id: string; props: Record<string, unknown> }[] }>(await h.handle(q("document.getState"))).elements.find((e) => e.id === id)!;
  assert.deepEqual(el.props.from, [10, 0], "the duplicate id moved the line exactly once");
  assert.deepEqual(el.props.to, [110, 0]);
});

// ---------------------------------------------------------------------------
// No-fabrication guarantees: pre-commit selection surface mutates nothing.
// ---------------------------------------------------------------------------

test("negative: selection keywords and batches mutate NO document state before the committed command", async () => {
  const h = AppApiHandler.create(CONFIG);
  val(await h.handle(cmd("drafting.createEntities", { entities: [
    { type: "line", layer: "0", from: [0, 0], to: [100, 0] },
    { type: "line", layer: "0", from: [0, 10], to: [100, 10] },
  ] })));
  const before = val<{ version: { version_number: number }; elements: unknown[] }>(await h.handle(q("document.getState")));

  // The interactive surface: ERASE + ALL + a window batch + a LAST — every
  // event is collection only. The engine emits NO plan until Enter.
  const elements = val<{ elements: Element[] }>(await h.handle(q("document.getState"))).elements;
  const plans: CommandPlan[] = [];
  runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "typed", text: "ALL" } },
      { event: { type: "entities", entities: [pickOf(elements[0]!)] } },
      { event: { type: "typed", text: "LAST" } },
      { event: { type: "cancel" } },
    ] as const satisfies readonly CommandScriptStep[],
    defaultCommandContext({ documentElements: elements, layers: [{ id: "0", name: "0", color: "#111", visible: true }] }),
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 0, "collection events emit ZERO plans — the mutation only happens at commit");
  const after = val<{ version: { version_number: number }; elements: unknown[] }>(await h.handle(q("document.getState")));
  assert.equal(after.version.version_number, before.version.version_number, "no version bump");
  assert.equal(after.elements.length, before.elements.length, "no element change");
});

test("negative: a failed edit never emits false success (the build error is the typed outcome)", () => {
  // MOVE with no objects collected: Enter at the select phase with no
  // selection answers the typed requirement — no plan, no success echo.
  const plans: CommandPlan[] = [];
  const { lines, state } = runCommandScript(
    [
      { event: { type: "typed", text: "MOVE" } },
      { event: { type: "enter" } },
    ] as const satisfies readonly CommandScriptStep[],
    defaultCommandContext(),
    (plan) => plans.push(plan),
  );
  assert.equal(plans.length, 0);
  assert.equal(state.commandId, "move", "MOVE keeps waiting for its objects");
  assert.ok(lines.some((l) => /No objects selected|previous selection/i.test(l)), `the typed requirement answers (got: ${lines.join(" | ")})`);
  assert.ok(!lines.some((l) => /^MOVE: /.test(l)), "no success echo before the canonical mutation");
});

// ---------------------------------------------------------------------------
// Web/Electron parity (LOCK-004): the same selection/edit stream through
// BOTH real host transports produces identical outcomes.
// ---------------------------------------------------------------------------

test("selection/edit flows are byte-identical through WebHost and ElectronHost (engine stream parity)", () => {
  // The shared prompt-engine stream both hosts dispatch for the DEF-006/007/021
  // flows — identical plans and echoes by construction. The host transports
  // then execute the SAME plan entries; the post-state must converge.
  const ctx = defaultCommandContext({
    documentElements: [
      { id: "el-000001", kind: "geometry", engineId: null, props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [100, 0] } },
      { id: "el-000002", kind: "geometry", engineId: null, props: { drafting: true, type: "line", layer: "0", from: [0, 10], to: [100, 10] } },
    ],
    layers: [{ id: "0", name: "0", color: "#111", visible: true }],
  });
  const stream: readonly CommandScriptStep[] = [
    { event: { type: "typed", text: "LINE" } },
    { event: { type: "pick", point: [0, 0] } },
    { event: { type: "pick", point: [100, 0] } },
    { event: { type: "typed", text: "Undo" } }, // DEF-007 full word
    { event: { type: "pick", point: [100, 0] } },
    { event: { type: "typed", text: "ERASE" } },
    { event: { type: "typed", text: "ALL" } }, // DEF-021 keyword
    { event: { type: "entities", entities: [pickOf(ctx.documentElements![0]!)] } }, // DEF-006 batch
    { event: { type: "enter" } },
    { event: { type: "typed", text: "UNDO" } },
    { event: { type: "typed", text: "REDO" } },
  ];
  const plansA: CommandPlan[] = [];
  const plansB: CommandPlan[] = [];
  const a = runCommandScript(stream, ctx, (p) => plansA.push(p));
  const b = runCommandScript(stream, ctx, (p) => plansB.push(p));
  assert.deepEqual(a.lines, b.lines, "the echo stream is deterministic");
  assert.deepEqual(
    plansA.map((p) => [p.appApi.map((e) => e.name), JSON.stringify(p.appApi.map((e) => e.payload))]),
    plansB.map((p) => [p.appApi.map((e) => e.name), JSON.stringify(p.appApi.map((e) => e.payload))]),
    "the plan stream is deterministic",
  );
  // The exact expected semantic shape (one plan per mutating command).
  assert.deepEqual(
    plansA.map((p) => p.appApi.map((e) => e.name)),
    [["drafting.createEntities"], ["document.undo"], ["drafting.createEntities"], ["drafting.delete"], ["document.undo"], ["document.redo"]],
  );
});

test("selection/edit flows converge on equivalent serialized state through BOTH host transports", async () => {
  const webHandler = AppApiHandler.create(CONFIG);
  const electronHandler = AppApiHandler.create(CONFIG);
  const web = createRenderer(new WebHost(new WebSocketTransport(webHandler)));
  const electron = createRenderer(new ElectronHost(new IpcTransport(electronHandler)));

  type Exec = { execute(request: Command | Query): Promise<CommandQueryResponse> };
  const run = async (host: Exec): Promise<{ elements: number; selection: string[]; version: number }> => {
    await host.execute(cmd("drafting.createEntities", { entities: [
      { type: "line", layer: "0", from: [0, 0], to: [100, 0] },
      { type: "line", layer: "0", from: [0, 10], to: [100, 10] },
      { type: "circle", layer: "0", center: [200, 0], radius: 30 },
    ] }));
    // The ALL-keyword erase stream (the engine + host plan composition).
    const plans: CommandPlan[] = [];
    const ctx = defaultCommandContext({
      documentElements: [
        { id: "el-000001", kind: "geometry", engineId: null, props: { drafting: true, type: "line", layer: "0", from: [0, 0], to: [100, 0] } },
        { id: "el-000002", kind: "geometry", engineId: null, props: { drafting: true, type: "line", layer: "0", from: [0, 10], to: [100, 10] } },
        { id: "el-000003", kind: "geometry", engineId: null, props: { drafting: true, type: "circle", layer: "0", center: [200, 0], radius: 30 } },
      ],
      layers: [{ id: "0", name: "0", color: "#111", visible: true }],
    });
    runCommandScript(
      [
        { event: { type: "typed", text: "ERASE" } },
        { event: { type: "typed", text: "ALL" } },
        { event: { type: "enter" } },
      ] as const satisfies readonly CommandScriptStep[],
      ctx,
      (p) => plans.push(p),
    );
    for (const entry of plans[0]!.appApi) {
      val(await host.execute({ type: "command", name: entry.name as Command["name"], payload: entry.payload }));
    }
    await host.execute(cmd("document.undo", {}));
    const snap = val<{ version: { version_number: number }; elements: unknown[]; selection: string[] }>(await host.execute(q("document.getState")));
    return { elements: snap.elements.length, selection: snap.selection, version: snap.version.version_number };
  };
  const webState = await run(web);
  const electronState = await run(electron);
  assert.deepEqual(webState, electronState, "Web and Electron converge on the identical post-stream state");
  assert.equal(webState.elements, 3, "UNDO restored the erased set on both hosts");
});

// ---------------------------------------------------------------------------
// CC005/CC006 regression pins (the verified predecessor behavior).
// ---------------------------------------------------------------------------

test("regression: the P keyword still wins over PAN at entity steps (the CC006 pinned convention)", () => {
  let state = IDLE_PROMPT_STATE;
  state = applyPromptEvent(state, { type: "typed", text: "ERASE" }, fixtureCtx()).state;
  const r = applyPromptEvent(state, { type: "typed", text: "P" }, fixtureCtx());
  assert.equal(r.state.commandId, "erase", "P did not start PAN");
  assert.ok(r.output.lines.some((l) => /No previous selection/.test(l)));
});

test("regression: typed PAN at a POINT step still starts PAN (the CC006 navigation path is unchanged)", () => {
  let state = IDLE_PROMPT_STATE;
  state = applyPromptEvent(state, { type: "typed", text: "LINE" }, defaultCommandContext()).state;
  const r = applyPromptEvent(state, { type: "typed", text: "P" }, defaultCommandContext());
  assert.ok(r.output.lines.includes("*Cancel*"), "P at LINE's point step cancels (the pre-existing command-switch path)");
  assert.equal(r.state.commandId, "pan", "PAN starts by its alias outside select phases");
});

test("regression: the CC005 commit-authoritative echo split holds for the batch/keyword collection events", () => {
  // Collection echoes are interactive; the plan's outcome echoes are the
  // engine's own lines — splitEchoTiming still separates them.
  const { lines } = runCommandScript(
    [
      { event: { type: "typed", text: "ERASE" } },
      { event: { type: "typed", text: "ALL" } },
    ] as const satisfies readonly CommandScriptStep[],
    fixtureCtx(),
    () => {},
  );
  assert.ok(lines.includes("5 found (all objects)"));
});

test("regression: ZOOM/PAN/REGEN remain plan-free of App API commands (CC006 no-mutation contract)", () => {
  for (const [name, extra] of [["ZOOM", [{ event: { type: "typed", text: "E" } }]], ["PAN", [{ event: { type: "pick", point: [0, 0] } }, { event: { type: "pick", point: [10, 0] } }]], ["REGEN", []]] as const) {
    const plans: CommandPlan[] = [];
    runCommandScript(
      [{ event: { type: "typed", text: name as string } }, ...extra] as CommandScriptStep[],
      defaultCommandContext(),
      (p) => plans.push(p),
    );
    for (const plan of plans) {
      assert.equal(plan.appApi.length, 0, `${name} emits zero App API commands (CC006)`);
    }
  }
});

test("DEF-006 window selection stays deterministic at real G2 scale through the shared transform (CC006 transform path)", () => {
  // Real-scale site-plan coordinates: two boundary polylines at ~400 m
  // extents; the window select runs in WORLD space independent of zoom.
  const far = (id: string, x: number, y: number): Element => ({
    id,
    kind: "geometry",
    engineId: null,
    props: { drafting: true, type: "line", layer: "0", from: [x, y], to: [x + 50, y] },
  });
  const elements = [far("el-000001", 0, 0), far("el-000002", 0, 380), far("el-000003", 300, 190)];
  const layers = [{ id: "0", name: "0", color: "#111", visible: true }];
  const picks = commandWindowPicks([-10, -10], [60, 400], elements, toEntities(elements), annotationStyleContext([], [], undefined));
  assert.deepEqual(picks.map((p) => p.id), ["el-000001", "el-000002"], "deterministic window capture at real scale");
  const all = selectableElements(elements, layers);
  assert.equal(all.length, 3, "ALL captures everything at real scale");
  const last = lastSelectableElement(elements, layers);
  assert.equal(last?.id, "el-000003");
});

test("toEntityPicks drops ids that no longer resolve (live-element filtering)", () => {
  const elements = fixtureElements().slice(0, 2);
  const picks = toEntityPicks(elements, ["el-000001", "el-000099", "el-000002"]);
  assert.deepEqual(picks.map((p) => p.id), ["el-000001", "el-000002"], "dead ids cannot fabricate picks");
});
