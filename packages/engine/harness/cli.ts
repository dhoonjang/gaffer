import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { HARNESSES } from "./catalog";
import { listing } from "./harness";
import { prepareReportDir, writeReport, SUMMARY_FILE } from "./report";

/**
 * `pnpm balance` — 밸런스 하네스를 돌리거나(인자 없이·파일 이름으로 걸러) 목록만 본다.
 *
 * `--list`는 세계를 세우지 않는다. 밸런스 손잡이를 옮긴 뒤 **무엇을 돌려야 하는가**를
 * 고르는 자리라, 몇 분을 쓰기 전에 한 화면을 먼저 준다.
 *
 * `--report <디렉터리>`는 측정값을 파일로도 남긴다 — 주간 워크플로가 읽는 자리다
 * (→ `docs/balance-harness.md` §5).
 *
 * `--deadline <분>`은 그 시간에 하네스를 끊고 **그때까지 온 측정값으로 리포트를 세운다.**
 * 잡의 시한에 통째로 죽으면 리포트도 이슈도 서지 않아 「아무것도 보고하지 않았다」가
 * 조용히 몇 주를 산다. 끊긴 하네스는 리포트에 `missing`으로 선다.
 */
function valueOf(flag: string): { at: number; value: string | undefined } {
  const at = args.indexOf(flag);
  const value = at >= 0 ? args[at + 1] : undefined;
  return { at, value: value === undefined || value.startsWith("-") ? undefined : value };
}

const args = process.argv.slice(2);

if (args.includes("--list")) {
  process.stdout.write(`${listing(HARNESSES)}\n`);
} else {
  const { at, value: dir } = valueOf("--report");
  const deadline = valueOf("--deadline");
  const minutes = deadline.value === undefined ? undefined : Number(deadline.value);
  if (at >= 0 && dir === undefined) {
    process.stderr.write("--report 뒤에 디렉터리를 적어라 (예: --report balance-report)\n");
    process.exitCode = 2;
  } else if (deadline.at >= 0 && !(minutes !== undefined && minutes > 0)) {
    process.stderr.write("--deadline 뒤에 분을 적어라 (예: --deadline 100)\n");
    process.exitCode = 2;
  } else {
    // 걸러 돌릴 파일 이름만 vitest에 넘긴다 — 우리 플래그와 그 값은 빼고
    const ours = new Set([at, deadline.at].filter((i) => i >= 0).flatMap((i) => [i, i + 1]));
    const filters = args.filter((_, i) => !ours.has(i));
    const reportDir = dir === undefined ? undefined : resolve(dir);
    const env = { ...process.env };
    if (reportDir !== undefined) env.BALANCE_REPORT = prepareReportDir(reportDir);

    // 프로세스 묶음을 따로 세운다 — 시한에 끊을 때 pnpm만 죽이면 vitest 워커가 남아 돈다
    const child = spawn(
      "pnpm",
      ["exec", "vitest", "run", "--config", "vitest.balance.config.ts", ...filters],
      { stdio: "inherit", env, detached: true },
    );
    // 콜백이 세우는 표식 — 흐름 분석이 지역 변수의 재할당을 따라가지 못해 객체에 둔다
    const deadlineHit: { value: boolean } = { value: false };
    const timer =
      minutes === undefined
        ? undefined
        : setTimeout(() => {
            deadlineHit.value = true;
            process.kill(-child.pid!, "SIGKILL");
          }, minutes * 60_000);
    const status = await new Promise<number | null>((done) => child.on("exit", done));
    clearTimeout(timer);
    if (deadlineHit.value) {
      process.stdout.write(
        `\n[balance] ${minutes}분 시한에 끊었다 — 그때까지 온 측정값으로 리포트를 세운다\n`,
      );
    }

    if (reportDir !== undefined) {
      // 하네스가 빨갛게 끝나도 리포트는 남긴다 — 이탈을 읽으려고 돌린 것이다
      const { breaches, reported } = writeReport(reportDir, filters.length === 0);
      process.stdout.write(
        `\n[balance] 하네스 ${reported}개 보고 · 이탈 ${breaches.length}건 → ${resolve(reportDir, SUMMARY_FILE)}\n`,
      );
    }
    process.exitCode = deadlineHit.value ? 1 : (status ?? 1);
  }
}
