import {
  BUYBACK_MARKUP,
  DealTermSchema,
  ProposalInputSchema,
  isPlayerDeal,
  naturalPositionOf,
  positionGroupOf,
  sellOnAmountOf,
  type MarketCard,
  type Negotiation,
} from "@story-fm/domain";
import type { GameState } from "@story-fm/engine";
import {
  acceptDeal,
  acceptTableTerms,
  activeContract,
  addDays,
  answerIncomingOffer,
  answerPersonal,
  applyProposal,
  askingPriceFor,
  buildOfficeViews,
  contractUntil,
  describeNegotiation,
  describeNegotiations,
  exerciseBuyBack,
  expireNegotiations,
  expiringContracts,
  financeOf,
  incomingOffer,
  isClubTeam,
  LOAN_FEE_RATE,
  loanPlayer,
  marketValueOf,
  offerPlayerOut,
  offerTerms,
  openNegotiationFor,
  openRelease,
  openRenewal,
  openTalks,
  ourBuyBackRights,
  pendingOffer,
  pendingVerdicts,
  playerById,
  playersOf,
  precontractStartOf,
  proposalViewOf,
  proposePersonal,
  recallLoan,
  releasePlayer,
  renewalExpectation,
  respondOffer,
  sendOffer,
  settleEscalators,
  settlePointsBonus,
  setTransferList,
  severanceOf,
  teamName,
  teamNameIn,
  unilateralSeveranceOf,
  USER_WAGE_HEADROOM,
  userPlayers,
  validateDeal,
  wageExpectationOf,
  wageRoomOf,
  weeklyWagesOf,
  withdrawOffer,
} from "@story-fm/engine";
import { describe, expect, it } from "vitest";
import { completeDeal, createTestGame } from "../helpers";

/**
 * 이적 협상 — 오퍼 → 상대 판정 → 합의 → 실행.
 *
 * 판정은 LLM이 하므로 여기서는 **코어가 무엇을 막는지**를 고정한다.
 * (미리 답하기·확률 바닥 수락·터무니없는 조정·결렬 후 재오퍼·예산 초과)
 */

/** 협상 대상 — 우리 팀이 아니고 예산으로 살 수 있는 선수 */
function target(state: GameState) {
  const budget = financeOf(state, state.userTeamId).transferBudget;
  const found = state.players.find((p) => {
    if (p.teamId === state.userTeamId) return false;
    const fee = askingPriceFor(state, p);
    return fee > 1_000_000 && fee < budget * 0.6;
  });
  if (!found) throw new Error("협상 대상을 찾지 못했습니다");
  return found;
}

function offerFor(state: GameState, playerId: string, feeRatio = 1) {
  const player = playerById(state, playerId)!;
  return {
    playerId,
    fee: Math.round(askingPriceFor(state, player) * feeRatio),
    weeklyWage: wageExpectationOf(state, player),
    years: 4,
  };
}

/**
 * 답신이 **하루 이상 걸리는** 대상 — "기다리는 동안"을 재는 케이스가 쓴다.
 *
 * 지연 0일은 버그가 아니라 설계다(`responseDelayDays` — 어떤 전화는 그 자리에서
 * 끝난다). 그래서 `target`이 고른 선수의 답이 그날 오는 것도 정상인데, 그 경우
 * "답을 기다리는 동안 막힌다"를 재는 케이스는 잴 것이 없어진다. 지연은 이적료
 * 해시에서 나오므로 **시장가 눈금이 움직이면 누가 걸리는지도 함께 움직인다** —
 * 한 선수를 못 박지 않고 조건에 맞는 첫 선수를 찾는 이유다.
 */
function waitForIncoming(state: GameState) {
  const player = userPlayers(state).find((p) => !p.loan)!;
  const buyer = state.teams.find(
    (t) => t.id !== state.userTeamId && state.finances.some((f) => f.teamId === t.id),
  )!;
  const n = stagedNegotiation(state, {
    id: `incoming-${state.negotiations.length}`,
    kind: "sell",
    playerId: player.id,
    counterpartTeamId: buyer.id,
    fee: 1_000_000,
    weeklyWage: activeContract(state, player.id)?.weeklyWage ?? 1000,
    status: "open",
  });
  n.rounds[0]!.by = "them";
  n.rounds[0]!.verdict = null;
  return { negotiation: n, digest: [] as string[] };
}

/**
 * **협상을 손으로 세운다** — 합의 뒤를 보는 케이스가 파일 전체에서 공유하는 픽스처.
 *
 * 오퍼 → 답신 → 합의를 세계에 굴려 기다리면 확률·답신 지연·검진이 전부 시드에
 * 걸려, 주사위가 안 나온 날 케이스가 통째로 빠진다. 여기서 재는 것은 그 앞이
 * 아니라 **관문과 장부**라 상태를 직접 세워 넣는 것이 옳다 (코어는 순수 함수다).
 *
 * 기본값은 "창이 열려 있고, 검진은 이미 통과한, 우리가 부른 합의"다.
 */
function stagedNegotiation(
  state: GameState,
  input: {
    id: string;
    kind: Negotiation["kind"];
    playerId: string;
    counterpartTeamId: string;
    fee: number;
    weeklyWage?: number;
    years?: number;
    status?: Negotiation["status"];
    /** 검진 — 기본은 "이미 통과", `null`이면 아직 잡히지 않은 것으로 둔다 */
    medical?: "passed" | "scheduled" | null;
    expiresOn?: string;
    /** 이적창을 30일 열어 둔다 (기본) — 창 자체를 보는 케이스는 끈다 */
    openWindow?: boolean;
    /** 사전 계약인가 — `sendOffer`가 오퍼를 넣는 날 굳히는 값 (transfer.md §1-4) */
    precontract?: boolean;
  },
): Negotiation {
  if (input.openWindow !== false) {
    for (const w of state.windows) w.closesOn = addDays(state.date, 30);
  }
  const negotiation: Negotiation = {
    id: input.id,
    gamePlayerId: input.playerId,
    kind: input.kind,
    counterpartTeamId: input.counterpartTeamId,
    windowId: null,
    openedOn: state.date,
    expiresOn: input.expiresOn ?? addDays(state.date, 10),
    status: input.status ?? "agreed",
    pitched: [],
    terms: [],
    buyout: false,
    precontract: input.precontract ?? false,
    ...(input.medical === null
      ? {}
      : { medical: { onDate: state.date, status: input.medical ?? "passed" } }),
    rounds: [
      {
        date: state.date,
        by: "us",
        fee: input.fee,
        weeklyWage: input.weeklyWage ?? 40_000,
        contractYears: input.years ?? 1,
        respondsOn: null,

        verdict: "accept",
      },
    ],
  };
  state.negotiations.push(negotiation);
  return negotiation;
}

describe("오퍼", () => {
  it("예산을 넘거나 우리 선수면 오퍼가 막힌다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const tooBig = sendOffer(state, { ...offerFor(state, player.id), fee: 900_000_000 });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.message).toContain("예산");

    const ours = playersOf(state, state.userTeamId)[0]!;
    expect(sendOffer(state, offerFor(state, ours.id)).ok).toBe(false);
  });
});

/**
 * **감독은 카탈로그 id를 모른다** (transfer.md §1). 해석기에 실리는 상대 구단은
 * 「첼시」이고, 그것을 조회만 풀면 같은 말이 조회에서는 닿고 명령에서는 말없이
 * 반려된다 — 감독은 자기 매각이 왜 안 나갔는지 읽을 데가 없다.
 */
describe("상대 구단은 이름으로 닿는다", () => {
  it("팀 이름으로 부른 매각 오퍼가 그 구단에 선다", () => {
    const state = createTestGame(42);
    const ours = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[0]!;
    const buyerId = state.players.find((p) => p.teamId !== state.userTeamId)!.teamId;
    const fee = Math.round(marketValueOf(state, ours));

    const missing = offerPlayerOut(state, { playerId: ours.id, teamId: "없는구단", fee });
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("찾지 못했습니다");
    expect(openNegotiationFor(state, ours.id)).toBeNull();

    const byName = offerPlayerOut(state, {
      playerId: ours.id,
      teamId: teamNameIn(state, buyerId),
      fee,
    });
    expect(byName.ok, byName.message).toBe(true);
    expect(openNegotiationFor(state, ours.id)!.counterpartTeamId).toBe(buyerId);
  });
});

describe("상대의 판정 — 코어가 가능한 것만 받는다", () => {
  /**
   * **조정을 받아들이는 말은 `accept_deal` 하나다** (transfer.md §1). 합의 전이라
   * 서명할 것이 없고 `respond_offer`는 우리 오퍼에 온 답을 받지 않으므로, 여기가
   * 막히면 「받아들이겠다」가 어느 명령에도 닿지 않는다.
   */
  it("조정이 선 협상의 accept_deal은 그 조건으로 우리 오퍼를 다시 세운다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const terms = offerFor(state, player.id, 0.9);
    expect(sendOffer(state, terms).ok).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    const countered = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      fee: Math.round(terms.fee * 1.1),
    });
    expect(countered.ok, countered.message).toBe(true);
    const demanded = negotiation.rounds.at(-1)!;
    expect(demanded.by).toBe("them");

    // 기한이 지난 협상은 여전히 반려다 — 조정이 서 있어도 문이 닫혔다
    negotiation.status = "expired";
    const late = acceptDeal(state, negotiation.id);
    expect(late.ok).toBe(false);
    expect(late.message).toContain("아직 합의된 협상이 아닙니다");
    negotiation.status = "open";

    const accepted = acceptDeal(state, negotiation.id);
    expect(accepted.ok, accepted.message).toBe(true);
    // 서명이 아니라 다시 나간 오퍼다 — 판정은 여전히 상대의 것이다
    expect(negotiation.status).toBe("open");
    const resent = pendingOffer(negotiation)!;
    expect(resent.by).toBe("us");
    expect(resent.verdict).toBeNull();
    expect(resent.fee).toBe(demanded.fee);
    expect(resent.weeklyWage).toBe(demanded.weeklyWage);
    expect(resent.contractYears).toBe(demanded.contractYears);
    expect(resent.respondsOn).toBeNull();
  });
});

