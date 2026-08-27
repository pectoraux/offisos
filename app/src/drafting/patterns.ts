/**
 * Deterministic reusable 2D symbols/blocks and pattern transforms.
 * COMPAT-CAD-004. Engine-free; identities are supplied by the document layer.
 */

import type { DraftEntity, DraftEntityInput } from "./entities.js";
import type { Vec2 } from "./precision.js";

export interface SymbolDefinition {
  readonly id: string;
  readonly name: string;
  readonly entities: readonly DraftEntity[];
}

export interface SymbolInstance {
  readonly id: string;
  readonly definitionId: string;
  readonly origin: Vec2;
  readonly rotation: number;
  readonly scale: number;
}

export interface PatternSpec {
  readonly count: number;
  readonly dx: number;
  readonly dy: number;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

export function makeSymbolDefinition(id: string, name: string, entities: readonly DraftEntity[]): SymbolDefinition {
  if (!id || !name) throw new Error("symbol definition id and name are required");
  if (entities.length === 0) throw new Error("symbol definition must contain at least one entity");
  const ids = new Set<string>();
  for (const entity of entities) {
    if (ids.has(entity.id)) throw new Error(`duplicate symbol entity id '${entity.id}'`);
    ids.add(entity.id);
  }
  return { id, name, entities: [...entities] };
}

export function makeSymbolInstance(id: string, definitionId: string, origin: Vec2, rotation = 0, scale = 1): SymbolInstance {
  if (!id || !definitionId) throw new Error("symbol instance id and definitionId are required");
  finite(origin[0], "origin.x");
  finite(origin[1], "origin.y");
  finite(rotation, "rotation");
  scale = finite(scale, "scale");
  if (!(scale > 0)) throw new Error("symbol instance scale must be > 0");
  return { id, definitionId, origin: [origin[0], origin[1]], rotation, scale };
}

export function validatePattern(spec: PatternSpec): PatternSpec {
  const count = finite(spec.count, "count");
  if (!Number.isInteger(count) || count < 1) throw new Error("pattern.count must be an integer >= 1");
  const dx = finite(spec.dx, "dx");
  const dy = finite(spec.dy, "dy");
  return { count, dx, dy };
}

/** Stable translated origins for a linear array. Index 0 is the source. */
export function linearArray(origin: Vec2, spec: PatternSpec): readonly Vec2[] {
  const s = validatePattern(spec);
  return Array.from({ length: s.count }, (_, i) => [origin[0] + s.dx * i, origin[1] + s.dy * i] as Vec2);
}

/** Mirror a 2D point across a horizontal or vertical construction line. */
export function mirrorPoint(point: Vec2, axis: "x" | "y", offset: number): Vec2 {
  const o = finite(offset, "offset");
  return axis === "x" ? [point[0], 2 * o - point[1]] : [2 * o - point[0], point[1]];
}

/** Deterministically transform supported drafting point-bearing inputs. */
export function transformDraftEntity(entity: DraftEntityInput, transform: (point: Vec2) => Vec2): DraftEntityInput {
  switch (entity.type) {
    case "line":
      return { ...entity, from: transform(entity.from), to: transform(entity.to) };
    case "polyline":
      return { ...entity, points: entity.points.map(transform) };
    case "circle":
      return { ...entity, center: transform(entity.center) };
    case "arc":
      return { ...entity, center: transform(entity.center) };
    case "rectangle":
      return { ...entity, corner1: transform(entity.corner1), corner2: transform(entity.corner2) };
    case "dim-linear":
      return { ...entity, p1: transform(entity.p1), p2: transform(entity.p2) };
    case "dim-radius":
      return { ...entity };
  }
}

export function instancePositions(instance: SymbolInstance, pattern?: PatternSpec): readonly Vec2[] {
  return pattern ? linearArray(instance.origin, pattern) : [instance.origin];
}
