/**
 * CAD-PARITY-003 geometry bridge — the canonical 2D geometry view over
 * CADDocument elements (Issue #78, CAD-2D-001/CAD-2D-002).
 *
 * Two storage conventions meet here:
 *
 *  1. The COMPAT-CAD-001 drafting vocabulary (line/polyline/circle/arc/
 *     rectangle stored as { drafting, type, layer, from/to | points |
 *     center/radius | corner1/corner2 }).
 *  2. The CAD-PARITY-003 canonical vocabulary (the flat Geom union of
 *     geometry/types.ts: line/polyline/circle/arc/ellipse/spline/point/
 *     ray/xline/region).
 *
 * Every CAD-PARITY-003 command (draw + modify) operates on the CANONICAL
 * Geom view — never on UI approximations (Issue #78 acceptance:
 * "modify operations operate on canonical geometry"). The bridge loads
 * elements into that view and writes results back as canonical props,
 * preserving the element id, layer and non-geometry metadata. A rectangle
 * that undergoes a general modify operation is materialized as the closed
 * polyline it mathematically is (AutoCAD-class semantics; the conversion
 * is echoed by the command, never silent).
 *
 * Engine-free, host-free, deterministic (LOCK-003/018).
 */

import type { Element } from "../../contracts/caddocument.js";
import type { Geom } from "./types.js";
import type { Pt } from "./math2d.js";
import { propsToGeom } from "./types.js";

/** Is this element a drafting-domain geometry element (either convention)? */
export function isDraftingGeometry(el: Element): boolean {
  if (el.kind !== "geometry") return false;
  return (el.props as Record<string, unknown>).drafting === true;
}

/** Is this element a CAD-PARITY-003 canonical entity (flat convention)? */
export function isCanonicalEntity(el: Element): boolean {
  return isDraftingGeometry(el) && propsToGeom(el.props) !== null;
}

function num(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

function vec(v: unknown): Pt | null {
  if (!Array.isArray(v) || v.length !== 2 || !num(v[0]) || !num(v[1])) return null;
  return { x: v[0] as number, y: v[1] as number };
}

function vecList(v: unknown): readonly Pt[] | null {
  if (!Array.isArray(v)) return null;
  const out: Pt[] = [];
  for (const p of v) {
    const q = vec(p);
    if (q === null) return null;
    out.push(q);
  }
  return out;
}

/**
 * Load an element's geometry into the canonical Geom view.
 * Returns null for elements outside the CAD-2D vocabulary (annotations,
 * BIM entities, malformed props — LOCK-007: no guessing).
 */
export function geomFromElement(el: Element): Geom | null {
  if (!isDraftingGeometry(el)) return null;
  const props = el.props as Record<string, unknown>;

  // Canonical (flat) convention first — exact round-trip.
  const canonical = propsToGeom(props);
  if (canonical !== null) return canonical;

  // COMPAT-CAD-001 drafting convention.
  switch (props.type) {
    case "line": {
      const from = vec(props.from);
      const to = vec(props.to);
      if (from === null || to === null) return null;
      return { type: "line", x1: from.x, y1: from.y, x2: to.x, y2: to.y };
    }
    case "polyline": {
      const points = vecList(props.points);
      if (points === null || points.length < 2) return null;
      return { type: "polyline", vertices: points, closed: props.closed === true };
    }
    case "circle": {
      const center = vec(props.center);
      const radius = props.radius;
      if (center === null || !num(radius) || (radius as number) <= 0) return null;
      return { type: "circle", cx: center.x, cy: center.y, r: radius as number };
    }
    case "arc": {
      const center = vec(props.center);
      const radius = props.radius;
      if (
        center === null || !num(radius) || (radius as number) <= 0 ||
        !num(props.startAngle) || !num(props.endAngle)
      ) return null;
      return {
        type: "arc",
        cx: center.x,
        cy: center.y,
        r: radius as number,
        startAngle: props.startAngle as number,
        endAngle: props.endAngle as number,
      };
    }
    case "rectangle": {
      // Materialized as the closed 4-vertex polyline it mathematically is.
      const c1 = vec(props.corner1);
      const c2 = vec(props.corner2);
      if (c1 === null || c2 === null) return null;
      return {
        type: "polyline",
        vertices: [
          { x: c1.x, y: c1.y },
          { x: c2.x, y: c1.y },
          { x: c2.x, y: c2.y },
          { x: c1.x, y: c2.y },
        ],
        closed: true,
      };
    }
    default:
      return null;
  }
}

/** True when the element stores a rectangle that would be materialized as a
 *  polyline by the canonical view (for honest command echo). */
export function isRectangleElement(el: Element): boolean {
  return isDraftingGeometry(el) && (el.props as Record<string, unknown>).type === "rectangle";
}

/**
 * Write a canonical Geom back to element props (flat convention + drafting
 * marker). `layer` is preserved from the original element when omitted.
 */
export function propsFromGeom(g: Geom, layer?: string): Record<string, unknown> {
  const flat = g as unknown as Record<string, unknown>;
  const props: Record<string, unknown> = { drafting: true, ...flat };
  if (layer !== undefined) props.layer = layer;
  return props;
}

/** The element's drafting layer ("0" when absent — COMPAT-CAD-001 default). */
export function layerOfElement(el: Element): string {
  const layer = (el.props as Record<string, unknown>).layer;
  return typeof layer === "string" && layer.length > 0 ? layer : "0";
}
