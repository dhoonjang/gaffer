import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
for (const file of [".env.local", "apps/web/.env.local"]) {
  const path = resolve(file);
  if (existsSync(path)) process.loadEnvFile(path);
}
import { spawn, type ChildProcess } from "node:child_process";
const port = Number(process.env.PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? port + 1);
const env = {
  ...process.env,
  GAFFER_MODE: "local",
  // 로컬은 Google 없이 바로 들어간다 — 실제 로그인을 볼 때만 GAFFER_AUTH_MODE=google
  GAFFER_AUTH_MODE: process.env.GAFFER_AUTH_MODE ?? "development",
  // 개발 기록은 `pnpm log`가 읽는 창고 하나에 쌓는다 — API의 cwd(apps/api)에 두면 갈라진다
  GAFFER_LOG_DIR: process.env.GAFFER_LOG_DIR ?? resolve("apps/web/.log"),
  APP_ORIGIN: `http://localhost:${port}`,
  API_ORIGIN: `http://127.0.0.1:${apiPort}`,
};
/** API가 답하는지 다시 물어보는 간격 */
const READY_POLL_MS = 250;
const children: ChildProcess[] = [];
function stop() {
  for (const child of children) child.kill("SIGTERM");
}
function track(child: ChildProcess) {
  children.push(child);
  child.on("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const api = spawn("pnpm", ["--filter", "@gaffer/api", "dev"], {
  stdio: "inherit",
  env: { ...env, PORT: String(apiPort) },
});
track(api);
/**
 * 화면 포트는 API가 답한 뒤에 연다 — 먼저 열면 첫 요청이 아직 없는 API로 프록시되어
 * 거절당한다(e2e는 화면 포트가 서는 순간을 준비 완료로 읽는다).
 */
async function apiReady(): Promise<boolean> {
  while (api.exitCode === null && api.signalCode === null) {
    try {
      if ((await fetch(`${env.API_ORIGIN}/health`)).ok) return true;
    } catch {
      // 아직 듣고 있지 않다
    }
    await pause(READY_POLL_MS);
  }
  return false;
}
if (await apiReady())
  track(
    spawn("pnpm", ["--filter", "@gaffer/web", "dev"], {
      stdio: "inherit",
      env: { ...env, WEB_PORT: String(port) },
    }),
  );
