/**
 * INFRA-002 (Issue #144) — the DocumentStore foundation tests: the port
 * contract (the memory backend + the fail-closed adapter), the LOCK-007
 * structural validation, the deterministic CAS/idempotency semantics, and
 * the cross-backend byte-identity fixture (the memory instance of the
 * runner — the real-PostgreSQL instance runs in the CI web job,
 * apps/web/test/infra-002-postgres-store.mjs, against the SAME pinned
 * fixture).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DocumentStoreError,
  FailClosedDocumentStore,
  MemoryDocumentStore,
  bodyRefOf,
  idempotencyScope,
  validateCommitInput,
  validateCreateDocumentInput,
  type DocumentCommitInput,
  type DocumentCreateInput,
  type DocumentRecord,
  type DocumentStore,
  type DocumentVersionRecord,
} from "../src/persist/documentstore.js";
import {
  DOC_A,
  runDocumentStoreFixture,
} from "./infra-002-documentstore-fixture.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PINNED_FIXTURE_PATH = join(
  HERE,
  "fixtures",
  "infra-002-documentstore.json",
);

const root = (entityId: string): DocumentVersionRecord => ({
  entity_id: entityId,
  version_id: `${entityId}#v1(roothash00000)`,
  parent_version_id: null,
  version_number: 1,
  content_hash: "roothash000000000000000000000000000000000000000000000000000000",
  model_revision: 0,
  body_ref: bodyRefOf(`{"fixture":"${entityId}","v":1}`),
  body_bytes: new TextEncoder().encode(`{"fixture":"${entityId}","v":1}`).length,
  created_by: "infra-002-worker",
});

const registry = (entityId: string, r: DocumentVersionRecord): DocumentRecord => ({
  entity_id: entityId,
  tenant: "default",
  format: "offisos-dummy",
  format_version: "1",
  created_by: "infra-002-worker",
  head_version_id: r.version_id,
  head_version_number: r.version_number,
  head_content_hash: r.content_hash,
  head_model_revision: r.model_revision,
});

const createInput = (entityId: string): DocumentCreateInput => ({
  record: registry(entityId, root(entityId)),
  root: root(entityId),
  body: `{"fixture":"${entityId}","v":1}`,
  actor: "infra-002-worker",
});

const nextVersion = (
  entityId: string,
  parent: DocumentVersionRecord,
  n: number,
): { version: DocumentVersionRecord; body: string } => {
  const body = `{"fixture":"${entityId}","v":${n}}`;
  const contentHash = bodyRefOf(`content:${entityId}#v${n}`);
  return {
    version: {
      entity_id: entityId,
      version_id: `${entityId}#v${n}(${contentHash.slice(0, 12)})`,
      parent_version_id: parent.version_id,
      version_number: n,
      content_hash: contentHash,
      model_revision: n,
      body_ref: bodyRefOf(body),
      body_bytes: new TextEncoder().encode(body).length,
      created_by: "infra-002-worker",
    },
    body,
  };
};

function commitInput(
  entityId: string,
  parent: DocumentVersionRecord,
  next: { version: DocumentVersionRecord; body: string },
): DocumentCommitInput {
  return {
    entity_id: entityId,
    base: { version_id: parent.version_id, version_number: parent.version_number },
    version: next.version,
    body: next.body,
    idempotency: null,
    command: { command_name: "line.create", actor: "infra-002-worker" },
  };
}

test("infra-002: the byte-identity fixture — memory view equals the pinned fixture, and a fresh memory instance reproduces it deterministically", async () => {
  const pinned = JSON.parse(readFileSync(PINNED_FIXTURE_PATH, "utf8")) as {
    viewA: string;
    viewB: string;
  };
  const run1 = await runDocumentStoreFixture(new MemoryDocumentStore());
  assert.equal(run1.viewA, pinned.viewA, "memory viewA must be byte-identical to the pinned fixture");
  assert.equal(run1.viewB, pinned.viewB, "memory viewB must be byte-identical to the pinned fixture");
  // Determinism: a SECOND fresh instance driven with the same command
  // sequence produces the exact same view (the pure-function contract).
  const run2 = await runDocumentStoreFixture(new MemoryDocumentStore());
  assert.equal(run2.viewA, run1.viewA);
  assert.equal(run2.viewB, run1.viewB);
});

test("infra-002: registry bootstrap — createDocument round-trips, audit-logs, and declines duplicates typed", async () => {
  const store = new MemoryDocumentStore();
  const created = await store.createDocument(createInput(DOC_A));
  assert.equal(created.head_version_number, 1);
  assert.equal(created.tenant, "default");
  const read = await store.getDocument(DOC_A);
  assert.ok(read !== null);
  assert.equal(read.head_version_id, created.head_version_id);
  const versions = await store.listVersions(DOC_A);
  assert.equal(versions.length, 1);
  const log = await store.listCommandLog(DOC_A);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.command_name, "document.create");
  assert.equal(log[0]!.ok, true);
  assert.equal(log[0]!.base_version_id, "");
  // The typed duplicate decline (+ the honest audit entry).
  await assert.rejects(
    () => store.createDocument(createInput(DOC_A)),
    (e: unknown) => e instanceof DocumentStoreError && e.code === "document_exists",
  );
  const logAfter = await store.listCommandLog(DOC_A);
  assert.equal(logAfter.length, 2);
  assert.equal(logAfter[1]!.ok, false);
  assert.equal(logAfter[1]!.err_code, "document_exists");
  // The body fetch is byte-exact.
  const body = await store.fetchBody(root(DOC_A).body_ref);
  assert.equal(body, `{"fixture":"${DOC_A}","v":1}`);
});

test("infra-002: commit happy path — head advance, version chain, audit entry", async () => {
  const store = new MemoryDocumentStore();
  const r = root(DOC_A);
  await store.createDocument(createInput(DOC_A));
  const v2 = nextVersion(DOC_A, r, 2);
  const outcome = await store.commit(commitInput(DOC_A, r, v2));
  assert.equal(outcome.replayed, false);
  assert.equal(outcome.version.version_id, v2.version.version_id);
  const head = await store.getDocument(DOC_A);
  assert.ok(head !== null);
  assert.equal(head.head_version_id, v2.version.version_id);
  assert.equal(head.head_version_number, 2);
  assert.equal(head.head_content_hash, v2.version.content_hash);
  const chain = await store.listVersions(DOC_A);
  assert.deepEqual(
    chain.map((v) => v.version_number),
    [1, 2],
  );
  assert.equal(chain[1]!.parent_version_id, r.version_id);
  const log = await store.listCommandLog(DOC_A);
  assert.equal(log[log.length - 1]!.command_name, "line.create");
  assert.equal(log[log.length - 1]!.result_version_id, v2.version.version_id);
  assert.equal(log[log.length - 1]!.ok, true);
});

test("infra-002: idempotency — the retry replays the persisted binding without moving the head; the divergence declines typed", async () => {
  const store = new MemoryDocumentStore();
  const r = root(DOC_A);
  await store.createDocument(createInput(DOC_A));
  const v2 = nextVersion(DOC_A, r, 2);
  const withIdem: DocumentCommitInput = {
    ...commitInput(DOC_A, r, v2),
    idempotency: {
      scope: idempotencyScope(DOC_A),
      idem_key: "k-1",
      request_hash: bodyRefOf("req-1"),
      response_binding: `{"ok":true,"versionId":"${v2.version.version_id}"}`,
    },
  };
  const first = await store.commit(withIdem);
  assert.equal(first.replayed, false);
  // The retry (the SAME key + request, on the SAME base): replay.
  const retry = await store.commit(withIdem);
  assert.equal(retry.replayed, true);
  assert.equal(retry.version.version_id, v2.version.version_id);
  const versions = await store.listVersions(DOC_A);
  assert.equal(versions.length, 2); // no duplicate application
  const idem = await store.getIdempotency(idempotencyScope(DOC_A), "k-1");
  assert.ok(idem !== null);
  assert.equal(idem.applied_version, v2.version.version_id);
  // The same key, a DIFFERENT request: the typed divergence (never the
  // wrong response).
  const divergence: DocumentCommitInput = {
    ...withIdem,
    idempotency: {
      scope: idempotencyScope(DOC_A),
      idem_key: "k-1",
      request_hash: bodyRefOf("DIFFERENT"),
      response_binding: `{"ok":true}`,
    },
  };
  await assert.rejects(
    () => store.commit(divergence),
    (e: unknown) => e instanceof DocumentStoreError && e.code === "idempotency_key_conflict",
  );
  // The idempotent retry is audited as a success on the applied version.
  const log = await store.listCommandLog(DOC_A);
  const last = log[log.length - 1]!;
  assert.equal(last.ok, false);
  assert.equal(last.err_code, "idempotency_key_conflict");
  const replayEntries = log.filter(
    (e) => e.ok === true && e.idem_key === "k-1" && e.result_version_id === v2.version.version_id,
  );
  assert.equal(replayEntries.length, 2); // the fresh application + the replay
});

test("infra-002: CAS — a stale base declines typed with the current head + the intervening versions; no silent merge", async () => {
  const store = new MemoryDocumentStore();
  const r = root(DOC_A);
  await store.createDocument(createInput(DOC_A));
  const v2 = nextVersion(DOC_A, r, 2);
  await store.commit(commitInput(DOC_A, r, v2));
  const v3 = nextVersion(DOC_A, v2.version, 3);
  await store.commit(commitInput(DOC_A, v2.version, v3));
  // The stale commit on base v2 (the head is v3).
  const staleCandidate = nextVersion(DOC_A, v2.version, 3);
  await assert.rejects(
    () => store.commit(commitInput(DOC_A, v2.version, staleCandidate)),
    (e: unknown) => {
      assert.ok(e instanceof DocumentStoreError);
      assert.equal(e.code, "document_conflict");
      assert.ok(e.data !== undefined);
      assert.equal(e.data.current.head_version_id, v3.version.version_id);
      assert.equal(e.data.current.head_version_number, 3);
      assert.equal(e.data.intervening.length, 1);
      assert.equal(e.data.intervening[0]!.version_id, v3.version.version_id);
      return true;
    },
  );
  // The head is unchanged by the declined write.
  const head = await store.getDocument(DOC_A);
  assert.ok(head !== null);
  assert.equal(head.head_version_id, v3.version.version_id);
  const chain = await store.listVersions(DOC_A);
  assert.equal(chain.length, 3);
  // The decline is audited honestly.
  const log = await store.listCommandLog(DOC_A);
  const declined = log.filter((e) => e.ok === false && e.err_code === "document_conflict");
  assert.equal(declined.length, 1);
});

test("infra-002: commit against a missing document declines typed and is audited", async () => {
  const store = new MemoryDocumentStore();
  const r = root("ghost-document");
  const v2 = nextVersion("ghost-document", r, 2);
  await assert.rejects(
    () => store.commit(commitInput("ghost-document", r, v2)),
    (e: unknown) => e instanceof DocumentStoreError && e.code === "document_not_found",
  );
  const log = await store.listCommandLog("ghost-document");
  assert.equal(log.length, 1);
  assert.equal(log[0]!.ok, false);
  assert.equal(log[0]!.err_code, "document_not_found");
});

test("infra-002: LOCK-007 structural validation — malformed inputs decline typed before the authority layer (no state change, not audited)", async () => {
  const store = new MemoryDocumentStore();
  const r = root(DOC_A);
  const good = createInput(DOC_A);
  // create: the record head must match the root.
  assert.throws(
    () =>
      validateCreateDocumentInput({
        ...good,
        record: { ...good.record, head_version_id: "mismatch" },
      }),
    (e: unknown) => e instanceof DocumentStoreError && e.code === "document_bad_input",
  );
  // create: the root's body identity must be exact.
  assert.throws(
    () =>
      validateCreateDocumentInput({
        ...good,
        root: { ...r, body_ref: bodyRefOf("other") },
      }),
    (e: unknown) => e instanceof DocumentStoreError && e.code === "document_bad_input",
  );
  // commit: the version must sit exactly on the base.
  await store.createDocument(good);
  const v2 = nextVersion(DOC_A, r, 2);
  const input = commitInput(DOC_A, r, v2);
  assert.throws(
    () =>
      validateCommitInput({
        ...input,
        version: { ...v2.version, version_number: 5 },
      }),
    (e: unknown) => e instanceof DocumentStoreError && e.code === "document_bad_input",
  );
  assert.throws(
    () =>
      validateCommitInput({
        ...input,
        version: { ...v2.version, parent_version_id: "not-the-base" },
      }),
    (e: unknown) => e instanceof DocumentStoreError && e.code === "document_bad_input",
  );
  assert.throws(
    () =>
      validateCommitInput({
        ...input,
        body: `{"fixture":"${DOC_A}","v":999}`,
      }),
    (e: unknown) => e instanceof DocumentStoreError && e.code === "document_bad_input",
  );
  // No state changed: no log entries, no versions beyond the root.
  const log = await store.listCommandLog(DOC_A);
  assert.equal(log.length, 1); // only document.create
  const versions = await store.listVersions(DOC_A);
  assert.equal(versions.length, 1);
});

test("infra-002: the derivations — idempotencyScope and bodyRefOf", () => {
  assert.equal(idempotencyScope("doc-1"), "command:doc-1");
  assert.equal(bodyRefOf("abc"), bodyRefOf("abc"));
  assert.notEqual(bodyRefOf("abc"), bodyRefOf("abd"));
  assert.equal(bodyRefOf("abc").length, 64);
});

test("infra-002: FailClosedDocumentStore — every operation declines typed document_store_unconfigured; close resolves", async () => {
  const store: DocumentStore = new FailClosedDocumentStore();
  const r = root(DOC_A);
  const expectUnconfigured = (e: unknown): boolean => {
    assert.ok(e instanceof DocumentStoreError, "the fail-closed decline must be typed");
    assert.equal(e.code, "document_store_unconfigured");
    return true;
  };
  await assert.rejects(() => store.createDocument(createInput(DOC_A)), expectUnconfigured);
  await assert.rejects(() => store.getDocument(DOC_A), expectUnconfigured);
  const v2 = nextVersion(DOC_A, r, 2);
  await assert.rejects(
    () => store.commit(commitInput(DOC_A, r, v2)),
    expectUnconfigured,
  );
  await assert.rejects(() => store.getVersion(DOC_A, r.version_id), expectUnconfigured);
  await assert.rejects(() => store.listVersions(DOC_A), expectUnconfigured);
  await assert.rejects(() => store.getIdempotency("command:x", "k"), expectUnconfigured);
  await assert.rejects(() => store.listCommandLog(DOC_A), expectUnconfigured);
  await assert.rejects(() => store.fetchBody(r.body_ref), expectUnconfigured);
  await assert.rejects(() => store.persistedView(DOC_A), expectUnconfigured);
  await store.close(); // never fails
});

test("infra-002: the command log seq is the audit counter, not the domain clock — it increments across documents", async () => {
  const store = new MemoryDocumentStore();
  await store.createDocument(createInput("audit-1"));
  await store.createDocument(createInput("audit-2"));
  const log1 = await store.listCommandLog("audit-1");
  const log2 = await store.listCommandLog("audit-2");
  assert.equal(log1[0]!.seq, 1);
  assert.equal(log2[0]!.seq, 2);
});
