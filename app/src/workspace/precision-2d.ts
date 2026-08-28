/**
 * CAD-PARITY-003 precision engine (Issue #78, CAD-2D-003): nine object-snap
 * modes with deterministic priority, ortho/polar constraints, grid snap,
 * object-snap tracking, deterministic picking and window/crossing selection
 * over the canonical geometry view — pure functions of (document entities,
 * cursor, modes). The SAME module runs in BOTH host renderers (every mouse
 * move) and behind the server-side App API precision queries: identical
 * inputs produce identical results on every host (LOCK-004 parity by
 * construction; engine-free per LOCK-003/018).
 */

import {
  angleAt,
  angleDiff,
  angleOf,
  dist,
  EPS,
  normAngle,
  Pt,
  sub,
  TAU,
} from "./geometry/math2d.js";
import {
  arcEnd,
  arcStart,
  arcSweep,
  bbox as entityBBox,
  centerOf,
  closestOn,
  polylineSegments,
  sampleSpline,
} from "./geometry/entities.js";
import { intersectGeoms } from "./geometry/intersect.js";
import type { Geom } from "./geometry/types.js";
import { geomFromElement } from "./geometry/bridge.js";
import type { Element } from "../contracts/caddocument.js";

/** The canonical geometry view of one document entity (id + geometry +
 *  display metadata; layers/styles palettes are CAD-PARITY-004 scope). */
export interface Entity {
  readonly id: string;
  readonly geom: Geom;
  readonly layer: string;
  readonly color: string | null;
  readonly linetype: string;
}

export type { Geom };

// --- Modes -----------------------------------------------------------------

export type OsnapMode =
  | "endpoint"
  | "midpoint"
  | "center"
  | "quadrant"
  | "intersection"
  | "node"
  | "nearest"
  | "perpendicular"
  | "tangent";

export const OSNAP_LABELS: Readonly<Record<OsnapMode, string>> = {
  endpoint: "Endpoint",
  midpoint: "Midpoint",
  center: "Center",
  quadrant: "Quadrant",
  intersection: "Intersection",
  node: "Node",
  nearest: "Nearest",
  perpendicular: "Perpendicular",
  tangent: "Tangent",
};

export interface PrecisionSettings {
  /** Enabled object snap modes (empty = osnap off). */
  readonly osnapModes: readonly OsnapMode[];
  /** Orthogonal constraint (F8). */
  readonly ortho: boolean;
  /** Polar tracking (F10) with increment angles in degrees. */
  readonly polar: boolean;
  readonly polarAnglesDeg: readonly number[];
  /** Grid snap (F9). */
  readonly gridSnap: boolean;
  readonly gridSize: number;
  /** Aperture radius in world units (pick box half-size). */
  readonly aperture: number;
  /** Object-snap tracking (acquired points alignment paths). */
  readonly tracking: boolean;
}

export const DEFAULT_PRECISION: PrecisionSettings = {
  osnapModes: ["endpoint", "midpoint", "center", "quadrant", "intersection", "node"],
  ortho: false,
  polar: true,
  polarAnglesDeg: [0, 45, 90, 135, 180, 225, 270, 315],
  gridSnap: false,
  gridSize: 10,
  aperture: 10,
  tracking: true,
};

// --- Snap points -----------------------------------------------------------

export interface SnapCandidate {
  readonly point: Pt;
  readonly mode: OsnapMode;
  readonly entityId: string | null; // null = intersection of two entities
  readonly otherEntityId?: string;
  /** Deterministic sort key (distance to cursor). */
  readonly d: number;
}

