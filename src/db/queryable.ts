import type { Pool, PoolClient } from "pg";

/**
 * Accepted by every queue primitive that needs a transaction
 * (claimNextJob, finalizeJob, requestCancel, createRun). In production,
 * callers always pass a `Pool` and the primitive owns a connection's whole
 * lifecycle (connect, transact, release).
 *
 * The second reason this exists: a concurrency test that wants to prove
 * two operations genuinely race on two distinct Postgres backend
 * connections (not just "two JS calls that happen to interleave, but could
 * just as well run serially over the same connection and still pass") needs
 * to pin each operation to a specific, already-open `PoolClient` it
 * acquired and identified via `pg_backend_pid()` itself. Accepting
 * `Queryable` here lets a test do exactly that, without the primitive ever
 * knowing the difference — see test/db-harness.ts's
 * `acquireTwoDistinctClients` and its use in the barrier tests.
 */
export type Queryable = Pool | PoolClient;

function isPoolClient(db: Queryable): db is PoolClient {
  return typeof (db as PoolClient).release === "function";
}

/**
 * Runs `fn` inside BEGIN/COMMIT (ROLLBACK on throw). If `db` is a `Pool`,
 * a connection is acquired and released here. If `db` is already a
 * `PoolClient`, the transaction runs directly on it and the caller keeps
 * ownership of connect/release — this is what makes backend-pinned tests
 * possible.
 */
export async function withTransaction<T>(db: Queryable, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (isPoolClient(db)) {
    await db.query("BEGIN");
    try {
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
