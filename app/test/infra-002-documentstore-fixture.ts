/**
 * INFRA-002 (Issue #144) — the backend-neutral cross-backend byte-identity
 * fixture runner: ONE deterministic command sequence driven against ANY
 * DocumentStore implementation (memory in the deterministic app tests,
 * the real PostgreSQL service in the CI web job) — every backend must
 * produce the SAME canonical persisted view (byte-identical) and the SAME
 * typed decline surfaces.
 *
 * The sequence exercises the full INFRA-002 acceptance surface:
 *  - the registry bootstrap (createDocument + the audit entry);
 *  - the happy-path commits with and without idempotency;
 *  - the idempotent REPLAY (the same key + request replays the persisted
 *    binding even though the head has moved on — the dedup precedes CAS);
 *  - the typed idempotency divergence (same key, different request);
 *  - the typed CAS conflict (stale base → current head + the intervening
 *    versions in the conflict data);
 *  - the typed duplicate-create decline;
 *  - the read surface (getVersion / listVersions / fetchBody / getIdempotency);
 *  - the canonical persisted view (the byte-identity artifact, compared
 *    against the pinned fixture app/test/fixtures/infra-002-documentstore.json).
 *
 * The fixture bodies use the CADDocument canonical JSON encoder over
 * deterministic snapshots — the store is body-agnostic (it stores and
 * returns the exact canonical text), so the fixture stays realistic
 * without pulling the full document machinery.
 */

import { canonicalStringify } from "../src/caddocument/serialization.js";
import {
  DocumentStoreError,
  bodyRefOf,
  idempotencyScope,
  type DocumentConflictData,
  type DocumentCommitInput,
  type DocumentCreateInput,
  type DocumentRecord,
  type DocumentStore,
  type DocumentVersionRecord,
} from "../src/persist/documentstore.js";

/** The fixture documents. */
export const DOC_A = "infra-002-fixture-a";
export const DOC_B = "infra-002-fixture-b";

const FORMAT = "offisos-dummy";
const FORMAT_VERSION = "1";
const CREATED_BY = "infra-002-worker";
const ACTOR = "infra-002-worker";

/** A deterministic canonical snapshot body (content-addressed by the
 * store; the exact text round-trips byte-identically). */
function bodyOf(revision: number): string {
  return canonicalStringify({
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    fixture: "infra-002",
    revision,
    elements: Array.from({ length: revision }, (_, i) => ({
      id: `el-${String(i + 1).padStart(6, "0")}`,
      kind: "fixture-wall",
      start: [i * 1000, 0],
      end: [i * 1000 + 3000, 0],
    })),
  });
}

/** A deterministic content hash for a fixture version (the domain derives
 * its own hashes; the store only stores and compares them). */
function hashOf(entityId: string, versionNumber: number): string {
  return bodyRefOf(`content:${entityId}#v${versionNumber}`);
}

/** A deterministic version identity (the makeVersionId shape). */
function versionIdOf(entityId: string, versionNumber: number, contentHash: string): string {
  return `${entityId}#v${versionNumber}(${contentHash.slice(0, 12)})`;
}

function versionRecord(
  entityId: string,
  versionNumber: number,
  parentVersionId: string | null,
  body: string,
  modelRevision: number,
): DocumentVersionRecord {
  const contentHash = hashOf(entityId, versionNumber);
  return {
    entity_id: entityId,
    version_id: versionIdOf(entityId, versionNumber, contentHash),
    parent_version_id: parentVersionId,
    version_number: versionNumber,
    content_hash: contentHash,
    model_revision: modelRevision,
    body_ref: bodyRefOf(body),
    body_bytes: new TextEncoder().encode(body).length,
    created_by: CREATED_BY,
  };
}

function registryRecord(entityId: string, root: DocumentVersionRecord): DocumentRecord {
  return {
    entity_id: entityId,
    tenant: "default",
    format: FORMAT,
    format_version: FORMAT_VERSION,
    created_by: CREATED_BY,
    head_version_id: root.version_id,
    head_version_number: root.version_number,
    head_content_hash: root.content_hash,
    head_model_revision: root.model_revision,
  };
}