/** All snap candidates of one entity for the enabled modes. */
function entitySnaps(
  e: Entity,
  modes: ReadonlySet<OsnapMode>,
  cursor: Pt,
): SnapCandidate[] {
  const g = e.geom;
  const out: SnapCandidate[] = [];
  const push = (point: Pt, mode: OsnapMode) => {
    out.push({ point, mode, entityId: e.id, d: dist(point, cursor) });
  };

  if (modes.has("endpoint")) {
    switch (g.type) {
      case "line":
      case "ray":
      case "xline":
        push({ x: g.x1, y: g.y1 }, "endpoint");
        if (g.type === "line") push({ x: g.x2, y: g.y2 }, "endpoint");
        break;
      case "polyline":
        for (const v of g.vertices) push(v, "endpoint");
        break;
      case "arc":
        push(arcStart(g), "endpoint");
        push(arcEnd(g), "endpoint");
        break;
      default:
        break;
    }
  }
  if (modes.has("midpoint")) {
    switch (g.type) {
      case "line":
        push({ x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 }, "midpoint");
        break;
      case "polyline":
        for (const [a, b] of polylineSegments(g.vertices, g.closed)) {
          push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, "midpoint");
        }
        break;
      case "arc": {
        const sweep = arcSweep(g);
        const midA = g.startAngle + sweep / 2;
        push({ x: g.cx + g.r * Math.cos(midA), y: g.cy + g.r * Math.sin(midA) }, "midpoint");
        break;
      }
      default:
        break;
    }
  }
  if (modes.has("center")) {
    switch (g.type) {
      case "circle":
      case "arc":
      case "ellipse":
      case "region":
        push(centerOf(g), "center");
        break;
      default:
        break;
    }
  }
  if (modes.has("quadrant")) {
    switch (g.type) {
      case "circle":
        for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
          push({ x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) }, "quadrant");
        }
        break;
      case "arc":
        for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
          const p = { x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) };
          const rel = normAngle(angleAt({ x: g.cx, y: g.cy }, p) - g.startAngle);
          if (rel <= arcSweep(g) + 1e-9) push(p, "quadrant");
        }
        break;
      case "ellipse":
        for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
          const c = Math.cos(g.rotation);
          const s = Math.sin(g.rotation);
          const ex = g.rx * Math.cos(a);
          const ey = g.ry * Math.sin(a);
          push({ x: g.cx + ex * c - ey * s, y: g.cy + ex * s + ey * c }, "quadrant");
        }
        break;
      default:
        break;
    }
  }
  if (modes.has("node")) {
    if (g.type === "point") push({ x: g.x, y: g.y }, "node");
  }
  return out;
}

/** Pairwise entity intersections near the cursor (within aperture). */
function intersectionSnaps(
  entities: readonly Entity[],
  cursor: Pt,
  aperture: number,
): SnapCandidate[] {
  const out: SnapCandidate[] = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const pts = intersectGeoms(entities[i]!.geom, entities[j]!.geom);
      for (const p of pts) {
        const d = dist(p, cursor);
        if (d <= aperture) {
          out.push({ point: p, mode: "intersection", entityId: entities[i]!.id, otherEntityId: entities[j]!.id, d });
        }
      }
    }
  }
  return out;
}

/** Perpendicular foot / tangent point from the last point onto an entity. */
function perpTangentSnaps(
  entities: readonly Entity[],
  cursor: Pt,
  lastPoint: Pt | null,
  modes: ReadonlySet<OsnapMode>,
): SnapCandidate[] {
  const out: SnapCandidate[] = [];
  if (lastPoint === null) return out;
  for (const e of entities) {
    const g = e.geom;
    if (modes.has("perpendicular")) {
      // Foot of perpendicular from lastPoint onto the entity.
      const foot = perpendicularFoot(g, lastPoint);
      if (foot !== null && dist(foot, cursor) <= 1e9) {
        out.push({ point: foot, mode: "perpendicular", entityId: e.id, d: dist(foot, cursor) });
      }
    }
    if (modes.has("tangent")) {
      for (const t of tangentPoints(g, lastPoint)) {
        out.push({ point: t, mode: "tangent", entityId: e.id, d: dist(t, cursor) });
      }
    }
  }
  return out;
}

function perpendicularFoot(g: Geom, from: Pt): Pt | null {
  switch (g.type) {
    case "line":
    case "ray":
    case "xline": {
      const a = { x: g.x1, y: g.y1 };
      const d = { x: g.x2 - g.x1, y: g.y2 - g.y1 };
      const l2 = d.x * d.x + d.y * d.y;
      if (l2 <= EPS) return null;
      const t = ((from.x - a.x) * d.x + (from.y - a.y) * d.y) / l2;
      if (g.type === "line" && (t < -EPS || t > 1 + EPS)) return null;
      if (g.type === "ray" && t < -EPS) return null;
      return { x: a.x + d.x * t, y: a.y + d.y * t };
    }
    case "circle":
    case "arc": {
      // Perpendicular to a circle = radial line through `from`.
      const c = { x: g.cx, y: g.cy };
      const dc = dist(from, c);
      if (dc <= EPS) return null;
      const a = angleAt(c, from);
      const p = { x: c.x + g.r * Math.cos(a), y: c.y + g.r * Math.sin(a) };
      if (g.type === "arc") {
        const rel = normAngle(a - g.startAngle);
        if (rel > arcSweep(g) + 1e-9) return null;
      }
      return p;
    }
    default:
      return null;
  }
}

