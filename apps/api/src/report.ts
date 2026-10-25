import type { Database } from "./database";
export async function report(db: Database): Promise<unknown> {
  const usage = await db.query(
    "SELECT provider,model,count(*)::text AS calls,sum(coalesce(actual_micros,reserved_micros))::text AS cost_micros,count(*) FILTER(WHERE status='unknown')::text AS unknown FROM private.usage WHERE created_at>now()-interval '30 days' GROUP BY provider,model",
  );
  const funnel = await db.query(
    "SELECT name,count(*)::text AS events,count(DISTINCT a.owner_id)::text AS users FROM private.analytics a JOIN private.members m ON m.id=a.owner_id WHERE m.role='member' AND a.created_at>now()-interval '30 days' GROUP BY name ORDER BY name",
  );
  const retention =
    await db.query(`WITH joined AS(SELECT m.id,(min(a.created_at) AT TIME ZONE 'UTC')::date AS day FROM private.members m JOIN private.analytics a ON a.owner_id=m.id AND a.name='invite_accepted' WHERE m.role='member' GROUP BY m.id), days AS(SELECT unnest(ARRAY[1,7]) AS n)
 SELECT n,count(*) FILTER(WHERE j.day+n<(now() AT TIME ZONE 'UTC')::date)::text AS eligible,count(*) FILTER(WHERE j.day+n<(now() AT TIME ZONE 'UTC')::date AND EXISTS(SELECT 1 FROM private.analytics a WHERE a.owner_id=j.id AND a.name IN ('turn_committed','match_completed') AND (a.created_at AT TIME ZONE 'UTC')::date=j.day+n))::text AS returned FROM joined j CROSS JOIN days GROUP BY n`);
  const jobs = await db.query(
    "SELECT status,count(*)::text AS count FROM private.jobs GROUP BY status",
  );
  const storage = await db.query(
    "SELECT pg_database_size(current_database())::text AS database_bytes",
  );
  const feedback = await db.query(
    "SELECT status,category,count(*)::text AS count FROM private.feedback GROUP BY status,category",
  );
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    usage,
    funnel,
    retention,
    jobs,
    storage,
    feedback,
  };
}
