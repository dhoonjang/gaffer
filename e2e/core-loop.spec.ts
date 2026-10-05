import { expect, test } from "@playwright/test";

import type { OfficeViews } from "@gaffer/engine";
import { seedMailNegotiation, seedFinishedSeason, seedSellerAgreement } from "./seed";
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

test("메일 스레드와 첨부, 메인 대화의 협상이 같은 장부로 이어진다", async ({ page }) => {
  const fixture = seedMailNegotiation();
  await page.goto(`/game/${fixture.gameId}`);
  const input = page.getByTestId("chat-input");
  await expect(input).toBeVisible({ timeout: COLD_MS });
  const openPanel = async (key: string) => {
    const tab = page.getByTestId(`tab-${key}`);
    if ((await tab.getAttribute("aria-pressed")) === "true") return;
    const menu = page.getByTestId("rail-toggle");
    if (key !== "채팅" && (await menu.isVisible())) {
      if ((await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
      await expect(menu).toHaveAttribute("aria-expanded", "true");
    }
    await tab.click();
    await expect(tab).toHaveAttribute("aria-pressed", "true");
  };
  const readMail = async () => {
    const response = await page.request.get(`/api/games/${fixture.gameId}/mail`, { maxRetries: 1 });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { mail: OfficeViews["mail"] }).mail;
  };
  const readNegotiations = async () => {
    const response = await page.request.get(`/api/games/${fixture.gameId}/negotiation`, {
      maxRetries: 1,
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { negotiation: OfficeViews["negotiation"] }).negotiation;
  };
  await input.fill("메일을 검토한 뒤 훈련을 논의하자");
  await openPanel("메일함");
  await page.getByTestId("mail-compose").click();
  await page.getByTestId("mail-recipient").fill(fixture.targetTeamId);
  await page.getByTestId("mail-subject").fill(`${fixture.targetName} 영입 문의`);
  await page
    .getByTestId("mail-body")
    .fill(`${fixture.targetName} 선수의 이적 협상 의향과 조건을 알려주세요.`);
  await page.getByTestId("mail-send").click();
  await expect.poll(async () => (await readMail()).threads.length).toBe(1);
  let thread = (await readMail()).threads[0]!;
  const threadId = thread.id;
  expect(thread.messages).toHaveLength(1);
  expect(thread.messages[0]!.direction).toBe("outbound");
  await page.getByRole("button", { name: "메일 목록", exact: true }).click();
  await page.getByTestId("mail-compose").click();
  await page.getByTestId("mail-recipient").fill(fixture.targetTeamId);
  await page.getByTestId("mail-subject").fill("문의 보충");
  await page
    .getByTestId("mail-body")
    .fill("아직 구체적인 금액을 제안한 것은 아닙니다. 구단의 입장을 먼저 듣겠습니다.");
  await page.getByTestId("mail-send").click();
  await expect.poll(async () => (await readMail()).threads[0]!.messages.length).toBe(2);
  expect((await readMail()).threads.map((item) => item.id)).toEqual([threadId]);
  await openPanel("채팅");
  await expect(input).toHaveValue("메일을 검토한 뒤 훈련을 논의하자");
  await input.fill("");
  await page.getByTestId("time-skip-toggle").click();
  await page.getByTestId("skip-day").click();
  await expect(input).toBeEnabled({ timeout: COLD_MS });
  await expect
    .poll(
      async () =>
        (await readMail()).threads
          .find((item) => item.id === threadId)!
          .messages.filter((message) => message.direction === "inbound").length,
    )
    .toBe(1);
  thread = (await readMail()).threads.find((item) => item.id === threadId)!;
  const incoming = thread.messages.at(-1)!;
  await openPanel("메일함");
  await page.getByTestId("mail-thread").filter({ hasText: thread.label }).click();
  await page.getByTestId("mail-attach").last().click();
  await expect(page.getByTestId("mail-attachment")).toHaveAttribute("data-message-id", incoming.id);
  await input.fill("첨부한 회신 내용을 확인하고 다음 행동을 정리해줘");
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(`/api/games/${fixture.gameId}/turn/stream`),
  );
  await page.getByTestId("chat-send").click();
  expect((await sent).postDataJSON().mailMessageIds).toEqual([incoming.id]);
  await expect(input).toBeEnabled();
  await expect(page.getByTestId("mail-attachment")).toHaveCount(0);
  expect(
    (await readMail()).threads
      .find((item) => item.id === threadId)!
      .messages.filter((message) => message.direction === "inbound"),
  ).toHaveLength(1);

  await openPanel("채팅");
  await input.fill("테스트 재계약 협상");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("tool-start_negotiation")).toBeVisible();
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(page.getByTestId("negotiation-input")).toHaveCount(0);
  await input.fill("테스트 재계약 조건 제안");
  await page.getByTestId("chat-send").click();
  const confirmation = page.getByTestId("negotiation-confirmation").last();
  await expect(
    confirmation.getByRole("button", { name: "조건 확인 후 합의", exact: true }),
  ).toBeVisible();
  await confirmation.getByRole("button", { name: "조건 확인 후 합의", exact: true }).click();
  const ready = (await readNegotiations()).cases.find((item) => item.playerId === fixture.ownId)!;
  expect(ready.signed).toBeNull();
  await input.fill("테스트 재계약 최종 확인");
  await page.getByTestId("chat-send").click();
  await confirmation.getByRole("button", { name: "최종 서명", exact: true }).click();
  await expect
    .poll(async () => (await readNegotiations()).cases.find((item) => item.id === ready.id)?.status)
    .toBe("completed");
  await page.reload();
  expect((await readMail()).threads.find((item) => item.id === threadId)?.messages).toEqual(
    thread.messages,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await openPanel("메일함");
  await page.getByTestId("mail-thread").filter({ hasText: thread.label }).click();
  await page.getByTestId("mail-attach").last().click();
  await expect(input).toBeVisible();
  await expect(page.getByTestId("tab-채팅")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("mail-attachment")).toHaveAttribute("data-message-id", incoming.id);
});

test("매각 감독은 비공개 선수 조건 없이 구단 이적 조건에 합의한다", async ({ page, request }) => {
  const fixture = seedSellerAgreement();
  await page.goto(`/game/${fixture.gameId}`);
  const card = page.getByTestId("negotiation-confirmation");
  await expect(card).toBeVisible({ timeout: COLD_MS });
  const read = async () => {
    const response = await request.get(`/api/games/${fixture.gameId}/negotiation`);
    return (
      (await response.json()) as { negotiation: OfficeViews["negotiation"] }
    ).negotiation.cases.find((n) => n.id === fixture.negotiationId)!;
  };
  expect((await read()).proposals.every((p) => p.terms.scope === "club")).toBe(true);
  const accept = card.getByRole("button", { name: "조건 확인 후 합의", exact: true });
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect
    .poll(async () =>
      (await read()).proposals
        .find((p) => p.id === fixture.clubProposalId)
        ?.acceptedBy.includes(fixture.sellerId),
    )
    .toBe(true);
  expect((await read()).proposals.every((p) => p.terms.scope === "club")).toBe(true);
});
