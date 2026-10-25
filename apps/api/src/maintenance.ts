import type { Config } from "./config";
import type { Database } from "./database";
import type { ObjectStore } from "./objects";
/**
 * 거둘 수 있는 객체 — 하루가 지났고, 게임·작업·진단 어디서도 직접 가리키지 않고, 지금
 * 세이브나 작업 객체가 조각으로 가리키지도 않는다(`refs`). 선택과 삭제가 같은 조건을 쓴다.
 */
const COLLECTABLE = `o.created_at<now()-interval '1 day'
  AND NOT EXISTS(SELECT 1 FROM private.games g WHERE g.snapshot_key=o.key OR g.view_key=o.key)
  AND NOT EXISTS(SELECT 1 FROM private.jobs j WHERE j.result_key=o.key OR j.work_key=o.key)
  AND NOT EXISTS(SELECT 1 FROM private.diagnostics d WHERE d.object_key=o.key)
  AND NOT EXISTS(SELECT 1 FROM private.objects r WHERE r.refs ? o.key
    AND (EXISTS(SELECT 1 FROM private.games g WHERE g.snapshot_key=r.key)
      OR EXISTS(SELECT 1 FROM private.jobs j WHERE j.result_key=r.key OR j.work_key=r.key)))`;
export async function maintenance(c: Config, db: Database, objects: ObjectStore): Promise<void> {
  await db.transaction(async (sql) => {
    // Deleting the rows returned by this CTE makes repeated aggregation idempotent.
    await sql.query(`WITH old AS (DELETE FROM private.usage WHERE created_at<now()-interval '30 days' AND status<>'reserved' RETURNING *)
      INSERT INTO private.usage_daily(day,owner_id,provider,model,price_version,calls,cost_micros,input_tokens,output_tokens)
      SELECT (created_at AT TIME ZONE 'UTC')::date,owner_id,provider,model,price_version,count(*),sum(coalesce(actual_micros,reserved_micros)),sum(coalesce(input_tokens,0)),sum(coalesce(output_tokens,0)) FROM old GROUP BY 1,2,3,4,5
      ON CONFLICT(day,owner_id,provider,model,price_version) DO UPDATE SET calls=private.usage_daily.calls+excluded.calls,cost_micros=private.usage_daily.cost_micros+excluded.cost_micros,input_tokens=private.usage_daily.input_tokens+excluded.input_tokens,output_tokens=private.usage_daily.output_tokens+excluded.output_tokens`);
    await sql.query("DELETE FROM private.usage_daily WHERE day<current_date-180");
    await sql.query("DELETE FROM private.audit WHERE created_at<now()-interval '180 days'");
    await sql.query(
      "DELETE FROM private.diagnostics WHERE expires_at<now() OR owner_id IN (SELECT owner_id FROM private.tombstones)",
    );
    await sql.query(
      "UPDATE private.jobs SET payload='{}' WHERE status NOT IN ('queued','running') AND updated_at<now()-interval '24 hours'",
    );
    await sql.query(
      "UPDATE private.jobs SET result_key=NULL,work_key=NULL WHERE status NOT IN ('queued','running') AND updated_at<now()-interval '7 days'",
    );
  });
  // Restored tombstones may predate identity erasure; the login identifier lives only here.
  await db.transaction(async (sql) => {
    await sql.query(
      "UPDATE private.members m SET active=false,google_sub=NULL,email_hash='deleted:'||m.id::text FROM private.tombstones t WHERE t.owner_id=m.id AND t.auth_deleted_at IS NULL",
    );
    await sql.query(
      "UPDATE private.tombstones SET auth_deleted_at=now() WHERE auth_deleted_at IS NULL",
    );
  });
  const [pin] = await db.query("SELECT key FROM private.operations WHERE key='gc_pin'");
  if (!pin) {
    // Deleted games lose live references before objects are considered for collection.
    await db.transaction(async (sql) => {
      await sql.query(
        "UPDATE private.games SET snapshot_key=NULL,snapshot_hash=NULL,view_key=NULL,view_hash=NULL,summary='{}' WHERE deleted_at<now()-interval '1 day'",
      );
      await sql.query(
        "UPDATE private.jobs SET result_key=NULL,work_key=NULL,payload='{}' WHERE game_id IN (SELECT id FROM private.games WHERE deleted_at<now()-interval '1 day')",
      );
    });
    const rows = await db.query<{ key: string }>(
      `SELECT o.key FROM private.objects o WHERE ${COLLECTABLE} LIMIT 100`,
    );
    for (const row of rows) {
      if ((await db.query("SELECT key FROM private.operations WHERE key='gc_pin'")).length) break;
      // 행을 조건부로 먼저 지운다 — 그사이 다시 쓰인 조각(created_at 갱신)은 여기서 살아남는다
      const [gone] = await db.query(
        `DELETE FROM private.objects o WHERE o.key=$1 AND ${COLLECTABLE} RETURNING o.key`,
        [row.key],
      );
      if (gone) await objects.delete(row.key);
    }
  }
  const [backup] = await db.query<{ age: string }>(
    "SELECT extract(epoch FROM(now()-updated_at))/3600 AS age FROM private.operations WHERE key='last_backup'",
  );
  if (c.GAFFER_MODE === "production" && (!backup || Number(backup.age) > 26))
    console.error(JSON.stringify({ event: "backup_overdue", hours: backup?.age ?? null }));
  const [metrics] = await db.query(
    "SELECT count(*) FILTER(WHERE status='dead')::int AS dead,count(*) FILTER(WHERE status='running' AND lease_until<now())::int AS expired_leases,coalesce(max(extract(epoch FROM(now()-created_at))) FILTER(WHERE status='queued'),0)::float AS oldest_queue_seconds FROM private.jobs",
  );
  const [unknown] = await db.query(
    "SELECT count(*)::int AS unknown_calls FROM private.usage WHERE status='unknown' AND created_at>now()-interval '1 day'",
  );
  console.info(JSON.stringify({ event: "service_metrics", ...metrics, ...unknown }));
  if (
    Number(metrics?.dead) > 0 ||
    Number(metrics?.oldest_queue_seconds) > 300 ||
    Number(unknown?.unknown_calls) > 0
  )
    console.warn(JSON.stringify({ event: "service_attention", ...metrics, ...unknown }));
  // Product events are explicitly named; no chat, prompt, URL, email or replay is sent.
  const posthogKey = process.env.POSTHOG_API_KEY;
  const posthogOrigin = process.env.POSTHOG_ORIGIN;
  if (posthogKey && posthogOrigin) {
    const project = process.env.POSTHOG_PROJECT_ID;
    const admin = process.env.POSTHOG_PERSONAL_API_KEY;
    if (!project || !/^\d+$/.test(project) || !admin)
      throw new Error("PostHog deletion configuration required before exporting");
    const pending = await db.query<{ owner_id: string }>(
      "SELECT owner_id FROM private.tombstones WHERE analytics_deletion_requested_at IS NULL AND deleted_at<now()-interval '1 hour' LIMIT 100",
    );
    if (pending.length) {
      const deletionUrl = new URL(`/api/projects/${project}/persons/bulk_delete/`, posthogOrigin);
      if (deletionUrl.protocol !== "https:") throw new Error("PostHog must use HTTPS");
      const response = await fetch(deletionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin}` },
        body: JSON.stringify({
          distinct_ids: pending.map((r) => r.owner_id),
          delete_events: true,
          delete_recordings: true,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Analytics deletion deferred");
      const result = (await response.json()) as { deletion_errors?: unknown[] };
      if (!Array.isArray(result.deletion_errors) || result.deletion_errors.length)
        throw new Error("Analytics deletion incomplete");
      await db.query(
        "UPDATE private.tombstones SET analytics_deletion_requested_at=now() WHERE owner_id=ANY($1::uuid[])",
        [pending.map((r) => r.owner_id)],
      );
    }
    const url = new URL("/batch/", posthogOrigin);
    if (url.protocol !== "https:") throw new Error("PostHog must use HTTPS");
    const rows = await db.query<{ id: string; owner_id: string; name: string; created_at: string }>(
      "SELECT id,owner_id,name,created_at FROM private.analytics WHERE delivered_at IS NULL AND owner_id IN (SELECT id FROM private.members WHERE active AND analytics_consent AND role='member') ORDER BY created_at LIMIT 100",
    );
    if (rows.length) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: posthogKey,
          batch: rows.map((row) => ({
            uuid: row.id,
            event: row.name,
            timestamp: row.created_at,
            properties: { distinct_id: row.owner_id, $process_person_profile: true },
          })),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Analytics delivery failed");
      await db.query("UPDATE private.analytics SET delivered_at=now() WHERE id=ANY($1::uuid[])", [
        rows.map((row) => row.id),
      ]);
    }
  }
}
