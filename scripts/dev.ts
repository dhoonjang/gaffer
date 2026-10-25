import { existsSync } from "node:fs";
import { resolve } from "node:path";
for (const file of [".env.local", "apps/web/.env.local"]) {
  const path = resolve(file);
  if (existsSync(path)) process.loadEnvFile(path);
}
import { spawn } from "node:child_process";
const port = Number(process.env.PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? port + 1);
const env = {
  ...process.env,
  GAFFER_MODE: "local",
  // 로컬은 Google 없이 바로 들어간다 — 실제 로그인을 볼 때만 GAFFER_AUTH_MODE=google
  GAFFER_AUTH_MODE: process.env.GAFFER_AUTH_MODE ?? "development",
  APP_ORIGIN: `http://localhost:${port}`,
  API_ORIGIN: `http://127.0.0.1:${apiPort}`,
};
const children = [
  spawn("pnpm", ["--filter", "@gaffer/api", "dev"], {
    stdio: "inherit",
    env: { ...env, PORT: String(apiPort) },
  }),
  spawn("pnpm", ["--filter", "@gaffer/web", "dev"], {
    stdio: "inherit",
    env: { ...env, WEB_PORT: String(port) },
  }),
];
function stop() {
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children)
  child.on("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
