/**
 * CAD-PARITY-002 prompt engine — the deterministic command-interaction
 * state machine (Issue #75; CAD-P-002 "command line and prompt state").
 *
 * A pure reducer: applyPromptEvent(state, event, ctx) → { state, output }.
 * The same event sequence always produces the same prompt texts, echo lines
 * and CommandPlans on every host (Web/Electron parity acceptance
 * criterion). The engine NEVER mutates state itself: completed commands
 * emit App API command plans that the host executes through its transport
 * (§5.3 — the only mutating path).
 *
 * Interaction model (AutoCAD-class familiarity):
 *  - commands start from any surface (ribbon/menu/palette/shortcut) or by
 *    typing a name/alias at the command line;
 *  - steps collect typed input (coordinate syntax, numbers, text, options)
 *    or picks (points with snap applied by the host, entity hits);
 *  - Enter finishes optional steps / accepts defaults / repeats the last
 *    command when idle;
 *  - Esc cancels the running command ("*Cancel*") or clears the selection;
 *  - LINE chains segments (Undo option removes the last segment through
 *    document.undo); POLYLINE collects vertices until Enter (Close option).
 *
 * Host-local aids (ortho/polar/tracking) constrain the CURSOR before the
 * pick reaches this engine (feedback.ts) — the engine stays pure.
 */

import type { Vec2 } from "../drafting/precision.js";
import { commandById, resolveCommand, type WorkspaceCommand } from "./commands.js";
import { resolveTypedDistance, resolveTypedPoint } from "./typed-input.js";
// CAD-PARITY-013: the option-value helpers live in the CYCLE-FREE
// prompt-options module (this engine imports the command registry, so a
// registry module importing THESE helpers from here would create a TDZ
// cycle); re-exported below so every existing importer is unchanged.
import { optionValueKey } from "./prompt-options.js";
// COMPAT-CAD-007 (Issue #142): the shared command-phase selection core —
// the ALL/LAST keyword resolution surface. command-select imports selection/
// precision/annotation modules only (no registry/engine imports), so this
// import is cycle-free.
import { lastSelectableElement, selectableElements } from "./command-select.js";
import type {
  CommandContext,
  CommandPlan,
  EntityPick,
  PromptStep,
  PromptValue,
} from "./types.js";

export { optionValue, optionValueKey } from "./prompt-options.js";

// ---------------------------------------------------------------------------
// State + events.
// ---------------------------------------------------------------------------

export interface PromptEngineState {
  readonly commandId: string | null;
  readonly stepIndex: number;
  readonly values: Readonly<Record<string, PromptValue>>;
  /** Last collected point (relative input base / direct-distance base). */
  readonly lastPoint: Vec2 | null;
  /** Last STARTED command — Enter repeats it when idle. */
  readonly lastCommandId: string | null;
  /** LINE chain: from-points of the created segments (for the Undo option). */
  readonly chainStack: readonly Vec2[];
  /** CAD-PARITY-003: active option sub-prompt (FILLET R, OFFSET T, CHAMFER
   *  D1/D2 — the keyword opens its own input, then the flow returns to the
   *  step). Null when no option is being collected. */
  readonly optionCapture: OptionCapture | null;
  /** CAD-PARITY-006: the MATERIALIZED steps of the running command —
   *  dynamicSteps(ctx) resolved once at start (deterministic: the same
   *  context yields the same steps). Absent for states built before the
   *  field existed / for commands without dynamicSteps → the registry's
   *  static steps. */
  readonly steps?: readonly PromptStep[];
}

/** An option currently collecting its own value. */
export interface OptionCapture {
  readonly stepId: string;
  readonly keyword: string;
  /** CAD-PARITY-004: "text" captures a typed string (-LAYER/CHPROP values). */
  readonly kind: "number" | "distance" | "point" | "text";
  readonly prompt: string;
  readonly defaultValue?: number;
}

// optionValueKey/optionValue: extracted to prompt-options.ts (cycle-free)
// and re-exported above.

export const IDLE_PROMPT_STATE: PromptEngineState = {
  commandId: null,
  stepIndex: 0,
  values: {},
  lastPoint: null,
  lastCommandId: null,
  chainStack: [],
  optionCapture: null,
};

export type PromptEvent =
  | { readonly type: "start"; readonly commandId: string }
  | { readonly type: "typed"; readonly text: string; readonly cursor?: Vec2 | null }
  | { readonly type: "pick"; readonly point: Vec2 }
  | { readonly type: "entity"; readonly entity: EntityPick }
  | { readonly type: "entities"; readonly entities: readonly EntityPick[] }
  | { readonly type: "entityPoint"; readonly entity: EntityPick; readonly point: Vec2 }
  | { readonly type: "enter" }
  | { readonly type: "cancel" };

export interface PromptEngineOutput {
  /** Echo lines for the command-line history (this event only). */
  readonly lines: readonly string[];
  /** The prompt to display now (null when idle). */
  readonly prompt: string | null;
  /** Display name of the running command (null when idle). */
  readonly commandName: string | null;
  /** Semantic plan emitted by this event (execute through the App API). */
  readonly plan: CommandPlan | null;
}

export interface PromptEngineResult {
  readonly state: PromptEngineState;
  readonly output: PromptEngineOutput;
}

