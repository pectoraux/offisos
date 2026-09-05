/**
 * CAD-PARITY-002 deterministic selection engine (Issue #75; CAD-P-004
 * "Deterministic selection, snapping, coordinates, grips and contextual
 * editing").
 *
 * Pure geometry over CADDocument elements — the same functions rank picks,
 * resolve window vs crossing selection and cycle stacked candidates on BOTH
 * hosts with identical results (LOCK-004 Web/Electron semantic parity).
 *
 * Coverage in this foundation slice (documented, not silently approximated):
 *  - ALL drafting entities (line, polyline, circle, arc, rectangle,
 *    dimensions) — precise curve-distance tests via the shared drafting core;
 *  - bim.wall — the plan footprint band around the wall centerline;
 *  - bim.slab — the axis-aligned footprint rectangle.
 * Component instances, doors and windows remain selectable through the
 * Navigator/Components palettes until their canvas pick support lands with
 * CAD-PARITY-004/012 (explicit non-goal of this slice).
 *
 * Ranking is a total order: distance ascending, then element id ascending —
 * every list this module returns is deterministic.
 */

import type { Element } from "../contracts/caddocument.js";
import { elementToDraftEntity, entityCurves, isDraftingElement } from "../drafting/entities.js";
import * as g from "../drafting/geom2d.js";
import type { Vec2 } from "../drafting/precision.js";

// ---------------------------------------------------------------------------
// Hit testing.
// ---------------------------------------------------------------------------

export interface PickCandidate {
  readonly id: string;
  /** Distance from the query point to the entity (≥ 0). */
  readonly distance: number;
  readonly kind: "drafting" | "wall" | "slab";
}

function elementDistance(el: Element, point: Vec2): number | null {
  const props = el.props as Record<string, unknown>;
  if (isDraftingElement(el)) {
    try {
      const entity = elementToDraftEntity(el);
      let best = Infinity;
      for (const curve of entityCurves(entity)) {
        let d: number;
        if (curve.kind === "segment") d = g.distanceToSegment(curve.a, curve.b, point);
        else if (curve.kind === "circle") d = Math.abs(g.distanceToCircle(curve.center, curve.radius, point));
        else if (curve.kind === "arc") d = g.distanceToArc(curve.center, curve.radius, curve.startAngle, curve.sweep, point);
        else d = Infinity;
        if (d < best) best = d;
      }
      return Number.isFinite(best) ? best : null;
    } catch {
      return null;
    }
  }
  if (el.kind === "bim" && props.type === "bim.wall") {
    const start = props.start as Vec2 | undefined;
    const end = props.end as Vec2 | undefined;
    const width = props.width as number | undefined;
    if (!Array.isArray(start) || !Array.isArray(end) || typeof width !== "number") return null;
    const d = g.distanceToSegment(start, end, point) - width / 2;
    return Math.max(0, d);
  }
  if (el.kind === "bim" && props.type === "bim.slab") {
    const corner1 = props.corner1 as Vec2 | undefined;
    const corner2 = props.corner2 as Vec2 | undefined;
    if (!Array.isArray(corner1) || !Array.isArray(corner2)) return null;
    const minX = Math.min(corner1[0], corner2[0]);
    const maxX = Math.max(corner1[0], corner2[0]);
    const minY = Math.min(corner1[1], corner2[1]);
    const maxY = Math.max(corner1[1], corner2[1]);
    const dx = Math.max(minX - point[0], 0, point[0] - maxX);
    const dy = Math.max(minY - point[1], 0, point[1] - maxY);
    return Math.hypot(dx, dy);
  }
  return null;
}

function candidateKind(el: Element): PickCandidate["kind"] {
  const props = el.props as Record<string, unknown>;
  if (el.kind === "bim" && props.type === "bim.wall") return "wall";
  if (el.kind === "bim" && props.type === "bim.slab") return "slab";
  return "drafting";
}

/**
 * All pickable elements within `tolerance` of the point, ranked by the total
 * order (distance asc, id asc). The caller passes VISIBLE elements only
 * (visibility is pickability — the same rule the snap core applies).
 */
