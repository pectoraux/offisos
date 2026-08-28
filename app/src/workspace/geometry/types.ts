/**
 * 2D drawing entity types (CAD-PARITY-003, CAD-2D-001 vocabulary).
 *
 * Geometry lives inside CADDocument `Element.props` (kind = "geometry") as a
 * discriminated union on `type`. All numbers are plain JSON — the canonical
 * serialization and content-hash semantics of CADDocument apply unchanged.
 *
 * Conventions (AutoCAD-compatible):
 * - Y is up in world space.
 * - Arcs sweep counter-clockwise from startAngle to endAngle (radians).
 * - Ray/XLINE store a base point + a second point defining direction.
 * - SPLINE stores control points; evaluated as a clamped uniform cubic B-spline.
 * - REGION stores a closed boundary description + computed properties
 *   (area/perimeter/centroid) — a derived, associative representation.
 */

import type { Pt } from "./math2d.js";

export type GeomType =
  | "line"
  | "polyline"
  | "circle"
  | "arc"
  | "ellipse"
  | "spline"
  | "point"
  | "ray"
  | "xline"
  | "region";

export interface LineGeom {
  readonly type: "line";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface PolylineGeom {
  readonly type: "polyline";
  readonly vertices: readonly Pt[];
  readonly closed: boolean;
}

export interface CircleGeom {
  readonly type: "circle";
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

export interface ArcGeom {
  readonly type: "arc";
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

export interface EllipseGeom {
  readonly type: "ellipse";
  readonly cx: number;
  readonly cy: number;
  /** Half-length of the axis defined by `rotation`. */
  readonly rx: number;
  /** Half-length of the perpendicular axis. */
  readonly ry: number;
  /** Rotation of the rx axis, radians CCW from +X. */
  readonly rotation: number;
}

export interface SplineGeom {
  readonly type: "spline";
  readonly controlPoints: readonly Pt[];
  /** Clamped B-spline degree (3 for >= 4 points, else points-1). */
  readonly degree: number;
}

export interface PointGeom {
  readonly type: "point";
  readonly x: number;
  readonly y: number;
}

/** Infinite half-line from (x1,y1) through (x2,y2). */
export interface RayGeom {
  readonly type: "ray";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Infinite line through (x1,y1) and (x2,y2). */
export interface XLineGeom {
  readonly type: "xline";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export type RegionBoundary =
  | { readonly kind: "circle"; readonly cx: number; readonly cy: number; readonly r: number }
  | {
      readonly kind: "ellipse";
      readonly cx: number;
      readonly cy: number;
      readonly rx: number;
      readonly ry: number;
      readonly rotation: number;
    }
  | { readonly kind: "polyline"; readonly vertices: readonly Pt[] };

export interface RegionGeom {
  readonly type: "region";
  readonly boundary: RegionBoundary;
  /** Computed deterministic properties (associative representation). */
  readonly area: number;
  readonly perimeter: number;
  readonly centroid: Pt;
}

export type Geom =
  | LineGeom
  | PolylineGeom
  | CircleGeom
  | ArcGeom
  | EllipseGeom
  | SplineGeom
  | PointGeom
  | RayGeom
  | XLineGeom
  | RegionGeom;

export interface DisplayProps {
  readonly layer?: string;
  readonly color?: string | null;
  readonly linetype?: string;
}

/** Full entity record used across commands/prompt engine/renderer. */
export interface Entity {
  readonly id: string;
  readonly geom: Geom;
  readonly layer: string;
  readonly color: string | null;
  readonly linetype: string;
}

/** Geometry -> plain props for CADDocument Element storage. */
export function geomToProps(g: Geom, display: DisplayProps = {}): Record<string, unknown> {
  return { ...(g as unknown as Record<string, unknown>), ...display };
}

/** Decode an Element's props into a typed Geom, or null when the props do not
 *  describe a known 2D geometry (LOCK-007: no guessing). */
export function propsToGeom(props: Readonly<Record<string, unknown>>): Geom | null {
  const t = props.type;
  switch (t) {
    case "line":
    case "ray":
    case "xline":
      if (
        num(props.x1) && num(props.y1) && num(props.x2) && num(props.y2)
      ) {
        return { type: t, x1: props.x1 as number, y1: props.y1 as number, x2: props.x2 as number, y2: props.y2 as number };
      }
      return null;
    case "polyline":
      if (ptList(props.vertices) !== null) {
        return {
          type: "polyline",
          vertices: ptList(props.vertices)!,
          closed: props.closed === true,
        };
      }
      return null;
    case "circle":
      if (num(props.cx) && num(props.cy) && num(props.r) && (props.r as number) > 0) {
        return { type: "circle", cx: props.cx as number, cy: props.cy as number, r: props.r as number };
      }
      return null;
    case "arc":
      if (
        num(props.cx) && num(props.cy) && num(props.r) &&
        num(props.startAngle) && num(props.endAngle) && (props.r as number) > 0
      ) {
        return {
          type: "arc",
          cx: props.cx as number,
          cy: props.cy as number,
          r: props.r as number,
          startAngle: props.startAngle as number,
          endAngle: props.endAngle as number,
        };
      }
      return null;
    case "ellipse":
      if (
        num(props.cx) && num(props.cy) && num(props.rx) && num(props.ry) && num(props.rotation) &&
        (props.rx as number) > 0 && (props.ry as number) > 0
      ) {
        return {
          type: "ellipse",
          cx: props.cx as number,
          cy: props.cy as number,
          rx: props.rx as number,
          ry: props.ry as number,
          rotation: props.rotation as number,
        };
      }
      return null;
    case "spline":
      if (ptList(props.controlPoints) !== null && num(props.degree)) {
        return {
          type: "spline",
          controlPoints: ptList(props.controlPoints)!,
          degree: props.degree as number,
        };
      }
      return null;
    case "point":
      if (num(props.x) && num(props.y)) {
        return { type: "point", x: props.x as number, y: props.y as number };
      }
      return null;
    case "region": {
      const b = props.boundary as unknown;
      if (typeof b !== "object" || b === null) return null;
      const bb = b as Record<string, unknown>;
      if (
        num(props.area) && num(props.perimeter) &&
        typeof (props.centroid as Record<string, unknown> | undefined)?.x === "number" &&
        typeof (props.centroid as Record<string, unknown> | undefined)?.y === "number"
      ) {
        let boundary: RegionBoundary | null = null;
        if (bb.kind === "circle" && num(bb.cx) && num(bb.cy) && num(bb.r)) {
          boundary = { kind: "circle", cx: bb.cx as number, cy: bb.cy as number, r: bb.r as number };
        } else if (
          bb.kind === "ellipse" && num(bb.cx) && num(bb.cy) && num(bb.rx) && num(bb.ry) && num(bb.rotation)
        ) {
          boundary = {
            kind: "ellipse",
            cx: bb.cx as number,
            cy: bb.cy as number,
            rx: bb.rx as number,
            ry: bb.ry as number,
            rotation: bb.rotation as number,
          };
        } else if (bb.kind === "polyline" && ptList(bb.vertices) !== null) {
          boundary = { kind: "polyline", vertices: ptList(bb.vertices)! };
        }
        if (boundary !== null) {
          return {
            type: "region",
            boundary,
            area: props.area as number,
            perimeter: props.perimeter as number,
            centroid: { x: (props.centroid as { x: number }).x, y: (props.centroid as { y: number }).y },
          };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function num(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

function ptList(v: unknown): readonly Pt[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: Pt[] = [];
  for (const p of v) {
    if (typeof p !== "object" || p === null) return null;
    const pp = p as Record<string, unknown>;
    if (!num(pp.x) || !num(pp.y)) return null;
    out.push({ x: pp.x as number, y: pp.y as number });
  }
  return out;
}

/** Display metadata extraction (layers/styles/palettes are CAD-PARITY-004;
 *  this build keeps a single implicit layer + per-entity color/linetype). */
export function displayOf(props: Readonly<Record<string, unknown>>): DisplayProps {
  return {
    layer: typeof props.layer === "string" ? props.layer : "0",
    color: typeof props.color === "string" ? props.color : null,
    linetype: typeof props.linetype === "string" ? props.linetype : "Continuous",
  };
}

export const GEOM_TYPES: readonly GeomType[] = [
  "line",
  "polyline",
  "circle",
  "arc",
  "ellipse",
  "spline",
  "point",
  "ray",
  "xline",
  "region",
];

/** Human label for an entity type (status bar / properties panel). */
export const GEOM_LABEL: Readonly<Record<GeomType, string>> = {
  line: "Line",
  polyline: "Polyline",
  circle: "Circle",
  arc: "Arc",
  ellipse: "Ellipse",
  spline: "Spline",
  point: "Point",
  ray: "Ray",
  xline: "Construction Line",
  region: "Region",
};
