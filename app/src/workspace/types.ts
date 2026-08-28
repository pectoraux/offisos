/**
 * CAD-PARITY-002 shared workspace types — the command/selection/input
 * foundation (Issue #75, CAD/BIM Product Architecture v1.0 FROZEN under
 * ConstructionOS Architecture v1.1).
 *
 * This module is ENGINE-FREE and HOST-FREE (LOCK-003/018: no OCCT, FreeCAD,
 * IfcOpenShell, node or browser imports anywhere in src/workspace). It is
 * imported by BOTH hosts (Web via `@offisos/cad-app-shell/workspace/*` through
 * tsconfig paths; Electron through the same alias in its renderer bundle) so
 * the professional workspace produces THE SAME semantic command streams on
 * every host (LOCK-004 Web/Electron semantic parity).
 *
 * Core idea: the workspace is command-first. Every user intention — ribbon
 * button, menu item, tool palette click, keyboard shortcut, command palette
 * search or command-line alias — resolves to ONE canonical WorkspaceCommand.
 * Interactive commands run through the deterministic PromptEngine (a pure
 * reducer over input events); when the required inputs are collected the
 * command's builder emits a CommandPlan: an ordered list of App API
 * commands (the ONLY way state mutates, §5.3 — UI actions never mutate
 * domain state directly) plus declarative UI actions (palette toggles,
 * view changes — host-local, LOCK-015 non-authoritative state).
 *
 * Determinism contract (acceptance criterion): the same event sequence +
 * the same CommandContext produces the same CommandPlan, on every host,
 * every run. This is what the Web and Electron workflow smokes assert.
 */

import type { Vec2 } from "../drafting/precision.js";

// ---------------------------------------------------------------------------
// Command categories (mirrors the ribbon/menu information architecture of
// spec/cad-bim/ui.md §Workspace anatomy).
// ---------------------------------------------------------------------------

export type CommandCategory =
  | "draw"
  | "bim"
  | "modify"
  | "document"
  | "view"
  | "settings"
  | "help";

// ---------------------------------------------------------------------------
// Prompt steps — what a running command asks for.
// ---------------------------------------------------------------------------

/**
 * Input kinds a step can require.
 *
 * - point:     a world coordinate (mouse pick with snap applied, or typed
 *              coordinate syntax — see typed-input.ts).
 * - distance:  a positive length (typed number, or a pick whose distance
 *              from the step's base point is used).
 * - number:    a typed number (may be signed, e.g. story level).
 * - text:      a typed string (e.g. story name).
 * - entity:    a pick of an existing element (carries its snapshot so
 *              builders stay pure — no host queries inside the engine).
 * - entityPoint: a pick that selects the element under the cursor AND
 *              records the pick point (TRIM/EXTEND/FILLET/CHAMFER/BREAK
 *              targets — the pick location selects the piece to operate
 *              on, AutoCAD-class semantics).
 * - displacement: a vector (typed "dx,dy" or base→pick); used by MOVE/COPY.
 */
export type PromptInputKind =
  | "point"
  | "distance"
  | "number"
  | "text"
  | "entity"
  | "entityPoint"
  | "displacement";

/** Per-step option keyword (e.g. LINE's [Undo], POLYLINE's [Close]).
 *  CAD-PARITY-003 additive: an option with `input` collects its own value
 *  (a sub-prompt) and returns to the step — OFFSET's Through, FILLET's
 *  Radius, CHAMFER's distances. */
export interface PromptStepOption {
  readonly keyword: string;
  readonly label: string;
  /** When set, the keyword opens a sub-prompt for this input kind. */
  readonly input?: "number" | "distance" | "point";
  /** Sub-prompt text shown while the option value is collected. */
  readonly optionPrompt?: string;
  /** Default accepted on Enter for number sub-prompts. */
  readonly defaultValue?: number;
}