describe("합의 실행 — 장부가 움직인다", () => {
  function agreeOn(state: GameState, feeRatio = 1.1) {
    const player = target(state);
    const terms = offerFor(state, player.id, feeRatio);
    expect(sendOffer(state, terms).ok).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    const responded = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(responded.ok, responded.message).toBe(true);
    expect(negotiation.status).toBe("agreed");
    return { player, terms, negotiation };
  }

  it("TRANSFER·CONTRACT·재정·소속이 함께 반영된다", () => {
    const state = createTestGame(42);
    const { player, terms, negotiation } = agreeOn(state);
    const fromTeamId = player.teamId;
    const ourBudget = financeOf(state, state.userTeamId).transferBudget;
    const theirBudget = financeOf(state, fromTeamId).transferBudget;
    const theirBalance = financeOf(state, fromTeamId).balance;
    const previousContract = activeContract(state, player.id)!;

    const result = acceptDeal(state, negotiation.id);
    expect(result.ok, result.message).toBe(true);
    expect(negotiation.status).toBe("completed");

    // 원장
    const transfer = state.transfers.find((t) => t.gamePlayerId === player.id);
    expect(transfer?.fromTeamId).toBe(fromTeamId);
    expect(transfer?.toTeamId).toBe(state.userTeamId);
    expect(transfer?.fee).toBe(terms.fee);
    expect(transfer?.type).toBe("transfer");

    // 계약 — 이전 계약은 끝나고 새 계약이 주급의 원본이 된다
    expect(previousContract.status).toBe("ended");
    const contract = activeContract(state, player.id)!;
    expect(contract.teamId).toBe(state.userTeamId);
    expect(contract.weeklyWage).toBe(terms.weeklyWage);
    expect(contract.until.endsWith("-06-30")).toBe(true);

    // 재정 — 우리 지출·상대 수입, 예산은 빠지고 판매 대금은 상대 예산으로
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(ourBudget - terms.fee);
    expect(financeOf(state, fromTeamId).transferBudget).toBe(theirBudget + terms.fee);
    expect(
      financeOf(state, state.userTeamId).ledger.some(
        (e) => e.category === "transfer_out" && e.label.includes(player.name),
      ),
    ).toBe(true);
    // 에이전트 수수료도 이적료의 10%로 함께 빠진다 (finance.md §6)
    expect(
      financeOf(state, state.userTeamId).ledger.find((e) => e.category === "agent_fee")?.amount,
    ).toBe(Math.round(terms.fee * 0.1));
    // 파는 쪽(AI 팀)은 상세 원장을 쌓지 않는다 — 잔고로 확인한다
    expect(financeOf(state, fromTeamId).balance).toBe(theirBalance + terms.fee);

    // 소속 — 새 팀에서는 예비 스쿼드다 (감독이 라인업에 넣는다)
    expect(playerById(state, player.id)!.teamId).toBe(state.userTeamId);
    expect(playersOf(state, state.userTeamId).some((p) => p.id === player.id)).toBe(true);
    expect(playersOf(state, fromTeamId).some((p) => p.id === player.id)).toBe(false);
  });

  it("합의만으로는 이적이 아니다 — 확정 전에 물러설 수 있다", () => {
    const state = createTestGame(42);
    const { player, negotiation } = agreeOn(state);
    expect(playerById(state, player.id)!.teamId).not.toBe(state.userTeamId);

    expect(withdrawOffer(state, negotiation.id).ok).toBe(true);
    expect(negotiation.status).toBe("rejected");
    expect(acceptDeal(state, negotiation.id).ok).toBe(false);
    expect(playerById(state, player.id)!.teamId).not.toBe(state.userTeamId);
  });

  it("합의 뒤 예산이 사라지면 확정이 막힌다", () => {
    const state = createTestGame(42);
    const { negotiation } = agreeOn(state);
    financeOf(state, state.userTeamId).transferBudget = 0;
    // 예산 검증은 **계약이 실제로 쓰이는 순간**(메디컬 통과 뒤)에 걸린다
    const result = completeDeal(state, negotiation.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("예산이 부족");
    expect(negotiation.status).toBe("agreed");
  });
});

/**
 * 분할 지급 — 미래의 돈이 표에 앉는다 (transfer.md §5-2).
 *
 * 여기서 재는 것은 **상태 전이**다: 못 내는 일시금이 무산 대신 분할 조정으로
 * 넘어가는가, 그리고 확정이 일정 표를 세우고 오늘 첫 회분만 무는가.
 */
describe("분할 지급 — 관문은 첫 회분을 잰다", () => {
  it("분할 영입은 일정 표가 지고 오늘은 첫 회분만 나간다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const fromTeamId = player.teamId;
    const budget = financeOf(state, state.userTeamId).transferBudget;
    /**
     * 일시금으로는 예산을 넘고 3년 분할의 첫 회분이면 들어오는 값 — 관문이 총액을
     * 재면 여기서 막힌다. 홀수라 마지막 회분이 잔차를 진다.
     */
    const fee = budget * 2 + 1;
    const negotiation = stagedNegotiation(state, {
      id: "neg-buy-split",
      kind: "buy",
      playerId: player.id,
      counterpartTeamId: fromTeamId,
      fee,
      weeklyWage: 40_000,
      years: 4,
    });
    negotiation.rounds[0]!.paymentYears = 3;
    const theirBudget = financeOf(state, fromTeamId).transferBudget;
    const theirBalance = financeOf(state, fromTeamId).balance;

    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");

    // 원장은 총액이고, 나뉜 것은 현금의 시점이다
    expect(state.transfers.find((t) => t.gamePlayerId === player.id)?.fee).toBe(fee);
    const schedule = state.paymentSchedules!.find((s) => s.gamePlayerId === player.id)!;
    expect(schedule.payerTeamId).toBe(state.userTeamId);
    expect(schedule.payeeTeamId).toBe(fromTeamId);
    expect(schedule.installments).toHaveLength(3);
    // 일정의 합은 언제나 합의 총액과 같다 — 잔차는 마지막 회분이 진다 (§11)
    expect(schedule.installments.reduce((sum, i) => sum + i.amount, 0)).toBe(fee);

    const first = Math.floor(fee / 3);
    expect(schedule.installments[0]!.paidOn).toBe(state.date);
    expect(schedule.installments[1]!.paidOn).toBeNull();
    expect(schedule.installments[2]!.paidOn).toBeNull();
    // 예산도 잔고도 오늘 나간 첫 회분만큼만 움직인다
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(budget - first);
    expect(financeOf(state, fromTeamId).transferBudget).toBe(theirBudget + first);
    expect(financeOf(state, fromTeamId).balance).toBe(theirBalance + first);
  });
});

describe("시간이 흐르면", () => {
  it("기한을 넘긴 협상은 무효가 된다", () => {
    const state = createTestGame(42);
    const player = target(state);
    sendOffer(state, offerFor(state, player.id));
    const negotiation = openNegotiationFor(state, player.id)!;

    const digest: string[] = [];
    negotiation.expiresOn = addDays(state.date, 3);
    state.date = addDays(negotiation.expiresOn, 1);
    expireNegotiations(state, digest);
    expect(negotiation.status).toBe("expired");
    expect(digest.some((d) => d.includes("기한"))).toBe(true);
  });
});

describe("매각 — 들어오는 오퍼", () => {
  it("거절·조정·수락이 모두 가능하고, 조정은 받은 값보다 높아야 한다", () => {
    const state = createTestGame(42);
    const { negotiation } = waitForIncoming(state);
    const offer = incomingOffer(negotiation!)!;

    const countered = answerIncomingOffer(state, {
      negotiationId: negotiation!.id,
      verdict: "counter",
      fee: Math.round(offer.fee * 1.3),
    });
    expect(countered.ok, countered.message).toBe(true);
    // 조정하면 사는 쪽이 답할 차례가 된다
    expect(negotiation!.status).toBe("open");
    const ours = negotiation!.rounds[negotiation!.rounds.length - 1]!;
    expect(ours.by).toBe("us");
    expect(ours.respondsOn).toBeNull();
  });

  it("수락하면 선수가 떠나고 이적료가 예산으로 들어온다", () => {
    const state = createTestGame(42);
    const { negotiation } = waitForIncoming(state);
    const offer = incomingOffer(negotiation!)!;
    const player = playerById(state, negotiation!.gamePlayerId)!;
    const buyerTeamId = negotiation!.counterpartTeamId!;
    const budgetBefore = financeOf(state, state.userTeamId).transferBudget;
    const buyerBefore = {
      balance: financeOf(state, buyerTeamId).balance,
      budget: financeOf(state, buyerTeamId).transferBudget,
    };
    const squadBefore = playersOf(state, state.userTeamId).length;
    // 떠나는 선수가 남기고 가는 것들 — 어느 문으로 나가든 함께 지워진다 (transfer.md §2)
    state.playerTraining.push({ gamePlayerId: player.id, axis: "pace", since: state.date });
    state.roleMemory.push({ gamePlayerId: player.id, position: "ST", roleId: "poacher" });

    const answered = answerIncomingOffer(state, {
      negotiationId: negotiation!.id,
      verdict: "accept",
    });
    expect(answered.ok, answered.message).toBe(true);
    expect(negotiation!.status).toBe("agreed");
    // 합의만으로는 떠나지 않는다
    expect(playerById(state, player.id)!.teamId).toBe(state.userTeamId);

    const done = completeDeal(state, negotiation!.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation!.status).toBe("completed");

    expect(playerById(state, player.id)!.teamId).toBe(buyerTeamId);
    expect(playersOf(state, state.userTeamId)).toHaveLength(squadBefore - 1);
    /**
     * 판매 대금은 잔고와 이적 예산에 함께 들어간다.
     * **처음 부른 값이 아니라 마지막에 합의된 값**이다 — 사는 쪽 메디컬에서
     * 소견이 나오면 그 자리에서 깎아 다시 부르기 때문이다 (medical.ts).
     */
    const settled = [...negotiation!.rounds].reverse().find((r) => r.verdict === "accept")!;
    expect(settled.fee).toBeLessThanOrEqual(offer.fee);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(budgetBefore + settled.fee);
    expect(financeOf(state, buyerTeamId).balance).toBe(
      buyerBefore.balance - settled.fee - Math.round(settled.fee * 0.1),
    );
    expect(financeOf(state, buyerTeamId).transferBudget).toBe(buyerBefore.budget - settled.fee);
    expect(
      financeOf(state, state.userTeamId).ledger.some(
        (e) => e.kind === "income" && e.label.includes(player.name),
      ),
    ).toBe(true);
    // 원장은 방향이 반대다
    const transfer = state.transfers.find((t) => t.gamePlayerId === player.id)!;
    expect(transfer.fromTeamId).toBe(state.userTeamId);
    expect(transfer.toTeamId).toBe(buyerTeamId);
    // 계약도 새 팀으로 넘어간다
    expect(activeContract(state, player.id)!.teamId).toBe(buyerTeamId);
    // 개인 훈련·역할 기억은 방출만이 아니라 매각에서도 정리된다
    expect(state.playerTraining.some((t) => t.gamePlayerId === player.id)).toBe(false);
    expect(state.roleMemory.some((m) => m.gamePlayerId === player.id)).toBe(false);
  });

  it("우리가 넣은 오퍼는 answerIncomingOffer로 답할 수 없다", () => {
    const state = createTestGame(42);
    const player = target(state);
    sendOffer(state, offerFor(state, player.id));
    const negotiation = openNegotiationFor(state, player.id)!;
    const wrong = answerIncomingOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(wrong.ok).toBe(false);
    expect(wrong.message).toContain("들어온 오퍼가 아닙니다");
  });

  /**
   * **어느 방향에서 답했든 판정은 카드로 남는다.**
   *
   * 예전엔 들어온 오퍼에 답하는 갈래에만 카드가 없어서, 감독이 직접 판정한 건은
   * 채팅에 한 줄 요약으로 떨어졌다 — 제시 vs 요구도, 답이 오는 날도 볼 수 없었다.
   * 그 갈래가 `respondOffer`와 같은 헬퍼를 쓰게 되면서 사라진 차이다.
   */
  it("들어온 오퍼에 답해도 판정 카드가 남고, 감독의 메모가 실린다", () => {
    for (const verdict of ["accept", "reject", "counter"] as const) {
      const state = createTestGame(42);
      const { negotiation } = waitForIncoming(state);
      const offer = incomingOffer(negotiation!)!;
      const player = playerById(state, negotiation!.gamePlayerId)!;

      const answered = answerIncomingOffer(state, {
        negotiationId: negotiation!.id,
        verdict,
        ...(verdict === "counter" ? { fee: Math.round(offer.fee * 1.3) } : {}),
        note: "우리 판단은 이렇습니다",
      });
      expect(answered.ok, `${verdict}: ${answered.message}`).toBe(true);

      const card = answered.payload as MarketCard | undefined;
      expect(card, `${verdict}: 판정 카드가 없다`).toBeDefined();
      expect(card!.kind).toBe("verdict");
      expect(card!.verdict).toBe(verdict);
      expect(card!.playerName).toBe(player.name);
      // 상대는 **사려는 구단**이다 — 매각에서 선수는 아직 우리 소속이다
      expect(card!.counterpart).not.toBe(teamName(state.userTeamId));
      // 받은 오퍼가 제시, 되부른 값이 요구
      expect(card!.terms?.fee).toBe(offer.fee);
      expect(card!.note).toBe("우리 판단은 이렇습니다");
      if (verdict === "counter") {
        expect(card!.counterTerms?.fee).toBe(Math.round(offer.fee * 1.3));
        expect(card!.dueOn).toBeUndefined();
        // 메모는 우리가 부른 라운드에 남는다 — 상대의 오퍼에 덮어쓰지 않는다
        const ours = negotiation!.rounds[negotiation!.rounds.length - 1]!;
        expect(ours.by).toBe("us");
        expect(ours.note).toBe("우리 판단은 이렇습니다");
      } else {
        expect(card!.counterTerms).toBeUndefined();
      }
    }
  });

  /** 되부를 때 주급도 함께 조정할 수 있다 — 예전엔 이 값이 조용히 버려졌다 */
  it("조정에 주급을 실으면 그 값이 라운드와 카드에 남는다", () => {
    const state = createTestGame(42);
    const { negotiation } = waitForIncoming(state);
    const offer = incomingOffer(negotiation!)!;

    const countered = answerIncomingOffer(state, {
      negotiationId: negotiation!.id,
      verdict: "counter",
      fee: Math.round(offer.fee * 1.3),
      weeklyWage: offer.weeklyWage + 20_000,
    });
    expect(countered.ok, countered.message).toBe(true);
    const ours = negotiation!.rounds[negotiation!.rounds.length - 1]!;
    expect(ours.weeklyWage).toBe(offer.weeklyWage + 20_000);
    expect((countered.payload as MarketCard).counterTerms?.weeklyWage).toBe(
      offer.weeklyWage + 20_000,
    );
  });
});

/**
 * 이적 요청 — **선수가 시작하는 매각** (transfer.md §1-1).
 *
 * 여기서 재는 것은 셋이다: 값이 붙은 오퍼를 가르는 **경계**, 같은 창의 두 번째
 * 거절이 요청을 세우는 **전이**, 수락한 호가가 요청 할인선을 넘지 못하는 **불변식**.
 */
