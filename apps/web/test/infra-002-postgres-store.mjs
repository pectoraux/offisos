/**
 * INFRA-002 (Issue #144) — the REAL-PostgreSQL store proof (the CI web
 * job's postgres service): the Neon/PostgreSQL adapter exercised against
 * a real PostgreSQL backend — the cross-backend byte-identity fixture
 * (memory view == postgres view == the pinned fixture, ON THE REAL
 * SERVICE), the deterministic concurrent-CAS proof (two parallel commits
 * on the same base — exactly one wins, the loser gets the typed
 * data-carrying document_conflict), the cross-instance durability proof
 * (a FRESH adapter instance over the same database sees the same head and
 * replays the same idempotency binding — the serverless instance-rotation
 * boundary at the store layer), and the LOCK-007 stored-corruption proofs
 * (a NULL body_bytes and a missing referenced body blob both decline
 * typed document_corrupt — reject, never guess; the PR #147 CHANGES
 * REQUIRED remediation).
 *
 * Usage: node --import tsx apps/web/test/infra-002-postgres-store.mjs
 *   (requires DATABASE_URL; a local postgres; skips honestly when unset —
 *   the deterministic memory/fail-closed coverage runs in the app suite)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const DATABASE_URL = process.env.DATABASE_URL;
const isPostgresUrl =
  typeof DATABASE_URL === "string"
  && (DATABASE_URL.startsWith("postgres://") || DATABASE_URL.startsWith("postgresql://"));

// The precise backend check: only a postgres:// URL runs this proof (a
// non-postgres DATABASE_URL in the environment — e.g. an unrelated local
// project's SQLite URL — is not this backend and skips honestly).
if (!isPostgresUrl) {
  console.log(
    "INFRA-002 POSTGRES STORE PROOF: SKIP (no postgres:// DATABASE_URL — the real-postgres proof runs in the CI web job's postgres service)",
  );
  process.exit(0);
}

const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
};

/** The typed-corruption expectation: fn must REJECT with
 * DocumentStoreError("document_corrupt") — resolving (a silently degraded
 * success) is itself the assertion failure. Returns the caught error. */
const expectDocumentCorrupt = async (fn, label) => {
  try {
    await fn();
  } catch (e) {
    assert(
      e instanceof DocumentStoreError && e.code === "document_corrupt",
      `${label} must decline typed document_corrupt (got ${e?.code ?? e})`,
    );
    return e;
  }
  throw new Error(`ASSERTION FAILED: ${label} resolved — it must decline typed document_corrupt (LOCK-007: reject, never guess)`);
};

const { runDocumentStoreFixture } = await import(
  join(REPO_ROOT, "app", "test", "infra-002-documentstore-fixture.ts")
);
const { MemoryDocumentStore, DocumentStoreError, bodyRefOf, idempotencyScope } = await import(
  join(REPO_ROOT, "app", "src", "persist", "documentstore.ts")
);
const { PostgresDocumentStore } = await import(
  join(REPO_ROOT, "apps", "web", "src", "server", "documentstore-postgres.ts")
);
const { canonicalStringify } = await import(
  join(REPO_ROOT, "app", "src", "caddocument", "serialization.ts")
);

const DOC_C = "infra-002-concurrent-c";
const byteLength = (s) => new TextEncoder().encode(s).length;

function bodyOf(revision) {
  return canonicalStringify({
    format: "offisos-dummy",
    formatVersion: "1",
    fixture: "infra-002-concurrent",
    revision,
  });
}

function versionRecord(entityId, versionNumber, parentVersionId, body, modelRevision) {
  const contentHash = bodyRefOf(`content:${entityId}#v${versionNumber}`);
  return {
    entity_id: entityId,
    version_id: `${entityId}#v${versionNumber}(${contentHash.slice(0, 12)})`,
    parent_version_id: parentVersionId,
    version_number: versionNumber,
    content_hash: contentHash,
    model_revision: modelRevision,
    body_ref: bodyRefOf(body),
    body_bytes: byteLength(body),
    created_by: "infra-002-worker",
  };
}

