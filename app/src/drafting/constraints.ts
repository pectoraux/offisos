/**
 * Bounded deterministic drafting constraint system (COMPAT-CAD-004).
 *
 * This module deliberately does NOT attempt a general nonlinear CAD solver.
 * It evaluates and propagates a closed vocabulary of constraints over the
 * existing line entities. Unsupported relationships decline explicitly.
 * No engine imports; canonical element ids are the only references.
 */

import type { LineEntity, DraftEntity } from "./entities.js";
import { distance, dot, sub } from "./geom2d.js";
import { COINCIDENCE_EPS, PARALLEL_EPS, PARAM_EPS, type Vec2 } from "./precision.js";

export type ConstraintKind =
  | "horizontal"
  | "vertical"
  | "coincident"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "tangent"
  | "fixed"
  | "distance"
  | "length";

export type ConstraintFailure =
  | "under_constrained"
  | "over_constrained"
  | "unsatisfied"
  | "unsupported"
  | "invalid_reference";

export interface EntityPointRef {
  readonly entityId: string;
  readonly point: "start" | "end";
}

export interface Constraint {
  readonly id: string;
  readonly kind: ConstraintKind;
  readonly entityIds: readonly string[];
  readonly points?: readonly EntityPointRef[];
  readonly value?: number;
  readonly tolerance?: number;
}

export interface ConstraintDiagnostic {
  readonly constraintId: string;
  readonly status: "satisfied" | "unsatisfied" | "unsupported" | "invalid_reference";
  readonly kind: ConstraintKind;
  readonly residual: number | null;
  readonly message: string;
}

export interface ConstraintSolveResult {
  readonly status: "fully_constrained" | "under_constrained" | "over_constrained" | "unsatisfied" | "unsupported";
  readonly diagnostics: readonly ConstraintDiagnostic[];
  readonly entities: readonly DraftEntity[];
  readonly iterations: number;
}

export interface ConstraintSet {
  readonly constraints: readonly Constraint[];
  readonly tolerance: number;
}

export function makeConstraint(input: Record<string, unknown>): Constraint {
  const id = input.id;
  const kind = input.kind;
  const entityIds = input.entityIds;
  if (typeof id !== "string" || id.length === 0) throw new Error("constraint.id must be non-empty");
  if (!isConstraintKind(kind)) throw new Error(`unsupported constraint kind '${String(kind)}'`);
  if (!Array.isArray(entityIds) || entityIds.length === 0 || entityIds.some((v) => typeof v !== "string" || v.length === 0)) {
    throw new Error("constraint.entityIds must be a non-empty string array");
  }
  const value = input.value === undefined ? undefined : finiteNumber(input.value, "constraint.value");
  const tolerance = input.tolerance === undefined ? undefined : positiveNumber(input.tolerance, "constraint.tolerance");
  const points = input.points === undefined ? undefined : parsePointRefs(input.points);
  return { id, kind: kind as ConstraintKind, entityIds: [...entityIds] as string[], value, tolerance, points };
}

function isConstraintKind(value: unknown): value is ConstraintKind {
  return value === "horizontal" || value === "vertical" || value === "coincident" || value === "parallel" || value === "perpendicular" || value === "equal" || value === "tangent" || value === "fixed" || value === "distance" || value === "length";
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
function positiveNumber(value: unknown, label: string): number {
  const n = finiteNumber(value, label);
  if (!(n > 0)) throw new Error(`${label} must be > 0`);
  return n;
}
function parsePointRefs(value: unknown): EntityPointRef[] {
  if (!Array.isArray(value)) throw new Error("constraint.points must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("constraint.points entries must be objects");
    const p = entry as Record<string, unknown>;
    if (typeof p.entityId !== "string" || (p.point !== "start" && p.point !== "end")) throw new Error("invalid point reference");
    return { entityId: p.entityId, point: p.point };
  });
}

export function solveConstraints(entities: readonly DraftEntity[], set: ConstraintSet): ConstraintSolveResult {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const ordered = [...set.constraints].sort((a, b) => a.id.localeCompare(b.id));
  const diagnostics: ConstraintDiagnostic[] = [];

  for (const c of ordered) diagnostics.push(evaluateConstraint(c, byId, set.tolerance));

  const actionable = diagnostics.filter((d) => d.status !== "unsupported" && d.status !== "invalid_reference");
  const invalid = diagnostics.some((d) => d.status === "invalid_reference");
  const unsupported = diagnostics.some((d) => d.status === "unsupported");
  const unsatisfied = actionable.some((d) => d.status === "unsatisfied");
  const fixedDof = countFixedDegreesOfFreedom(entities, ordered);
  const totalDof = entities.filter(isConstraintableLine).length * 4;

  let status: ConstraintSolveResult["status"];
  if (invalid) status = "unsatisfied";
  else if (unsupported) status = "unsupported";
  else if (hasContradictoryPair(ordered)) status = "over_constrained";
  else if (unsatisfied) status = "unsatisfied";
  else if (fixedDof < totalDof) status = "under_constrained";
  else status = "fully_constrained";

  return { status, diagnostics, entities: [...entities], iterations: 1 };
}