/**
 * COMPAT-CAD-005: split one prompt-engine output into the two echo classes
 * the hosts must render at DIFFERENT times.
 *
 * Structural invariant of this engine (held by every plan-emitting path —
 * `startCommand`'s instant branch, the chained-command branch of
 * `collectValue`, and `completeCommand`): whenever `output.plan !== null`
 * the emitted `output.lines` END with exactly the plan's own `echo` block
 * (`[...interactiveEcho, ...plan.echo]`); when no plan is emitted, every
 * line is interactive.
 *
 * - `interactive`: prompt/acknowledge lines (the command name, typed
 *   coordinate resolutions, "1 found (el-000001)" pick feedback). These
 *   describe INPUT the user just gave — safe to render immediately.
 * - `deferred`: the plan's outcome claims ("LINE: (0,0) → (300,0) on layer
 *   'Walls'.", "-LAYER: layer 'X' created and set current."). These assert
 *   what the command WILL have done — the CAD-BENCH-RW-001 benchmark
 *   (DEF-027) proved printing them before the App API transaction commits
 *   produces success-then-`*ERROR*` pairs the user cannot trust. The hosts
 *   print them ONLY after every plan entry commits.
 */
export function splitEchoTiming(
  lines: readonly string[],
  plan: CommandPlan | null,
): { interactive: readonly string[]; deferred: readonly string[] } {
  if (plan === null || plan.echo.length === 0) {
    return { interactive: lines, deferred: [] };
  }
  return {
    interactive: lines.slice(0, lines.length - plan.echo.length),
    deferred: plan.echo,
  };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function command(state: PromptEngineState): WorkspaceCommand | null {
  return state.commandId === null ? null : commandById(state.commandId);
}

/** The steps of the RUNNING command (materialized at start — dynamic steps
 *  resolved once; static steps otherwise). CAD-PARITY-006. */
function stepsOf(state: PromptEngineState, cmd: WorkspaceCommand): readonly PromptStep[] {
  return state.steps ?? cmd.steps;
}

function currentStep(state: PromptEngineState): PromptStep | null {
  const cmd = command(state);
  if (cmd === null) return null;
  // CAD-PARITY-003: an active option sub-prompt replaces the visible step
  // (its kind routes pick/typed input; the collected value is stored under
  // the option key and the flow returns to the real step).
  if (state.optionCapture !== null) {
    const capture = state.optionCapture;
    return capture.defaultValue !== undefined
      ? {
          id: optionValueKey(capture.stepId, capture.keyword),
          kind: capture.kind,
          prompt: capture.prompt,
          defaultValue: capture.defaultValue,
        }
      : {
          id: optionValueKey(capture.stepId, capture.keyword),
          kind: capture.kind,
          prompt: capture.prompt,
        };
  }
  return stepsOf(state, cmd)[state.stepIndex] ?? null;
}

/** The step the HOST should interact with (option sub-prompt aware).
 *  Exported for both host renderers so pick routing stays identical. */
export function effectiveStep(state: PromptEngineState): PromptStep | null {
  return currentStep(state);
}

function promptFor(state: PromptEngineState): string | null {
  const step = currentStep(state);
  return step === null ? null : step.prompt;
}

function idleOutput(lines: readonly string[]): PromptEngineOutput {
  return { lines, prompt: null, commandName: null, plan: null };
}

function activeOutput(
  state: PromptEngineState,
  lines: readonly string[],
  plan: CommandPlan | null = null,
): PromptEngineOutput {
  const cmd = command(state);
  return {
    lines,
    prompt: promptFor(state),
    commandName: cmd === null ? null : cmd.name,
    plan,
  };
}

function fmt(p: Vec2): string {
  const n = (x: number) => (Number.isInteger(x) ? String(x) : String(Number(x.toFixed(3))));
  return `${n(p[0])},${n(p[1])}`;
}

/** Base point for relative/direct-distance input of the CURRENT step. */
function stepBase(state: PromptEngineState): Vec2 | null {
  const step = currentStep(state);
  if (step !== null && step.baseStep !== undefined) {
    const v = state.values[step.baseStep];
    if (v !== undefined && v.kind === "point") return v.point;
  }
  return state.lastPoint;
}

function startCommand(state: PromptEngineState, cmd: WorkspaceCommand, ctx: CommandContext): PromptEngineResult {
  if (cmd.instant !== undefined) {
    // Instant commands: emit the plan and stay idle.
    const plan = cmd.instant(ctx);
    return {
      state: { ...IDLE_PROMPT_STATE, lastCommandId: cmd.id },
      output: { lines: [cmd.name, ...plan.echo], prompt: null, commandName: null, plan },
    };
  }
  if (stepsOf(state, cmd).length === 0) {
    return {
      state,
      output: idleOutput([`${cmd.name}: no interactive steps defined — nothing to do.`]),
    };
  }
  // Fast-fail guard: BIM authoring commands without an active story.
  if (cmd.id === "wall" || cmd.id === "slab") {
    if (ctx.activeStoryId === null) {
      return {
        state,
        output: idleOutput([
          `${cmd.name} requires an active story — create one with STORY or select it in the Navigator.`,
        ]),
      };
    }
  }
  const next: PromptEngineState = {
    ...IDLE_PROMPT_STATE,
    commandId: cmd.id,
    lastCommandId: cmd.id,
    stepIndex: 0,
    values: {},
    // CAD-PARITY-006: materialize the steps at start — dynamic steps
    // (INSERT's per-attribute prompts, ATTEDIT's tag options) resolve
    // against the start context and re-materialize when a
    // `rematerialize` step completes (deterministic: the same ctx +
    // values → the same steps, every host).
    ...(cmd.dynamicSteps !== undefined ? { steps: cmd.dynamicSteps(ctx, {}) } : {}),
  };
  return { state: next, output: activeOutput(next, [cmd.name]) };
}

/** Collect one value into the state and advance/complete the command. */
function collectValue(
  state: PromptEngineState,
  cmd: WorkspaceCommand,
  value: PromptValue,
  echo: readonly string[],
  ctx: CommandContext,
): PromptEngineResult {
  const step = currentStep(state);
  if (step === null) return { state, output: activeOutput(state, echo) };

  // CAD-PARITY-003: option sub-prompt collection — the value is stored
  // under the option key and the flow returns to the real step.
  // COMPAT-CAD-006 (Issue #138): ZOOM's Scale factor is the whole command —
  // once the factor text is captured the command completes immediately
  // (AutoCAD: "Enter a scale factor (nX or nXP): 2" → the view zooms; there
  // is no further point prompt).
  if (state.optionCapture !== null) {
    const key = optionValueKey(state.optionCapture.stepId, state.optionCapture.keyword);
    const values: Record<string, PromptValue> = { ...state.values, [key]: value };
    if (cmd.id === "zoom" && state.optionCapture.keyword === "S") {
      return completeCommand({ ...state, values, optionCapture: null }, cmd, echo, ctx);
    }
    const next: PromptEngineState = { ...state, values, optionCapture: null };
    return { state: next, output: activeOutput(next, echo) };
  }

  let values: Record<string, PromptValue> = { ...state.values };
  let lastPoint = state.lastPoint;
  let chainStack = state.chainStack;

  if (step.multiple === true) {
    if (value.kind === "point") {
      const existing = values[step.id];
      const points = existing !== undefined && existing.kind === "points" ? [...existing.points] : [];
      points.push(value.point);
      values[step.id] = { kind: "points", points };
      lastPoint = value.point;
    } else if (value.kind === "entities") {
      const existing = values[step.id];
      const entities = existing !== undefined && existing.kind === "entities" ? [...existing.entities] : [];
      entities.push(...value.entities);
      values[step.id] = { kind: "entities", entities };
    } else if (value.kind === "entityPoints") {
      const existing = values[step.id];
      const picks = existing !== undefined && existing.kind === "entityPoints" ? [...existing.picks] : [];
      picks.push(...value.picks);
      values[step.id] = { kind: "entityPoints", picks };
    } else {
      values[step.id] = value;
    }
  } else {
    values[step.id] = value;
    if (value.kind === "point") lastPoint = value.point;
  }

  // CAD-PARITY-006: a REMATERIALIZING step extends the prompt sequence with
  // the context of everything collected so far — dynamicSteps(ctx, values)
  // rebuilds the steps with the new knowledge (INSERT appends one value
  // prompt per attribute of the just-named definition; ATTEDIT builds the
  // picked instance's tag options). The builder contract is PREFIX-STABLE:
  // the rebuilt steps keep every already-completed step at its index, so
  // advancing continues inside the extended tail. Deterministic: the same
  // ctx + the same collected values → the same steps, every host.
  const baseState: PromptEngineState =
    step.rematerialize === true && cmd.dynamicSteps !== undefined
      ? { ...state, steps: cmd.dynamicSteps(ctx, values) }
      : state;
  // CAD-PARITY-005: a multiple POINT step collects until Enter whether or
  // not it is the last step (LEADER's spine + trailing annotation text).
  // (Entity/entityPoint multiple steps keep the shipped advance-after-first
  // behavior — the pinned CAD-PARITY-002/003 parity streams rely on it.)
  if (step.multiple === true && step.kind === "point" && cmd.chained !== true) {
    const next: PromptEngineState = { ...baseState, values, lastPoint };
    return { state: next, output: activeOutput(next, echo) };
  }

  // LINE chaining: completing the final step of a chained command emits a
  // plan and re-prompts the final step with the carried base.
  const isLastStep = baseState.stepIndex === stepsOf(baseState, cmd).length - 1;
  if (isLastStep && (cmd.chained === true || step.multiple === true)) {
    if (cmd.chained === true) {
      // Chained point command (LINE): emit one plan per collected point.
      if (value.kind !== "point") {
        return { state, output: activeOutput(state, [...echo, "*Invalid input for a chained point step.*"]) };
      }
      let plan: CommandPlan;
      try {
        plan = cmd.build!(values, ctx);
      } catch (e) {
        // Validation failure cancels the command with an actionable message.
        return { state: { ...IDLE_PROMPT_STATE, lastCommandId: cmd.id }, output: idleOutput([...echo, (e as Error).message]) };
      }
      const prevFrom = baseState.values.from !== undefined && baseState.values.from.kind === "point" ? (baseState.values.from as { kind: "point"; point: Vec2 }).point : null;
      chainStack = prevFrom === null ? chainStack : [...chainStack, prevFrom];
      // Carry the just-collected point as the new chain base — or, for
      // chainKeep commands (RAY/XLINE), retain the FIRST step's value so
      // one base point serves many directions.
      const firstStep = stepsOf(baseState, cmd)[0];
      const carry: Record<string, PromptValue> =
        cmd.chainKeep === true && firstStep !== undefined && values[firstStep.id] !== undefined
          ? { [firstStep.id]: values[firstStep.id]! }
          : { from: value };
      const next: PromptEngineState = {
        ...baseState,
        values: carry,
        lastPoint: value.point,
        chainStack,
        stepIndex: stepsOf(baseState, cmd).length - 1,
      };
      return { state: next, output: activeOutput(next, [...echo, ...plan.echo], plan) };
    }
    // Multiple non-chained step (POLYLINE vertices, object picks): stay on
    // the same step collecting more input.
    const next: PromptEngineState = { ...baseState, values, lastPoint };
    return { state: next, output: activeOutput(next, echo) };
  }

  if (isLastStep) {
    return completeCommand({ ...baseState, values, lastPoint, chainStack }, cmd, echo, ctx);
  }

  const next: PromptEngineState = { ...baseState, values, lastPoint, chainStack, stepIndex: baseState.stepIndex + 1 };
  return { state: next, output: activeOutput(next, echo) };
}

function completeCommand(
  state: PromptEngineState,
  cmd: WorkspaceCommand,
  echo: readonly string[],
  ctx: CommandContext,
): PromptEngineResult {
  let plan: CommandPlan;
  try {
    plan = cmd.build!(state.values, ctx);
  } catch (e) {
    return {
      state: { ...IDLE_PROMPT_STATE, lastCommandId: cmd.id },
      output: idleOutput([...echo, (e as Error).message]),
    };
  }
  const next: PromptEngineState = { ...IDLE_PROMPT_STATE, lastCommandId: cmd.id };
  return { state: next, output: { lines: [...echo, ...plan.echo], prompt: null, commandName: null, plan } };
}

/** COMPAT-CAD-007 (Issue #142; DEF-007): the bracketed option words of a
 *  step's prompt — the ADVERTISED option surface the user sees. Every
 *  `[A/B/C]` segment contributes its `/`-separated tokens ("Undo", "Yes",
 *  "No", "All", "Extents" …). Pure string parsing; deterministic. */
export function bracketOptionWords(prompt: string): readonly string[] {
  const out: string[] = [];
  const re = /\[([^\][]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    for (const token of m[1]!.split("/")) {
      const word = token.trim();
      if (word.length > 0) out.push(word);
    }
  }
  return out;
}

function applyOptionKeyword(
  state: PromptEngineState,
  cmd: WorkspaceCommand,
  keyword: string,
  ctx: CommandContext,
): PromptEngineResult | null {
  const step = currentStep(state);
  if (step === null || step.options === undefined) return null;
  const typed = keyword.trim().toUpperCase();
  // 1. Abbreviation: the declared keyword (the existing contract — "U" is
  //    LINE's Undo, "C" is POLYLINE's Close).
  let option = step.options.find((o) => o.keyword.toUpperCase() === typed);
  // 2. COMPAT-CAD-007 (Issue #142; DEF-007): the ADVERTISED full word — the
  //    typed token equals a bracketed word of this step's prompt and that
  //    word starts with the option's keyword ("Undo"→U, "Close"→C,
  //    "Through"→T, "Radius"→R). Advertised options are honored uniformly:
  //    typing the full word can never cancel the command and start another.
  //    Most-specific match wins (the longest keyword; ties → declaration
  //    order), so ZOOM's "Extents" resolves EXTENTS before E.
  if (option === undefined) {
    const words = bracketOptionWords(step.prompt);
    if (words.length > 0) {
      const candidates = step.options.filter((o) =>
        words.some((w) => w.toUpperCase() === typed && w.toUpperCase().startsWith(o.keyword.toUpperCase())),
      );
      if (candidates.length > 0) {
        option = candidates.reduce((best, o) => (o.keyword.length > best.keyword.length ? o : best));
      }
    }
  }
  if (option === undefined) return null;

  if (cmd.id === "line" && option.keyword === "U") {
    // Undo the last chained segment through the document's own undo.
    if (state.chainStack.length === 0) {
      return { state, output: activeOutput(state, ["Undo: nothing to undo in this LINE run."]) };
    }
    const previous = state.chainStack[state.chainStack.length - 1]!;
    const chainStack = state.chainStack.slice(0, -1);
    const next: PromptEngineState = {
      ...state,
      chainStack,
      values: { from: { kind: "point", point: previous } },
      lastPoint: previous,
    };
    return {
      state: next,
      output: activeOutput(next, ["Undo one segment."], { appApi: [{ name: "document.undo", payload: {} }], ui: [], echo: [] }),
    };
  }

  if (cmd.id === "polyline" && option.keyword === "C") {
    const closed: PromptValue = { kind: "text", text: "C" };
    const values = { ...state.values, closed };
    return completeCommand({ ...state, values }, cmd, ["Close."], ctx);
  }

  // CAD-PARITY-003: SPLINE's Close behaves like POLYLINE's (finish the
  // command with the closed flag).
  if (cmd.id === "spline" && option.keyword === "C") {
    const closed: PromptValue = { kind: "text", text: "C" };
    const values = { ...state.values, closed };
    return completeCommand({ ...state, values }, cmd, ["Close."], ctx);
  }

  // CAD-PARITY-003 (Architect review): an option marked `unsupported` answers
  // with its typed failure and the step re-prompts — the supported/
  // unsupported surface is explicit in the command line, the command keeps
  // running (AutoCAD-class invalid-option handling).
  if (option.unsupported !== undefined) {
    return { state, output: activeOutput(state, [option.unsupported]) };
  }

  // COMPAT-CAD-006 (Issue #138): ZOOM's acting mode keywords (All/Extents/
  // Previous — every casing variant) complete the command IMMEDIATELY with
  // the mode stored (the POLYLINE-Close precedent: an option that IS the
  // whole command). AutoCAD semantics: typing E at the ZOOM prompt zooms
  // extents right away — no further point prompts. Window (W) is the
  // default corner mode, so it keeps the flag re-prompt behavior below.
  // (Checked BEFORE the generic flag branch so the acting keywords win.)
  if (cmd.id === "zoom" && option.flag === true && ZOOM_ACT_KEYWORDS.has(option.keyword.toUpperCase())) {
    const key = optionValueKey(step.id, option.keyword);
    const values: Record<string, PromptValue> = { ...state.values, [key]: { kind: "text", text: option.keyword.toUpperCase() } };
    return completeCommand({ ...state, values, optionCapture: null }, cmd, echoKeyword(option), ctx);
  }

  // CAD-PARITY-005: a FLAG option — the keyword itself is the value: it is
  // stored under the option key and the step re-prompts (DIMLINEAR's
  // Horizontal/Vertical). The stored text is the keyword, uppercase.
  if (option.flag === true) {
    const key = optionValueKey(step.id, option.keyword);
    const values: Record<string, PromptValue> = { ...state.values, [key]: { kind: "text", text: option.keyword.toUpperCase() } };
    const next: PromptEngineState = { ...state, values, optionCapture: null };
    return { state: next, output: activeOutput(next, echoKeyword(option)) };
  }

  // CAD-PARITY-003 generic mechanism: an option with `input` opens its own
  // sub-prompt (OFFSET's Through, FILLET's Radius, CHAMFER's distances).
  // The collected value is stored under the option key; the flow returns to
  // the step afterwards. Options WITHOUT input keep their legacy behavior.
  if (option.input !== undefined) {
    const capture: OptionCapture = option.defaultValue !== undefined
      ? {
          stepId: step.id,
          keyword: option.keyword,
          kind: option.input,
          prompt: option.optionPrompt ?? `${option.label}:`,
          defaultValue: option.defaultValue,
        }
      : {
          stepId: step.id,
          keyword: option.keyword,
          kind: option.input,
          prompt: option.optionPrompt ?? `${option.label}:`,
        };
    const next: PromptEngineState = { ...state, optionCapture: capture };
    return { state: next, output: activeOutput(next, echoKeyword(option)) };
  }

  return { state, output: activeOutput(state, [`Option ${option.label} is not available in this state.`]) };
}

function echoKeyword(option: { readonly keyword: string; readonly label: string }): readonly string[] {
  return [`${option.keyword} — ${option.label}`];
}

/** COMPAT-CAD-006 (Issue #138): ZOOM option keywords that ACT (complete the
 *  command immediately) rather than re-prompt: All/Extents/Previous. Window
 *  (W/WINDOW) stays a plain flag — window picking is the default mode. */
const ZOOM_ACT_KEYWORDS: ReadonlySet<string> = new Set(["A", "ALL", "E", "EXT", "EXTENTS", "P", "PREVIOUS"]);

// ---------------------------------------------------------------------------
// The reducer.
// ---------------------------------------------------------------------------

export function applyPromptEvent(
  state: PromptEngineState,
  event: PromptEvent,
  ctx: CommandContext,
): PromptEngineResult {
  const cmd = command(state);

  switch (event.type) {
    case "start": {
      const target = commandById(event.commandId);
      if (target === null) {
        return { state, output: idleOutput([`Unknown command '${event.commandId}'.`]) };
      }
      if (cmd !== null) {
        const started = startCommand({ ...IDLE_PROMPT_STATE, lastCommandId: state.lastCommandId }, target, ctx);
        return { state: started.state, output: { ...started.output, lines: ["*Cancel*", ...started.output.lines] } };
      }
      return startCommand(state, target, ctx);
    }

    case "cancel": {
      if (cmd === null) {
        return { state, output: idleOutput(["*Cancel*"]) };
      }
      // An active option sub-prompt cancels back to its step (the command
      // keeps running — AutoCAD-class behavior).
      if (state.optionCapture !== null) {
        const next: PromptEngineState = { ...state, optionCapture: null };
        return { state: next, output: activeOutput(next, ["Option cancelled."]) };
      }
      return { state: { ...IDLE_PROMPT_STATE, lastCommandId: state.lastCommandId }, output: idleOutput(["*Cancel*"]) };
    }

    case "enter": {
      if (cmd === null) {
        // Enter repeats the last command (AutoCAD-class behavior).
        if (state.lastCommandId === null) {
          return { state, output: idleOutput([]) };
        }
        const target = commandById(state.lastCommandId);
        if (target === null) return { state, output: idleOutput([]) };
        const started = startCommand({ ...state, commandId: null }, target, ctx);
        return started;
      }
      const step = currentStep(state);
      if (step === null) return { state, output: activeOutput(state, []) };

      // Enter accepts an option sub-prompt's declared default.
      if (state.optionCapture !== null) {
        if (state.optionCapture.defaultValue !== undefined) {
          return collectValue(state, cmd, { kind: "number", value: state.optionCapture.defaultValue }, [`<${state.optionCapture.defaultValue}>`], ctx);
        }
        return { state, output: activeOutput(state, ["This option requires a value — type one or press Esc to cancel the option."]) };
      }

      // CAD-PARITY-003: optional multiple ENTITY-POINT step (TRIM/EXTEND
      // targets) finishes on Enter — checked BEFORE the generic multiple
      // branch so the entityPoints collection is not misread as points.
      if (step.optional === true && step.multiple === true && step.kind === "entityPoint") {
        const existing = state.values[step.id];
        const picks = existing !== undefined && existing.kind === "entityPoints" ? existing.picks : [];
        const min = step.minInputs ?? 1;
        if (picks.length < min) {
          return { state, output: activeOutput(state, [`Need at least ${min} object pick(s) — ${picks.length} collected.`]) };
        }
        return completeCommand(state, cmd, [], ctx);
      }

      // Option-free Enter on an optional multiple step: finish collection.
      if (step.optional === true && (step.multiple === true || step.kind === "entity")) {
        if (step.kind === "entity") {
          const existing = state.values[step.id];
          const picked = existing !== undefined && existing.kind === "entities" ? existing.entities : [];
          if (picked.length === 0) {
            if (ctx.currentSelection.length > 0) {
              // Use the current (pre)selection — professional behavior.
              const picked: PromptValue = { kind: "entities", entities: [...ctx.currentSelection] };
              const values = { ...state.values, [step.id]: picked };
              const withSelection: PromptEngineState = { ...state, values };
              const isLast = state.stepIndex === stepsOf(state, cmd).length - 1;
              if (isLast) return completeCommand(withSelection, cmd, [`${ctx.currentSelection.length} found (current selection).`], ctx);
              const next: PromptEngineState = { ...withSelection, stepIndex: state.stepIndex + 1 };
              return { state: next, output: activeOutput(next, [`${ctx.currentSelection.length} found (current selection).`]) };
            }
            // CAD-PARITY-003: TRIM/EXTEND "or <all objects>" — Enter with no
            // picks completes the step empty (the implied-all mode is
            // resolved by the semantic core).
            if (step.emptyEnterCompletes === true) {
              const values = { ...state.values, [step.id]: { kind: "entities", entities: [] } as PromptValue };
              const withEmpty: PromptEngineState = { ...state, values };
              const isLast = state.stepIndex === stepsOf(state, cmd).length - 1;
              const echo = ["all objects implied."];
              if (isLast) return completeCommand(withEmpty, cmd, echo, ctx);
              const next: PromptEngineState = { ...withEmpty, stepIndex: state.stepIndex + 1 };
              return { state: next, output: activeOutput(next, echo) };
            }
            return { state, output: activeOutput(state, ["No objects selected — pick objects first."]) };
          }
          const min = step.minInputs ?? 1;
          if (picked.length < min) {
            return { state, output: activeOutput(state, [`Need at least ${min} object(s) — ${picked.length} selected.`]) };
          }
          const isLast = state.stepIndex === stepsOf(state, cmd).length - 1;
          if (isLast) return completeCommand(state, cmd, [], ctx);
          const next: PromptEngineState = { ...state, stepIndex: state.stepIndex + 1 };
          return { state: next, output: activeOutput(next, []) };
        }
        // Optional multiple POINT step (POLYLINE vertices): finish — or,
        // when more steps follow (CAD-PARITY-005 LEADER's annotation text),
        // ADVANCE to the next step with the collected points.
        const existing = state.values[step.id];
        const points = existing !== undefined && existing.kind === "points" ? existing.points : [];
        const min = step.minInputs ?? 1;
        if (points.length < min) {
          return { state, output: activeOutput(state, [`Need at least ${min} more point(s) — press Esc to cancel.`]) };
        }
        if (state.stepIndex === stepsOf(state, cmd).length - 1) {
          return completeCommand(state, cmd, [], ctx);
        }
        const next: PromptEngineState = { ...state, stepIndex: state.stepIndex + 1 };
        return { state: next, output: activeOutput(next, []) };
      }

      // Enter accepts a declared default (number/text steps).
      if (step.defaultValue !== undefined) {
        const v: PromptValue =
          typeof step.defaultValue === "number"
            ? { kind: "number", value: step.defaultValue }
            : { kind: "text", text: step.defaultValue };
        return collectValue(state, cmd, v, [`<${String(step.defaultValue)}>`], ctx);
      }

      // CAD-PARITY-004: an OPTIONAL single step (the -LAYER/CHPROP option
      // prompts) completes on Enter — with whatever option values were
      // collected (none → the builder echoes the honest no-op).
      if (step.optional === true) {
        const isLast = state.stepIndex === stepsOf(state, cmd).length - 1;
        if (isLast) return completeCommand(state, cmd, [], ctx);
        const next: PromptEngineState = { ...state, stepIndex: state.stepIndex + 1 };
        return { state: next, output: activeOutput(next, []) };
      }

      // Enter on a chained final point step ends the command.
      if (cmd.chained === true && state.stepIndex === stepsOf(state, cmd).length - 1) {
        return { state: { ...IDLE_PROMPT_STATE, lastCommandId: cmd.id }, output: idleOutput([`${cmd.name} finished.`]) };
      }

      return {
        state,
        output: activeOutput(state, [`This step requires a ${step.kind} — Esc cancels.`]),
      };
    }

    case "pick": {
      if (cmd === null) return { state, output: idleOutput([]) };
      const step = currentStep(state);
      if (step === null) return { state, output: activeOutput(state, []) };
      if (step.kind === "point") {
        return collectValue(state, cmd, { kind: "point", point: event.point }, [`(${fmt(event.point)})`], ctx);
      }
      if (step.kind === "distance") {
        const base = stepBase(state);
        if (base === null) {
          return { state, output: activeOutput(state, ["Pick distance needs a base point — type a number instead."]) };
        }
        const d = Math.hypot(event.point[0] - base[0], event.point[1] - base[1]);
        if (!(d > 0)) {
          return { state, output: activeOutput(state, ["Distance must be positive — pick away from the base point."]) };
        }
        return collectValue(state, cmd, { kind: "distance", distance: d }, [`(${fmt(event.point)}) → distance ${fmt([d, 0]).split(",")[0]}`], ctx);
      }
      if (step.kind === "displacement") {
        const base = stepBase(state);
        if (base === null) {
          return { state, output: activeOutput(state, ["Displacement needs a base point."]) };
        }
        const vector: Vec2 = [event.point[0] - base[0], event.point[1] - base[1]];
        return collectValue(state, cmd, { kind: "displacement", vector }, [`displacement (${fmt(vector)})`], ctx);
      }
      // CAD-PARITY-003: a NUMBER step with a base step resolves a pick to
      // the angle base→cursor in DEGREES (ROTATE's "Specify rotation angle"
      // with a drag — AutoCAD-class behavior).
      if (step.kind === "number" && step.baseStep !== undefined) {
        const base = stepBase(state);
        if (base === null) {
          return { state, output: activeOutput(state, ["Angle pick needs a base point — type the angle instead."]) };
        }
        const dx = event.point[0] - base[0];
        const dy = event.point[1] - base[1];
        if (Math.hypot(dx, dy) <= 1e-9) {
          return { state, output: activeOutput(state, ["Angle pick needs a point away from the base."]) };
        }
        const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
        return collectValue(state, cmd, { kind: "number", value: deg }, [`(${fmt(event.point)}) → angle ${deg.toFixed(2)}°`], ctx);
      }
      return { state, output: activeOutput(state, ["This step does not accept a point pick."]) };
    }

    case "entity": {
      if (cmd === null) return { state, output: idleOutput([]) };
      const step = currentStep(state);
      if (step === null || step.kind !== "entity") {
        return { state, output: activeOutput(state, ["This step does not accept an object pick."]) };
      }
      if (step.validate !== undefined) {
        const rejection = step.validate(event.entity);
        if (rejection !== null) {
          return { state, output: activeOutput(state, [rejection]) };
        }
      }
      return collectValue(state, cmd, { kind: "entities", entities: [event.entity] }, [`1 found (${event.entity.id})`], ctx);
    }

    // COMPAT-CAD-007 (Issue #142; DEF-006): a WINDOW/CROSSING batch of
    // object picks during a command select phase. The host resolves the
    // drag rectangle through the shared command-select core (the SAME
    // three-way merge the idle canvas selection runs) and dispatches the
    // captured objects here; the engine validates each, collects the
    // accepted set and echoes "N found" (+ cumulative total) — AutoCAD-class
    // window selection inside "Select objects:". Deterministic: the entity
    // order is the host's shared-merge order (document order based).
    case "entities": {
      if (cmd === null) return { state, output: idleOutput([]) };
      const step = currentStep(state);
      if (step === null || step.kind !== "entity") {
        return { state, output: activeOutput(state, ["This step does not accept an object pick."]) };
      }
      const accepted: EntityPick[] = [];
      let rejected = 0;
      let firstRejection: string | null = null;
      if (step.validate !== undefined) {
        for (const entity of event.entities) {
          const rejection = step.validate(entity);
          if (rejection === null) accepted.push(entity);
          else {
            rejected += 1;
            if (firstRejection === null) firstRejection = rejection;
          }
        }
      } else {
        accepted.push(...event.entities);
      }
      if (accepted.length === 0) {
        // Typed outcome — the collection state is unchanged (no partial
        // mutation, no fabricated success).
        const reason = firstRejection !== null ? ` — ${firstRejection}` : " — no objects within the selection window.";
        return { state, output: activeOutput(state, [`0 found${reason}`]) };
      }
      const existing = state.values[step.id];
      const prior = existing !== undefined && existing.kind === "entities" ? existing.entities : [];
      const total = prior.length + accepted.length;
      const echo = [`${accepted.length} found${total > accepted.length ? ` (${total} total)` : ""}`];
      if (rejected > 0 && firstRejection !== null) {
        echo.push(`${rejected} rejected — ${firstRejection}`);
      }
      return collectValue(state, cmd, { kind: "entities", entities: accepted }, echo, ctx);
    }

    // CAD-PARITY-003: object pick that ALSO records where it was picked —
    // the pick location is semantic for TRIM/EXTEND/FILLET/CHAMFER/BREAK
    // (it selects the piece/corner to operate on).
    case "entityPoint": {
      if (cmd === null) return { state, output: idleOutput([]) };
      const step = currentStep(state);
      if (step === null || step.kind !== "entityPoint") {
        return { state, output: activeOutput(state, ["This step does not accept an object pick."]) };
      }
      if (step.validate !== undefined) {
        const rejection = step.validate(event.entity);
        if (rejection !== null) {
          return { state, output: activeOutput(state, [rejection]) };
        }
      }
      return collectValue(
        state,
        cmd,
        { kind: "entityPoints", picks: [{ entity: event.entity, point: event.point }] },
        [`1 found (${event.entity.id}) at (${fmt(event.point)})`],
        ctx,
      );
    }

    case "typed": {
      const text = event.text.trim();
      if (text.length === 0) {
        return applyPromptEvent(state, { type: "enter" }, ctx);
      }

      if (cmd === null) {
        const target = resolveCommand(text);
        if (target === null) {
          return { state, output: idleOutput([`Unknown command '${text.toUpperCase()}'. Press F1 or Ctrl+K for the command search.`]) };
        }
        return startCommand(state, target, ctx);
      }

      // Step option keyword? (options win over command switching — "U" is
      // LINE's Undo and "C" is POLYLINE's Close while those steps run)
      const optioned = applyOptionKeyword(state, cmd, text, ctx);
      if (optioned !== null) return optioned;

      // COMPAT-CAD-007 (Issue #142; DEF-021): selection vocabulary at
      // "Select objects:" prompts is SELECT-PHASE INPUT, never a command
      // switch — ALL/LAST/P/PREVIOUS resolve (or fail typed) inside the
      // running command. The benchmark proved typed "ALL" cancelling MOVE
      // to run SELECTALL (DEF-021); with DEF-007's full-word matching the
      // same class of escape could hit advertised option words.
      const runningStep = currentStep(state);
      if (runningStep !== null && (runningStep.kind === "entity" || runningStep.kind === "entityPoint")) {
        const token = text.toUpperCase();
        if (token === "P" || token === "PREVIOUS" || token === "ALL" || token === "LAST") {
          if (runningStep.kind === "entityPoint") {
            // The pick LOCATION is semantic (TRIM/EXTEND/FILLET/…) — a
            // keyword cannot supply it. Typed outcome, command survives.
            return {
              state,
              output: activeOutput(state, [
                `'${text}' cannot supply the pick point — pick the object in the canvas (the pick point selects the piece to operate on).`,
              ]),
            };
          }
          if (token === "P" || token === "PREVIOUS") {
            if (ctx.currentSelection.length === 0) {
              return { state, output: activeOutput(state, ["No previous selection — pick objects or type P with a selection active."] ) };
            }
            return collectValue(
              state,
              cmd,
              { kind: "entities", entities: [...ctx.currentSelection] },
              [`${ctx.currentSelection.length} found (previous selection)`],
              ctx,
            );
          }
          if (token === "ALL") {
            const selectable = selectableElements(ctx.documentElements ?? [], ctx.layers);
            if (selectable.length === 0) {
              return { state, output: activeOutput(state, ["0 found — the document contains no selectable objects (visible, unfrozen, unlocked layers only)."] ) };
            }
            return collectValue(
              state,
              cmd,
              { kind: "entities", entities: selectable.map((el) => ({ id: el.id, kind: el.kind, props: el.props as Record<string, unknown> })) },
              [`${selectable.length} found (all objects)`],
              ctx,
            );
          }
          const last = lastSelectableElement(ctx.documentElements ?? [], ctx.layers);
          if (last === null) {
            return { state, output: activeOutput(state, ["0 found — no object has been created yet (LAST needs at least one selectable object)."] ) };
          }
          return collectValue(
            state,
            cmd,
            { kind: "entities", entities: [{ id: last.id, kind: last.kind, props: last.props as Record<string, unknown> }] },
            [`1 found (LAST: ${last.id})`],
            ctx,
          );
        }
      }

      // A command token typed while a command runs starts the new command
      // (canceling the current one) — except inside text steps, where the
      // token is legitimate input (e.g. a story named "Wall").
      // COMPAT-CAD-006 (Issue #138): the ENTITY-step "P" (previous
      // selection) convention WINS over the PAN command's P alias; PAN
      // starts by its full name, or by P whenever no entity/entityPoint
      // step is running. COMPAT-CAD-007: the select-phase vocabulary
      // (P/PREVIOUS/ALL/LAST) is fully consumed above — only OTHER tokens
      // reach the switch.
      if (runningStep !== null && runningStep.kind !== "text") {
        const switchTarget = resolveCommand(text);
        if (switchTarget !== null) {
          const started = startCommand({ ...IDLE_PROMPT_STATE, lastCommandId: state.lastCommandId }, switchTarget, ctx);
          return { state: started.state, output: { ...started.output, lines: ["*Cancel*", ...started.output.lines] } };
        }
      }

      const step = currentStep(state);
      if (step === null) return { state, output: activeOutput(state, []) };

      switch (step.kind) {
        case "point": {
          const resolution = resolveTypedPoint(text, stepBase(state), event.cursor ?? null);
          if (!resolution.ok) return { state, output: activeOutput(state, [resolution.reason]) };
          return collectValue(state, cmd, { kind: "point", point: resolution.point }, [`${text} → (${fmt(resolution.point)})`], ctx);
        }
        case "distance": {
          const resolution = resolveTypedDistance(text, stepBase(state), event.cursor ?? null);
          if (!resolution.ok) return { state, output: activeOutput(state, [resolution.reason]) };
          // resolveTypedDistance returns the distance encoded as [d, 0].
          const distance = resolution.point[0];
          if (!(distance > 0)) return { state, output: activeOutput(state, ["Distance must be positive."]) };
          return collectValue(state, cmd, { kind: "distance", distance }, [`${text} → distance ${distance}`], ctx);
        }
        case "number": {
          const n = Number(text);
          if (!Number.isFinite(n)) {
            return { state, output: activeOutput(state, [`'${text}' is not a number.`]) };
          }
          return collectValue(state, cmd, { kind: "number", value: n }, [text], ctx);
        }
        case "text": {
          return collectValue(state, cmd, { kind: "text", text }, [text], ctx);
        }
        case "entity": {
          // COMPAT-CAD-007: the select-phase vocabulary (P/PREVIOUS/ALL/
          // LAST) is consumed by the interception above; anything else
          // typed here is a typed decline (the command keeps running).
          return {
            state,
            output: activeOutput(state, [
              `'${text}' is not an object — pick in the canvas, drag a selection window, or type P/ALL/LAST.`,
            ]),
          };
        }
        case "entityPoint": {
          // The pick LOCATION is semantic here (TRIM/EXTEND/FILLET/…) — a
          // previous-selection shortcut cannot supply it.
          return { state, output: activeOutput(state, [`'${text}' is not an object — pick the object in the canvas (the pick point selects the piece to operate on).`]) };
        }
        case "displacement": {
          const resolution = resolveTypedPoint(text, null, event.cursor ?? null);
          if (resolution.ok) {
            // Typed "dx,dy" / "dist<angle" IS the displacement.
            const vector: Vec2 = resolution.point;
            return collectValue(state, cmd, { kind: "displacement", vector }, [`displacement (${fmt(vector)})`], ctx);
          }
          const n = Number(text);
          if (Number.isFinite(n)) {
            return { state, output: activeOutput(state, ["Displacement needs a direction — type 'dx,dy' or pick a point."]) };
          }
          return { state, output: activeOutput(state, [resolution.reason]) };
        }
      }
      return { state, output: activeOutput(state, []) };
    }
  }
}

/** The prompt + command name to display for a state (pure, side-effect free). */
export function describePrompt(state: PromptEngineState): { readonly prompt: string | null; readonly commandName: string | null } {
  const cmd = command(state);
  const step = currentStep(state);
  return { prompt: step === null ? null : step.prompt, commandName: cmd === null ? null : cmd.name };
}

// ---------------------------------------------------------------------------
// Script harness — deterministic command scripts (tests + host smokes).
// ---------------------------------------------------------------------------

export interface CommandScriptStep {
  readonly event: PromptEvent;
  /** Human-readable description of the step (evidence + debugging). */
  readonly note?: string;
}

/**
 * Apply a sequence of input events, invoking `execute` for every emitted
 * CommandPlan (the host executes the plan through its transport). Returns
 * the final state and every echo line produced — the deterministic record
 * of the interaction. Used by the app tests AND both host workflow smokes
 * to prove Web/Electron semantic parity (same script → same plans → same
 * document state).
 */
export function runCommandScript(
  steps: readonly CommandScriptStep[],
  ctx: CommandContext,
  execute: (plan: CommandPlan) => void,
  initial: PromptEngineState = IDLE_PROMPT_STATE,
): { readonly state: PromptEngineState; readonly lines: readonly string[] } {
  let state = initial;
  const lines: string[] = [];
  for (const step of steps) {
    const result = applyPromptEvent(state, step.event, ctx);
    state = result.state;
    lines.push(...result.output.lines);
    if (result.output.plan !== null) execute(result.output.plan);
  }
  return { state, lines };
}
