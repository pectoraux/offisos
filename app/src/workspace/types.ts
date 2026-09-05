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
import type {
  BlockDefinitionRecord,
  Camera3DState,
  ConstraintRecord,
  DimStyleRecord,
  Element,
  LayerRecord,
  LayoutRecord,
  TextStyleRecord,
  UcsRecord,
  ViewportRecord,
  XrefRecord,
} from "../contracts/caddocument.js";

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
  | "help"
  // CAD-PARITY-009 (Issue #90): the 3D navigation / UCS / bounded-modeling
  // vocabulary (the ribbon's 3D Model tab carries it).
  | "model3d"
  // CAD-PARITY-018 (Issue #118): the specialized professional toolsets
  // (architecture composition, MEP routing, mechanical layout, raster
  // underlay — the ribbon's Toolsets tab carries it).
  | "toolsets";

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
  /** When set, the keyword opens a sub-prompt for this input kind.
   *  CAD-PARITY-004: "text" sub-prompts collect a typed string value
   *  (-LAYER's name prompts, CHPROP's value prompts). */
  readonly input?: "number" | "distance" | "point" | "text";
  /** Sub-prompt text shown while the option value is collected. */
  readonly optionPrompt?: string;
  /** Default accepted on Enter for number sub-prompts. */
  readonly defaultValue?: number;
  /** When set, this option is explicitly UNSUPPORTED in this build: the
   *  keyword always answers with this typed failure and the step re-prompts
   *  (the supported/unsupported surface must be explicit in the command
   *  line — never silent, never a generic parse error). */
  readonly unsupported?: string;
  /** CAD-PARITY-005: a FLAG option — the keyword itself is the value (no
   *  sub-prompt): it is stored under the option key and the step
   *  re-prompts (DIMLINEAR's Horizontal/Vertical mode selection). */
  readonly flag?: boolean;
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
  /**
   * CAD-PARITY-006: completing this step REMATERIALIZES the command's
   * dynamic steps with everything collected so far (the dynamicSteps
   * builder contract is prefix-stable). INSERT marks its name step so the
   * per-attribute value prompts appear once the definition is known;
   * ATTEDIT marks its instance pick so the tag options list the picked
   * instance's attribute slots.
   */
  readonly rematerialize?: boolean;
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

/** CAD-PARITY-012 (Issue #102): one material-table entry the MATERIAL/MATSET
 *  builders resolve names against (the bim.material parity fields — a pure
 *  read view; category/lineweight optional, absent = the canonical default
 *  form). */