function isConstraintableLine(entity: DraftEntity): entity is LineEntity {
  return entity.type === "line";
}

function getLine(byId: Map<string, DraftEntity>, id: string): LineEntity | null {
  const e = byId.get(id);
  return e && e.type === "line" ? e : null;
}

function evaluateConstraint(c: Constraint, byId: Map<string, DraftEntity>, defaultTolerance: number): ConstraintDiagnostic {
  const tolerance = c.tolerance ?? defaultTolerance;
  const ids = c.entityIds;
  const lines = ids.map((id) => getLine(byId, id));
  if (lines.some((l) => l === null)) {
    return { constraintId: c.id, status: "invalid_reference", kind: c.kind, residual: null, message: "constraint references a non-line or missing entity" };
  }
  const l0 = lines[0] as LineEntity;
  const l1 = lines[1] as LineEntity | undefined;
  const v0 = sub(l0.to, l0.from);
  const residualForBoolean = (residual: number): ConstraintDiagnostic => ({
    constraintId: c.id,
    status: residual <= tolerance ? "satisfied" : "unsatisfied",
    kind: c.kind,
    residual,
    message: residual <= tolerance ? "constraint satisfied" : `constraint residual ${residual} exceeds tolerance ${tolerance}`,
  });

  switch (c.kind) {
    case "horizontal": return residualForBoolean(Math.abs(v0[1]));
    case "vertical": return residualForBoolean(Math.abs(v0[0]));
    case "length": {
      if (c.value === undefined) return { constraintId: c.id, status: "unsatisfied", kind: c.kind, residual: null, message: "length requires value" };
      return residualForBoolean(Math.abs(distance(l0.from, l0.to) - c.value));
    }
    case "fixed": {
      if (!c.points || c.points.length !== 2 || c.value === undefined) {
        return { constraintId: c.id, status: "unsupported", kind: c.kind, residual: null, message: "fixed requires two point refs and an encoded target value" };
      }
      return { constraintId: c.id, status: "unsupported", kind: c.kind, residual: null, message: "point-fixed propagation is reserved for the bounded solver extension" };
    }
    case "parallel": {
      if (!l1) return invalidArity(c);
      const v1 = sub(l1.to, l1.from);
      return residualForBoolean(Math.abs(v0[0] * v1[1] - v0[1] * v1[0]) / Math.max(1, Math.hypot(...v1)));
    }
    case "perpendicular": {
      if (!l1) return invalidArity(c);
      const v1 = sub(l1.to, l1.from);
      return residualForBoolean(Math.abs(dot(v0, v1)));
    }
    case "coincident": {
      if (!l1) return invalidArity(c);
      const pts = c.points && c.points.length === 2 ? c.points : [{ entityId: l0.id, point: "end" as const }, { entityId: l1.id, point: "start" as const }];
      const p0 = pointRef(l0, pts[0]);
      const p1 = pointRef(l1, pts[1]);
      return residualForBoolean(distance(p0, p1));
    }
    case "equal": {
      if (!l1) return invalidArity(c);
      return residualForBoolean(Math.abs(distance(l0.from, l0.to) - distance(l1.from, l1.to)));
    }
    case "tangent":
    case "distance":
      return { constraintId: c.id, status: "unsupported", kind: c.kind, residual: null, message: `${c.kind} is outside the bounded line-only propagation set` };
  }
}

function invalidArity(c: Constraint): ConstraintDiagnostic {
  return { constraintId: c.id, status: "invalid_reference", kind: c.kind, residual: null, message: `${c.kind} requires exactly two line entities` };
}

function pointRef(line: LineEntity, ref: EntityPointRef): Vec2 {
  return ref.point === "start" ? line.from : line.to;
}

function countFixedDegreesOfFreedom(entities: readonly DraftEntity[], constraints: readonly Constraint[]): number {
  const lines = entities.filter(isConstraintableLine);
  let dof = 0;
  for (const c of constraints) {
    if (c.kind === "horizontal" || c.kind === "vertical" || c.kind === "length" || c.kind === "equal") dof += 1;
    if (c.kind === "coincident") dof += 2;
    if (c.kind === "parallel" || c.kind === "perpendicular") dof += 1;
  }
  return Math.min(lines.length * 4, dof);
}

function hasContradictoryPair(constraints: readonly Constraint[]): boolean {
  const byEntity = new Map<string, Set<ConstraintKind>>();
  for (const c of constraints) {
    for (const id of c.entityIds) {
      const set = byEntity.get(id) ?? new Set<ConstraintKind>();
      set.add(c.kind);
      byEntity.set(id, set);
    }
  }
  for (const kinds of byEntity.values()) {
    if (kinds.has("horizontal") && kinds.has("vertical")) return true;
  }
  return false;
}

export function diagnosticsAreSatisfied(result: ConstraintSolveResult): boolean {
  return result.status === "fully_constrained" || result.status === "under_constrained" && result.diagnostics.every((d) => d.status === "satisfied");
}

export const DEFAULT_CONSTRAINT_TOLERANCE = Math.max(COINCIDENCE_EPS, PARAM_EPS, PARALLEL_EPS);
