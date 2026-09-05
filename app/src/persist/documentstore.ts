/**
 * INFRA-002 (Issue #144, verified INFRA-001's roadmap) — the authoritative
 * document persistence port: the P016 discipline applied to the CADDocument
 * working representation (Architecture v1.1 FROZEN, additive, engine-free).
 *
 * THE SCOPE (docs/infrastructure/offisos-persistence-model.md §2, promoted
 * from the verified INFRA-001 design):
 *  - the document REGISTRY (one row per document identity — entity_id, head
 *    version binding, the CAS target);
 *  - the append-only VERSION CHAIN (deterministic version identities,
 *    parent linkage, content hashes, model revisions, content-addressed
 *    bodies);
 *  - the IDEMPOTENCY records (insert-on-conflict authority dedup — the
 *    retry sees the persisted binding, never a second application);
 *  - the COMMAND LOG (the audit trail of every mutating command that
 *    reached the authority layer, successes AND typed declines — seq is
 *    audit order, NEVER the domain clock);
 *  - the deterministic PERSISTED REPRESENTATION (the canonical view — a
 *    pure function of the command sequence; the cross-backend byte-identity
 *    contract).
 *
 * THE SEMANTICS (inherited from the P016 precedent, not invented):
 *  - `commit` is the SERIALIZATION POINT and ONE transaction: the
 *    idempotency check (replay / typed divergence), the CAS on the head
 *    (typed, data-carrying conflict — the current head + the intervening
 *    versions; never a silent merge/repair), the content-addressed body put
 *    (the existence proof), the version append, the head advance, the
 *    idempotency insert and the command-log entry — all-or-nothing.
 *  - Optimistic concurrency: exactly one writer wins per base revision;
 *    the loser receives the typed `document_conflict` with the data needed
 *    to rebase or discard explicitly (the collab.commit precedent).
 *  - Content-addressed bodies: the body text's SHA-256 IS the store
 *    address — a repeated put is an idempotent dedup. The bodies are the
 *    canonical serialized document snapshots (LOCK-005); the store is
 *    body-agnostic (it stores and returns the exact text — the adapter's
 *    byte-preservation discipline makes the round-trip exact).
 *  - Determinism is a persistence requirement: every record field the port
 *    exposes is a domain-deterministic value (no wall-clock, no random);
 *    SQL-side `created_at`/`updated_at` columns are pure database
 *    observability and are NEVER read into the port records — the
 *    canonical persisted view is byte-identical across backends by
 *    construction.
 *  - Fail-closed honesty: a host that wires no document store and does not
 *    opt into the memory backend gets typed `document_store_unconfigured`
 *    failures — the authority contract is never silently degraded to
 *    per-handler memory (production wiring arrives with INFRA-007).
 *
 * LOCK-019 is preserved unchanged: the Construction Graph stays the
 * canonical project/asset authority; this port stores the CADDocument
 * working representation with versioning and provenance — never a
 * competing graph. Engine isolation (LOCK-018): this module is pure
 * TypeScript — no engine imports, no environment reads, no wall-clock, no
 * I/O (the adapters own I/O; the `postgres`/Neon adapter lives in the web
 * host, apps/web/src/server/documentstore-postgres.ts, selected through
 * DATABASE_URL at the host wiring point — the LOCK-003 boundary discipline).
 *
 * INFRA-002 non-goals honored here: no R2 (the bodies use the store-local
 * content-addressed table now; the R2 object backend arrives with
 * INFRA-003 behind this same port contract), no request-shape change, no
 * Redis, no worker service, no production wiring — and NO change to the
 * existing v1 request path (this module is not wired into AppApiHandler in
 * this work item; the stateless request migration is INFRA-004/005).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// The typed failure surface (the closed error-code vocabulary).
// ---------------------------------------------------------------------------

/** The closed document-store error-code vocabulary (typed, data-carrying). */
export type DocumentStoreErrorCode =
  | "document_store_unconfigured" // fail-closed: no backend wired (typed honesty)
  | "document_store_failed" // backend/exhaustion failures (bounded retries spent)
  | "document_bad_input" // structural validation (LOCK-007: reject, never guess)
  | "document_not_found" // commit against a registry row that does not exist
  | "document_exists" // createDocument duplicate identity
  | "document_conflict" // CAS mismatch (carries the current head + intervening)
  | "idempotency_key_conflict" // same key, different request (never the wrong response)
  | "document_corrupt"; // a record read from the store fails validation (LOCK-007)

