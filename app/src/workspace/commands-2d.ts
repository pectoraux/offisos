/**
 * CAD-PARITY-003 command registry extension (Issue #78) — the 2D
 * draw/modify vocabulary over the canonical geometry view.
 *
 * Draw (CAD-2D-001): ELLIPSE, SPLINE, POINT, RAY, XLINE, REGION (LINE/
 * POLYLINE/CIRCLE/ARC remain the CAD-PARITY-002 commands; PLINE is added
 * as a POLYLINE alias per the work-order vocabulary).
 * Modify (CAD-2D-002): ROTATE, SCALE, MIRROR, OFFSET, TRIM, EXTEND,
 * STRETCH, FILLET, CHAMFER, BREAK, JOIN, EXPLODE (MOVE/COPY/ERASE remain
 * the CAD-PARITY-002 commands, extended to route canonical entities).
 *
 * Every command is pure data + a pure builder emitting App API commands —
 * `entity.create` / `entity.modify` dispatch to the shared entity-ops
 * semantic core (workspace/entity-ops.ts), which applies the deterministic
 * 2D kernel on canonical geometry loaded through the bridge. The SAME
 * registry drives ribbon, palette, keyboard and command line on BOTH
 * hosts (LOCK-004; no host-specific command implementations).
 *
 * Honest scope notes surfaced in the command descriptions and the command
 * line itself (typed declines — LOCK-007):
 * - TRIM/EXTEND/BREAK exclude ellipse/spline/region targets (the kernel
 *   reports the typed limitation);
 * - OFFSET excludes ellipse/spline;
 * - FILLET/CHAMFER corners are line-pair corners (circle/arc pairs are
 *   typed-declined); SPLINE is control-point based (not fit-point);
 * - ROTATE/SCALE Reference mode (R) and COPY Multiple placement (M) are
 *   explicit typed declines at their input steps (the command keeps
 *   running — the supported/unsupported surface is never silent);
 * - FILLET radius / CHAMFER distances apply per run: the echo states that
 *   persistence across commands is not supported in this build.
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
import { optionValue } from "./prompt-engine.js";
import { geomFromElement, isDraftingGeometry } from "./geometry/bridge.js";
import { regionFromGeom } from "./geometry/editops.js";
import { GeomOpError } from "./geometry/fillet.js";
import type { Geom } from "./geometry/types.js";
import { dist as distPts, sub } from "./geometry/math2d.js";
import type { Pt } from "./geometry/math2d.js";
import type { WorkspaceCommand } from "./commands.js";
import type { ElementKind } from "../contracts/caddocument.js";

// ---------------------------------------------------------------------------
// Local helpers (same conventions as commands.ts).
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

function fmtPoint(p: Vec2): string {
  return `${trimNum(p[0])},${trimNum(p[1])}`;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

function toPt(v: Vec2): Pt {
  return { x: v[0], y: v[1] };
}

/** Load the canonical geometry of a picked drafting entity (bridge view).
 *  Throws with an actionable message when the pick is outside the 2D
 *  vocabulary (annotations, BIM elements — LOCK-007 explicit rejection). */
function geomOfPick(pick: EntityPick): Geom {
  const kind: ElementKind = pick.kind === "geometry" || pick.kind === "bim" || pick.kind === "annotation" ? pick.kind : "geometry";
  const geom = geomFromElement({
    id: pick.id,
    kind,
    engineId: null,
    props: pick.props,
  });
  if (geom === null) {
    throw new Error(
      `'${pick.id}' is not part of the 2D drawing vocabulary (annotations and BIM elements are excluded from CAD-2D modify commands).`,
    );
  }
  return geom;
}

/** Validate a drafting pick for the CAD-2D modify vocabulary (rejects
 *  annotations and BIM entities with an actionable message). */
function validate2dPick(pick: EntityPick): string | null {
  if (pick.kind === "bim") {
    return "BIM elements are authored through the BIM commands — CAD-2D modify operations accept 2D drawing entities.";
  }
  const pickKind: ElementKind = pick.kind === "geometry" || pick.kind === "bim" || pick.kind === "annotation" ? pick.kind : "geometry";
  if (!isDraftingGeometry({ id: pick.id, kind: pickKind, engineId: null, props: pick.props })) {
    if (pick.kind === "annotation" || (pick.props as Record<string, unknown>).type === "dim-linear" || (pick.props as Record<string, unknown>).type === "dim-radius") {
      return "Annotations are not part of the CAD-2D modify vocabulary.";
    }
    return "Select a 2D drawing entity.";
  }
  return null;
}