describe("재계약 — 상대가 선수 본인이다", () => {
  /** 계약이 곧 끝나는 우리 선수 하나를 만든다 */
  function expiringPlayer(state: GameState) {
    const player = playersOf(state, state.userTeamId)[0]!;
    activeContract(state, player.id)!.until = addDays(state.date, 120);
    return player;
  }

  it("만료가 다가온 계약을 뽑아 준다", () => {
    const state = createTestGame(42);
    const player = expiringPlayer(state);
    const rows = expiringContracts(state, 180);
    expect(rows.some((r) => r.player.id === player.id)).toBe(true);
    // 먼 계약은 걸리지 않는다
    expect(expiringContracts(state, 30).some((r) => r.player.id === player.id)).toBe(false);
  });

  it("이적창과 무관하게 열리고, 관문이 하나다 (선수가 남을까)", () => {
    const state = createTestGame(42);
    const player = expiringPlayer(state);
    // 창을 모두 닫아도 재계약은 가능하다
    for (const w of state.windows) w.closesOn = state.date;
    state.date = addDays(state.date, 1);

    const expectation = renewalExpectation(state, player);
    const odds = validateDeal(state, {
      playerId: player.id,
      fee: 0,
      weeklyWage: expectation,
      years: 3,
      kind: "renew",
    });
    expect(odds.blockers).toHaveLength(0);

    const result = openRenewal(state, { playerId: player.id, weeklyWage: expectation, years: 3 });
    expect(result.ok, result.message).toBe(true);
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    expect(negotiation.counterpartTeamId).toBeNull();
    expect(negotiation.windowId).toBeNull();
    expect(negotiation.rounds[0]!.fee).toBe(0);
  });

  it("선수가 주급을 더 요구하면 그 값으로 다시 제안해 합의한다", () => {
    const state = createTestGame(42);
    const player = expiringPlayer(state);
    const expectation = renewalExpectation(state, player);
    openRenewal(state, {
      playerId: player.id,
      weeklyWage: Math.round(expectation * 0.8),
      years: 3,
    });
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;

    const demanded = Math.round(expectation * 1.15);
    const countered = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      weeklyWage: demanded,
      note: "그 정도는 받아야죠",
    });
    expect(countered.ok, countered.message).toBe(true);
    expect(negotiation.rounds[negotiation.rounds.length - 1]!.weeklyWage).toBe(demanded);

    // 요구대로 다시 제안하면 받아들인다
    expect(openRenewal(state, { playerId: player.id, weeklyWage: demanded, years: 3 }).ok).toBe(
      true,
    );
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    const accepted = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(accepted.ok, accepted.message).toBe(true);
    expect(negotiation.status).toBe("agreed");
  });

  /** 80% 주급 · 3년으로 재계약을 열고 답이 도착한 날까지 보낸다 */
  function arrivedRenewal(state: GameState) {
    const player = expiringPlayer(state);
    const expectation = renewalExpectation(state, player);
    const opened = openRenewal(state, {
      playerId: player.id,
      weeklyWage: Math.round(expectation * 0.8),
      years: 3,
    });
    expect(opened.ok, opened.message).toBe(true);
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    return { player, negotiation, demanded: Math.round(expectation * 1.15) };
  }

  it("선수가 연수를 함께 되부르면 그 연수로 다시 제안해 합의하고, 계약도 그 길이다", () => {
    const state = createTestGame(42);
    const { player, negotiation, demanded } = arrivedRenewal(state);
    const countered = respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      weeklyWage: demanded,
      contractYears: 4,
    });
    expect(countered.ok, countered.message).toBe(true);
    expect(negotiation.rounds[negotiation.rounds.length - 1]!.contractYears).toBe(4);
    const card = countered.payload as MarketCard & { counterTerms?: { years?: number } };
    expect(card.counterTerms?.years).toBe(4);
    expect(countered.message).toContain("4년");

    expect(openRenewal(state, { playerId: player.id, weeklyWage: demanded, years: 4 }).ok).toBe(
      true,
    );
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    const accepted = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(accepted.ok, accepted.message).toBe(true);
    expect(negotiation.status).toBe("agreed");
    expect(acceptDeal(state, negotiation.id).ok).toBe(true);
    expect(activeContract(state, player.id)!.until).toBe(contractUntil(state.date, 4));
  });

  /**
   * **주급 여력의 자는 영입에만 서 있다** (`validateDeal`의 buy 갈래). 재계약은 관문이
   * 하나(선수가 남을까)인 `renewOdds`로 빠지고, `executeRenewal`도 총액을 보지
   * 않는다 — 그래서 한도의 몇 배짜리 재계약이 열리고 확정까지 그대로 간다.
   *
   * 여기 있는 것은 현재 동작의 못이다. 재계약에도 여력을 걸기로 한다면 그건 밸런스
   * 결정(감독이 한 선수에게 임금 총액을 다 몰 수 있는가)이고, 이 케이스가 그때
   * 함께 움직여야 하는 자리다.
   */
  it("재계약에는 주급 여력 관문이 없다 — 같은 값이 영입이면 막힌다", () => {
    const state = createTestGame(42);
    const player = expiringPlayer(state);
    const wagesBefore = weeklyWagesOf(state, state.userTeamId);
    const room = wageRoomOf(state.userTeamId, wagesBefore, USER_WAGE_HEADROOM, state);
    const absurd = Math.round(room * 5) + 1_000_000;

    // 같은 주급을 영입에 실으면 관문이 막아선다
    const buying = validateDeal(state, {
      ...offerFor(state, target(state).id),
      weeklyWage: absurd,
    });
    expect(buying.blockers.some((b) => b.includes("주급 여력"))).toBe(true);

    // 재계약은 그대로 지나간다 — 차단도 없고 협상도 열린다
    const renewTerms = {
      playerId: player.id,
      fee: 0,
      weeklyWage: absurd,
      years: 3,
      kind: "renew" as const,
    };
    expect(validateDeal(state, renewTerms).blockers).toHaveLength(0);
    expect(openRenewal(state, { playerId: player.id, weeklyWage: absurd, years: 3 }).ok).toBe(true);

    // 확정까지 가면 계약이 그 값으로 서고 임금 총액이 한도를 넘긴다
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    expect(respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok).toBe(true);
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(activeContract(state, player.id)!.weeklyWage).toBe(absurd);
    expect(
      wageRoomOf(
        state.userTeamId,
        weeklyWagesOf(state, state.userTeamId),
        USER_WAGE_HEADROOM,
        state,
      ),
    ).toBeLessThan(0);
  });

  it("확정하면 계약만 새로 쓰고 이적 원장은 남기지 않는다", () => {
    const state = createTestGame(42);
    const player = expiringPlayer(state);
    const expectation = renewalExpectation(state, player);
    const oldContract = activeContract(state, player.id)!;
    const transfersBefore = state.transfers.length;

    openRenewal(state, {
      playerId: player.id,
      weeklyWage: Math.round(expectation * 1.2),
      years: 4,
    });
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    expect(respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok).toBe(true);

    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");

    // 팀이 바뀌지 않으므로 원장(TRANSFER)은 그대로다
    expect(state.transfers).toHaveLength(transfersBefore);
    expect(oldContract.status).toBe("ended");
    const fresh = activeContract(state, player.id)!;
    expect(fresh.teamId).toBe(state.userTeamId);
    expect(fresh.weeklyWage).toBe(Math.round(expectation * 1.2));
    expect(fresh.until > oldContract.until).toBe(true);
    expect(playerById(state, player.id)!.teamId).toBe(state.userTeamId);
  });
});

describe("대화의 합의 — 계약서는 서고 서명은 감독이 한다", () => {
  /** 80% 주급 · 3년 재계약을 열고, 선수 쪽이 115%로 되부른 자리까지 */
  function counteredRenewal(state: GameState) {
    const player = playersOf(state, state.userTeamId)[0]!;
    activeContract(state, player.id)!.until = addDays(state.date, 120);
    const expectation = renewalExpectation(state, player);
    const offered = Math.round(expectation * 0.8);
    openRenewal(state, { playerId: player.id, weeklyWage: offered, years: 3 });
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    const demanded = Math.round(expectation * 1.15);
    respondOffer(state, {
      negotiationId: negotiation.id,
      verdict: "counter",
      weeklyWage: demanded,
    });
    return { player, negotiation, offered, demanded };
  }

  it("감독이 상대의 조정안을 받으면 그 값으로 합의하고, 서명 전에는 계약이 그대로다", () => {
    const state = createTestGame(42);
    const { player, negotiation, demanded } = counteredRenewal(state);
    const before = activeContract(state, player.id)!.weeklyWage;
    const result = acceptTableTerms(state, {
      negotiationId: negotiation.id,
      party: "agent",
      side: "manager",
    });
    expect(result.ok, result.message).toBe(true);
    expect(negotiation.status).toBe("agreed");
    const card = result.payload as MarketCard;
    expect(card.kind).toBe("contract");
    expect(card.negotiationId).toBe(negotiation.id);
    expect(card.terms?.weeklyWage).toBe(demanded);
    expect(activeContract(state, player.id)!.weeklyWage).toBe(before);

    expect(acceptDeal(state, negotiation.id).ok).toBe(true);
    expect(negotiation.status).toBe("completed");
    expect(activeContract(state, player.id)!.weeklyWage).toBe(demanded);
  });

  it("상대가 우리 조건을 받으면 조정안이 서 있어도 우리 값으로 합의한다", () => {
    const state = createTestGame(42);
    const { negotiation, offered } = counteredRenewal(state);
    const result = acceptTableTerms(state, {
      negotiationId: negotiation.id,
      party: "agent",
      side: "counterparty",
    });
    expect(result.ok, result.message).toBe(true);
    expect(negotiation.status).toBe("agreed");
    expect((result.payload as MarketCard).terms?.weeklyWage).toBe(offered);
    // 이미 합의된 거래는 같은 계약서를 다시 세울 뿐 조건을 옮기지 않는다
    const again = acceptTableTerms(state, {
      negotiationId: negotiation.id,
      party: "agent",
      side: "manager",
    });
    expect((again.payload as MarketCard).terms?.weeklyWage).toBe(offered);
  });
});

describe("계약의 만료일 — 계약일이 정한다", () => {
  /**
   * 경계는 6월 30일과 7월 1일이다. 시즌 기준 연도로 세면 1월의 1년 계약이 그해
   * 6월 30일, 곧 다섯 달짜리가 된다 (transfer.md §5-1).
   */
  it("겨울 1년 계약은 다음 해 6월 30일까지다", () => {
    expect(contractUntil("2027-01-20", 1)).toBe("2028-06-30");
    // 여름 계약은 달라지지 않는다 — 역년이 시즌 기준 연도와 같은 구간이다
    expect(contractUntil("2026-08-15", 1)).toBe("2027-06-30");
    expect(contractUntil("2026-07-01", 3)).toBe("2029-06-30");
    // 시즌이 갈리는 자리 — 6/30과 7/1은 역년이 같아 만료도 같다
    expect(contractUntil("2027-06-30", 1)).toBe("2028-06-30");
    expect(contractUntil("2027-07-01", 1)).toBe("2028-06-30");
  });

  it("겨울에 확정한 1년 재계약이 그 시즌 안에서 끝나지 않는다", () => {
    const state = createTestGame(42);
    state.date = "2027-01-20"; // 시즌 1(2026-07 ~ 2027-06)의 겨울 창
    const player = playersOf(state, state.userTeamId)[0]!;
    activeContract(state, player.id)!.until = addDays(state.date, 120);

    const wage = Math.round(renewalExpectation(state, player) * 1.3);
    expect(openRenewal(state, { playerId: player.id, weeklyWage: wage, years: 1 }).ok).toBe(true);
    const negotiation = state.negotiations.find((n) => n.kind === "renew")!;
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    const accepted = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(accepted.ok, accepted.message).toBe(true);
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);

    expect(activeContract(state, player.id)!.until).toBe("2028-06-30");
  });
});

/**
 * 이적 시스템 전반 점검에서 나온 다섯 가지 — 각각 **무엇이 깨져 있었는지**를 고정한다.
 * (docs/negotiation/transfer.md의 규칙이 한쪽에만 걸려 있던 자리들이다)
 */
describe("시장의 문 — 한쪽에만 걸려 있던 관문들", () => {
  /** 주급 여력 — 감독에게도 걸린다 (예전엔 AI에만 있었다) */
  it("주급 여력을 넘는 오퍼는 막힌다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const terms = offerFor(state, player.id);
    // 여력을 확실히 넘기는 주급
    const absurd = sendOffer(state, { ...terms, weeklyWage: 5_000_000 });
    expect(absurd.ok).toBe(false);
    expect(absurd.message).toContain("주급");
    // 정상 조건은 그대로 지나간다 — 관문의 일은 규율이 아니라 폭주 방지다
    expect(sendOffer(state, terms).ok, "평범한 영입까지 막으면 안 된다").toBe(true);
  });

  /** 합의와 실행 사이에 창이 닫히면 임대도 확정되지 않는다 (예전엔 영입만 막혔다) */
  it("창이 닫히면 임대 영입도 확정할 수 없다", () => {
    const state = createTestGame(42);
    const player = target(state);
    // 합의까지 간 임대 협상을 직접 세운다 — 관문만 보는 테스트다
    const negotiation = stagedNegotiation(state, {
      id: "neg-loan",
      kind: "loan",
      playerId: player.id,
      counterpartTeamId: player.teamId,
      fee: 2_000_000,
      // 검진은 이미 통과한 것으로 — 여기서 보려는 것은 창이다
      openWindow: false,
    });

    for (const w of state.windows) w.closesOn = addDays(state.date, -1);
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok).toBe(false);
    expect(done.message).toContain("이적시장이 닫혀");
    // 창이 열려 있으면 같은 딜이 지나간다 — 관문이 창 하나만 보는지 확인
    for (const w of state.windows) w.closesOn = addDays(state.date, 30);
    expect(acceptDeal(state, negotiation.id).ok, "창이 열리면 확정된다").toBe(true);
  });
});

/**
 * 임대료도 이적 예산에서 움직인다 (transfer.md §2).
 *
 * 관문(`affordabilityGate`)이 임대료를 이적 예산으로 검사하는데 차감이 없었다 —
 * 같은 예산으로 임대를 몇 번이든 반복할 수 있었다. 검사한 값과 빠지는 값이
 * 같은지를 여기서 고정한다.
 */