export interface PromptStep {
  readonly id: string;
  readonly kind: PromptInputKind;
  /** Imperative prompt text shown in the command line. */
  readonly prompt: string;
  /** The point step this distance/displacement is measured from. */
  readonly baseStep?: string;
  /** Enter completes the command early using collected values (polyline /
   * multi-pick finish). */
  readonly optional?: boolean;
  /** Step accepts multiple inputs of the same kind until Enter (selection
   * building, polyline vertices). */
  readonly multiple?: boolean;
  /** Minimum number of inputs for a multiple step (checked on Enter). */
  readonly minInputs?: number;
  /** CAD-PARITY-003: Enter with NO picks (and no preselection) completes the
   *  step with an EMPTY value — TRIM/EXTEND "or <all objects>" semantics
   *  (the implied-all-edges mode is resolved server-side). */
  readonly emptyEnterCompletes?: boolean;
  /** Option keywords valid while this step is active. */
  readonly options?: readonly PromptStepOption[];
  /** Entity-step pick validator: returns a rejection message or null. */
  readonly validate?: (pick: EntityPick) => string | null;
  /** Default value accepted on Enter (number/text steps). */
  readonly defaultValue?: number | string;
}

// ---------------------------------------------------------------------------
// Values collected while a command runs.
// ---------------------------------------------------------------------------

export type PromptValue =
  | { readonly kind: "point"; readonly point: Vec2 }
  | { readonly kind: "points"; readonly points: readonly Vec2[] }
  | { readonly kind: "distance"; readonly distance: number }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "entities"; readonly entities: readonly EntityPick[] }
  | { readonly kind: "entityPoints"; readonly picks: readonly EntityPointPick[] }
  | { readonly kind: "displacement"; readonly vector: Vec2 };

/** A pick of one existing element, snapshot at pick time (pure engine —
 *  no live host state inside). */
export interface EntityPick {
  readonly id: string;
  readonly kind: string;
  readonly props: Readonly<Record<string, unknown>>;
}

/** An object pick that also records WHERE it was picked (CAD-PARITY-003:
 *  TRIM/EXTEND/FILLET/CHAMFER/BREAK — the pick location is semantic). */
export interface EntityPointPick {
  readonly entity: EntityPick;
  readonly point: Vec2;
}

// ---------------------------------------------------------------------------
// Command plans — the semantic output of a completed command.
// ---------------------------------------------------------------------------

/** One App API command to execute, in order. The ONLY mutating path. */
export interface AppApiCommandPlanEntry {
  readonly name: string;
  readonly payload: unknown;
}

/** One declarative UI action for the host shell (palette/view/selection). */
export interface UiActionPlanEntry {
  readonly action: string;
  readonly payload?: unknown;
}

export interface CommandPlan {
  readonly appApi: readonly AppApiCommandPlanEntry[];
  readonly ui: readonly UiActionPlanEntry[];
  /** Echo lines for the command-line history (deterministic). */
  readonly echo: readonly string[];
}

// ---------------------------------------------------------------------------
// Command context — host-provided, deterministic inputs the builders need.
// ---------------------------------------------------------------------------

export interface CommandDefaults {
  readonly wallWidth: number;
  readonly wallHeight: number;
  readonly storyHeight: number;
  readonly slabThickness: number;
  readonly doorWidth: number;
  readonly doorHeight: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly windowSill: number;
}

export const DEFAULT_COMMAND_DEFAULTS: Readonly<CommandDefaults> = {
  wallWidth: 240,
  wallHeight: 3000,
  storyHeight: 3000,
  slabThickness: 200,
  doorWidth: 900,
  doorHeight: 2100,
  windowWidth: 1200,
  windowHeight: 1500,
  windowSill: 900,
};

/**
 * Everything command builders may read. Passed fresh with EVERY engine
 * event so plans always reflect the current document/workspace state.
 * Hosts must derive these deterministically (no wall-clock, no randomness).
 */
export interface CommandContext {
  /** Active drafting layer for new drafting entities. */
  readonly activeLayer: string;
  /** Active story for new BIM entities (null → BIM commands fail fast). */
  readonly activeStoryId: string | null;
  /** Next document element count — used to mint collision-unlikely explicit
   *  ids for batched host+dependent entities (opening→door). Deterministic
   *  given the same document history (parity). */
  readonly elementCount: number;
  /** Number of existing stories (STORY naming default). */
  readonly storyCount: number;
  readonly defaults: Readonly<CommandDefaults>;
  /** Current editor selection (ids with kinds) — used by MOVE/COPY/ERASE
   *  when the object step is skipped with Enter ("previous"). */
  readonly currentSelection: readonly EntityPick[];
}

export function defaultCommandContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    activeLayer: "0",
    activeStoryId: null,
    elementCount: 0,
    storyCount: 0,
    defaults: DEFAULT_COMMAND_DEFAULTS,
    currentSelection: [],
    ...overrides,
  };
}
