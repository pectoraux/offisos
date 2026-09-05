/**
 * CAD-PARITY-002 workspace command registry — the canonical command surface
 * of the professional workspace (Issue #75; CAD-P-002 command system,
 * CAD-P-003 workspace, CAD-UX-002 keyboard-first parity).
 *
 * ONE registry drives EVERY entry point: ribbon buttons, application menu,
 * tool palette, command palette search, keyboard shortcuts and command-line
 * aliases all resolve to the same WorkspaceCommand. Command definitions are
 * pure data + pure builders: a builder receives the collected prompt values
 * and the CommandContext and emits a CommandPlan of App API commands +
 * declarative UI actions. Builders NEVER mutate state, never touch engines
 * and never read host state directly (LOCK-003/015/018; §5.3 — UI actions
 * never mutate domain state).
 *
 * Scope discipline (Issue #75 non-goals): this is the command/selection/
 * input FOUNDATION, not full command-count parity. The registry carries the
 * representative professional set: draw primitives, BIM authoring, the
 * modify operations that already exist in the App API, document/view/
 * palette commands and the drafting-aid toggles. Later parity work items
 * (CAD-PARITY-003+) extend this registry additively.
 */

import type { Vec2 } from "../drafting/precision.js";
import { propsToGeom } from "./geometry/types.js";
import { optionValueKey } from "./prompt-options.js";
import { COMMANDS_2D } from "./commands-2d.js";
import { COMMANDS_PROPS } from "./commands-props.js";
import { COMMANDS_ANNO } from "./commands-anno.js";
import { COMMANDS_BLOCK } from "./commands-blocks.js";
import { COMMANDS_PARAMETRICS } from "./commands-parametrics.js";
import { COMMANDS_LAYOUTS } from "./commands-layouts.js";
import { COMMANDS_MODEL3D } from "./commands-model3d.js";
import { COMMANDS_COORDINATION } from "./commands-coordination.js";
import { COMMANDS_DOCUMENTATION } from "./commands-documentation.js";
import { COMMANDS_COLLAB } from "./commands-collab.js";
import { COMMANDS_AUTOMATION } from "./commands-automation.js";
import { COMMANDS_TOOLSETS } from "./commands-toolsets.js";
import { COMMANDS_ASSOCIATIVE } from "./commands-associative.js";
import type {
  AppApiCommandPlanEntry,
  CommandCategory,
  CommandContext,
  CommandPlan,
  EntityPick,
  PromptStep,
  PromptValue,
} from "./types.js";
import { layerNameOrId } from "./types.js";

// ---------------------------------------------------------------------------
// Registry types.
// ---------------------------------------------------------------------------

export interface WorkspaceCommand {
  readonly id: string;
  /** Canonical command name typed at the command line (uppercase). */
  readonly name: string;
  /** Command-line aliases (AutoCAD-class familiarity, CAD-P-002). */
  readonly aliases: readonly string[];
  readonly label: string;
  readonly description: string;
  readonly category: CommandCategory;
  /** Ribbon tab the command appears on (host shells read this). */
  readonly ribbonTab: string;
  /** Display shortcut (informational; enforcement is host-side keymap.ts). */
  readonly shortcut?: string;
  /** Prompt sequence for interactive commands. */
  readonly steps: readonly PromptStep[];
  /**
   * CAD-PARITY-006: context-dependent prompt sequences — when present, the
   * prompt engine materializes the steps at command start AND whenever a
   * step marked `rematerialize` completes (deterministic: the same ctx +
   * the same collected values → the same steps, every host, every run).
   * INSERT builds a per-attribute value prompt for every attdef of the
   * named definition; ATTEDIT lists the picked instance's tags as keyword
   * options. The builder contract is PREFIX-STABLE: already-completed
   * steps keep their indices across rematerializations. Commands without
   * dynamicSteps are unaffected.
   */
  readonly dynamicSteps?: (
    ctx: CommandContext,
    values: Readonly<Record<string, PromptValue>>,
  ) => readonly PromptStep[];
  /**
   * LINE-style chaining: after the final step completes, the command stays
   * active with the final step re-prompted and the base carried forward.
   */
  readonly chained?: boolean;
  /**
   * CAD-PARITY-003: chained completion KEEPS the first step's value
   * instead of advancing the base (RAY/XLINE: one base point, many
   * directions — AutoCAD-class behavior). Requires `chained`.
   */
  readonly chainKeep?: boolean;
  /** Builder for interactive commands (steps completed). */
  readonly build?: (values: Readonly<Record<string, PromptValue>>, ctx: CommandContext) => CommandPlan;
  /** Executor for instant commands (no steps). */
  readonly instant?: (ctx: CommandContext) => CommandPlan;
}

// ---------------------------------------------------------------------------
// Small plan helpers.
// ---------------------------------------------------------------------------

function plan(
  appApi: readonly AppApiCommandPlanEntry[],
  echo: readonly string[],
  ui: CommandPlan["ui"] = [],
): CommandPlan {
  return { appApi, ui, echo };
}

function pointValue(values: Readonly<Record<string, PromptValue>>, id: string): Vec2 {
  const v = values[id];
  if (v === undefined || v.kind !== "point") throw new Error(`command builder: step '${id}' has no point`);
  return v.point;
}

/** COMPAT-CAD-006: the TEXT collected by an option sub-prompt (ZOOM Scale's
 *  factor string) stored under the option key — null when the option never
 *  fired. Uses the canonical optionValueKey storage convention. */
function optionTextValue(values: Readonly<Record<string, PromptValue>>, stepId: string, keyword: string): string | null {
  const v = values[optionValueKey(stepId, keyword)];
  if (v === undefined || v.kind !== "text") return null;
  return v.text;
}

function pointsValue(values: Readonly<Record<string, PromptValue>>, id: string): readonly Vec2[] {
  const v = values[id];
  if (v === undefined || v.kind !== "points") throw new Error(`command builder: step '${id}' has no points`);
  return v.points;
}

function entitiesValue(values: Readonly<Record<string, PromptValue>>, id: string): readonly EntityPick[] {
  const v = values[id];
  if (v === undefined || v.kind !== "entities") throw new Error(`command builder: step '${id}' has no entities`);
  return v.entities;
}

function numberValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback?: number): number {
  const v = values[id];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`command builder: step '${id}' has no number`);
  }
  if (v.kind !== "number") throw new Error(`command builder: step '${id}' is not a number`);
  return v.value;
}

function textValue(values: Readonly<Record<string, PromptValue>>, id: string, fallback?: string): string {
  const v = values[id];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`command builder: step '${id}' has no text`);
  }
  if (v.kind !== "text") throw new Error(`command builder: step '${id}' is not text`);
  return v.text;
}

