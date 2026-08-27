/**
 * Canonical-ID associative drafting references (COMPAT-CAD-004).
 *
 * Associations store semantic references, never engine-native handles or
 * copied geometry. Rebuilding a dimension/annotation therefore resolves
 * against the current document entities each time.
 */

import type { DraftEntity } from "./entities.js";
import { distance } from "./geom2d.js";
import type { Vec2 } from "./precision.js";

export type AssociationAnchor =
  | { readonly entityId: string; readonly anchor: "start" | "end" | "center" | "midpoint" }
  | { readonly entityId: string; readonly anchor: "point"; readonly point: Vec2 };

export interface AssociativeDimension {
  readonly id: string;
  readonly kind: "linear" | "radius";
  readonly refs: readonly AssociationAnchor[];
  readonly labelPrefix?: string;
  readonly unit: "mm";
}

export interface AssociationResolution {
  readonly id: string;
  readonly status: "resolved" | "dangling" | "ambiguous";
  readonly points: readonly Vec2[];
  readonly value: number | null;
  readonly message: string;
}

export function resolveAssociation(
  association: AssociativeDimension,
  entities: readonly DraftEntity[],
): AssociationResolution {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const resolved: Vec2[] = [];

  for (const ref of association.refs) {
    const entity = byId.get(ref.entityId);
    if (!entity) {
      return {
        id: association.id,
        status: "dangling",
        points: resolved,
        value: null,
        message: `association references missing entity '${ref.entityId}'`,
      };
    }
    const point = anchorPoint(entity, ref);
    if (point === null) {
      return {
        id: association.id,
        status: "ambiguous",
        points: resolved,
        value: null,
        message: `association anchor '${ref.anchor}' is unsupported for entity '${ref.entityId}'`,
      };
    }
    resolved.push(point);
  }

  if (association.kind === "linear") {
    if (resolved.length !== 2) {
      return {
        id: association.id,
        status: "ambiguous",
        points: resolved,
        value: null,
        message: "linear association requires exactly two resolved anchors",
      };
    }
    return {
      id: association.id,
      status: "resolved",
      points: resolved,
      value: distance(resolved[0]!, resolved[1]!),
      message: "associative linear dimension resolved from canonical identities",
    };
  }

  if (association.kind === "radius") {
    const first = byId.get(association.refs[0]?.entityId ?? "");
    if (!first || (first.type !== "circle" && first.type !== "arc")) {
      return {
        id: association.id,
        status: "ambiguous",
        points: resolved,
        value: null,
        message: "radius association requires a circle or arc target",
      };
    }
    return {
      id: association.id,
      status: "resolved",
      points: resolved,
      value: first.radius,
      message: "associative radius resolved from canonical identity",
    };
  }
}

function anchorPoint(entity: DraftEntity, ref: AssociationAnchor): Vec2 | null {
  switch (entity.type) {
    case "line":
      if (ref.anchor === "start") return entity.from;
      if (ref.anchor === "end") return entity.to;
      if (ref.anchor === "midpoint") return [(entity.from[0] + entity.to[0]) / 2, (entity.from[1] + entity.to[1]) / 2];
      return null;
    case "polyline":
      if (ref.anchor === "start") return entity.points[0] ?? null;
      if (ref.anchor === "end") return entity.points[entity.points.length - 1] ?? null;
      if (ref.anchor === "midpoint") {
        const first = entity.points[0];
        const last = entity.points[entity.points.length - 1];
        return first && last ? [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2] : null;
      }
      return null;
    case "circle":
    case "arc":
      if (ref.anchor === "center") return entity.center;
      return null;
    case "rectangle":
      if (ref.anchor === "start") return entity.corner1;
      if (ref.anchor === "end") return entity.corner2;
      if (ref.anchor === "center") return [(entity.corner1[0] + entity.corner2[0]) / 2, (entity.corner1[1] + entity.corner2[1]) / 2];
      if (ref.anchor === "midpoint") return [(entity.corner1[0] + entity.corner2[0]) / 2, (entity.corner1[1] + entity.corner2[1]) / 2];
      return null;
    case "dim-linear":
    case "dim-radius":
      return null;
  }
}
