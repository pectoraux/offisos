/**
 * INFRA-002 (Issue #144, the verified INFRA-001 roadmap) — the Neon
 * PostgreSQL adapter for the DocumentStore port (backend identity:
 * "postgres"; selected at the host wiring point through DATABASE_URL —
 * the LOCK-003 boundary discipline, exactly like PostgresP016Persist).
 *
 * Architecture v1.1 §6 / docs/infrastructure/offisos-persistence-model.md
 * §2: PostgreSQL/Neon is authoritative for the transactional document
 * state. The mapping (the p016-postgres.ts semantics promoted to the
 * document foundation):
 *  - `documents` — the registry (one row per document identity; the head
 *    columns are the CAS target; SELECT ... FOR UPDATE is the per-document
 *    serialization inside the commit transaction).
 *  - `document_versions` — the append-only version chain (the unique
 *    (entity_id, version_number) + the parent linkage).
 *  - `document_blobs` — the content-addressed canonical snapshot bodies
 *    (insert-if-absent = idempotent dedup). THE COLUMN TYPE IS `json`,
 *    NOT `jsonb` — the byte-identity contract (see the p016-postgres.ts
 *    header: jsonb normalizes, json preserves the exact text; a body
 *    fetched from the store must be the EXACT text that was stored, or
 *    the cross-backend byte-identity fixture breaks). These tables are
 *    created by THIS revision with `json` — no in-place column migration
 *    applies (unlike p016, no earlier revision of this schema exists).
 *  - `idempotency_keys` — the authority-layer dedup (insert-on-conflict
 *    semantics: the pre-checked insert inside the serialized transaction;
 *    a retry replays the persisted binding).
 *  - `command_log` — the audit trail (BIGSERIAL seq is audit order, never
 *    the domain clock; ok=false + err_code records the typed declines).
 *
 * THE COMMIT TRANSACTION (persistence-model §2.3 — the serialization
 * point, all-or-nothing):
 *   BEGIN;
 *     1. SELECT ... FROM documents WHERE entity_id = $doc FOR UPDATE —
 *        the CAS base + the per-document serialization.
 *     2. The idempotency check: a persisted binding replays (or diverges
 *        typed) — the dedup PRECEDES the CAS so a retry replays even
 *        after the head moved on.
 *     3. The CAS: a head mismatch rolls the write back and declines with
 *        the typed data-carrying document_conflict (the current head +
 *        the intervening versions) — never a silent merge/repair.
 *     4. INSERT document_blobs (the existence proof at commit).
 *     5. INSERT document_versions (the append).
 *     6. UPDATE documents head_* (the advance).
 *     7. INSERT idempotency_keys (when keyed).
 *     8. INSERT command_log (the audit entry).
 *   COMMIT;
 *
 * Typed declines are DOMAIN OUTCOMES — never retried, never rewritten
 * (the P016 phase-2 rule). Transient backend failures (connection loss,
 * deadlock) get the bounded whole-transaction retry (the input is
 * immutable data — a retry is safe; an ambiguous commit resolves through
 * the idempotency replay or the CAS conflict on the next attempt).
 *
 * Engine isolation (LOCK-018) is untouched — this is host wiring, not
 * core. The port is imported by RELATIVE path (not the
 * @offisos/cad-app-shell alias) so the standalone CI proof script
 * (apps/web/test/infra-002-postgres-store.mjs, run under tsx) resolves
 * it without a bundler-level alias — the tsc/Next builds resolve the
 * same file identically.
 */

import { Pool, type PoolClient } from "pg";
import {
  DocumentStoreError,
  bodyRefOf,
  idempotencyScope,
  renderPersistedView,
  validateCommitInput,
  validateCreateDocumentInput,
  type DocumentCommitInput,
  type DocumentCommitOutcome,
  type DocumentConflictData,
  type DocumentCreateInput,
  type DocumentRecord,
  type DocumentStore,
  type DocumentStoreBackend,
  type DocumentVersionRecord,
  type IdempotencyRecord,
  type CommandLogEntry,
  type PersistedDocumentViewData,
} from "../../../../app/src/persist/documentstore.js";