function tangentPoints(g: Geom, from: Pt): Pt[] {
  if (g.type !== "circle" && g.type !== "arc") return [];
  const c = { x: g.cx, y: g.cy };
  const d = dist(from, c);
  if (d <= g.r + EPS) return [];
  const base = angleAt(c, from);
  const alpha = Math.acos(g.r / d);
  const out: Pt[] = [];
  for (const da of [-alpha, alpha]) {
    const a = base + da;
    const p = { x: c.x + g.r * Math.cos(a), y: c.y + g.r * Math.sin(a) };
    if (g.type === "arc") {
      const rel = normAngle(a - g.startAngle);
      if (rel > arcSweep(g) + 1e-9) continue;
    }
    out.push(p);
  }
  return out;
}

export interface SnapResult {
  readonly point: Pt;
  readonly mode: OsnapMode | null;
  readonly entityId: string | null;
  readonly otherEntityId?: string;
}

/** Resolve the snap for a cursor position. Order: osnap candidates (by
 *  distance, then mode priority, then entity id) → nearest-on-curve → grid
 *  snap → raw point. Deterministic. */
export function resolveSnap(
  entities: readonly Entity[],
  cursor: Pt,
  settings: PrecisionSettings,
  lastPoint: Pt | null,
): SnapResult {
  const modes = new Set(settings.osnapModes);
  const aperture = settings.aperture;

  if (modes.size > 0) {
    const candidates: SnapCandidate[] = [];
    for (const e of entities) {
      candidates.push(...entitySnaps(e, modes, cursor));
    }
    if (modes.has("intersection") && entities.length <= 64) {
      // Cap pairwise work for interactive performance.
      candidates.push(...intersectionSnaps(entities, cursor, aperture * 3));
    }
    if (lastPoint !== null) {
      candidates.push(...perpTangentSnaps(entities, cursor, lastPoint, modes));
    }
    const inAperture = candidates.filter((c) => c.d <= aperture);
    if (inAperture.length > 0) {
      const best = inAperture.sort(compareSnap)[0]!;
      return best.otherEntityId === undefined
        ? { point: best.point, mode: best.mode, entityId: best.entityId }
        : {
            point: best.point,
            mode: best.mode,
            entityId: best.entityId,
            otherEntityId: best.otherEntityId,
          };
    }
  }

  // Nearest-on-curve within half aperture.
  if (settings.osnapModes.includes("nearest")) {
    let best: { p: Pt; id: string; d: number } | null = null;
    for (const e of entities) {
      const r = closestOn(e.geom, cursor);
      if (r.d <= aperture / 2 && (best === null || r.d < best.d)) {
        best = { p: r.point, id: e.id, d: r.d };
      }
    }
    if (best !== null) {
      return { point: best.p, mode: "nearest", entityId: best.id };
    }
  }

  return { point: cursor, mode: null, entityId: null };
}

const MODE_PRIORITY: readonly OsnapMode[] = [
  "intersection",
  "endpoint",
  "node",
  "center",
  "quadrant",
  "midpoint",
  "perpendicular",
  "tangent",
  "nearest",
];

function compareSnap(a: SnapCandidate, b: SnapCandidate): number {
  if (Math.abs(a.d - b.d) > 1e-9) return a.d - b.d;
  const pa = MODE_PRIORITY.indexOf(a.mode);
  const pb = MODE_PRIORITY.indexOf(b.mode);
  if (pa !== pb) return pa - pb;
  const ea = a.entityId ?? "";
  const eb = b.entityId ?? "";
  if (ea !== eb) return ea < eb ? -1 : 1;
  return a.point.x - b.point.x || a.point.y - b.point.y;
}

// --- Constraints (ortho / polar / grid / tracking) --------------------------

export interface ConstrainResult {
  readonly point: Pt;
  /** Polar/ortho tracking angle (radians) when constrained, else null. */
  readonly angle: number | null;
  /** Alignment paths to render (tracking + current constraint). */
  readonly paths: readonly TrackingPath[];
}

export interface TrackingPath {
  readonly kind: "horizontal" | "vertical" | "angled";
  readonly angle: number;
  /** A point the path passes through. */
  readonly through: Pt;
}