describe("임대료 — 검사한 값이 빠진다", () => {
  const LOAN_FEE = 2_000_000;

  /** 합의까지 간 임대 협상 — 관문 뒤의 장부만 보는 테스트다 */
  const agreedLoan = (
    state: GameState,
    input: { id: string; kind: "loan" | "loan_out"; playerId: string; counterpartTeamId: string },
  ) => stagedNegotiation(state, { ...input, fee: LOAN_FEE });

  it("빌려오면 현금과 예산이 같은 크기로 빠진다", () => {
    const state = createTestGame(42);
    const player = target(state);
    const lenderId = player.teamId;
    const ourBudget = financeOf(state, state.userTeamId).transferBudget;
    const ourBalance = financeOf(state, state.userTeamId).balance;
    const theirBudget = financeOf(state, lenderId).transferBudget;
    const theirBalance = financeOf(state, lenderId).balance;

    const negotiation = agreedLoan(state, {
      id: "neg-loan-in",
      kind: "loan",
      playerId: player.id,
      counterpartTeamId: lenderId,
    });
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(playerById(state, player.id)!.loan?.fromTeamId).toBe(lenderId);

    expect(financeOf(state, state.userTeamId).balance).toBe(ourBalance - LOAN_FEE);
    expect(
      financeOf(state, state.userTeamId).transferBudget,
      "관문이 예산으로 검사했으면 예산에서도 빠져야 한다",
    ).toBe(ourBudget - LOAN_FEE);
    expect(financeOf(state, lenderId).balance).toBe(theirBalance + LOAN_FEE);
    expect(financeOf(state, lenderId).transferBudget).toBe(theirBudget + LOAN_FEE);
  });

  /** 예산이 안 빠지면 같은 돈으로 임대를 무한히 반복할 수 있었다 */
  it("예산을 임대료만큼만 남기면 두 번째 임대가 막힌다", () => {
    const state = createTestGame(42);
    const first = target(state);
    const second = state.players.find(
      (p) => p.teamId !== state.userTeamId && p.id !== first.id && p.teamId === first.teamId,
    );
    expect(second, "같은 구단에서 둘을 빌려 오는 상황을 세운다").toBeDefined();
    financeOf(state, state.userTeamId).transferBudget = LOAN_FEE;

    const one = agreedLoan(state, {
      id: "neg-loan-a",
      kind: "loan",
      playerId: first.id,
      counterpartTeamId: first.teamId,
    });
    expect(acceptDeal(state, one.id).ok).toBe(true);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(0);

    const two = agreedLoan(state, {
      id: "neg-loan-b",
      kind: "loan",
      playerId: second!.id,
      counterpartTeamId: second!.teamId,
    });
    const blocked = acceptDeal(state, two.id);
    expect(blocked.ok, "예산을 다 쓴 뒤에는 같은 임대료를 또 낼 수 없다").toBe(false);
    expect(blocked.message).toContain("예산");
  });

  it("빌려주면 현금과 예산이 같은 크기로 들어온다", () => {
    const state = createTestGame(42);
    // 주전이 아닌 자원을 내보낸다 — 스쿼드 하한에 걸리지 않게
    const ours = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[0]!;
    const borrowerId = state.players.find((p) => p.teamId !== state.userTeamId)!.teamId;
    const ourBudget = financeOf(state, state.userTeamId).transferBudget;
    const ourBalance = financeOf(state, state.userTeamId).balance;
    const theirBudget = financeOf(state, borrowerId).transferBudget;
    const theirBalance = financeOf(state, borrowerId).balance;

    const negotiation = agreedLoan(state, {
      id: "neg-loan-out",
      kind: "loan_out",
      playerId: ours.id,
      counterpartTeamId: borrowerId,
    });
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(playerById(state, ours.id)!.loan?.fromTeamId).toBe(state.userTeamId);

    expect(financeOf(state, state.userTeamId).balance).toBe(ourBalance + LOAN_FEE);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(ourBudget + LOAN_FEE);
    expect(financeOf(state, borrowerId).balance).toBe(theirBalance - LOAN_FEE);
    expect(financeOf(state, borrowerId).transferBudget).toBe(theirBudget - LOAN_FEE);
  });

  /**
   * **사는 쪽 예산은 매각만 보던 문이다** (transfer.md §2). 임대료도 이적 예산에서
   * 같은 값이 빠지므로, 검사 없이 빼면 AI 구단의 예산이 음수가 된다 — 그 구단은
   * 다음 창에서 마이너스를 안고 시장에 선다.
   */
  it("빌리는 쪽 예산이 모자라면 무산된다 — 상대 예산은 음수가 되지 않는다", () => {
    const state = createTestGame(42);
    const ours = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[0]!;
    const borrowerId = state.players.find((p) => p.teamId !== state.userTeamId)!.teamId;
    financeOf(state, borrowerId).transferBudget = LOAN_FEE - 1;
    const theirBudget = financeOf(state, borrowerId).transferBudget;

    const negotiation = agreedLoan(state, {
      id: "neg-loan-broke",
      kind: "loan_out",
      playerId: ours.id,
      counterpartTeamId: borrowerId,
    });

    const blocked = acceptDeal(state, negotiation.id);
    expect(blocked.ok, "임대료를 못 내는 구단에 확정되어서는 안 된다").toBe(false);
    expect(financeOf(state, borrowerId).transferBudget, "예산은 음수가 되지 않는다").toBe(
      theirBudget,
    );
    expect(
      playerById(state, ours.id)!.loan,
      "무산된 딜에 선수만 옮겨 가서는 안 된다",
    ).toBeUndefined();
    expect(playerById(state, ours.id)!.teamId).toBe(state.userTeamId);
    // 결렬이면 이번 창에 값을 낮춰 다시 붙을 길까지 닫힌다
    expect(state.negotiations.find((n) => n.id === negotiation.id)!.status).toBe("expired");
  });
});

/**
 * **협상은 갈래별로 따로 선다** (transfer.md §1).
 *
 * 열린 협상을 갈래를 안 보고 재사용하면 라운드는 이번 오퍼의 조건으로 쌓이는데
 * 실행은 협상이 쥔 `kind`가 고른다 — 임대 협상에 영입 오퍼가 얹히면 합의가
 * 임대료 자리에 이적료를 문다.
 */
describe("갈래가 다른 협상은 섞이지 않는다", () => {
  it("영입이 열려 있으면 같은 선수의 임대 오퍼가 반려된다 — 양방향", () => {
    const state = createTestGame(42);
    const player = target(state);
    expect(sendOffer(state, offerFor(state, player.id)).ok).toBe(true);
    const buy = openNegotiationFor(state, player.id)!;
    expect(buy.kind).toBe("buy");
    // id에도 갈래가 든다 — 같은 선수에게 같은 날 두 갈래를 열면 겹친다
    expect(buy.id).toContain(`neg-buy-${player.id}-`);

    const loan = sendOffer(state, {
      playerId: player.id,
      fee: Math.round(marketValueOf(state, player) * LOAN_FEE_RATE),
      weeklyWage: wageExpectationOf(state, player),
      years: 1,
      kind: "loan",
    });
    expect(loan.ok, "영입 협상 위에 임대 라운드가 쌓여서는 안 된다").toBe(false);
    expect(loan.message).toContain("영입 협상");
    expect(buy.rounds).toHaveLength(1);
    expect(state.negotiations.filter((n) => n.gamePlayerId === player.id)).toHaveLength(1);

    // 우리 선수 쪽도 같다 — 매각이 열려 있으면 임대 송출이 반려된다
    const ours = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[0]!;
    const buyerId = state.players.find((p) => p.teamId !== state.userTeamId)!.teamId;
    const sale = offerPlayerOut(state, {
      playerId: ours.id,
      teamId: buyerId,
      fee: Math.round(marketValueOf(state, ours)),
    });
    expect(sale.ok, sale.message).toBe(true);
    const out = openNegotiationFor(state, ours.id)!;
    expect(out.kind).toBe("sell");
    const loanOut = offerPlayerOut(state, {
      playerId: ours.id,
      teamId: buyerId,
      fee: Math.round(marketValueOf(state, ours) * LOAN_FEE_RATE),
      loan: true,
    });
    expect(loanOut.ok).toBe(false);
    expect(loanOut.message).toContain("매각 협상");
    expect(out.rounds).toHaveLength(1);
  });
});

/**
 * **임대 중인 선수의 계약은 소유 구단의 것이다** (transfer.md §2).
 *
 * 코어가 `loan.fromTeamId === userTeamId`(우리가 **내보낸** 임대)만 보던 시절엔
 * 우리에게 **온** 임대가 우리 선수로 취급됐다: 빌려 온 선수를 팔면 남의 계약이
 * 끝나고 이적료가 우리에게 들어왔고, 남의 임대 선수를 영입하면 돈이 계약 소유
 * 구단이 아니라 **빌린 구단**에 입금되면서 `loan`이 남아 복귀일에 선수만 원소속으로
 * 돌아갔다. 화면에 드러나지 않는 장부라 문마다 못 박는다.
 */
describe("임대 중인 선수는 소유 구단만 움직인다", () => {
  const OWNER = "chelsea";
  const HOST = "liverpool";
  const BUYER = "mancity";
  const FEE = 2_000_000;

  /** 합의까지 간 협상 하나 — 관문 뒤의 장부를 보려면 확정 직전까지 세워야 한다 */
  const agreedDeal = (
    state: GameState,
    input: {
      id: string;
      kind: "buy" | "sell" | "loan";
      playerId: string;
      counterpartTeamId: string;
      fee: number;
    },
  ) => stagedNegotiation(state, { ...input, years: 3 }).id;

  /** 첼시 선수를 우리가 빌려 온다 — `teamId`는 우리, 계약은 첼시에 남는다 */
  function borrowed(state: GameState) {
    const player = playersOf(state, OWNER).sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[2]!;
    const id = agreedDeal(state, {
      id: "neg-loan-in",
      kind: "loan",
      playerId: player.id,
      counterpartTeamId: OWNER,
      fee: FEE,
    });
    const done = acceptDeal(state, id);
    expect(done.ok, done.message).toBe(true);
    const after = playerById(state, player.id)!;
    expect(after.teamId).toBe(state.userTeamId);
    expect(activeContract(state, after.id)!.teamId).toBe(OWNER);
    return after;
  }

  /** 첼시 선수가 리버풀에서 뛰는 상태 — AI 시장의 임대가 남기는 모양 그대로 */
  function thirdPartyLoan(state: GameState) {
    const player = playersOf(state, OWNER).sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[3]!;
    player.teamId = HOST;
    player.loan = { fromTeamId: OWNER, until: addDays(state.date, 200), wageShare: 0.5 };
    return player;
  }

  it("빌려 온 선수는 어느 문으로도 나가지 않는다 — 등재·매각·재계약·방출", () => {
    const state = createTestGame(42);
    const player = borrowed(state);

    for (const res of [
      setTransferList(state, { playerId: player.id, listed: true }),
      offerPlayerOut(state, { playerId: player.id, teamId: BUYER, fee: FEE }),
      openRenewal(state, { playerId: player.id, weeklyWage: 50_000, years: 3 }),
      releasePlayer(state, { playerId: player.id }),
    ]) {
      expect(res.ok, res.message).toBe(false);
      expect(res.message).toContain("임대 중");
    }
    expect(state.transferList.some((l) => l.gamePlayerId === player.id)).toBe(false);
    expect(activeContract(state, player.id)!.teamId).toBe(OWNER);
  });

  it("빌려 온 선수는 원소속에서 완전 영입할 수 있다 — 배치·번호는 그대로, 계약과 돈은 옮긴다", () => {
    const state = createTestGame(42);
    const player = borrowed(state);
    const number = player.squadNumber;
    const level = player.squadLevel;
    const ownerBudget = financeOf(state, OWNER).transferBudget;
    const fee = askingPriceFor(state, player);
    const sent = sendOffer(state, {
      playerId: player.id,
      fee,
      weeklyWage: wageExpectationOf(state, player),
      years: 3,
    });
    expect(sent.ok, sent.message).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    // 상대는 우리 스쿼드가 아니라 계약을 가진 구단이다
    expect(negotiation.counterpartTeamId).toBe(OWNER);
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    const accepted = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(accepted.ok, accepted.message).toBe(true);
    const done = completeDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    const after = playerById(state, player.id)!;
    expect(after.loan).toBeUndefined();
    expect(after.teamId).toBe(state.userTeamId);
    expect(activeContract(state, player.id)!.teamId).toBe(state.userTeamId);
    expect(after.squadNumber).toBe(number);
    expect(after.squadLevel).toBe(level);
    expect(financeOf(state, OWNER).transferBudget).toBe(ownerBudget + fee);
    expect(done.message).toContain("임대에서 완전 영입");
  });

  it("빌려 온 선수를 팔면 이적료가 소유 구단을 지나쳐 온다 — 확정이 막는다", () => {
    const state = createTestGame(42);
    const player = borrowed(state);
    const ourBalance = financeOf(state, state.userTeamId).balance;
    const ownerBalance = financeOf(state, OWNER).balance;
    const buyerBalance = financeOf(state, BUYER).balance;

    const id = agreedDeal(state, {
      id: "neg-sell-loaned",
      kind: "sell",
      playerId: player.id,
      counterpartTeamId: BUYER,
      fee: 20_000_000,
    });
    const done = acceptDeal(state, id);
    expect(done.ok, "빌린 구단이 남의 계약을 팔 수는 없다").toBe(false);

    // 장부는 한 푼도 움직이지 않았고 계약은 여전히 첼시의 것이다
    expect(financeOf(state, state.userTeamId).balance).toBe(ourBalance);
    expect(financeOf(state, OWNER).balance).toBe(ownerBalance);
    expect(financeOf(state, BUYER).balance).toBe(buyerBalance);
    const after = playerById(state, player.id)!;
    expect(after.teamId).toBe(state.userTeamId);
    expect(after.loan!.fromTeamId).toBe(OWNER);
    expect(activeContract(state, player.id)!.teamId).toBe(OWNER);
    expect(
      state.contracts.filter((c) => c.gamePlayerId === player.id && c.status === "active"),
    ).toHaveLength(1);
  });

  it("임대 중인 남의 선수는 영입되지 않는다 — 돈이 빌린 구단에 입금된다", () => {
    const state = createTestGame(42);
    const player = thirdPartyLoan(state);
    const ownerBalance = financeOf(state, OWNER).balance;
    const hostBalance = financeOf(state, HOST).balance;
    const ourBudget = financeOf(state, state.userTeamId).transferBudget;

    const offer = sendOffer(state, {
      playerId: player.id,
      fee: FEE,
      weeklyWage: 40_000,
      years: 3,
    });
    expect(offer.ok, "오퍼 단계에서 이미 막힌다").toBe(false);
    expect(offer.message).toContain("임대 중");

    // 합의까지 갔더라도 장부를 옮기는 자리가 다시 막는다
    const id = agreedDeal(state, {
      id: "neg-buy-loaned",
      kind: "buy",
      playerId: player.id,
      counterpartTeamId: HOST,
      fee: FEE,
    });
    const done = acceptDeal(state, id);
    expect(done.ok).toBe(false);
    expect(financeOf(state, HOST).balance, "빌린 구단은 이적료를 받지 않는다").toBe(hostBalance);
    expect(financeOf(state, OWNER).balance).toBe(ownerBalance);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(ourBudget);
    const after = playerById(state, player.id)!;
    expect(after.teamId).toBe(HOST);
    expect(after.loan!.fromTeamId).toBe(OWNER);
    expect(activeContract(state, player.id)!.teamId).toBe(OWNER);
  });

  it("내보낸 임대도 같은 문을 지난다 — 불러들이면 다시 열린다", () => {
    const state = createTestGame(42);
    const ours = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[0]!;
    expect(loanPlayer(state, { playerId: ours.id, teamId: OWNER }).ok).toBe(true);

    for (const res of [
      setTransferList(state, { playerId: ours.id, listed: true }),
      releasePlayer(state, { playerId: ours.id }),
      sendOffer(state, { playerId: ours.id, fee: FEE, weeklyWage: 40_000, years: 3 }),
    ]) {
      expect(res.ok, res.message).toBe(false);
      expect(res.message).toContain("임대 중");
    }

    expect(recallLoan(state, { playerId: ours.id }).ok).toBe(true);
    const listed = setTransferList(state, { playerId: ours.id, listed: true });
    expect(listed.ok, "불러들인 뒤에는 소유 구단이 다시 움직일 수 있다").toBe(true);
  });
});