/** The bounded commit retries under transient backend failures (the P016
 *  append precedent). Typed declines are domain outcomes — never retried. */
const MAX_COMMIT_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// The SQL row shapes (node-pg: BIGINT arrives as string — mapped to number
// with LOCK-007 corrupt checks; the observability timestamps are never
// selected into the port records).
// ---------------------------------------------------------------------------

interface DocumentRow {
  entity_id: string;
  tenant: string;
  format: string;
  format_version: string;
  created_by: string;
  head_version_id: string;
  head_version_number: string | number;
  head_content_hash: string;
  head_model_revision: string | number;
}

interface VersionRow {
  entity_id: string;
  version_id: string;
  parent_version_id: string | null;
  version_number: string | number;
  content_hash: string;
  model_revision: string | number;
  body_ref: string;
  body_bytes: string | number | null;
  created_by: string;
}

interface IdempotencyRow {
  scope: string;
  idem_key: string;
  request_hash: string;
  response_binding: string;
  applied_version: string;
}

interface CommandLogRow {
  seq: string | number;
  entity_id: string;
  command_name: string;
  base_version_id: string;
  result_version_id: string | null;
  idem_scope: string | null;
  idem_key: string | null;
  actor: string | null;
  ok: boolean;
  err_code: string | null;
}

function asInt(value: string | number, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new DocumentStoreError("document_corrupt", `the stored ${field} is not an integer`);
  }
  return n;
}

function mapDocumentRow(row: DocumentRow): DocumentRecord {
  return {
    entity_id: row.entity_id,
    tenant: row.tenant,
    format: row.format,
    format_version: row.format_version,
    created_by: row.created_by,
    head_version_id: row.head_version_id,
    head_version_number: asInt(row.head_version_number, "head_version_number"),
    head_content_hash: row.head_content_hash,
    head_model_revision: asInt(row.head_model_revision, "head_model_revision"),
  };
}

function mapVersionRow(row: VersionRow): DocumentVersionRecord {
  return {
    entity_id: row.entity_id,
    version_id: row.version_id,
    parent_version_id: row.parent_version_id,
    version_number: asInt(row.version_number, "version_number"),
    content_hash: row.content_hash,
    model_revision: asInt(row.model_revision, "model_revision"),
    body_ref: row.body_ref,
    body_bytes: row.body_bytes === null ? 0 : asInt(row.body_bytes, "body_bytes"),
    created_by: row.created_by,
  };
}

function mapIdempotencyRow(row: IdempotencyRow): IdempotencyRecord {
  return {
    scope: row.scope,
    idem_key: row.idem_key,
    request_hash: row.request_hash,
    response_binding: row.response_binding,
    applied_version: row.applied_version,
  };
}

function mapCommandLogRow(row: CommandLogRow): CommandLogEntry {
  return {
    seq: asInt(row.seq, "command_log.seq"),
    entity_id: row.entity_id,
    command_name: row.command_name,
    base_version_id: row.base_version_id,
    result_version_id: row.result_version_id,
    idem_scope: row.idem_scope,
    idem_key: row.idem_key,
    actor: row.actor,
    ok: row.ok,
    err_code: row.err_code,
  };
}

// ---------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------