/** The typed document-store failure (data-carrying for the conflict surface). */
export class DocumentStoreError extends Error {
  constructor(
    readonly code: DocumentStoreErrorCode,
    message: string,
    /** The typed conflict payload (document_conflict): the current head + the
     *  intervening versions — the explicit rebase/discard data. */
    readonly data?: DocumentConflictData | undefined,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// The record types (deterministic fields only — no wall-clock, no random).
// ---------------------------------------------------------------------------

/** The closed backend vocabulary (honestly reported, never substituted). */
export type DocumentStoreBackend = "memory" | "postgres";

/** The document registry record (the CAS target — `head_version_id` is the
 *  optimistic-concurrency anchor; `tenant` reserves the LOCK-009 namespace
 *  and defaults to "default" until the auth work item enforces it). */
export interface DocumentRecord {
  readonly entity_id: string;
  readonly tenant: string;
  readonly format: string;
  readonly format_version: string;
  readonly created_by: string;
  readonly head_version_id: string;
  readonly head_version_number: number;
  readonly head_content_hash: string;
  readonly head_model_revision: number;
}

/** The append-only version-chain record (parent linkage is the chain;
 *  `body_ref` is the content-addressed body key — the SHA-256 of the body
 *  text; `model_revision` is the modelHistory head number at this version). */
export interface DocumentVersionRecord {
  readonly entity_id: string;
  readonly version_id: string;
  readonly parent_version_id: string | null;
  readonly version_number: number;
  readonly content_hash: string;
  readonly model_revision: number;
  readonly body_ref: string;
  readonly body_bytes: number;
  readonly created_by: string;
}

/** The idempotency record (the authority-layer dedup binding: the request
 *  hash identifies the exact request; the response binding is the persisted
 *  replay; `applied_version` is the version the command produced). */
export interface IdempotencyRecord {
  readonly scope: string;
  readonly idem_key: string;
  readonly request_hash: string;
  readonly response_binding: string;
  readonly applied_version: string;
}

/** The command-log audit entry (seq is the audit append counter — NEVER the
 *  domain clock; ok=false + err_code records the typed declines honestly). */
export interface CommandLogEntry {
  readonly seq: number;
  readonly entity_id: string;
  readonly command_name: string;
  readonly base_version_id: string;
  readonly result_version_id: string | null;
  readonly idem_scope: string | null;
  readonly idem_key: string | null;
  readonly actor: string | null;
  readonly ok: boolean;
  readonly err_code: string | null;
}

// ---------------------------------------------------------------------------
// The write inputs.
// ---------------------------------------------------------------------------

/** The idempotency write (the caller's request identity + replay binding). */
export interface IdempotencyWrite {
  readonly scope: string;
  readonly idem_key: string;
  readonly request_hash: string;
  readonly response_binding: string;
}

/** The command provenance the authority layer audits (the app layer owns
 *  the command name and actor; the store persists them verbatim). */
export interface CommandLogInput {
  readonly command_name: string;
  readonly actor: string | null;
}

/** The registry bootstrap input: the record with its head = the root
 *  version, the root version (version_number 1, no parent), the canonical
 *  serialized snapshot body, and the actor provenance for the
 *  `document.create` audit entry. */
export interface DocumentCreateInput {
  readonly record: DocumentRecord;
  readonly root: DocumentVersionRecord;
  readonly body: string;
  readonly actor: string | null;
}

/** The expected base the caller commits on top of (the CAS assertion). */
export interface DocumentCommitBase {
  readonly version_id: string;
  readonly version_number: number;
}

/** The commit input: ONE authority transaction — the CAS base, the new
 *  version (parent = base, version_number = base + 1), the canonical body,
 *  the optional idempotency write and the command provenance. */
export interface DocumentCommitInput {
  readonly entity_id: string;
  readonly base: DocumentCommitBase;
  readonly version: DocumentVersionRecord;
  readonly body: string;
  readonly idempotency: IdempotencyWrite | null;
  readonly command: CommandLogInput;
}

/** The commit outcome: the persisted (or replayed) version and the honest
 *  replay marker (true = the idempotency dedup served the persisted
 *  binding — the command did NOT apply a second time). */
export interface DocumentCommitOutcome {
  readonly version: DocumentVersionRecord;
  readonly replayed: boolean;
}

/** The typed CAS-conflict payload: the current head record and the versions
 *  that landed after the caller's base (ascending) — the explicit
 *  rebase/discard data (never a silent merge). */
export interface DocumentConflictData {
  readonly entity_id: string;
  readonly current: DocumentRecord;
  readonly intervening: readonly DocumentVersionRecord[];
}

// ---------------------------------------------------------------------------
// The canonical persisted view (the cross-backend byte-identity contract).
// ---------------------------------------------------------------------------

/** The deterministic persisted-view data (a pure function of the command
 *  sequence — every value domain-deterministic; bodies embed the EXACT
 *  stored text so byte identity is proven at the text level). */
export interface PersistedDocumentViewData {
  readonly entity_id: string;
  readonly document: DocumentRecord | null;
  readonly versions: readonly DocumentVersionRecord[];
  readonly bodies: Readonly<Record<string, string>>;
  readonly idempotency: readonly IdempotencyRecord[];
  readonly command_log: readonly CommandLogEntry[];
}

// ---------------------------------------------------------------------------
// The port.
// ---------------------------------------------------------------------------

/** The authoritative document persistence port (the P016 discipline). */
export interface DocumentStore {
  /** The closed backend identity (observability + the honest evidence). */
  readonly backend: DocumentStoreBackend;

  /** The registry bootstrap: registry row + root version + body + the
   *  `document.create` audit entry (base_version_id "" — the root has no
   *  parent). Typed `document_exists` decline (audited) on a duplicate
   *  identity. */
  createDocument(input: DocumentCreateInput): Promise<DocumentRecord>;

  /** The current registry record (null when the document does not exist) —
   *  read-only, never appends. */
  getDocument(entity_id: string): Promise<DocumentRecord | null>;

  /** The SERIALIZATION POINT — one authority transaction: idempotency
   *  check (replay / typed divergence) → CAS on the head (typed,
   *  data-carrying conflict) → content-addressed body put → version
   *  append → head advance → idempotency insert → command-log entry.
   *  Declines are audited (ok=false, err_code) and thrown typed. */
  commit(input: DocumentCommitInput): Promise<DocumentCommitOutcome>;

  /** One version record (null when absent). */
  getVersion(entity_id: string, version_id: string): Promise<DocumentVersionRecord | null>;

  /** The version chain, ascending by version_number. */
  listVersions(entity_id: string): Promise<readonly DocumentVersionRecord[]>;

  /** The idempotency binding (null when absent) — read-only. */
  getIdempotency(scope: string, idem_key: string): Promise<IdempotencyRecord | null>;

  /** The command-log audit trail for a document (ascending seq). */
  listCommandLog(entity_id: string): Promise<readonly CommandLogEntry[]>;

  /** The exact stored body text (null when absent) — byte-preserving. */
  fetchBody(body_ref: string): Promise<string | null>;

  /** The canonical persisted view as canonical JSON text — the
   *  cross-backend byte-identity contract (deterministic; a pure function
   *  of the command sequence). */
  persistedView(entity_id: string): Promise<string>;

  /** Release backend resources (test teardown / graceful shutdown). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The deterministic derivations (pure helpers).
// ---------------------------------------------------------------------------

/** The canonical idempotency scope for a document (persistence-model §2.2:
 * "command:<documentId>" — the authority-layer dedup namespace). */
export function idempotencyScope(entityId: string): string {
  return `command:${entityId}`;
}

/** The content-addressed body key: the SHA-256 of the canonical body text
 *  (the object-storage discipline — the content hash IS the address). */
export function bodyRefOf(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** The canonical JSON encoding for the persisted view (sorted object keys,
 *  stable formatting — the same algorithm as the CADDocument canonical
 *  serialization; local here so the persistence layer stays self-contained
 *  and lower-layer clean). Throws on `undefined` values (LOCK-007: canonical
 *  JSON must be valid JSON). */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new Error("canonicalJson: undefined is not representable in canonical JSON");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Render the persisted-view data as canonical JSON text (the
 *  byte-identity artifact). */
export function renderPersistedView(view: PersistedDocumentViewData): string {
  return canonicalJson(view);
}

// ---------------------------------------------------------------------------
// The LOCK-007 structural validation (reject malformed, never guess).
// ---------------------------------------------------------------------------

function nonEmpty(value: unknown, field: string, problems: string[]): void {
  if (typeof value !== "string" || value.length === 0) {
    problems.push(`${field} must be a non-empty string`);
  }
}

function positiveInt(value: unknown, field: string, problems: string[]): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    problems.push(`${field} must be a positive integer`);
  }
}

function nonNegativeInt(value: unknown, field: string, problems: string[]): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    problems.push(`${field} must be a non-negative integer`);
  }
}