describe("계약 해지 — 값을 흥정하고, 안 되면 전액을 문다", () => {
  /**
   * 해지가 협상 상태기계를 지난다 — 선수가 거부하거나 더 요구할 수 있고, 합의가
   * 끝내 안 되면 감독이 **전액**을 물고 끊는 길이 남는다 (transfer.md §2·§11).
   * 픽스처는 describe당 하나가 원칙이나 케이스마다 계약을 끊어 놓으므로 각자 세운다.
   */

  /** 우리 스쿼드에서 자리가 막힌 선수 — 스쿼드 하한에 걸리지 않게 뒤에서 고른다 */
  function spare(state: GameState) {
    const squad = playersOf(state, state.userTeamId).sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    );
    return squad.find((p) => p.positions[0]?.position !== "GK") ?? squad[0]!;
  }

  const terms = (state: GameState, player: { id: string }, fee: number) => ({
    playerId: player.id,
    fee,
    weeklyWage: 0,
    years: 0,
    kind: "release" as const,
  });

  it("이적창과 무관하게 열리고, 관문이 하나다 (선수가 합의해 줄까)", () => {
    const state = createTestGame(42);
    const player = spare(state);
    for (const w of state.windows) w.closesOn = state.date;
    state.date = addDays(state.date, 1);

    const anchor = severanceOf(state, player.id);
    const odds = validateDeal(state, terms(state, player, anchor));
    expect(odds.blockers).toHaveLength(0);
    // 이 갈래의 "요구액"은 기대 정산금이고 주급은 흥정거리가 아니다

    const opened = openRelease(state, { playerId: player.id, severance: anchor });
    expect(opened.ok, opened.message).toBe(true);
    const negotiation = state.negotiations.find((n) => n.kind === "release")!;
    expect(negotiation.counterpartTeamId).toBeNull();
    expect(negotiation.windowId).toBeNull();
    // 쓸 계약이 없는 협상이다 — 연수도 주급도 라운드에 서지 않는다
    expect(negotiation.rounds[0]!.contractYears).toBe(0);
    expect(negotiation.rounds[0]!.weeklyWage).toBe(0);
    expect(negotiation.rounds[0]!.fee).toBe(anchor);
  });

  it("선수가 거부하면 남는 길은 전액을 무는 일방 해지다", () => {
    const state = createTestGame(42);
    const player = spare(state);
    openRelease(state, { playerId: player.id, severance: severanceOf(state, player.id) });
    const negotiation = state.negotiations.find((n) => n.kind === "release")!;
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;

    const rejected = respondOffer(state, { negotiationId: negotiation.id, verdict: "reject" });
    expect(rejected.ok, rejected.message).toBe(true);
    expect(negotiation.status).toBe("rejected");

    // 결렬이 일방 해지를 막지 않는다 — 그것이 이 협상의 바깥값이다
    const full = unilateralSeveranceOf(state, player.id);
    const balanceBefore = financeOf(state, state.userTeamId).balance;
    const cut = releasePlayer(state, { playerId: player.id });
    expect(cut.ok, cut.message).toBe(true);
    expect(balanceBefore - financeOf(state, state.userTeamId).balance).toBe(full);
  });

  it("요구대로 다시 제안하면 합의되고, 확정이 계약을 끊고 정산금을 문다", () => {
    const state = createTestGame(42);
    const player = spare(state);
    const anchor = severanceOf(state, player.id);
    const wagesBefore = weeklyWagesOf(state, state.userTeamId);
    const transfersBefore = state.transfers.length;
    const balanceBefore = financeOf(state, state.userTeamId).balance;

    openRelease(state, { playerId: player.id, severance: anchor });
    const negotiation = state.negotiations.find((n) => n.kind === "release")!;
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    const demanded = Math.round(anchor * 1.2);
    expect(
      respondOffer(state, { negotiationId: negotiation.id, verdict: "counter", fee: demanded }).ok,
    ).toBe(true);

    expect(openRelease(state, { playerId: player.id, severance: demanded }).ok).toBe(true);
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    expect(respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" }).ok).toBe(true);
    expect(negotiation.status).toBe("agreed");

    /** 상대가 선수 본인인 갈래는 메디컬을 지나지 않는다 — 옮겨 갈 구단이 없다 */
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    expect(negotiation.status).toBe("completed");
    expect(negotiation.medical).toBeUndefined();

    // 선수는 무소속이 되고, 주급이 빠지고, 합의한 값만 나간다
    expect(playersOf(state, state.userTeamId).some((p) => p.id === player.id)).toBe(false);
    expect(weeklyWagesOf(state, state.userTeamId)).toBeLessThan(wagesBefore);
    expect(balanceBefore - financeOf(state, state.userTeamId).balance).toBe(demanded);
    // 팀이 바뀌는 이동이라 원장에는 남는다 (재계약과 갈리는 자리다)
    expect(state.transfers.length).toBe(transfersBefore + 1);
  });

  it("잔고를 넘는 정산금으로는 흥정을 시작할 수 없다", () => {
    const state = createTestGame(42);
    const player = spare(state);
    const balance = financeOf(state, state.userTeamId).balance;
    const opened = openRelease(state, { playerId: player.id, severance: balance + 1 });
    expect(opened.ok).toBe(false);
    expect(opened.message).toContain("잔고");
  });

  it("다른 갈래가 열려 있으면 해지를 열 수 없다 — 실행이 협상의 kind를 고른다", () => {
    const state = createTestGame(42);
    const player = spare(state);
    openRenewal(state, {
      playerId: player.id,
      weeklyWage: renewalExpectation(state, player),
      years: 2,
    });
    const opened = openRelease(state, {
      playerId: player.id,
      severance: severanceOf(state, player.id),
    });
    expect(opened.ok).toBe(false);
    expect(opened.message).toContain("재계약");
  });
});

describe("방향은 모든 줄에 실린다", () => {
  /**
   * 요약 줄과 주의 줄은 GM이 **사실로 읽는** 문장이다 — 방향이 빠지면 모델은
   * 감독이 내린 결정의 반대를 장면으로 확정한다 (transfer.md §1).
   */
  const state = createTestGame(42);
  const ours = playersOf(state, state.userTeamId)[0]!;
  const theirs = target(state);
  const RIVAL = state.teams.find((t) => t.id !== state.userTeamId && t.id !== theirs.teamId)!.id;

  const KINDS: Negotiation["kind"][] = ["buy", "sell", "loan", "loan_out", "renew", "release"];
  const WAY: Record<Negotiation["kind"], string> = {
    buy: "영입",
    sell: "매각",
    loan: "임대 영입",
    loan_out: "임대 송출",
    renew: "재계약",
    release: "계약 해지",
  };
  /** 그 갈래의 줄에 절대 서면 안 되는 낱말 — 뒤집힘은 이걸로 잡힌다 */
  const NEVER: Record<Negotiation["kind"], string[]> = {
    buy: ["매각", "임대", "송출", "재계약", "해지"],
    sell: ["영입", "임대", "송출", "재계약", "해지"],
    loan: ["매각", "송출", "재계약", "해지"],
    loan_out: ["영입", "매각", "재계약", "해지"],
    renew: ["영입", "매각", "임대", "송출", "해지"],
    release: ["영입", "매각", "임대", "송출", "재계약"],
  };

  /** 한 갈래 · 한 차례의 협상을 세운다 (같은 id는 다시 만들지 않는다) */
  function stage(
    kind: Negotiation["kind"],
    by: "us" | "them",
    opts: { id?: string; countered?: boolean; status?: Negotiation["status"] } = {},
  ): Negotiation {
    const incoming = kind === "buy" || kind === "loan";
    const player = incoming ? theirs : ours;
    const id = opts.id ?? `neg-${kind}-${by}`;
    const found = state.negotiations.find((n) => n.id === id);
    if (found) return found;
    const negotiation: Negotiation = {
      id,
      gamePlayerId: player.id,
      kind,
      counterpartTeamId: isPlayerDeal(kind) ? null : incoming ? player.teamId : RIVAL,
      windowId: null,
      openedOn: state.date,
      expiresOn: addDays(state.date, 10),
      status: opts.status ?? "open",
      pitched: [],
      precontract: false,
      terms: [],
      buyout: false,
      rounds: [
        {
          date: state.date,
          by,
          fee: 20_000_000,
          weeklyWage: 40_000,
          contractYears: 3,
          // 우리가 넣은 오퍼는 답을 기다린다 — 답할 날이 되면 코어가 굳히므로 그 상태로 세울 자리가 없다
          respondsOn: by === "us" ? addDays(state.date, 3) : null,

          // 상대의 차례에 `counter`를 적으면 **되부른 조정**, 비우면 상대가 넣은 오퍼다
          verdict: opts.countered ? "counter" : null,
        },
      ],
    };
    state.negotiations.push(negotiation);
    return negotiation;
  }

  /** 그 협상의 요약 줄 */
  function lineOf(negotiation: Negotiation): string {
    return describeNegotiations(state)
      .split("\n")
      .find((l) => l.startsWith(`${negotiation.id} `))!;
  }

  it("여섯 갈래 × 두 차례 — 요약 줄이 언제나 갈래를 적는다", () => {
    for (const kind of KINDS) {
      for (const by of ["us", "them"] as const) {
        const line = lineOf(stage(kind, by));
        expect(line, `${kind}/${by}`).toBeTruthy();
        expect(line, `${kind}/${by}`).toContain(`${WAY[kind]} —`);
        for (const wrong of NEVER[kind]) {
          expect(line, `${kind}/${by}에 "${wrong}"이 섰다`).not.toContain(wrong);
        }
      }
    }
  });

  it("내보내는 줄의 상대는 선수의 소속이 아니라 거래 상대다", () => {
    for (const kind of ["sell", "loan_out"] as const) {
      const line = lineOf(stage(kind, "them"));
      expect(line).toContain(`${ours.name} → ${teamName(RIVAL)}`);
      expect(line, "괄호 표기는 선수의 소속으로 읽힌다").not.toContain(`${ours.name}(`);
    }
    // 데려오는 갈래에서는 괄호가 선수의 지금 소속이라 그대로 맞다
    expect(lineOf(stage("buy", "them"))).toContain(`${theirs.name}(${teamName(theirs.teamId)})`);
  });

  it("주의 줄 라벨에도 갈래가 선다 — 상대 오퍼·되부른 조정·합의", () => {
    const cases = [
      {
        id: stage("sell", "them", { id: "warn-sell" }).id,
        want: `${ours.name} 매각 상대 오퍼 도착`,
      },
      {
        id: stage("buy", "them", { id: "warn-buy", countered: true }).id,
        want: `${theirs.name} 영입 상대가 조정을 되불렀습니다`,
      },
      {
        id: stage("loan_out", "us", { id: "warn-loanout", status: "agreed" }).id,
        want: `${ours.name} 임대 송출 합의됨`,
      },
      {
        id: stage("renew", "them", { id: "warn-renew", countered: true }).id,
        want: `${ours.name} 재계약 상대가 조정을 되불렀습니다`,
      },
    ];
    const labels = new Map(pendingVerdicts(state).map((v) => [v.negotiation.id, v.label]));
    for (const c of cases) {
      expect(labels.get(c.id), c.id).toContain(c.want);
    }
  });
});

