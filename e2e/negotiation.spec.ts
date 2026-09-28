import { expect, test } from "@playwright/test";
import { loadGame } from "@story-fm/engine";
import { seedTransferTarget } from "./seed";
import { COLD_MS } from "./timeouts";

// The mock evaluates to review. This test verifies routing and durable contact history, not a price oracle.
test("같은 상대와 대면·통화·제안서를 이어도 기록과 거래가 유지된다", async ({ page }) => {
  const { gameId, targetName } = seedTransferTarget();
  await page.goto(`/game/${gameId}`);
  const input = page.getByTestId("chat-input");
  await expect(input).toBeEnabled({ timeout: COLD_MS });
  const gate = page.getByTestId("negotiation-gate");
  const room = page.getByTestId("negotiation-room");
  for (const method of ["meeting", "phone", "proposal"]) {
    await input.fill(`${targetName} 협상하자`);
    await page.getByTestId("chat-send").click();
    await expect(gate).toBeVisible();
    await gate.getByLabel("연락 방식").selectOption(method);
    await page.getByTestId("negotiation-enter").click();
    await expect(room).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(page.getByTestId("time-skip-toggle")).toBeDisabled();
    await input.fill(`조건을 먼저 들어 보고 싶습니다 (${method})`);
    await page.getByTestId("chat-send").click();
    await expect(input).toBeEnabled();
    await page.getByTestId("negotiation-propose").click();
    const form = page.getByTestId("proposal-form");
    await expect(form.getByTestId("proposal-club")).toBeVisible();
    await expect(form.getByTestId("proposal-agent")).toHaveCount(0);
    await expect(form.getByTestId("proposal-submit")).toBeDisabled();
    await form.getByRole("button", { name: "닫기" }).click();
    await page.getByTestId("negotiation-leave").click();
    await expect(page.locator(".app")).toHaveAttribute("data-phase", "idle");
    await expect(input).toBeEnabled();
    await page.reload();
    await expect(input).toBeEnabled();
  }
  const saved = loadGame(gameId)!;
  expect(saved.negotiations).toHaveLength(1);
  expect(saved.negotiationContacts).toHaveLength(1);
  const contacts = new Set(saved.negotiationExchanges.map((exchange) => exchange.contactId));
  expect(contacts.size).toBe(1);
  expect(saved.negotiationExchanges.map((exchange) => exchange.method)).toEqual([
    "meeting",
    "phone",
    "proposal",
  ]);
  expect(
    saved.negotiationContacts[0]!.lines.filter((line) => line.by === "us")
      .map((line) => line.text)
      .join("\n"),
  ).toContain("조건을 먼저 들어 보고 싶습니다");
  expect(saved.negotiations[0]!.rounds).toHaveLength(0);
  expect(saved.negotiations[0]!.status).toBe("open");
});
