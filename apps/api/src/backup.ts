import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import type { Database } from "./database";
import { decode, encode, hash, objectStore, type ObjectStore } from "./objects";
import type { Config } from "./config";
const tables = [
  "members",
  "invites",
  "sessions",
  "games",
  "jobs",
  "outbox",
  "events",
  "objects",
  "feedback",
  "analytics",
  "usage",
  "usage_daily",
  "audit",
  "diagnostics",
  "tombstones",
  "operations",
] as const;
type Tables = (typeof tables)[number];
interface Manifest {
  version: 1;
  createdAt: string;
  tables: Record<Tables, Record<string, unknown>[]>;
  objects: { key: string; checksum: string; backupKey: string }[];
}
export class Backup {
  constructor(
    readonly db: Database,
    readonly live: ObjectStore,
    readonly copies: ObjectStore[],
    readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("Backup key must be 32 bytes");
  }
  private seal(bytes: Uint8Array): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([c.update(bytes), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), encrypted]);
  }
  private open(bytes: Uint8Array): Buffer {
    const b = Buffer.from(bytes);
    const c = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([c.update(b.subarray(28)), c.final()]);
  }
  private async copy(key: string, bytes: Uint8Array): Promise<void> {
    for (const store of this.copies) {
      await store.put(key, bytes);
      if (hash(await store.get(key)) !== hash(bytes)) throw new Error("Backup verification failed");
    }
  }
  async create(): Promise<string> {
    if (!this.copies.length) throw new Error("Backup destinations missing");
    const prefix = `backups/${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomUUID()}`;
    // A live backup renews its pin. A killed request may be replaced after 15 minutes.
    const pinned = await this.db.query(
      "INSERT INTO private.operations(key,value) VALUES('gc_pin',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now() WHERE private.operations.value ? 'backup' AND private.operations.updated_at<now()-interval '15 minutes' RETURNING key",
      [JSON.stringify({ backup: prefix })],
    );
    if (!pinned.length) throw new Error("GC is pinned by another backup or restore");
    const renewal = setInterval(() => {
      void this.db
        .query(
          "UPDATE private.operations SET updated_at=now() WHERE key='gc_pin' AND value->>'backup'=$1",
          [prefix],
        )
        .catch(() => {});
    }, 10000);
    try {
      const rows = await this.db.transaction(async (sql) => {
        const output = {} as Manifest["tables"];
        for (const name of tables) output[name] = await sql.query(`SELECT * FROM private.${name}`);
        return output;
      }, "repeatable read");
      const refs = new Set<string>();
      // 세이브 본문이 가리키는 조각도 함께 — 본문만 복제하면 복원한 세이브가 열리지 않는다
      const chunks = new Map(rows.objects.map((o) => [o.key, o.refs]));
      for (const game of rows.games) {
        if (typeof game.snapshot_key === "string") {
          refs.add(game.snapshot_key);
          const listed = chunks.get(game.snapshot_key);
          if (Array.isArray(listed))
            for (const key of listed) if (typeof key === "string") refs.add(key);
        }
        if (typeof game.view_key === "string") refs.add(game.view_key);
      }
      // Completed operation receipts survive; the latest game/view reconstructs UI after restore.
      // Transient per-job result copies are deliberately excluded from daily backups.
      rows.jobs = rows.jobs.map((job) => ({
        ...job,
        result_key: null,
        work_key: null,
        payload: {},
      }));
      for (const d of rows.diagnostics)
        if (typeof d.object_key === "string") refs.add(d.object_key);
      const objects: Manifest["objects"] = [];
      const keys = [...refs];
      const registered = new Map(rows.objects.map((o) => [o.key, o.checksum]));
      for (let start = 0; start < keys.length; start += 4) {
        await Promise.all(
          keys.slice(start, start + 4).map(async (key, offset) => {
            const bytes = await this.live.get(key);
            if (registered.get(key) !== hash(bytes))
              throw new Error("Backup source checksum mismatch");
            const backupKey = `${prefix}/objects/${start + offset}`;
            await this.copy(backupKey, this.seal(bytes));
            objects.push({ key, checksum: hash(bytes), backupKey });
          }),
        );
      }
      const manifest: Manifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        tables: rows,
        objects,
      };
      const key = `${prefix}/manifest`;
      await this.copy(key, this.seal(encode(manifest)));
      await this.db.transaction(async (sql) => {
        await sql.query(
          "INSERT INTO private.operations(key,value) VALUES('last_backup',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
          [JSON.stringify({ key, objects: objects.length })],
        );
        await sql.query(
          "DELETE FROM private.operations WHERE key='gc_pin' AND value->>'backup'=$1",
          [prefix],
        );
      });
      return key;
    } finally {
      clearInterval(renewal);
      await this.db.query(
        "DELETE FROM private.operations WHERE key='gc_pin' AND value->>'backup'=$1",
        [prefix],
      );
    }
  }
  async restore(key: string, source = 0): Promise<void> {
    if (!/^backups\/[A-Za-z0-9-]+\/manifest$/.test(key)) throw new Error("Invalid backup manifest");
    const store = this.copies[source];
    if (!store) throw new Error("Missing backup source");
    const value = decode(this.open(await store.get(key))) as Omit<Manifest, "version"> & {
      version: number;
    };
    if (value.version !== 1) throw new Error("Unsupported backup");
    await this.db.query(
      "INSERT INTO private.operations(key,value) VALUES('maintenance','true') ON CONFLICT(key) DO UPDATE SET value='true',updated_at=now()",
    );
    await this.db.query(
      "INSERT INTO private.operations(key,value) VALUES('gc_pin',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
      [JSON.stringify({ restore: key })],
    );
    // Invalidate running fences before restoring objects or SQL metadata.
    await this.db.query(
      "UPDATE private.jobs SET status='cancelled',lease_until=NULL WHERE status IN ('queued','running')",
    );
    const tombstones = await this.db.query<{ owner_id: string }>(
      "SELECT owner_id FROM private.tombstones",
    );
    for (const marker of await this.live.list("tombstones/")) {
      const id = marker.slice("tombstones/".length);
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid deletion marker");
      const data = decode(await this.live.get(marker)) as { ownerId: string };
      if (data.ownerId !== id) throw new Error("Deletion marker mismatch");
      tombstones.push({ owner_id: id });
    }
    for (const ref of value.objects) {
      const bytes = this.open(await store.get(ref.backupKey));
      if (hash(bytes) !== ref.checksum) throw new Error("Backup object corrupt");
      let current: Uint8Array | null = null;
      try {
        current = await this.live.get(ref.key);
      } catch {
        /* Missing live objects are restored from verified copies. */
      }
      if (current) {
        if (hash(current) !== ref.checksum)
          throw new Error("Existing object conflicts with backup");
      } else await this.live.put(ref.key, bytes);
    }
    await this.db.transaction(async (sql) => {
      // Restore is an operator-only operation; runtime database roles cannot TRUNCATE.
      await sql.query(`TRUNCATE ${tables.map((t) => `private.${t}`).join(",")} CASCADE`);
      for (const table of tables)
        for (const row of value.tables[table]) {
          const columns = Object.keys(row);
          if (columns.some((k) => !/^[a-z_]+$/.test(k))) throw new Error("Invalid backup column");
          await sql.query(
            `INSERT INTO private.${table}(${columns.join(",")}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(",")})`,
            columns.map((k) => {
              const v = row[k];
              return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
            }),
          );
        }
      for (const deleted of tombstones)
        await sql.query(
          "INSERT INTO private.tombstones(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
          [deleted.owner_id],
        );
      await sql.query(
        "UPDATE private.jobs SET status='cancelled',lease_until=NULL WHERE status IN ('queued','running')",
      );
      await sql.query(
        "UPDATE private.games SET active_job=NULL,client_epoch=client_epoch+1,client_id=NULL",
      );
      await sql.query("DELETE FROM private.sessions");
      await sql.query("DELETE FROM private.outbox");
      await sql.query(
        "UPDATE private.members SET active=false WHERE id IN (SELECT owner_id FROM private.tombstones)",
      );
      await sql.query(
        "UPDATE private.games SET deleted_at=now() WHERE owner_id IN (SELECT owner_id FROM private.tombstones)",
      );
      await sql.query(
        "INSERT INTO private.operations(key,value) VALUES('maintenance','true'),('cost_reconciliation_required','true'),('gc_pin',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [JSON.stringify({ restore: key })],
      );
    });
  }
}
export function configuredBackup(
  c: Config,
  db: Database,
  live: ObjectStore,
  env: NodeJS.ProcessEnv = process.env,
): Backup {
  const bucket = env.BACKUP_R2_BUCKET;
  const key = env.BACKUP_KEY;
  const gcsBucket = env.BACKUP_GCS_BUCKET;
  if (!bucket || !key || !gcsBucket)
    throw new Error("Both backup destinations and BACKUP_KEY are required");
  const r2 = objectStore({
    ...c,
    R2_BUCKET: bucket,
    R2_ACCESS_KEY_ID: env.BACKUP_R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.BACKUP_R2_SECRET_ACCESS_KEY,
  });
  const gcs = new Storage().bucket(gcsBucket);
  const google: ObjectStore = {
    list: async (prefix) => (await gcs.getFiles({ prefix }))[0].map((file) => file.name),
    put: async (name, body) => {
      await gcs
        .file(name)
        .save(Buffer.from(body), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    },
    get: async (name) => (await gcs.file(name).download())[0],
    delete: async (name) => {
      await gcs.file(name).delete({ ignoreNotFound: true });
    },
  };
  return new Backup(db, live, [r2, google], Buffer.from(key, "base64"));
}