/** Apply ortho/polar/grid/tracking constraints to a snapped point. */
export function constrainPoint(
  raw: Pt,
  lastPoint: Pt | null,
  settings: PrecisionSettings,
  acquired: readonly Pt[] = [],
): ConstrainResult {
  let point = raw;
  let angle: number | null = null;
  const paths: TrackingPath[] = [];

  if (lastPoint !== null) {
    const v = sub(point, lastPoint);
    const d = Math.hypot(v.x, v.y);
    if (d > EPS) {
      const a = angleOf(v);
      if (settings.ortho) {
        // Snap to the nearer axis.
        const deg = (a * 180) / Math.PI;
        const snappedDeg = Math.round(deg / 90) * 90;
        angle = (snappedDeg * Math.PI) / 180;
        point = {
          x: lastPoint.x + Math.cos(angle) * d,
          y: lastPoint.y + Math.sin(angle) * d,
        };
        paths.push({
          kind: snappedDeg % 180 === 0 ? "horizontal" : "vertical",
          angle,
          through: lastPoint,
        });
      } else if (settings.polar) {
        // Nearest polar increment within the capture tolerance (10°).
        const TOL = (10 * Math.PI) / 180;
        let bestDeg: number | null = null;
        let bestDiff = Infinity;
        for (const deg of settings.polarAnglesDeg) {
          const target = (deg * Math.PI) / 180;
          const diff = Math.abs(Math.abs(angleDiff(target, a)) > Math.PI
            ? TAU - Math.abs(angleDiff(target, a))
            : angleDiff(target, a));
          if (diff < bestDiff) {
            bestDiff = diff;
            bestDeg = deg;
          }
        }
        if (bestDeg !== null && bestDiff <= TOL) {
          angle = (bestDeg * Math.PI) / 180;
          point = {
            x: lastPoint.x + Math.cos(angle) * d,
            y: lastPoint.y + Math.sin(angle) * d,
          };
          paths.push({ kind: "angled", angle, through: lastPoint });
        }
      }
    }
  }

  // Object-snap tracking: alignment paths through acquired points.
  if (settings.tracking && acquired.length > 0) {
    for (const acq of acquired) {
      if (Math.abs(point.x - acq.x) <= settings.aperture / 2) {
        paths.push({ kind: "vertical", angle: Math.PI / 2, through: acq });
        // Snap X to the acquired point.
        point = { x: acq.x, y: point.y };
        break;
      }
      if (Math.abs(point.y - acq.y) <= settings.aperture / 2) {
        paths.push({ kind: "horizontal", angle: 0, through: acq });
        point = { x: point.x, y: acq.y };
        break;
      }
    }
  }

  if (settings.gridSnap) {
    const gs = settings.gridSize;
    if (gs > 0) {
      point = {
        x: Math.round(point.x / gs) * gs,
        y: Math.round(point.y / gs) * gs,
      };
    }
  }

  return { point, angle, paths };
}

// --- Deterministic picking --------------------------------------------------

/** Pick the entity under the cursor: smallest distance-to-cursor wins; ties
 *  broken by insertion order (entity id) — deterministic across hosts. */
export function pickAt(
  entities: readonly Entity[],
  cursor: Pt,
  aperture: number,
): Entity | null {
  let best: { e: Entity; d: number } | null = null;
  for (const e of entities) {
    const r = closestOn(e.geom, cursor);
    // Points and nodes need a looser hit test (they have no extent).
    const tol = e.geom.type === "point" ? aperture : aperture;
    if (r.d <= tol && (best === null || r.d < best.d - 1e-12)) {
      best = { e, d: r.d };
    }
  }
  return best !== null ? best.e : null;
}

export interface WindowSelection {
  readonly mode: "window" | "crossing";
  readonly min: Pt;
  readonly max: Pt;
}

function boxIntersectsBox(
  aMin: Pt,
  aMax: Pt,
  bMin: Pt,
  bMax: Pt,
): boolean {
  return (
    aMin.x <= bMax.x + 1e-9 &&
    aMax.x >= bMin.x - 1e-9 &&
    aMin.y <= bMax.y + 1e-9 &&
    aMax.y >= bMin.y - 1e-9
  );
}

/** Window (fully contained) vs crossing (any intersection) selection over
 *  conservative bounding boxes + exact curve-box test for edge cases. */