function fmtPoint(p: Vec2): string {
  return `${trimNum(p[0])},${trimNum(p[1])}`;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/** Is this element a drafting entity (kind "geometry" + drafting mark)? */
export function isDraftingPick(pick: EntityPick): boolean {
  return pick.kind === "geometry" && (pick.props as Record<string, unknown>).drafting === true;
}

/** Is this element a BIM entity (kind "bim")? */
export function isBimPick(pick: EntityPick): boolean {
  return pick.kind === "bim";
}

function partitionSelection(entities: readonly EntityPick[]): {
  readonly drafting: readonly string[];
  readonly canonical: readonly string[];
  readonly bim: readonly string[];
} {
  const drafting: string[] = [];
  const canonical: string[] = [];
  const bim: string[] = [];
  // Deterministic order: preserve pick order within each partition.
  // CAD-PARITY-003: drafting entities stored in the canonical flat
  // convention (entity.create / entity.modify write-back) route to the
  // entity.* command surface; the legacy COMPAT-CAD-001 vocabulary keeps
  // its drafting.* commands (regression-safe); BIM keeps bim.*.
  for (const e of entities) {
    if (isDraftingPick(e)) {
      if (isCanonicalFlatPick(e)) canonical.push(e.id);
      else drafting.push(e.id);
    } else if (isBimPick(e)) bim.push(e.id);
  }
  return { drafting, canonical, bim };
}

/** CAD-PARITY-003: a drafting pick decodable as a canonical flat geometry
 *  record (the entity.* command surface). Legacy-convention entities (from
 *  drafting.createEntities: from/to, points, center/radius, corner1/2,
 *  dimensions) are NOT canonical-flat and keep the drafting.* path. */
function isCanonicalFlatPick(pick: EntityPick): boolean {
  if (pick.kind !== "geometry") return false;
  const props = pick.props as Record<string, unknown>;
  if (props.drafting !== true) return false;
  return propsToGeom(props) !== null;
}

/** Project a point onto the wall axis; returns the signed distance from the
 *  wall start, or null when the projection falls outside the wall span
 *  (explicit rejection — never silently clamped, LOCK-008). */
export function projectOnWall(wall: EntityPick, point: Vec2): number | null {
  const props = wall.props as Record<string, unknown>;
  const start = props.start as Vec2 | undefined;
  const end = props.end as Vec2 | undefined;
  if (!Array.isArray(start) || !Array.isArray(end)) return null;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len = Math.hypot(dx, dy);
  if (len <= 1e-12) return null;
  const t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (len * len);
  if (t < 0 || t > 1) return null;
  return t * len;
}

/** Step-level pick validator for DOOR/WINDOW hosts: a wall or a rejection. */
function validateWallHost(pick: EntityPick): string | null {
  if ((pick.props as Record<string, unknown>).type !== "bim.wall") {
    return "Host must be a wall — select a bim.wall element.";
  }
  return null;
}

/** CAD-PARITY-011: host validators for the Archicad-class authoring
 *  commands (typed, actionable — the command-line boundary). */
function validateStoryHost(pick: EntityPick): string | null {
  if ((pick.props as Record<string, unknown>).type !== "bim.story") {
    return "Pick must be a story — select a bim.story element.";
  }
  return null;
}

function validateStairHost(pick: EntityPick): string | null {
  if ((pick.props as Record<string, unknown>).type !== "bim.stair") {
    return "Host must be a stair — select a bim.stair element.";
  }
  return null;
}

function validateSpaceHost(pick: EntityPick): string | null {
  if ((pick.props as Record<string, unknown>).type !== "bim.space") {
    return "Zone members must be spaces — select bim.space elements.";
  }
  return null;
}

function validateBimLifecyclePick(pick: EntityPick): string | null {
  const type = (pick.props as Record<string, unknown>).type;
  const eligible = [
    "bim.wall", "bim.slab", "bim.roof", "bim.stair", "bim.railing",
    "bim.opening", "bim.door", "bim.window", "bim.space", "bim.zone",
    "bim.componentInstance",
  ];
  if (typeof type !== "string" || !eligible.includes(type)) {
    return "Renovation status applies to building/spatial BIM elements only.";
  }
  return null;
}

function wallStoryId(wall: EntityPick): string | null {
  const storyId = (wall.props as Record<string, unknown>).storyId;
  return typeof storyId === "string" ? storyId : null;
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

const UNDO_STEP: PromptStep = {
  id: "objects",
  kind: "entity",
  prompt: "Select objects:",
  optional: true,
  multiple: true,
  minInputs: 1,
};

export const WORKSPACE_COMMANDS: readonly WorkspaceCommand[] = [
  // --- Draw (ribbon: Home) --------------------------------------------------
  {
    id: "line",
    name: "LINE",
    aliases: ["L"],
    label: "Line",
    description: "Draw straight chain segments. Pick points; Enter ends, Esc cancels, U undoes the last segment.",
    category: "draw",
    ribbonTab: "Home",
    steps: [
      { id: "from", kind: "point", prompt: "Specify first point:" },
      {
        id: "to",
        kind: "point",
        prompt: "Specify next point or [Undo]:",
        options: [{ keyword: "U", label: "Undo" }],
      },
    ],
    chained: true,
    build: (values, ctx) => {
      const from = pointValue(values, "from");
      const to = pointValue(values, "to");
      return plan(
        [
          {
            name: "drafting.createEntities",
            payload: {
              entities: [{ type: "line", layer: ctx.activeLayer, from: [from[0], from[1]], to: [to[0], to[1]] }],
            },
          },
        ],
        [`LINE: (${fmtPoint(from)}) → (${fmtPoint(to)}) on layer '${layerNameOrId(ctx, ctx.activeLayer)}'.`],
      );
    },
  },
  {
    id: "polyline",
    name: "POLYLINE",
    aliases: ["PL", "PLINE"],
    label: "Polyline",
    description: "Draw a polyline. Pick vertices; Enter finishes (min 2), C closes.",
    category: "draw",
    ribbonTab: "Home",
    steps: [
      { id: "start", kind: "point", prompt: "Specify start point:" },
      {
        id: "next",
        kind: "point",
        prompt: "Specify next vertex or [Close]:",
        multiple: true,
        optional: true,
        minInputs: 1,
        options: [{ keyword: "C", label: "Close" }],
      },
    ],
    build: (values, ctx) => {
      const start = pointValue(values, "start");
      const rest = pointsValue(values, "next");
      const vertices = [start, ...rest].map((p) => [p[0], p[1]] as Vec2);
      if (vertices.length < 2) throw new Error("POLYLINE requires at least two vertices.");
      const closed = values.closed !== undefined && values.closed.kind === "text" && values.closed.text === "C";
      return plan(
        [
          {
            name: "drafting.createEntities",
            payload: {
              entities: [
                {
                  type: "polyline",
                  layer: ctx.activeLayer,
                  points: vertices,
                  closed,
                },
              ],
            },
          },
        ],
        [`POLYLINE: ${vertices.length} vertices${closed ? " (closed)" : ""} on layer '${layerNameOrId(ctx, ctx.activeLayer)}'.`],
      );
    },
  },
  {
    id: "circle",
    name: "CIRCLE",
    aliases: ["C"],
    label: "Circle",
    description: "Draw a circle from center and radius (pick a point or type a distance).",
    category: "draw",
    ribbonTab: "Home",
    steps: [
      { id: "center", kind: "point", prompt: "Specify center point:" },
      { id: "radius", kind: "distance", prompt: "Specify radius:", baseStep: "center" },
    ],
    build: (values, ctx) => {
      const center = pointValue(values, "center");
      const v = values.radius;
      const radius = v !== undefined && v.kind === "distance" ? v.distance : NaN;
      if (!(radius > 0)) throw new Error("CIRCLE requires a positive radius");
      return plan(
        [
          {
            name: "drafting.createEntities",
            payload: {
              entities: [{ type: "circle", layer: ctx.activeLayer, center: [center[0], center[1]], radius }],
            },
          },
        ],
        [`CIRCLE: center (${fmtPoint(center)}), radius ${trimNum(radius)} on layer '${layerNameOrId(ctx, ctx.activeLayer)}'.`],
      );
    },
  },
  {
    id: "arc",
    name: "ARC",
    aliases: ["A"],
    label: "Arc",
    description: "Draw an arc: center, start point, end point (counter-clockwise).",
    category: "draw",
    ribbonTab: "Home",
    steps: [
      { id: "center", kind: "point", prompt: "Specify arc center point:" },
      { id: "start", kind: "point", prompt: "Specify start point:" },
      { id: "end", kind: "point", prompt: "Specify end point (CCW):" },
    ],
    build: (values, ctx) => {
      const center = pointValue(values, "center");
      const start = pointValue(values, "start");
      const end = pointValue(values, "end");
      const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
      if (radius <= 1e-9) throw new Error("ARC start point must differ from the center");
      let startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
      let endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
      // Normalize to [0, 2π) and guarantee a positive CCW sweep.
      startAngle = normalize(startAngle);
      endAngle = normalize(endAngle);
      if (endAngle <= startAngle) endAngle += 2 * Math.PI;
      if (endAngle - startAngle >= 2 * Math.PI - 1e-12) {
        throw new Error("ARC sweep must be < 360° — use CIRCLE for a full circle");
      }
      return plan(
        [
          {
            name: "drafting.createEntities",
            payload: {
              entities: [
                {
                  type: "arc",
                  layer: ctx.activeLayer,
                  center: [center[0], center[1]],
                  radius,
                  startAngle,
                  endAngle,
                },
              ],
            },
          },
        ],
        [`ARC: center (${fmtPoint(center)}), radius ${trimNum(radius)}, ${trimNum(((endAngle - startAngle) * 180) / Math.PI)}° CCW.`],
      );
    },
  },
  {
    id: "rectangle",
    name: "RECTANGLE",
    aliases: ["REC", "RECT"],
    label: "Rectangle",
    description: "Draw an axis-aligned rectangle from two corners.",
    category: "draw",
    ribbonTab: "Home",
    steps: [
      { id: "corner1", kind: "point", prompt: "Specify first corner:" },
      { id: "corner2", kind: "point", prompt: "Specify opposite corner:" },
    ],
    build: (values, ctx) => {
      const corner1 = pointValue(values, "corner1");
      const corner2 = pointValue(values, "corner2");
      return plan(
        [
          {
            name: "drafting.createEntities",
            payload: {
              entities: [
                {
                  type: "rectangle",
                  layer: ctx.activeLayer,
                  corner1: [corner1[0], corner1[1]],
                  corner2: [corner2[0], corner2[1]],
                },
              ],
            },
          },
        ],
        [`RECTANGLE: (${fmtPoint(corner1)}) → (${fmtPoint(corner2)}) on layer '${layerNameOrId(ctx, ctx.activeLayer)}'.`],
      );
    },
  },


  // --- BIM authoring (ribbon: BIM) ------------------------------------------
  {
    id: "story",
    name: "STORY",
    aliases: ["ST"],
    label: "Story",
    description: "Create a building story (name, level, height) and make it active.",
    category: "bim",
    ribbonTab: "BIM",
    steps: [
      { id: "name", kind: "text", prompt: "Story name <Story N+1>:", defaultValue: "" },
      { id: "level", kind: "number", prompt: "Story level (elevation) <0>:", defaultValue: 0 },
      { id: "height", kind: "number", prompt: "Story height <3000>:", defaultValue: 0 },
    ],
    build: (values, ctx) => {
      const typedName = textValue(values, "name", "").trim();
      const name = typedName.length > 0 ? typedName : `Story ${ctx.storyCount + 1}`;
      const level = numberValue(values, "level", 0);
      const typedHeight = numberValue(values, "height", 0);
      const height = typedHeight > 0 ? typedHeight : ctx.defaults.storyHeight;
      return plan(
        [
          { name: "bim.createElements", payload: { entities: [{ type: "bim.story", name, level, height }] } },
        ],
        [`STORY: '${name}' level ${trimNum(level)}, height ${trimNum(height)} created and set active.`],
        [{ action: "story.activateCreated" }],
      );
    },
  },
  {
    id: "wall",
    name: "WALL",
    aliases: ["WA", "WL"],
    label: "Wall",
    description: "Draw a wall on the active story from two points (width/height from BIM defaults).",
    category: "bim",
    ribbonTab: "BIM",
    steps: [
      { id: "start", kind: "point", prompt: "Specify wall start point:" },
      { id: "end", kind: "point", prompt: "Specify wall end point:" },
    ],
    build: (values, ctx) => {
      if (ctx.activeStoryId === null) {
        throw new Error("WALL requires an active story — create one with STORY or select it in the Navigator.");
      }
      const start = pointValue(values, "start");
      const end = pointValue(values, "end");
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= 1e-9) {
        throw new Error("Wall start and end must not coincide.");
      }
      return plan(
        [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                {
                  type: "bim.wall",
                  storyId: ctx.activeStoryId,
                  start: [start[0], start[1]],
                  end: [end[0], end[1]],
                  width: ctx.defaults.wallWidth,
                  height: ctx.defaults.wallHeight,
                },
              ],
            },
          },
        ],
        [`WALL: (${fmtPoint(start)}) → (${fmtPoint(end)}) width ${ctx.defaults.wallWidth} height ${ctx.defaults.wallHeight} on story '${ctx.activeStoryId}'.`],
      );
    },
  },
  {
    id: "slab",
    name: "SLAB",
    aliases: ["SL"],
    label: "Slab",
    description: "Create a slab on the active story from two corners.",
    category: "bim",
    ribbonTab: "BIM",
    steps: [
      { id: "corner1", kind: "point", prompt: "Specify slab first corner:" },
      { id: "corner2", kind: "point", prompt: "Specify slab opposite corner:" },
    ],
    build: (values, ctx) => {
      if (ctx.activeStoryId === null) {
        throw new Error("SLAB requires an active story — create one with STORY or select it in the Navigator.");
      }
      const corner1 = pointValue(values, "corner1");
      const corner2 = pointValue(values, "corner2");
      return plan(
        [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                {
                  type: "bim.slab",
                  storyId: ctx.activeStoryId,
                  corner1: [corner1[0], corner1[1]],
                  corner2: [corner2[0], corner2[1]],
                  thickness: ctx.defaults.slabThickness,
                },
              ],
            },
          },
        ],
        [`SLAB: (${fmtPoint(corner1)}) → (${fmtPoint(corner2)}) thickness ${ctx.defaults.slabThickness}.`],
      );
    },
  },
  {
    id: "door",
    name: "DOOR",
    aliases: ["DR"],
    label: "Door",
    description: "Place a door: pick the host wall, then the position on the wall.",
    category: "bim",
    ribbonTab: "BIM",
    steps: [
      { id: "host", kind: "entity", prompt: "Select host wall:", validate: validateWallHost },
      { id: "position", kind: "point", prompt: "Specify door position on the wall:" },
    ],
    build: (values, ctx) => {
      const host = entitiesValue(values, "host")[0];
      if (host === undefined) throw new Error("DOOR requires a host wall.");
      if ((host.props as Record<string, unknown>).type !== "bim.wall") {
        throw new Error("DOOR host must be a wall — select a bim.wall element.");
      }
      const storyId = wallStoryId(host);
      if (storyId === null) throw new Error("Host wall has no story reference.");
      const position = pointValue(values, "position");
      const distance = projectOnWall(host, position);
      if (distance === null) {
        throw new Error("Door position projects outside the wall — pick a point on the wall.");
      }
      const openingId = `cmd-open-${ctx.elementCount + 1}`;
      return plan(
        [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                {
                  type: "bim.opening",
                  id: openingId,
                  hostId: host.id,
                  distance,
                  width: ctx.defaults.doorWidth,
                  height: ctx.defaults.doorHeight,
                  sill: 0,
                },
                { type: "bim.door", openingId, storyId, swing: "left" },
              ],
            },
          },
        ],
        [`DOOR: on wall '${host.id}' at ${trimNum(distance)} from the wall start (width ${ctx.defaults.doorWidth}).`],
      );
    },
  },
  {
    id: "window",
    name: "WINDOW",
    aliases: ["WN"],
    label: "Window",
    description: "Place a window: pick the host wall, then the position on the wall.",
    category: "bim",
    ribbonTab: "BIM",
    steps: [
      { id: "host", kind: "entity", prompt: "Select host wall:", validate: validateWallHost },
      { id: "position", kind: "point", prompt: "Specify window position on the wall:" },
    ],
    build: (values, ctx) => {
      const host = entitiesValue(values, "host")[0];
      if (host === undefined) throw new Error("WINDOW requires a host wall.");
      if ((host.props as Record<string, unknown>).type !== "bim.wall") {
        throw new Error("WINDOW host must be a wall — select a bim.wall element.");
      }
      const storyId = wallStoryId(host);
      if (storyId === null) throw new Error("Host wall has no story reference.");
      const position = pointValue(values, "position");
      const distance = projectOnWall(host, position);
      if (distance === null) {
        throw new Error("Window position projects outside the wall — pick a point on the wall.");
      }
      const openingId = `cmd-open-${ctx.elementCount + 1}`;
      return plan(
        [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                {
                  type: "bim.opening",
                  id: openingId,
                  hostId: host.id,
                  distance,
                  width: ctx.defaults.windowWidth,
                  height: ctx.defaults.windowHeight,
                  sill: ctx.defaults.windowSill,
                },
                { type: "bim.window", openingId, storyId },
              ],
            },
          },
        ],
        [`WINDOW: on wall '${host.id}' at ${trimNum(distance)} from the wall start (width ${ctx.defaults.windowWidth}).`],
      );
    },
  },

  // --- CAD-PARITY-011 (additive, Issue #97): Archicad-class authoring
  // commands (ribbon: BIM) ---------------------------------------------------

  {
    id: "roof",
    name: "ROOF",
    aliases: ["RF"],
    label: "Roof",
    description: "Create a gable roof on the active story from two footprint corners (ridge axis + ridge height).",
    category: "bim",
    ribbonTab: "BIM",
    steps: [
      { id: "corner1", kind: "point", prompt: "Specify roof first corner:" },
      { id: "corner2", kind: "point", prompt: "Specify roof opposite corner:" },
      { id: "ridgeAxis", kind: "text", prompt: "Ridge axis <x> (x or y — the plan axis the ridge runs parallel to):", defaultValue: "x" },
      { id: "height", kind: "number", prompt: "Ridge height above the eaves base <default>:", defaultValue: 0 },
    ],
    build: (values, ctx) => {
      if (ctx.activeStoryId === null) {
        throw new Error("ROOF requires an active story — create one with STORY or select it in the Navigator.");
      }
      const corner1 = pointValue(values, "corner1");
      const corner2 = pointValue(values, "corner2");
      const axis = textValue(values, "ridgeAxis", "x").trim().toLowerCase();
      if (axis !== "x" && axis !== "y") {
        throw new Error("ROOF ridge axis must be 'x' or 'y' (the plan axis the ridge runs parallel to).");
      }
      const typedHeight = numberValue(values, "height", 0);
      const height = typedHeight > 0 ? typedHeight : ctx.defaults.roofHeight;
      return plan(
        [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                {
                  type: "bim.roof",
                  storyId: ctx.activeStoryId,
                  corner1: [corner1[0], corner1[1]],
                  corner2: [corner2[0], corner2[1]],
                  ridgeAxis: axis,
                  height,
                },
              ],
            },
          },
        ],
        [
          `ROOF: (${fmtPoint(corner1)}) → (${fmtPoint(corner2)}), ridge ∥ ${axis}, ridge height ${trimNum(height)} on story '${ctx.activeStoryId}'.`,
        ],
      );
    },
  },
  {
    id: "stair",
    name: "STAIR",
    aliases: ["STR"],
    label: "Stair",
    description: "Create a stair from the active story to a picked top story (start point + run direction; width/tread/risers from BIM defaults).",
    category: "bim",
    ribbonTab: "BIM",
    steps: [
      { id: "start", kind: "point", prompt: "Specify stair start point (run centerline, bottom):" },
      { id: "direction", kind: "point", prompt: "Specify run direction (a point in the run direction):" },
      { id: "topStory", kind: "entity", prompt: "Select the TOP story the stair lands on:", validate: validateStoryHost },
    ],
    build: (values, ctx) => {
      if (ctx.activeStoryId === null) {
        throw new Error("STAIR requires an active story — create one with STORY or select it in the Navigator.");
      }
      const start = pointValue(values, "start");
      const dirPoint = pointValue(values, "direction");
      const vx = dirPoint[0] - start[0];
      const vy = dirPoint[1] - start[1];
      const vlen = Math.sqrt(vx * vx + vy * vy);
      if (vlen <= 1e-9) {
        throw new Error("STAIR direction must differ from the start point (the direction pick defines the run heading).");
      }
      const topStory = entitiesValue(values, "topStory")[0];
      if (topStory === undefined) throw new Error("STAIR requires the top story.");
      const topStoryId = topStory.id;
      if (topStoryId === ctx.activeStoryId) {
        throw new Error("STAIR top story must be a DIFFERENT story above the active story.");
      }
      // The direction pick defines the run HEADING — normalized to the unit
      // vector the entity requires (the picked length carries no meaning).
      const direction: [number, number] = [vx / vlen, vy / vlen];
      return plan(
        [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                {
                  type: "bim.stair",
                  storyId: ctx.activeStoryId,
                  topStoryId,
                  start: [start[0], start[1]],
                  direction,
                  width: ctx.defaults.stairWidth,
                  stepCount: ctx.defaults.stairStepCount,
                  tread: ctx.defaults.stairTread,
                  ...(ctx.defaults.stairLandingLength > 0 ? { landingLength: ctx.defaults.stairLandingLength } : {}),
                },
              ],
            },
          },
        ],
        [
          `STAIR: from (${fmtPoint(start)}) toward (${fmtPoint(dirPoint)}) on story '${ctx.activeStoryId}' → story '${topStoryId}', width ${ctx.defaults.stairWidth}, ${ctx.defaults.stairStepCount} risers, tread ${ctx.defaults.stairTread}.`,
        ],
      );
    },
  },
  {
    id: "railing",
    name: "RAILING",
    aliases: ["RAL"],
    label: "Railing",
    description: "Create a railing on a host stair (side + handrail height from BIM defaults).",
    category: "bim",
    ribbonTab: "BIM",
    steps: [
      { id: "host", kind: "entity", prompt: "Select host stair:", validate: validateStairHost },
      { id: "side", kind: "text", prompt: "Side <left> (left or right, facing the run direction):", defaultValue: "left" },
    ],
    build: (values, ctx) => {
      const host = entitiesValue(values, "host")[0];
      if (host === undefined) throw new Error("RAILING requires a host stair.");
      const side = textValue(values, "side", "left").trim().toLowerCase();
      if (side !== "left" && side !== "right") {
        throw new Error("RAILING side must be 'left' or 'right' (facing the host stair's run direction).");
      }
      return plan(
        [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                {
                  type: "bim.railing",
                  hostId: host.id,
                  side,
                  height: ctx.defaults.railingHeight,
                },
              ],
            },
          },
        ],
        [
          `RAILING: on stair '${host.id}' (${side} side), handrail height ${ctx.defaults.railingHeight}.`,
        ],
      );
    },
  },
  {
    id: "zone",
    name: "ZONE",
    aliases: ["ZN"],
    label: "Zone",
    description: "Create a zone grouping one or more spaces (name + space selection).",
    category: "bim",
    ribbonTab: "BIM",
    steps: [
      { id: "name", kind: "text", prompt: "Zone name <Zone N+1>:", defaultValue: "" },
      { id: "spaces", kind: "entity", prompt: "Select member spaces (Enter to finish):", multiple: true, optional: true, minInputs: 1, validate: validateSpaceHost },
    ],
    build: (values, ctx) => {
      const typedName = textValue(values, "name", "").trim();
      const name = typedName.length > 0 ? typedName : `Zone ${ctx.storyCount + 1}`;
      const spaces = entitiesValue(values, "spaces");
      if (spaces.length === 0) {
        throw new Error("ZONE requires at least one member space (a zone groups spaces).");
      }
      return plan(
        [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                {
                  type: "bim.zone",
                  name,
                  spaceIds: spaces.map((s) => s.id),
                },
              ],
            },
          },
        ],
        [
          `ZONE: '${name}' grouping ${spaces.length} space(s): ${spaces.map((s) => s.id).join(", ")}.`,
        ],
      );
    },
  },
  {
    id: "optiongroup",
    name: "OPTION",
    aliases: ["OPT"],
    label: "Option group",
    description: "Create a design-option group (name + comma-separated options + the active option).",
    category: "bim",
    ribbonTab: "BIM",
    steps: [
      { id: "name", kind: "text", prompt: "Option group name:", defaultValue: "" },
      { id: "options", kind: "text", prompt: "Options (comma-separated, ≥ 2):", defaultValue: "" },
      { id: "active", kind: "text", prompt: "Active option (must be one of the declared options):", defaultValue: "" },
    ],
    build: (values) => {
      const name = textValue(values, "name", "").trim();
      if (name.length === 0) throw new Error("OPTION requires a group name.");
      const options = textValue(values, "options", "")
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0);
      if (options.length < 2) {
        throw new Error("OPTION requires at least 2 distinct option names (comma-separated).");
      }
      const active = textValue(values, "active", "").trim();
      if (!options.includes(active)) {
        throw new Error(`OPTION active option '${active}' must be one of the declared options (${options.join(", ")}).`);
      }
      return plan(
        [
          {
            name: "bim.createElements",
            payload: {
              entities: [
                {
                  type: "bim.optionGroup",
                  name,
                  options,
                  activeOption: active,
                },
              ],
            },
          },
        ],
        [
          `OPTION: group '${name}' with options ${options.join(", ")} (active: '${active}'). Use bim.setOptionMembership on elements and bim.setActiveOption to switch.`,
        ],
      );
    },
  },
  {
    id: "renovate",
    name: "RENOVATE",
    aliases: ["REN"],
    label: "Renovation status",
    description: "Set the renovation status (existing | new | to-be-demolished) of the selected BIM elements.",
    category: "bim",
    ribbonTab: "BIM",
    steps: [
      { id: "status", kind: "text", prompt: "Renovation status <new> (existing | new | to-be-demolished):", defaultValue: "new" },
      { id: "objects", kind: "entity", prompt: "Select BIM elements (Enter to use the current selection):", multiple: true, optional: true, validate: validateBimLifecyclePick },
    ],
    build: (values, ctx) => {
      const status = textValue(values, "status", "new").trim().toLowerCase();
      if (status !== "existing" && status !== "new" && status !== "to-be-demolished") {
        throw new Error("RENOVATE status must be 'existing', 'new' or 'to-be-demolished'.");
      }
      let picks = entitiesValue(values, "objects");
      if (picks.length === 0) {
        picks = ctx.currentSelection.filter(isBimPick);
      }
      if (picks.length === 0) {
        throw new Error("RENOVATE requires at least one BIM element (select elements or use the current selection).");
      }
      const appApi = picks.map((pick) => ({
        name: "bim.setRenovation" as const,
        payload: { elementId: pick.id, status },
      }));
      return plan(
        appApi,
        [
          `RENOVATE: ${picks.length} element(s) → '${status}': ${picks.map((p) => p.id).join(", ")}.`,
        ],
      );
    },
  },

  // --- Modify (ribbon: Home / Modify) ---------------------------------------
  {
    id: "move",
    name: "MOVE",
    aliases: ["M"],
    label: "Move",
    description: "Move selected objects by a displacement (base point → second point, or typed dx,dy).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      UNDO_STEP,
      { id: "base", kind: "point", prompt: "Specify base point:" },
      { id: "target", kind: "displacement", prompt: "Specify second point or <use typed displacement>:", baseStep: "base" },
    ],
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      const v = values.target;
      const vector: Vec2 = v !== undefined && v.kind === "displacement" ? v.vector : [0, 0];
      const { drafting, canonical, bim } = partitionSelection(objects);
      const appApi: AppApiCommandPlanEntry[] = [];
      if (drafting.length > 0) appApi.push({ name: "drafting.move", payload: { ids: drafting, dx: vector[0], dy: vector[1] } });
      if (canonical.length > 0) appApi.push({ name: "entity.modify", payload: { op: "move", ids: canonical, dx: vector[0], dy: vector[1] } });
      if (bim.length > 0) appApi.push({ name: "bim.move", payload: { ids: bim, dx: vector[0], dy: vector[1], dz: 0 } });
      if (appApi.length === 0) throw new Error("MOVE received no movable objects.");
      return plan(appApi, [`MOVE: ${objects.length} object(s) by (${trimNum(vector[0])}, ${trimNum(vector[1])}).`]);
    },
  },
  {
    id: "copy",
    name: "COPY",
    aliases: ["CO", "CP"],
    label: "Copy",
    description:
      "Copy selected objects by a displacement (single placement per run — the Multiple repeat mode is a typed decline in this build).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      UNDO_STEP,
      { id: "base", kind: "point", prompt: "Specify base point:" },
      {
        id: "target",
        kind: "displacement",
        prompt: "Specify second point or [Multiple] <use typed displacement>:",
        baseStep: "base",
        options: [
          {
            keyword: "M",
            label: "Multiple placement (unsupported in this build)",
            unsupported:
              "COPY multiple placement (repeat) is not supported in this build — one copy per run; run COPY again for the next placement.",
          },
        ],
      },
    ],
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      const v = values.target;
      const vector: Vec2 = v !== undefined && v.kind === "displacement" ? v.vector : [0, 0];
      const { drafting, canonical, bim } = partitionSelection(objects);
      const appApi: AppApiCommandPlanEntry[] = [];
      if (drafting.length > 0) appApi.push({ name: "drafting.copy", payload: { ids: drafting, dx: vector[0], dy: vector[1] } });
      if (canonical.length > 0) appApi.push({ name: "entity.modify", payload: { op: "copy", ids: canonical, dx: vector[0], dy: vector[1] } });
      if (bim.length > 0) appApi.push({ name: "bim.copy", payload: { ids: bim, dx: vector[0], dy: vector[1], dz: 0 } });
      if (appApi.length === 0) throw new Error("COPY received no copyable objects.");
      return plan(appApi, [`COPY: ${objects.length} object(s) by (${trimNum(vector[0])}, ${trimNum(vector[1])}).`]);
    },
  },
  {
    id: "erase",
    name: "ERASE",
    aliases: ["E"],
    label: "Erase",
    description: "Delete selected objects.",
    category: "modify",
    ribbonTab: "Home",
    shortcut: "Del",
    steps: [UNDO_STEP],
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      const { drafting, bim } = partitionSelection(objects);
      const appApi: AppApiCommandPlanEntry[] = [];
      if (drafting.length > 0) appApi.push({ name: "drafting.delete", payload: { ids: drafting } });
      if (bim.length > 0) appApi.push({ name: "bim.delete", payload: { ids: bim } });
      if (appApi.length === 0) throw new Error("ERASE received no erasable objects.");
      return plan(appApi, [`ERASE: ${objects.length} object(s).`]);
    },
  },
  // TRIM and EXTEND are superseded by the CAD-PARITY-003 generalized
  // commands (entity.modify trim/extend over the full CAD-2D vocabulary
  // with implied-all-edges Enter semantics) — see commands-2d.ts. The
  // drafting.trim / drafting.extend App API commands remain available for
  // compatibility (COMPAT-CAD-001 regression surface).

  // --- Document (ribbon: File quick access) ---------------------------------
  {
    id: "undo",
    name: "UNDO",
    aliases: ["U"],
    label: "Undo",
    description: "Undo the last versioned document command.",
    category: "document",
    ribbonTab: "Home",
    shortcut: "Ctrl+Z",
    steps: [],
    instant: () => plan([{ name: "document.undo", payload: {} }], ["UNDO."]),
  },
  {
    id: "redo",
    name: "REDO",
    aliases: ["REDO"],
    label: "Redo",
    description: "Redo the last undone command.",
    category: "document",
    ribbonTab: "Home",
    shortcut: "Ctrl+Y",
    steps: [],
    instant: () => plan([{ name: "document.redo", payload: {} }], ["REDO."]),
  },
  {
    id: "new",
    name: "NEW",
    aliases: ["NEW"],
    label: "New document",
    description: "Start a new empty document.",
    category: "document",
    ribbonTab: "Home",
    shortcut: "Ctrl+N",
    steps: [],
    instant: () => plan([], ["NEW."], [{ action: "file.new" }]),
  },
  {
    id: "save",
    name: "SAVE",
    aliases: ["SAVE"],
    label: "Save",
    description: "Save the document (web: download; desktop: file save).",
    category: "document",
    ribbonTab: "Home",
    shortcut: "Ctrl+S",
    steps: [],
    instant: () => plan([{ name: "document.save", payload: {} }], ["SAVE."], [{ action: "file.save" }]),
  },

  // --- View / palettes -------------------------------------------------------
  {
    id: "zoomextents",
    name: "ZOOMEXTENTS",
    aliases: ["ZE"],
    label: "Zoom Extents",
    description: "Fit all visible entities in the viewport.",
    category: "view",
    ribbonTab: "View",
    steps: [],
    instant: () => plan([], ["ZOOMEXTENTS."], [{ action: "view.zoomExtents" }]),
  },
  // COMPAT-CAD-006 (Issue #138): the navigation vocabulary over the shared
  // view transform — ZOOM (window default, bracketed All/Extents/Previous/
  // Scale/Window modes), PAN (base+second point or displacement-on-Enter),
  // REGEN (redraw, never a document mutation). View state is presentation
  // state: the builders emit NO App API commands; every navigation plan is
  // ui-actions + echo only.
  {
    id: "zoom",
    name: "ZOOM",
    aliases: ["Z"],
    label: "Zoom",
    description:
      "Zoom the view. Default: specify two window corners. Options: All/Extents fit everything, Previous restores the last view, Scale multiplies by a factor (n = ×extents fit, nX = ×current).",
    category: "view",
    ribbonTab: "View",
    steps: [
      {
        id: "corner1",
        kind: "point",
        prompt: "Specify first corner of zoom window or [All/Extents/Previous/Scale/Window]:",
        options: [
          { keyword: "A", label: "All", flag: true },
          { keyword: "ALL", label: "All", flag: true },
          { keyword: "E", label: "Extents", flag: true },
          { keyword: "EXT", label: "Extents", flag: true },
          { keyword: "EXTENTS", label: "Extents", flag: true },
          { keyword: "P", label: "Previous", flag: true },
          { keyword: "PREVIOUS", label: "Previous", flag: true },
          { keyword: "S", label: "Scale factor", input: "text", optionPrompt: "Enter a scale factor (nX or nXP):" },
          { keyword: "W", label: "Window", flag: true },
          { keyword: "WINDOW", label: "Window", flag: true },
        ],
      },
      { id: "corner2", kind: "point", prompt: "Specify opposite corner:" },
    ],
    build: (values) => {
      // Option modes (All/Extents/Previous act immediately — see
      // applyOptionKeyword's zoom branch; Scale captures a text factor then
      // completes). Window (W) is the default corner mode: the flag alone
      // re-prompts for the corners.
      const scaleText = optionTextValue(values, "corner1", "S");
      if (scaleText !== null) {
        const m = scaleText.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*(x|X|xp|XP)?$/);
        if (m === null || m[1] === undefined) {
          return plan([], [`ZOOM: '${scaleText}' is not a scale factor — enter a number (n) or nX. No view change.`], []);
        }
        const factor = Number(m[1]);
        if (!(factor > 0)) {
          return plan([], [`ZOOM: scale factor must be positive — '${scaleText}' rejected. No view change.`], []);
        }
        const relative = m[2] !== undefined;
        return plan(
          [],
          [relative ? `ZOOM: scale ${factor}X — ${factor}× the current view.` : `ZOOM: scale ${factor} — ${factor}× the extents fit.`],
          [{ action: "view.zoomScale", payload: { factor, relative } }],
        );
      }
      if (optionTextValue(values, "corner1", "E") !== null || optionTextValue(values, "corner1", "EXT") !== null || optionTextValue(values, "corner1", "EXTENTS") !== null) {
        return plan([], ["ZOOM: fitting extents."], [{ action: "view.zoomExtents" }]);
      }
      if (optionTextValue(values, "corner1", "A") !== null || optionTextValue(values, "corner1", "ALL") !== null) {
        return plan([], ["ZOOM All: no drawing limits defined in this document — fitting extents."], [{ action: "view.zoomExtents" }]);
      }
      if (optionTextValue(values, "corner1", "P") !== null || optionTextValue(values, "corner1", "PREVIOUS") !== null) {
        return plan([], ["ZOOM: restoring previous view."], [{ action: "view.zoomPrevious" }]);
      }
      const corner1 = pointValue(values, "corner1");
      const corner2 = pointValue(values, "corner2");
      // COMPAT-CAD-006: a degenerate window (zero width or height) is
      // rejected HERE — world-intrinsic, viewport-independent: the honest
      // typed failure, no view change, no ui action.
      const wW = Math.abs(corner2[0] - corner1[0]);
      const wH = Math.abs(corner2[1] - corner1[1]);
      if (!(wW > 0) || !(wH > 0)) {
        return plan([], ["ZOOM: window is degenerate (zero width or height) — two different corners required. No view change."], []);
      }
      return plan(
        [],
        [`ZOOM: window (${fmtPoint(corner1)}) → (${fmtPoint(corner2)}).`],
        [{ action: "view.zoomWindow", payload: { corner1: [corner1[0], corner1[1]], corner2: [corner2[0], corner2[1]] } }],
      );
    },
  },
  {
    id: "pan",
    name: "PAN",
    aliases: ["P"],
    label: "Pan",
    description: "Pan the view: specify a base point and a second point (Enter at the second prompt treats the base point as the displacement).",
    category: "view",
    ribbonTab: "View",
    steps: [
      { id: "base", kind: "point", prompt: "Specify base point or displacement:" },
      // COMPAT-CAD-006: Enter at the second point completes the command with
      // the base point alone (AutoCAD's displacement mode: the first entry
      // IS the pan vector).
      { id: "second", kind: "point", prompt: "Specify second point:", optional: true },
    ],
    build: (values) => {
      const base = pointValue(values, "base");
      const secondValue = values["second"];
      if (secondValue === undefined || secondValue.kind !== "point") {
        return plan([], [`PAN: displacement (${fmtPoint(base)}).`], [{ action: "view.pan", payload: { delta: [base[0], base[1]] } }]);
      }
      const delta: Vec2 = [secondValue.point[0] - base[0], secondValue.point[1] - base[1]];
      return plan([], [`PAN: (${fmtPoint(base)}) → (${fmtPoint(secondValue.point)}) — displacement (${fmtPoint(delta)}).`], [{ action: "view.pan", payload: { delta: [delta[0], delta[1]] } }]);
    },
  },
  {
    id: "regen",
    name: "REGEN",
    aliases: ["RE"],
    label: "Regenerate Display",
    description: "Regenerate the viewport display (pure redraw — no document change).",
    category: "view",
    ribbonTab: "View",
    steps: [],
    instant: () =>
      plan([], ["Regenerating model.", "REGEN: display regenerated — no document change."], [{ action: "view.regen" }]),
  },
  {
    id: "layer",
    name: "LAYER",
    aliases: ["LA"],
    label: "Layers palette",
    description: "Open the layers palette.",
    category: "settings",
    ribbonTab: "Home",
    steps: [],
    instant: () => plan([], ["LAYER."], [{ action: "palette.show", payload: { palette: "layers" } }]),
  },
  {
    id: "properties",
    name: "PROPERTIES",
    aliases: ["PR", "CH", "MO"],
    label: "Properties",
    description: "Open the properties inspector.",
    category: "settings",
    ribbonTab: "Home",
    steps: [],
    instant: () => plan([], ["PROPERTIES."], [{ action: "palette.show", payload: { palette: "properties" } }]),
  },
  {
    id: "navigator",
    name: "NAVIGATOR",
    aliases: ["NAV"],
    label: "Navigator",
    description: "Open the project navigator.",
    category: "settings",
    ribbonTab: "View",
    steps: [],
    instant: () => plan([], ["NAVIGATOR."], [{ action: "palette.show", payload: { palette: "navigator" } }]),
  },
  {
    id: "commandsearch",
    name: "COMMANDSEARCH",
    aliases: ["SEARCH"],
    label: "Command search",
    description: "Search every workspace command by name, alias or description.",
    category: "help",
    ribbonTab: "View",
    shortcut: "Ctrl+K",
    steps: [],
    instant: () => plan([], ["COMMANDSEARCH."], [{ action: "palette.show", payload: { palette: "search" } }]),
  },
  {
    id: "help",
    name: "HELP",
    aliases: ["?"],
    label: "Help",
    description: "Open the workspace help surface (commands, shortcuts, aliases).",
    category: "help",
    ribbonTab: "View",
    shortcut: "F1",
    steps: [],
    instant: () => plan([], ["HELP."], [{ action: "palette.show", payload: { palette: "help" } }]),
  },
  {
    id: "workspace",
    name: "WORKSPACE",
    aliases: ["WS"],
    label: "Workspace preset",
    description: "Switch workspace preset (Drafting & Annotation, BIM, Documentation, Compact).",
    category: "settings",
    ribbonTab: "View",
    steps: [],
    instant: () => plan([], ["WORKSPACE."], [{ action: "palette.show", payload: { palette: "workspace" } }]),
  },

  // --- Drafting-aid toggles (status bar) ------------------------------------
  {
    id: "osnap-toggle",
    name: "OSNAP",
    aliases: ["OSNAP"],
    label: "Object snap",
    description: "Toggle object snapping (endpoints, centers, intersections…).",
    category: "settings",
    ribbonTab: "View",
    shortcut: "F3",
    steps: [],
    instant: () => plan([], ["OSNAP toggle."], [{ action: "toggle.osnap" }]),
  },
  {
    id: "grid-toggle",
    name: "GRID",
    aliases: ["GRID"],
    label: "Grid",
    description: "Toggle the drafting grid (document workspace settings).",
    category: "settings",
    ribbonTab: "View",
    shortcut: "F7",
    steps: [],
    instant: () => plan([], ["GRID toggle."], [{ action: "toggle.grid" }]),
  },
  {
    id: "ortho-toggle",
    name: "ORTHO",
    aliases: ["ORTHO"],
    label: "Ortho",
    description: "Toggle orthographic cursor constraint (horizontal/vertical).",
    category: "settings",
    ribbonTab: "View",
    shortcut: "F8",
    steps: [],
    instant: () => plan([], ["ORTHO toggle."], [{ action: "toggle.ortho" }]),
  },
  {
    id: "snap-toggle",
    name: "SNAPMODE",
    aliases: ["SNAP"],
    label: "Snap mode",
    description: "Toggle grid snap stepping.",
    category: "settings",
    ribbonTab: "View",
    shortcut: "F9",
    steps: [],
    instant: () => plan([], ["SNAPMODE toggle."], [{ action: "toggle.snap" }]),
  },
  {
    id: "polar-toggle",
    name: "POLAR",
    aliases: ["POLAR"],
    label: "Polar tracking",
    description: "Toggle polar angle tracking.",
    category: "settings",
    ribbonTab: "View",
    shortcut: "F10",
    steps: [],
    instant: () => plan([], ["POLAR toggle."], [{ action: "toggle.polar" }]),
  },
  {
    id: "otrack-toggle",
    name: "OTRACK",
    aliases: ["OTRACK"],
    label: "Object tracking",
    description: "Toggle object-snap tracking.",
    category: "settings",
    ribbonTab: "View",
    shortcut: "F11",
    steps: [],
    instant: () => plan([], ["OTRACK toggle."], [{ action: "toggle.otrack" }]),
  },
  {
    id: "selectall",
    name: "SELECTALL",
    aliases: ["ALL"],
    label: "Select all",
    description: "Select every pickable entity.",
    category: "modify",
    ribbonTab: "Home",
    shortcut: "Ctrl+A",
    steps: [],
    instant: () => plan([], ["SELECTALL."], [{ action: "selection.selectAll" }]),
  },
  {
    id: "cancel",
    name: "CANCEL",
    aliases: ["CANCEL"],
    label: "Cancel",
    description: "Cancel the running command / clear the selection.",
    category: "modify",
    ribbonTab: "Home",
    shortcut: "Esc",
    steps: [],
    instant: () => plan([], ["CANCEL."], [{ action: "selection.clear" }]),
  },
  // --- CAD-PARITY-003 (Issue #78): the 2D draw/modify vocabulary ---------
  ...COMMANDS_2D,
  ...COMMANDS_PROPS,
  ...COMMANDS_ANNO,
  // --- CAD-PARITY-006 (Issue #84): blocks, attributes & references -------
  ...COMMANDS_BLOCK,
  // --- CAD-PARITY-007 (Issue #86): parametric constraints & patterns ---
  ...COMMANDS_PARAMETRICS,
  // --- CAD-PARITY-008 (Issue #88): layouts, viewports, page setup, plot ---
  ...COMMANDS_LAYOUTS,
  // --- CAD-PARITY-009 (Issue #90): 3D navigation, UCS/workplanes, the
  // bounded modeling vocabulary + section planes ---
  ...COMMANDS_MODEL3D,
  // --- CAD-PARITY-012 (Issue #102): components, materials and coordination
  // (the material records, grid datums, clash/report surfaces and revision
  // clouds) ---
  ...COMMANDS_COORDINATION,
  // --- CAD-PARITY-013 (Issue #104): the documentation production
  // vocabulary — the navigator (View Map folders + Layout Book subsets),
  // layout-book assignment, master layouts, title blocks, revisions,
  // schedules/indexes and publisher sets (ribbonTab "Documentation") ---
  ...COMMANDS_DOCUMENTATION,
  // --- CAD-PARITY-016 (Issue #112): the collaboration/recovery/scale
  // vocabulary — durable versioned recovery checkpoints + deterministic
  // crash/session recovery, project-scoped members/presence/comments/
  // activity, versioned transactions with explicit conflict + merge
  // lineage, the durable background-regeneration jobs, the fresh
  // external-reference status surfaces and the observable performance
  // budgets (ribbonTab "Collab") ---
  ...COMMANDS_COLLAB,
  // --- CAD-PARITY-017 (Issue #116): the automation/extension/API
  // vocabulary — the versioned typed capability discovery surface, the
  // automation principal registration (the authorization hook reusing the
  // P016 role table), the deterministic governed script execution, the
  // bounded scoped event subscriptions and the automation report surfaces
  // (ribbonTab "Automation") ---
  ...COMMANDS_AUTOMATION,
  ...COMMANDS_TOOLSETS,
  // --- COMPAT-CAD-004 (Issue #121): the consolidated parametrics/
  //  associative/patterns vocabulary — the bounded mirror including
  //  symbol instances, the one-revision associative refresh and the
  //  Parametrics workbench surface (ribbonTab "Parametric") ---
  ...COMMANDS_ASSOCIATIVE,
];