describe("조건부 조항 — 딜의 모양이 붙이고, 되사기는 흥정이 아니다", () => {
  it("셀온은 이익에만 붙는다", () => {
    expect(sellOnAmountOf({ originalFee: 10_000_000, resaleFee: 30_000_000, rate: 0.2 })).toBe(
      4_000_000,
    );
    // 같은 값에 팔거나 손해를 봤으면 £0 — 총액에 붙이면 손해 본 구단이 더 문다
    expect(sellOnAmountOf({ originalFee: 10_000_000, resaleFee: 10_000_000, rate: 0.2 })).toBe(0);
    expect(sellOnAmountOf({ originalFee: 10_000_000, resaleFee: 4_000_000, rate: 0.2 })).toBe(0);
  });

  /**
   * 우리가 판 어린 선수 하나를 상대 구단에 앉히고 되사기를 걸어 둔다 —
   * 매각 협상을 다 굴리지 않고 **행사만** 본다.
   */
  function soldWithBuyBack(state: GameState, input: { fee: number; until: string }) {
    const player = playersOf(state, state.userTeamId).find((p) => !p.loan)!;
    const buyer = state.finances.find(
      (f) => f.teamId !== state.userTeamId && isClubTeam(f.teamId),
    )!.teamId;
    const contract = activeContract(state, player.id)!;
    contract.status = "ended";
    state.contracts.push({
      id: `c-seed-${player.id}`,
      gamePlayerId: player.id,
      teamId: buyer,
      weeklyWage: contract.weeklyWage,
      since: state.date,
      until: contractUntil(state.date, 4),
      status: "active",
    });
    player.teamId = buyer;
    state.transfers.push({
      id: `tr-seed-${player.id}`,
      gamePlayerId: player.id,
      windowId: null,
      fromTeamId: state.userTeamId,
      toTeamId: buyer,
      date: state.date,
      type: "transfer",
      fee: Math.round(input.fee / BUYBACK_MARKUP),
      clauses: { buyBack: { fee: input.fee, until: input.until, exercisedOn: null } },
    });
    return { player, buyer };
  }

  const FEE = 8_000_000;

  it("권리를 쓰면 선수가 그 자리에서 돌아오고 돈은 양쪽에 대칭으로 선다", () => {
    const state = createTestGame();
    const { player, buyer } = soldWithBuyBack(state, { fee: FEE, until: "2028-06-30" });
    financeOf(state, state.userTeamId).transferBudget = FEE * 2;
    const before = {
      us: { ...financeOf(state, state.userTeamId) },
      them: { ...financeOf(state, buyer) },
    };
    expect(ourBuyBackRights(state).map((r) => r.player.id)).toEqual([player.id]);

    const done = exerciseBuyBack(state, { playerId: player.id });
    expect(done.ok).toBe(true);
    expect(playerById(state, player.id)!.teamId).toBe(state.userTeamId);
    expect(activeContract(state, player.id)!.teamId).toBe(state.userTeamId);
    // 조항 값만 오간다 — 에이전트 수수료는 사는 쪽만 문다 (세계 밖으로 나가는 돈)
    expect(financeOf(state, buyer).balance).toBe(before.them.balance + FEE);
    expect(financeOf(state, buyer).transferBudget).toBe(before.them.transferBudget + FEE);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(before.us.transferBudget - FEE);
    // 되산 이적에는 조항이 다시 붙지 않는다
    const back = state.transfers[state.transfers.length - 1]!;
    expect(back.toTeamId).toBe(state.userTeamId);
    expect(back.clauses).toBeUndefined();
  });

  it("한 번 행사하면 권리가 사라진다", () => {
    const state = createTestGame();
    const { player } = soldWithBuyBack(state, { fee: FEE, until: "2028-06-30" });
    financeOf(state, state.userTeamId).transferBudget = FEE * 2;

    expect(exerciseBuyBack(state, { playerId: player.id }).ok).toBe(true);
    expect(ourBuyBackRights(state)).toHaveLength(0);
    const again = exerciseBuyBack(state, { playerId: player.id });
    expect(again.ok).toBe(false);
    expect(again.message).toContain("되사기");
  });

  it("창이 지난 권리는 보이지도 서지도 않는다", () => {
    const state = createTestGame();
    const { player } = soldWithBuyBack(state, { fee: FEE, until: addDays(state.date, -1) });
    expect(ourBuyBackRights(state)).toHaveLength(0);
    expect(exerciseBuyBack(state, { playerId: player.id }).ok).toBe(false);
  });

  it("이적 예산이 조항 값을 못 덮으면 서지 않는다", () => {
    const state = createTestGame();
    const { player } = soldWithBuyBack(state, { fee: FEE, until: "2028-06-30" });
    financeOf(state, state.userTeamId).transferBudget = FEE - 1;
    const blocked = exerciseBuyBack(state, { playerId: player.id });
    expect(blocked.ok).toBe(false);
    expect(playerById(state, player.id)!.teamId).not.toBe(state.userTeamId);
  });
});

/**
 * 사전 계약 — **계약이 먼저 서고 사람은 나중에 온다** (transfer.md §1-4).
 *
 * 여기서 재는 것은 상태 전이와 불변식이다: 확정이 무엇을 남기고 **무엇을 남기지
 * 않는가**, 그리고 예약이 선 뒤에 어느 문이 닫히는가. 확률·판정은 이 갈래의 것이
 * 아니라 관문의 것이라 다른 자리에서 재진다.
 */
describe("사전 계약 — 계약이 먼저 서고 사람은 나중에 온다", () => {
  const state = createTestGame(42);
  /** 다음 7월 1일 — 발효일이자 연수를 세는 기준 */
  const start = precontractStartOf(state);
  const startYear = Number(start.slice(0, 4));
  /**
   * 창을 여는 것은 협회의 달력이 아니라 **계약의 만료일**이다 — 그 해 12월 31일이면
   * 만료(6월 30일)까지 반년 안이라 창이 열려 있다.
   */
  state.date = `${startYear - 1}-12-31`;
  const outsider = state.players.find(
    (p) => p.teamId !== state.userTeamId && isClubTeam(p.teamId) && activeContract(state, p.id),
  )!;
  activeContract(state, outsider.id)!.until = `${startYear}-06-30`;

  const YEARS = 3;
  const WAGE = 20_000;
  const before = {
    teamId: outsider.teamId,
    wages: weeklyWagesOf(state, state.userTeamId),
    budget: financeOf(state, state.userTeamId).transferBudget,
    balance: financeOf(state, state.userTeamId).balance,
    transfers: state.transfers.length,
  };
  const negotiation = stagedNegotiation(state, {
    id: "neg-pre-fixture",
    kind: "buy",
    playerId: outsider.id,
    counterpartTeamId: outsider.teamId,
    fee: 0,
    weeklyWage: WAGE,
    years: YEARS,
    medical: null,
    precontract: true,
  });
  const settled = acceptDeal(state, negotiation.id);
  const pending = pendingContractOf(state, outsider.id);

  it("확정해도 선수는 옮기지 않는다 — `pending` 계약 한 줄만 선다", () => {
    expect(settled.ok).toBe(true);
    expect(outsider.teamId).toBe(before.teamId);
    expect(pending?.teamId).toBe(state.userTeamId);
    // 옛 계약은 발효일까지 그대로 활성이다 — 발효 전까지 그는 남의 선수다
    expect(activeContract(state, outsider.id)?.teamId).toBe(before.teamId);
    expect(
      state.contracts.filter((c) => c.gamePlayerId === outsider.id && c.status === "pending"),
    ).toHaveLength(1);
  });

  it("원장도 돈도 움직이지 않는다 — 이적료가 없다", () => {
    expect(state.transfers).toHaveLength(before.transfers);
    expect(financeOf(state, state.userTeamId).transferBudget).toBe(before.budget);
    expect(financeOf(state, state.userTeamId).balance).toBe(before.balance);
  });

  it("`pending`은 주급 총액에 세어지지 않는다", () => {
    expect(weeklyWagesOf(state, state.userTeamId)).toBe(before.wages);
  });

  it("연수는 계약일이 아니라 발효일이 센다", () => {
    expect(pending?.since).toBe(start);
    // 계약일(12월 31일)로 세면 한 해 짧은 `${startYear + 2}-06-30`이 된다 (§5-1)
    expect(pending?.until).toBe(`${startYear + YEARS}-06-30`);
  });

  it("같은 선수를 두 번 예약하지 못한다", () => {
    const again = stagedNegotiation(state, {
      id: "neg-pre-fixture-2",
      kind: "buy",
      playerId: outsider.id,
      counterpartTeamId: outsider.teamId,
      fee: 0,
      weeklyWage: WAGE,
      years: YEARS,
      medical: null,
      precontract: true,
    });
    const twice = acceptDeal(state, again.id);
    expect(twice.ok).toBe(false);
    expect(again.status).toBe("expired");
    expect(
      state.contracts.filter((c) => c.gamePlayerId === outsider.id && c.status === "pending"),
    ).toHaveLength(1);
  });

  /**
   * 「방향은 모든 줄에 실린다」의 사전 계약판 (transfer.md §1) — 빠지는 자리를 하나
   * 두면 GM이 「영입」을 읽고 오늘 합류하는 장면을 확정한다.
   */
  it("요약 줄·단건·주의 줄이 모두 갈래를 `사전 계약`으로 적는다", () => {
    const live = stagedNegotiation(state, {
      id: "neg-pre-fixture-3",
      kind: "buy",
      playerId: outsider.id,
      counterpartTeamId: outsider.teamId,
      fee: 0,
      weeklyWage: WAGE,
      years: YEARS,
      medical: null,
      precontract: true,
    });
    expect(describeNegotiations(state)).toContain("사전 계약");
    expect(describeNegotiation(state, live.id)).toContain("사전 계약");
    expect(pendingVerdicts(state).find((v) => v.negotiation.id === live.id)?.subject).toContain(
      "사전 계약",
    );
    live.status = "expired";
  });

  it("남과 약속한 우리 선수에게는 재계약을 열 수 없다", () => {
    const ours = playersOf(state, state.userTeamId)[0]!;
    const rival = state.teams.find((t) => t.id !== state.userTeamId && isClubTeam(t.id))!;
    state.contracts.push({
      id: `c-pre-rival-${ours.id}`,
      gamePlayerId: ours.id,
      teamId: rival.id,
      weeklyWage: 50_000,
      since: start,
      until: `${startYear + 2}-06-30`,
      status: "pending",
    });
    const opened = openRenewal(state, { playerId: ours.id, weeklyWage: 90_000, years: 3 });
    expect(opened.ok).toBe(false);
    expect(opened.message).toContain("다른 구단");
    expect(openNegotiationFor(state, ours.id)).toBeNull();
  });
});