const OBJECTS_STEP: PromptStep = {
  id: "objects",
  kind: "entity",
  prompt: "Select objects:",
  optional: true,
  multiple: true,
  minInputs: 1,
  validate: validate2dPick,
};

// ---------------------------------------------------------------------------
// The CAD-PARITY-003 registry.
// ---------------------------------------------------------------------------

export const COMMANDS_2D: readonly WorkspaceCommand[] = [
  // --- Draw (CAD-2D-001) ------------------------------------------------------

  {
    id: "ellipse",
    name: "ELLIPSE",
    aliases: ["EL"],
    label: "Ellipse",
    description:
      "Draw an ellipse: center, endpoint of one axis (defines its length + rotation), endpoint of the other axis (perpendicular distance).",
    category: "draw",
    ribbonTab: "Home",
    steps: [
      { id: "center", kind: "point", prompt: "Specify center point:" },
      { id: "axisEnd", kind: "point", prompt: "Specify endpoint of first axis:" },
      { id: "otherEnd", kind: "point", prompt: "Specify endpoint of second axis (perpendicular distance):" },
    ],
    build: (values, ctx) => {
      const center = toPt(pointValue(values, "center"));
      const axisEnd = toPt(pointValue(values, "axisEnd"));
      const otherEnd = toPt(pointValue(values, "otherEnd"));
      const axis = sub(axisEnd, center);
      const rx = Math.hypot(axis.x, axis.y);
      if (rx <= 1e-9) throw new Error("ELLIPSE: axis endpoint coincides with the center.");
      // Perpendicular half-length of the second axis.
      const axisLen = rx;
      const crossV = (otherEnd.x - center.x) * (axis.y / axisLen) - (otherEnd.y - center.y) * (axis.x / axisLen);
      const ry = Math.abs(crossV);
      if (ry <= 1e-9) throw new Error("ELLIPSE: second axis endpoint lies on the first axis — perpendicular distance is zero.");
      const rotation = Math.atan2(axis.y, axis.x);
      return plan(
        [
          {
            name: "entity.create",
            payload: {
              entities: [
                {
                  type: "ellipse",
                  layer: ctx.activeLayer,
                  cx: center.x,
                  cy: center.y,
                  rx,
                  ry,
                  rotation,
                },
              ],
            },
          },
        ],
        [`ELLIPSE: center (${fmtPoint(pointValue(values, "center"))}), axes ${trimNum(rx)} × ${trimNum(ry)} on layer '${ctx.activeLayer}'.`],
      );
    },
  },
  {
    id: "spline",
    name: "SPLINE",
    aliases: ["SPL"],
    label: "Spline",
    description:
      "Draw a control-point spline: pick control points (min 2); Enter finishes. Clamped uniform cubic B-spline (degree = min(3, n-1)).",
    category: "draw",
    ribbonTab: "Home",
    steps: [
      { id: "start", kind: "point", prompt: "Specify first control point:" },
      {
        id: "next",
        kind: "point",
        prompt: "Specify next control point or [Close]:",
        multiple: true,
        optional: true,
        minInputs: 1,
        options: [{ keyword: "C", label: "Close" }],
      },
    ],
    build: (values, ctx) => {
      const start = pointValue(values, "start");
      const rest = pointsValue(values, "next");
      const controlPoints = [start, ...rest].map(toPt);
      const closed = textValue(values, "closed", "") === "C";
      const pts = closed ? [...controlPoints, controlPoints[0]!] : controlPoints;
      if (pts.length < 2) throw new Error("SPLINE needs at least two control points.");
      const degree = Math.min(3, pts.length - 1);
      return plan(
        [
          {
            name: "entity.create",
            payload: {
              entities: [
                {
                  type: "spline",
                  layer: ctx.activeLayer,
                  controlPoints: pts.map((p) => ({ x: p.x, y: p.y })),
                  degree,
                },
              ],
            },
          },
        ],
        [`SPLINE: ${pts.length} control points (degree ${degree}${closed ? ", closed" : ""}) on layer '${ctx.activeLayer}'.`],
      );
    },
  },
  {
    id: "point",
    name: "POINT",
    aliases: ["PO"],
    label: "Point",
    description: "Place a point entity (node) at the picked position.",
    category: "draw",
    ribbonTab: "Home",
    steps: [{ id: "position", kind: "point", prompt: "Specify point position:" }],
    build: (values, ctx) => {
      const p = pointValue(values, "position");
      return plan(
        [
          {
            name: "entity.create",
            payload: { entities: [{ type: "point", layer: ctx.activeLayer, x: p[0], y: p[1] }] },
          },
        ],
        [`POINT: (${fmtPoint(p)}) on layer '${ctx.activeLayer}'.`],
      );
    },
  },
  {
    id: "ray",
    name: "RAY",
    aliases: [],
    label: "Ray",
    description: "Draw a half-infinite ray: base point, then through points (one base, many directions; Enter finishes).",
    category: "draw",
    ribbonTab: "Home",
    chained: true,
    chainKeep: true,
    steps: [
      { id: "base", kind: "point", prompt: "Specify ray base point:" },
      { id: "through", kind: "point", prompt: "Specify ray through point:" },
    ],
    build: (values, ctx) => {
      const base = toPt(pointValue(values, "base"));
      const through = toPt(pointValue(values, "through"));
      if (distPts(base, through) <= 1e-9) throw new Error("RAY needs a direction — through point must differ from the base.");
      return plan(
        [
          {
            name: "entity.create",
            payload: {
              entities: [{ type: "ray", layer: ctx.activeLayer, x1: base.x, y1: base.y, x2: through.x, y2: through.y }],
            },
          },
        ],
        [`RAY: base (${fmtPoint(pointValue(values, "base"))}) → (${fmtPoint(pointValue(values, "through"))}).`],
      );
    },
  },
  {
    id: "xline",
    name: "XLINE",
    aliases: ["XL"],
    label: "Construction Line",
    description: "Draw an infinite construction line: base point, then through points (one base, many directions; Enter finishes).",
    category: "draw",
    ribbonTab: "Home",
    chained: true,
    chainKeep: true,
    steps: [
      { id: "base", kind: "point", prompt: "Specify construction line base point:" },
      { id: "through", kind: "point", prompt: "Specify construction line through point:" },
    ],
    build: (values, ctx) => {
      const base = toPt(pointValue(values, "base"));
      const through = toPt(pointValue(values, "through"));
      if (distPts(base, through) <= 1e-9) throw new Error("XLINE needs a direction — through point must differ from the base.");
      return plan(
        [
          {
            name: "entity.create",
            payload: {
              entities: [{ type: "xline", layer: ctx.activeLayer, x1: base.x, y1: base.y, x2: through.x, y2: through.y }],
            },
          },
        ],
        [`XLINE: base (${fmtPoint(pointValue(values, "base"))}) → (${fmtPoint(pointValue(values, "through"))}).`],
      );
    },
  },
  {
    id: "region",
    name: "REGION",
    aliases: ["REG"],
    label: "Region",
    description:
      "Create a region (closed 2D area with computed area/perimeter/centroid) from closed profiles: circles, ellipses, closed polylines, rectangles.",
    category: "draw",
    ribbonTab: "Home",
    steps: [
      {
        id: "objects",
        kind: "entity",
        prompt: "Select closed profiles to convert:",
        multiple: true,
        optional: true,
        minInputs: 1,
        validate: validate2dPick,
      },
    ],
    build: (values, ctx) => {
      const objects = entitiesValue(values, "objects");
      if (objects.length === 0) throw new Error("REGION requires at least one closed profile.");
      const entities: Record<string, unknown>[] = [];
      const skipped: string[] = [];
      for (const pick of objects) {
        try {
          const geom = geomOfPick(pick);
          const region = regionFromGeom(geom);
          entities.push({ ...region, layer: ctx.activeLayer });
        } catch (err) {
          if (err instanceof GeomOpError) skipped.push(err.message);
          else throw err;
        }
      }
      if (entities.length === 0) {
        throw new Error(`No regions created: ${skipped.join("; ")}`);
      }
      return plan(
        [{ name: "entity.create", payload: { entities } }],
        [
          `REGION: ${entities.length} region${entities.length === 1 ? "" : "s"} created on layer '${ctx.activeLayer}'${skipped.length > 0 ? `; skipped: ${skipped.join("; ")}` : ""}.`,
        ],
      );
    },
  },

  // --- Modify (CAD-2D-002) ----------------------------------------------------

  {
    id: "rotate",
    name: "ROTATE",
    aliases: ["RO"],
    label: "Rotate",
    description:
      "Rotate objects around a base point by a typed angle (degrees, CCW) or a picked base→cursor angle. Reference mode (R) is not supported in this build (typed decline).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      OBJECTS_STEP,
      { id: "base", kind: "point", prompt: "Specify base point:" },
      {
        id: "angle",
        kind: "number",
        prompt: "Specify rotation angle in degrees (CCW), or pick the direction:",
        baseStep: "base",
        options: [
          {
            keyword: "R",
            label: "Reference (unsupported in this build)",
            unsupported:
              "ROTATE Reference mode is not supported in this build — specify the angle directly (typed degrees or a base→cursor pick).",
          },
        ],
      },
    ],
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      const base = toPt(pointValue(values, "base"));
      const angleDeg = numberValue(values, "angle");
      if (!Number.isFinite(angleDeg)) throw new Error("ROTATE requires a finite angle.");
      const angle = (angleDeg * Math.PI) / 180;
      return plan(
        [
          {
            name: "entity.modify",
            payload: { op: "rotate", ids: objects.map((o) => o.id), base, angle },
          },
        ],
        [`ROTATE: ${objects.length} object(s) ${trimNum(angleDeg)}° about (${fmtPoint(pointValue(values, "base"))}).`],
      );
    },
  },
  {
    id: "scale",
    name: "SCALE",
    aliases: ["SC"],
    label: "Scale",
    description:
      "Scale objects about a base point by a typed positive factor. Reference mode (R) is not supported in this build (typed decline).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      OBJECTS_STEP,
      { id: "base", kind: "point", prompt: "Specify base point:" },
      {
        id: "factor",
        kind: "number",
        prompt: "Specify scale factor (positive):",
        options: [
          {
            keyword: "R",
            label: "Reference (unsupported in this build)",
            unsupported:
              "SCALE Reference mode is not supported in this build — specify the factor directly (typed positive number).",
          },
        ],
      },
    ],
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      const base = toPt(pointValue(values, "base"));
      const factor = numberValue(values, "factor");
      if (!(factor > 0)) throw new Error("SCALE requires a positive factor.");
      return plan(
        [
          {
            name: "entity.modify",
            payload: { op: "scale", ids: objects.map((o) => o.id), base, factor },
          },
        ],
        [`SCALE: ${objects.length} object(s) ×${trimNum(factor)} about (${fmtPoint(pointValue(values, "base"))}).`],
      );
    },
  },
  {
    id: "mirror",
    name: "MIRROR",
    aliases: ["MI"],
    label: "Mirror",
    description: "Mirror objects across a two-point axis; keep or erase the source (Y/N, default keep).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      OBJECTS_STEP,
      { id: "p1", kind: "point", prompt: "Specify first point of mirror axis:" },
      { id: "p2", kind: "point", prompt: "Specify second point of mirror axis:" },
      {
        id: "eraseSource",
        kind: "text",
        prompt: "Erase source objects? [Yes/No] <No>:",
        defaultValue: "N",
      },
    ],
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      const p1 = toPt(pointValue(values, "p1"));
      const p2 = toPt(pointValue(values, "p2"));
      const answer = textValue(values, "eraseSource", "N").toUpperCase();
      if (answer !== "Y" && answer !== "N" && answer !== "YES" && answer !== "NO") {
        throw new Error("MIRROR: answer Y (erase source) or N (keep source).");
      }
      const eraseSource = answer === "Y" || answer === "YES";
      if (distPts(p1, p2) <= 1e-9) throw new Error("MIRROR: axis needs two distinct points.");
      return plan(
        [
          {
            name: "entity.modify",
            payload: { op: "mirror", ids: objects.map((o) => o.id), p1, p2, eraseSource },
          },
        ],
        [`MIRROR: ${objects.length} object(s) across (${fmtPoint(pointValue(values, "p1"))})–(${fmtPoint(pointValue(values, "p2"))})${eraseSource ? " (source erased)" : " (source kept)"}.`],
      );
    },
  },
  {
    id: "offset",
    name: "OFFSET",
    aliases: ["O"],
    label: "Offset",
    description:
      "Create a parallel copy at a typed distance on the picked side (T = through a point). Lines, rays, xlines, circles, arcs, polylines; ellipse/spline are excluded (typed limitation).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      {
        id: "distance",
        kind: "number",
        prompt: "Specify offset distance or [Through]:",
        options: [
          {
            keyword: "T",
            label: "Through point",
            input: "point",
            optionPrompt: "Specify through point:",
          },
        ],
      },
      { id: "object", kind: "entity", prompt: "Select object to offset:", validate: validate2dPick },
      { id: "side", kind: "point", prompt: "Specify point on side to offset (or the through point):" },
    ],
    build: (values) => {
      const object = entitiesValue(values, "object")[0];
      if (object === undefined) throw new Error("OFFSET requires an object.");
      const side = toPt(pointValue(values, "side"));
      const throughOpt = optionValue(values, "distance", "T");
      const through = throughOpt !== null && throughOpt.kind === "point";
      const distance = numberValue(values, "distance", 0);
      if (!through && !(distance > 0)) throw new Error("OFFSET requires a positive distance (or the Through option).");
      return plan(
        [
          {
            name: "entity.modify",
            payload: {
              op: "offset",
              items: [{ targetId: object.id, distance, side, through }],
            },
          },
        ],
        [through ? "OFFSET: through the picked point." : `OFFSET: distance ${trimNum(distance)}.`],
      );
    },
  },
  {
    id: "trim",
    name: "TRIM",
    aliases: ["TR"],
    label: "Trim",
    description:
      "Trim objects at cutting edges: select edges (Enter = all other objects), then pick the pieces to remove. Lines, circles, arcs, polylines, rays, xlines; spline/ellipse/region targets are typed-declined (no exact spline intersections in this build).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      {
        id: "edges",
        kind: "entity",
        prompt: "Select cutting edges or <all objects>:",
        optional: true,
        multiple: true,
        minInputs: 1,
        emptyEnterCompletes: true,
        validate: validate2dPick,
      },
      {
        id: "targets",
        kind: "entityPoint",
        prompt: "Select object to trim (pick the piece to remove):",
        optional: true,
        multiple: true,
        minInputs: 1,
        validate: validate2dPick,
      },
    ],
    build: (values) => {
      const edges = entitiesValue(values, "edges");
      const targets = entityPointsValue(values, "targets");
      if (targets.length === 0) throw new Error("TRIM requires at least one object pick.");
      return plan(
        [
          {
            name: "entity.modify",
            payload: {
              op: "trim",
              edges: edges.map((e) => e.id),
              trims: targets.map((t) => ({ targetId: t.entity.id, pick: toPt(t.point) })),
            },
          },
        ],
        [`TRIM: ${targets.length} target(s)${edges.length > 0 ? ` against ${edges.length} edge(s)` : " (implied all edges)"}.`],
      );
    },
  },
  {
    id: "extend",
    name: "EXTEND",
    aliases: ["EX"],
    label: "Extend",
    description:
      "Extend objects to boundaries: select boundaries (Enter = all other objects), then pick the ends to extend. Lines, arcs, polylines (open); ellipse/spline/region targets are excluded (typed limitation).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      {
        id: "boundaries",
        kind: "entity",
        prompt: "Select boundary edges or <all objects>:",
        optional: true,
        multiple: true,
        minInputs: 1,
        emptyEnterCompletes: true,
        validate: validate2dPick,
      },
      {
        id: "targets",
        kind: "entityPoint",
        prompt: "Select object to extend (pick the end to extend):",
        optional: true,
        multiple: true,
        minInputs: 1,
        validate: validate2dPick,
      },
    ],
    build: (values) => {
      const boundaries = entitiesValue(values, "boundaries");
      const targets = entityPointsValue(values, "targets");
      if (targets.length === 0) throw new Error("EXTEND requires at least one object pick.");
      return plan(
        [
          {
            name: "entity.modify",
            payload: {
              op: "extend",
              boundaries: boundaries.map((b) => b.id),
              targets: targets.map((t) => ({ targetId: t.entity.id, pick: toPt(t.point) })),
            },
          },
        ],
        [`EXTEND: ${targets.length} target(s)${boundaries.length > 0 ? ` to ${boundaries.length} boundar${boundaries.length === 1 ? "y" : "ies"}` : " (implied all boundaries)"}.`],
      );
    },
  },
  {
    id: "stretch",
    name: "STRETCH",
    aliases: ["S"],
    label: "Stretch",
    description:
      "Stretch the objects crossed by a window: two window corners, then a displacement. Entities with vertices/endpoints inside the window are stretched.",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      { id: "corner1", kind: "point", prompt: "Specify first corner of the crossing window:" },
      { id: "corner2", kind: "point", prompt: "Specify opposite corner:" },
      { id: "base", kind: "point", prompt: "Specify base point:" },
      {
        id: "displacement",
        kind: "displacement",
        prompt: "Specify second point or <use typed displacement>:",
        baseStep: "base",
      },
    ],
    build: (values) => {
      const c1 = toPt(pointValue(values, "corner1"));
      const c2 = toPt(pointValue(values, "corner2"));
      const base = pointValue(values, "base");
      const v = values.displacement;
      const vector: Vec2 = v !== undefined && v.kind === "displacement" ? v.vector : [0, 0];
      const winMin = { x: Math.min(c1.x, c2.x), y: Math.min(c1.y, c2.y) };
      const winMax = { x: Math.max(c1.x, c2.x), y: Math.max(c1.y, c2.y) };
      if (winMax.x - winMin.x <= 1e-9 && winMax.y - winMin.y <= 1e-9) {
        throw new Error("STRETCH: the crossing window is degenerate.");
      }
      return plan(
        [
          {
            name: "entity.modify",
            payload: { op: "stretch", winMin, winMax, dx: vector[0], dy: vector[1] },
          },
        ],
        [`STRETCH: window (${trimNum(winMin.x)},${trimNum(winMin.y)})–(${trimNum(winMax.x)},${trimNum(winMax.y)}) by (${trimNum(vector[0])}, ${trimNum(vector[1])}).`],
      );
    },
  },
  {
    id: "fillet",
    name: "FILLET",
    aliases: ["F"],
    label: "Fillet",
    description:
      "Round or join two objects: pick both near the corner (R sets the radius for this run; 0 = sharp corner — persistence across commands is not supported in this build). Line-pair corners; polyline mode through the entity.modify API.",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      {
        id: "first",
        kind: "entityPoint",
        prompt: "Select first object or [Radius]:",
        options: [
          {
            keyword: "R",
            label: "Fillet radius",
            input: "number",
            optionPrompt: "Specify fillet radius:",
            defaultValue: 0,
          },
        ],
        validate: validate2dPick,
      },
      { id: "second", kind: "entityPoint", prompt: "Select second object:", validate: validate2dPick },
    ],
    build: (values) => {
      const first = entityPointsValue(values, "first")[0];
      const second = entityPointsValue(values, "second")[0];
      if (first === undefined || second === undefined) throw new Error("FILLET requires two object picks.");
      const radiusOpt = optionValue(values, "first", "R");
      const radius = radiusOpt !== null && radiusOpt.kind === "number" ? radiusOpt.value : 0;
      if (!(radius >= 0)) throw new Error("FILLET radius must be ≥ 0.");
      const echo = [radius > 0 ? `FILLET: radius ${trimNum(radius)}.` : "FILLET: sharp corner (radius 0)."];
      if (radiusOpt !== null) {
        // Explicit supported/unsupported surface (Architect review): the
        // radius is per-run — persistence is a stated non-goal, never silent.
        echo.push("Radius applies to this FILLET run only — persistence across commands is not supported in this build.");
      }
      return plan(
        [
          {
            name: "entity.modify",
            payload: {
              op: "fillet",
              mode: "pair",
              radius,
              firstId: first.entity.id,
              firstPick: toPt(first.point),
              secondId: second.entity.id,
              secondPick: toPt(second.point),
            },
          },
        ],
        echo,
      );
    },
  },
  {
    id: "chamfer",
    name: "CHAMFER",
    aliases: ["CHA"],
    label: "Chamfer",
    description:
      "Bevel or join two objects: pick both near the corner (D1/D2 set the distances for this run — persistence across commands is not supported in this build). Line-pair corners; polyline mode through the entity.modify API.",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      {
        id: "first",
        kind: "entityPoint",
        prompt: "Select first object or [Distances]:",
        options: [
          {
            keyword: "D1",
            label: "First chamfer distance",
            input: "number",
            optionPrompt: "Specify first chamfer distance:",
            defaultValue: 0,
          },
          {
            keyword: "D2",
            label: "Second chamfer distance",
            input: "number",
            optionPrompt: "Specify second chamfer distance:",
            defaultValue: 0,
          },
        ],
        validate: validate2dPick,
      },
      { id: "second", kind: "entityPoint", prompt: "Select second object:", validate: validate2dPick },
    ],
    build: (values) => {
      const first = entityPointsValue(values, "first")[0];
      const second = entityPointsValue(values, "second")[0];
      if (first === undefined || second === undefined) throw new Error("CHAMFER requires two object picks.");
      const d1Opt = optionValue(values, "first", "D1");
      const d2Opt = optionValue(values, "first", "D2");
      const d1 = d1Opt !== null && d1Opt.kind === "number" ? d1Opt.value : 0;
      const d2 = d2Opt !== null && d2Opt.kind === "number" ? d2Opt.value : 0;
      if (!(d1 >= 0) || !(d2 >= 0)) throw new Error("CHAMFER distances must be ≥ 0.");
      const echo = [`CHAMFER: distances ${trimNum(d1)} × ${trimNum(d2)}.`];
      if (d1Opt !== null || d2Opt !== null) {
        // Explicit supported/unsupported surface (Architect review).
        echo.push("Distances apply to this CHAMFER run only — persistence across commands is not supported in this build.");
      }
      return plan(
        [
          {
            name: "entity.modify",
            payload: {
              op: "chamfer",
              mode: "pair",
              d1,
              d2,
              firstId: first.entity.id,
              firstPick: toPt(first.point),
              secondId: second.entity.id,
              secondPick: toPt(second.point),
            },
          },
        ],
        echo,
      );
    },
  },
  {
    id: "break",
    name: "BREAK",
    aliases: ["BR"],
    label: "Break",
    description:
      "Break an object at two points: the selection point is the first break point, then the second. Lines, circles, arcs, polylines; spline/ellipse/region excluded (typed limitation).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      { id: "object", kind: "entityPoint", prompt: "Select object to break (the pick point is the first break point):", validate: validate2dPick },
      { id: "second", kind: "point", prompt: "Specify second break point:" },
    ],
    build: (values) => {
      const object = entityPointsValue(values, "object")[0];
      if (object === undefined) throw new Error("BREAK requires an object pick.");
      const second = toPt(pointValue(values, "second"));
      return plan(
        [
          {
            name: "entity.modify",
            payload: { op: "break", targetId: object.entity.id, p1: toPt(object.point), p2: second },
          },
        ],
        [`BREAK: '${object.entity.id}' at (${fmtPoint(object.point)}) and (${fmtPoint(pointValue(values, "second"))}).`],
      );
    },
  },
  {
    id: "join",
    name: "JOIN",
    aliases: ["J"],
    label: "Join",
    description:
      "Join collinear lines, same-circle arcs, or connected open polylines into one entity (source entities are replaced).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      {
        id: "objects",
        kind: "entity",
        prompt: "Select objects to join (min 2):",
        optional: true,
        multiple: true,
        minInputs: 2,
        validate: validate2dPick,
      },
    ],
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      if (objects.length < 2) throw new Error("JOIN requires at least two objects.");
      return plan(
        [{ name: "entity.modify", payload: { op: "join", ids: objects.map((o) => o.id) } }],
        [`JOIN: ${objects.length} objects.`],
      );
    },
  },
  {
    id: "explode",
    name: "EXPLODE",
    aliases: ["X"],
    label: "Explode",
    description: "Explode composite entities into their components (polylines → lines/arcs, regions → boundary entities).",
    category: "modify",
    ribbonTab: "Home",
    steps: [
      {
        id: "objects",
        kind: "entity",
        prompt: "Select objects to explode:",
        optional: true,
        multiple: true,
        minInputs: 1,
        validate: validate2dPick,
      },
    ],
    build: (values) => {
      const objects = entitiesValue(values, "objects");
      if (objects.length === 0) throw new Error("EXPLODE requires at least one object.");
      return plan(
        [{ name: "entity.modify", payload: { op: "explode", ids: objects.map((o) => o.id) } }],
        [`EXPLODE: ${objects.length} object(s).`],
      );
    },
  },
];

/** Add the PLINE alias (work-order vocabulary) — applied where POLYLINE is
 *  declared in commands.ts (kept here so the CAD-PARITY-002 file stays
 *  untouched except the registry merge). */
export const PLINE_ALIAS: { readonly commandId: string; readonly alias: string } = { commandId: "polyline", alias: "PLINE" };
