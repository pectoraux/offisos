/**
 * CAD/BIM App API handler v1 (§5.3, §5.5, api-contract.md).
 *
 * Sits below the hosts and above the CAD/BIM engine. Receives a
 * CommandQueryRequest through any Transport, validates the payload against
 * the wire schema, dispatches commands to the CADDocument (and engine adapters
 * when the command requires them), and returns a CommandQueryResponse.
 *
 * The same handler logic is exercised through both the Web Host and the
 * Electron Host (§5.5). The handler holds a CADDocument (editor's working
 * representation, §5.4) and an EngineAdapterBundle (LOCK-003/018). The renderer
 * never sees the adapter bundle — only the App API does.
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type {
  Command,
  CommandQueryRequest,
  CommandQueryResponse,
  Query,
} from "../contracts/app-api.js";
import type { EngineAdapterBundle } from "../contracts/adapter.js";
import type { CADDocumentSnapshot, DocumentEdit, Element, VersionMeta } from "../contracts/caddocument.js";
import { CADDocument } from "../caddocument/index.js";
import { deserialize, serialize } from "../caddocument/index.js";
import { err, ok } from "../contracts/app-api.js";
import {
  isAdapterFailure,
  isGeometryMetadataProvider,
  isMeshProvider,
} from "../contracts/geometry.js";
import type { GeometryPrepareResult } from "../contracts/geometry.js";
import { IdempotencyCache } from "./idempotency.js";
import { bridgeModelHistory } from "../graph/index.js";
import { verifiedReplay } from "../caddocument/history.js";
import { runImpactCascade } from "../impact/index.js";
import type { ModelReplayResult } from "../contracts/model.js";
import {
  buildDraftingCreate,
  copyEntities,
  deleteEntities,
  extendEntity,
  moveEntities,
  trimEntity,
} from "../drafting/commands.js";
import { resolveSnap } from "../drafting/snap.js";
// CAD-PARITY-003 (additive): the shared 2D entity operations + precision
// engine (workspace core — engine-free, LOCK-018 scanned).
import { createEntities, modifyEntities, EntityOpError } from "../workspace/entity-ops.js";
import {
  pickAt as precisionPickAt,
  resolveSnap as precisionResolveSnap,
  selectWindow as precisionSelectWindow,
  toEntities as toPrecisionEntities,
  type OsnapMode,
  type PrecisionSettings,
} from "../workspace/precision-2d.js";
import { canonicalSnapKinds, validateDraftingSettings, validateBimSettings } from "../caddocument/workspace.js";
import type { LayerRecord } from "../contracts/caddocument.js";
// COMPAT-CAD-002: the pure BIM authoring core (LOCK-018 scanned).
import {
  buildBimCreate,
  bimGeometryContext,
  bimModelBBox,
  bimSolidDescriptor,
  copyBimElements,
  deleteBimElements,
  elementToBimEntityOrNull,
  extractElementSemanticsSafe,
  moveBimElements,
  setBimProperties,
  standardCamera,
} from "../bim/index.js";
// COMPAT-BIM-003: the pure component/material/coordination core.
import {
  effectiveBox,
  effectiveMaterialId,
  effectiveParameters,
  type ComponentDefEntity,
  type GridEntity,
  type MaterialEntity,
  type ReferencePlaneEntity,
} from "../bim/index.js";
// COMPAT-IFC-001: the pure IFC/openBIM core + the optional interop adapter
// capability (LOCK-018 — the engine stays behind the adapter boundary).
import {
  buildIfcExportRequest,
  ifcGuidFor,
  importEntitiesToElements,
  ifcReportHash,
  reconcileIfcImport,
  type IfcImportReport,
} from "../ifc/index.js";
import { isIfcInteropProvider } from "../contracts/adapter.js";
import type { IfcInteropAdapter } from "../contracts/adapter.js";
// COMPAT-CAD-003: the pure construction-documentation core (LOCK-018 scanned).
import {
  annotationElement,
  buildSheetIR,
  isDocsExportFormat,
  isDocsAnnotationType,
  makeDocsDim,
  makeDocsNote,
  makeDocsTag,
  projectAllViews,
  regenerateDocumentation,
  viewContentHash,
} from "../docs/index.js";
import type { DocsSheetRecord, DocsViewRecord } from "../contracts/caddocument.js";
import { validateDocsSheetRecord, validateDocsViewRecord } from "../caddocument/workspace.js";

export interface AppApiHandlerOptions {
  readonly adapterBundle: EngineAdapterBundle;
  readonly entityId: string;
  readonly format: string;
  readonly formatVersion: string;
  readonly createdBy: string;
}

export class AppApiHandler {
  private doc: CADDocument;
  private readonly adapters: EngineAdapterBundle;
  private readonly options: AppApiHandlerOptions;
  private readonly idempotency: IdempotencyCache = new IdempotencyCache();

  private constructor(options: AppApiHandlerOptions, doc: CADDocument, adapters: EngineAdapterBundle) {
    this.options = options;
    this.doc = doc;
    this.adapters = adapters;
  }

  /** Create a handler with an empty document (root version). */
  static create(options: AppApiHandlerOptions): AppApiHandler {
    const doc = CADDocument.empty(options.entityId, options.format, options.formatVersion, options.createdBy);
    return new AppApiHandler(options, doc, options.adapterBundle);
  }

  /** Process a command/query request. Idempotent for commands with a key. */
  async handle(request: CommandQueryRequest): Promise<CommandQueryResponse> {
    if (request.type === "command" && request.idempotencyKey !== undefined) {
      const cached = this.idempotency.get(request.idempotencyKey);
      if (cached !== undefined) return cached;
    }
    const response =
      request.type === "command" ? await this.handleCommand(request) : await this.handleQuery(request);
    if (request.type === "command" && request.idempotencyKey !== undefined) {
      this.idempotency.set(request.idempotencyKey, response);
    }
    return response;
  }

  /** Current document content hash (for parity assertions across hosts). */
  currentContentHash(): string {
    return this.doc.currentContentHash();
  }

  // --- Commands -----------------------------------------------------------

  private async handleCommand(command: Command): Promise<CommandQueryResponse> {
    switch (command.name) {
      case "document.create":
        return this.cmdCreate(command.payload);
      case "document.open":
        return this.cmdOpen(command.payload);
      case "document.applyEdit":
        return this.cmdApplyEdit(command.payload);
      case "document.setSelection":
        return this.cmdSetSelection(command.payload);
      case "document.undo":
        return this.cmdUndo();
      case "document.redo":
        return this.cmdRedo();
      case "document.serialize":
        return this.cmdSerialize();
      case "document.deserialize":
        return this.cmdDeserialize(command.payload);
      case "document.save":
        return this.cmdSave();
      case "geometry.prepare":
        return this.cmdPrepareGeometry(command.payload);
      // --- CAD-PARITY-003 (additive): canonical 2D entity commands ---
      case "entity.create":
        return this.cmdEntityCreate(command.payload);
      case "entity.modify":
        return this.cmdEntityModify(command.payload);
      // --- COMPAT-CAD-001 (additive): 2D drafting commands ---
      case "drafting.createEntities":
        return this.cmdDraftingCreate(command.payload);
      case "drafting.move":
        return this.cmdDraftingTransform(command.payload, "move");
      case "drafting.copy":
        return this.cmdDraftingTransform(command.payload, "copy");
      case "drafting.delete":
        return this.cmdDraftingDelete(command.payload);
      case "drafting.trim":
        return this.cmdDraftingTrimExtend(command.payload, "trim");
      case "drafting.extend":
        return this.cmdDraftingTrimExtend(command.payload, "extend");
      case "drafting.setSettings":
        return this.cmdDraftingSetSettings(command.payload);
      case "drafting.addLayer":
        return this.cmdDraftingLayer(command.payload, "add");
      case "drafting.updateLayer":
        return this.cmdDraftingLayer(command.payload, "update");
      case "drafting.removeLayer":
        return this.cmdDraftingLayer(command.payload, "remove");
      // --- COMPAT-CAD-002 (additive): 3D/BIM authoring commands ---
      case "bim.createElements":
        return this.cmdBimCreate(command.payload);
      case "bim.move":
        return this.cmdBimTransform(command.payload, "move");
      case "bim.copy":
        return this.cmdBimTransform(command.payload, "copy");
      case "bim.delete":
        return this.cmdBimDelete(command.payload);
      case "bim.setProperties":
        return this.cmdBimSetProperties(command.payload);
      case "bim.setSettings":
        return this.cmdBimSetSettings(command.payload);
      case "bim.buildGeometry":
        return await this.cmdBimBuildGeometry(command.payload);
      // --- COMPAT-CAD-003 (additive): documentation commands ---
      case "docs.createViews":
        return this.cmdDocsCreateViews(command.payload);
      case "docs.updateView":
        return this.cmdDocsUpdateView(command.payload);
      case "docs.removeView":
        return this.cmdDocsRemoveView(command.payload);
      case "docs.createSheets":
        return this.cmdDocsCreateSheets(command.payload);
      case "docs.updateSheet":
        return this.cmdDocsUpdateSheet(command.payload);
      case "docs.removeSheet":
        return this.cmdDocsRemoveSheet(command.payload);
      case "docs.addAnnotations":
        return this.cmdDocsAddAnnotations(command.payload);
      case "docs.removeAnnotations":
        return this.cmdDocsRemoveAnnotations(command.payload);
      case "docs.regenerate":
        return this.cmdDocsRegenerate();
      case "ifc.export":
        return this.cmdIfcExport(command.payload);
      case "ifc.import":
        return this.cmdIfcImport(command.payload);
      case "ifc.bcfCreate":
        return this.cmdIfcBcfCreate(command.payload);
      default: {
        const _exhaustive: never = command.name;
        return err("unknown_command", `unknown command: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  private async cmdCreate(payload: unknown): Promise<CommandQueryResponse> {
    const p = (payload ?? {}) as {
      entityId?: string;
      format?: string;
      formatVersion?: string;
      createdBy?: string;
    } | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", "create payload must be an object", true);
    }
    const entityId = typeof p.entityId === "string" && p.entityId.length > 0 ? p.entityId : randomUUID();
    const format = typeof p.format === "string" ? p.format : this.options.format;
    const formatVersion = typeof p.formatVersion === "string" ? p.formatVersion : this.options.formatVersion;
    const createdBy = typeof p.createdBy === "string" ? p.createdBy : this.options.createdBy;
    this.doc = CADDocument.empty(entityId, format, formatVersion, createdBy);
    return ok(this.doc.snapshot());
  }

  private async cmdOpen(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { snapshot?: CADDocumentSnapshot; source?: number[] | Uint8Array } | null;
    if (p === null || typeof p !== "object") return err("bad_payload", "open payload must be an object", true);
    let snapshot: CADDocumentSnapshot;
    if (p.snapshot !== undefined) {
      snapshot = p.snapshot;
    } else if (p.source !== undefined) {
      try {
        // The wire contract is JSON; a Uint8Array source survives the wire as a
        // plain number[]. Normalize back to Uint8Array for the file adapter.
        const source =
          p.source instanceof Uint8Array ? p.source : new Uint8Array(p.source);
        snapshot = await this.adapters.file.read(source);
      } catch (e) {
        return err("file_read_failed", `file adapter read failed: ${(e as Error).message}`, false);
      }
    } else {
      return err("bad_payload", "open requires snapshot or source", true);
    }
    try {
      // CAD-IMPLEMENT-003: open now adopts/validates the persisted model
      // revision history carried by the snapshot (LOCK-007: malformed
      // history is rejected, never guessed or silently repaired).
      this.doc = CADDocument.open(snapshot, this.options.createdBy);
    } catch (e) {
      return err("open_failed", `open rejected the snapshot: ${(e as Error).message}`, false);
    }
    return ok(this.doc.snapshot());
  }

  private async cmdApplyEdit(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { edit?: DocumentEdit } | null;
    if (p === null || typeof p !== "object" || p.edit === undefined) {
      return err("bad_payload", "applyEdit requires edit", true);
    }
    try {
      this.doc.execute(p.edit);
    } catch (e) {
      return err("edit_failed", (e as Error).message, false);
    }
    return ok(this.doc.snapshot());
  }

  private async cmdUndo(): Promise<CommandQueryResponse> {
    const undone = this.doc.undo();
    if (undone === null) return err("nothing_to_undo", "undo stack is empty", false);
    return ok({ undone, snapshot: this.doc.snapshot() });
  }

  private async cmdRedo(): Promise<CommandQueryResponse> {
    const redone = this.doc.redo();
    if (redone === null) return err("nothing_to_redo", "redo stack is empty", false);
    return ok({ redone, snapshot: this.doc.snapshot() });
  }

  private async cmdSerialize(): Promise<CommandQueryResponse> {
    return ok(serialize(this.doc.snapshot()));
  }

  private async cmdDeserialize(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { text?: string } | null;
    if (p === null || typeof p !== "object" || typeof p.text !== "string") {
      return err("bad_payload", "deserialize requires text", true);
    }
    try {
      const snapshot = deserialize(p.text);
      this.doc = CADDocument.open(snapshot, this.options.createdBy);
    } catch (e) {
      return err("deserialize_failed", (e as Error).message, false);
    }
    return ok(this.doc.snapshot());
  }

  private async cmdSetSelection(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { ids?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids)) {
      return err("bad_payload", "setSelection requires ids array", true);
    }
    const ids = p.ids as unknown[];
    if (!ids.every((x) => typeof x === "string")) {
      return err("bad_payload", "setSelection ids must all be strings", true);
    }
    this.doc.setSelection(ids as string[]);
    return ok({ selection: [...this.doc.selection] });
  }

  private async cmdSave(): Promise<CommandQueryResponse> {
    try {
      const bytes = await this.adapters.file.write(this.doc.snapshot());
      // The wire contract is JSON; Uint8Array survives the wire as a plain
      // number[]. Return both forms for caller convenience.
      return ok({ bytes: Array.from(bytes), format: this.doc.snapshot().format });
    } catch (e) {
      return err("file_write_failed", `file adapter write failed: ${(e as Error).message}`, false);
    }
  }

  /**
   * geometry.prepare (CAD-IMPLEMENT-002, additive): realize an
   * engine-independent GeometryDescriptor through the geometry engine
   * adapter (LOCK-003/018 — the only place the App API touches the engine).
   * Non-mutating: callers persist the result via applyEdit(addElement).
   *
   * Typed failure mapping (CAD-005 §5): an AdapterFailure thrown by the
   * adapter becomes the wire ErrResult verbatim (engine_timeout /
   * engine_malformed_input / engine_error / engine_unavailable). The
   * adapter's result is structurally validated before it is returned
   * (never trust engine output blindly). Viewport mesh data and
   * selection/query metadata are attached when the concrete adapter
   * implements the optional structural capabilities (MeshProvider /
   * GeometryMetadataProvider) — the dummy adapter implements neither.
   */
  private async cmdPrepareGeometry(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { geometry?: unknown } | null;
    if (p === null || typeof p !== "object" || p.geometry === undefined) {
      return err("bad_payload", "geometry.prepare requires geometry", true);
    }
    // The contract method takes an Element; the descriptor is its props.
    const element: Element = {
      id: "geometry:prepare",
      kind: "geometry",
      engineId: null,
      props: p.geometry as Record<string, unknown>,
    };
    let result: { meshToken: string; bbox: readonly [number, number, number, number, number, number] };
    try {
      result = await this.adapters.geometry.prepareGeometry(element);
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("engine_error", `geometry adapter failed: ${(e as Error).message}`, false);
    }
    // Structural validation of the adapter's result (CAD-005 §5).
    if (
      typeof result !== "object" || result === null ||
      typeof result.meshToken !== "string" || result.meshToken.length === 0 ||
      !Array.isArray(result.bbox) || result.bbox.length !== 6 ||
      !result.bbox.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return err("engine_error", "geometry adapter returned an invalid GeometryResult", false);
    }

    // Optional capabilities (structural — the protected core never imports
    // a concrete adapter; LOCK-018 stays intact).
    let mesh: GeometryPrepareResult["mesh"] = null;
    if (isMeshProvider(this.adapters.geometry)) {
      try {
        mesh = await this.adapters.geometry.describeMesh(result.meshToken);
      } catch {
        mesh = null;
      }
    }
    let metadata: GeometryPrepareResult["metadata"] = null;
    if (isGeometryMetadataProvider(this.adapters.geometry)) {
      try {
        metadata = await this.adapters.geometry.describeGeometryMetadata(result.meshToken);
      } catch {
        metadata = null;
      }
    }

    const value: GeometryPrepareResult = {
      meshToken: result.meshToken,
      bbox: result.bbox,
      mesh,
      metadata,
      engine: {
        engineId: this.adapters.geometry.engineId,
        engineVersion: this.adapters.geometry.engineVersion,
      },
    };
    return ok(value);
  }

  // --- Queries ------------------------------------------------------------

  private async handleQuery(query: Query): Promise<CommandQueryResponse> {
    switch (query.name) {
      case "document.getState":
        return ok(this.doc.snapshot());
      case "document.getVersion":
        return ok(this.doc.snapshot().version as VersionMeta);
      case "document.canUndo":
        return ok(this.doc.canUndo);
      case "document.canRedo":
        return ok(this.doc.canRedo);
      case "document.getSelection":
        return ok([...this.doc.selection]);
      // --- CAD-IMPLEMENT-003 (additive): model revisions + Graph bridge ---
      case "model.getHistory":
        return ok(this.doc.history);
      case "model.getGraphEvents": {
        try {
          return ok(bridgeModelHistory(this.doc.history));
        } catch (e) {
          return err("graph_bridge_failed", `graph bridge failed: ${(e as Error).message}`, false);
        }
      }
      case "model.replay": {
        const p = query.payload as { revision_number?: unknown } | null;
        if (
          p === null || typeof p !== "object" ||
          typeof p.revision_number !== "number" || !Number.isInteger(p.revision_number) || p.revision_number < 0
        ) {
          return err("bad_payload", "model.replay requires a non-negative integer revision_number", true);
        }
        const k = p.revision_number;
        const history = this.doc.history;
        if (k > history.revisions.length) {
          return err(
            "bad_payload",
            `model.replay revision_number ${k} out of range 0..${history.revisions.length}`,
            true,
          );
        }
        try {
          const replayed = verifiedReplay(history, k);
          const targetRevision = k === 0 ? undefined : history.revisions[k - 1];
          const result: ModelReplayResult = {
            revision_number: k,
            revision_id:
              k === 0
                ? `${history.entity_id}#r0(${replayed.content_hash.slice(0, 12)})`
                : (targetRevision as { revision_id: string }).revision_id,
            elements: replayed.elements,
            content_hash: replayed.content_hash,
            verified: replayed.verified,
          };
          if (!result.verified) {
            return err(
              "replay_failed",
              `replay to revision ${k} does not match the recorded content hash (history integrity violation)`,
              false,
            );
          }
          return ok(result);
        } catch (e) {
          return err("replay_failed", `replay failed: ${(e as Error).message}`, false);
        }
      }
      case "impact.cascade":
        return await this.qImpactCascade(query.payload);
      case "drafting.snap":
        return this.qDraftingSnap(query.payload);
      // --- CAD-PARITY-003 (additive): precision queries (the SAME shared
      // modules the host renderers run — parity by construction) ---
      case "precision.snap":
        return this.qPrecisionSnap(query.payload);
      case "precision.pick":
        return this.qPrecisionPick(query.payload);
      case "precision.window":
        return this.qPrecisionWindow(query.payload);
      // --- COMPAT-CAD-002 (additive): BIM queries ---
      case "bim.getBuilding":
        return this.qBimGetBuilding();
      // --- COMPAT-BIM-003 (additive): component/material/coordination ---
      case "bim.getComponents":
        return this.qBimGetComponents();
      case "bim.getSemantics":
        return this.qBimGetSemantics(query.payload);
      case "bim.camera":
        return this.qBimCamera(query.payload);
      // --- COMPAT-CAD-003 (additive): documentation queries ---
      case "docs.listViews":
        return this.qDocsListViews();
      case "docs.getViewGeometry":
        return this.qDocsGetViewGeometry(query.payload);
      case "docs.listSheets":
        return this.qDocsListSheets();
      case "docs.exportSheet":
        return this.qDocsExportSheet(query.payload);
      case "ifc.probe":
        return this.qIfcProbe();
      case "ifc.compare":
        return this.qIfcCompare(query.payload);
      case "ifc.idsValidate":
        return this.qIfcIdsValidate(query.payload);
      case "ifc.bcfParse":
        return this.qIfcBcfParse(query.payload);
      case "ifc.listImports":
        return this.qIfcListImports();
      default: {
        const _exhaustive: never = query.name;
        return err("unknown_query", `unknown query: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * impact.cascade (RESEARCH-CAD-007, additive): run the deterministic
   * downstream chain for one model transition (default: the latest
   * revision) — quantity.recalculate.requested → quantity.changed →
   * estimate.recalculated → rfq.scope.impact.detected + the aggregate
   * commercial impact — caused by the corresponding model.version.created
   * graph event. Quantities are computed THROUGH the bound geometry engine
   * adapter (LOCK-003/018 — the only engine touchpoint); engine ids are
   * provenance only. Non-mutating, deterministic (fixed timestamps,
   * canonical ordering, canonical-hash event ids).
   */
  private async qImpactCascade(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { revision_number?: unknown } | null;
    const history = this.doc.history;
    if (history.revisions.length === 0) {
      return err("bad_payload", "impact.cascade requires at least one recorded revision", true);
    }
    let k = history.revisions.length;
    if (p !== null && typeof p === "object" && p.revision_number !== undefined) {
      if (typeof p.revision_number !== "number" || !Number.isInteger(p.revision_number)) {
        return err("bad_payload", "impact.cascade revision_number must be an integer", true);
      }
      k = p.revision_number;
    }
    if (k < 1 || k > history.revisions.length) {
      return err(
        "bad_payload",
        `impact.cascade revision_number ${k} out of range 1..${history.revisions.length}`,
        true,
      );
    }
    try {
      const cascade = await runImpactCascade({ history, revision: k, bundle: this.adapters });
      return ok(cascade);
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("impact_failed", `impact cascade failed: ${(e as Error).message}`, false);
    }
  }

  // --- COMPAT-CAD-001 (additive): 2D drafting commands -----------------------

  /** drafting.createEntities — validate + apply ONE atomic create batch
   *  (one versioned command, one revision, one undo entry). Entity ids are
   *  minted by the document; the response reports the created ids. */
  private cmdDraftingCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { entities?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.entities)) {
      return err("bad_payload", "drafting.createEntities requires an entities array", true);
    }
    try {
      const before = new Set(this.doc.allElements().map((el) => el.id));
      const outcome = buildDraftingCreate(
        this.doc.allElements(),
        (id) => this.doc.layerById(id) !== undefined,
        p.entities,
      );
      this.doc.execute(outcome.edit);
      const created = this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id);
      return ok({ created, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** drafting.move / drafting.copy — translate / duplicate the selection. */
  private cmdDraftingTransform(payload: unknown, op: "move" | "copy"): CommandQueryResponse {
    const p = payload as { ids?: unknown; dx?: unknown; dy?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
      return err("bad_payload", `drafting.${op} requires an ids string array`, true);
    }
    if (typeof p.dx !== "number" || !Number.isFinite(p.dx) || typeof p.dy !== "number" || !Number.isFinite(p.dy)) {
      return err("bad_payload", `drafting.${op} requires finite dx/dy`, true);
    }
    try {
      const outcome = op === "move"
        ? moveEntities(this.doc.allElements(), p.ids as string[], p.dx, p.dy)
        : copyEntities(this.doc.allElements(), p.ids as string[], p.dx, p.dy);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      const before = new Set(this.doc.allElements().map((el) => el.id));
      this.doc.execute(outcome.edit);
      const created = op === "copy"
        ? this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id)
        : [];
      return ok({ applied: true, summary: outcome.summary, created, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** drafting.delete — remove the selection atomically. */
  private cmdDraftingDelete(payload: unknown): CommandQueryResponse {
    const p = payload as { ids?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
      return err("bad_payload", "drafting.delete requires an ids string array", true);
    }
    try {
      const outcome = deleteEntities(p.ids as string[]);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({ applied: true, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** drafting.trim / drafting.extend — geometry edits on line targets. */
  private cmdDraftingTrimExtend(payload: unknown, op: "trim" | "extend"): CommandQueryResponse {
    const p = payload as { targetId?: unknown; pick?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.targetId !== "string") {
      return err("bad_payload", `drafting.${op} requires a targetId string`, true);
    }
    if (!Array.isArray(p.pick) || p.pick.length !== 2 || !p.pick.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return err("bad_payload", `drafting.${op} requires pick: [x, y] finite numbers`, true);
    }
    try {
      const outcome = op === "trim"
        ? trimEntity(this.doc.allElements(), p.targetId, [p.pick[0] as number, p.pick[1] as number])
        : extendEntity(this.doc.allElements(), p.targetId, [p.pick[0] as number, p.pick[1] as number]);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({ applied: true, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("supported set")) {
        return err("drafting_unsupported", message, false);
      }
      return err("drafting_invalid", message, false);
    }
  }

  /** drafting.setSettings — replace the non-versioned drafting settings. */
  private cmdDraftingSetSettings(payload: unknown): CommandQueryResponse {
    const p = payload as { settings?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.settings !== "object" || p.settings === null) {
      return err("bad_payload", "drafting.setSettings requires a settings object", true);
    }
    try {
      const cur = this.doc.draftingSettings;
      const incoming = p.settings as Record<string, unknown>;
      // One-level deep merge: partial grid/snap/view patches keep the
      // unmentioned sibling fields.
      const merged = {
        ...cur,
        ...incoming,
        grid: { ...cur.grid, ...((incoming.grid as object) ?? {}) },
        snap: { ...cur.snap, ...((incoming.snap as object) ?? {}) },
        view: { ...cur.view, ...((incoming.view as object) ?? {}) },
      };
      const settings = validateDraftingSettings(merged);
      this.doc.setDraftingSettings(settings);
      return ok({ settings: this.doc.draftingSettings, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** drafting.addLayer / updateLayer / removeLayer — semantic layer edits
   *  through the document command model (ids minted by the document). */
  private cmdDraftingLayer(payload: unknown, op: "add" | "update" | "remove"): CommandQueryResponse {
    const p = payload as Record<string, unknown> | null;
    if (p === null || typeof p !== "object") {
      return err("bad_payload", `drafting.${op}Layer requires an object payload`, true);
    }
    try {
      if (op === "add") {
        if (typeof p.name !== "string" || p.name.length === 0) {
          return err("bad_payload", "drafting.addLayer requires a non-empty name", true);
        }
        const layer: LayerRecord = {
          id: this.doc.mintLayerId(),
          name: p.name,
          color: typeof p.color === "string" ? p.color : "#111827",
          visible: typeof p.visible === "boolean" ? p.visible : true,
        };
        this.doc.execute({ type: "addLayer", layer });
        return ok({ layerId: layer.id, snapshot: this.doc.snapshot() });
      }
      if (op === "update") {
        if (typeof p.layerId !== "string" || typeof p.patch !== "object" || p.patch === null) {
          return err("bad_payload", "drafting.updateLayer requires layerId + patch", true);
        }
        this.doc.execute({ type: "updateLayer", layerId: p.layerId, patch: p.patch as Record<string, unknown> });
        return ok({ snapshot: this.doc.snapshot() });
      }
      if (typeof p.layerId !== "string") {
        return err("bad_payload", "drafting.removeLayer requires layerId", true);
      }
      this.doc.execute({ type: "removeLayer", layerId: p.layerId });
      return ok({ snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  /** drafting.snap (query) — deterministic snap resolution against the
   *  current document. Hidden layers are not snappable (visibility is
   *  pickability); defaults come from the document drafting settings. */
  private qDraftingSnap(payload: unknown): CommandQueryResponse {
    const p = payload as {
      point?: unknown;
      tolerance?: unknown;
      kinds?: unknown;
      gridSize?: unknown;
      exclude?: unknown;
    } | null;
    if (
      p === null || typeof p !== "object" ||
      !Array.isArray(p.point) || p.point.length !== 2 || !p.point.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return err("bad_payload", "drafting.snap requires point: [x, y] finite numbers", true);
    }
    const settings = this.doc.draftingSettings;
    const tolerance = typeof p.tolerance === "number" && p.tolerance > 0 ? p.tolerance : settings.snap.tolerance;
    const kinds = Array.isArray(p.kinds)
      ? canonicalSnapKinds(p.kinds)
      : settings.snap.kinds;
    if (kinds.length === 0) return err("bad_payload", "drafting.snap kinds contains no known snap kind", true);
    const gridSize = typeof p.gridSize === "number" && p.gridSize > 0 ? p.gridSize : settings.grid.size;
    const visible = new Set(this.doc.layerTable.filter((l) => l.visible).map((l) => l.id));
    const entities = this.doc.allElements().filter((el) => {
      const layer = (el.props as Record<string, unknown>).layer;
      return typeof layer === "string" && visible.has(layer);
    });
    try {
      const result = resolveSnap({
        point: [p.point[0] as number, p.point[1] as number],
        tolerance,
        kinds,
        gridSize,
        entities,
        exclude: Array.isArray(p.exclude) ? (p.exclude as string[]) : undefined,
      });
      return ok(result);
    } catch (e) {
      return err("drafting_invalid", (e as Error).message, false);
    }
  }

  // --- CAD-PARITY-003 (additive): canonical 2D entity commands ---------------

  /** entity.create — validate + apply ONE atomic create batch of canonical
   *  2D entities (the CAD-2D-001 vocabulary through the shared geometry
   *  kernel; one versioned command, one revision, one undo entry). */
  private cmdEntityCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { entities?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.entities)) {
      return err("bad_payload", "entity.create requires an entities array", true);
    }
    try {
      const before = new Set(this.doc.allElements().map((el) => el.id));
      const outcome = createEntities(
        this.doc.allElements(),
        (id) => this.doc.layerById(id) !== undefined,
        p.entities,
      );
      if (outcome.edit === null) {
        return ok({ applied: false, reason: outcome.summary, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      const created = this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id);
      return ok({ applied: true, created, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      if (e instanceof EntityOpError) return err(e.code, e.message, false);
      return err("entity_invalid", (e as Error).message, false);
    }
  }

  /** entity.modify — apply ONE canonical-geometry modify operation (the
   *  CAD-2D-002 vocabulary: move/copy/rotate/scale/mirror/offset/trim/
   *  extend/stretch/fillet/chamfer/break/join/explode/setGeometry) as a
   *  single atomic revision. */
  private cmdEntityModify(payload: unknown): CommandQueryResponse {
    const p = payload as { op?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.op !== "string") {
      return err("bad_payload", "entity.modify requires an op string", true);
    }
    try {
      const outcome = modifyEntities(this.doc.allElements(), p as never);
      if (outcome.edit === null) {
        return ok({ applied: false, reason: outcome.summary, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({
        applied: true,
        summary: outcome.summary,
        created: outcome.createdCount,
        modified: outcome.modifiedCount,
        removed: outcome.removedCount,
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (e instanceof EntityOpError) return err(e.code, e.message, false);
      return err("entity_invalid", (e as Error).message, false);
    }
  }

  /** The visible canonical entity view shared by the precision queries —
   *  identical filtering to the host renderers (hidden layers are neither
   *  pickable nor snappable) so queries and renderers see one world. */
  private visiblePrecisionEntities() {
    const visible = new Set(this.doc.layerTable.filter((l) => l.visible).map((l) => l.id));
    return toPrecisionEntities(
      this.doc.allElements().filter((el) => {
        const layer = (el.props as Record<string, unknown>).layer;
        return typeof layer === "string" && visible.has(layer);
      }),
    );
  }

  private static readonly OSNAP_MODES: readonly OsnapMode[] = [
    "endpoint",
    "midpoint",
    "center",
    "quadrant",
    "intersection",
    "node",
    "nearest",
    "perpendicular",
    "tangent",
  ];

  /** precision.snap (query) — the SAME resolveSnap the host renderers run
   *  over the SAME visible entity view (parity by construction). */
  private qPrecisionSnap(payload: unknown): CommandQueryResponse {
    const p = payload as {
      cursor?: unknown;
      settings?: unknown;
      lastPoint?: unknown;
    } | null;
    if (
      p === null || typeof p !== "object" ||
      !Array.isArray(p.cursor) || p.cursor.length !== 2 || !p.cursor.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return err("bad_payload", "precision.snap requires cursor: [x, y] finite numbers", true);
    }
    const s = (p.settings ?? {}) as Record<string, unknown>;
    const modes = Array.isArray(s.osnapModes)
      ? (s.osnapModes as unknown[]).filter((m): m is OsnapMode =>
          typeof m === "string" && (AppApiHandler.OSNAP_MODES as readonly string[]).includes(m))
      : [];
    const settings: PrecisionSettings = {
      osnapModes: modes,
      ortho: s.ortho === true,
      polar: s.polar === true,
      polarAnglesDeg: Array.isArray(s.polarAnglesDeg)
        ? (s.polarAnglesDeg as unknown[]).filter((n) => typeof n === "number" && Number.isFinite(n)) as number[]
        : [0, 45, 90, 135, 180, 225, 270, 315],
      gridSnap: s.gridSnap === true,
      gridSize: typeof s.gridSize === "number" && s.gridSize > 0 ? s.gridSize : 10,
      aperture: typeof s.aperture === "number" && s.aperture > 0 ? s.aperture : 10,
      tracking: s.tracking === true,
    };
    const lastPoint = Array.isArray(p.lastPoint) && p.lastPoint.length === 2 && p.lastPoint.every((n) => typeof n === "number" && Number.isFinite(n))
      ? { x: p.lastPoint[0] as number, y: p.lastPoint[1] as number }
      : null;
    try {
      const result = precisionResolveSnap(
        this.visiblePrecisionEntities(),
        { x: p.cursor[0] as number, y: p.cursor[1] as number },
        settings,
        lastPoint,
      );
      return ok(result);
    } catch (e) {
      return err("precision_failed", (e as Error).message, false);
    }
  }

  /** precision.pick (query) — deterministic entity pick under the cursor. */
  private qPrecisionPick(payload: unknown): CommandQueryResponse {
    const p = payload as { cursor?: unknown; aperture?: unknown } | null;
    if (
      p === null || typeof p !== "object" ||
      !Array.isArray(p.cursor) || p.cursor.length !== 2 || !p.cursor.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return err("bad_payload", "precision.pick requires cursor: [x, y] finite numbers", true);
    }
    const aperture = typeof p.aperture === "number" && p.aperture > 0 ? p.aperture : 10;
    const hit = precisionPickAt(
      this.visiblePrecisionEntities(),
      { x: p.cursor[0] as number, y: p.cursor[1] as number },
      aperture,
    );
    return ok(hit === null ? { id: null } : { id: hit.id, type: hit.geom.type, layer: hit.layer });
  }

  /** precision.window (query) — deterministic window/crossing selection. */
  private qPrecisionWindow(payload: unknown): CommandQueryResponse {
    const p = payload as { mode?: unknown; min?: unknown; max?: unknown } | null;
    if (
      p === null || typeof p !== "object" ||
      (p.mode !== "window" && p.mode !== "crossing") ||
      !Array.isArray(p.min) || p.min.length !== 2 || !p.min.every((n) => typeof n === "number" && Number.isFinite(n)) ||
      !Array.isArray(p.max) || p.max.length !== 2 || !p.max.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return err("bad_payload", "precision.window requires mode ('window'|'crossing') and min/max: [x, y] finite numbers", true);
    }
    const ids = precisionSelectWindow(this.visiblePrecisionEntities(), {
      mode: p.mode as "window" | "crossing",
      min: { x: p.min[0] as number, y: p.min[1] as number },
      max: { x: p.max[0] as number, y: p.max[1] as number },
    });
    return ok({ ids });
  }

  // --- COMPAT-CAD-002 (additive): 3D/BIM authoring -----------------------------

  /** bim.createElements — validate + apply ONE atomic create batch (one
   *  versioned command, one revision, one undo entry). Element ids are minted
   *  by the document; the response reports the created ids. */
  private cmdBimCreate(payload: unknown): CommandQueryResponse {
    const p = payload as { entities?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.entities)) {
      return err("bad_payload", "bim.createElements requires an entities array", true);
    }
    try {
      const before = new Set(this.doc.allElements().map((el) => el.id));
      const outcome = buildBimCreate(this.doc.allElements(), p.entities);
      this.doc.execute(outcome.edit);
      const created = this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id);
      return ok({ created, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("bim_invalid", (e as Error).message, false);
    }
  }

  /** bim.move / bim.copy — translate / duplicate + declared hosted cascades. */
  private cmdBimTransform(payload: unknown, op: "move" | "copy"): CommandQueryResponse {
    const p = payload as { ids?: unknown; dx?: unknown; dy?: unknown; dz?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
      return err("bad_payload", `bim.${op} requires an ids string array`, true);
    }
    if (
      typeof p.dx !== "number" || !Number.isFinite(p.dx) ||
      typeof p.dy !== "number" || !Number.isFinite(p.dy) ||
      typeof p.dz !== "number" || !Number.isFinite(p.dz)
    ) {
      return err("bad_payload", `bim.${op} requires finite dx/dy/dz`, true);
    }
    try {
      const outcome = op === "move"
        ? moveBimElements(this.doc.allElements(), p.ids as string[], p.dx, p.dy, p.dz)
        : copyBimElements(this.doc.allElements(), p.ids as string[], p.dx, p.dy, p.dz, () => this.doc.mintElementId());
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      const before = new Set(this.doc.allElements().map((el) => el.id));
      this.doc.execute(outcome.edit);
      const created = op === "copy"
        ? this.doc.allElements().filter((el) => !before.has(el.id)).map((el) => el.id)
        : [];
      return ok({ applied: true, summary: outcome.summary, created, snapshot: this.doc.snapshot() });
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("supported set")) {
        return err("bim_unsupported", message, false);
      }
      return err("bim_invalid", message, false);
    }
  }

  /** bim.delete — remove atomically (declared hosted cascades, itemized). */
  private cmdBimDelete(payload: unknown): CommandQueryResponse {
    const p = payload as { ids?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
      return err("bad_payload", "bim.delete requires an ids string array", true);
    }
    try {
      const outcome = deleteBimElements(this.doc.allElements(), p.ids as string[]);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({ applied: true, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("bim_invalid", (e as Error).message, false);
    }
  }

  /** bim.setProperties — whitelisted semantic property edits (merged +
   *  re-validated through the strict constructors). */
  private cmdBimSetProperties(payload: unknown): CommandQueryResponse {
    const p = payload as { elementId?: unknown; patch?: unknown } | null;
    if (
      p === null || typeof p !== "object" || typeof p.elementId !== "string" ||
      typeof p.patch !== "object" || p.patch === null
    ) {
      return err("bad_payload", "bim.setProperties requires elementId + patch", true);
    }
    try {
      const outcome = setBimProperties(this.doc.allElements(), p.elementId, p.patch as Record<string, unknown>);
      if (outcome.status === "no-op") {
        return ok({ applied: false, reason: outcome.reason, snapshot: this.doc.snapshot() });
      }
      this.doc.execute(outcome.edit);
      return ok({ applied: true, summary: outcome.summary, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("bim_invalid", (e as Error).message, false);
    }
  }

  /** bim.setSettings — replace the non-versioned BIM workspace settings
   *  (camera preset), with a one-level merge like drafting.setSettings. */
  private cmdBimSetSettings(payload: unknown): CommandQueryResponse {
    const p = payload as { settings?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.settings !== "object" || p.settings === null) {
      return err("bad_payload", "bim.setSettings requires a settings object", true);
    }
    try {
      const cur = this.doc.bimSettings;
      const incoming = p.settings as Record<string, unknown>;
      const merged = {
        ...cur,
        ...incoming,
        camera: { ...cur.camera, ...((incoming.camera as object) ?? {}) },
      };
      const settings = validateBimSettings(merged);
      this.doc.setBimSettings(settings);
      return ok({ settings: this.doc.bimSettings, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("bim_invalid", (e as Error).message, false);
    }
  }

  /**
   * bim.buildGeometry — realize BIM element solids through the bound geometry
   * engine adapter (LOCK-003/018 — the only engine touchpoint, exactly like
   * geometry.prepare). For every addressed BIM element the pure core derives
   * the engine-independent descriptor; the adapter realizes it; the results
   * (meshToken + bbox + engine provenance) attach through ONE atomic
   * versioned batch, so engine realization is itself an immutable, replayable
   * revision. Elements without a solid (stories) are skipped with honest
   * reasons — never silently approximated.
   */
  private async cmdBimBuildGeometry(payload: unknown): Promise<CommandQueryResponse> {
    const p = payload as { ids?: unknown } | null;
    if (p !== null && typeof p === "object" && p.ids !== undefined) {
      if (!Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
        return err("bad_payload", "bim.buildGeometry ids must be a string array when present", true);
      }
    }
    const ids = p !== null && typeof p === "object" && Array.isArray(p.ids) ? (p.ids as string[]) : null;
    const elements = this.doc.allElements();
    const entities = elements
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .filter((entity) => ids === null || ids.includes(entity.id));
    if (entities.length === 0) {
      return err("bad_payload", "bim.buildGeometry found no BIM elements to build", true);
    }
    const ctx = bimGeometryContext(entities);
    interface BuildResult {
      readonly elementId: string;
      readonly meshToken: string;
      readonly bbox: readonly [number, number, number, number, number, number];
      readonly engine: { readonly engineId: string; readonly engineVersion: string };
    }
    const results: BuildResult[] = [];
    const skipped: { elementId: string; reason: string }[] = [];
    const edits: DocumentEdit[] = [];
    for (const entity of entities) {
      const { descriptor, reason } = bimSolidDescriptor(entity, ctx);
      if (descriptor === null) {
        skipped.push({ elementId: entity.id, reason });
        continue;
      }
      const element: Element = { id: "bim:build", kind: "bim", engineId: null, props: descriptor as Record<string, unknown> };
      let realized: { meshToken: string; bbox: readonly [number, number, number, number, number, number] };
      try {
        realized = await this.adapters.geometry.prepareGeometry(element);
      } catch (e) {
        if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
        return err("engine_error", `geometry adapter failed: ${(e as Error).message}`, false);
      }
      if (
        typeof realized !== "object" || realized === null ||
        typeof realized.meshToken !== "string" || realized.meshToken.length === 0 ||
        !Array.isArray(realized.bbox) || realized.bbox.length !== 6 ||
        !realized.bbox.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        return err("engine_error", "geometry adapter returned an invalid GeometryResult", false);
      }
      results.push({
        elementId: entity.id,
        meshToken: realized.meshToken,
        bbox: realized.bbox,
        engine: { engineId: this.adapters.geometry.engineId, engineVersion: this.adapters.geometry.engineVersion },
      });
      edits.push({
        type: "updateElement",
        elementId: entity.id,
        patch: {
          meshToken: realized.meshToken,
          meshBBox: [...realized.bbox],
          geometryEngine: { engineId: this.adapters.geometry.engineId, engineVersion: this.adapters.geometry.engineVersion },
        },
      });
    }
    if (edits.length > 0) {
      try {
        this.doc.execute({ type: "applyEdits", edits });
      } catch (e) {
        return err("edit_failed", (e as Error).message, false);
      }
    }
    return ok({ built: results.length, results, skipped, snapshot: this.doc.snapshot() });
  }

  /** bim.getBuilding (query) — the story→elements structure with semantic
   *  summaries, deterministically ordered (stories by level then id;
   *  walls/slabs/spaces/openings/fills by id). */
  private qBimGetBuilding(): CommandQueryResponse {
    const elements = this.doc.allElements();
    const entities = elements
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const ctx = bimGeometryContext(entities);
    const stories = entities
      .filter((x) => x.type === "bim.story")
      .sort((a, b) =>
        a.level !== b.level ? a.level - b.level : a.id < b.id ? -1 : 1,
      );
    const byStory = (type: string) =>
      entities
        .filter((x) => x.type === type && x.type !== "bim.story")
        .filter((x) => (x as { storyId?: unknown }).storyId !== undefined)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
    const building = stories.map((story) => {
      const hosted = (type: string) => byStory(type).filter((x) => (x as { storyId: string }).storyId === story.id);
      const walls = hosted("bim.wall").map((wall) => ({
        ...extractElementSemanticsSafe(elements.find((el) => el.id === wall.id)!)!,
        openings: (ctx.openingsByHost.get(wall.id) ?? []).map((opening) => ({
          ...extractElementSemanticsSafe(elements.find((el) => el.id === opening.id)!)!,
          fills: entities
            .filter((x) => (x.type === "bim.door" || x.type === "bim.window") && x.openingId === opening.id)
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((fill) => extractElementSemanticsSafe(elements.find((el) => el.id === fill.id)!)!),
        })),
      }));
      return {
        story: extractElementSemanticsSafe(elements.find((el) => el.id === story.id)!)!,
        walls,
        slabs: hosted("bim.slab").map((slab) => extractElementSemanticsSafe(elements.find((el) => el.id === slab.id)!)!),
        spaces: hosted("bim.space").map((space) => extractElementSemanticsSafe(elements.find((el) => el.id === space.id)!)!),
      };
    });
    return ok({ stories: building, bimSettings: this.doc.bimSettings });
  }

  /** bim.getComponents (COMPAT-BIM-003, query) — the component/material/
   *  coordination inventory with DERIVED state: every instance reports its
   *  effective parameters (definition defaults ⊕ overrides) and effective
   *  material — the observable result of deterministic parametric
   *  propagation. Deterministic ordering (by id) throughout. */
  private qBimGetComponents(): CommandQueryResponse {
    const elements = this.doc.allElements();
    const entities = elements
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const definitions = new Map<string, ComponentDefEntity>();
    for (const entity of entities) {
      if (entity.type === "bim.componentDef") definitions.set(entity.id, entity);
    }
    const materials = entities
      .filter((x): x is MaterialEntity => x.type === "bim.material")
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((material) => ({
        elementId: material.id,
        name: material.name,
        ...(material.description !== undefined ? { description: material.description } : {}),
        ...(material.color !== undefined ? { color: material.color } : {}),
        properties: material.properties,
      }));
    const definitionRecords = [...definitions.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((def) => ({
        elementId: def.id,
        name: def.name,
        category: def.category,
        parameters: def.parameters,
        ...(def.materialId !== undefined ? { materialId: def.materialId } : {}),
      }));
    const instances: unknown[] = [];
    for (const entity of entities) {
      if (entity.type !== "bim.componentInstance") continue;
      const definition = definitions.get(entity.definitionId);
      if (definition === undefined) {
        return err(
          "bim_invalid",
          `component instance '${entity.id}' references missing definition '${entity.definitionId}' (stored props are inconsistent)`,
          false,
        );
      }
      instances.push({
        elementId: entity.id,
        definitionId: entity.definitionId,
        ...(entity.name !== undefined ? { name: entity.name } : {}),
        storyId: entity.storyId,
        position: entity.position,
        rotation: entity.rotation,
        baseOffset: entity.baseOffset,
        overrides: entity.overrides,
        effectiveParameters: effectiveParameters(definition, entity),
        effectiveBox: effectiveBox(definition, entity),
        effectiveMaterialId: effectiveMaterialId(definition, entity),
        ...(entity.materialId !== undefined ? { materialId: entity.materialId } : {}),
      });
    }
    instances.sort((a, b) => ((a as { elementId: string }).elementId < (b as { elementId: string }).elementId ? -1 : 1));
    const grids = entities
      .filter((x): x is GridEntity => x.type === "bim.grid")
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((grid) => ({
        elementId: grid.id,
        storyId: grid.storyId,
        name: grid.name,
        uLines: grid.uLines,
        vLines: grid.vLines,
      }));
    const referencePlanes = entities
      .filter((x): x is ReferencePlaneEntity => x.type === "bim.referencePlane")
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((plane) => ({
        elementId: plane.id,
        storyId: plane.storyId,
        name: plane.name,
        start: plane.start,
        end: plane.end,
      }));
    return ok({
      materials,
      definitions: definitionRecords,
      instances,
      grids,
      referencePlanes,
      // Declared unsupported set (LOCK-007): alignment constraints and
      // full parametric constraint solving are outside this slice.
      unsupported: {
        alignmentConstraints: "alignment constraints are outside the supported set of this slice",
      },
    });
  }

  /** bim.getSemantics (query) — extracted semantic records (all BIM elements,
   *  or one by elementId). */
  private qBimGetSemantics(payload: unknown): CommandQueryResponse {
    const p = payload as { elementId?: unknown } | null;
    if (p !== null && typeof p === "object" && p.elementId !== undefined) {
      if (typeof p.elementId !== "string") {
        return err("bad_payload", "bim.getSemantics elementId must be a string", true);
      }
      const el = this.doc.elementById(p.elementId);
      if (el === undefined) {
        return err("bad_payload", `bim.getSemantics: no element '${p.elementId}'`, true);
      }
      const record = extractElementSemanticsSafe(el);
      if (record === null) {
        return err("bim_invalid", `element '${p.elementId}' carries no BIM semantics`, false);
      }
      return ok(record);
    }
    const records = this.doc
      .allElements()
      .map((el) => extractElementSemanticsSafe(el))
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (a.elementId < b.elementId ? -1 : 1));
    return ok({ semantics: records });
  }

  /** bim.camera (query) — the standard camera for a preset, derived from the
   *  model's analytic world bbox (pure, engine-free; identical on both hosts). */
  private qBimCamera(payload: unknown): CommandQueryResponse {
    const p = payload as { preset?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.preset !== "string") {
      return err("bad_payload", "bim.camera requires a preset string", true);
    }
    const entities = this.doc
      .allElements()
      .map((el) => elementToBimEntityOrNull(el))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const bbox = bimModelBBox(entities, bimGeometryContext(entities));
    try {
      const camera = standardCamera(p.preset, bbox);
      return ok({ camera, bbox });
    } catch (e) {
      return err("bim_invalid", (e as Error).message, false);
    }
  }

  // --- COMPAT-CAD-003 (additive): documentation commands --------------------
  // Typed-error convention: docs_invalid = validation/consistency failure of
  // documentation content; docs_unsupported = an operation outside this
  // slice's declared vocabulary (e.g. PDF/DWG writers); both explicit, no
  // silent approximation (LOCK-007).

  /** docs.createViews — create view definitions as ONE atomic versioned
   *  batch (one revision, one undo). Ids are minted by the document
   *  (`vw-NNNNNN`) when missing; explicit ids must be unused. */
  private cmdDocsCreateViews(payload: unknown): CommandQueryResponse {
    const p = payload as { views?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.views) || p.views.length === 0) {
      return err("bad_payload", "docs.createViews requires a non-empty views array", true);
    }
    try {
      const edits: DocumentEdit[] = [];
      const ids: string[] = [];
      for (const raw of p.views) {
        if (typeof raw !== "object" || raw === null) {
          throw new Error("each view must be an object");
        }
        const input = raw as Record<string, unknown>;
        const id = typeof input.id === "string" && input.id.length > 0 ? input.id : this.doc.mintViewId();
        const view = validateDocsViewRecord({ ...input, id });
        edits.push({ type: "addView", view });
        ids.push(view.id);
      }
      this.doc.execute({ type: "applyEdits", edits });
      return ok({ created: ids, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.updateView — whitelisted patch on one view definition. */
  private cmdDocsUpdateView(payload: unknown): CommandQueryResponse {
    const p = payload as { viewId?: unknown; patch?: unknown } | null;
    if (
      p === null || typeof p !== "object" || typeof p.viewId !== "string" ||
      typeof p.patch !== "object" || p.patch === null
    ) {
      return err("bad_payload", "docs.updateView requires viewId + patch", true);
    }
    try {
      this.doc.execute({ type: "updateView", viewId: p.viewId, patch: p.patch as Record<string, unknown> });
      return ok({ view: this.doc.viewById(p.viewId), snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.removeView — remove one view (rejected while sheets/annotations/
   *  detail sources still reference it — no silent cascade). */
  private cmdDocsRemoveView(payload: unknown): CommandQueryResponse {
    const p = payload as { viewId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.viewId !== "string") {
      return err("bad_payload", "docs.removeView requires viewId", true);
    }
    try {
      this.doc.execute({ type: "removeView", viewId: p.viewId });
      return ok({ removed: p.viewId, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.createSheets — create sheets/layouts with title blocks as ONE
   *  atomic versioned batch (`sh-NNNNNN` minting; placements validated
   *  inside the drawable region, non-overlapping, referencing views). */
  private cmdDocsCreateSheets(payload: unknown): CommandQueryResponse {
    const p = payload as { sheets?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.sheets) || p.sheets.length === 0) {
      return err("bad_payload", "docs.createSheets requires a non-empty sheets array", true);
    }
    try {
      const edits: DocumentEdit[] = [];
      const ids: string[] = [];
      for (const raw of p.sheets) {
        if (typeof raw !== "object" || raw === null) {
          throw new Error("each sheet must be an object");
        }
        const input = raw as Record<string, unknown>;
        const id = typeof input.id === "string" && input.id.length > 0 ? input.id : this.doc.mintSheetId();
        const sheet = validateDocsSheetRecord({ ...input, id });
        edits.push({ type: "addSheet", sheet });
        ids.push(sheet.id);
      }
      this.doc.execute({ type: "applyEdits", edits });
      return ok({ created: ids, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.updateSheet — whitelisted patch on one sheet. */
  private cmdDocsUpdateSheet(payload: unknown): CommandQueryResponse {
    const p = payload as { sheetId?: unknown; patch?: unknown } | null;
    if (
      p === null || typeof p !== "object" || typeof p.sheetId !== "string" ||
      typeof p.patch !== "object" || p.patch === null
    ) {
      return err("bad_payload", "docs.updateSheet requires sheetId + patch", true);
    }
    try {
      this.doc.execute({ type: "updateSheet", sheetId: p.sheetId, patch: p.patch as Record<string, unknown> });
      return ok({ sheet: this.doc.sheetById(p.sheetId), snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.removeSheet — remove one sheet (top-level object; views and
   *  annotations are NOT cascaded). */
  private cmdDocsRemoveSheet(payload: unknown): CommandQueryResponse {
    const p = payload as { sheetId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.sheetId !== "string") {
      return err("bad_payload", "docs.removeSheet requires sheetId", true);
    }
    try {
      this.doc.execute({ type: "removeSheet", sheetId: p.sheetId });
      return ok({ removed: p.sheetId, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.addAnnotations — create documentation annotations (docs.dim /
   *  docs.tag / docs.note elements, kind "annotation") as ONE atomic batch.
   *  Views must exist; dim/tag references must be existing BIM elements —
   *  annotations stay associated with CANONICAL element identities. */
  private cmdDocsAddAnnotations(payload: unknown): CommandQueryResponse {
    const p = payload as { annotations?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.annotations) || p.annotations.length === 0) {
      return err("bad_payload", "docs.addAnnotations requires a non-empty annotations array", true);
    }
    try {
      const elements = this.doc.allElements();
      const bimIds = new Set(
        elements
          .map((el) => elementToBimEntityOrNull(el))
          .filter((x) => x !== null)
          .map((x) => (x as { id: string }).id),
      );
      const edits: DocumentEdit[] = [];
      const ids: string[] = [];
      for (const raw of p.annotations) {
        if (typeof raw !== "object" || raw === null) throw new Error("each annotation must be an object");
        const input = raw as Record<string, unknown>;
        if (!isDocsAnnotationType(input.type)) {
          throw new Error(`annotation type must be one of docs.dim | docs.tag | docs.note, got ${JSON.stringify(input.type)}`);
        }
        const view = this.doc.viewById(input.viewId as string);
        if (view === undefined) {
          throw new Error(`annotation references unknown view '${String(input.viewId)}'`);
        }
        if (input.type === "docs.dim") {
          for (const ref of input.refIds as string[]) {
            if (!bimIds.has(ref)) {
              throw new Error(`docs.dim refIds must reference existing BIM elements — '${ref}' does not`);
            }
          }
        }
        if (input.type === "docs.tag" && !bimIds.has(input.targetId as string)) {
          throw new Error(`docs.tag targetId must reference an existing BIM element — '${String(input.targetId)}' does not`);
        }
        const props =
          input.type === "docs.dim" ? makeDocsDim(input) :
          input.type === "docs.tag" ? makeDocsTag(input) :
          makeDocsNote(input);
        const id = typeof input.id === "string" && input.id.length > 0 ? input.id : this.doc.mintElementId();
        const element = annotationElement(id, props as unknown as Parameters<typeof annotationElement>[1]);
        edits.push({ type: "addElement", element });
        ids.push(id);
      }
      this.doc.execute({ type: "applyEdits", edits });
      return ok({ created: ids, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.removeAnnotations — remove annotation elements atomically. */
  private cmdDocsRemoveAnnotations(payload: unknown): CommandQueryResponse {
    const p = payload as { ids?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.ids) || !p.ids.every((x) => typeof x === "string")) {
      return err("bad_payload", "docs.removeAnnotations requires an ids string array", true);
    }
    try {
      const elements = this.doc.allElements();
      const known = new Set(elements.filter((el) => {
        const a = el.props.type;
        return el.kind === "annotation" && isDocsAnnotationType(a);
      }).map((el) => el.id));
      for (const id of p.ids as string[]) {
        if (!known.has(id)) {
          throw new Error(`'${id}' is not a documentation annotation element`);
        }
      }
      const edits = (p.ids as string[]).map((id) => ({ type: "removeElement", elementId: id }) as DocumentEdit);
      this.doc.execute({ type: "applyEdits", edits });
      return ok({ removed: p.ids, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  /** docs.regenerate — recompute every view's projection (with canonical
   *  content hashes — the determinism proof) and refresh every annotation's
   *  derived values through ONE atomic versioned batch. No-op regenerations
   *  (nothing changed) record NO revision — identical inputs producing
   *  identical output is the invariant, reported not versioned. */
  private cmdDocsRegenerate(): CommandQueryResponse {
    try {
      const report = regenerateDocumentation(
        this.doc.viewTable,
        this.doc.sheetTable,
        this.doc.allElements(),
        this.doc.history.revisions.length.toString(),
      );
      if (report.updates.length > 0) {
        const edits = report.updates.map((u) => ({ type: "setProps", elementId: u.elementId, patch: u.props }) as DocumentEdit);
        this.doc.execute({ type: "applyEdits", edits });
      }
      return ok({ report, applied: report.updates.length, snapshot: this.doc.snapshot() });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

  // --- COMPAT-IFC-001 (additive): IFC/openBIM interoperability -------------
  // Typed-error convention: ifc_unavailable = no interop adapter bound to
  // this host's engine bundle (hosts opt in); ifc_invalid = payload/file/
  // validation failure; ifc_unsupported = an operation outside the declared
  // vocabulary (e.g. unsupported source units). All explicit (LOCK-007);
  // loss/unsupported FIELD semantics live in the reconciliation reports.

  /** Fixed deterministic import-record timestamp (deterministic records;
   *  the record is already distinguished by its source + report hashes). */
  static readonly IFC_IMPORT_NOW = "2026-01-01T00:00:00.000Z";

  private ifcInterop(): IfcInteropAdapter | null {
    const candidate: unknown = this.adapters.ifc;
    return candidate !== undefined && isIfcInteropProvider(candidate) ? candidate : null;
  }

  /** ifc.export — deterministically export the document's BIM model to IFC
   *  bytes (byte-identical for equal inputs; identity psets carry the
   *  canonical ids; GlobalIds derive from them). */
  private async cmdIfcExport(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { projectName?: unknown } | null;
    const projectName = p !== null && typeof p.projectName === "string" && p.projectName.length > 0 ? p.projectName : "Offisos Export";
    try {
      const snapshot = this.doc.snapshot();
      const entities = snapshot.elements
        .map((el) => elementToBimEntityOrNull(el))
        .filter((e): e is NonNullable<typeof e> => e !== null);
      const rawPropsById = new Map(snapshot.elements.map((el) => [el.id, el.props as Readonly<Record<string, unknown>>] as const));
      const storyLevels = new Map<string, number>();
      for (const entity of entities) {
        if (entity.type === "bim.story") storyLevels.set(entity.id, entity.level);
      }
      const outcome = buildIfcExportRequest(entities, rawPropsById, storyLevels, projectName);
      const built = await adapter.build(outcome.request);
      return ok({
        ifc: built.ifc,
        size: built.size,
        sha256: built.sha256,
        schema: "IFC4",
        engineVersion: built.engineVersion,
        counts: outcome.counts,
      });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("ifc_invalid", (e as Error).message, false);
    }
  }

  /** ifc.import — parse + reconcile an IFC file into the canonical model as
   *  ONE atomic versioned command (created elements + reconciliation
   *  patches + the deterministic import record; one revision, one undo).
   *  GlobalIds are retained as engineId provenance only (LOCK-019). */
  private async cmdIfcImport(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { ifc?: unknown; defaultStoryHeight?: unknown; defaultSpaceHeight?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.ifc !== "string" || p.ifc.length === 0) {
      return err("bad_payload", "ifc.import requires an ifc base64 payload", true);
    }
    const options: { defaultStoryHeight?: number; defaultSpaceHeight?: number; mintId?: () => string } = {};
    if (typeof p.defaultStoryHeight === "number" && Number.isFinite(p.defaultStoryHeight) && p.defaultStoryHeight > 0) {
      options.defaultStoryHeight = p.defaultStoryHeight;
    }
    if (typeof p.defaultSpaceHeight === "number" && Number.isFinite(p.defaultSpaceHeight) && p.defaultSpaceHeight > 0) {
      options.defaultSpaceHeight = p.defaultSpaceHeight;
    }
    options.mintId = (): string => this.doc.mintElementId();
    try {
      const bytes = Buffer.from(p.ifc, "base64");
      const sourceHash = createHash("sha256").update(bytes).digest("hex");
      const parsed = await adapter.parse(p.ifc);
      const snapshot = this.doc.snapshot();
      const outcome = reconcileIfcImport(parsed, sourceHash, snapshot.elements, options);
      const newElements = importEntitiesToElements(outcome.entities, (i) => outcome.globalIds[i] ?? null);
      const edits: DocumentEdit[] = newElements.map((element) => ({ type: "addElement", element }) as DocumentEdit);
      for (const patch of outcome.patches) {
        edits.push({ type: "setProps", elementId: patch.elementId, patch: patch.patch });
      }
      edits.push({
        type: "addIfcImport",
        record: { ...outcome.record, id: "", at: AppApiHandler.IFC_IMPORT_NOW },
      });
      this.doc.execute({ type: "applyEdits", edits });
      const records = this.doc.ifcImportRecords;
      const record = records[records.length - 1];
      return ok({
        record,
        report: outcome.report,
        reportHash: outcome.record.reportHash,
        created: newElements.map((e) => e.id).filter((id) => id.length > 0),
        patched: outcome.patches.map((patch) => patch.elementId),
        snapshot: this.doc.snapshot(),
      });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      const message = (e as Error).message;
      if (message.startsWith("IFC import: unsupported length unit")) {
        return err("ifc_unsupported", message, false);
      }
      return err("ifc_invalid", message, false);
    }
  }

  /** ifc.bcfCreate — build a BCF-XML v3 .bcf container binding topics to
   *  CANONICAL elements (IfcGuids derived deterministically from the
   *  canonical ids). BCF is a transport contract, never the system of
   *  record (Issue #47). */
  private async cmdIfcBcfCreate(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { topics?: unknown } | null;
    if (p === null || typeof p !== "object" || !Array.isArray(p.topics) || p.topics.length === 0) {
      return err("bad_payload", "ifc.bcfCreate requires a non-empty topics array", true);
    }
    try {
      const topics = p.topics.map((raw, index) => {
        if (typeof raw !== "object" || raw === null) {
          throw new Error(`topics[${index}] must be an object`);
        }
        const t = raw as Record<string, unknown>;
        if (typeof t.title !== "string" || t.title.length === 0) {
          throw new Error(`topics[${index}].title must be a non-empty string`);
        }
        if (typeof t.description !== "string") {
          throw new Error(`topics[${index}].description must be a string`);
        }
        const elementIds = Array.isArray(t.elementIds) ? t.elementIds : [];
        const known = new Set(this.doc.allElements().map((el) => el.id));
        for (const id of elementIds) {
          if (typeof id !== "string" || !known.has(id)) {
            throw new Error(`topics[${index}]: element id '${String(id)}' does not exist in the document`);
          }
        }
        return {
          title: t.title,
          description: t.description,
          author: typeof t.author === "string" ? t.author : "offisos",
          type: typeof t.type === "string" ? t.type : "Issue",
          status: typeof t.status === "string" ? t.status : "Open",
          references: (elementIds as string[]).map((id) => ifcGuidFor(id)),
          comment: typeof t.comment === "string" && t.comment.length > 0 ? t.comment : null,
          commentAuthor: typeof t.commentAuthor === "string" ? t.commentAuthor : null,
        };
      });
      const built = await adapter.buildBcf(topics);
      return ok({ bcf: built.bcf, size: built.size, referencedCanonicalIds: topics.flatMap((t) => t.references).length });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("ifc_invalid", (e as Error).message, false);
    }
  }

  /** ifc.probe — engine/toolchain availability. */
  private async qIfcProbe(): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return ok({ available: false, engineVersion: null, message: "no IFC interop adapter is bound to this host's engine bundle" });
    }
    const probe = await adapter.probe();
    return ok(probe);
  }

  /** ifc.compare — dry-run reconciliation of an IFC file against the current
   *  canonical state (field-level exact/tolerance/lossy/unsupported). */
  private async qIfcCompare(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { ifc?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.ifc !== "string" || p.ifc.length === 0) {
      return err("bad_payload", "ifc.compare requires an ifc base64 payload", true);
    }
    try {
      const bytes = Buffer.from(p.ifc, "base64");
      const sourceHash = createHash("sha256").update(bytes).digest("hex");
      const parsed = await adapter.parse(p.ifc);
      const outcome = reconcileIfcImport(parsed, sourceHash, this.doc.snapshot().elements, {});
      return ok({ report: outcome.report, reportHash: outcome.record.reportHash });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      const message = (e as Error).message;
      if (message.startsWith("IFC import: unsupported length unit")) {
        return err("ifc_unsupported", message, false);
      }
      return err("ifc_invalid", message, false);
    }
  }

  /** ifc.idsValidate — IDS validation through the proven IfcTester toolchain,
   *  with every per-entity result bound to canonical provenance (the
   *  identity pset DomainId; null for external entities). */
  private async qIfcIdsValidate(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { ifc?: unknown; ids?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.ids !== "string" || p.ids.trim().length === 0) {
      return err("bad_payload", "ifc.idsValidate requires a non-empty ids XML string", true);
    }
    try {
      let ifcPayload: string = typeof p.ifc === "string" && p.ifc.length > 0 ? p.ifc : "";
      if (ifcPayload.length === 0) {
        // default: validate the current document's export
        const exportResult = await this.cmdIfcExport({ projectName: "Offisos IDS Validation" });
        if (exportResult.ok !== true) {
          return exportResult;
        }
        ifcPayload = (exportResult.value as { ifc: string }).ifc;
      }
      const [result, parsed] = await Promise.all([
        adapter.validateIds(ifcPayload, p.ids as string),
        adapter.parse(ifcPayload),
      ]);
      const canonicalByGuid = new Map<string, string>();
      for (const el of parsed.elements) {
        const identity = el.psets["Pset_OffisosIdentity"] as Record<string, unknown> | undefined;
        const domainId = identity?.DomainId;
        if (typeof domainId === "string" && domainId.length > 0) {
          canonicalByGuid.set(el.globalId, domainId);
        }
      }
      const classByGuid = new Map(parsed.elements.map((el) => [el.globalId, el.ifcClass] as const));
      const nameByGuid = new Map(parsed.elements.map((el) => [el.globalId, el.name] as const));
      const specs = result.specs.map((spec) => ({
        name: spec.name,
        status: spec.status,
        entities: spec.applicable.map((guid) => ({
          globalId: guid,
          canonicalId: canonicalByGuid.get(guid) ?? null,
          ifcClass: classByGuid.get(guid) ?? null,
          name: nameByGuid.get(guid) ?? null,
          passed: spec.passed.includes(guid),
        })),
      }));
      return ok({ specs, schema: parsed.schema });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("ifc_invalid", (e as Error).message, false);
    }
  }

  /** ifc.bcfParse — parse a .bcf container; every IfcGuid reference resolves
   *  back to a canonical element id when one exists in the current document
   *  (derived guid match or engineId provenance). BCF never becomes the
   *  system of record. */
  private async qIfcBcfParse(payload: unknown): Promise<CommandQueryResponse> {
    const adapter = this.ifcInterop();
    if (adapter === null) {
      return err("ifc_unavailable", "no IFC interop adapter is bound to this host's engine bundle (bind one to use ifc.* interop)", false);
    }
    const p = payload as { bcf?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.bcf !== "string" || p.bcf.length === 0) {
      return err("bad_payload", "ifc.bcfParse requires a bcf base64 payload", true);
    }
    try {
      const parsed = await adapter.parseBcf(p.bcf);
      // canonical resolution: derived guids (exports) + engineId provenance (imports)
      const canonicalByGuid = new Map<string, string>();
      for (const el of this.doc.allElements()) {
        canonicalByGuid.set(ifcGuidFor(el.id), el.id);
        if (typeof el.engineId === "string" && el.engineId.length > 0) {
          canonicalByGuid.set(el.engineId, el.id);
        }
      }
      const topics = parsed.topics.map((topic) => ({
        ...topic,
        references: topic.references,
        resolvedCanonicalIds: topic.references.map((guid) => canonicalByGuid.get(guid) ?? null),
      }));
      return ok({ topics });
    } catch (e) {
      if (isAdapterFailure(e)) return err(e.code, e.message, e.retryable);
      return err("ifc_invalid", (e as Error).message, false);
    }
  }

  /** ifc.listImports — the persisted deterministic import records. */
  private qIfcListImports(): CommandQueryResponse {
    return ok({ records: this.doc.ifcImportRecords });
  }

  // --- COMPAT-CAD-003 (additive): documentation queries ----------------------

  /** docs.listViews — every view with its CURRENT content hash, primitive
   *  count and honest error (dangling story etc.). */
  private qDocsListViews(): CommandQueryResponse {
    const views = this.doc.viewTable;
    const projections = projectAllViews(views, this.doc.allElements());
    const result = views.map((view) => {
      const r = projections.get(view.id);
      if (r === undefined || r.projection === null) {
        return { view, contentHash: null, primitiveCount: 0, skipCount: 0, error: r?.error ?? "not projected" };
      }
      return {
        view,
        contentHash: viewContentHash(r.projection),
        primitiveCount: r.projection.primitives.length,
        skipCount: r.projection.skips.length,
        error: null,
      };
    });
    return ok({ views: result });
  }

  /** docs.getViewGeometry — one view's FRESH projection (derived on demand,
   *  never stored) + content hash + resolved annotations. */
  private qDocsGetViewGeometry(payload: unknown): CommandQueryResponse {
    const p = payload as { viewId?: unknown } | null;
    if (p === null || typeof p !== "object" || typeof p.viewId !== "string") {
      return err("bad_payload", "docs.getViewGeometry requires viewId", true);
    }
    const view = this.doc.viewById(p.viewId);
    if (view === undefined) {
      return err("docs_invalid", `no view '${p.viewId}'`, false);
    }
    const projections = projectAllViews(this.doc.viewTable, this.doc.allElements());
    const r = projections.get(view.id);
    if (r === undefined || r.projection === null) {
      return err("docs_invalid", `view '${view.id}' does not project: ${r?.error ?? "unknown"}`, false);
    }
    const annotations = this.doc
      .allElements()
      .filter((el) => el.kind === "annotation" && isDocsAnnotationType(el.props.type) && el.props.viewId === view.id)
      .map((el) => ({ id: el.id, ...el.props }));
    return ok({
      view,
      primitives: r.projection.primitives,
      skips: r.projection.skips,
      bbox: r.projection.bbox,
      contentHash: viewContentHash(r.projection),
      primitiveCount: r.projection.primitives.length,
      annotations,
    });
  }

  /** docs.listSheets — every sheet record. */
  private qDocsListSheets(): CommandQueryResponse {
    return ok({ sheets: this.doc.sheetTable });
  }

  /** docs.exportSheet — the canonical Sheet IR (the PDF/DWG adapter
   *  contract). pdf/dwg are CONTRACTS ONLY in this slice: the writers are
   *  not implemented and the request fails typed docs_unsupported. */
  private qDocsExportSheet(payload: unknown): CommandQueryResponse {
    const p = payload as { sheetId?: unknown; format?: unknown } | null;
    if (
      p === null || typeof p !== "object" || typeof p.sheetId !== "string" ||
      !isDocsExportFormat(p.format)
    ) {
      return err("bad_payload", "docs.exportSheet requires sheetId + format ('sheet-ir' | 'pdf' | 'dwg')", true);
    }
    if (p.format !== "sheet-ir") {
      return err(
        "docs_unsupported",
        `'${p.format}' writer is not implemented in this slice — the export CONTRACT is the canonical Sheet IR ('sheet-ir'); future adapters consume it (explicit, no partial writer)`,
        false,
      );
    }
    const sheet = this.doc.sheetById(p.sheetId);
    if (sheet === undefined) {
      return err("docs_invalid", `no sheet '${p.sheetId}'`, false);
    }
    try {
      const built = buildSheetIR(sheet as DocsSheetRecord, this.doc.viewTable, this.doc.allElements());
      return ok({ format: "sheet-ir", sheetId: sheet.id, ir: built.ir, canonical: built.canonical, hash: built.hash });
    } catch (e) {
      return err("docs_invalid", (e as Error).message, false);
    }
  }

}