export function selectWindow(
  entities: readonly Entity[],
  sel: WindowSelection,
): string[] {
  const out: string[] = [];
  for (const e of entities) {
    if (sel.mode === "window") {
      if (entityFullyInside(e.geom, sel.min, sel.max)) out.push(e.id);
    } else {
      if (entityIntersectsBox(e.geom, sel.min, sel.max)) out.push(e.id);
    }
  }
  return out;
}

function entityFullyInside(g: Geom, min: Pt, max: Pt): boolean {
  switch (g.type) {
    case "line":
      return (
        Math.min(g.x1, g.x2) >= min.x - 1e-9 && Math.max(g.x1, g.x2) <= max.x + 1e-9 &&
        Math.min(g.y1, g.y2) >= min.y - 1e-9 && Math.max(g.y1, g.y2) <= max.y + 1e-9
      );
    case "ray":
    case "xline":
      return false; // infinite entities are never fully inside
    case "circle":
    case "ellipse":
      return g.cx - (g.type === "circle" ? g.r : g.rx) >= min.x - 1e-9 &&
        g.cx + (g.type === "circle" ? g.r : g.rx) <= max.x + 1e-9 &&
        g.cy - (g.type === "circle" ? g.r : g.ry) >= min.y - 1e-9 &&
        g.cy + (g.type === "circle" ? g.r : g.ry) <= max.y + 1e-9;
    case "arc": {
      // Conservative: all four extreme angles present + endpoints inside.
      const extremes: Pt[] = [arcStart(g), arcEnd(g)];
      for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        const rel = normAngle(a - g.startAngle);
        if (rel <= arcSweep(g) + 1e-9) {
          extremes.push({ x: g.cx + g.r * Math.cos(a), y: g.cy + g.r * Math.sin(a) });
        }
      }
      return extremes.every(
        (p) => p.x >= min.x - 1e-9 && p.x <= max.x + 1e-9 && p.y >= min.y - 1e-9 && p.y <= max.y + 1e-9,
      );
    }
    case "polyline":
      return g.vertices.every(
        (v) => v.x >= min.x - 1e-9 && v.x <= max.x + 1e-9 && v.y >= min.y - 1e-9 && v.y <= max.y + 1e-9,
      );
    case "spline":
      return sampleSpline(g, 8).every(
        (v) => v.x >= min.x - 1e-9 && v.x <= max.x + 1e-9 && v.y >= min.y - 1e-9 && v.y <= max.y + 1e-9,
      );
    case "point":
      return g.x >= min.x - 1e-9 && g.x <= max.x + 1e-9 && g.y >= min.y - 1e-9 && g.y <= max.y + 1e-9;
    case "region": {
      const b = g.boundary;
      if (b.kind === "polyline") {
        return b.vertices.every(
          (v) => v.x >= min.x - 1e-9 && v.x <= max.x + 1e-9 && v.y >= min.y - 1e-9 && v.y <= max.y + 1e-9,
        );
      }
      return entityFullyInside(
        b.kind === "circle"
          ? { type: "circle", cx: b.cx, cy: b.cy, r: b.r }
          : { type: "ellipse", cx: b.cx, cy: b.cy, rx: b.rx, ry: b.ry, rotation: b.rotation },
        min,
        max,
      );
    }
  }
}

function entityIntersectsBox(g: Geom, min: Pt, max: Pt): boolean {
  // Fast conservative reject: bbox vs box.
  const bb = entityBBox(g);
  if (!boxIntersectsBox({ x: bb.minX, y: bb.minY }, { x: bb.maxX, y: bb.maxY }, min, max)) return false;
  if (entityFullyInside(g, min, max)) return true;
  // Splines have no exact line intersections in this build (typed kernel
  // limitation) — crossing is tested against the deterministic sampled
  // polyline (same sample count as the fully-inside test).
  const testGeom: Geom = g.type === "spline"
    ? { type: "polyline", vertices: sampleSpline(g, 32), closed: false }
    : g;
  // The box's four edges as segments vs the entity.
  const corners: Pt[] = [min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }];
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    const edge: Geom = { type: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    if (intersectGeoms(testGeom, edge).length > 0) return true;
  }
  // Box fully inside a closed entity (e.g., tiny window inside a big circle).
  const c = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 };
  if ((g.type === "circle" && dist(c, { x: g.cx, y: g.cy }) < g.r) ||
      (g.type === "region" && g.boundary.kind === "circle" &&
        dist(c, { x: g.boundary.cx, y: g.boundary.cy }) < g.boundary.r)) {
    return true;
  }
  return false;
}