/** Validate the registry-bootstrap input (LOCK-007): the record and the
 *  root version must be mutually consistent, the body non-empty, and the
 *  derived body identity (ref + byte length) exact. */
export function validateCreateDocumentInput(input: DocumentCreateInput): void {
  const problems: string[] = [];
  const { record, root, body } = input;
  nonEmpty(record.entity_id, "record.entity_id", problems);
  nonEmpty(record.tenant, "record.tenant", problems);
  nonEmpty(record.format, "record.format", problems);
  nonEmpty(record.format_version, "record.format_version", problems);
  nonEmpty(record.created_by, "record.created_by", problems);
  nonEmpty(record.head_version_id, "record.head_version_id", problems);
  positiveInt(record.head_version_number, "record.head_version_number", problems);
  nonEmpty(record.head_content_hash, "record.head_content_hash", problems);
  nonNegativeInt(record.head_model_revision, "record.head_model_revision", problems);
  nonEmpty(root.entity_id, "root.entity_id", problems);
  nonEmpty(root.version_id, "root.version_id", problems);
  if (root.parent_version_id !== null) {
    problems.push("root.parent_version_id must be null (the root has no parent)");
  }
  positiveInt(root.version_number, "root.version_number", problems);
  nonEmpty(root.content_hash, "root.content_hash", problems);
  nonNegativeInt(root.model_revision, "root.model_revision", problems);
  nonEmpty(root.body_ref, "root.body_ref", problems);
  nonNegativeInt(root.body_bytes, "root.body_bytes", problems);
  nonEmpty(root.created_by, "root.created_by", problems);
  if (typeof body !== "string" || body.length === 0) {
    problems.push("body must be a non-empty string");
  }
  // The mutual consistency: the record's head IS the root version.
  if (problems.length === 0) {
    if (record.entity_id !== root.entity_id) {
      problems.push("record.entity_id must equal root.entity_id");
    }
    if (record.head_version_id !== root.version_id) {
      problems.push("record.head_version_id must equal root.version_id");
    }
    if (record.head_version_number !== root.version_number || root.version_number !== 1) {
      problems.push("the root must be version_number 1 and the record head must match");
    }
    if (record.head_content_hash !== root.content_hash) {
      problems.push("record.head_content_hash must equal root.content_hash");
    }
    if (record.head_model_revision !== root.model_revision) {
      problems.push("record.head_model_revision must equal root.model_revision");
    }
    // The derived body identity (the content-addressed key + byte length).
    if (root.body_ref !== bodyRefOf(body)) {
      problems.push("root.body_ref must equal the SHA-256 of the body");
    }
    if (root.body_bytes !== byteLengthOf(body)) {
      problems.push("root.body_bytes must equal the body's UTF-8 byte length");
    }
  }
  if (problems.length > 0) {
    throw new DocumentStoreError(
      "document_bad_input",
      `createDocument input failed validation: ${problems.join("; ")}`,
    );
  }
}

