/**
 * CAD-PARITY-002 grip system (Issue #75; CAD-P-004 "grips and contextual
 * editing", CAD-UX-003 contextual editing parity), extended for
 * CAD-PARITY-003 (Issue #78) to the canonical entity vocabulary.
 *
 * Grips are the drag handles of a SELECTED entity: endpoints/vertices for
 * lines/polylines/walls, corners for rectangles/slabs, center + radius for
 * circles/arcs, plus one MOVE grip (drag the whole entity). Pure and
 * deterministic: gripsFor maps an element to its handles; gripDrag maps a
 * dragged handle to App API commands (stretch grips re-validate the entity
 * through the canonical strict constructors — never a raw unvalidated props
 * patch; move grips reuse the versioned drafting.move / bim.move commands).
 *
 * CAD-PARITY-003: elements stored in the canonical flat convention (the
 * entity.create vocabulary — line/polyline/circle/arc/ellipse/spline/point/
 * ray/xline/region) are handled through the shared precision engine's
 * gripsOf over the bridge's canonical Geom view; the drag applies the shared
 * geometry kernel and re-validates (no zero-length / zero-radius results).
 * The legacy branches above stay byte-identical for legacy elements.
 */

import type { Element } from "../contracts/caddocument.js";
import { makeArc, makeCircle, makeLine, makePolyline, makeRectangle } from "../drafting/entities.js";
import type { Vec2 } from "../drafting/precision.js";
import type { AppApiCommandPlanEntry } from "./types.js";
import { geomFromElement, propsFromGeom } from "./geometry/bridge.js";
import { gripsOf } from "./precision-2d.js";
import { moveGeom } from "./geometry/transform.js";
import { dist as distPt, EPS, normAngle, ptEq, type Pt } from "./geometry/math2d.js";
import type { Geom } from "./geometry/types.js";

export interface GripHandle {
  readonly id: string;
  readonly kind: "stretch" | "move" | "radius";
  readonly point: Vec2;
  readonly label: string;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function vec(v: unknown): Vec2 | null {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") {
    return [v[0], v[1]];
  }
  return null;
}

/** The pickable drag handles of one element (empty for unsupported kinds). */
export function gripsFor(el: Element): readonly GripHandle[] {
  const props = el.props as Record<string, unknown>;
  const grips: GripHandle[] = [];

  if (el.kind === "geometry" && props.drafting === true) {
    switch (props.type) {
      case "line": {
        const from = vec(props.from);
        const to = vec(props.to);
        if (from !== null) grips.push({ id: "from", kind: "stretch", point: from, label: "start" });
        if (to !== null) grips.push({ id: "to", kind: "stretch", point: to, label: "end" });
        if (from !== null && to !== null) {
          grips.push({ id: "move", kind: "move", point: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2], label: "move" });
        }
        break;
      }
      case "polyline": {
        const points = Array.isArray(props.points) ? props.points : [];
        points.forEach((p, i) => {
          const v = vec(p);
          if (v !== null) grips.push({ id: `v${i}`, kind: "stretch", point: v, label: `vertex ${i + 1}` });
        });
        break;
      }
      case "circle": {
        const center = vec(props.center);
        const radius = num(props.radius);
        if (center !== null && radius !== null) {
          grips.push({ id: "center", kind: "stretch", point: center, label: "center" });
          grips.push({ id: "radius-e", kind: "radius", point: [center[0] + radius, center[1]], label: "radius" });
          grips.push({ id: "radius-w", kind: "radius", point: [center[0] - radius, center[1]], label: "radius" });
          grips.push({ id: "radius-n", kind: "radius", point: [center[0], center[1] + radius], label: "radius" });
          grips.push({ id: "radius-s", kind: "radius", point: [center[0], center[1] - radius], label: "radius" });
        }
        break;
      }
      case "arc": {
        const center = vec(props.center);
        const radius = num(props.radius);
        const startAngle = num(props.startAngle);
        const endAngle = num(props.endAngle);
        if (center !== null && radius !== null && startAngle !== null && endAngle !== null) {
          grips.push({ id: "center", kind: "stretch", point: center, label: "center" });
          grips.push({
            id: "start",
            kind: "stretch",
            point: [center[0] + radius * Math.cos(startAngle), center[1] + radius * Math.sin(startAngle)],
            label: "start",
          });
          grips.push({
            id: "end",
            kind: "stretch",
            point: [center[0] + radius * Math.cos(endAngle), center[1] + radius * Math.sin(endAngle)],
            label: "end",
          });
        }
        break;
      }
      case "rectangle": {
        const corner1 = vec(props.corner1);
        const corner2 = vec(props.corner2);
        if (corner1 !== null) grips.push({ id: "corner1", kind: "stretch", point: corner1, label: "corner 1" });
        if (corner2 !== null) grips.push({ id: "corner2", kind: "stretch", point: corner2, label: "corner 2" });
        if (corner1 !== null && corner2 !== null) {
          grips.push({ id: "move", kind: "move", point: [(corner1[0] + corner2[0]) / 2, (corner1[1] + corner2[1]) / 2], label: "move" });
        }
        break;
      }
      default:
        break;
    }
    // CAD-PARITY-003: the legacy branches read legacy field names and produce
    // nothing for flat-convention records (entity.create vocabulary) — those
    // resolve through the canonical view instead. Legacy elements with legacy
    // grips keep their handles EXACTLY as before.
    if (grips.length === 0) {
      const canonical = canonicalGrips(el);
      if (canonical !== null) return canonical;
    }
    return grips;
  }

  if (el.kind === "bim" && props.type === "bim.wall") {
    const start = vec(props.start);
    const end = vec(props.end);
    if (start !== null) grips.push({ id: "start", kind: "stretch", point: start, label: "wall start" });
    if (end !== null) grips.push({ id: "end", kind: "stretch", point: end, label: "wall end" });
    if (start !== null && end !== null) {
      grips.push({ id: "move", kind: "move", point: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2], label: "move wall" });
    }
    return grips;
  }

  if (el.kind === "bim" && props.type === "bim.slab") {
    const corner1 = vec(props.corner1);
    const corner2 = vec(props.corner2);
    if (corner1 !== null) grips.push({ id: "corner1", kind: "stretch", point: corner1, label: "slab corner 1" });
    if (corner2 !== null) grips.push({ id: "corner2", kind: "stretch", point: corner2, label: "slab corner 2" });
    return grips;
  }

  return grips;
}

