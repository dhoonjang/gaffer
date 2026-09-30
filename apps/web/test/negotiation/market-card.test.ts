import type { ChatTurn } from "@story-fm/engine";
import { chatForActiveNegotiation } from "../../domains/negotiation/lib/negotiation-chat";
import { describe, expect, it, vi } from "vitest";
import { proposalAttachments, splitMarketCalls } from "../../domains/negotiation/lib/market-calls";

const accepted = {
  kind: "verdict",
  playerId: "player-1",
  playerName: "테스트 선수",
  counterpart: "테스트 구단",
  verdict: "accept",
} as const;

const offered = {
  kind: "offer",
  playerId: "player-2",
  playerName: "마누엘 우가르테",
  counterpart: "아스날",
  terms: { fee: 38_000_000, weeklyWage: 120_000, years: 4 },
} as const;

describe("시장 결과 카드와 칩", () => {
  it("첨부는 바로 앞 발신 메시지에만 연결하고 원본 조건과 다른 응답을 보존한다", () => {
    const input = {
      playerId: "player-2",
      kind: "renew",
      weeklyWage: 100_000,
      years: 4,
      terms: [{ kind: "other", note: "시즌 뒤 조건 재검토" }],
    };
    const proposal = { name: "open_renewal", summary: "", input };
    const reply = { name: "respond_offer", summary: "", payload: accepted };
    const sender: ChatTurn = {
      role: "user",
      text: "이 조건으로 제안합니다",
      at: "2026-07-01",
      toolCalls: [],
    };
    const response: ChatTurn = {
      role: "model",
      text: "",
      at: sender.at,
      toolCalls: [proposal, reply],
    };
    const next: ChatTurn = { ...sender, text: "다시 검토해줘" };
    const chat = [sender, response, next];
    const before = structuredClone(chat);
    const result = proposalAttachments(chat);
    expect(result.byTurn.get(sender)).toEqual(input);
    expect(result.byTurn.has(next)).toBe(false);
    expect([...result.calls]).toEqual([proposal]);
    expect(chat).toEqual(before);
    expect(proposalAttachments([response]).calls.size).toBe(0);
  });

  it("제안서만 보낸 경우와 전송 중인 경우도 원본을 표시하고 일반 GM 호출은 제외한다", () => {
    const input = { playerId: "player-2", kind: "personal", weeklyWage: 100_000, years: 4 };
    const call = { name: "propose_personal", summary: "", input };
    const sender: ChatTurn = { role: "operator", text: "", at: "2026-07-01", toolCalls: [] };
    const response: ChatTurn = { ...sender, role: "model", toolCalls: [call] };
    expect(proposalAttachments([sender, response]).byTurn.get(sender)).toEqual(input);
    const pending = { ...sender, toolCalls: [call] };
    expect(proposalAttachments([pending]).byTurn.get(pending)).toEqual(input);
    response.toolCalls = [
      { ...call, input: { playerId: input.playerId, weeklyWage: 110_000, years: 4 } },
    ];
    expect(proposalAttachments([sender, response]).calls.size).toBe(0);
    response.toolCalls = [{ ...call, name: "another_command" }];
    expect(proposalAttachments([sender, response]).calls.size).toBe(0);
  });
  it("제안 수락 카드가 있어도 계약 확정 결과는 숨기지 않는다", () => {
    const result = splitMarketCalls([
      { name: "respond_offer", payload: accepted },
      { name: "accept_deal" },
    ]);

    expect(result.cards).toEqual([accepted]);
    expect(result.chips).toEqual([{ name: "accept_deal" }]);
  });

  it("수락 카드 없이 실행된 계약 확정은 칩으로 남긴다", () => {
    const call = { name: "accept_deal" };
    expect(splitMarketCalls([call])).toEqual({ cards: [], chips: [call] });
  });

  it("거절 카드 옆의 다른 결과 칩은 숨기지 않는다", () => {
    const rejected = { ...accepted, verdict: "reject" as const };
    const call = { name: "set_transfer_list" };
    expect(splitMarketCalls([{ name: "respond_offer", payload: rejected }, call])).toEqual({
      cards: [rejected],
      chips: [call],
    });
  });

  it("내보내는 오퍼도 카드로 선다 — 칩은 서지 않는다", () => {
    expect(splitMarketCalls([{ name: "send_offer", payload: offered }])).toEqual({
      cards: [offered],
      chips: [],
    });
  });

  /**
   * 가르는 기준은 **호출 이름**이다. 모양으로 가르던 때는 카드를 실어야 할 호출이
   * payload를 빠뜨려도 그냥 칩이 되어 화면이 코어의 누락을 감췄다.
   */
  it("카드 호출은 payload가 성하지 않으면 어느 쪽에도 서지 않고 콘솔에 남는다", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const call = { name: "send_offer", summary: "아스날에 매각을 제안했습니다" };

    expect(splitMarketCalls([call])).toEqual({ cards: [], chips: [] });
    expect(error).toHaveBeenCalled();

    error.mockRestore();
  });

  it("모양이 깨진 카드도 칩으로 흘리지 않는다", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // counterpart가 없다 — 코어 계약(MarketCommandResult)이 깨진 경우
    const call = { name: "send_offer", payload: { kind: "offer", playerName: "누구" } };

    expect(splitMarketCalls([call])).toEqual({ cards: [], chips: [] });
    expect(error).toHaveBeenCalled();

    error.mockRestore();
  });
});

describe("상대별 협상 이력", () => {
  it("같은 상대의 여러 거래는 잇고, 같은 거래의 다른 상대는 제외한다", () => {
    const turns: ChatTurn[] = [
      {
        role: "user",
        text: "첫 거래",
        at: "2026-07-01",
        toolCalls: [],
        inNegotiation: true,
        negotiationId: "deal-a",
        negotiationContactId: "club",
      },
      {
        role: "model",
        text: "개인 조건",
        at: "2026-07-01",
        toolCalls: [],
        inNegotiation: true,
        negotiationId: "deal-a",
        negotiationContactId: "agent",
      },
      {
        role: "user",
        text: "다른 선수",
        at: "2026-07-02",
        toolCalls: [],
        inNegotiation: true,
        negotiationId: "deal-b",
        negotiationContactId: "club",
      },
      { role: "model", text: "일상", at: "2026-07-02", toolCalls: [] },
    ];
    expect(chatForActiveNegotiation(turns, "club")).toEqual([turns[0], turns[2]]);
    expect(chatForActiveNegotiation(turns, null)).toBe(turns);
  });
});
