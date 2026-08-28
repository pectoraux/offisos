/**
 * CAD/BIM App API — the semantic command/query contract v1 (§5.3, §5.5,
 * api-contract.md).
 *
 * This contract sits below the hosts and above the CAD/BIM engine. The same
 * contract is testable through both the Web Host and the Electron Host (§5.5).
 * The contract exposes stable construction-domain capabilities, not internal
 * implementation details (api-contract.md §1, §12). Mutating operations
 * support idempotency keys (api-contract.md §4).
 */

export const APP_API_VERSION = "1" as const;
export type AppApiVersion = typeof APP_API_VERSION;

// --- Command names (mutating; idempotency-supported) ---
// `document.create` resets to a fresh empty document (new entity id, root
// version, cleared selection). `document.setSelection` mutates the ephemeral
// editor selection WITHOUT bumping the document version or pushing an undo
// entry (selection is non-versioned editor state, §5.4). `document.save`
// persists the snapshot through the file adapter and returns file bytes.
// `geometry.prepare` (CAD-IMPLEMENT-002, additive per api-contract.md §8)
// asks the geometry engine adapter to realize an engine-independent
// GeometryDescriptor (contracts/geometry.ts) and returns the deterministic
// GeometryResult { meshToken, bbox } (+ optional viewport mesh and
// selection/query metadata when the concrete adapter provides them). It does
// NOT mutate the document — callers persist the result via
// document.applyEdit(addElement) with the returned meshToken in props.
export type CommandName =
  | "document.create"
  | "document.open"
  | "document.applyEdit"
  | "document.setSelection"
  | "document.undo"
  | "document.redo"
  | "document.serialize"
  | "document.deserialize"
  | "document.save"
  | "geometry.prepare"
  // --- CAD-PARITY-003 (additive, Issue #78): canonical 2D entities ---
  | "entity.create"
  | "entity.modify"
  // --- COMPAT-CAD-001 (additive, api-contract.md §8): 2D drafting ---
  | "drafting.createEntities"
  | "drafting.move"
  | "drafting.copy"
  | "drafting.delete"
  | "drafting.trim"
  | "drafting.extend"
  | "drafting.setSettings"
  | "drafting.addLayer"
  | "drafting.updateLayer"
  | "drafting.removeLayer"
  // --- COMPAT-CAD-002 (additive, api-contract.md §8): 3D/BIM authoring ---
  | "bim.createElements"
  | "bim.move"
  | "bim.copy"
  | "bim.delete"
  | "bim.setProperties"
  | "bim.setSettings"
  | "bim.buildGeometry"
  // --- COMPAT-CAD-003 (additive, api-contract.md §8): documentation ---
  | "docs.createViews"
  | "docs.updateView"
  | "docs.removeView"
  | "docs.createSheets"
  | "docs.updateSheet"
  | "docs.removeSheet"
  | "docs.addAnnotations"
  | "docs.removeAnnotations"
  | "docs.regenerate"
  // COMPAT-IFC-001 (additive): IFC/openBIM interoperability (export bytes,
  // reconciling import, BCF topic containers). Read-only surfaces are queries.
  | "ifc.export"
  | "ifc.import"
  | "ifc.bcfCreate";

// --- Query names (non-mutating) ---
// `document.getSelection` returns the ephemeral editor selection (orthogonal
// to the versioned snapshot, so it does not affect the parity hash, §5.5).
// CAD-IMPLEMENT-003 (additive, api-contract.md §8): the model/revision and
// Construction Graph bridge surface is read-only queries —
// `model.getHistory` returns the immutable ModelRevision log persisted with
// the document; `model.getGraphEvents` returns the deterministic
// graph-facing event stream (model.created / model.version.created) produced
// by the Construction Graph bridge from that history; `model.replay`
// deterministically replays the history to a given revision number
// (0 = base) — information-state correct, no future leakage.
// RESEARCH-CAD-007 (additive, api-contract.md §8): `impact.cascade` runs the
// deterministic downstream chain for one model transition —
// quantity.recalculate.requested → quantity.changed → estimate.recalculated
// → rfq.scope.impact.detected plus the aggregate commercial impact — caused
// by the corresponding `model.version.created` graph event. Quantities are
// computed through the bound geometry engine adapter (engine ids are
// provenance only; every downstream identity is canonical and engine-free).
// Non-mutating.
export type QueryName =
  | "document.getState"
  | "document.getVersion"
  | "document.canUndo"
  | "document.canRedo"
  | "document.getSelection"
  | "model.getHistory"
  | "model.getGraphEvents"
  | "model.replay"
  | "impact.cascade"
  // COMPAT-CAD-001 (additive): deterministic snap resolution.
  | "drafting.snap"
  // CAD-PARITY-003 (additive, Issue #78): the shared precision engine as
  // queries — the SAME modules the host renderers run (parity by
  // construction).
  | "precision.snap"
  | "precision.pick"
  | "precision.window"
  // COMPAT-CAD-002 (additive): BIM structure, semantics and cameras.
  | "bim.getBuilding"
  // COMPAT-BIM-003 (additive): component/material/coordination inventory
  // with derived parametric state.
  | "bim.getComponents"
  | "bim.getSemantics"
  | "bim.camera"
  // COMPAT-CAD-003 (additive): documentation views, geometry and exports.
  | "docs.listViews"
  | "docs.getViewGeometry"
  | "docs.listSheets"
  | "docs.exportSheet"
  // COMPAT-IFC-001 (additive): IFC engine probe, dry-run reconciliation,
  // IDS validation, BCF parsing and the persisted import-record list.
  | "ifc.probe"
  | "ifc.compare"
  | "ifc.idsValidate"
  | "ifc.bcfParse"
  | "ifc.listImports";

export interface Command {
  readonly type: "command";
  readonly name: CommandName;
  readonly payload: unknown;
  /** Idempotency key for mutating operations (api-contract.md §4). Two
   *  commands with the same key are applied at most once. */
  readonly idempotencyKey?: string;
}

export interface Query {
  readonly type: "query";
  readonly name: QueryName;
  readonly payload: unknown;
}

export type CommandQueryRequest = Command | Query;

export interface OkResult {
  readonly ok: true;
  readonly value: unknown;
}

export interface ErrResult {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  /** Whether the caller may retry (api-contract.md §7). */
  readonly retryable: boolean;
}

export type CommandQueryResponse = OkResult | ErrResult;

/** Stable wire envelope. The transport carries this JSON; both hosts decode
 *  to the same `CommandQueryRequest`/`CommandQueryResponse`. Versioning is
 *  additive (api-contract.md §8): breaking changes create a new version. */
export interface WireEnvelope {
  readonly api: AppApiVersion;
  readonly body: CommandQueryRequest;
}

export function ok(value: unknown): OkResult {
  return { ok: true, value };
}

export function err(code: string, message: string, retryable = false): ErrResult {
  return { ok: false, code, message, retryable };
}