function registryRecord(entityId, root) {
  return {
    entity_id: entityId,
    tenant: "default",
    format: "offisos-dummy",
    format_version: "1",
    created_by: "infra-002-worker",
    head_version_id: root.version_id,
    head_version_number: root.version_number,
    head_content_hash: root.content_hash,
    head_model_revision: root.model_revision,
  };
}

async function main() {
  // --- 1. The memory baseline + the pinned fixture ------------------------
  const pinned = JSON.parse(
    readFileSync(join(REPO_ROOT, "app", "test", "fixtures", "infra-002-documentstore.json"), "utf8"),
  );
  const memoryViews = await runDocumentStoreFixture(new MemoryDocumentStore());
  assert(memoryViews.viewA === pinned.viewA, "memory viewA must equal the pinned fixture");
  assert(memoryViews.viewB === pinned.viewB, "memory viewB must equal the pinned fixture");

  // --- 2. The REAL PostgreSQL run ----------------------------------------
  const pg = new PostgresDocumentStore(DATABASE_URL);
  // Any read awaits the idempotent DDL migration (CREATE TABLE IF NOT
  // EXISTS), so the tables exist before the reset below.
  await pg.getDocument("infra-002-bootstrap-probe");

  // The deterministic reset (the script owns the CI test database):
  // RESTART IDENTITY resets the command_log BIGSERIAL so the seq sequence
  // (and therefore the byte-identity fixture) is reproducible run over run.
  // (pg is imported dynamically here — after the honest skip check — so the
  // skip path needs no web-host dependencies installed.)
  const { Pool } = await import("pg");
  const admin = new Pool({
    connectionString: DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10_000,
    ssl: /sslmode=disable/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
  });
  await admin.query(
    "TRUNCATE command_log, idempotency_keys, document_blobs, document_versions, documents RESTART IDENTITY CASCADE",
  );

  const pgViews = await runDocumentStoreFixture(pg);
  assert(
    pgViews.viewA === pinned.viewA,
    "postgres viewA must be byte-identical to the pinned fixture (the real-service byte-identity)",
  );
  assert(
    pgViews.viewB === pinned.viewB,
    "postgres viewB must be byte-identical to the pinned fixture (the real-service byte-identity)",
  );
  console.log(
    "INFRA-002 byte-identity on the REAL postgres service: PASS " +
      `(viewA ${pgViews.viewA.length} bytes, viewB ${pgViews.viewB.length} bytes — memory == postgres == pinned)`,
  );

  // --- 3. The deterministic concurrent-CAS proof --------------------------
  // Two PARALLEL commits on the SAME base: exactly one wins; the loser
  // receives the typed data-carrying document_conflict. The winner is
  // nondeterministic — the OUTCOME shape is not.
  const rootC = versionRecord(DOC_C, 1, null, bodyOf(1), 1);
  await pg.createDocument({
    record: registryRecord(DOC_C, rootC),
    root: rootC,
    body: bodyOf(1),
    actor: "infra-002-worker",
  });
  const v2c = versionRecord(DOC_C, 2, rootC.version_id, bodyOf(2), 2);
  const commit2c = {
    entity_id: DOC_C,
    base: { version_id: rootC.version_id, version_number: 1 },
    version: v2c,
    body: bodyOf(2),
    idempotency: {
      scope: idempotencyScope(DOC_C),
      idem_key: "k-c-win",
      request_hash: bodyRefOf("c-win"),
      response_binding: canonicalStringify({ ok: true, versionId: v2c.version_id }),
    },
    command: { command_name: "wall.create", actor: "infra-002-worker" },
  };
  const outcome2c = await pg.commit(commit2c);
  assert(outcome2c.replayed === false, "C v2 must be fresh");

  const vX = versionRecord(DOC_C, 3, v2c.version_id, bodyOf(31), 31);
  const candidateX = {
    entity_id: DOC_C,
    base: { version_id: v2c.version_id, version_number: 2 },
    version: vX,
    body: bodyOf(31),
    idempotency: null,
    command: { command_name: "wall.create", actor: "infra-002-worker" },
  };
  const vY = versionRecord(DOC_C, 3, v2c.version_id, bodyOf(32), 32);
  const candidateY = {
    entity_id: DOC_C,
    base: { version_id: v2c.version_id, version_number: 2 },
    version: vY,
    body: bodyOf(32),
    idempotency: null,
    command: { command_name: "wall.create", actor: "infra-002-worker" },
  };
  const settled = await Promise.allSettled([pg.commit(candidateX), pg.commit(candidateY)]);
  const fulfilled = settled.filter((s) => s.status === "fulfilled");
  const rejected = settled.filter((s) => s.status === "rejected");
  assert(fulfilled.length === 1, `exactly one concurrent commit wins (got ${fulfilled.length})`);
  assert(rejected.length === 1, `exactly one concurrent commit declines (got ${rejected.length})`);
  const loser = rejected[0].reason;
  assert(
    loser instanceof DocumentStoreError && loser.code === "document_conflict",
    `the loser declines typed document_conflict (got ${loser?.code ?? loser})`,
  );
  const winnerVersion = fulfilled[0].value.version;
  assert(
    loser.data !== undefined && loser.data.current.head_version_id === winnerVersion.version_id,
    "the conflict data carries the winner's head",
  );
  assert(
    loser.data.intervening.length === 1 && loser.data.intervening[0].version_id === winnerVersion.version_id,
    "the conflict data carries the intervening version",
  );
  const chainC = await pg.listVersions(DOC_C);
  assert(chainC.length === 3, "C has exactly 3 versions (the loser never wrote)");
  const logC = await pg.listCommandLog(DOC_C);
  assert(
    logC.length === 4,
    "C's audit trail: create + v2 + the winning commit + the typed conflict decline",
  );
  assert(
    logC.some((e) => e.ok === false && e.err_code === "document_conflict"),
    "the conflict decline is audited",
  );
  console.log(
    "INFRA-002 concurrent CAS on the REAL postgres service: PASS " +
      "(one winner, one typed data-carrying document_conflict, audit trail complete)",
  );

  // --- 4. The cross-instance durability + idempotency replay -------------
  // A FRESH adapter instance over the SAME database (the serverless
  // instance-rotation boundary at the store layer): the new instance sees
  // the same head, replays the same idempotency binding (the dedup
  // precedes the CAS — the head moved to v3, the retry still replays v2)
  // and fetches the exact body bytes.
  const pg2 = new PostgresDocumentStore(DATABASE_URL);
  const headFromFreshInstance = await pg2.getDocument(DOC_C);
  assert(
    headFromFreshInstance !== null && headFromFreshInstance.head_version_id === winnerVersion.version_id,
    "the fresh instance sees the same authoritative head",
  );
  const replayFromFreshInstance = await pg2.commit(commit2c);
  assert(replayFromFreshInstance.replayed === true, "the fresh instance replays the persisted idempotency binding");
  assert(
    replayFromFreshInstance.version.version_id === v2c.version_id,
    "the replay serves the originally applied version",
  );
  const bodyFromFreshInstance = await pg2.fetchBody(v2c.body_ref);
  assert(bodyFromFreshInstance === bodyOf(2), "the fresh instance fetches the EXACT body bytes");
  // The retry never moved the head.
  const headAfterReplay = await pg2.getDocument(DOC_C);
  assert(
    headAfterReplay.head_version_id === winnerVersion.version_id,
    "the cross-instance replay does not move the head",
  );
  console.log(
    "INFRA-002 cross-instance durability + idempotency on the REAL postgres service: PASS " +
      "(fresh adapter instance: same head, same replay binding, exact body bytes)",
  );

  // --- 5. The LOCK-007 stored-corruption proofs (the PR #147 CHANGES
  // REQUIRED remediation): both corruption cases are injected with direct
  // SQL (the public API cannot produce them — by design) and must decline
  // typed document_corrupt — reject, never guess.
  const viewCBeforeCorruption = await pg.persistedView(DOC_C);

  // 5a. The body_bytes invariant: the column is BIGINT NOT NULL (the
  //     database-level guard — a direct NULL insert is rejected by the
  //     schema itself), and the row mapper additionally declines a NULL
  //     as typed document_corrupt — never a silent 0 — when the schema
  //     guard is bypassed (a legacy nullable column or a manual edit).
  let schemaGuard = null;
  try {
    await admin.query(
      `INSERT INTO document_versions
         (entity_id, version_id, parent_version_id, version_number, content_hash,
          model_revision, body_ref, body_bytes, created_by)
       VALUES ($1, $2, NULL, 99, 'corruption-probe', 1, 'corruption-probe', NULL, 'corruption-probe')`,
      [DOC_C, `${DOC_C}#corrupt-null-bytes`],
    );
  } catch (e) {
    schemaGuard = e;
  }
  assert(
    schemaGuard !== null && schemaGuard.code === "23502",
    `the body_bytes NOT NULL schema guard rejects a NULL insert at the database level (got ${schemaGuard?.code ?? schemaGuard})`,
  );
  // The mapper-level guard: bypass the schema guard (the legacy-nullable
  // scenario) and store the NULL directly, then read it back through the
  // adapter's public read paths.
  await admin.query("ALTER TABLE document_versions ALTER COLUMN body_bytes DROP NOT NULL");
  await admin.query(
    "UPDATE document_versions SET body_bytes = NULL WHERE entity_id = $1 AND version_id = $2",
    [DOC_C, rootC.version_id],
  );
  const nullBytesError = await expectDocumentCorrupt(
    () => pg.getVersion(DOC_C, rootC.version_id),
    "getVersion with a stored NULL body_bytes",
  );
  assert(
    String(nullBytesError.message).includes("body_bytes"),
    "the document_corrupt decline names body_bytes",
  );
  await expectDocumentCorrupt(
    () => pg.persistedView(DOC_C),
    "persistedView with a stored NULL body_bytes",
  );
  // Restore the exact stored value and the NOT NULL guard.
  await admin.query(
    "UPDATE document_versions SET body_bytes = $3 WHERE entity_id = $1 AND version_id = $2",
    [DOC_C, rootC.version_id, rootC.body_bytes],
  );
  await admin.query("ALTER TABLE document_versions ALTER COLUMN body_bytes SET NOT NULL");

  // 5b. The missing content-addressed body: fetchBody stays the honest
  //     direct lookup (null — the Architect-confirmed contract), but
  //     persistedView must fail closed: a version whose body_ref has no
  //     blob makes the view incomplete, which is typed document_corrupt —
  //     never a silently omitted body.
  await admin.query("DELETE FROM document_blobs WHERE body_ref = $1", [v2c.body_ref]);
  assert(
    (await pg.fetchBody(v2c.body_ref)) === null,
    "fetchBody returns null for a missing blob (the direct-lookup contract)",
  );
  const missingBlobError = await expectDocumentCorrupt(
    () => pg.persistedView(DOC_C),
    "persistedView with a missing referenced body blob",
  );
  assert(
    String(missingBlobError.message).includes(v2c.body_ref),
    "the document_corrupt decline names the missing body_ref",
  );
  // Restoring the exact body restores the byte-identical view (the
  // corruption proofs are non-destructive to the durable state).
  await admin.query(
    "INSERT INTO document_blobs (body_ref, content) VALUES ($1, $2::json)",
    [v2c.body_ref, bodyOf(2)],
  );
  const viewCAfterRestore = await pg.persistedView(DOC_C);
  assert(
    viewCAfterRestore === viewCBeforeCorruption,
    "the restored view is byte-identical to the pre-corruption view",
  );
  console.log(
    "INFRA-002 LOCK-007 stored-corruption proofs on the REAL postgres service: PASS " +
      "(NULL body_bytes: NOT NULL schema guard + typed document_corrupt mapper guard, never a silent 0; " +
      "missing body blob: typed document_corrupt fail-closed persistedView with fetchBody as the honest null lookup; exact restoration)",
  );

  await pg.close();
  await pg2.close();
  await admin.end();
  console.log("INFRA-002 POSTGRES STORE PROOF: PASS (byte-identity + concurrent CAS + cross-instance durability + LOCK-007 stored-corruption proofs)");
}

main().catch((e) => {
  console.error("INFRA-002 POSTGRES STORE PROOF: FAIL");
  console.error(e);
  process.exit(1);
});