// --- Grips -------------------------------------------------------------------

export interface Grip {
  readonly entityId: string;
  readonly index: number;
  readonly point: Pt;
  readonly kind: "vertex" | "center" | "radius" | "mid";
}

/** Grip points for an entity (drag handles). */
export function gripsOf(e: Entity): Grip[] {
  const g = e.geom;
  const out: Grip[] = [];
  switch (g.type) {
    case "line":
      out.push({ entityId: e.id, index: 0, point: { x: g.x1, y: g.y1 }, kind: "vertex" });
      out.push({ entityId: e.id, index: 1, point: { x: g.x2, y: g.y2 }, kind: "vertex" });
      out.push({
        entityId: e.id,
        index: -1,
        point: { x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 },
        kind: "mid",
      });
      break;
    case "polyline":
      g.vertices.forEach((v, i) =>
        out.push({ entityId: e.id, index: i, point: v, kind: "vertex" }),
      );
      break;
    case "circle":
      out.push({ entityId: e.id, index: -1, point: { x: g.cx, y: g.cy }, kind: "center" });
      out.push({
        entityId: e.id,
        index: 0,
        point: { x: g.cx + g.r, y: g.cy },
        kind: "radius",
      });
      out.push({
        entityId: e.id,
        index: 1,
        point: { x: g.cx, y: g.cy + g.r },
        kind: "radius",
      });
      out.push({
        entityId: e.id,
        index: 2,
        point: { x: g.cx - g.r, y: g.cy },
        kind: "radius",
      });
      out.push({
        entityId: e.id,
        index: 3,
        point: { x: g.cx, y: g.cy - g.r },
        kind: "radius",
      });
      break;
    case "arc":
      out.push({ entityId: e.id, index: -1, point: { x: g.cx, y: g.cy }, kind: "center" });
      out.push({ entityId: e.id, index: 0, point: arcStart(g), kind: "vertex" });
      out.push({ entityId: e.id, index: 1, point: arcEnd(g), kind: "vertex" });
      break;
    case "ellipse":
      out.push({ entityId: e.id, index: -1, point: { x: g.cx, y: g.cy }, kind: "center" });
      out.push({
        entityId: e.id,
        index: 0,
        point: {
          x: g.cx + g.rx * Math.cos(g.rotation),
          y: g.cy + g.rx * Math.sin(g.rotation),
        },
        kind: "radius",
      });
      out.push({
        entityId: e.id,
        index: 1,
        point: {
          x: g.cx - g.rx * Math.cos(g.rotation),
          y: g.cy - g.rx * Math.sin(g.rotation),
        },
        kind: "radius",
      });
      break;
    case "spline":
      g.controlPoints.forEach((v, i) =>
        out.push({ entityId: e.id, index: i, point: v, kind: "vertex" }),
      );
      break;
    case "point":
      out.push({ entityId: e.id, index: 0, point: { x: g.x, y: g.y }, kind: "vertex" });
      break;
    case "ray":
    case "xline":
      out.push({ entityId: e.id, index: 0, point: { x: g.x1, y: g.y1 }, kind: "vertex" });
      break;
    case "region":
      out.push({ entityId: e.id, index: -1, point: g.centroid, kind: "center" });
      break;
  }
  return out;
}

/** Convert CADDocument elements to typed canonical entities through the
 *  bridge — BOTH storage conventions (COMPAT-CAD-001 drafting vocabulary and
 *  the CAD-PARITY-003 flat vocabulary) resolve to the SAME canonical view,
 *  so precision aids and modify commands see one geometry world. Annotations,
 *  BIM entities and malformed props are skipped (deterministic order
 *  preserved; LOCK-007: no guessing). */
export function toEntities(
  elements: readonly Element[],
): Entity[] {
  const out: Entity[] = [];
  for (const el of elements) {
    if (el.kind !== "geometry") continue;
    const geom = geomFromElement(el);
    if (geom === null) continue;
    const props = el.props as Record<string, unknown>;
    out.push({
      id: el.id,
      geom,
      layer: typeof props.layer === "string" && props.layer.length > 0 ? props.layer : "0",
      color: typeof props.color === "string" ? props.color : null,
      linetype: typeof props.linetype === "string" ? props.linetype : "Continuous",
    });
  }
  return out;
}
