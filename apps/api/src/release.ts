import pg from "pg";
import { postgresOptions } from "./postgres";
import { setTimeout as pause } from "node:timers/promises";
import { simBuildId } from "../../../scripts/sim-build";
import { SAVE_VERSION } from "@gaffer/engine";
const [command] = process.argv.slice(2);
if (!process.env.DATABASE_URL) throw new Error("Deployment database credential required");
const sql = new pg.Client(postgresOptions(process.env.DATABASE_URL));
await sql.connect();
try {
  if (command === "pause") {
    const lock = await sql.query(
      "INSERT INTO private.operations(key,value) VALUES('deployment_lock',$1) ON CONFLICT DO NOTHING RETURNING key",
      [JSON.stringify(process.env.DEPLOY_SHA ?? "operator")],
    );
    if (!lock.rows.length) throw new Error("Another deployment requires inspection");
    const existing = await sql.query(
      "SELECT key FROM private.operations WHERE key='maintenance' AND value='true'",
    );
    if (existing.rows.length) {
      await sql.query("DELETE FROM private.operations WHERE key='deployment_lock'");
      throw new Error("Existing maintenance must be resolved first");
    }
    try {
      await sql.query(
        "INSERT INTO private.operations(key,value) VALUES('maintenance','true') ON CONFLICT(key) DO UPDATE SET value='true',updated_at=now()",
      );
      const until = Date.now() + 660000;
      for (;;) {
        const { rows } = await sql.query(
          "SELECT id FROM private.jobs WHERE status='running' AND lease_until>now() LIMIT 1",
        );
        if (!rows.length) break;
        if (Date.now() > until)
          throw new Error("Active jobs remain; deployment paused for operator review");
        await pause(5000);
      }
      const matches = await sql.query(
        "SELECT id FROM private.games WHERE deleted_at IS NULL AND match_build IS NOT NULL AND match_build<>$1",
        [simBuildId()],
      );
      if (matches.rows.length) {
        /**
         * The build id hashes every file the simulator can read, so a change that never touches
         * match logic (a colour table, a generated index) still moves it. An operator who has
         * read the diff and found the simulator's behaviour unchanged may carry the unfinished
         * matches to the new build instead of waiting for them — they resume from their last
         * verified checkpoint. Carrying a match across a real simulator change makes the next
         * checkpoint fail verification, so this is never the default.
         */
        if (process.env.CARRY_MATCHES !== "true")
          throw new Error(
            "Finish active matches before changing the simulator; existing version stays online",
          );
        const carried = await sql.query(
          "UPDATE private.games SET match_build=$1 WHERE deleted_at IS NULL AND match_build IS NOT NULL AND match_build<>$1",
          [simBuildId()],
        );
        console.info(`Carried ${String(carried.rowCount)} unfinished matches to the new build`);
      }
      const { rows } = await sql.query<{ value: unknown }>(
        "SELECT value FROM private.operations WHERE key='save_version'",
      );
      if (rows.length && rows[0]?.value !== SAVE_VERSION)
        throw new Error("SAVE_VERSION changed; this beta has no save migration");
    } catch (error) {
      await sql.query(
        "DELETE FROM private.operations WHERE key IN ('maintenance','deployment_lock')",
      );
      throw error;
    }
  } else if (command === "resume") {
    await sql.query("BEGIN");
    const { rows } = await sql.query(
      "SELECT key FROM private.operations WHERE key='cost_reconciliation_required'",
    );
    if (rows.length) throw new Error("Restore reconciliation required");
    await sql.query(
      "INSERT INTO private.operations(key,value) VALUES('save_version',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify(SAVE_VERSION)],
    );
    await sql.query(
      "DELETE FROM private.operations WHERE key IN ('maintenance','deployment_lock')",
    );
    await sql.query("COMMIT");
  } else throw new Error("Expected pause or resume");
} finally {
  await sql.end();
}
