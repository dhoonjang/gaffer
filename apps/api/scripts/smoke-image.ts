// The built server image, run in local mode with the mock model: it must boot from its
// bundles, run one game creation in an execution Worker and deliver the result over SSE.
// CI runs the container on the host network and this script beside it.
export {};
const base = process.env.SMOKE_ORIGIN ?? "http://127.0.0.1:8080";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
for (let tries = 0; ; tries++) {
  const ok = await fetch(`${base}/health`).then(
    (res) => res.ok,
    () => false,
  );
  if (ok) break;
  if (tries > 120) throw new Error("The server did not start");
  await wait(500);
}
const catalog = (await (await fetch(`${base}/api/games?catalog=1`)).json()) as {
  teams: { id: string }[];
};
const accepted = (await (
  await fetch(`${base}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `image-smoke-${Date.now()}` },
    body: JSON.stringify({ teamId: catalog.teams[0]!.id, managerName: "점검", background: "점검" }),
  })
).json()) as { jobId?: string };
if (!accepted.jobId) throw new Error(`Game creation was not accepted: ${JSON.stringify(accepted)}`);
const stream = await fetch(`${base}/api/jobs/${accepted.jobId}/events`, {
  headers: { accept: "text/event-stream" },
});
if (stream.headers.get("content-type")?.startsWith("text/event-stream") !== true)
  throw new Error(`Not an event stream: ${stream.status}`);
const text = await stream.text();
const end = /^event: end\ndata: (.*)$/m.exec(text);
if (!end) throw new Error(`The stream closed without a result:\n${text.slice(0, 500)}`);
const outcome = JSON.parse(end[1]!) as { result: { status: number } | null };
if (outcome.result?.status !== 200)
  throw new Error(`Game creation failed: ${end[1]!.slice(0, 300)}`);
console.info("image smoke passed");
