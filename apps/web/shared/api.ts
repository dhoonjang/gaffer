const nativeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
interface Receipt {
  key: string;
  createdAt: number;
  jobId?: string;
  gameId?: string;
}
/** 작업 스트림의 마지막 `end` 이벤트 — 결과가 있으면 그것이 답이다 */
interface JobEnd {
  status: string;
  gameId: string;
  revision: number | null;
  result: { status: number; body: unknown } | null;
  error: string | null;
}
interface Frame {
  event: string;
  data: string;
  id: string;
}
const revisions = new Map<string, number>();
/** 앞선 작업을 기다렸다가 다시 접수하는 횟수 — 그 사이 또 다른 작업이 끼어드는 일까지 받는다 */
const BUSY_ROUNDS = 3;
/** 아무것도 받지 못한 채 끊긴 연결을 다시 여는 횟수와 그 사이 간격 */
const RECONNECT_TRIES = 5;
const RECONNECT_MS = 1000;
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
/** text/event-stream을 프레임 단위로 넘긴다. 주석 줄(하트비트)은 `ping`이다. */
async function readFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: Frame) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const frame: Frame = { event: "message", data: "", id: "" };
      const data: string[] = [];
      for (const line of buffer.slice(0, at).split("\n")) {
        if (line.startsWith(":")) {
          frame.event = "ping";
          continue;
        }
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const text = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") frame.event = text;
        else if (field === "id") frame.id = text;
        else if (field === "data") data.push(text);
      }
      buffer = buffer.slice(at + 2);
      frame.data = data.join("\n");
      onFrame(frame);
    }
  }
}
function finished(end: JobEnd): Response {
  if (end.result) {
    if (end.revision !== null) revisions.set(end.gameId, end.revision);
    return Response.json(end.result.body, { status: end.result.status });
  }
  if (end.status === "succeeded")
    return Response.json(
      {
        error: "이전 작업은 완료되었습니다. 게임을 다시 열어 최신 상태를 확인해 주세요",
        completed: true,
      },
      { status: 410 },
    );
  return Response.json({ error: end.error ?? "작업이 완료되지 않았습니다" }, { status: 409 });
}
/**
 * 작업을 SSE로 따라가 결과를 돌려준다. 서버는 일정 시간마다 연결을 닫으므로 마지막 seq부터
 * 다시 붙고, 아무것도 받지 못한 채 끊기는 일이 거듭될 때만 포기한다. 한 줄에 들지 않아
 * `part`로 나뉘어 온 이벤트는 마지막 조각에서 이어 붙여 하나로 넘긴다.
 */
export async function followJob(
  id: string,
  onEvent: (body: { type: string; text?: string }) => void = () => {},
  signal?: AbortSignal | null,
): Promise<Response> {
  let seq = 0;
  let parts = "";
  for (let failures = 0; ;) {
    // 프레임 콜백이 채운다 — 흐름 분석이 콜백 안의 대입을 보지 못해 객체에 담는다
    const round: { end: JobEnd | null; received: boolean } = { end: null, received: false };
    try {
      const res = await nativeFetch(`/api/jobs/${id}/events?after=${seq}`, {
        headers: { Accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      });
      if (!res.ok || !res.body) return res;
      await readFrames(res.body, (frame) => {
        round.received = true;
        if (frame.event === "end") round.end = JSON.parse(frame.data) as JobEnd;
        else if (frame.event === "job") {
          seq = Number(frame.id);
          const body = JSON.parse(frame.data) as { type: string; data?: string; last?: boolean };
          if (body.type !== "part") onEvent(body);
          else {
            parts += body.data ?? "";
            if (body.last) {
              const whole = parts;
              parts = "";
              onEvent(JSON.parse(whole) as { type: string });
            }
          }
        } else if (frame.event === "ping") onEvent({ type: "ping" });
      });
    } catch (error) {
      if (signal?.aborted || failures + 1 > RECONNECT_TRIES) throw error;
    }
    if (round.end) return finished(round.end);
    if (round.received) failures = 0;
    else if (++failures > RECONNECT_TRIES) throw new Error("작업 스트림이 거듭 끊겼습니다");
    else await pause(RECONNECT_MS, signal);
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
    await followJob(busy.activeJobId, () => {}, init?.signal);
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
  // 새 게임도 턴처럼 흐른다 — 첫 장면이 닿는 순간 화면이 넘어간다 (game/turn-stream.ts)
  if (path.endsWith("/turn/stream") || path === "/api/games") {
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
          const result = await followJob(accepted.jobId, send, init?.signal);
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
  const result = await followJob(accepted.jobId, () => {}, init?.signal);
  done();
  return result;
}
