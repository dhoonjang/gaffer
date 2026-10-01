import { expect, test } from "@playwright/test";

import { seedFinishedSeason } from "./seed";
import { COLD_MS } from "./timeouts";

/**
 * 핵심 루프의 **뒷걸음** — 시즌 전환.
 *
 * 나머지 스펙은 부임에서 시작해 화면을 밟아 나가지만, 시즌 전환은 그 앞을 다 지나야
 * 닿는다: 유저 경기 쉰 번 뒤에 있다.
 * 그 앞부분을 브라우저로 다시 걷는 것은 CI가 낼 수 없는 값이라, **닿기까지는
 * 코어가 걷고 재려는 그 한 걸음만 브라우저가 밟는다** (`e2e/seed.ts`).
 */

test("시즌 마지막 경기 뒤 하루를 넘기면 새 시즌이 선다", async ({ page }) => {
  const gameId = seedFinishedSeason();
  await page.goto(`/game/${gameId}`);

  const date = page.getByTestId("game-date");
  await expect(date).toBeVisible({ timeout: COLD_MS });
  const lastDay = (await date.textContent())!.trim();

  // 지난 시즌은 38라운드를 다 치렀다 — 넘길 것이 남아 있지 않다
  await page.getByTestId("tab-대회").click();
  const played = page.getByTestId("standings").locator("tr.me").getByTestId("standing-played");
  await expect(played).toHaveText("38");
  const fixtures = page.getByTestId("round-fixtures").locator(".fixture");
  await page.getByTestId("round-select").selectOption({ index: 0 });
  await expect(fixtures.locator(".mid.played")).toHaveCount(10);

  /*
   * 손잡이 한 번 — 남은 경기가 없으므로 코어가 그 자리에서 시즌을 넘긴다.
   * 갈 경기가 없으니 **"다음 경기" 눈금은 서지 않는다** (composer.tsx).
   */
  await page.getByTestId("tab-채팅").click();
  await page.getByTestId("time-skip-toggle").click();
  await expect(page.getByTestId("time-skip")).toBeVisible();
  await expect(page.getByTestId("skip-match")).toHaveCount(0);
  await page.getByTestId("skip-day").click();
  await expect(page.getByTestId("chat-input")).toBeEnabled({ timeout: COLD_MS });
  await expect(date).not.toHaveText(lastDay);

  // 새 시즌 — 순위표도 일정도 처음부터 다시 선다 (같은 20팀, 같은 라운드 열 경기)
  await page.getByTestId("tab-대회").click();
  await expect(played).toHaveText("0");
  await page.getByTestId("round-select").selectOption({ index: 0 });
  await expect(fixtures).toHaveCount(10);
  await expect(fixtures.locator(".mid.played")).toHaveCount(0);
  await expect(page.getByTestId("round-fixtures").locator(".fixture.ours")).toHaveCount(1);

  // 달력도 새 시즌 것으로 갈렸다 — 지난 시즌의 경기가 한 칸도 남지 않는다
  await page.getByTestId("tab-달력").click();
  await expect(page.getByTestId("view-calendar")).toContainText("시즌 일정");
  await expect(page.locator('[data-testid^="cal-fixture-"]').first()).toBeVisible();
});
