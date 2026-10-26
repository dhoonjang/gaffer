import { postgresOptions } from "./postgres";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { Config } from "./config";

const actor = new AsyncLocalStorage<string>();
export const asActor = <T>(id: string, fn: () => T): T => actor.run(id, fn);
export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
}
export interface Database extends Sql {
  transaction<T>(fn: (sql: Sql) => Promise<T>, isolation?: "repeatable read"): Promise<T>;
  close(): Promise<void>;
  /**
   * NOTIFY 채널을 듣는다 — 돌려받은 함수로 그만 듣는다. 들을 연결이 없으면 null이고,
   * 연결이 끊기면 `onLost`를 한 번 부른다(다시 듣는 것은 부른 쪽의 몫).
   */
  listen(
    channel: string,
    onPayload: (payload: string) => void,
    onLost: () => void,
  ): Promise<(() => Promise<void>) | null>;
}
export async function database(c: Config, operator = false): Promise<Database> {
  if (c.GAFFER_MODE === "local") {
    await mkdir(c.GAFFER_DATA_DIR, { recursive: true });
    const db = new PGlite(resolve(c.GAFFER_DATA_DIR, "postgres"));
    const wrap = (s: Pick<PGlite, "query">): Sql => ({
      query: async <T extends Record<string, unknown>>(q: string, p: unknown[] = []) =>
        (await s.query<T>(q, p)).rows,
    });
    await db.exec(
      await readFile(new URL("../../../infra/migrations/001-service.sql", import.meta.url), "utf8"),
    );
    await db.exec(
      await readFile(new URL("../../../infra/migrations/003-roles.sql", import.meta.url), "utf8"),
    );
    return {
      ...wrap(db),
      transaction: (fn, isolation) =>
        db.transaction(async (tx) => {
          if (isolation) await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          return fn(wrap(tx));
        }),
      close: () => db.close(),
      listen: async (channel, onPayload) => {
        const stop = await db.listen(channel, onPayload);
        return async () => stop();
      },
    };
  }
  const pool = new pg.Pool({
    ...postgresOptions(c.DATABASE_URL),
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", () => console.error(JSON.stringify({ event: "database_connection_lost" })));
  if (!operator) {
    const expected =
      c.SERVICE_ROLE === "api"
        ? "gaffer_api"
        : c.SERVICE_ROLE === "maintenance"
          ? "gaffer_maintenance"
          : "gaffer_worker";
    const result = await pool.query<{ current_user: string }>("SELECT current_user");
    if (result.rows[0]?.current_user !== expected) {
      await pool.end();
      throw new Error("Use the dedicated non-owner database role");
    }
  }
  return {
    query: async <T extends Record<string, unknown>>(q: string, p: unknown[] = []) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('gaffer.actor',$1,true)", [actor.getStore() ?? ""]);
        const result = (await client.query<T>(q, p)).rows;
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    transaction: async (fn, isolation) => {
      const client = await pool.connect();
      try {
        await client.query(isolation ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN");
        await client.query("SELECT set_config('gaffer.actor',$1,true)", [actor.getStore() ?? ""]);
        const value = await fn({
          query: async <T extends Record<string, unknown>>(q: string, p: unknown[] = []) =>
            (await client.query<T>(q, p)).rows,
        });
        await client.query("COMMIT");
        return value;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
    listen: async (channel, onPayload, onLost) => {
      if (!c.DATABASE_LISTEN_URL) return null;
      const client = new pg.Client({ ...postgresOptions(c.DATABASE_LISTEN_URL), keepAlive: true });
      let lost = false;
      const drop = () => {
        if (lost) return;
        lost = true;
        onLost();
      };
      client.on("error", drop);
      client.on("end", drop);
      client.on("notification", (message) => {
        if (message.channel === channel && message.payload) onPayload(message.payload);
      });
      try {
        await client.connect();
        await client.query(`LISTEN ${client.escapeIdentifier(channel)}`);
      } catch (error) {
        lost = true;
        await client.end().catch(() => undefined);
        throw error;
      }
      return async () => {
        lost = true;
        await client.end().catch(() => undefined);
      };
    },
  };
}