/** The deterministic idempotency request hashes (SHA-256 of the canonical
 * request — the caller derives them; the store compares them). */
function requestHashOf(label: string): string {
  return bodyRefOf(`request:${label}`);
}

/** Capture a typed decline: asserts the error code and returns it. */
async function expectDecline(
  op: string,
  expectedCode: string,
  fn: () => Promise<unknown>,
): Promise<DocumentStoreError> {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof DocumentStoreError, `${op}: expected a DocumentStoreError`);
    const err = e as DocumentStoreError;
    assert(
      err.code === expectedCode,
      `${op}: expected code '${expectedCode}', got '${err.code}'`,
    );
    return err;
  }
  throw new Error(`${op}: expected a typed decline ('${expectedCode}'), got success`);
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

export interface FixtureRunResult {
  readonly viewA: string;
  readonly viewB: string;
}

/** Drive the full deterministic fixture sequence against a store and
 *  return the two canonical persisted views (A and B). Every intermediate
 *  assertion is backend-neutral: memory and the real PostgreSQL service
 *  must satisfy them identically. */
export async function runDocumentStoreFixture(store: DocumentStore): Promise<FixtureRunResult> {
  const body1 = bodyOf(1);
  const body2 = bodyOf(2);
  const body3 = bodyOf(3);
  const body4 = bodyOf(4);

  // --- Document A: the registry bootstrap ---------------------------------
  const rootA = versionRecord(DOC_A, 1, null, body1, 1);
  const recordA = registryRecord(DOC_A, rootA);
  const createA: DocumentCreateInput = {
    record: recordA,
    root: rootA,
    body: body1,
    actor: ACTOR,
  };
  const created = await store.createDocument(createA);
  assert(created.head_version_id === rootA.version_id, "create A: head must be the root");

  const readBack = await store.getDocument(DOC_A);
  assert(readBack !== null && readBack.head_version_id === rootA.version_id, "getDocument A");

  // --- A v1 → v2: a commit WITH idempotency -------------------------------
  const v2 = versionRecord(DOC_A, 2, rootA.version_id, body2, 2);
  const commit2: DocumentCommitInput = {
    entity_id: DOC_A,
    base: { version_id: rootA.version_id, version_number: 1 },
    version: v2,
    body: body2,
    idempotency: {
      scope: idempotencyScope(DOC_A),
      idem_key: "k-commit-2",
      request_hash: requestHashOf("commit-2"),
      response_binding: canonicalStringify({ ok: true, versionId: v2.version_id }),
    },
    command: { command_name: "line.create", actor: ACTOR },
  };
  const outcome2 = await store.commit(commit2);
  assert(outcome2.replayed === false, "commit v2 must be fresh");
  assert(outcome2.version.version_id === v2.version_id, "commit v2 identity");

  // --- A v2 → v3: a commit WITHOUT idempotency (actor honestly null —
  //     the app has no authentication; the column reserves the value) -----
  const v3 = versionRecord(DOC_A, 3, v2.version_id, body3, 3);
  const commit3: DocumentCommitInput = {
    entity_id: DOC_A,
    base: { version_id: v2.version_id, version_number: 2 },
    version: v3,
    body: body3,
    idempotency: null,
    command: { command_name: "line.create", actor: null },
  };
  const outcome3 = await store.commit(commit3);
  assert(outcome3.replayed === false, "commit v3 must be fresh");
  assert(outcome3.version.version_id === v3.version_id, "commit v3 identity");

  // --- The idempotent REPLAY: the same key + request on a STALE base -----
  //     The dedup precedes the CAS: the retry replays the persisted binding
  //     even though the head is now v3.
  const replay = await store.commit(commit2);
  assert(replay.replayed === true, "the retried commit v2 must replay");
  assert(replay.version.version_id === v2.version_id, "the replay serves the applied version");
  const headAfterReplay = await store.getDocument(DOC_A);
  assert(
    headAfterReplay !== null && headAfterReplay.head_version_id === v3.version_id,
    "the replay must NOT move the head",
  );

  // --- The typed idempotency divergence: same key, different request ------
  const v4 = versionRecord(DOC_A, 4, v3.version_id, body4, 4);
  const divergent: DocumentCommitInput = {
    entity_id: DOC_A,
    base: { version_id: v3.version_id, version_number: 3 },
    version: v4,
    body: body4,
    idempotency: {
      scope: idempotencyScope(DOC_A),
      idem_key: "k-commit-2",
      request_hash: requestHashOf("DIFFERENT-request"),
      response_binding: canonicalStringify({ ok: true, versionId: v4.version_id }),
    },
    command: { command_name: "layer.create", actor: ACTOR },
  };
  await expectDecline(
    "idempotency divergence",
    "idempotency_key_conflict",
    () => store.commit(divergent),
  );
  const headAfterDivergence = await store.getDocument(DOC_A);
  assert(
    headAfterDivergence !== null && headAfterDivergence.head_version_id === v3.version_id,
    "the divergence decline must NOT move the head",
  );

  // --- The typed CAS conflict: a stale base (v2 while the head is v3) ----
  const v3b = versionRecord(DOC_A, 3, v2.version_id, bodyOf(33), 33);
  const stale: DocumentCommitInput = {
    entity_id: DOC_A,
    base: { version_id: v2.version_id, version_number: 2 },
    version: v3b,
    body: bodyOf(33),
    idempotency: null,
    command: { command_name: "line.create", actor: ACTOR },
  };
  const conflict = await expectDecline(
    "CAS conflict",
    "document_conflict",
    () => store.commit(stale),
  );
  {
    const data = conflict.data;
    assert(data !== undefined, "the conflict must carry data");
    const conflictData = data as DocumentConflictData;
    assert(conflictData.entity_id === DOC_A, "conflict data entity");
    assert(conflictData.current.head_version_id === v3.version_id, "conflict data: the current head");
    assert(
      conflictData.intervening.length === 1 && conflictData.intervening[0] !== undefined
        && conflictData.intervening[0].version_id === v3.version_id,
      "conflict data: the intervening versions (v3 after base v2)",
    );
  }
  const versionsA = await store.listVersions(DOC_A);
  assert(versionsA.length === 3, "A must have exactly 3 versions (v1, v2, v3)");

  // --- The typed duplicate-create decline ---------------------------------
  await expectDecline(
    "duplicate create",
    "document_exists",
    () => store.createDocument(createA),
  );

  // --- The read surface ----------------------------------------------------
  const gotV2 = await store.getVersion(DOC_A, v2.version_id);
  assert(gotV2 !== null && gotV2.body_ref === v2.body_ref, "getVersion v2");
  const fetchedBody = await store.fetchBody(v2.body_ref);
  assert(fetchedBody === body2, "fetchBody must return the EXACT body text");
  const idem = await store.getIdempotency(idempotencyScope(DOC_A), "k-commit-2");
  assert(
    idem !== null && idem.request_hash === requestHashOf("commit-2")
      && idem.applied_version === v2.version_id,
    "getIdempotency serves the persisted binding",
  );

  // --- Document B: the scope/registry isolation proof ---------------------
  const rootB = versionRecord(DOC_B, 1, null, bodyOf(11), 11);
  const recordB = registryRecord(DOC_B, rootB);
  await store.createDocument({ record: recordB, root: rootB, body: bodyOf(11), actor: ACTOR });
  const v2b = versionRecord(DOC_B, 2, rootB.version_id, bodyOf(12), 12);
  await store.commit({
    entity_id: DOC_B,
    base: { version_id: rootB.version_id, version_number: 1 },
    version: v2b,
    body: bodyOf(12),
    idempotency: {
      scope: idempotencyScope(DOC_B),
      idem_key: "k-b-commit-2",
      request_hash: requestHashOf("b-commit-2"),
      response_binding: canonicalStringify({ ok: true, versionId: v2b.version_id }),
    },
    command: { command_name: "wall.create", actor: ACTOR },
  });
  const idemA = await store.getIdempotency(idempotencyScope(DOC_A), "k-b-commit-2");
  assert(idemA === null, "B's idempotency scope must not leak into A's");

  // --- The canonical persisted views (the byte-identity artifacts) ---------
  const viewA = await store.persistedView(DOC_A);
  const viewB = await store.persistedView(DOC_B);
  return { viewA, viewB };
}