// ---------------------------------------------------------------------------
// CAD-PARITY-003: canonical (flat-convention) grips over the shared bridge.
// ---------------------------------------------------------------------------

/** Grips of a canonical (flat-convention) element — the shared precision
 *  engine's gripsOf over the bridge's canonical Geom view, mapped to the
 *  GripHandle shape (v0/v1/… vertices, center, r0..r3 radius, mid move). */
function canonicalGrips(el: Element): readonly GripHandle[] | null {
  const geom = geomFromElement(el);
  if (geom === null) return null;
  const props = el.props as Record<string, unknown>;
  const entity = {
    id: el.id,
    geom,
    layer: typeof props.layer === "string" ? props.layer : "0",
    color: typeof props.color === "string" ? props.color : null,
    linetype: typeof props.linetype === "string" ? props.linetype : "Continuous",
  };
  const out: GripHandle[] = [];
  for (const g of gripsOf(entity)) {
    const point: Vec2 = [g.point.x, g.point.y];
    switch (g.kind) {
      case "vertex":
        out.push({ id: `v${g.index}`, kind: "stretch", point, label: g.index >= 0 ? `vertex ${g.index + 1}` : "vertex" });
        break;
      case "center":
        out.push({ id: "center", kind: "stretch", point, label: "center" });
        break;
      case "radius":
        out.push({ id: `r${g.index}`, kind: "radius", point, label: "radius" });
        break;
      case "mid":
        out.push({ id: "mid", kind: "move", point, label: "move" });
        break;
    }
  }
  return out;
}

export interface GripEditResult {
  readonly appApi: readonly AppApiCommandPlanEntry[];
  readonly echo: readonly string[];
}

/**
 * Map a dragged grip to App API commands. Stretch/radius grips re-validate
 * through the canonical strict constructors (LOCK-007 — malformed results
 * throw instead of silently patching); the MOVE grip emits a versioned
 * transform command. CAD-PARITY-003 flat-convention records fall through to
 * the canonical handler (shared geometry kernel + re-validation).
 */
export function gripDrag(el: Element, gripId: string, to: Vec2): GripEditResult | null {
  const legacy = legacyGripDrag(el, gripId, to);
  if (legacy !== null) return legacy;
  return canonicalGripDrag(el, gripId, to);
}

