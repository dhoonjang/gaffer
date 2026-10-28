import { report } from "./report";
import { decode } from "./objects";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { simBuildId } from "../../../scripts/sim-build";
import { LLM_CONFIG } from "@gaffer/llm";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { postgresOptions } from "./postgres";
import { configuration } from "./config";
import { database } from "./database";
import { objectStore } from "./objects";
import { Auth } from "./auth";
import { configuredBackup } from "./backup";
import { Jobs } from "./jobs";
const [command, arg] = process.argv.slice(2);
if (command === "price-template") {
  const models = Object.fromEntries(
    [...Object.values(LLM_CONFIG.agents), ...Object.values(LLM_CONFIG.evaluators)].map((x) => [
      `${x.provider}/${x.model}`,
      {
        inputMicrosPerToken: null,
        outputMicrosPerToken: null,
        rpm: null,
        tpm: null,
        concurrency: null,
      },
    ]),
  );
  console.info(JSON.stringify({ version: new Date().toISOString().slice(0, 10), models }, null, 2));
} else if (command === "migrate") {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
  const client = new pg.Client(postgresOptions(url));
  await client.connect();
  try {
    for (const file of ["001-service.sql", "003-roles.sql"]) {
      await client.query(
        await readFile(new URL(`../../../infra/migrations/${file}`, import.meta.url), "utf8"),
      );
    }
  } finally {
    await client.end();
  }
} else {
  const c = configuration();
  const db = await database(c, true);
  const objects = objectStore(c);
  try {
    switch (command ?? "") {
      case "reconcile":
        await new Jobs(db, objects).recover();
        break;
      case "backup":
        console.info(await configuredBackup(c, db, objects).create());
        break;
      case "restore":
        if (!arg) throw new Error("Supply a backup manifest key");
        await configuredBackup(c, db, objects).restore(arg);
        console.info(
          "Restored in maintenance mode. Sessions and active jobs invalidated. Cost reconciliation is required.",
        );
        break;
      case "resume-after-restore":
        if (arg !== "costs-reconciled")
          throw new Error("Reconcile provider usage, then pass costs-reconciled");
        await db.query(
          "DELETE FROM private.operations WHERE key IN ('maintenance','cost_reconciliation_required')",
        );
        console.info(
          "Traffic enabled. GC remains pinned until backup references have been reviewed.",
        );
        break;
      case "deployment-check": {
        const incompatible = await db.query(
          "SELECT id FROM private.games WHERE deleted_at IS NULL AND match_build IS NOT NULL AND match_build<>$1",
          [simBuildId()],
        );
        if (incompatible.length)
          throw new Error("Finish active matches before deploying a changed simulator");
        console.info("Simulator rollout is compatible");
        break;
      }
      case "retry-lore": {
        const id = z.string().uuid().parse(arg);
        await db.transaction(async (sql) => {
          const rows = await sql.query(
            "UPDATE private.jobs SET status='queued',lore_failures=0,attempt=0,deadline=now()+interval '15 minutes',lease_until=NULL WHERE id=$1 AND path='/internal/lorebook' AND status IN ('dead','failed','expired') AND owner_id IN (SELECT id FROM private.members WHERE active) RETURNING id",
            [id],
          );
          if (!rows.length) throw new Error("No held lorebook job");
          await sql.query(
            "INSERT INTO private.outbox(job_id,generation) VALUES($1,1) ON CONFLICT(job_id) DO UPDATE SET generation=private.outbox.generation+1,sent_at=NULL,next_at=now()",
            [id],
          );
          await sql.query(
            "INSERT INTO private.audit(id,action,subject) VALUES($1,'lorebook_retry',$2)",
            [randomUUID(), id],
          );
        });
        break;
      }
      case "report":
        console.info(JSON.stringify(await report(db), null, 2));
        break;
      case "feedback":
        console.info(
          JSON.stringify(
            await db.query(
              "SELECT id,category,message,status,game_id,job_id,revision,release,created_at FROM private.feedback ORDER BY created_at DESC LIMIT 100",
            ),
            null,
            2,
          ),
        );
        break;
      case "feedback-status": {
        const id = z.string().uuid().parse(arg);
        const status = z
          .enum(["new", "triaged", "investigating", "resolved", "closed"])
          .parse(process.argv[4]);
        const note = z
          .string()
          .max(2000)
          .parse(process.argv[5] ?? "");
        await db.query("UPDATE private.feedback SET status=$2,operator_note=$3 WHERE id=$1", [
          id,
          status,
          note,
        ]);
        await db.query(
          "INSERT INTO private.audit(id,action,subject) VALUES($1,'feedback_status',$2)",
          [randomUUID(), id],
        );
        break;
      }
      case "diagnostic": {
        const id = z.string().uuid().parse(arg);
        const [row] = await db.query<{ object_key: string }>(
          "SELECT object_key FROM private.diagnostics WHERE id=$1 AND expires_at>now()",
          [id],
        );
        if (!row) throw new Error("Diagnostic unavailable");
        await db.query(
          "INSERT INTO private.audit(id,action,subject) VALUES($1,'diagnostic_read',$2)",
          [randomUUID(), id],
        );
        const value = decode(await objects.get(row.object_key)) as { cipher: string };
        console.info(JSON.stringify(new Auth(c, db).decrypt(value.cipher)));
        break;
      }
      case "status":
        console.info(
          JSON.stringify(
            await db.query("SELECT status,count(*)::text FROM private.jobs GROUP BY status"),
          ),
        );
        break;
      default:
        throw new Error(
          "Commands: migrate, reconcile, backup, restore, resume-after-restore, status",
        );
    }
  } finally {
    await db.close();
  }
}