function normalize(a: number): number {
  const two = 2 * Math.PI;
  let x = a % two;
  if (x < 0) x += two;
  return x;
}

// ---------------------------------------------------------------------------
// Lookup + search.
// ---------------------------------------------------------------------------

const COMMAND_INDEX: ReadonlyMap<string, WorkspaceCommand> = (() => {
  const index = new Map<string, WorkspaceCommand>();
  for (const command of WORKSPACE_COMMANDS) {
    index.set(command.name.toUpperCase(), command);
    for (const alias of command.aliases) index.set(alias.toUpperCase(), command);
  }
  return index;
})();

export const WORKSPACE_COMMAND_INDEX: ReadonlyMap<string, WorkspaceCommand> = COMMAND_INDEX;

/** Resolve a command-line token (name or alias, case-insensitive). */
export function resolveCommand(token: string): WorkspaceCommand | null {
  const key = token.trim().toUpperCase();
  if (key.length === 0) return null;
  return COMMAND_INDEX.get(key) ?? null;
}

export function commandById(id: string): WorkspaceCommand | null {
  return WORKSPACE_COMMANDS.find((c) => c.id === id) ?? null;
}

export interface CommandSearchHit {
  readonly command: WorkspaceCommand;
  /** Deterministic score for ranking (lower = better). */
  readonly score: number;
}

/**
 * Deterministic command search for the command palette (CAD-P-002):
 * exact name match < name prefix < alias prefix < label prefix < description
 * substring. Ties break on registry order (stable, reproducible).
 */
export function searchCommands(query: string): readonly CommandSearchHit[] {
  const q = query.trim().toUpperCase();
  if (q.length === 0) return WORKSPACE_COMMANDS.map((command) => ({ command, score: 100 }));
  const hits: CommandSearchHit[] = [];
  for (const command of WORKSPACE_COMMANDS) {
    const name = command.name.toUpperCase();
    let score: number | null = null;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (command.aliases.some((a) => a.toUpperCase() === q)) score = 2;
    else if (command.aliases.some((a) => a.toUpperCase().startsWith(q))) score = 3;
    else if (command.label.toUpperCase().startsWith(q)) score = 4;
    else if (name.includes(q)) score = 5;
    else if (command.description.toUpperCase().includes(q)) score = 6;
    if (score !== null) hits.push({ command, score });
  }
  hits.sort((a, b) => (a.score !== b.score ? a.score - b.score : WORKSPACE_COMMANDS.indexOf(a.command) - WORKSPACE_COMMANDS.indexOf(b.command)));
  return hits;
}