describe("조건서 — 돈 말고 오가는 것", () => {
  function ourPlayer(state: GameState) {
    const player = playersOf(state, state.userTeamId).find((p) => !p.isCaptain)!;
    activeContract(state, player.id)!.until = addDays(state.date, 120);
    return player;
  }

  it("조건 입력은 개수와 인상률 구간 대신 유효한 수치를 검증한다", () => {
    for (const pct of [1, 75, 150]) {
      expect(DealTermSchema.parse({ kind: "escalator", trigger: "title", pct }).pct).toBe(pct);
    }
    for (const pct of [0, -1, Infinity, NaN, 1.5]) {
      expect(DealTermSchema.safeParse({ kind: "escalator", trigger: "title", pct }).success).toBe(
        false,
      );
    }
    const terms = Array.from({ length: 9 }, (_, index) => ({
      kind: "other",
      note: `합의 ${index}`,
    }));
    expect(ProposalInputSchema.parse({ playerId: "p", kind: "terms", terms }).terms).toHaveLength(
      9,
    );
  });

  it("조건 개수 제한 없이 같은 갈래는 고쳐 부르고, 필수 값은 검증한다", () => {
    const state = createTestGame(42);
    const player = ourPlayer(state);
    const talks = openTalks(state, { playerId: player.id });
    if (!talks.ok) throw new Error(talks.message);
    const id = talks.negotiation.id;
    const first = offerTerms(state, {
      negotiationId: id,
      terms: [
        { kind: "captain" },
        { kind: "buyout", fee: 40_000_000 },
        { kind: "escalator", trigger: "europe", pct: 20 },
        { kind: "signing", position: "st" },
        { kind: "number", number: 7 },
        { kind: "bonus", fee: 500_000 },
        { kind: "other", note: "가족 숙소를 구단이 마련한다" },
      ],
    });
    expect(first.ok, first.message).toBe(true);
    const sheet = talks.negotiation.terms!;
    // 금전 조항과 서사 조건을 모두 보존한다.
    expect(sheet.filter((row) => row.term.kind !== "other")).toHaveLength(6);
    expect(sheet.some((row) => row.term.kind === "other")).toBe(true);
    // 같은 갈래를 다시 올리면 값이 바뀔 뿐 둘이 되지 않는다
    offerTerms(state, { negotiationId: id, terms: [{ kind: "buyout", fee: 60_000_000 }] });
    const buyouts = talks.negotiation.terms!.filter((row) => row.term.kind === "buyout");
    expect(buyouts).toHaveLength(1);
    expect(buyouts[0]!.term.fee).toBe(60_000_000);
    // 값이 빈 조건은 서지 않는다
    const empty = offerTerms(state, { negotiationId: id, terms: [{ kind: "number" }] });
    expect(empty.ok).toBe(false);
  });

  it("수비수·골키퍼도 포인트 보너스를 합의하고 실제 골·도움만큼 받는다", () => {
    const state = createTestGame(42);
    const ours = playersOf(state, state.userTeamId);
    for (const group of ["DF", "GK"] as const) {
      const player = ours.find((p) => positionGroupOf(naturalPositionOf(p).position) === group)!;
      expect(proposalViewOf(state, player.id)!.termKinds.renew).toContain("points");
      const talks = openTalks(state, { playerId: player.id });
      if (!talks.ok) throw new Error(talks.message);
      const offered = offerTerms(state, {
        negotiationId: talks.negotiation.id,
        terms: [{ kind: "points", fee: 10_000 }],
      });
      expect(offered.ok, offered.message).toBe(true);
      const contract = activeContract(state, player.id)!;
      contract.terms = talks.negotiation.terms.map((row) => row.term);
      const finance = financeOf(state, state.userTeamId);
      const balance = finance.balance;
      expect(settlePointsBonus(state, player, 0)).toBe(0);
      expect(settlePointsBonus(state, player, 3)).toBe(30_000);
      expect(finance.balance).toBe(balance - 30_000);
      expect(finance.ledger.at(-1)).toMatchObject({ category: "bonus", amount: 30_000 });
    }
  });

  it("서명은 합의 조건을 보존하고 금전 조항을 정산하며 약속 상태를 만들지 않는다", () => {
    const state = createTestGame(42);
    const player = ourPlayer(state);
    const budgetBefore = financeOf(state, state.userTeamId).transferBudget;
    const opened = openRenewal(state, {
      playerId: player.id,
      weeklyWage: Math.round(renewalExpectation(state, player) * 1.2),
      years: 3,
      terms: [
        { kind: "captain" },
        { kind: "buyout", fee: 50_000_000 },
        { kind: "bonus", fee: 1_000_000 },
        { kind: "other", note: "겨울 휴가 이레를 보장한다" },
      ],
    });
    expect(opened.ok, opened.message).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    expect(pendingOffer(negotiation)!.terms).toHaveLength(4);
    state.date = pendingOffer(negotiation)!.respondsOn ?? state.date;
    const accepted = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(accepted.ok, accepted.message).toBe(true);
    const done = acceptDeal(state, negotiation.id);
    expect(done.ok, done.message).toBe(true);
    const contract = activeContract(state, player.id)!;
    expect(contract.buyoutClause).toBe(50_000_000);
    expect(contract.terms?.map((t) => t.kind)).toEqual(["captain", "buyout", "bonus", "other"]);
    expect(contract.terms?.find((t) => t.kind === "bonus")?.settledOn).toBe(state.date);
    expect(state).not.toHaveProperty("promises");
    expect(player.isCaptain).toBe(false);
    const finance = financeOf(state, state.userTeamId);
    expect(finance.transferBudget).toBe(budgetBefore - 1_000_000);
    expect(
      finance.ledger.some((e) => e.category === "signing_bonus" && e.amount === 1_000_000),
    ).toBe(true);
  });

  it("개인 조건을 먼저 굳히면 그 값의 오퍼는 선수 관문이 합의로 선다", () => {
    const state = createTestGame(42);
    state.date = "2026-07-10";
    const player = target(state);
    const wage = Math.round(wageExpectationOf(state, player) * 1.3);
    const proposed = proposePersonal(state, { playerId: player.id, weeklyWage: wage, years: 4 });
    expect(proposed.ok, proposed.message).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    expect(negotiation.personal?.weeklyWage).toBe(wage);
    negotiation.personal!.respondsOn = state.date;
    const answered = answerPersonal(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(answered.ok, answered.message).toBe(true);
    expect(negotiation.personal?.agreedOn).toBe(state.date);
    const offer = { ...offerFor(state, player.id), weeklyWage: wage, years: 4 };
    const sent = sendOffer(state, offer);
    expect(sent.ok, sent.message).toBe(true);
    // 굳은 값을 그대로 실었으므로 선수 쪽 축은 닫혀 있다
    expect(negotiation.personal?.agreedOn).toBe(state.date);
    // 굳은 값 아래로 부르면 합의는 무른다
  });

  it("주급 인상 조항은 사건이 오면 한 번만 오른다", () => {
    const state = createTestGame(42);
    const player = ourPlayer(state);
    const contract = activeContract(state, player.id)!;
    const before = contract.weeklyWage;
    contract.terms = [{ kind: "escalator", trigger: "europe", pct: 75 }];
    settleEscalators(state, { europe: false, title: false, promotion: false }, []);
    expect(contract.weeklyWage).toBe(before);
    const digest: string[] = [];
    settleEscalators(state, { europe: true, title: false, promotion: false }, digest);
    expect(contract.weeklyWage).toBe(Math.round(before * 1.75));
    expect(digest.some((line) => line.includes("주급 인상 조항"))).toBe(true);
    settleEscalators(state, { europe: true, title: false, promotion: false }, []);
    expect(contract.weeklyWage).toBe(Math.round(before * 1.75));
  });
});

/**
 * 제안 폼 — **화면이 정확한 값으로 낸 제안은 채팅으로 낸 것과 같은 문을 지난다**
 * (transfer.md §12-3). 고정하는 것은 갈래가 어느 명령으로 가는가와, 폼이 미리 채우는 자가
 * 코어의 자와 같은가다.
 */
describe("제안 폼 — 구조체가 명령이 된다", () => {
  it("영입 제안은 오퍼가 되고 조건서까지 싣는다", () => {
    const state = createTestGame(42);
    state.date = "2026-07-10";
    const player = target(state);
    const view = proposalViewOf(state, player.id)!;
    expect(view.kinds).toEqual(["buy", "loan"]);

    const sent = applyProposal(state, {
      playerId: player.id,
      kind: "buy",
      fee: 1_000_000,
      weeklyWage: 50_000,
      years: 4,
      squadStatus: "starter",
      terms: [{ kind: "buyout", fee: 60_000_000 }],
    });
    expect(sent.ok, sent.message).toBe(true);
    const negotiation = openNegotiationFor(state, player.id)!;
    expect(negotiation.kind).toBe("buy");
    expect(pendingOffer(negotiation)!.terms?.map((t) => t.kind)).toEqual(["buyout"]);
    // 열린 협상이 있으면 폼의 갈래는 그 하나로 고정된다
    expect(proposalViewOf(state, player.id)!.kinds).toEqual(["buy"]);
    // 이적료가 비면 오퍼가 아니다 — 지어낼 값이 없다
    expect(applyProposal(state, { playerId: player.id, kind: "buy" }).ok).toBe(false);
  });

  it("우리 선수의 제안은 재계약이고, 조건만 올리면 자리부터 연다", () => {
    const state = createTestGame(42);
    const player = playersOf(state, state.userTeamId).find((p) => !p.isCaptain)!;
    const view = proposalViewOf(state, player.id)!;
    expect(view.kinds).toEqual(["renew"]);

    const tabled = applyProposal(state, {
      playerId: player.id,
      kind: "terms",
      terms: [{ kind: "captain" }],
    });
    expect(tabled.ok, tabled.message).toBe(true);
    const talks = openNegotiationFor(state, player.id)!;
    expect(talks.kind).toBe("renew");
    expect(talks.rounds).toHaveLength(0);
    expect(talks.terms?.map((row) => row.term.kind)).toEqual(["captain"]);
    // 빌려 온 선수에게 부를 제안은 원소속과의 영입 하나다 — 재계약은 남의 계약 위의 일이다
    const loanee = playersOf(state, state.userTeamId)[1]!;
    loanee.loan = { fromTeamId: "chelsea", until: "2027-06-30", wageShare: 1 };
    const borrowed = proposalViewOf(state, loanee.id)!;
    expect(borrowed.kinds).toEqual(["buy"]);
    expect(borrowed.loanedFrom).not.toBeNull();
  });

  it("무소속은 자유계약 하나다 — 이적료 없이, 창이 닫혀 있어도", () => {
    const state = createTestGame(42);
    // 창 밖의 날 — 자유계약은 창을 보지 않는다
    state.date = "2026-10-15";
    const player = playersOf(state, state.userTeamId)[5]!;
    releasePlayer(state, { playerId: player.id });
    const view = proposalViewOf(state, player.id)!;
    expect(view.freeAgent).toBe(true);
    expect(view.kinds).toEqual(["buy"]);

    const signed = applyProposal(state, {
      playerId: player.id,
      kind: "buy",
      weeklyWage: 50_000,
      years: 2,
    });
    expect(signed.ok, signed.message).toBe(true);
    expect(openNegotiationFor(state, player.id)!.rounds[0]!.fee).toBe(0);
  });
});

describe("계약 (주급의 원본)", () => {
  it("선수당 활성 계약은 정확히 1건이고 현 소속과 일치한다", () => {
    const state = createTestGame();
    for (const p of state.players) {
      const active = state.contracts.filter(
        (c) => c.gamePlayerId === p.id && c.status === "active",
      );
      expect(active).toHaveLength(1);
      expect(active[0]?.teamId).toBe(p.teamId);
    }
  });

  it("주급은 OVR에 비례한다 (스타가 더 비싸다)", () => {
    const state = createTestGame();
    const squad = [...userPlayers(state)].sort(
      (a, b) => b.attributes.overall - a.attributes.overall,
    );
    const best = activeContract(state, squad[0]!.id)!;
    const worst = activeContract(state, squad[squad.length - 1]!.id)!;
    expect(best.weeklyWage).toBeGreaterThan(worst.weeklyWage);
  });

  it("팀 주급 총액은 저장되지 않고 계약에서 파생된다", () => {
    const state = createTestGame();
    const before = weeklyWagesOf(state, state.userTeamId);
    // 계약 하나를 종료하면 총액이 즉시 줄어든다 (파생값이므로)
    const contract = state.contracts.find(
      (c) => c.status === "active" && c.teamId === state.userTeamId,
    )!;
    contract.status = "ended";
    expect(weeklyWagesOf(state, state.userTeamId)).toBe(before - contract.weeklyWage);
    // 뷰도 파생값을 쓴다
    expect(buildOfficeViews(state).finance.weeklyWages).toBe(
      weeklyWagesOf(state, state.userTeamId),
    );
  });
});

it("an empty transfer table becomes a precontract when its first in-window offer has zero fee", () => {
  const state = createTestGame(42);
  state.date = "2027-01-10";
  const player = target(state);
  activeContract(state, player.id)!.until = "2027-06-30";
  const talks = openTalks(state, { playerId: player.id, kind: "buy" });
  if (!talks.ok) throw new Error(talks.message);
  const id = talks.negotiation.id;
  const sent = sendOffer(state, {
    playerId: player.id,
    kind: "buy",
    fee: 0,
    weeklyWage: wageExpectationOf(state, player),
    years: 3,
  });
  expect(sent.ok, sent.message).toBe(true);
  expect(talks.negotiation.id).toBe(id);
  expect(talks.negotiation.precontract).toBe(true);
  expect(talks.negotiation.rounds).toHaveLength(1);
});

import type { NegotiationAssessment } from "@story-fm/domain";
import {
  applyNegotiationAssessment,
  dueNegotiationFollowups,
  negotiationEvaluationContext,
  negotiationTermsOf,
  negotiationVersion,
  overLimit,
  requestNegotiationEvaluation,
  resolveMedical,
  negotiationChat,
  linkNegotiationChat,
} from "@story-fm/engine";

describe("상대별 교환과 평가 원장", () => {
  const setup = () => {
    const state = createTestGame(42);
    state.date = "2026-07-10";
    const player = target(state);
    const opened = openTalks(state, { playerId: player.id, kind: "buy" });
    if (!opened.ok) throw new Error(opened.message);
    return { state, player, n: opened.negotiation };
  };
  const assessment = (
    n: Negotiation,
    position: NegotiationAssessment["position"] = "review",
  ): NegotiationAssessment => ({
    position,
    conditions: negotiationTermsOf(n),
    alternatives: [],
    factRefs: ["proposal"],
    followup: null,
  });
  it("교환 방식과 거래가 바뀌어도 동일 구단 접촉 기록을 재사용한다", () => {
    const { state, player, n } = setup();
    expect(
      startNegotiation(state, { negotiationId: n.id, party: "club", method: "meeting" }).ok,
    ).toBe(true);
    markSeated(state);
    const exchange = state.pendingNegotiation!.exchangeId;
    state.chat.push({
      role: "user",
      text: "이 선수 이적료를 문의합니다",
      at: state.date,
      toolCalls: [],
    });
    linkNegotiationChat(state, exchange);
    linkNegotiationChat(state, exchange);
    closeNegotiation(state, "left");
    const other = state.players.find((p) => p.teamId === player.teamId && p.id !== player.id)!;
    const next = openTalks(state, { playerId: other.id, kind: "buy" });
    if (!next.ok) throw new Error(next.message);
    startNegotiation(state, {
      negotiationId: next.negotiation.id,
      party: "club",
      method: "proposal",
    });
    expect(state.negotiationContacts).toHaveLength(1);
    expect(state.negotiationExchanges).toHaveLength(2);
    expect(negotiationChat(state, next.negotiation, "club")).toHaveLength(1);
    expect(negotiationChat(state, next.negotiation, "club")[0]).toBe(state.chat[0]);
    expect(state.chat[0]!.negotiationExchangeId).toBe(exchange);
    expect(state.chat[0]!.negotiationId).toBe(n.id);
    expect(negotiationChat(state, next.negotiation, "agent")).toHaveLength(0);
  });
  it("대화 중에는 예약하지 않고 종료 평가만 한 번 예약한다", () => {
    const { state, n } = setup();
    const e = requestNegotiationEvaluation(state, {
      negotiationId: n.id,
      party: "club",
    })!;
    const result = assessment(n);
    result.followup = { purpose: "response", days: 3, requiresDecision: false };
    expect(applyNegotiationAssessment(state, e.id, result).ok).toBe(false);
    expect(state.negotiationFollowups).toHaveLength(0);
    expect(applyNegotiationAssessment(state, e.id, assessment(n)).ok).toBe(true);
    const ending = requestNegotiationEvaluation(state, {
      negotiationId: n.id,
      party: "club",
      ending: true,
    })!;
    expect(ending.id).not.toBe(e.id);
    expect(applyNegotiationAssessment(state, ending.id, result).ok).toBe(true);
    expect(
      requestNegotiationEvaluation(state, {
        negotiationId: n.id,
        party: "club",
        ending: true,
      })!.id,
    ).toBe(ending.id);
    expect(applyNegotiationAssessment(state, ending.id, result).ok).toBe(true);
    expect(state.negotiationFollowups).toHaveLength(1);
    expect(dueNegotiationFollowups(state)).toHaveLength(0);
    state.date = addDays(state.date, 3);
    expect(dueNegotiationFollowups(state)).toHaveLength(1);
  });
  it("종료 평가는 이미 받은 수정안을 바꾸거나 같은 응답 라운드를 다시 쌓지 않는다", () => {
    const { state, n, player } = setup();
    sendOffer(state, { playerId: player.id, fee: 1000, weeklyWage: 0, years: 0 });
    const reply = requestNegotiationEvaluation(state, { negotiationId: n.id, party: "club" })!;
    const counter = assessment(n, "counter");
    counter.conditions.fee = 2000;
    expect(applyNegotiationAssessment(state, reply.id, counter).ok).toBe(true);
    const rounds = structuredClone(state.negotiations.find((entry) => entry.id === n.id)!.rounds);
    const ending = requestNegotiationEvaluation(state, {
      negotiationId: n.id,
      party: "club",
      ending: true,
    })!;
    expect(
      applyNegotiationAssessment(state, ending.id, {
        ...counter,
        conditions: { ...counter.conditions, fee: 3000 },
      }).ok,
    ).toBe(false);
    expect(
      applyNegotiationAssessment(state, ending.id, {
        ...counter,
        followup: { purpose: "response", days: 2, requiresDecision: true },
      }).ok,
    ).toBe(true);
    expect(state.negotiations.find((entry) => entry.id === n.id)!.rounds).toEqual(rounds);
    expect(state.negotiationFollowups.filter((event) => event.status === "pending")).toHaveLength(
      1,
    );
  });
  it("바뀐 조건과 무관한 근거를 가진 결과는 계약과 후속 일정을 바꾸지 못한다", () => {
    const { state, n, player } = setup();
    const e = requestNegotiationEvaluation(state, { negotiationId: n.id, party: "club" })!;
    const bad = assessment(n);
    bad.factRefs = ["invented"];
    expect(applyNegotiationAssessment(state, e.id, bad).ok).toBe(false);
    expect(sendOffer(state, { playerId: player.id, fee: 1000, weeklyWage: 0, years: 0 }).ok).toBe(
      true,
    );
    expect(applyNegotiationAssessment(state, e.id, assessment(n)).ok).toBe(false);
    expect(state.negotiationEvaluations[0]!.status).toBe("stale");
    expect(state.negotiationFollowups).toHaveLength(0);
  });
  it("구단 평가가 개인 조건을 승인하거나 바꾸지 못한다", () => {
    const { state, n, player } = setup();
    sendOffer(state, { playerId: player.id, fee: 1000, weeklyWage: 20_000, years: 3 });
    const e = requestNegotiationEvaluation(state, { negotiationId: n.id, party: "club" })!;
    const invalidDuration = assessment(n, "counter");
    invalidDuration.conditions.paymentYears = 5;
    expect(applyNegotiationAssessment(state, e.id, invalidDuration).ok).toBe(false);
    const bad = assessment(n, "agree");
    bad.conditions.weeklyWage++;
    expect(applyNegotiationAssessment(state, e.id, bad).ok).toBe(false);
    expect(applyNegotiationAssessment(state, e.id, assessment(n, "agree")).ok).toBe(true);
    const live = state.negotiations.find((x) => x.id === n.id)!;
    expect(live.feeAgreed?.fee).toBe(1000);
    expect(live.status).toBe("open");
    expect(activeContract(state, player.id)!.teamId).not.toBe(state.userTeamId);
    const personal = requestNegotiationEvaluation(state, { negotiationId: n.id, party: "agent" })!;
    const invalidAlternative = assessment(live);
    invalidAlternative.alternatives = [{ ...negotiationTermsOf(live), fee: 1 }];
    expect(applyNegotiationAssessment(state, personal.id, invalidAlternative).ok).toBe(false);
  });
  it("합의 해지의 동의는 정산금까지 정확히 일치해야 한다", () => {
    const state = createTestGame(42);
    const p = userPlayers(state)[0]!;
    expect(openRelease(state, { playerId: p.id, severance: 100 }).ok).toBe(true);
    const n = openNegotiationFor(state, p.id)!;
    const e = requestNegotiationEvaluation(state, { negotiationId: n.id, party: "agent" })!;
    const result = assessment(n, "agree");
    result.conditions.fee = 101;
    expect(applyNegotiationAssessment(state, e.id, result).ok).toBe(false);
    result.conditions.fee = 100;
    result.conditions.paymentYears = 2;
    expect(applyNegotiationAssessment(state, e.id, result).ok).toBe(false);
    expect(n.status).toBe("open");
    expect(state.negotiationFollowups).toHaveLength(0);
  });
  it("합의 전 메디컬 예약은 원자적으로 거절하고 검진은 실제 부상만 기록한다", () => {
    const { state, n, player } = setup();
    const e = requestNegotiationEvaluation(state, {
      negotiationId: n.id,
      party: "club",
      ending: true,
    })!;
    const result = assessment(n);
    result.followup = { purpose: "medical", days: 1, requiresDecision: false };
    expect(applyNegotiationAssessment(state, e.id, result).ok).toBe(false);
    expect(n.medical).toBeUndefined();
    expect(state.negotiationFollowups).toHaveLength(0);
    const before = player.state.injuryProneness;
    state.injuries = state.injuries.filter((i) => i.gamePlayerId !== player.id);
    expect(resolveMedical(state, n, player).passed).toBe(true);
    expect(player.state.injuryProneness).toBe(before);
    expect(n.status).toBe("open");
  });
  it("위임에서 비운 축은 무제한 권한이 아니며 개인 정보는 상대에게 넘어가지 않는다", () => {
    const { state, n, player } = setup();
    n.mandate = { fee: 1000 };
    expect(overLimit(state, n, player, { fee: 500, weeklyWage: 100, contractYears: 2 })).toContain(
      "권한",
    );
    const context = JSON.stringify(negotiationEvaluationContext(state, n, "club"));
    expect(context).not.toContain('"mandate"');
    const version = negotiationVersion(state, n, "club");
    state.finances.find((f) => f.teamId === state.userTeamId)!.transferBudget++;
    expect(negotiationVersion(state, n, "club")).toBe(version);
  });
  it("상대 캐릭터북 갱신은 평가 문맥과 버전에 반영하고 낡은 응답을 거절한다", () => {
    const { state, n } = setup();
    for (const party of ["club", "agent"] as const) {
      const persona = negotiationEvaluationContext(state, n, party)!.facts.persona!;
      expect(persona).toBeDefined();
      const id = `person:${persona.characterId}`;
      state.characterBook = state.characterBook.filter((entry) => entry.id !== id);
      expect(negotiationEvaluationContext(state, n, party)!.facts.persona!.characterBook).toEqual({
        name: persona.characterBook.name,
        keywords: persona.characterBook.keywords,
        description: persona.characterBook.description,
        information: persona.characterBook.information,
      });
      const pending = requestNegotiationEvaluation(state, { negotiationId: n.id, party })!;
      expect(pending).not.toBeNull();
      const version = negotiationVersion(state, n, party);
      const updated = {
        name: persona.characterBook.name,
        keywords: persona.characterBook.keywords,
        description: persona.characterBook.description,
        information: "현재 논의에서 선수의 장기 계획을 먼저 확인하기로 합의했다.",
      };
      state.characterBook.push({ ...updated, id, kind: "person", version: 2 });
      expect(
        negotiationEvaluationContext(state, n, party)!.facts.persona!.characterBook,
      ).toMatchObject(updated);
      expect(negotiationVersion(state, n, party)).not.toBe(version);
      expect(applyNegotiationAssessment(state, pending.id, assessment(n)).ok).toBe(false);
    }
  });
});

import { closeNegotiation, markSeated, startNegotiation } from "@story-fm/engine";

import { pendingContractOf } from "@story-fm/engine";

describe("검증된 조건 묶음의 승인", () => {
  it("추가 조항은 감독이 묶음을 승인한 뒤 한 번만 계약과 현금에 반영된다", () => {
    const state = createTestGame(42);
    const player = userPlayers(state)[0]!;
    expect(openRenewal(state, { playerId: player.id, weeklyWage: 1000, years: 3 }).ok).toBe(true);
    const n = openNegotiationFor(state, player.id)!;
    const e = requestNegotiationEvaluation(state, { negotiationId: n.id, party: "agent" })!;
    const result: NegotiationAssessment = {
      position: "counter",
      conditions: {
        ...negotiationTermsOf(n),
        weeklyWage: 1500,
        terms: [{ kind: "bonus", fee: 100 }],
      },
      alternatives: [],
      factRefs: ["contract"],
      followup: null,
    };
    expect(applyNegotiationAssessment(state, e.id, result).ok).toBe(true);
    expect(activeContract(state, player.id)!.weeklyWage).not.toBe(1500);
    expect(acceptDeal(state, n.id).ok).toBe(true);
    const proposed = state.negotiations.find((x) => x.id === n.id)!;
    expect(pendingOffer(proposed)!.terms).toEqual([{ kind: "bonus", fee: 100 }]);
    const accepted = requestNegotiationEvaluation(state, { negotiationId: n.id, party: "agent" })!;
    expect(
      applyNegotiationAssessment(state, accepted.id, {
        ...result,
        position: "agree",
        conditions: negotiationTermsOf(proposed),
      }).ok,
    ).toBe(true);
    const before = financeOf(state, state.userTeamId).balance;
    expect(acceptDeal(state, n.id).ok).toBe(true);
    expect(activeContract(state, player.id)!.weeklyWage).toBe(1500);
    expect(financeOf(state, state.userTeamId).balance).toBe(before - 100);
    expect(acceptDeal(state, n.id).ok).toBe(false);
    expect(financeOf(state, state.userTeamId).balance).toBe(before - 100);
  });
  it("실제 폼 변화는 평가를 갱신하고 동일 선수의 다른 상대 구단은 다른 거래다", () => {
    const state = createTestGame(42);
    const p = userPlayers(state)[0]!;
    const teams = state.teams
      .filter((t) => t.id !== state.userTeamId && isClubTeam(t.id))
      .slice(0, 2);
    const first = openTalks(state, {
      playerId: p.id,
      kind: "sell",
      counterpartTeamId: teams[0]!.id,
    });
    const second = openTalks(state, {
      playerId: p.id,
      kind: "sell",
      counterpartTeamId: teams[1]!.id,
    });
    if (!first.ok || !second.ok) throw new Error("문의 개설 실패");
    expect(first.negotiation.id).not.toBe(second.negotiation.id);
    const e = requestNegotiationEvaluation(state, {
      negotiationId: first.negotiation.id,
      party: "club",
    })!;
    expect(
      applyNegotiationAssessment(state, e.id, {
        position: "review",
        conditions: negotiationTermsOf(first.negotiation),
        alternatives: [],
        factRefs: ["player"],
        followup: null,
      }).ok,
    ).toBe(true);
    playerById(state, p.id)!.state.form -= 0.1;
    expect(
      requestNegotiationEvaluation(state, { negotiationId: first.negotiation.id, party: "club" })!
        .id,
    ).not.toBe(e.id);
  });
});
