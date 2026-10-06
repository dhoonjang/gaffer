import { defineConfig } from "vitest/config";

/**
 * 밸런스 하네스 전용 — `pnpm balance`가 쓴다 (→ `docs/balance-harness.md`).
 *
 * ⚠️ 이 설정의 `include`와 `vitest.config.ts`의 것은 **겹치지 않는다.** 하네스가
 * 테스트 디렉터리 아래로 들어가는 순간 `pnpm test`가 다시 걷고, 그러면 케이스를
 * 건너뛰어도 파일당 모듈 그래프 값(2.2초)을 CI가 계속 낸다 (AGENTS.md 5장).
 */
export default defineConfig({
  test: {
    include: ["packages/*/harness/**/*.harness.ts"],
    // 한 케이스가 세계 하나로 시즌을 돌고, 감독의 경기를 실시간으로 치르는 하네스는 한 판에
    // 20초 남짓을 문다 — 실시간 경기 백여 판(전술 팔 다섯 · 두 시즌의 상대 벤치)이 다른
    // 파일과 코어를 나누면 40분을 넘긴다. 멈춘 것을 끊는 자리지 속도를 재는 자리가 아니다
    // (balance-harness.md §6). 주간 실행의 시한은 `--deadline`이 따로 쥔다.
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    reporters: ["verbose"],
  },
});