/** Validate the commit input (LOCK-007): the new version must sit exactly
 *  on top of the asserted base (parent linkage + sequence) and the derived
 *  body identity must be exact. */
export function validateCommitInput(input: DocumentCommitInput): void {
  const problems: string[] = [];
  const { entity_id, base, version, body, idempotency, command } = input;
  nonEmpty(entity_id, "entity_id", problems);
  nonEmpty(base.version_id, "base.version_id", problems);
  positiveInt(base.version_number, "base.version_number", problems);
  nonEmpty(version.entity_id, "version.entity_id", problems);
  nonEmpty(version.version_id, "version.version_id", problems);
  if (version.parent_version_id === null) {
    problems.push("version.parent_version_id must reference the base (non-null)");
  }
  positiveInt(version.version_number, "version.version_number", problems);
  nonEmpty(version.content_hash, "version.content_hash", problems);
  nonNegativeInt(version.model_revision, "version.model_revision", problems);
  nonEmpty(version.body_ref, "version.body_ref", problems);
  nonNegativeInt(version.body_bytes, "version.body_bytes", problems);
  nonEmpty(version.created_by, "version.created_by", problems);
  if (typeof body !== "string" || body.length === 0) {
    problems.push("body must be a non-empty string");
  }
  nonEmpty(command.command_name, "command.command_name", problems);
  if (idempotency !== null) {
    nonEmpty(idempotency.scope, "idempotency.scope", problems);
    nonEmpty(idempotency.idem_key, "idempotency.idem_key", problems);
    nonEmpty(idempotency.request_hash, "idempotency.request_hash", problems);
    nonEmpty(idempotency.response_binding, "idempotency.response_binding", problems);
  }
  if (problems.length === 0) {
    if (version.entity_id !== entity_id) {
      problems.push("version.entity_id must equal entity_id");
    }
    if (version.parent_version_id !== base.version_id) {
      problems.push("version.parent_version_id must equal base.version_id");
    }
    if (version.version_number !== base.version_number + 1) {
      problems.push("version.version_number must equal base.version_number + 1");
    }
    if (version.body_ref !== bodyRefOf(body)) {
      problems.push("version.body_ref must equal the SHA-256 of the body");
    }
    if (version.body_bytes !== byteLengthOf(body)) {
      problems.push("version.body_bytes must equal the body's UTF-8 byte length");
    }
  }
  if (problems.length > 0) {
    throw new DocumentStoreError(
      "document_bad_input",
      `commit input failed validation: ${problems.join("; ")}`,
    );
  }
}

