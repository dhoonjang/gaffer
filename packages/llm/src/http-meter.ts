import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export interface HttpAttempt {
  agent?: string;
  callId?: string;
  provider: string;
  model: string;
  inputBound: number;
  outputBound: number;
}
export interface HttpUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface HttpMeter {
  reserve(attempt: HttpAttempt): Promise<string>;
  settle(id: string, usage: HttpUsage | null): Promise<void>;
  capture?(id: string, request: string, response: string): Promise<void>;
}
const call = new AsyncLocalStorage<{ agent: string; callId: string }>();
export const withHttpAgent = <T>(agent: string, fn: () => T): T =>
  call.run({ agent, callId: randomUUID() }, fn);
const scope = new AsyncLocalStorage<HttpMeter>();
export const withHttpMeter = <T>(meter: HttpMeter, fn: () => T): T => scope.run(meter, fn);
const baseFetch = globalThis.fetch;
function usageOf(provider: string, value: unknown): HttpUsage | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const nested = (obj.response ?? obj.message ?? obj) as Record<string, unknown>;
  const usage = (nested.usageMetadata ?? nested.usage) as Record<string, unknown> | undefined;
  if (!usage) return null;
  const n = (key: string) => (typeof usage[key] === "number" ? usage[key] : 0);
  if (provider === "google")
    return {
      inputTokens: n("promptTokenCount"),
      outputTokens: n("candidatesTokenCount") + n("thoughtsTokenCount"),
    };
  return {
    inputTokens:
      n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens"),
    outputTokens: n("output_tokens"),
  };
}
export const meteredFetch: typeof fetch = async (input, init) => {
  const transport = globalThis.fetch === meteredFetch ? baseFetch : globalThis.fetch;
  const meter = scope.getStore();
  if (!meter) return transport(input, init);
  const request = new Request(input, init);
  const url = new URL(request.url);
  const provider =
    url.hostname === "api.anthropic.com"
      ? "anthropic"
      : url.hostname === "api.openai.com"
        ? "openai"
        : url.hostname === "generativelanguage.googleapis.com"
          ? "google"
          : url.hostname === "api.typesafe.ai"
            ? "typesafe"
            : null;
  if (!provider) return transport(request);
  const text = await request.clone().text();
  const body = JSON.parse(text) as Record<string, unknown>;
  const generation = body.generationConfig as Record<string, unknown> | undefined;
  const max =
    provider === "typesafe"
      ? 0
      : (body.max_tokens ?? body.max_output_tokens ?? generation?.maxOutputTokens);
  const model =
    typeof body.model === "string"
      ? body.model
      : (url.pathname.match(/models\/([^:]+)/)?.[1] ?? "");
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 0)
    throw new Error("An output limit is required for metering");
  const id = await meter.reserve({
    ...call.getStore(),
    provider,
    model,
    inputBound: Buffer.byteLength(text),
    outputBound: max,
  });
  let response: Response;
  try {
    response = await transport(request);
  } catch (e) {
    await meter.settle(id, null);
    throw e;
  }
  // Authentication, validation and rate-limit rejections occur before generation.
  if ([400, 401, 403, 404, 413, 422, 429].includes(response.status)) {
    await meter.settle(id, { inputTokens: 0, outputTokens: 0 });
    return response;
  }
  if (!response.body) {
    await meter.settle(id, null);
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: HttpUsage | null = null;
  let diagnostic = "";
  const accept = (line: string) => {
    try {
      const value = JSON.parse(line.replace(/^data:\s*/, "")) as unknown;
      const next = usageOf(provider, value);
      if (next)
        usage = {
          inputTokens: Math.max(usage?.inputTokens ?? 0, next.inputTokens),
          outputTokens: Math.max(usage?.outputTokens ?? 0, next.outputTokens),
        };
    } catch {
      /* SSE control lines carry no usage. */
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = (await reader.read()) as
          { done: true; value: undefined } | { done: false; value: Uint8Array };
        if (next.done) {
          accept(buffer);
          await meter.settle(id, usage);
          if (meter.capture)
            await meter.capture(id, text.slice(0, 131072), diagnostic).catch(() => {});
          controller.close();
          return;
        }
        const chunk = decoder.decode(next.value, { stream: true });
        buffer += chunk;
        if (meter.capture && diagnostic.length < 131072)
          diagnostic = (diagnostic + chunk).slice(0, 131072);
        if (response.headers.get("content-type")?.includes("text/event-stream")) {
          let at: number;
          while ((at = buffer.indexOf("\n")) >= 0) {
            accept(buffer.slice(0, at));
            buffer = buffer.slice(at + 1);
          }
        }
        if (buffer.length > 16 * 1024 * 1024)
          throw new Error("Provider response exceeds metering limit");
        controller.enqueue(next.value);
      } catch (e) {
        await meter.settle(id, null);
        controller.error(e);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await meter.settle(id, null);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
