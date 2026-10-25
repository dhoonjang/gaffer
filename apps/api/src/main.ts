import { LLM_CONFIG, hasKey } from "@gaffer/llm";
import { initializeTelemetry, reportFailure } from "./telemetry";
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import express from "express";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { z } from "zod";
import { configuration, HttpError } from "./config";
import { database } from "./database";
import { objectStore } from "./objects";
import { Service } from "./service";
// Nest requires a module class as its dependency-injection root.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module metadata attaches to this class.
class AppModule {}
Module({})(AppModule);
const c = configuration();
initializeTelemetry();
// Raw model traces contain user prose. Production never writes the local developer trace store.
if (c.GAFFER_MODE === "production") {
  process.env.NODE_ENV = "production";
  process.env.LLM_MODE = "real";
}
const db = await database(c);
const service = new Service(c, db, objectStore(c));
await service.usage.init();
if (c.GAFFER_MODE === "production") {
  service.usage.validateConfiguredModels();
  if (c.SERVICE_ROLE === "worker")
    for (const agent of [
      ...Object.values(LLM_CONFIG.agents),
      ...Object.values(LLM_CONFIG.evaluators),
    ]) {
      if (
        !(agent.provider === "typesafe"
          ? process.env.TYPESAFE_API_KEY?.trim()
          : hasKey(agent.provider))
      )
        throw new Error(`Missing provider credential: ${agent.provider}`);
    }
}
const app = await NestFactory.create(AppModule, { logger: ["error", "warn"], bodyParser: false });
app.use((_req: ExpressRequest, res: ExpressResponse, next: () => void) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.json({ limit: "256kb" }));
app.use(async (req: ExpressRequest, res: ExpressResponse) => {
  const requestId = crypto.randomUUID();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    }
    headers.set("x-request-id", requestId);
    const request = new Request(new URL(req.originalUrl, c.APP_ORIGIN), {
      method: req.method,
      headers,
      ...(["GET", "HEAD"].includes(req.method) ? {} : { body: JSON.stringify(req.body ?? {}) }),
    });
    const response = await service.handle(request);
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") res.setHeader(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader("Set-Cookie", cookies);
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const status =
      error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
    res.status(status).json({
      // A Zod message is the raw issue JSON — it never reaches the client.
      error:
        status === 500
          ? "서버 요청에 실패했습니다"
          : error instanceof HttpError
            ? error.message
            : "잘못된 요청입니다",
      ...(error instanceof HttpError ? error.detail : {}),
      requestId,
    });
    console.error(JSON.stringify({ event: "request_failed", requestId, status }));
    if (status === 500) await reportFailure(requestId, error);
  }
});
app.use(
  (
    error: unknown,
    _req: ExpressRequest,
    res: ExpressResponse,
    _next: (error?: unknown) => void,
  ) => {
    void _next;
    res.status(400).json({ error: "올바르지 않은 요청 본문입니다" });
    void error;
  },
);
let busy = false;
// Started jobs are not awaited here: one slow turn must not hold the next queued job
// behind it while a slot is free.
const started = new Set<string>();
const timer =
  c.GAFFER_MODE === "local"
    ? setInterval(() => {
        if (busy) return;
        busy = true;
        void (async () => {
          await service.jobs.recover();
          const free = service.runner.free();
          if (!free) return;
          const rows = await db.query<{ id: string }>(
            "SELECT id FROM private.jobs WHERE status='queued' AND id IN (SELECT job_id FROM private.outbox WHERE next_at<=now()) ORDER BY (path='/internal/lorebook'),created_at LIMIT $1",
            [free + started.size],
          );
          for (const { id } of rows.filter((row) => !started.has(row.id)).slice(0, free)) {
            started.add(id);
            void service.runner
              .job(id)
              .catch(() => console.error(JSON.stringify({ event: "local_dispatch_failed" })))
              .finally(() => started.delete(id));
          }
        })()
          .catch(() => console.error(JSON.stringify({ event: "local_dispatch_failed" })))
          .finally(() => {
            busy = false;
          });
      }, 500)
    : undefined;
await app.listen(c.PORT, c.GAFFER_MODE === "local" ? "127.0.0.1" : "0.0.0.0");
console.info(
  JSON.stringify({ event: "listening", role: c.SERVICE_ROLE, port: c.PORT, mode: c.GAFFER_MODE }),
);
async function close() {
  if (timer) clearInterval(timer);
  await app.close();
  await db.close();
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