/** The UTF-8 byte length (platform-neutral — no Buffer dependency). */
function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// MemoryDocumentStore — the in-process deterministic adapter.
// ---------------------------------------------------------------------------

/**
 * The deterministic in-process memory adapter (local development and the
 * deterministic tests — the MemoryP016Persist discipline). NOT durable
 * across processes (backend identity "memory", honestly reported, never
 * silently substituted). All operations are synchronous under the hood —
 * atomic by construction in single-threaded JavaScript, which makes the
 * CAS/idempotency semantics deterministic for the fixture set.
 */
export class MemoryDocumentStore implements DocumentStore {
  readonly backend = "memory" as const;

  private readonly documents = new Map<string, DocumentRecord>();
  private readonly versions = new Map<string, DocumentVersionRecord[]>();
  private readonly bodies = new Map<string, string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly commandLog: CommandLogEntry[] = [];
  private logSeq = 0;

  async createDocument(input: DocumentCreateInput): Promise<DocumentRecord> {
    validateCreateDocumentInput(input);
    const entity = input.record.entity_id;
    if (this.documents.has(entity)) {
      this.logDecline(entity, "document.create", "", null, input.actor, "document_exists");
      throw new DocumentStoreError(
        "document_exists",
        `document '${entity}' already exists in the registry`,
      );
    }
    this.bodies.set(input.root.body_ref, input.body);
    this.versions.set(entity, [input.root]);
    this.documents.set(entity, input.record);
    this.logSuccess(
      entity,
      "document.create",
      "",
      input.root.version_id,
      null,
      null,
      input.actor,
    );
    return input.record;
  }

  async getDocument(entityId: string): Promise<DocumentRecord | null> {
    return this.documents.get(entityId) ?? null;
  }