export function hitTest(point: Vec2, tolerance: number, elements: readonly Element[]): readonly PickCandidate[] {
  const candidates: PickCandidate[] = [];
  for (const el of elements) {
    const distance = elementDistance(el, point);
    if (distance !== null && distance <= tolerance) {
      candidates.push({ id: el.id, distance, kind: candidateKind(el) });
    }
  }
  candidates.sort((a, b) => (a.distance !== b.distance ? a.distance - b.distance : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return candidates;
}

/** The best pick at a point, or null when nothing is within tolerance. */
export function pickAt(point: Vec2, tolerance: number, elements: readonly Element[]): string | null {
  const hits = hitTest(point, tolerance, elements);
  return hits.length > 0 ? (hits[0]!.id) : null;
}

/**
 * CYCLE through stacked candidates: repeated picks at the same location
 * advance through the ranked list (AutoCAD-class cycling). `lastIndex` is
 * the previously cycled index (-1 to start fresh); wraps around.
 */
export function cyclePick(
  point: Vec2,
  tolerance: number,
  elements: readonly Element[],
  lastIndex: number,
): { readonly id: string; readonly index: number } | null {
  const hits = hitTest(point, tolerance, elements);
  if (hits.length === 0) return null;
  const next = (lastIndex + 1) % hits.length;
  return { id: hits[next]!.id, index: next };
}

// ---------------------------------------------------------------------------
// Click selection semantics (with modifiers).
// ---------------------------------------------------------------------------

export type PickModifier = "replace" | "toggle";

/**
 * Apply one picked id to the current selection. `replace` is a plain click;
 * `toggle` (Shift/Ctrl held) adds or removes. Deterministic: the result is
 * order-independent for toggles and always keeps the original order plus
 * appended ids.
 */
export function applyPickModifier(current: readonly string[], id: string, modifier: PickModifier): readonly string[] {
  if (modifier === "replace") return current.length === 1 && current[0] === id ? current : [id];
  if (current.includes(id)) return current.filter((x) => x !== id);
  return [...current, id];
}

// ---------------------------------------------------------------------------
// Window / crossing selection.
// ---------------------------------------------------------------------------

export interface SelectionRectangle {
  readonly min: Vec2;
  readonly max: Vec2;
  /** window = left-to-right drag (fully contained); crossing = right-to-left
   *  drag (intersecting or contained). The host derives the mode from the
   *  drag direction — CAD-P-004. */
  readonly mode: "window" | "crossing";
}

export function selectionRectangle(a: Vec2, b: Vec2): SelectionRectangle {
  const mode: "window" | "crossing" = b[0] >= a[0] ? "window" : "crossing";
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
    mode,
  };
}

function rectContainsPoint(rect: SelectionRectangle, p: Vec2): boolean {
  return p[0] >= rect.min[0] && p[0] <= rect.max[0] && p[1] >= rect.min[1] && p[1] <= rect.max[1];
}

function segmentIntersectsRect(a: Vec2, b: Vec2, rect: SelectionRectangle): boolean {
  if (rectContainsPoint(rect, a) || rectContainsPoint(rect, b)) return true;
  // Liang–Barsky clip test. COMPAT-CAD-007 (Issue #142; DEF-006): the
  // branch convention is the standard one — a NEGATIVE denominator is an
  // ENTERING parameter (t0 candidate: reject when it is already past the
  // leaving bound), a POSITIVE denominator is a LEAVING parameter (t1
  // candidate: reject when it precedes the entering bound). The previous
  // inverted convention rejected every through-crossing segment whose BOTH
  // endpoints were outside the rect (the crossing window could never
  // capture them — the deterministic-crossing defect this phase fixes).
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const checks: readonly [number, number][] = [
    [-dx, a[0] - rect.min[0]],
    [dx, rect.max[0] - a[0]],
    [-dy, a[1] - rect.min[1]],
    [dy, rect.max[1] - a[1]],
  ];
  for (const [denom, num] of checks) {
    if (denom === 0) {
      if (num < 0) return false;
    } else {
      const t = num / denom;
      if (denom < 0) {
        // Entering boundary: t must not pass the leaving bound.
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        // Leaving boundary: t must not precede the entering bound.
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

function circleIntersectsRect(center: Vec2, radius: number, rect: SelectionRectangle): boolean {
  const cx = Math.max(rect.min[0], Math.min(center[0], rect.max[0]));
  const cy = Math.max(rect.min[1], Math.min(center[1], rect.max[1]));
  return Math.hypot(center[0] - cx, center[1] - cy) <= radius;
}

function arcIntersectsRect(
  center: Vec2,
  radius: number,
  startAngle: number,
  sweep: number,
  rect: SelectionRectangle,
): boolean {
  // Sample the arc deterministically (64 steps — precise enough for pick
  // semantics and identical on every host).
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const angle = startAngle + (sweep * i) / steps;
    const p: Vec2 = [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
    if (rectContainsPoint(rect, p)) return true;
  }
  return false;
}

function entityIntersectsRect(el: Element, rect: SelectionRectangle): boolean {
  if (isDraftingElement(el)) {
    try {
      const entity = elementToDraftEntity(el);
      for (const curve of entityCurves(entity)) {
        if (curve.kind === "segment") {
          if (segmentIntersectsRect(curve.a, curve.b, rect)) return true;
        } else if (curve.kind === "circle") {
          if (circleIntersectsRect(curve.center, curve.radius, rect)) return true;
        } else if (curve.kind === "arc") {
          if (arcIntersectsRect(curve.center, curve.radius, curve.startAngle, curve.sweep, rect)) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }
  const props = el.props as Record<string, unknown>;
  if (el.kind === "bim" && props.type === "bim.wall") {
    const start = props.start as Vec2 | undefined;
    const end = props.end as Vec2 | undefined;
    const width = props.width as number | undefined;
    if (!Array.isArray(start) || !Array.isArray(end) || typeof width !== "number") return false;
    // Conservative + deterministic: the wall's axis-aligned footprint rect.
    const half = width / 2;
    const min: Vec2 = [Math.min(start[0], end[0]) - half, Math.min(start[1], end[1]) - half];
    const max: Vec2 = [Math.max(start[0], end[0]) + half, Math.max(start[1], end[1]) + half];
    return !(max[0] < rect.min[0] || min[0] > rect.max[0] || max[1] < rect.min[1] || min[1] > rect.max[1]);
  }
  if (el.kind === "bim" && props.type === "bim.slab") {
    const corner1 = props.corner1 as Vec2 | undefined;
    const corner2 = props.corner2 as Vec2 | undefined;
    if (!Array.isArray(corner1) || !Array.isArray(corner2)) return false;
    return !(
      Math.max(corner1[0], corner2[0]) < rect.min[0] ||
      Math.min(corner1[0], corner2[0]) > rect.max[0] ||
      Math.max(corner1[1], corner2[1]) < rect.min[1] ||
      Math.min(corner1[1], corner2[1]) > rect.max[1]
    );
  }
  return false;
}

function entityContainedInRect(el: Element, rect: SelectionRectangle): boolean {
  if (isDraftingElement(el)) {
    try {
      const entity = elementToDraftEntity(el);
      // Segments are contained iff both endpoints are; circles/arcs use the
      // exact radial test via their extreme points.
      for (const curve of entityCurves(entity)) {
        if (curve.kind === "segment") {
          if (!rectContainsPoint(rect, curve.a) || !rectContainsPoint(rect, curve.b)) return false;
        } else if (curve.kind === "circle") {
          if (
            !rectContainsPoint(rect, [curve.center[0] - curve.radius, curve.center[1]]) ||
            !rectContainsPoint(rect, [curve.center[0] + curve.radius, curve.center[1]]) ||
            !rectContainsPoint(rect, [curve.center[0], curve.center[1] - curve.radius]) ||
            !rectContainsPoint(rect, [curve.center[0], curve.center[1] + curve.radius])
          ) {
            return false;
          }
        } else if (curve.kind === "arc") {
          const steps = 64;
          for (let i = 0; i <= steps; i++) {
            const angle = curve.startAngle + (curve.sweep * i) / steps;
            const p: Vec2 = [curve.center[0] + curve.radius * Math.cos(angle), curve.center[1] + curve.radius * Math.sin(angle)];
            if (!rectContainsPoint(rect, p)) return false;
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }
  const props = el.props as Record<string, unknown>;
  if (el.kind === "bim" && props.type === "bim.wall") {
    const start = props.start as Vec2 | undefined;
    const end = props.end as Vec2 | undefined;
    const width = props.width as number | undefined;
    if (!Array.isArray(start) || !Array.isArray(end) || typeof width !== "number") return false;
    const half = width / 2;
    const min: Vec2 = [Math.min(start[0], end[0]) - half, Math.min(start[1], end[1]) - half];
    const max: Vec2 = [Math.max(start[0], end[0]) + half, Math.max(start[1], end[1]) + half];
    return rectContainsPoint(rect, min) && rectContainsPoint(rect, max);
  }
  if (el.kind === "bim" && props.type === "bim.slab") {
    const corner1 = props.corner1 as Vec2 | undefined;
    const corner2 = props.corner2 as Vec2 | undefined;
    if (!Array.isArray(corner1) || !Array.isArray(corner2)) return false;
    return (
      rectContainsPoint(rect, corner1) &&
      rectContainsPoint(rect, corner2)
    );
  }
  return false;
}

/**
 * Window/crossing selection over the visible elements. Returns the selected
 * ids in DOCUMENT ORDER (stable — not hit-rank order) so the result is
 * independent of the drag direction magnitude.
 */
export function windowSelect(rect: SelectionRectangle, elements: readonly Element[]): readonly string[] {
  const ids: string[] = [];
  for (const el of elements) {
    if (rect.mode === "window") {
      if (entityContainedInRect(el, rect)) ids.push(el.id);
    } else {
      if (entityIntersectsRect(el, rect)) ids.push(el.id);
    }
  }
  return ids;
}