export class PostgresDocumentStore implements DocumentStore {
  readonly backend: DocumentStoreBackend = "postgres";

  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(databaseUrl: string) {
    // Serverless-honest pool sizing (the p016-postgres precedent): each
    // function instance keeps a small warm pool; Neon's pooled endpoint
    // handles instance churn; scale-to-zero is acceptable (the first
    // request pays the wake).
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: /sslmode=disable/.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
    });
    this.ready = this.migrate();
  }

  /** The idempotent DDL (CREATE TABLE IF NOT EXISTS — the persistence-model
   *  §2.2 schema; no earlier revision of these tables exists, so no in-place
   *  column migration applies). */
  private async migrate(): Promise<void> {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS documents (
          entity_id          TEXT PRIMARY KEY,
          tenant             TEXT NOT NULL DEFAULT 'default',
          format             TEXT NOT NULL,
          format_version     TEXT NOT NULL,
          created_by         TEXT NOT NULL,
          head_version_id    TEXT NOT NULL,
          head_version_number BIGINT NOT NULL,
          head_content_hash  TEXT NOT NULL,
          head_model_revision BIGINT NOT NULL,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS document_versions (
          entity_id        TEXT NOT NULL REFERENCES documents(entity_id),
          version_id       TEXT NOT NULL,
          parent_version_id TEXT,
          version_number   BIGINT NOT NULL,
          content_hash     TEXT NOT NULL,
          model_revision   BIGINT NOT NULL,
          body_ref         TEXT NOT NULL,
          body_bytes       BIGINT,
          created_by       TEXT NOT NULL,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (entity_id, version_id),
          UNIQUE (entity_id, version_number)
        );
        CREATE INDEX IF NOT EXISTS document_versions_head
          ON document_versions (entity_id, version_number DESC);
        CREATE TABLE IF NOT EXISTS document_blobs (
          body_ref   TEXT PRIMARY KEY,
          content    JSON NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          scope            TEXT NOT NULL,
          idem_key         TEXT NOT NULL,
          request_hash     TEXT NOT NULL,
          response_binding TEXT NOT NULL,
          applied_version  TEXT NOT NULL,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (scope, idem_key)
        );
        CREATE TABLE IF NOT EXISTS command_log (
          seq               BIGSERIAL PRIMARY KEY,
          entity_id         TEXT NOT NULL,
          command_name      TEXT NOT NULL,
          base_version_id   TEXT NOT NULL,
          result_version_id TEXT,
          idem_scope        TEXT,
          idem_key          TEXT,
          actor             TEXT,
          ok                BOOLEAN NOT NULL,
          err_code          TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS command_log_doc
          ON command_log (entity_id, seq);
      `);
    } catch (e) {
      throw new DocumentStoreError(
        "document_store_failed",
        `document store migration failed: ${(e as Error).message}`,
      );
    }
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async createDocument(input: DocumentCreateInput): Promise<DocumentRecord> {
    validateCreateDocumentInput(input);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
      try {
        await this.ready;
        return await this.withClient(async (client) => {
          let txOpen = false;
          try {
            await client.query("BEGIN");
            txOpen = true;
            await client.query(
              `INSERT INTO documents
                 (entity_id, tenant, format, format_version, created_by,
                  head_version_id, head_version_number, head_content_hash, head_model_revision)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                input.record.entity_id,
                input.record.tenant,
                input.record.format,
                input.record.format_version,
                input.record.created_by,
                input.record.head_version_id,
                input.record.head_version_number,
                input.record.head_content_hash,
                input.record.head_model_revision,
              ],
            );
            await client.query(
              `INSERT INTO document_blobs (body_ref, content)
               VALUES ($1, $2::json) ON CONFLICT (body_ref) DO NOTHING`,
              [input.root.body_ref, input.body],
            );
            await client.query(
              `INSERT INTO document_versions
                 (entity_id, version_id, parent_version_id, version_number, content_hash,
                  model_revision, body_ref, body_bytes, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                input.root.entity_id,
                input.root.version_id,
                input.root.parent_version_id,
                input.root.version_number,
                input.root.content_hash,
                input.root.model_revision,
                input.root.body_ref,
                input.root.body_bytes,
                input.root.created_by,
              ],
            );
            await this.appendLog(client, {
              entity_id: input.record.entity_id,
              command_name: "document.create",
              base_version_id: "",
              result_version_id: input.root.version_id,
              idem_scope: null,
              idem_key: null,
              actor: input.actor,
              ok: true,
              err_code: null,
            });
            await client.query("COMMIT");
            txOpen = false;
            return input.record;
          } catch (e) {
            if (txOpen) {
              await client.query("ROLLBACK").catch(() => undefined);
            }
            // The duplicate registry identity is a DOMAIN outcome (typed,
            // never retried); the failure is audited in its own committed
            // transaction — the command_log has no documents FK by design
            // (the audit trail must record declines on absent rows too).
            if (isUniqueViolation(e, "documents_pkey")) {
              await this.logDeclineStandalone({
                entity_id: input.record.entity_id,
                command_name: "document.create",
                base_version_id: "",
                idem_scope: null,
                idem_key: null,
                actor: input.actor,
                err_code: "document_exists",
              });
              throw new DocumentStoreError(
                "document_exists",
                `document '${input.record.entity_id}' already exists in the registry`,
              );
            }
            throw e;
          }
        });
      } catch (e) {
        if (e instanceof DocumentStoreError) {
          throw e; // a typed decline is the domain outcome — never retried
        }
        lastError = e;
        continue; // a transient backend failure — the bounded retry
      }
    }
    throw new DocumentStoreError(
      "document_store_failed",
      `createDocument for '${input.record.entity_id}' did not succeed after ${MAX_COMMIT_ATTEMPTS} attempts: ${(lastError as Error | undefined)?.message ?? "unknown"}`,
    );
  }

  async getDocument(entityId: string): Promise<DocumentRecord | null> {
    return this.withClient(async (client) => {
      const res = await client.query<DocumentRow>(
        `SELECT entity_id, tenant, format, format_version, created_by,
                head_version_id, head_version_number, head_content_hash, head_model_revision
         FROM documents WHERE entity_id = $1`,
        [entityId],
      );
      if ((res.rowCount ?? 0) === 0) return null;
      return mapDocumentRow(res.rows[0]!);
    });
  }

  async commit(input: DocumentCommitInput): Promise<DocumentCommitOutcome> {
    validateCommitInput(input);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
      try {
        await this.ready;
        return await this.withClient(async (client) => {
          let txOpen = false;
          try {
            await client.query("BEGIN");
            txOpen = true;
            // 1. The per-document serialization + the CAS base.
            const docRes = await client.query<DocumentRow>(
              `SELECT entity_id, tenant, format, format_version, created_by,
                      head_version_id, head_version_number, head_content_hash, head_model_revision
               FROM documents WHERE entity_id = $1 FOR UPDATE`,
              [input.entity_id],
            );
            if ((docRes.rowCount ?? 0) === 0) {
              await this.appendLog(client, {
                entity_id: input.entity_id,
                command_name: input.command.command_name,
                base_version_id: input.base.version_id,
                result_version_id: null,
                idem_scope: input.idempotency?.scope ?? null,
                idem_key: input.idempotency?.idem_key ?? null,
                actor: input.command.actor,
                ok: false,
                err_code: "document_not_found",
              });
              await client.query("COMMIT");
              txOpen = false;
              throw new DocumentStoreError(
                "document_not_found",
                `document '${input.entity_id}' does not exist in the registry`,
              );
            }
            const current = mapDocumentRow(docRes.rows[0]!);
            // 2. The idempotency check PRECEDES the CAS: a retry of an
            //    applied command replays the persisted binding regardless
            //    of how far the head moved on.
            if (input.idempotency !== null) {
              const idemRes = await client.query<IdempotencyRow>(
                `SELECT scope, idem_key, request_hash, response_binding, applied_version
                 FROM idempotency_keys WHERE scope = $1 AND idem_key = $2`,
                [input.idempotency.scope, input.idempotency.idem_key],
              );
              if ((idemRes.rowCount ?? 0) > 0) {
                const existing = mapIdempotencyRow(idemRes.rows[0]!);
                if (existing.request_hash !== input.idempotency.request_hash) {
                  await this.appendLog(client, {
                    entity_id: input.entity_id,
                    command_name: input.command.command_name,
                    base_version_id: input.base.version_id,
                    result_version_id: null,
                    idem_scope: input.idempotency.scope,
                    idem_key: input.idempotency.idem_key,
                    actor: input.command.actor,
                    ok: false,
                    err_code: "idempotency_key_conflict",
                  });
                  await client.query("COMMIT");
                  txOpen = false;
                  throw new DocumentStoreError(
                    "idempotency_key_conflict",
                    `idempotency key '${input.idempotency.idem_key}' in scope '${input.idempotency.scope}' is already bound to a different request`,
                  );
                }
                const vRes = await client.query<VersionRow>(
                  `SELECT entity_id, version_id, parent_version_id, version_number, content_hash,
                          model_revision, body_ref, body_bytes, created_by
                   FROM document_versions WHERE entity_id = $1 AND version_id = $2`,
                  [input.entity_id, existing.applied_version],
                );
                if ((vRes.rowCount ?? 0) === 0) {
                  throw new DocumentStoreError(
                    "document_corrupt",
                    `idempotency binding '${input.idempotency.idem_key}' references version '${existing.applied_version}' which is not in the chain`,
                  );
                }
                const replayed = mapVersionRow(vRes.rows[0]!);
                await this.appendLog(client, {
                  entity_id: input.entity_id,
                  command_name: input.command.command_name,
                  base_version_id: input.base.version_id,
                  result_version_id: replayed.version_id,
                  idem_scope: input.idempotency.scope,
                  idem_key: input.idempotency.idem_key,
                  actor: input.command.actor,
                  ok: true,
                  err_code: null,
                });
                await client.query("COMMIT");
                txOpen = false;
                return { version: replayed, replayed: true };
              }
            }
            // 3. The CAS: exactly one writer wins per base revision.
            if (current.head_version_id !== input.base.version_id) {
              const interveningRes = await client.query<VersionRow>(
                `SELECT entity_id, version_id, parent_version_id, version_number, content_hash,
                        model_revision, body_ref, body_bytes, created_by
                 FROM document_versions WHERE entity_id = $1 AND version_number > $2
                 ORDER BY version_number ASC`,
                [input.entity_id, input.base.version_number],
              );
              const conflictData: DocumentConflictData = {
                entity_id: input.entity_id,
                current,
                intervening: interveningRes.rows.map(mapVersionRow),
              };
              await this.appendLog(client, {
                entity_id: input.entity_id,
                command_name: input.command.command_name,
                base_version_id: input.base.version_id,
                result_version_id: null,
                idem_scope: input.idempotency?.scope ?? null,
                idem_key: input.idempotency?.idem_key ?? null,
                actor: input.command.actor,
                ok: false,
                err_code: "document_conflict",
              });
              await client.query("COMMIT");
              txOpen = false;
              throw new DocumentStoreError(
                "document_conflict",
                `document '${input.entity_id}' head is '${current.head_version_id}' (version ${current.head_version_number}), not the asserted base '${input.base.version_id}' — ${conflictData.intervening.length} version(s) intervened`,
                conflictData,
              );
            }
            // 4. The content-addressed body put (the existence proof at
            //    commit — insert-if-absent is the idempotent dedup).
            await client.query(
              `INSERT INTO document_blobs (body_ref, content)
               VALUES ($1, $2::json) ON CONFLICT (body_ref) DO NOTHING`,
              [input.version.body_ref, input.body],
            );
            // 5. The version append (the chain).
            await client.query(
              `INSERT INTO document_versions
                 (entity_id, version_id, parent_version_id, version_number, content_hash,
                  model_revision, body_ref, body_bytes, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                input.version.entity_id,
                input.version.version_id,
                input.version.parent_version_id,
                input.version.version_number,
                input.version.content_hash,
                input.version.model_revision,
                input.version.body_ref,
                input.version.body_bytes,
                input.version.created_by,
              ],
            );
            // 6. The head advance (the CAS target).
            await client.query(
              `UPDATE documents
                 SET head_version_id = $1, head_version_number = $2,
                     head_content_hash = $3, head_model_revision = $4, updated_at = now()
               WHERE entity_id = $5`,
              [
                input.version.version_id,
                input.version.version_number,
                input.version.content_hash,
                input.version.model_revision,
                input.entity_id,
              ],
            );
            // 7. The idempotency insert (the persisted replay binding).
            if (input.idempotency !== null) {
              await client.query(
                `INSERT INTO idempotency_keys
                   (scope, idem_key, request_hash, response_binding, applied_version)
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                  input.idempotency.scope,
                  input.idempotency.idem_key,
                  input.idempotency.request_hash,
                  input.idempotency.response_binding,
                  input.version.version_id,
                ],
              );
            }
            // 8. The audit entry.
            await this.appendLog(client, {
              entity_id: input.entity_id,
              command_name: input.command.command_name,
              base_version_id: input.base.version_id,
              result_version_id: input.version.version_id,
              idem_scope: input.idempotency?.scope ?? null,
              idem_key: input.idempotency?.idem_key ?? null,
              actor: input.command.actor,
              ok: true,
              err_code: null,
            });
            await client.query("COMMIT");
            txOpen = false;
            return { version: input.version, replayed: false };
          } catch (e) {
            if (txOpen) {
              await client.query("ROLLBACK").catch(() => undefined);
            }
            // A version-identity or idempotency unique violation cannot
            // occur under the FOR UPDATE serialization unless the stored
            // chain is inconsistent — LOCK-007: reject, never guess.
            if (
              isUniqueViolation(e, "document_versions_pkey")
              || isUniqueViolation(e, "document_versions_entity_id_version_number_key")
              || isUniqueViolation(e, "idempotency_keys_pkey")
            ) {
              throw new DocumentStoreError(
                "document_corrupt",
                `a unique constraint fired under the serialization lock: ${(e as Error).message}`,
              );
            }
            throw e;
          }
        });
      } catch (e) {
        if (e instanceof DocumentStoreError) {
          throw e; // a typed decline is the domain outcome — never retried
        }
        lastError = e;
        continue; // a transient backend failure — the bounded retry
      }
    }
    throw new DocumentStoreError(
      "document_store_failed",
      `commit for '${input.entity_id}' did not succeed after ${MAX_COMMIT_ATTEMPTS} attempts: ${(lastError as Error | undefined)?.message ?? "unknown"}`,
    );
  }

  async getVersion(entityId: string, versionId: string): Promise<DocumentVersionRecord | null> {
    return this.withClient(async (client) => {
      const res = await client.query<VersionRow>(
        `SELECT entity_id, version_id, parent_version_id, version_number, content_hash,
                model_revision, body_ref, body_bytes, created_by
         FROM document_versions WHERE entity_id = $1 AND version_id = $2`,
        [entityId, versionId],
      );
      if ((res.rowCount ?? 0) === 0) return null;
      return mapVersionRow(res.rows[0]!);
    });
  }

  async listVersions(entityId: string): Promise<readonly DocumentVersionRecord[]> {
    return this.withClient(async (client) => {
      const res = await client.query<VersionRow>(
        `SELECT entity_id, version_id, parent_version_id, version_number, content_hash,
                model_revision, body_ref, body_bytes, created_by
         FROM document_versions WHERE entity_id = $1 ORDER BY version_number ASC`,
        [entityId],
      );
      return res.rows.map(mapVersionRow);
    });
  }

  async getIdempotency(scope: string, idemKey: string): Promise<IdempotencyRecord | null> {
    return this.withClient(async (client) => {
      const res = await client.query<IdempotencyRow>(
        `SELECT scope, idem_key, request_hash, response_binding, applied_version
         FROM idempotency_keys WHERE scope = $1 AND idem_key = $2`,
        [scope, idemKey],
      );
      if ((res.rowCount ?? 0) === 0) return null;
      return mapIdempotencyRow(res.rows[0]!);
    });
  }

  async listCommandLog(entityId: string): Promise<readonly CommandLogEntry[]> {
    return this.withClient(async (client) => {
      const res = await client.query<CommandLogRow>(
        `SELECT seq, entity_id, command_name, base_version_id, result_version_id,
                idem_scope, idem_key, actor, ok, err_code
         FROM command_log WHERE entity_id = $1 ORDER BY seq ASC`,
        [entityId],
      );
      return res.rows.map(mapCommandLogRow);
    });
  }

  async fetchBody(bodyRef: string): Promise<string | null> {
    return this.withClient(async (client) => {
      // content::text — the EXACT stored text (the json type preserves it;
      // the byte-identity contract).
      const res = await client.query<{ content: string }>(
        "SELECT content::text AS content FROM document_blobs WHERE body_ref = $1",
        [bodyRef],
      );
      if ((res.rowCount ?? 0) === 0) return null;
      return res.rows[0]!.content;
    });
  }

  async persistedView(entityId: string): Promise<string> {
    return this.withClient(async (client) => {
      const docRes = await client.query<DocumentRow>(
        `SELECT entity_id, tenant, format, format_version, created_by,
                head_version_id, head_version_number, head_content_hash, head_model_revision
         FROM documents WHERE entity_id = $1`,
        [entityId],
      );
      const versionsRes = await client.query<VersionRow>(
        `SELECT entity_id, version_id, parent_version_id, version_number, content_hash,
                model_revision, body_ref, body_bytes, created_by
         FROM document_versions WHERE entity_id = $1 ORDER BY version_number ASC`,
        [entityId],
      );
      const versions = versionsRes.rows.map(mapVersionRow);
      const bodyRefs = [...new Set(versions.map((v) => v.body_ref))];
      const bodies: Record<string, string> = {};
      if (bodyRefs.length > 0) {
        const bodyRes = await client.query<{ body_ref: string; content: string }>(
          "SELECT body_ref, content::text AS content FROM document_blobs WHERE body_ref = ANY($1::text[])",
          [bodyRefs],
        );
        for (const row of bodyRes.rows) {
          bodies[row.body_ref] = row.content;
        }
      }
      const idemRes = await client.query<IdempotencyRow>(
        `SELECT scope, idem_key, request_hash, response_binding, applied_version
         FROM idempotency_keys WHERE scope = $1 ORDER BY idem_key ASC`,
        [idempotencyScope(entityId)],
      );
      const logRes = await client.query<CommandLogRow>(
        `SELECT seq, entity_id, command_name, base_version_id, result_version_id,
                idem_scope, idem_key, actor, ok, err_code
         FROM command_log WHERE entity_id = $1 ORDER BY seq ASC`,
        [entityId],
      );
      const view: PersistedDocumentViewData = {
        entity_id: entityId,
        document: (docRes.rowCount ?? 0) === 0 ? null : mapDocumentRow(docRes.rows[0]!),
        versions,
        bodies,
        idempotency: idemRes.rows.map(mapIdempotencyRow),
        command_log: logRes.rows.map(mapCommandLogRow),
      };
      return renderPersistedView(view);
    });
  }

  /** Close the pool (test teardown / graceful shutdown). */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Append one command-log audit entry inside the caller's transaction. */
  private async appendLog(
    client: PoolClient,
    entry: {
      entity_id: string;
      command_name: string;
      base_version_id: string;
      result_version_id: string | null;
      idem_scope: string | null;
      idem_key: string | null;
      actor: string | null;
      ok: boolean;
      err_code: string | null;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO command_log
         (entity_id, command_name, base_version_id, result_version_id, idem_scope, idem_key, actor, ok, err_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.entity_id,
        entry.command_name,
        entry.base_version_id,
        entry.result_version_id,
        entry.idem_scope,
        entry.idem_key,
        entry.actor,
        entry.ok,
        entry.err_code,
      ],
    );
  }

  /** The standalone decline audit (its own committed transaction — used
   *  when the primary transaction ABORTED before it could log, e.g. the
   *  duplicate-registry insert; command_log deliberately has no documents
   *  FK so declines on absent rows are auditable). */
  private async logDeclineStandalone(entry: {
    entity_id: string;
    command_name: string;
    base_version_id: string;
    idem_scope: string | null;
    idem_key: string | null;
    actor: string | null;
    err_code: string;
  }): Promise<void> {
    try {
      await this.withClient(async (client) => {
        await client.query("BEGIN");
        try {
          await this.appendLog(client, {
            entity_id: entry.entity_id,
            command_name: entry.command_name,
            base_version_id: entry.base_version_id,
            result_version_id: null,
            idem_scope: entry.idem_scope,
            idem_key: entry.idem_key,
            actor: entry.actor,
            ok: false,
            err_code: entry.err_code,
          });
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw e;
        }
      });
    } catch {
      // The decline audit is best-effort: the typed decline itself is the
      // authoritative outcome — a failed audit insert must never mask it.
    }
  }
}

function isUniqueViolation(e: unknown, constraint: string): boolean {
  return (
    typeof e === "object"
    && e !== null
    && (e as { code?: unknown }).code === "23505"
    && (e as { constraint?: unknown }).constraint === constraint
  );
}
