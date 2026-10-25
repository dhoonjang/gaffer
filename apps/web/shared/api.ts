const nativeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
interface Receipt {
  key: string;
  createdAt: number;
  jobId?: string;
  gameId?: string;
}
interface JobStatus {
  id: string;
  status: string;
  gameId: string;
  revision: number | null;
  events: { seq: number; attempt: number; body: { type: string; text?: string } }[];
  result: { status: number; body: unknown } | null;
  error: string | null;
}
const revisions = new Map<string, number>();
/** 앞선 작업을 기다렸다가 다시 접수하는 횟수 — 그 사이 또 다른 작업이 끼어드는 일까지 받는다 */
const BUSY_ROUNDS = 3;
/**
 * 작업 조회 간격 — 짧게 시작해 두 배씩 늘려 상한에 머문다. 저장·읽음 표시처럼 1초 안에
 * 끝나는 작업이 조회 한 칸을 통째로 기다리지 않게 하고, 긴 턴은 상한 간격으로 묻는다.
 */
const POLL_FIRST_MS = 200;
const POLL_MAX_MS = 1200;
const pollDelay = (polls: number) => Math.min(POLL_MAX_MS, POLL_FIRST_MS * 2 ** polls);
const pause = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
export async function pollJob(
  id: string,
  onEvent: (body: { type: string; text?: string }) => void = () => {},
  signal?: AbortSignal | null,
): Promise<Response> {
  let seq = 0;
  for (let polls = 0; ; polls++) {
    const res = await nativeFetch(`/api/jobs/${id}?after=${seq}`, {
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return res;
    const job = (await res.json()) as JobStatus;
    for (const event of job.events) {
      seq = event.seq;
      onEvent(event.body);
    }
    if (job.result) {
      if (job.revision !== null) revisions.set(job.gameId, job.revision);
      return Response.json(job.result.body, { status: job.result.status });
    }
    if (job.status === "succeeded")
      return Response.json(
        {
          error: "이전 작업은 완료되었습니다. 게임을 다시 열어 최신 상태를 확인해 주세요",
          completed: true,
        },
        { status: 410 },
      );
    if (!["queued", "running"].includes(job.status))
      return Response.json({ error: job.error ?? "작업이 완료되지 않았습니다" }, { status: 409 });
    onEvent({ type: "ping" });
    await pause(document.hidden ? 10_000 : pollDelay(polls), signal);
  }
}
async function receiptKey(path: string, body: BodyInit | null | undefined): Promise<string> {
  const game = path.match(/^\/api\/games\/([^/]+)/)?.[1];
  const bytes = new TextEncoder().encode(
    path +
      "\n" +
      String(game ? (revisions.get(game) ?? 0) : 0) +
      "\n" +
      (typeof body === "string" ? body : ""),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return (
    "gaffer:request:" +
    Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("")
  );
}
function clientId(): string {
  let id = sessionStorage.getItem("gaffer:client");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("gaffer:client", id);
  }
  return id;
}
export async function takeControl(gameId: string, takeover = false): Promise<Response> {
  return nativeFetch(`/api/games/${gameId}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: clientId(), takeover }),
  });
}
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof window === "undefined") return nativeFetch(input, init);
  const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  if (method !== "POST" || !/^\/api\/games(?:\/|$)/.test(path) || path.endsWith("/control")) {
    const response = await nativeFetch(input, init);
    const game = path.match(/^\/api\/games\/([^/?]+)/)?.[1];
    const revision = response.headers.get("x-gaffer-revision");
    if (game && revision !== null) revisions.set(game, Number(revision));
    return response;
  }
  const storageKey = await receiptKey(path, init?.body);
  let receipt: Receipt | null;
  try {
    receipt = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Receipt | null;
  } catch {
    receipt = null;
  }
  if (receipt && (!receipt.createdAt || Date.now() - receipt.createdAt > 15 * 60 * 1000))
    receipt = null;
  receipt ??= { key: crypto.randomUUID(), createdAt: Date.now() };
  localStorage.setItem(storageKey, JSON.stringify(receipt));
  const headers = new Headers(init?.headers);
  headers.set("Idempotency-Key", receipt.key);
  const match = path.match(/^\/api\/games\/([^/]+)\/match\//);
  if (match && !match[1]!.startsWith("lab-")) {
    let control = await takeControl(match[1]!);
    if (
      control.status === 409 &&
      window.confirm("다른 창에서 경기를 진행 중입니다. 이 창에서 이어할까요?")
    )
      control = await takeControl(match[1]!, true);
    if (!control.ok) return control;
    const data = (await control.json()) as { epoch: number };
    headers.set("X-Gaffer-Build", import.meta.env.VITE_SIM_BUILD_ID as string);
    headers.set("X-Gaffer-Client", clientId());
    headers.set("X-Gaffer-Epoch", String(data.epoch));
  }
  let response: Response;
  if (receipt.jobId) response = Response.json({ jobId: receipt.jobId }, { status: 202 });
  else response = await nativeFetch(input, { ...init, headers });
  /*
   * 일반 작업은 사용자당 하나다 — 읽음 표시·자동 저장 같은 앞선 작업이 돌고 있으면 서버가
   * 그 작업을 알려 준다. 그것이 끝나기를 기다렸다가 같은 키로 다시 접수한다 (거절된 접수는
   * 키를 남기지 않는다).
   */
  for (let round = 0; response.status === 409 && round < BUSY_ROUNDS; round++) {
    const busy = (await response
      .clone()
      .json()
      .catch(() => ({}))) as { activeJobId?: unknown };
    if (typeof busy.activeJobId !== "string") break;
    await pollJob(busy.activeJobId, () => {}, init?.signal);
    response = await nativeFetch(input, { ...init, headers });
  }
  if (response.status !== 202) {
    localStorage.removeItem(storageKey);
    return response;
  }
  const accepted = (await response.json()) as { jobId: string; gameId: string };
  receipt.jobId = accepted.jobId;
  receipt.gameId = accepted.gameId;
  localStorage.setItem(storageKey, JSON.stringify(receipt));
  window.dispatchEvent(new Event("gaffer:job-started"));
  const done = () => {
    localStorage.removeItem(storageKey);
    window.dispatchEvent(new Event("gaffer:job-finished"));
  };
  if (path.endsWith("/turn/stream")) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          } catch {
            /* The receipt remains authoritative after disconnect. */
          }
        };
        try {
          const result = await pollJob(accepted.jobId, send, init?.signal);
          const payload: unknown = await result.json();
          send(result.ok ? { type: "done", payload } : { type: "error", ...(payload as object) });
          done();
        } catch {
          send({
            type: "error",
            error: "연결이 끊겼습니다. 같은 작업 결과를 다시 확인해 주세요",
            retry: true,
            settled: false,
          });
        } finally {
          try {
            controller.close();
          } catch {
            /* reader closed */
          }
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  }
  const result = await pollJob(accepted.jobId, () => {}, init?.signal);
  done();
  return result;
}
