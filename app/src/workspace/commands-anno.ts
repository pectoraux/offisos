/**
 * CAD-PARITY-005 command registry extension (Issue #82) — the annotation,
 * text & dimension vocabulary.
 *
 * Commands:
 *  - TEXT — single-line text: insertion point, height (the style's fixed
 *    height wins when set — the echo says which), rotation, content.
 *  - MTEXT (MT/T) — multi-line text: attachment corner, column width,
 *    content ("\\n" escapes line breaks — there is no wrapping engine in
 *    this slice, an honest documented limitation).
 *  - DIMLINEAR (DLI) — horizontal/vertical/rotated linear dimension: two
 *    extension origins + the dimension line placement; the mode auto-
 *    selects from the placement (AutoCAD's heuristic) or is forced through
 *    the H/V flag options / the R(otation) sub-prompt.
 *  - DIMALIGNED (DAL) — the aligned linear dimension.
 *  - DIMRADIUS (DRA) — radius dimension on a picked circle/arc with the
 *    leader placement (ASSOCIATIVE: measured server-side from the target).
 *  - DIMDIAMETER (DDI) — diameter dimension on a picked circle/arc with
 *    the dimension line direction (ASSOCIATIVE).
 *  - DIMANGULAR (DAN) — angle between two picked lines with the arc
 *    placement selecting the measured sector (ASSOCIATIVE: both legs are
 *    referenced; moving the lines re-measures through the cascade).
 *  - LEADER (LE) — leader spine (multiple points) + optional annotation
 *    text at the end (Enter skips the text).
 *  - MLEADER (MLD) — multileader: arrowhead point, landing point, content.
 *  - DIMTEDIT (DIMTED) — dimension text placement override.
 *  - DIMSCALE — the document annotation scale standard (LTSCALE-class
 *    persisted setting; multiplies every dimension annotation).
 *
 * Every command is pure data + a pure builder emitting App API commands —
 * `annotation.create` / `annotation.update` / `drafting.setSettings`
 * dispatch to the shared annotation core, which measures SERVER-side and
 * never trusts client measurements. The SAME registry drives ribbon,
 * palette, keyboard and command line on BOTH hosts (LOCK-004).
 *
 * Honest scope notes surfaced in the command descriptions and echoes
 * (LOCK-007):
 *  - DIMLINEAR/DIMALIGNED dimensions are POINT-defined (non-associative):
 *    the extension origins are free points; association is the
 *    entity-dimension vocabulary (radius/diameter/angular) and the
 *    annotation.create refs parameter;
 *  - MTEXT does not wrap (explicit "\\n" breaks only);
 *  - LEADER text is a single line; the landing is the fixed 2 × height
 *    convention.
 */

import type { Vec2 } from "../drafting/precision.js";
import type {
  AppApiCommandPlanEntry,
  CommandContext,
  CommandPlan,
  EntityPick,
  PromptStep,
  PromptValue,
} from "./types.js";
import { layerNameOrId } from "./types.js";
import { optionValue } from "./prompt-engine.js";
import { geomFromElement } from "./geometry/bridge.js";
import { lineLine } from "./geometry/math2d.js";
import {
  angularSectorForPlacement,
  autoLinearMode,
  linearOffsetForPlacement,
} from "./annotation/types.js";
import type {
  LinearDimMode,
} from "./annotation/types.js";
import type { WorkspaceCommand } from "./commands.js";
import type { Pt } from "./geometry/math2d.js";
import { dist as distPts } from "./geometry/math2d.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts / commands-2d.ts).
// ---------------------------------------------------------------------------

function plan(
  appApi: readonly AppApiCommandPlanEntry[],
  echo: readonly string[],
): CommandPlan {
  return { appApi, ui: [], echo };
}