export interface MaterialContextEntry {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly color?: readonly [number, number, number];
  readonly lineweight?: number;
}

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
  // CAD-PARITY-011 (Issue #97): the Archicad-class authoring defaults.
  /** Default roof ridge height above the eaves base (mm). */
  readonly roofHeight: number;
  /** Default stair run width across the run (mm). */
  readonly stairWidth: number;
  /** Default stair riser count per flight. */
  readonly stairStepCount: number;
  /** Default stair tread depth (mm). */
  readonly stairTread: number;
  /** Default stair top landing length; 0 = no landing (mm). */
  readonly stairLandingLength: number;
  /** Default railing handrail height above the walking surface (mm). */
  readonly railingHeight: number;
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
  // CAD-PARITY-011 (Issue #97).
  roofHeight: 1500,
  stairWidth: 1200,
  stairStepCount: 16,
  stairTread: 280,
  stairLandingLength: 0,
  railingHeight: 900,
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
  /** COMPAT-CAD-007 (Issue #142): the document's live elements in document
   *  order — the deterministic resolution surface for the select-phase
   *  keywords (ALL / LAST) at "Select objects:" prompts (DEF-021). Both
   *  hosts pass the adopted snapshot's elements. Absent/empty on contexts
   *  that predate the field — the keywords then answer typed outcomes
   *  instead of approximating (no fabricated selections). */
  readonly documentElements?: readonly Element[];
  /** CAD-PARITY-004: the document layer table (name resolution for the
   *  -LAYER / CHPROP / LAYERSTATE builders; empty on contexts that predate
   *  the field — every builder treats it as "no resolvable names"). */
  readonly layers: readonly LayerRecord[];
  /** CAD-PARITY-005: the document user text-style table (the annotation
   *  builders resolve style-fixed heights; empty = only "Standard"). */
  readonly textStyles: readonly TextStyleRecord[];
  /** CAD-PARITY-005: the document user dim-style table. */
  readonly dimStyles: readonly DimStyleRecord[];
  /** CAD-PARITY-005: the current text style name (persisted editor state;
   *  "Standard" default). */
  readonly currentTextStyle: string;
  /** CAD-PARITY-005: the current dim style name ("Standard" default). */
  readonly currentDimStyle: string;
  /** CAD-PARITY-006: the document block-definition table (name resolution
   *  for BLOCK/INSERT/ATTDEF builders + the dynamic attribute prompts;
   *  empty on contexts that predate the field). */
  readonly blocks: readonly BlockDefinitionRecord[];
  /** CAD-PARITY-006: the attached external references (XATTACH/XDETACH/
   *  XLIST builders; empty on legacy contexts). */
  readonly xrefs: readonly XrefRecord[];
  /** CAD-PARITY-007: the declared parametric constraint graph
   *  (CONSTRAINTLIST/DELCONSTRAINT builders; empty on legacy contexts). */
  readonly constraints: readonly ConstraintRecord[];
  /** CAD-PARITY-008: the paper-space layout table (the LAYOUT family, MVIEW
   *  and PAGESETUP/PLOT builders; empty on legacy contexts). */
  readonly layouts: readonly LayoutRecord[];
  /** CAD-PARITY-008: the rectangular layout viewport table. */
  readonly viewports: readonly ViewportRecord[];
  /** CAD-PARITY-008: the active layout id (null when no layouts exist). */
  readonly activeLayoutId: string | null;
  /** CAD-PARITY-008: the TILEMODE-class editing context ("model" | "paper"). */
  readonly space: "model" | "paper";
  /** CAD-PARITY-009: the named-UCS table (the UCS family and the model3d
   *  builders; empty on legacy contexts — the implicit World is the
   *  fallback for every resolution). */
  readonly ucs: readonly UcsRecord[];
  /** CAD-PARITY-009: the ACTIVE UCS id (the persisted non-versioned
   *  draftingSettings.activeUcs editor state; "world" default). */
  readonly activeUcsId: string;
  /** CAD-PARITY-009: the persisted deterministic 3D camera (null → the
   *  shared module's default isometric view — the view3d.state semantics). */
  readonly view3d: Camera3DState | null;
  /** CAD-PARITY-009: the count of model3d solid elements (the 3DSTATE echo). */
  readonly model3dSolidCount: number;
  /** CAD-PARITY-012 (Issue #102): the document material table (the bim.material
   *  elements with the parity fields) for the MATERIAL/MATSET builders — the
   *  name resolution surface. Empty on contexts that predate the field (every
   *  builder treats it as "no known materials" — legacy hosts stay green). */
  readonly materials: readonly MaterialContextEntry[];
  /** CAD-PARITY-013 (Issue #104): the documentation view table (the
   *  vw-NNNNNN records) for the NAVASSIGN builder — view titles resolve to
   *  ids. Empty on contexts that predate the field ("no known views"). */
  readonly docsViews?: readonly { id: string; kind: string; title: string }[];
  /** CAD-PARITY-013: the navigator node table (View Map folders + Layout Book
   *  subsets) for the NAVFOLDER/SUBSET/NAVASSIGN/PUBSET builders —
   *  folder/subset names resolve to ids. Empty on legacy contexts. */
  readonly navigatorNodes?: readonly { id: string; kind: "folder" | "subset"; name: string }[];
  /** CAD-PARITY-013: the title-block table for the TITLEPLACE builder —
   *  title-block names resolve to ids. Empty on legacy contexts. */
  readonly titleBlocks?: readonly { id: string; name: string }[];
  /** CAD-PARITY-013: the publisher-set table for the PUBLISHBOOK builder —
   *  set names resolve to ids. Empty on legacy contexts. */
  readonly publisherSets?: readonly { id: string; name: string }[];
}

export function defaultCommandContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    activeLayer: "0",
    activeStoryId: null,
    elementCount: 0,
    storyCount: 0,
    defaults: DEFAULT_COMMAND_DEFAULTS,
    currentSelection: [],
    // COMPAT-CAD-007 (Issue #142): additive default (empty — legacy contexts
    // answer typed outcomes for ALL/LAST instead of guessing).
    documentElements: [],
    layers: [],
    textStyles: [],
    dimStyles: [],
    currentTextStyle: "Standard",
    currentDimStyle: "Standard",
    blocks: [],
    xrefs: [],
    constraints: [],
    layouts: [],
    viewports: [],
    activeLayoutId: null,
    space: "model",
    ucs: [],
    activeUcsId: "world",
    view3d: null,
    model3dSolidCount: 0,
    // CAD-PARITY-012 (Issue #102): additive default (empty — legacy contexts).
    materials: [],
    // CAD-PARITY-013 (Issue #104): additive defaults (empty — legacy
    // contexts; every builder treats them as "no known records").
    docsViews: [],
    navigatorNodes: [],
    titleBlocks: [],
    publisherSets: [],
    ...overrides,
  };
}

/**
 * COMPAT-CAD-005: resolve a canonical layer id to its display NAME for
 * command-line echo text (the identity the user typed — `-LAYER M
 * A-WALL-TEST`, `CLAYER A-WALL-TEST`). The CAD-BENCH-RW-001 benchmark found
 * every layer-attribution echo reporting raw minted ids (`on layer
 * 'ly-000001'`), which reads as an internal token, not a layer the user
 * knows (DEF-001/DEF-022). The id remains the canonical currency in every
 * payload; only the echo resolves the name (falling back to the raw id when
 * the table does not contain it — honest, never a guess).
 */
export function layerNameOrId(ctx: CommandContext, layerId: string): string {
  const layer = ctx.layers.find((l) => l.id === layerId);
  return layer?.name ?? layerId;
}