  async commit(input: DocumentCommitInput): Promise<DocumentCommitOutcome> {
    validateCommitInput(input);
    const entity = input.entity_id;
    const current = this.documents.get(entity);
    if (current === undefined) {
      this.logDecline(
        entity,
        input.command.command_name,
        input.base.version_id,
        input.idempotency,
        input.command.actor,
        "document_not_found",
      );
      throw new DocumentStoreError(
        "document_not_found",
        `document '${entity}' does not exist in the registry`,
      );
    }
    // The idempotency check precedes the CAS: a retry of an applied command
    // replays the persisted binding regardless of how far the head moved.
    if (input.idempotency !== null) {
      const existing = this.idempotency.get(idemKey(input.idempotency));
      if (existing !== undefined) {
        if (existing.request_hash !== input.idempotency.request_hash) {
          this.logDecline(
            entity,
            input.command.command_name,
            input.base.version_id,
            input.idempotency,
            input.command.actor,
            "idempotency_key_conflict",
          );
          throw new DocumentStoreError(
            "idempotency_key_conflict",
            `idempotency key '${input.idempotency.idem_key}' in scope '${input.idempotency.scope}' is already bound to a different request`,
          );
        }
        const replayed = this.versions
          .get(entity)
          ?.find((v) => v.version_id === existing.applied_version);
        if (replayed === undefined) {
          throw new DocumentStoreError(
            "document_corrupt",
            `idempotency binding '${input.idempotency.idem_key}' references version '${existing.applied_version}' which is not in the chain`,
          );
        }
        this.logSuccess(
          entity,
          input.command.command_name,
          input.base.version_id,
          replayed.version_id,
          input.idempotency.scope,
          input.idempotency.idem_key,
          input.command.actor,
        );
        return { version: replayed, replayed: true };
      }
    }
    // The CAS: exactly one writer wins per base revision.
    if (current.head_version_id !== input.base.version_id) {
      const chain = this.versions.get(entity) ?? [];
      const intervening = chain.filter((v) => v.version_number > input.base.version_number);
      this.logDecline(
        entity,
        input.command.command_name,
        input.base.version_id,
        input.idempotency,
        input.command.actor,
        "document_conflict",
      );
      throw new DocumentStoreError(
        "document_conflict",
        `document '${entity}' head is '${current.head_version_id}' (version ${current.head_version_number}), not the asserted base '${input.base.version_id}' — ${intervening.length} version(s) intervened`,
        { entity_id: entity, current, intervening },
      );
    }
    // The content-addressed body put (insert-if-absent = idempotent dedup).
    if (!this.bodies.has(input.version.body_ref)) {
      this.bodies.set(input.version.body_ref, input.body);
    }
    // The version append + the head advance.
    const chain = this.versions.get(entity) ?? [];
    chain.push(input.version);
    this.versions.set(entity, chain);
    const advanced: DocumentRecord = {
      ...current,
      head_version_id: input.version.version_id,
      head_version_number: input.version.version_number,
      head_content_hash: input.version.content_hash,
      head_model_revision: input.version.model_revision,
    };
    this.documents.set(entity, advanced);
    if (input.idempotency !== null) {
      this.idempotency.set(idemKey(input.idempotency), {
        scope: input.idempotency.scope,
        idem_key: input.idempotency.idem_key,
        request_hash: input.idempotency.request_hash,
        response_binding: input.idempotency.response_binding,
        applied_version: input.version.version_id,
      });
    }
    this.logSuccess(
      entity,
      input.command.command_name,
      input.base.version_id,
      input.version.version_id,
      input.idempotency?.scope ?? null,
      input.idempotency?.idem_key ?? null,
      input.command.actor,
    );
    return { version: input.version, replayed: false };
  }

  async getVersion(entityId: string, versionId: string): Promise<DocumentVersionRecord | null> {
    return this.versions.get(entityId)?.find((v) => v.version_id === versionId) ?? null;
  }

  async listVersions(entityId: string): Promise<readonly DocumentVersionRecord[]> {
    return [...(this.versions.get(entityId) ?? [])];
  }

  async getIdempotency(scope: string, idemKeyStr: string): Promise<IdempotencyRecord | null> {
    return this.idempotency.get(`${scope}\u0000${idemKeyStr}`) ?? null;
  }

  async listCommandLog(entityId: string): Promise<readonly CommandLogEntry[]> {
    return this.commandLog.filter((e) => e.entity_id === entityId);
  }

  async fetchBody(bodyRef: string): Promise<string | null> {
    return this.bodies.get(bodyRef) ?? null;
  }