function pointValue(values: Readonly<Record<string, PromptValue>>, id: string): Vec2 {
  const v = values[id];
  if (v === undefined || v.kind !== "point") throw new Error(`command builder: step '${id}' has no point`);
  return v.point;
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

function entityPointsValue(
  values: Readonly<Record<string, PromptValue>>,
  id: string,
): readonly { entity: EntityPick; point: Vec2 }[] {
  const v = values[id];
  if (v === undefined || v.kind !== "entityPoints") throw new Error(`command builder: step '${id}' has no entity picks`);
  return v.picks;
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

function fmtPoint(p: Vec2 | Pt): string {
  const q = p as Pt;
  const x = "x" in q ? q.x : (p as Vec2)[0];
  const y = "x" in q ? q.y : (p as Vec2)[1];
  return `${trimNum(x)},${trimNum(y)}`;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

function toPt(v: Vec2): Pt {
  return { x: v[0], y: v[1] };
}

/** The fixed height of a text style (0 when not fixed). */
function styleFixedHeight(ctx: CommandContext, styleName: string): number {
  const style = ctx.textStyles.find((s) => s.name === styleName);
  return style !== undefined ? style.height : 0;
}

/** The canonical geometry of a pick — BOTH storage conventions (the
 *  command-line CIRCLE/LINE commands still emit the COMPAT-CAD-001 layout;
 *  the bridge is the one canonical view over both). */
function geomOfPick(pick: EntityPick): import("./geometry/types.js").Geom | null {
  return geomFromElement({ id: pick.id, kind: "geometry", engineId: null, props: pick.props });
}

/** The circle/arc geometry of a pick (for dimension targets). */
function circleOfPick(pick: EntityPick): { center: Pt; radius: number } | null {
  const geom = geomOfPick(pick);
  if (geom === null) return null;
  if (geom.type === "circle") return { center: { x: geom.cx, y: geom.cy }, radius: geom.r };
  if (geom.type === "arc") return { center: { x: geom.cx, y: geom.cy }, radius: geom.r };
  return null;
}

/** The infinite line of a pick (for angular legs). */
function lineOfPick(pick: EntityPick): { a: Pt; b: Pt } | null {
  const geom = geomOfPick(pick);
  if (geom === null) return null;
  if (geom.type === "line" || geom.type === "ray" || geom.type === "xline") {
    return { a: { x: geom.x1, y: geom.y1 }, b: { x: geom.x2, y: geom.y2 } };
  }
  return null;
}

/** Validate a dimension-target pick (circle/arc). */
function validateCirclePick(pick: EntityPick): string | null {
  if (pick.kind === "bim") return "Select a 2D circle or arc.";
  if (circleOfPick(pick) === null) return "Dimension targets must be a circle or arc.";
  return null;
}

/** Validate a line pick (angular legs). */
function validateLinePick(pick: EntityPick): string | null {
  if (pick.kind === "bim") return "Select a 2D line, ray or construction line.";
  if (lineOfPick(pick) === null) return "Angular dimension legs must be lines (line/ray/xline).";
  return null;
}

/** Validate a dimension annotation pick (DIMTEDIT). */
function validateDimPick(pick: EntityPick): string | null {
  const props = pick.props as Record<string, unknown>;
  if (props.annotation === true && typeof props.type === "string" && props.type.startsWith("dim-")) {
    return null;
  }
  return "Select a dimension annotation.";
}

/** Expand literal "\\n" escapes into real line breaks (the typed multi-line
 *  convention — documented). */
function expandLines(text: string): string {
  return text.replace(/\\n/g, "\n");
}

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export const COMMANDS_ANNO: readonly WorkspaceCommand[] = [
  {
    id: "text",
    name: "TEXT",
    aliases: ["DT"],
    label: "Text",
    description:
      "Create single-line text: insertion point, height (the style's fixed height wins when set), rotation, content.",
    category: "draw",
    ribbonTab: "Annotate",
    steps: [
      { id: "start", kind: "point", prompt: "Specify start point of text:" },
      { id: "height", kind: "number", prompt: "Specify height:", defaultValue: 2.5 },
      { id: "rotation", kind: "number", prompt: "Specify rotation angle <0>:", defaultValue: 0 },
      { id: "value", kind: "text", prompt: "Enter text:" },
    ],
    build: (values, ctx) => {
      const start = pointValue(values, "start");
      const fixed = styleFixedHeight(ctx, ctx.currentTextStyle);
      const typedHeight = numberValue(values, "height", 2.5);
      const height = fixed > 0 ? fixed : typedHeight;
      const rotation = numberValue(values, "rotation", 0) * DEG;
      const value = textValue(values, "value");
      return plan(
        [
          {
            name: "annotation.create",
            payload: {
              entities: [
                {
                  type: "text",
                  layer: ctx.activeLayer,
                  x: start[0],
                  y: start[1],
                  height,
                  rotation,
                  value,
                  style: ctx.currentTextStyle,
                },
              ],
            },
          },
        ],
        [
          `TEXT: "${value}" at (${fmtPoint(start)}), height ${trimNum(height)}${fixed > 0 ? ` (fixed by style '${ctx.currentTextStyle}')` : ""}, rotation ${trimNum(rotation / DEG)}° on layer '${layerNameOrId(ctx, ctx.activeLayer)}'.`,
        ],
      );
    },
  },
  {
    id: "mtext",
    name: "MTEXT",
    aliases: ["MT", "T"],
    label: "MText",
    description:
      "Create multi-line text: attachment corner, column width, content (\\n escapes line breaks - no wrapping in this build).",
    category: "draw",
    ribbonTab: "Annotate",
    steps: [
      { id: "corner", kind: "point", prompt: "Specify first corner of the text block:" },
      { id: "width", kind: "distance", prompt: "Specify the column width:", baseStep: "corner" },
      { id: "value", kind: "text", prompt: "Enter text (\\\\n = line break):" },
    ],
    build: (values, ctx) => {
      const corner = pointValue(values, "corner");
      const v = values.width;
      const width = v !== undefined && v.kind === "distance" ? v.distance : NaN;
      if (!(width > 0)) throw new Error("MTEXT requires a positive column width");
      const fixed = styleFixedHeight(ctx, ctx.currentTextStyle);
      const height = fixed > 0 ? fixed : 2.5;
      const value = expandLines(textValue(values, "value"));
      return plan(
        [
          {
            name: "annotation.create",
            payload: {
              entities: [
                {
                  type: "mtext",
                  layer: ctx.activeLayer,
                  x: corner[0],
                  y: corner[1],
                  height,
                  width,
                  rotation: 0,
                  value,
                  style: ctx.currentTextStyle,
                },
              ],
            },
          },
        ],
        [
          `MTEXT: ${value.split("\n").length} line(s) at (${fmtPoint(corner)}), width ${trimNum(width)}, height ${trimNum(height)}${fixed > 0 ? ` (fixed by style '${ctx.currentTextStyle}')` : ""} on layer '${layerNameOrId(ctx, ctx.activeLayer)}'.`,
        ],
      );
    },
  },
  {
    id: "dimlinear",
    name: "DIMLINEAR",
    aliases: ["DLI", "DIMLIN"],
    label: "Linear dimension",
    description:
      "Dimension the distance between two extension line origins (horizontal/vertical auto-selected from the placement; H/V force, R rotates). Point-defined (non-associative).",
    category: "draw",
    ribbonTab: "Annotate",
    steps: [
      { id: "p1", kind: "point", prompt: "Specify first extension line origin:" },
      { id: "p2", kind: "point", prompt: "Specify second extension line origin:" },
      {
        id: "placement",
        kind: "point",
        prompt: "Specify dimension line location or [H/V/R] (H/V force the orientation, R rotates):",
        options: [
          { keyword: "H", label: "Horizontal", flag: true },
          { keyword: "V", label: "Vertical", flag: true },
          { keyword: "R", label: "Rotated", input: "number", optionPrompt: "Specify the dimension line angle (degrees):", defaultValue: 0 },
        ],
      },
    ],
    build: (values, ctx) => {
      const p1 = toPt(pointValue(values, "p1"));
      const p2 = toPt(pointValue(values, "p2"));
      const placement = toPt(pointValue(values, "placement"));
      const hOpt = optionValue(values, "placement", "H");
      const vOpt = optionValue(values, "placement", "V");
      const rOpt = optionValue(values, "placement", "R");
      let mode: LinearDimMode;
      let angle: number | undefined;
      if (hOpt !== null) mode = "horizontal";
      else if (vOpt !== null) mode = "vertical";
      else if (rOpt !== null && rOpt.kind === "number") {
        mode = "rotated";
        angle = rOpt.value * DEG;
      } else mode = autoLinearMode(p1, p2, placement);
      const offset = linearOffsetForPlacement(p1, p2, mode, angle, placement);
      return plan(
        [
          {
            name: "annotation.create",
            payload: {
              entities: [
                {
                  type: "dim-linear",
                  layer: ctx.activeLayer,
                  p1,
                  p2,
                  mode,
                  ...(angle !== undefined ? { angle } : {}),
                  offset,
                  style: ctx.currentDimStyle,
                },
              ],
            },
          },
        ],
        [
          `DIMLINEAR: (${fmtPoint(p1)}) → (${fmtPoint(p2)}), mode ${mode}${angle !== undefined ? ` @ ${trimNum(angle / DEG)}°` : ""}, offset ${trimNum(offset)} — measured server-side.`,
        ],
      );
    },
  },
  {
    id: "dimaligned",
    name: "DIMALIGNED",
    aliases: ["DAL", "DIMALI", "AL"],
    label: "Aligned dimension",
    description:
      "Dimension the true distance between two points along their direction (the dimension line is parallel to p1→p2). Point-defined (non-associative).",
    category: "draw",
    ribbonTab: "Annotate",
    steps: [
      { id: "p1", kind: "point", prompt: "Specify first extension line origin:" },
      { id: "p2", kind: "point", prompt: "Specify second extension line origin:" },
      { id: "placement", kind: "point", prompt: "Specify dimension line location:" },
    ],
    build: (values, ctx) => {
      const p1 = toPt(pointValue(values, "p1"));
      const p2 = toPt(pointValue(values, "p2"));
      const placement = toPt(pointValue(values, "placement"));
      const offset = linearOffsetForPlacement(p1, p2, "aligned", undefined, placement);
      return plan(
        [
          {
            name: "annotation.create",
            payload: {
              entities: [
                {
                  type: "dim-linear",
                  layer: ctx.activeLayer,
                  p1,
                  p2,
                  mode: "aligned",
                  offset,
                  style: ctx.currentDimStyle,
                },
              ],
            },
          },
        ],
        [
          `DIMALIGNED: (${fmtPoint(p1)}) → (${fmtPoint(p2)}), offset ${trimNum(offset)} — measured server-side.`,
        ],
      );
    },
  },
  {
    id: "dimradius",
    name: "DIMRADIUS",
    aliases: ["DRA", "DIMRAD"],
    label: "Radius dimension",
    description:
      "Dimension the radius of a circle or arc: pick the target, then the leader placement. ASSOCIATIVE — measured from the referenced entity, re-measured when it changes.",
    category: "draw",
    ribbonTab: "Annotate",
    steps: [
      { id: "target", kind: "entity", prompt: "Select a circle or arc:", validate: validateCirclePick },
      { id: "placement", kind: "point", prompt: "Specify the leader placement:" },
    ],
    build: (values, ctx) => {
      const target = entitiesValue(values, "target")[0];
      if (target === undefined) throw new Error("DIMRADIUS requires a target.");
      const placement = toPt(pointValue(values, "placement"));
      return plan(
        [
          {
            name: "annotation.create",
            payload: {
              entities: [
                {
                  type: "dim-radius",
                  layer: ctx.activeLayer,
                  target: target.id,
                  at: placement,
                  style: ctx.currentDimStyle,
                },
              ],
            },
          },
        ],
        [`DIMRADIUS: '${target.id}' — measured server-side from the referenced geometry (associative).`],
      );
    },
  },
  {
    id: "dimdiameter",
    name: "DIMDIAMETER",
    aliases: ["DDI", "DIMDIA"],
    label: "Diameter dimension",
    description:
      "Dimension the diameter of a circle or arc: pick the target, then a point giving the dimension line direction. ASSOCIATIVE.",
    category: "draw",
    ribbonTab: "Annotate",
    steps: [
      { id: "target", kind: "entity", prompt: "Select a circle or arc:", validate: validateCirclePick },
      { id: "placement", kind: "point", prompt: "Specify the dimension line direction (a point):" },
    ],
    build: (values, ctx) => {
      const target = entitiesValue(values, "target")[0];
      if (target === undefined) throw new Error("DIMDIAMETER requires a target.");
      const circle = circleOfPick(target);
      if (circle === null) throw new Error("DIMDIAMETER target must be a circle or arc.");
      const placement = toPt(pointValue(values, "placement"));
      const angle = Math.atan2(placement.y - circle.center.y, placement.x - circle.center.x);
      return plan(
        [
          {
            name: "annotation.create",
            payload: {
              entities: [
                {
                  type: "dim-diameter",
                  layer: ctx.activeLayer,
                  target: target.id,
                  angle,
                  style: ctx.currentDimStyle,
                },
              ],
            },
          },
        ],
        [`DIMDIAMETER: '${target.id}' at ${trimNum(angle / DEG)}° — measured server-side (associative).`],
      );
    },
  },
  {
    id: "dimangular",
    name: "DIMANGULAR",
    aliases: ["DAN", "DIMANG"],
    label: "Angular dimension",
    description:
      "Dimension the angle between two lines: pick each line, then the arc placement (the placement selects the measured sector). ASSOCIATIVE — both legs are referenced.",
    category: "draw",
    ribbonTab: "Annotate",
    steps: [
      { id: "line1", kind: "entityPoint", prompt: "Select first line:", validate: validateLinePick },
      { id: "line2", kind: "entityPoint", prompt: "Select second line:", validate: validateLinePick },
      { id: "placement", kind: "point", prompt: "Specify the arc placement (selects the measured sector):" },
    ],
    build: (values, ctx) => {
      const picks = entityPointsValue(values, "line1").concat(entityPointsValue(values, "line2"));
      const pick1 = picks[0];
      const pick2 = picks[1];
      if (pick1 === undefined || pick2 === undefined) throw new Error("DIMANGULAR requires two line picks.");
      const line1 = lineOfPick(pick1.entity);
      const line2 = lineOfPick(pick2.entity);
      if (line1 === null || line2 === null) throw new Error("DIMANGULAR legs must be lines.");
      const d1: Pt = { x: line1.b.x - line1.a.x, y: line1.b.y - line1.a.y };
      const d2: Pt = { x: line2.b.x - line2.a.x, y: line2.b.y - line2.a.y };
      const vertex = lineLine(line1.a, d1, line2.a, d2);
      if (vertex === null) {
        throw new Error("The two lines are parallel — there is no angle to measure.");
      }
      // Leg ray directions: the HALF-LINE of each picked line that contains
      // the pick (the pick selects the SIDE, not the direction — robust to
      // pick-point rounding; the angle is between the LINES, AutoCAD-class).
      const len1 = Math.hypot(d1.x, d1.y);
      const len2 = Math.hypot(d2.x, d2.y);
      const side1 = (pick1.point[0] - vertex.x) * d1.x + (pick1.point[1] - vertex.y) * d1.y >= 0 ? 1 : -1;
      const side2 = (pick2.point[0] - vertex.x) * d2.x + (pick2.point[1] - vertex.y) * d2.y >= 0 ? 1 : -1;
      const leg1Dir: Pt = { x: (d1.x / len1) * side1, y: (d1.y / len1) * side1 };
      const leg2Dir: Pt = { x: (d2.x / len2) * side2, y: (d2.y / len2) * side2 };
      const placement = toPt(pointValue(values, "placement"));
      const [startAngle, endAngle] = angularSectorForPlacement(vertex, leg1Dir, leg2Dir, placement);
      const radius = Math.max(distPts({ x: placement.x, y: placement.y }, vertex), 10);
      // Leg anchors: the endpoint each ray points toward (association).
      const anchorOf = (side: number): "start" | "end" => (side > 0 ? "end" : "start");
      return plan(
        [
          {
            name: "annotation.create",
            payload: {
              entities: [
                {
                  type: "dim-angular",
                  layer: ctx.activeLayer,
                  vertex,
                  startAngle,
                  endAngle,
                  radius,
                  style: ctx.currentDimStyle,
                  refs: [
                    { id: pick1.entity.id, anchor: anchorOf(side1), to: "leg1" },
                    { id: pick2.entity.id, anchor: anchorOf(side2), to: "leg2" },
                  ],
                },
              ],
            },
          },
        ],
        [
          `DIMANGULAR: lines '${pick1.entity.id}' + '${pick2.entity.id}' — sector selected by the placement (associative, re-measured when the legs move).`,
        ],
      );
    },
  },
  {
    id: "leader",
    name: "LEADER",
    aliases: ["LE"],
    label: "Leader",
    description:
      "Draw a leader: arrowhead point, spine points (Enter finishes), then optional annotation text (Enter skips).",
    category: "draw",
    ribbonTab: "Annotate",
    steps: [
      {
        id: "points",
        kind: "point",
        prompt: "Specify next leader point (Enter finishes):",
        optional: true,
        multiple: true,
        minInputs: 2,
      },
      { id: "value", kind: "text", prompt: "Enter annotation text (Enter skips):", optional: true },
    ],
    build: (values, ctx) => {
      const pts = pointsValue(values, "points").map(toPt);
      if (pts.length < 2) throw new Error("LEADER needs at least two points (arrowhead + one more).");
      const raw = textValue(values, "value", "");
      const value = raw.trim().length > 0 ? raw.trim() : undefined;
      return plan(
        [
          {
            name: "annotation.create",
            payload: {
              entities: [
                {
                  type: "leader",
                  layer: ctx.activeLayer,
                  points: pts,
                  ...(value !== undefined ? { value } : {}),
                  style: ctx.currentTextStyle,
                },
              ],
            },
          },
        ],
        [
          `LEADER: ${pts.length} points${value !== undefined ? `, annotation "${value}"` : " (no text)"} on layer '${layerNameOrId(ctx, ctx.activeLayer)}'.`,
        ],
      );
    },
  },
  {
    id: "mleader",
    name: "MLEADER",
    aliases: ["MLD"],
    label: "Multileader",
    description:
      "Draw a multileader: arrowhead point, landing point, then the content block (\\n escapes line breaks).",
    category: "draw",
    ribbonTab: "Annotate",
    steps: [
      { id: "arrow", kind: "point", prompt: "Specify the leader arrowhead point:" },
      { id: "landing", kind: "point", prompt: "Specify the landing point:" },
      { id: "value", kind: "text", prompt: "Enter content (\\\\n = line break):" },
    ],
    build: (values, ctx) => {
      const arrow = toPt(pointValue(values, "arrow"));
      const landing = toPt(pointValue(values, "landing"));
      const value = expandLines(textValue(values, "value"));
      return plan(
        [
          {
            name: "annotation.create",
            payload: {
              entities: [
                {
                  type: "mleader",
                  layer: ctx.activeLayer,
                  arrow,
                  landing,
                  value,
                  style: ctx.currentTextStyle,
                },
              ],
            },
          },
        ],
        [
          `MLEADER: (${fmtPoint(arrow)}) → (${fmtPoint(landing)}), ${value.split("\n").length} content line(s) on layer '${layerNameOrId(ctx, ctx.activeLayer)}'.`,
        ],
      );
    },
  },
  {
    id: "dimtedit",
    name: "DIMTEDIT",
    aliases: ["DIMTED"],
    label: "Dimension text position",
    description: "Move a dimension's text: pick the dimension, then its new text position.",
    category: "modify",
    ribbonTab: "Annotate",
    steps: [
      { id: "dim", kind: "entity", prompt: "Select a dimension:", validate: validateDimPick },
      { id: "position", kind: "point", prompt: "Specify the new text position:" },
    ],
    build: (values) => {
      const dim = entitiesValue(values, "dim")[0];
      if (dim === undefined) throw new Error("DIMTEDIT requires a dimension.");
      const position = toPt(pointValue(values, "position"));
      return plan(
        [
          {
            name: "annotation.update",
            payload: { ids: [dim.id], patch: { textPos: position } },
          },
        ],
        [`DIMTEDIT: '${dim.id}' text moved to (${fmtPoint(position)}).`],
      );
    },
  },
  {
    id: "dimscale",
    name: "DIMSCALE",
    aliases: [],
    label: "Annotation scale",
    description:
      "Set the document annotation scale (multiplies every dimension annotation's text height and arrow size; 1 = unscaled).",
    category: "settings",
    ribbonTab: "Annotate",
    steps: [
      { id: "scale", kind: "number", prompt: "Specify the annotation scale (positive number):", defaultValue: 1 },
    ],
    build: (values) => {
      const scale = numberValue(values, "scale", 1);
      if (!(scale > 0)) throw new Error("DIMSCALE requires a positive scale factor.");
      return plan(
        [
          {
            name: "drafting.setSettings",
            payload: { settings: { standards: { annotationScale: scale } } },
          },
        ],
        [`DIMSCALE: annotation scale set to ${trimNum(scale)} (applies to every dimension annotation).`],
      );
    },
  },
];