/** The CAD-PARITY-002 handler (legacy conventions — behavior unchanged). */
function legacyGripDrag(el: Element, gripId: string, to: Vec2): GripEditResult | null {
  const props = el.props as Record<string, unknown>;

  if (el.kind === "geometry" && props.drafting === true) {
    const layer = typeof props.layer === "string" ? props.layer : "0";
    switch (props.type) {
      case "line": {
        if (gripId === "move") {
          return moveResult(el, to);
        }
        const from = vec(props.from);
        const to0 = vec(props.to);
        if (from === null || to0 === null) return null;
        const newFrom = gripId === "from" ? to : from;
        const newTo = gripId === "to" ? to : to0;
        const validated = makeLine({ type: "line", layer, from: [...newFrom], to: [...newTo] });
        return {
          appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
          echo: [`STRETCH: line '${el.id}' ${gripId} → (${to[0]},${to[1]}).`],
        };
      }
      case "polyline": {
        const points = Array.isArray(props.points) ? props.points.map((p) => vec(p)) : [];
        const closed = props.closed === true;
        const index = Number(gripId.slice(1));
        if (!Number.isInteger(index) || index < 0 || index >= points.length || points.some((p) => p === null)) return null;
        const newPoints = points.map((p, i) => (i === index ? [...to] : [...(p as Vec2)])) as Vec2[];
        const validated = makePolyline({ type: "polyline", layer, points: newPoints, closed });
        return {
          appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
          echo: [`STRETCH: polyline '${el.id}' vertex ${index + 1} → (${to[0]},${to[1]}).`],
        };
      }
      case "circle": {
        const center = vec(props.center);
        if (center === null) return null;
        if (gripId === "center") {
          const radius = num(props.radius);
          if (radius === null) return null;
          const validated = makeCircle({ type: "circle", layer, center: [...to], radius });
          return {
            appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
            echo: [`STRETCH: circle '${el.id}' center → (${to[0]},${to[1]}).`],
          };
        }
        if (gripId.startsWith("radius")) {
          const radius = Math.hypot(to[0] - center[0], to[1] - center[1]);
          if (!(radius > 0)) return { appApi: [], echo: ["STRETCH: circle radius must be positive — grip edit rejected."] };
          const validated = makeCircle({ type: "circle", layer, center: [...center], radius });
          return {
            appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
            echo: [`STRETCH: circle '${el.id}' radius → ${radius}.`],
          };
        }
        return null;
      }
      case "arc": {
        const center = vec(props.center);
        const radius = num(props.radius);
        const startAngle = num(props.startAngle);
        const endAngle = num(props.endAngle);
        if (center === null || radius === null || startAngle === null || endAngle === null) return null;
        if (gripId === "center") {
          const validated = makeArc({ type: "arc", layer, center: [...to], radius, startAngle, endAngle });
          return {
            appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
            echo: [`STRETCH: arc '${el.id}' center → (${to[0]},${to[1]}).`],
          };
        }
        if (gripId === "start" || gripId === "end") {
          const newAngle = Math.atan2(to[1] - center[1], to[0] - center[0]);
          const newStart = gripId === "start" ? newAngle : startAngle;
          let newEnd = gripId === "end" ? newAngle : endAngle;
          if (newEnd <= newStart) newEnd += 2 * Math.PI;
          const validated = makeArc({ type: "arc", layer, center: [...center], radius, startAngle: newStart, endAngle: newEnd });
          return {
            appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
            echo: [`STRETCH: arc '${el.id}' ${gripId} angle → ${((newAngle * 180) / Math.PI).toFixed(1)}°.`],
          };
        }
        return null;
      }
      case "rectangle": {
        if (gripId === "move") {
          return moveResult(el, to);
        }
        const corner1 = vec(props.corner1);
        const corner2 = vec(props.corner2);
        if (corner1 === null || corner2 === null) return null;
        const newCorner1 = gripId === "corner1" ? to : corner1;
        const newCorner2 = gripId === "corner2" ? to : corner2;
        const validated = makeRectangle({ type: "rectangle", layer, corner1: [...newCorner1], corner2: [...newCorner2] });
        return {
          appApi: [{ name: "document.applyEdit", payload: { edit: { type: "updateElement", elementId: el.id, patch: { ...validated } } } }],
          echo: [`STRETCH: rectangle '${el.id}' ${gripId} → (${to[0]},${to[1]}).`],
        };
      }
      default:
        return null;
    }
  }

  if (el.kind === "bim" && props.type === "bim.wall") {
    if (gripId === "move") {
      return moveResult(el, to);
    }
    const start = vec(props.start);
    const end = vec(props.end);
    const storyId = props.storyId;
    const width = num(props.width);
    const height = num(props.height);
    if (start === null || end === null || typeof storyId !== "string" || width === null || height === null) return null;
    const patch: Record<string, unknown> =
      gripId === "start"
        ? { start: [...to], end: [...end] }
        : { start: [...start], end: [...to] };
    // Validate through bim.setProperties semantics (the App API re-validates
    // the resulting entity — LOCK-007).
    return {
      appApi: [{ name: "bim.setProperties", payload: { elementId: el.id, patch } }],
      echo: [`STRETCH: wall '${el.id}' ${gripId} → (${to[0]},${to[1]}).`],
    };
  }

  if (el.kind === "bim" && props.type === "bim.slab") {
    const corner1 = vec(props.corner1);
    const corner2 = vec(props.corner2);
    if (corner1 === null || corner2 === null) return null;
    const patch: Record<string, unknown> =
      gripId === "corner1"
        ? { corner1: [...to], corner2: [...corner2] }
        : { corner1: [...corner1], corner2: [...to] };
    return {
      appApi: [{ name: "bim.setProperties", payload: { elementId: el.id, patch } }],
      echo: [`STRETCH: slab '${el.id}' ${gripId} → (${to[0]},${to[1]}).`],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// CAD-PARITY-003 canonical grip dragging (shared geometry kernel).
// ---------------------------------------------------------------------------

/** Result of applying one canonical grip: new geometry, an explicit
 *  validation rejection (zero length / zero radius / zero sweep), or null
 *  when the grip id does not exist on the entity. */
type CanonicalGripResult = { readonly geom: Geom } | { readonly reject: string } | null;

/** Apply a canonical grip drag with the shared kernel. Vertex grips move
 *  vertices/endpoints, center grips move the entity (radius/axes/angles
 *  preserved), radius grips resize, the mid grip moves a line. */
function applyCanonicalGrip(g: Geom, gripId: string, to: Pt): CanonicalGripResult {
  switch (g.type) {
    case "line": {
      if (gripId === "mid") {
        return { geom: moveGeom(g, to.x - (g.x1 + g.x2) / 2, to.y - (g.y1 + g.y2) / 2) };
      }
      if (gripId === "v0" || gripId === "v1") {
        const next = gripId === "v0" ? { ...g, x1: to.x, y1: to.y } : { ...g, x2: to.x, y2: to.y };
        if (distPt({ x: next.x1, y: next.y1 }, { x: next.x2, y: next.y2 }) <= EPS) {
          return { reject: "line endpoints coincide — grip edit rejected." };
        }
        return { geom: next };
      }
      return null;
    }
    case "polyline": {
      if (!gripId.startsWith("v")) return null;
      const index = Number(gripId.slice(1));
      if (!Number.isInteger(index) || index < 0 || index >= g.vertices.length) return null;
      const vertices = g.vertices.map((v, i) => (i === index ? to : v));
      const n = g.vertices.length;
      const adjacent = g.closed ? [(index - 1 + n) % n, (index + 1) % n] : [index - 1, index + 1];
      for (const adj of adjacent) {
        if (adj < 0 || adj >= n) continue;
        if (ptEq(vertices[adj]!, to)) {
          return { reject: "polyline segment would collapse to zero length — grip edit rejected." };
        }
      }
      return { geom: { ...g, vertices } };
    }
    case "circle": {
      if (gripId === "center") {
        return { geom: moveGeom(g, to.x - g.cx, to.y - g.cy) };
      }
      if (gripId === "r0" || gripId === "r1" || gripId === "r2" || gripId === "r3") {
        const r = distPt({ x: g.cx, y: g.cy }, to);
        if (!(r > EPS)) {
          return { reject: "circle radius must be positive — grip edit rejected." };
        }
        return { geom: { ...g, r } };
      }
      return null;
    }
    case "arc": {
      if (gripId === "center") {
        return { geom: moveGeom(g, to.x - g.cx, to.y - g.cy) };
      }
      if (gripId === "v0" || gripId === "v1") {
        const center = { x: g.cx, y: g.cy };
        const r = distPt(center, to);
        if (!(r > EPS)) {
          return { reject: "arc radius must be positive — grip edit rejected." };
        }
        const angle = Math.atan2(to.y - g.cy, to.x - g.cx);
        let startAngle = gripId === "v0" ? angle : g.startAngle;
        let endAngle = gripId === "v1" ? angle : g.endAngle;
        if (endAngle <= startAngle) endAngle += Math.PI * 2;
        if (normAngle(endAngle - startAngle) <= EPS) {
          return { reject: "arc sweep must be positive — grip edit rejected." };
        }
        return { geom: { ...g, r, startAngle, endAngle } };
      }
      return null;
    }
    case "ellipse": {
      if (gripId === "center") {
        return { geom: moveGeom(g, to.x - g.cx, to.y - g.cy) };
      }
      if (gripId === "r0" || gripId === "r1") {
        // Project the drag onto the rx axis (rotation preserved).
        const axis = { x: Math.cos(g.rotation), y: Math.sin(g.rotation) };
        const rel = { x: to.x - g.cx, y: to.y - g.cy };
        const rx = Math.abs(rel.x * axis.x + rel.y * axis.y);
        if (!(rx > EPS)) {
          return { reject: "ellipse axis length must be positive — grip edit rejected." };
        }
        return { geom: { ...g, rx } };
      }
      return null;
    }
    case "spline": {
      if (!gripId.startsWith("v")) return null;
      const index = Number(gripId.slice(1));
      if (!Number.isInteger(index) || index < 0 || index >= g.controlPoints.length) return null;
      return { geom: { ...g, controlPoints: g.controlPoints.map((v, i) => (i === index ? to : v)) } };
    }
    case "point": {
      if (gripId === "v0") {
        return { geom: { ...g, x: to.x, y: to.y } };
      }
      return null;
    }
    case "ray":
    case "xline": {
      if (gripId === "v0") {
        // Move the base point, direction preserved.
        return { geom: moveGeom(g, to.x - g.x1, to.y - g.y1) };
      }
      return null;
    }
    case "region": {
      if (gripId === "center") {
        return { geom: moveGeom(g, to.x - g.centroid.x, to.y - g.centroid.y) };
      }
      return null;
    }
  }
}

/** Grip drag for canonical (flat-convention) elements: compute the new
 *  geometry with the shared kernel, re-validate, and emit the SAME
 *  document.applyEdit updateElement pattern the legacy branches use
 *  (patch = {drafting: true, layer, …geom} — see propsFromGeom). */
function canonicalGripDrag(el: Element, gripId: string, to: Vec2): GripEditResult | null {
  if (el.kind !== "geometry") return null;
  const props = el.props as Record<string, unknown>;
  if (props.drafting !== true) return null;
  const base = geomFromElement(el);
  if (base === null) return null;
  const layer = typeof props.layer === "string" ? props.layer : "0";
  const applied = applyCanonicalGrip(base, gripId, { x: to[0], y: to[1] });
  if (applied === null) return null;
  if ("reject" in applied) {
    return { appApi: [], echo: [`STRETCH: ${applied.reject}`] };
  }
  const patch = propsFromGeom(applied.geom, layer);
  // setProps (FULL replacement): canonical grip edits must not leave stale
  // legacy fields behind on mixed-convention elements.
  return {
    appApi: [{ name: "document.applyEdit", payload: { edit: { type: "setProps", elementId: el.id, patch } } }],
    echo: [`STRETCH: ${base.type} '${el.id}' ${gripId} → (${trimNum(to[0])},${trimNum(to[1])}).`],
  };
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

function moveResult(el: Element, to: Vec2): GripEditResult | null {
  const props = el.props as Record<string, unknown>;
  let center: Vec2 | null = null;
  if (el.kind === "geometry" && props.type === "line") {
    const from = vec(props.from);
    const end = vec(props.to);
    if (from !== null && end !== null) center = [(from[0] + end[0]) / 2, (from[1] + end[1]) / 2];
  } else if (el.kind === "geometry" && props.type === "rectangle") {
    const corner1 = vec(props.corner1);
    const corner2 = vec(props.corner2);
    if (corner1 !== null && corner2 !== null) center = [(corner1[0] + corner2[0]) / 2, (corner1[1] + corner2[1]) / 2];
  } else if (el.kind === "bim" && props.type === "bim.wall") {
    const start = vec(props.start);
    const end = vec(props.end);
    if (start !== null && end !== null) center = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  }
  if (center === null) return null;
  const dx = to[0] - center[0];
  const dy = to[1] - center[1];
  if (el.kind === "bim") {
    return {
      appApi: [{ name: "bim.move", payload: { ids: [el.id], dx, dy, dz: 0 } }],
      echo: [`MOVE: '${el.id}' by (${dx},${dy}).`],
    };
  }
  return {
    appApi: [{ name: "drafting.move", payload: { ids: [el.id], dx, dy } }],
    echo: [`MOVE: '${el.id}' by (${dx},${dy}).`],
  };
}