  async persistedView(entityId: string): Promise<string> {
    const versions = this.versions.get(entityId) ?? [];
    const bodies: Record<string, string> = {};
    for (const v of versions) {
      const body = this.bodies.get(v.body_ref);
      if (body !== undefined) bodies[v.body_ref] = body;
    }
    const scope = idempotencyScope(entityId);
    const idems = [...this.idempotency.values()]
      .filter((r) => r.scope === scope)
      .sort((a, b) => (a.idem_key < b.idem_key ? -1 : a.idem_key > b.idem_key ? 1 : 0));
    const view: PersistedDocumentViewData = {
      entity_id: entityId,
      document: this.documents.get(entityId) ?? null,
      versions,
      bodies,
      idempotency: idems,
      command_log: this.commandLog.filter((e) => e.entity_id === entityId),
    };
    return renderPersistedView(view);
  }

  async close(): Promise<void> {
    // No resources to release (the honest no-op).
  }

  private logSuccess(
    entity: string,
    commandName: string,
    baseVersionId: string,
    resultVersionId: string | null,
    idemScope: string | null,
    idemKeyStr: string | null,
    actor: string | null,
  ): void {
    this.logSeq += 1;
    this.commandLog.push({
      seq: this.logSeq,
      entity_id: entity,
      command_name: commandName,
      base_version_id: baseVersionId,
      result_version_id: resultVersionId,
      idem_scope: idemScope,
      idem_key: idemKeyStr,
      actor,
      ok: true,
      err_code: null,
    });
  }

  private logDecline(
    entity: string,
    commandName: string,
    baseVersionId: string,
    idempotency: IdempotencyWrite | null,
    actor: string | null,
    errCode: string,
  ): void {
    this.logSeq += 1;
    this.commandLog.push({
      seq: this.logSeq,
      entity_id: entity,
      command_name: commandName,
      base_version_id: baseVersionId,
      result_version_id: null,
      idem_scope: idempotency?.scope ?? null,
      idem_key: idempotency?.idem_key ?? null,
      actor,
      ok: false,
      err_code: errCode,
    });
  }
}

function idemKey(write: IdempotencyWrite): string {
  return `${write.scope}\u0000${write.idem_key}`;
}

// ---------------------------------------------------------------------------
// FailClosedDocumentStore — the typed fail-closed adapter.
// ---------------------------------------------------------------------------

/**
 * The fail-closed adapter: a host that wired no document store gets typed
 * failures on every operation — the authority contract is never silently
 * degraded to per-handler memory. Production wiring (DATABASE_URL
 * selection at the host boundary) arrives with the INFRA-004/007 request
 * migration; until then an unwired host fails closed, honestly.
 */
export class FailClosedDocumentStore implements DocumentStore {
  readonly backend = "memory" as const;

  private failure(): DocumentStoreError {
    return new DocumentStoreError(
      "document_store_unconfigured",
      "the document persistence store is not configured for this host " +
        "(the INFRA-002 foundation is not wired into the request path; the DATABASE_URL-backed " +
        "authoritative store is selected at the host wiring point with the INFRA-004/007 " +
        "stateless-request migration — until then this host fails closed rather than silently " +
        "degrading the authority contract to per-handler memory)",
    );
  }

  createDocument(_input: DocumentCreateInput): Promise<DocumentRecord> {
    return Promise.reject(this.failure());
  }

  getDocument(_entityId: string): Promise<DocumentRecord | null> {
    return Promise.reject(this.failure());
  }

  commit(_input: DocumentCommitInput): Promise<DocumentCommitOutcome> {
    return Promise.reject(this.failure());
  }

  getVersion(_entityId: string, _versionId: string): Promise<DocumentVersionRecord | null> {
    return Promise.reject(this.failure());
  }

  listVersions(_entityId: string): Promise<readonly DocumentVersionRecord[]> {
    return Promise.reject(this.failure());
  }

  getIdempotency(_scope: string, _idemKeyStr: string): Promise<IdempotencyRecord | null> {
    return Promise.reject(this.failure());
  }

  listCommandLog(_entityId: string): Promise<readonly CommandLogEntry[]> {
    return Promise.reject(this.failure());
  }

  fetchBody(_bodyRef: string): Promise<string | null> {
    return Promise.reject(this.failure());
  }

  persistedView(_entityId: string): Promise<string> {
    return Promise.reject(this.failure());
  }

  async close(): Promise<void> {
    // No resources (the honest no-op — close never fails).
  }
}
