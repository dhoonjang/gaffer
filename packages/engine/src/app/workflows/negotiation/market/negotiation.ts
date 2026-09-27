import {
  type GameState,
  playerById,
  playersOf,
  transferRequestOf,
  clearInterests,
  activeContract,
  financeOf,
  teamName,
  pushNarrative,
  squadShortfall,
  voidPendingContract,
  releaseFromTactics,
} from "../../../../common/core/state";
import {
  type TickSink,
  type GamePlayer,
  type Interest,
  josa,
  type Negotiation,
  type Contract,
  SQUAD_STATUS_KO,
  josaOf,
  type Transfer,
  registrationBlockText,
  MAX_PAYMENT_YEARS,
  ageOf,
} from "@story-fm/domain";
import {
  incomingOffers,
  MAX_INCOMING,
  liveNegotiationFor,
  recentlyRejected,
  LISTED_OFFER_CHANCE,
  listingOf,
  REQUEST_REFUSED_COOLDOWN_DAYS,
  REQUESTED_OFFER_CHANCE,
  INCOMING_OFFER_CHANCE,
  pickBuyer,
  BUYOUT_REACH,
  minDate,
  NEGOTIATION_DAYS,
  LISTED_DISCOUNT,
  REQUESTED_DISCOUNT,
  agreedSquadStatus,
  agreedTermsOf,
  clearIssueReason,
  statusLabel,
  standingCounter,
  acceptCounterTerms,
  proposePersonal,
  passMedicalGate,
  executeLoanIn,
  executeLoanOut,
  executePrecontract,
  affordabilityGate,
  agreedSquadNumber,
  SPLIT_YEARS,
  medicalFlagResult,
  AI_RENEWAL_WINDOW_DAYS,
  RENEWAL_URGENCY_STARTER,
  RENEWAL_URGENCY_ROTATION,
  RENEWAL_URGENCY_FRINGE,
  RENEWAL_VETERAN_AGE,
  RENEWAL_VETERAN_URGENCY,
  RENEWAL_YOUNG_AGE,
  RENEWAL_YOUNG_URGENCY,
  AI_RENEWAL_CHANCE,
  RENEWAL_YEARS_MIN,
  RENEWAL_YEARS_SPAN,
  RENEWAL_WAGE_BASE,
  RENEWAL_WAGE_SPAN,
} from "../../../../negotiation/market/negotiation";
import { windowOpenOn } from "../../../../common/core/calendar";
import {
  windowOpenForTeam,
  loanLockOf,
  marketValueOf,
  deadlineRushOf,
  marketBiasOf,
  deadlinePremiumOf,
  wageExpectationOf,
  dealOdds,
  loanedInBy,
  contractOwnerOf,
  paymentYearsOf,
  firstInstallmentOf,
  squadShortfallText,
  transferWindowLabel,
} from "../../../../negotiation/market/market";
import { makeRng } from "../../../../common/core/rng";
import { diffDays, addDays, contractUntil } from "../../../../common/core/dates";
import { formatMoney, settlePlayerFee } from "../../../../negotiation/finance/finance";
import { COUNTERPARTY_ACCEPT_AT } from "../../../../negotiation/market/counter-bounds";
import { type CommandResult } from "../../../../common/commands/result";
import { releasePlayer } from "./departures";
import { settleTermsOnSigning, promisedNumberOf } from "../../../../negotiation/market/terms";
import { withdrawRetirement } from "../../../../common/players/career";
import { item } from "../../../../common/commands/brief";
import { needsMedical, resolveMedicals } from "../../../../negotiation/market/medical";
import { isFreeAgent, clearDepartedState } from "../../../../negotiation/market/departures";
import { attachClauses, settleSellOn } from "../../../../negotiation/market/clauses";
import { consumeEarmark } from "../../../../negotiation/finance/board-request";
import {
  assignRequestedNumber,
  assignSquadNumber,
  numberLineageOf,
  numberBlockText,
} from "../../../../common/players/numbers";
import { canRegisterFor, arrivingSquadLevel } from "../../../../common/players/registration";
import { buildTransferPress } from "../../../../story/world/press";
import { openPress } from "../../story/world/press";
import { squadDepthOf } from "../../../../common/players/squad-depth";
import { attachAiBuyout } from "../../../../negotiation/market/buyout";

/**
 * 들어오는 오퍼 생성 — tick이 매일 부른다.
 *
 * 아무 선수에게나 오지 않는다. **자리가 막혀 있거나 사기가 낮은 선수**, 그리고
 * 값이 나가는 선수에게 온다 (실제로도 에이전트가 그런 선수를 움직인다).
 * 사는 구단은 그 자리가 우리보다 약하고 예산이 되는 곳에서 고른다.
 */
export function generateIncomingOffers(state: GameState, digest: TickSink): void {
  // **창은 사는 쪽 협회 것을 본다.** 우리 창이 닫혀도 사우디·MLS는 계속 노린다
  if (incomingOffers(state).length >= MAX_INCOMING) return;
  const anyWindowOpen =
    windowOpenOn(state.windows, state.date) !== null ||
    state.teams.some((t) => windowOpenForTeam(state, t.id) !== null);
  if (!anyWindowOpen) return;

  const rng = makeRng(state.seed, `incoming:${state.date}`);
  /**
   * 지금 오퍼가 붙을 수 있는 선수인가 — **살아 있는 협상과 최근의 거절만** 막는다.
   *
   * ⚠️ 협상 **이력**으로 거르면 안 된다 — 협상 기록은 시즌이 바뀌어도 지워지지
   * 않으므로, `status !== "expired"`류의 조건은 **영구 배제**가 된다: 오퍼를 한 번
   * 거절한 선수도, `completed` 이력이 남은 직접 영입 선수도 두 번 다시 오퍼를
   * 못 받는다. 이적 리스트 등재도 같은 필터를 지나므로 등재가 무력해진다.
   */
  const free = (p: GamePlayer) =>
    // 빌려 온 선수는 우리 `teamId`를 달고 있어도 남의 계약이라 오퍼가 붙지 않는다
    loanLockOf(p) === null &&
    liveNegotiationFor(state, p.id) === null &&
    !recentlyRejected(state, p.id);

  /**
   * **등재된 선수가 먼저다.** 감독이 값을 부르며 내놓은 선수에게는 확률이 다르게
   * 걸린다 — 그게 "판다"는 결정이 세계에 닿는 통로다. 호가가 시장가보다 높으면
   * 그만큼 더디 붙는다.
   */
  const listed = state.transferList
    .map((l) => ({ listing: l, player: playerById(state, l.gamePlayerId) }))
    .filter(
      (x): x is { listing: (typeof state.transferList)[number]; player: GamePlayer } =>
        x.player !== null && x.player.teamId === state.userTeamId && free(x.player),
    );
  if (listed.length > 0) {
    const pick = listed[Math.floor(rng() * listed.length)]!;
    const market = marketValueOf(state, pick.player);
    // 비싸게 부르면 관심이 준다 (호가/시장가로 확률을 깎는다)
    const priceAppeal = Math.max(
      0.25,
      Math.min(1.4, market / Math.max(1, pick.listing.askingPrice)),
    );
    /**
     * **마감 주에는 몰린다** (transfer.md §1-3). 사는 구단은 아직 정해지지 않았으므로
     * 재는 창은 **우리 것**이다 — 우리 창이 닫힌 날은 배수가 1이라, 사우디 창 하나
     * 때문에 우리 리스트가 통째로 마감 주가 되는 일이 없다.
     */
    const rush = deadlineRushOf(state, state.userTeamId);
    if (rng() < Math.min(1, LISTED_OFFER_CHANCE * priceAppeal * rush)) {
      openListedOffer(state, pick.player, pick.listing.askingPrice, rng, digest);
      return;
    }
  }

  /**
   * **이적 요청이 선 선수가 그다음이다** (transfer.md §1-1). 감독이 내놓지
   * 않았어도 나가고 싶어 하는 것을 시장이 알고, 그만큼 시장가 아래로 들어온다.
   *
   * 감독이 답한 요청에는 이 확률이 걸리지 않는다 — 수락한 선수는 이미 리스트에
   * 올라 위의 리스트 확률이 태우고(등재된 선수에게 요청 확률이 다시 걸리면 같은
   * 선수에게 하루 확률이 두 번 구른다 — transfer.md §11), 거부한 선수는
   * `REQUEST_REFUSED_COOLDOWN_DAYS` 동안 식는다: 안 판다고 했는데 시장이 계속
   * 두드리면 거부가 아무것도 아닌 것이 된다.
   */
  const requested = playersOf(state, state.userTeamId).filter((p) => {
    if (!free(p)) return false;
    const request = transferRequestOf(state, p.id);
    if (!request) return false;
    if (request.answer === "accept" || listingOf(state, p.id) !== null) return false;
    if (request.answer === "refuse" && request.answeredOn !== undefined) {
      return diffDays(request.answeredOn, state.date) >= REQUEST_REFUSED_COOLDOWN_DAYS;
    }
    return true;
  });
  if (requested.length > 0) {
    const pick = requested[Math.floor(rng() * requested.length)]!;
    // 리스트 갈래와 같은 자 — 사는 구단이 없으므로 우리 창으로 마감 주를 잰다
    const rush = deadlineRushOf(state, state.userTeamId);
    if (rng() < Math.min(1, REQUESTED_OFFER_CHANCE * rush)) {
      openRequestedOffer(state, pick, rng, digest);
      return;
    }
  }

  /**
   * **그 밖의 오퍼는 관심에서만 나온다** (→ docs/negotiation/transfer.md §1-2).
   *
   * 사는 구단을 여기서 다시 고르지 않는다 — `bidding`까지 올라온 줄의 주인이 곧
   * 값을 부르는 구단이다. 관심 없이 도착하는 오퍼는 감독에게 사건이 아니라
   * 사고다: 그 앞에 아무 소리도 없었으므로 준비할 자리도, 회견에서 물을 것도,
   * 재계약 테이블에서 쓸 카드도 없다.
   */
  const bidding = state.interests
    .map((interest) => ({ interest, player: playerById(state, interest.gamePlayerId) }))
    .filter(
      (x): x is { interest: Interest; player: GamePlayer } =>
        x.interest.stage === "bidding" &&
        x.player !== null &&
        x.player.teamId === state.userTeamId &&
        free(x.player),
    );
  if (bidding.length === 0) return;

  /**
   * **줄을 먼저 고르고 그 구단의 창으로 마감 주를 잰다** — 여기서는 사는 구단이 이미
   * 그 줄의 주인이라, 우리 창으로 재면 9월의 사우디 마감이 조용해지고 8월 말의 우리
   * 마감이 사우디의 오퍼까지 몰아붙인다.
   */
  const bid = bidding[Math.floor(rng() * bidding.length)]!;
  if (rng() > Math.min(1, INCOMING_OFFER_CHANCE * deadlineRushOf(state, bid.interest.teamId))) {
    return;
  }
  const marketValue = marketValueOf(state, bid.player);
  const opened = openIncomingSellOffer(
    state,
    bid.player,
    rng,
    digest,
    // 처음엔 시장가보다 낮게 부른다 (75~100%) — 흥정의 여지를 남긴다
    (feeBias) => Math.round((marketValue * (0.75 + rng() * 0.25) * feeBias) / 100_000) * 100_000,
    ({ buyerName, fee, expiresOn }) =>
      `${josa(buyerName, "이/가")} ${bid.player.name} 영입 오퍼를 넣었습니다 — ${formatMoney(fee)} (기한 ${expiresOn})`,
    bid.interest.teamId,
  );
  // 사다리의 끝 — 그 사실은 이제 협상이 든다. 창이 닫혀 못 열렸으면 줄은 남는다
  if (opened) clearInterests(state, (i) => i === bid.interest);
}

/**
 * 우리 선수에게 매각 오퍼 하나가 붙는다 — **구단 고르기·창·협상 레코드·서사는
 * 어느 갈래든 같다.** 갈래마다 다른 것은 값의 기준(`quote`)과 다이제스트 한 줄뿐.
 */
function openIncomingSellOffer(
  state: GameState,
  player: GamePlayer,
  rng: () => number,
  digest: TickSink,
  quote: (feeBias: number) => number,
  line: (ctx: { buyerName: string; fee: number; expiresOn: Negotiation["expiresOn"] }) => string,
  /** 이미 정해진 구단 — 관심 갈래는 장부의 줄이 주인을 갖고 온다 (§1-2) */
  from?: string,
): boolean {
  const buyer = from ?? pickBuyer(state, player, rng);
  if (!buyer) return false;
  const window = windowOpenForTeam(state, buyer);
  if (!window) return false;

  const bias = marketBiasOf(state, buyer);
  /**
   * **마감 주의 오퍼는 값이 시장가 위로 온다** (transfer.md §1-3) — 세 갈래가 여기
   * 한 자리에서 함께 탄다. 갈래마다 곱하면 배수가 세 벌이 되고, `sellOdds`가 같은
   * 수로 올리는 사는 쪽 상한(`deadlinePremiumOf`)과 어긋난다.
   */
  const quoted = quote(bias.fee * deadlinePremiumOf(state, buyer));
  /**
   * **바이아웃 조항이 닿는 값이면 사는 쪽은 조항을 부른다** (transfer.md §12-3) — 흥정할
   * 이유가 없다. 닿는다는 것은 부르려던 값을 `BUYOUT_REACH`만큼 늘려 조항에 닿고, 그
   * 구단의 이적 예산이 그 값을 감당한다는 뜻이다.
   */
  const clause = activeContract(state, player.id)?.buyoutClause;
  const triggered =
    clause !== undefined &&
    clause > 0 &&
    quoted * BUYOUT_REACH >= clause &&
    financeOf(state, buyer).transferBudget >= clause;
  const fee = triggered ? clause : quoted;
  const wage = Math.round(wageExpectationOf(state, player) * (1.05 + rng() * 0.2) * bias.wage);
  const negotiation: Negotiation = {
    id: `neg-in-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    kind: "sell",
    precontract: false,
    buyout: false,
    pitched: [],
    terms: [],
    counterpartTeamId: buyer,
    windowId: window.id,
    openedOn: state.date,
    /**
     * 창을 넘겨 살아 있는 협상은 없다. **마감 주에 온 오퍼의 기한은 곧 마감일이다**
     * — 그날 `standsToday`(core/tick.ts)가 시계를 세우므로 데드라인 데이가 감독의
     * 하루가 된다 (transfer.md §1-3 · season.md §5).
     */
    expiresOn: minDate(addDays(state.date, NEGOTIATION_DAYS), window.closesOn),
    status: "open",
    rounds: [
      {
        date: state.date,
        by: "them",
        fee,
        weeklyWage: wage,
        contractYears: 4,
        respondsOn: null,
        probability: dealOdds(state, {
          playerId: player.id,
          fee,
          weeklyWage: wage,
          years: 4,
          kind: "sell",
          counterpartTeamId: buyer,
        }).probability,
        verdict: null,
      },
    ],
  };
  state.negotiations.push(negotiation);
  if (triggered) {
    settleBuyoutOffer(state, negotiation, player, digest);
    return true;
  }
  digest.push(line({ buyerName: teamName(buyer), fee, expiresOn: negotiation.expiresOn }));
  pushNarrative(state, `${teamName(buyer)}의 ${player.name} 오퍼 (${formatMoney(fee)})`, 3);
  return true;
}

/**
 * **조항이 발동한 오퍼는 구단이 답할 자리가 없다** (transfer.md §12-3). 남는 것은 선수의
 * 결정이다 — 매각의 선수 관문이 사다리의 수락 문턱을 넘으면 가고, 못 넘으면 남는다.
 * 가면 그 자리에서 합의가 서고 메디컬이 잡힌다; 감독이 막을 수 없으니 `blocked-move`
 * 불만도 서지 않는다.
 */
function settleBuyoutOffer(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
  digest: TickSink,
): void {
  const offer = negotiation.rounds[0]!;
  const buyer = negotiation.counterpartTeamId ?? "";
  negotiation.buyout = true;
  const odds = dealOdds(state, {
    playerId: player.id,
    fee: offer.fee,
    weeklyWage: offer.weeklyWage,
    years: offer.contractYears,
    kind: "sell",
    counterpartTeamId: buyer,
  });
  const goes = odds.gates.player >= COUNTERPARTY_ACCEPT_AT;
  if (!goes) {
    offer.verdict = "reject";
    offer.note = "선수가 남기로 했다";
    negotiation.status = "rejected";
    digest.push(
      `${josa(teamName(buyer), "이/가")} ${player.name}의 바이아웃 조항 ${formatMoney(offer.fee)}을 불렀지만 ` +
        `선수가 남기로 했습니다 (선수 관문 ${odds.gates.player}%)`,
    );
    pushNarrative(state, `${player.name} 바이아웃 조항 오퍼 — 선수가 잔류 선택`, 3);
    return;
  }
  offer.verdict = "accept";
  offer.note = "바이아웃 조항 — 구단이 막을 수 없다";
  negotiation.status = "agreed";
  // 합의는 섰다 — 메디컬은 감독이 아니라 계약서가 잡는다
  const scheduled = acceptDeal(state, negotiation.id);
  digest.push(
    `${josa(teamName(buyer), "이/가")} ${player.name}의 바이아웃 조항 ${formatMoney(offer.fee)}을 불렀습니다 — ` +
      `구단이 막을 수 없고 선수는 가기로 했습니다` +
      (scheduled.ok ? `. ${scheduled.message}` : ""),
  );
  pushNarrative(
    state,
    `${player.name} 바이아웃 조항 발동 — ${teamName(buyer)} (${formatMoney(offer.fee)})`,
    4,
  );
}

/**
 * 등재 선수에게 오퍼가 붙는다 — 값은 **호가에서 깎고 들어온다.**
 * "얼마면 팔겠다"를 이미 밝힌 상태라 시장가가 아니라 그 숫자가 기준이 된다.
 */
function openListedOffer(
  state: GameState,
  player: GamePlayer,
  askingPrice: number,
  rng: () => number,
  digest: TickSink,
): void {
  openIncomingSellOffer(
    state,
    player,
    rng,
    digest,
    (feeBias) =>
      Math.round((askingPrice * (1 - LISTED_DISCOUNT * rng()) * feeBias) / 100_000) * 100_000,
    ({ buyerName, fee, expiresOn }) =>
      `${josa(buyerName, "이/가")} 이적 리스트의 ${player.name}에게 오퍼를 넣었습니다 — ${formatMoney(fee)} (호가 ${formatMoney(askingPrice)} · 기한 ${expiresOn})`,
  );
}

/**
 * 이적 요청이 선 선수에게 오퍼가 붙는다 — 값은 **시장가 아래로 온다.**
 * 나가고 싶어 하는 것을 시장이 알고, 그만큼 깎고 들어온다.
 */
function openRequestedOffer(
  state: GameState,
  player: GamePlayer,
  rng: () => number,
  digest: TickSink,
): void {
  const market = marketValueOf(state, player);
  openIncomingSellOffer(
    state,
    player,
    rng,
    digest,
    (feeBias) =>
      Math.round((market * (1 - REQUESTED_DISCOUNT * rng()) * feeBias) / 100_000) * 100_000,
    ({ buyerName, fee, expiresOn }) =>
      `${josa(buyerName, "이/가")} 이적을 요청한 ${player.name}에게 오퍼를 넣었습니다 — ${formatMoney(fee)} (기한 ${expiresOn})`,
  );
}

/**
 * 해지 실행 — 값이 정해진 뒤의 종착지는 **일방 해지와 같은 문**이다.
 * 임대 잠금·소속·스쿼드 하한·잔고를 거기서 다시 본다 (합의와 확정 사이가 며칠이다).
 */
function executeRelease(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
): CommandResult {
  const done = releasePlayer(state, {
    playerId: negotiation.gamePlayerId,
    severance: agreed.fee,
    ...(agreed.paymentYears === undefined ? {} : { paymentYears: agreed.paymentYears }),
  });
  if (!done.ok) {
    negotiation.status = "expired";
    return done;
  }
  negotiation.status = "completed";
  return done;
}

function executeRenewal(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
): CommandResult {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  if (player.teamId !== state.userTeamId) {
    negotiation.status = "expired";
    return { ok: false, message: `${josa(player.name, "은/는")} 이미 우리 선수가 아닙니다` };
  }
  // 빌려 온 선수의 재계약은 남의 계약을 우리 것으로 바꿔치기하는 일이다
  const locked = loanLockOf(player);
  if (locked) {
    negotiation.status = "expired";
    return { ok: false, message: locked };
  }
  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  const squadStatus = agreedSquadStatus(state, negotiation, agreed, player);
  const contract: Contract = {
    id: `c-${player.id}-renew-${state.date}`,
    gamePlayerId: player.id,
    teamId: state.userTeamId,
    weeklyWage: agreed.weeklyWage,
    since: state.date,
    until: contractUntil(state.date, agreed.contractYears),
    status: "active",
    squadStatus,
  };
  state.contracts.push(contract);
  // 조건서가 제자리로 흩어진다 — 약속 장부·조항·사본 (§12-3)
  const termNotes = settleTermsOnSigning(
    state,
    contract,
    player,
    agreedTermsOf(negotiation, agreed),
    {
      renewal: true,
    },
  );
  negotiation.status = "completed";
  /**
   * **이 불만을 푸는 것은 성사 하나뿐이다** (→ docs/story/people.md §5·§8). 협상을
   * 여는 것(`openRenewal`)은 압력을 멈출 뿐이라 불만은 그대로 있고, 계약이 실제로
   * 갈아 끼워진 이 자리에서만 풀린다.
   */
  const freed = clearIssueReason(state, player.id, "contract");
  /**
   * **재계약이 예고를 거둔다 — 나이 상한 안에서** (season.md §6). 감독이 한 시즌을 더
   * 설득한 것이 장부에 남지 않으면 1월의 예고가 7월에 그대로 집행돼, 방금 도장을 찍은
   * 선수가 그 계약을 한 경기도 쓰지 않고 그만둔다. 판정일에 이미 `RETIRE_AGE`면 거둘 수
   * 없다 — 서른다섯의 몸을 계약서가 되돌리지는 못한다.
   */
  const stays = withdrawRetirement(state, player);
  pushNarrative(
    state,
    `${player.name} 재계약 — 주급 ${formatMoney(agreed.weeklyWage)} ${agreed.contractYears}년`,
    4,
  );
  return {
    ok: true,
    message:
      `${player.name} 재계약 완료 — 주급 ${formatMoney(agreed.weeklyWage)}, ` +
      `${contractUntil(state.date, agreed.contractYears)}까지${statusLabel(squadStatus)}. ` +
      "주급 총액이 늘어납니다" +
      (freed ? " · 계약 불만이 풀렸습니다" : "") +
      (stays ? " · 은퇴 예고를 거뒀습니다" : "") +
      (termNotes.length > 0 ? ` · ${termNotes.join(" · ")}` : ""),
    brief: {
      head: "재계약",
      items: [
        item({ label: "선수", text: player.name }),
        item({
          label: "주급",
          text: formatMoney(agreed.weeklyWage),
          note: `${contractUntil(state.date, agreed.contractYears)}까지`,
        }),
        // 지위는 약속이라 요약에 선다 — 어겼을 때 라커룸이 세는 것이 이 줄이다
        item({ label: "계약 지위", text: SQUAD_STATUS_KO[squadStatus] }),
        ...termNotes.map((text) => item({ label: "조건", text })),
      ],
    },
  };
}

/**
 * 합의를 실행한다 — 여기서 장부가 움직인다.
 *
 * 합의(`agreed`)와 완료(`completed`)를 나눈 이유: 구단 합의 뒤에도 감독이 물러설
 * 수 있고, 실제 이적도 두 단계다. 예산·스쿼드 하한 검증은 이 시점에 한다 —
 * 합의 후 며칠 사이에 예산이 바뀔 수 있다.
 *
 * ⚠️ **이 함수는 관문이지 실행이 아니다.** 팀을 옮기는 딜은 여기서 곧장 계약이
 * 되지 않고 **메디컬을 먼저 잡는다** — 실제 이적이 그렇고, 무엇보다 합의한 날
 * 도장을 찍고 기자회견까지 여는 장면이 한 턴에 담기는 것을 막는다. 장부를
 * 옮기는 것은 검진이 끝난 뒤 `executeDeal`이 한다.
 */
export function acceptDeal(state: GameState, negotiationId: string): CommandResult {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation)
    return {
      ok: false,
      message: `협상 "${negotiationId}"${josaOf(negotiationId, "을/를")} 찾지 못했습니다`,
    };
  /**
   * **상대의 조정이 서 있으면 그것을 받는 말이다** (transfer.md §1) — 합의 전의
   * `accept_deal`이 언제나 반려면 감독은 조정을 받아들일 길을 갖지 못한다.
   */
  const counter = standingCounter(negotiation);
  if (counter) return acceptCounterTerms(state, negotiation, counter);
  /**
   * **선수 쪽이 되부른 개인 조건을 그대로 받는 말도 여기다** (transfer.md §12-3) — 그 값으로
   * 다시 제안하면 선수 쪽은 그 자리에서 받아들인다.
   */
  const personal = negotiation.status === "open" ? negotiation.personal?.counter : undefined;
  if (personal) {
    return proposePersonal(state, {
      negotiationId: negotiation.id,
      weeklyWage: personal.weeklyWage,
      years: personal.contractYears,
      ...(personal.squadStatus === undefined ? {} : { squadStatus: personal.squadStatus }),
    });
  }
  if (negotiation.status !== "agreed") {
    return { ok: false, message: `아직 합의된 협상이 아닙니다 (${negotiation.status})` };
  }
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };

  if (needsMedical(negotiation)) {
    const gate = passMedicalGate(state, negotiation, player);
    if (gate) return gate;
  }
  return executeDeal(state, negotiation);
}

/**
 * 합의된 조건을 장부로 옮긴다 — 메디컬을 통과한 뒤에만 불린다.
 *
 * `state.negotiations`는 감독의 딜만 담는다. AI 구단끼리의 재계약
 * (`runAiRenewals`)은 계약을 직접 갱신하고 이 함수를 지나지 않는다.
 */
export function executeDeal(state: GameState, negotiation: Negotiation): CommandResult {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };

  const agreed = [...negotiation.rounds].reverse().find((r) => r.verdict === "accept");
  if (!agreed) return { ok: false, message: "합의된 조건을 찾지 못했습니다" };

  if (negotiation.kind === "sell") return executeSale(state, negotiation, agreed);
  if (negotiation.kind === "loan") return executeLoanIn(state, negotiation, agreed);
  if (negotiation.kind === "loan_out") return executeLoanOut(state, negotiation, agreed);
  if (negotiation.kind === "renew") return executeRenewal(state, negotiation, agreed);
  if (negotiation.kind === "release") return executeRelease(state, negotiation, agreed);

  /**
   * **빌린 구단과의 합의로는 오지 않는다.** 계약이 소유 구단에 있어 여기서 계약을
   * 갈아 끼우면 그 구단은 선수도 이적료도 잃는다 (transfer.md §2). 오퍼 단계가 이미
   * 막지만, 합의와 확정 사이에 AI 시장이 그 선수를 임대 보낼 수 있어 다시 본다.
   */
  // 우리에게 빌려 온 선수의 완전 영입만 잠금을 지난다 (§2) — 그 사이 임대가 끝났으면 보통의 영입이다
  const loanee = loanedInBy(state, player);
  const loanLocked = loanLockOf(player);
  if (loanLocked && !loanee) {
    negotiation.status = "expired";
    return { ok: false, message: loanLocked };
  }
  // 그 사이 다른 팀이 데려갔으면 무효다 — 재는 것은 계약을 가진 구단이다
  if (contractOwnerOf(state, player) !== negotiation.counterpartTeamId) {
    negotiation.status = "expired";
    return {
      ok: false,
      message: `${josa(player.name, "은/는")} 이미 ${josa(teamName(contractOwnerOf(state, player)), "으로/로")} 갔습니다 — 협상이 무효가 됐습니다`,
    };
  }
  /**
   * **사전 계약은 여기서 갈린다** — 돈도 원장도 소속도 움직이지 않는다 (§1-4).
   * 위의 재검사 둘(임대 잠금·이미 옮겨 갔는가)은 예약도 함께 지난다: 며칠 사이에
   * 그가 남의 계약에 묶였으면 예약할 것이 없다.
   */
  if (negotiation.precontract) {
    return executePrecontract(state, negotiation, agreed, player);
  }
  const window = windowOpenOn(state.windows, state.date);
  // 무소속은 창과 무관하다 — 계약이 없는 선수는 언제든 데려온다
  const freeAgent = !activeContract(state, player.id);
  const ourFinance = state.finances.find((f) => f.teamId === state.userTeamId);
  if (!ourFinance) return { ok: false, message: "재정 정보를 찾지 못했습니다" };
  if (!window && !freeAgent) {
    return { ok: false, message: "이적시장이 닫혀 있어 계약을 확정할 수 없습니다" };
  }
  /**
   * 분할이면 오늘 나갈 것은 **첫 회분**뿐이라 관문도 그것만 잰다 (transfer.md §5-2).
   * 남은 회분은 지급일에 무조건 나간다 — 그 압박은 부채 이자가 문다.
   */
  const paymentYears = agreed.fee > 0 ? paymentYearsOf(agreed.paymentYears) : undefined;
  const dueNow = firstInstallmentOf(agreed.fee, paymentYears);
  const gate = affordabilityGate(state, {
    fee: dueNow,
    weeklyWage: agreed.weeklyWage,
    what: "영입",
    // 창은 위에서 무소속까지 감안해 이미 봤다
    skipWindow: true,
    gamePlayerId: player.id,
  });
  if (gate) return gate;
  // 무소속은 클럽이 아니라 클럽이 없는 상태다 — 지킬 스쿼드가 없다. 빌려 온 선수는
  // 이미 원소속을 떠나 있어 이 영입이 그쪽 스쿼드에서 사람을 빼는 것이 아니다
  const sellerShort =
    isFreeAgent(player) || loanee ? null : squadShortfall(state, player.teamId, player);
  if (sellerShort) {
    return {
      ok: false,
      message: `${josa(teamName(player.teamId), "이/가")} ${squadShortfallText(sellerShort, "sell")}`,
    };
  }

  // 돈과 원장의 상대는 **계약을 가진 구단**이다 — 지금 뛰는 팀과 갈라지는 자리가 임대다
  const fromTeamId = contractOwnerOf(state, player);
  // 전술에서 빼는 것은 그 선수가 실제로 뛰던 팀 쪽이다
  const hostTeamId = player.teamId;
  // 원장 — TRANSFER row가 이력의 원본 (GamePlayer.teamId는 현재값일 뿐)
  const transferId = `tr-in-${player.id}-${state.date}`;
  const transfer: Transfer = {
    // 방향이 id에 든다 — 같은 날 사고판 선수는 `tr-<id>-<date>` 하나로 겹친다
    id: transferId,
    gamePlayerId: player.id,
    windowId: window?.id ?? null,
    fromTeamId,
    toTeamId: state.userTeamId,
    date: state.date,
    type: agreed.fee > 0 ? "transfer" : "free",
    fee: agreed.fee,
  };
  // 파는 쪽이 어린 선수를 내보내는 자리면 그 구단이 조항을 들고 간다 (transfer.md §5-3)
  attachClauses(state, transfer, player);
  state.transfers.push(transfer);
  // 파는 구단이 무는 셀온은 이 이적으로 발동한다 — 우리 장부는 지나가지 않는다
  settleSellOn(state, {
    gamePlayerId: player.id,
    sellerTeamId: fromTeamId,
    resaleFee: agreed.fee,
    resaleTransferId: transferId,
  });

  // 계약 — 기존 계약을 끝내고 새로 쓴다 (주급의 원본은 CONTRACT다)
  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  const squadStatus = agreedSquadStatus(state, negotiation, agreed, player);
  const contract: Contract = {
    id: `c-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    teamId: state.userTeamId,
    weeklyWage: agreed.weeklyWage,
    since: state.date,
    until: contractUntil(state.date, agreed.contractYears),
    status: "active",
    squadStatus,
  };
  state.contracts.push(contract);
  const agreedTerms = agreedTermsOf(negotiation, agreed);
  /**
   * 새 계약이 다음 시즌을 덮으므로 그에게 선 예약은 설 자리가 없다 (§1-4) —
   * 우리가 예약해 둔 선수를 그 전에 값을 주고 데려온 자리가 여기다.
   */
  voidPendingContract(state, player.id);

  /**
   * **돈이 나가기 직전에 승인분을 예산으로 옮긴다** (finance.md §9.6).
   *
   * 관문이 잰 것은 예산 + 승인분이었으므로 그만큼을 예산에 얹어야 아래의
   * `settlePlayerFee`가 지난 뒤에도 이적 예산이 음수로
   * 내려가지 않는다 — 검사한 값과 빠지는 값이 같다 (transfer.md §11).
   *
   * 이적료가 0이어도 부른다: 허가는 그 영입에 대한 것이었고 영입은 일어났다.
   * 줄이 남으면 다음 `signing` 요청의 여력이 이미 쓴 돈만큼 깎인다.
   */
  consumeEarmark(state, player.id, dueNow);

  settlePlayerFee(state, {
    kind: "transfer",
    player,
    payerTeamId: state.userTeamId,
    payeeTeamId: fromTeamId,
    fee: agreed.fee,
    transferId,
    paymentYears,
  });

  /**
   * 소속 이동 — 새 팀에서는 예비 스쿼드다 (감독이 라인업에 넣는다).
   * **빌려 온 선수는 이미 여기서 뛰고 있다** — 배치·번호·완장·등록은 그대로 두고 계약과
   * 임대 표식만 갈아 끼운다 (transfer.md §2). 판에서 빼고 번호를 다시 주면 완전 영입이
   * 곧 라인업 붕괴가 된다.
   */
  if (!loanee) releaseFromTactics(state, hostTeamId, player.id);
  player.teamId = state.userTeamId;
  // 계약을 옮기는 자리에 임대는 남지 않는다 — 남으면 복귀일에 선수만 원소속으로
  // 돌아가고 계약은 우리 것으로 남는다 (위 관문이 이미 걸렀어도 값은 여기서 끝난다)
  player.loan = undefined;
  if (!loanee) player.squadNumber = undefined;
  /**
   * **합의된 번호가 자리 관례보다 앞선다** (transfer.md §3). `take` 없이 시도한다 —
   * 동료의 셔츠를 벗기는 것은 감독의 결정이어야 한다(`set_squad_number`). 막히면
   * 관례로 떨어지되 **막혔다는 사실이 확정 브리프에 선다**: 조용히 다른 번호를 주면
   * 감독은 자기가 합의한 것이 지켜졌는지 알 길이 없다.
   */
  // 감독이 조건으로 약속한 번호가 선수가 부른 번호보다 앞선다 — 약속이 요구보다 무겁다 (§12-3)
  const wantedNumber = promisedNumberOf(agreedTerms) ?? agreedSquadNumber(negotiation);
  const claim =
    wantedNumber === undefined || (loanee && player.squadNumber === wantedNumber)
      ? null
      : assignRequestedNumber(state, player, wantedNumber);
  const numberBlock = claim && !claim.ok ? claim.block : null;
  const squadNumber = claim?.ok
    ? claim.assignment.number
    : loanee && player.squadNumber !== undefined
      ? player.squadNumber
      : assignSquadNumber(state.players, player);
  // 계보의 앞사람 — 물려받은 셔츠인지 아직 아무의 것도 아닌 번호인지가 여기서 갈린다
  const numberAfter = numberLineageOf(state, state.userTeamId, squadNumber).past[0];
  if (!loanee) {
    player.isCaptain = false;
    player.isViceCaptain = false;
  }
  /**
   * 등록 명단에 자리가 없으면 **2군으로 들어온다.** 실제로도 명단이 찬 채로
   * 영입한 선수는 다음 명단 제출까지 못 뛴다 — 계약은 성립하고 등록만 안 되는
   * 상태다. 여기서 딜을 되돌리면 이미 오간 돈을 토해내야 해서 더 나쁘다.
   */
  const slot = canRegisterFor(state, player, state.userTeamId);
  // 빌려 온 선수는 이미 명단에 서 있다 — 그 자리를 그대로 둔다
  if (!loanee) player.squadLevel = slot.ok ? "first" : "reserve";
  // 이제 우리 선수다 — 조건서가 약속 장부·조항·사본으로 흩어진다 (§12-3)
  const termNotes = settleTermsOnSigning(state, contract, player, agreedTerms);
  negotiation.status = "completed";

  pushNarrative(
    state,
    `${player.name} 영입 완료 — ${teamName(fromTeamId)}에서 ${formatMoney(agreed.fee)}` +
      (loanee ? " (임대에서 완전 영입)" : ""),
    4,
  );
  // 큰 영입에는 회견이 붙는다 — 세계가 감독에게 설명을 요구하는 자리 (press.ts)
  const arrivalPress = buildTransferPress(state, {
    playerId: player.id,
    kind: "in",
    fee: agreed.fee,
  });
  if (arrivalPress) openPress(state, arrivalPress);
  return {
    ok: true,
    message:
      `${player.name} 영입 완료 — ${teamName(fromTeamId)}에서 ${formatMoney(agreed.fee)}` +
      (paymentYears === undefined
        ? ""
        : ` (${paymentYears}년 분할 — 첫 회분 ${formatMoney(dueNow)})`) +
      `, 주급 ${formatMoney(agreed.weeklyWage)} ${agreed.contractYears}년${statusLabel(squadStatus)}` +
      ` · 등번호 ${squadNumber}번` +
      // 합의한 번호를 못 준 사실은 여기서 한 번 더 선다 — 모델이 읽는 줄이다
      (numberBlock ? ` (요구는 ${numberBlockText(numberBlock)})` : "") +
      `. 남은 이적 예산 ${formatMoney(ourFinance.transferBudget)}` +
      (slot.ok || loanee ? "" : ` ${registrationBlockText(slot.block)} — 2군으로 들어왔습니다`) +
      (loanee ? " · 임대에서 완전 영입 — 배치와 번호는 그대로입니다" : "") +
      (termNotes.length > 0 ? ` · ${termNotes.join(" · ")}` : ""),
    brief: {
      head: "영입 완료",
      items: [
        item({ label: "영입", text: player.name, note: teamName(fromTeamId) }),
        item({
          label: "이적료",
          text: formatMoney(agreed.fee),
          ...(paymentYears === undefined
            ? {}
            : { note: `${paymentYears}년 분할 · 첫 회분 ${formatMoney(dueNow)}` }),
        }),
        item({
          label: "주급",
          text: formatMoney(agreed.weeklyWage),
          note: `${agreed.contractYears}년`,
        }),
        item({ label: "계약 지위", text: SQUAD_STATUS_KO[squadStatus] }),
        item({
          label: "등번호",
          text: `${squadNumber}번`,
          ...(numberAfter ? { note: `${numberAfter.name} 뒤 · ${numberAfter.seasons}시즌` } : {}),
        }),
        ...(numberBlock
          ? [item({ label: "요구한 번호", text: numberBlockText(numberBlock) })]
          : []),
        item({ label: "남은 이적 예산", text: formatMoney(ourFinance.transferBudget) }),
        ...(slot.ok || loanee
          ? []
          : [item({ label: "등록", text: "2군", note: registrationBlockText(slot.block) })]),
        ...termNotes.map((text) => item({ label: "조건", text })),
      ],
    },
  };
}

/**
 * 매각 실행 — 영입의 거울상. 선수가 떠나고 돈이 들어온다.
 *
 * 판매 대금은 잔고와 **이적 예산에 함께** 들어간다 — 팔지 않으면 큰
 * 영입이 없다는 규칙이 여기서 성립한다.
 */
function executeSale(
  state: GameState,
  negotiation: Negotiation,
  agreed: Negotiation["rounds"][number],
): CommandResult {
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return { ok: false, message: "선수를 찾지 못했습니다" };
  if (player.teamId !== state.userTeamId) {
    negotiation.status = "expired";
    return { ok: false, message: `${josa(player.name, "은/는")} 이미 우리 선수가 아닙니다` };
  }
  // 우리 스쿼드에 있어도 계약이 남의 것이면 팔 수 없다 — 돈이 소유 구단을 지나쳐 온다
  const loanLocked = loanLockOf(player);
  if (loanLocked) {
    negotiation.status = "expired";
    return { ok: false, message: loanLocked };
  }
  const buyerTeamId = negotiation.counterpartTeamId;
  if (!buyerTeamId) return { ok: false, message: "사는 구단을 알 수 없습니다" };
  /**
   * **창은 사는 쪽 협회의 것이다** — 등록을 하는 쪽이 그쪽이기 때문이고, 오퍼가
   * 그 창으로 열렸으므로 확정도 같은 창으로 재야 한다 (transfer.md §3).
   * 우리 창으로 재면 9월의 사우디행은 합의까지 가 놓고 반드시 여기서 막힌다.
   */
  const window = windowOpenForTeam(state, buyerTeamId);
  if (!window) {
    return {
      ok: false,
      message: `${josa(transferWindowLabel(state, buyerTeamId), "이/가")} 닫혀 있어 매각을 확정할 수 없습니다`,
    };
  }
  const shortfall = squadShortfall(state, state.userTeamId, player);
  if (shortfall) return { ok: false, message: `우리 ${squadShortfallText(shortfall, "sell")}` };
  /**
   * **사는 쪽도 돈이 있어야 한다.** 오퍼가 붙을 때 `pickBuyer`가 본 것은 그때의
   * 시장가였고, 감독의 조정은 그 위로 얼마든 부를 수 있다 — 그사이 그 구단이
   * 다른 영입에 예산을 썼을 수도 있다. 검사 없이 빼면 상대 예산이 음수가 된다.
   *
   * 못 내면 협상이 **무산**된다(`expired`) — 결렬(`rejected`)로 적으면 이번 창에
   * 다시 팔 길까지 닫힌다. 값을 낮춰 다시 붙는 것이 실제로도 흔한 결말이다.
   */
  const buyerFinance = state.finances.find((f) => f.teamId === buyerTeamId);
  const paymentYears = agreed.fee > 0 ? paymentYearsOf(agreed.paymentYears) : undefined;
  const dueNow = firstInstallmentOf(agreed.fee, paymentYears);
  if (agreed.fee > 0 && buyerFinance && dueNow > buyerFinance.transferBudget) {
    /**
     * **못 내면 분할로 되불러 온다** (transfer.md §5-2). 같은 총액을, 첫 회분이 그
     * 구단 예산에 들어오는 **가장 짧은 연수**로 나눈 조정이다 — 협상이 `open`으로
     * 돌아가고 감독이 답한다. 4년으로도 안 들어올 때만 무산(`expired`)이다.
     */
    const budget = buyerFinance.transferBudget;
    const split = SPLIT_YEARS.find((n) => firstInstallmentOf(agreed.fee, n) <= budget);
    if (split !== undefined) {
      const odds = dealOdds(state, {
        playerId: player.id,
        fee: agreed.fee,
        weeklyWage: agreed.weeklyWage,
        years: agreed.contractYears,
        kind: "sell",
        counterpartTeamId: buyerTeamId,
        paymentYears: split,
      });
      negotiation.rounds.push({
        date: state.date,
        by: "them",
        fee: agreed.fee,
        weeklyWage: agreed.weeklyWage,
        contractYears: agreed.contractYears,
        paymentYears: split,
        respondsOn: null,
        probability: odds.probability,
        // 답을 기다리는 상대 오퍼다 — `incomingOffer`가 `verdict: null`로 집는다
        verdict: null,
      });
      negotiation.status = "open";
      return {
        ok: false,
        message:
          `${josa(teamName(buyerTeamId), "이/가")} ${josa(formatMoney(agreed.fee), "을/를")} 일시금으로 마련하지 못해 ` +
          `${split}년 분할로 되불렀습니다 — 총액은 그대로, 첫 회분 ${formatMoney(firstInstallmentOf(agreed.fee, split))}. ` +
          "답해야 합니다",
      };
    }
    negotiation.status = "expired";
    return {
      ok: false,
      message:
        `${josa(teamName(buyerTeamId), "이/가")} ${josa(formatMoney(agreed.fee), "을/를")} 마련하지 못했습니다 — ` +
        `가용 ${formatMoney(budget)}. ${MAX_PAYMENT_YEARS}년 분할로도 첫 회분을 못 냅니다. 이 건은 무산됐습니다`,
    };
  }

  const transferId = `tr-out-${player.id}-${state.date}`;
  const transfer: Transfer = {
    id: transferId,
    gamePlayerId: player.id,
    windowId: window.id,
    fromTeamId: state.userTeamId,
    toTeamId: buyerTeamId,
    date: state.date,
    type: agreed.fee > 0 ? "transfer" : "free",
    fee: agreed.fee,
  };
  // 조항은 딜의 모양이 붙인다 — 파는 쪽이 우리든 AI든 같은 함수다 (transfer.md §5-3)
  attachClauses(state, transfer, player);
  state.transfers.push(transfer);
  /**
   * 우리가 데려올 때 걸린 셀온은 **이 매각으로 발동한다** — 원 소속 구단이 이익의
   * 일부를 가져간다. 원장은 지급 일정 표의 한 문을 지나 양쪽에 대칭으로 선다.
   */
  const sellOnPaid = settleSellOn(state, {
    gamePlayerId: player.id,
    sellerTeamId: state.userTeamId,
    resaleFee: agreed.fee,
    resaleTransferId: transferId,
  });

  const previous = activeContract(state, player.id);
  if (previous) previous.status = "ended";
  state.contracts.push({
    id: `c-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    teamId: buyerTeamId,
    weeklyWage: agreed.weeklyWage,
    since: state.date,
    until: contractUntil(state.date, agreed.contractYears),
    status: "active",
  });
  // 새 구단의 계약이 다음 시즌을 덮는다 — 그에게 선 남의 예약은 걷힌다 (§1-4)
  voidPendingContract(state, player.id);

  const ourFinance = state.finances.find((f) => f.teamId === state.userTeamId);
  settlePlayerFee(state, {
    kind: "transfer",
    player,
    payerTeamId: buyerTeamId,
    payeeTeamId: state.userTeamId,
    fee: agreed.fee,
    transferId,
    paymentYears,
  });

  const wasCaptain = player.isCaptain;
  // 배치·리스트·개인 훈련·역할 기억은 어느 문으로 나가든 함께 지운다 (transfer.md §2)
  clearDepartedState(state, player, state.userTeamId);
  player.teamId = buyerTeamId;
  player.squadNumber = undefined;
  assignSquadNumber(state.players, player);
  // 사는 쪽 1군이 차 있으면 2군으로 들어간다 — AI 시장이 지키는 상한과 같은 자다
  player.squadLevel = arrivingSquadLevel(state, player, buyerTeamId);
  negotiation.status = "completed";

  pushNarrative(
    state,
    `${player.name} 매각 — ${josa(teamName(buyerTeamId), "으로/로")} ${formatMoney(agreed.fee)}`,
    wasCaptain ? 5 : 4,
  );
  const salePress = buildTransferPress(state, {
    playerId: player.id,
    kind: "out",
    fee: agreed.fee,
  });
  if (salePress) openPress(state, salePress);
  const captainNote = wasCaptain ? " 주장이 떠났습니다 — 새 주장을 지명하세요." : "";
  return {
    ok: true,
    message:
      `${josa(player.name, "을/를")} ${josa(teamName(buyerTeamId), "으로/로")} 보냈습니다 — ${formatMoney(agreed.fee)}` +
      (paymentYears === undefined
        ? ""
        : ` (${paymentYears}년 분할 — 첫 회분 ${formatMoney(dueNow)})`) +
      "." +
      (sellOnPaid > 0
        ? ` 셀온 조항으로 ${josa(formatMoney(sellOnPaid), "이/가")} 나갔습니다.`
        : "") +
      `${captainNote} 이적 예산 ${formatMoney(ourFinance?.transferBudget ?? 0)}`,
    brief: {
      head: "매각 완료",
      items: [
        item({ label: "매각", text: player.name, note: teamName(buyerTeamId) }),
        item({
          label: "이적료",
          text: formatMoney(agreed.fee),
          ...(paymentYears === undefined
            ? {}
            : { note: `${paymentYears}년 분할 · 첫 회분 ${formatMoney(dueNow)}` }),
        }),
        ...(sellOnPaid > 0 ? [item({ label: "셀온 지급", text: formatMoney(sellOnPaid) })] : []),
        item({ label: "이적 예산", text: formatMoney(ourFinance?.transferBudget ?? 0) }),
        ...(wasCaptain ? [item({ text: "주장 공석" })] : []),
      ],
    },
  };
}

/**
 * 검진일이 된 딜을 처리한다 — tick이 매일 부른다.
 *
 * **통과는 조용히 끝난다.** 감독이 이미 결정한 일이고, 검진은 그 결정을 확인하는
 * 절차이지 새 판단을 요구하는 자리가 아니다 — 통과한 딜은 그날 계약이 된다.
 * 감독이 다시 결정해야 하는 것은 **소견이 붙었을 때뿐**이다.
 */
export function runMedicals(state: GameState, digest: TickSink): void {
  for (const outcome of resolveMedicals(state)) {
    const { negotiation, player } = outcome;
    if (outcome.passed) {
      const done = executeDeal(state, negotiation);
      digest.push(
        done.ok
          ? `${player.name} 메디컬 통과 — ${done.message}`
          : `${player.name} 메디컬은 통과했지만 계약을 확정하지 못했습니다 — ${done.message}`,
      );
      continue;
    }

    /**
     * 데려오는 딜이면 결정은 감독의 몫이고(강행이든 철회든), **우리가 파는 쪽이면
     * 결정권은 상대에게 있다** — 사는 구단이 값을 깎아 다시 부르고 협상이 `open`으로
     * 돌아가 감독이 답할 차례가 된다. 유리몸을 비싸게 파는 일이 그래서 어려워진다.
     * 두 갈래의 문장은 `accept_deal`이 마감일에 쓰는 것과 같다.
     */
    // 통과하지 않았으면 소견 카드가 반드시 붙는다 (`resolveMedical`)
    if (!outcome.concern) continue;
    const flagged = medicalFlagResult(state, negotiation, player, outcome.concern);
    if (flagged.ok) digest.push(`${flagged.message}`);
  }
}

/**
 * **다른 구단도 계약을 관리한다.**
 *
 * AI 구단은 시즌 중에도 재계약을 한다 — **자기 팀 주전일수록, 어릴수록
 * 서둘러 잡는다.** 우리가 노리던 선수가 재계약하면 진행 중이던 협상은 그 자리에서
 * 끝난다. 그게 이 시스템의 요점이다: 기다리는 데에도 대가가 있다.
 */
export function runAiRenewals(state: GameState, digest: TickSink): void {
  const limit = addDays(state.date, AI_RENEWAL_WINDOW_DAYS);
  const rng = makeRng(state.seed, `ai-renewal:${state.date}`);
  /**
   * 색인을 먼저 세운다 — 5,777건의 계약이 저마다 5,777명을 훑던 자리다.
   * 이 순회는 **계약과 협상만** 갈아 끼우므로(선수의 소속·전력은 그대로) 색인이
   * 도는 동안 어긋나지 않는다.
   */
  const byId = new Map(state.players.map((p) => [p.id, p] as const));
  const depth = squadDepthOf(state);

  /**
   * 대상을 **먼저 걸러 두고** 돈다 — 재계약은 같은 배열에 새 계약을 `push`하므로,
   * `state.contracts`를 직접 순회하면 이번 턴이 만든 계약까지 훑는다. 지금은 새
   * 계약의 만료가 검토 창(240일) 밖이라 무해하지만, 순회 중 변이는 창이 넓어지는
   * 날 조용히 이 순회를 자기가 만든 일로 채운다.
   */
  /**
   * 이미 갈 곳을 정한 사람에게 재계약할 것이 없다 (§1-4). 계약 건마다 원장을 다시
   * 훑으면 5,777건이 5,777건을 훑으므로, 예약은 **한 번 훑어 집합으로** 든다.
   */
  const promised = new Set(
    state.contracts.filter((c) => c.status === "pending").map((c) => c.gamePlayerId),
  );
  const due = state.contracts.filter(
    (c) =>
      c.status === "active" &&
      c.teamId !== state.userTeamId &&
      c.until <= limit &&
      c.until > state.date &&
      !promised.has(c.gamePlayerId),
  );

  for (const contract of due) {
    const player = byId.get(contract.gamePlayerId);
    if (!player || player.teamId !== contract.teamId) continue;
    if (player.loan) continue; // 임대 중엔 원소속이 따로 판단한다

    // 팀에서의 자리와 나이 — 주전이고 어릴수록 서둘러 잡는다
    const blocked = depth.betterThan(contract.teamId, player);
    const age = ageOf(player.birthdate, state.date);
    const urgency =
      (blocked === 0
        ? RENEWAL_URGENCY_STARTER
        : blocked === 1
          ? RENEWAL_URGENCY_ROTATION
          : RENEWAL_URGENCY_FRINGE) *
      (age >= RENEWAL_VETERAN_AGE
        ? RENEWAL_VETERAN_URGENCY
        : age <= RENEWAL_YOUNG_AGE
          ? RENEWAL_YOUNG_URGENCY
          : 1);
    if (rng() > AI_RENEWAL_CHANCE * urgency) continue;

    const years = RENEWAL_YEARS_MIN + Math.floor(rng() * RENEWAL_YEARS_SPAN);
    contract.status = "ended";
    const renewed: Contract = {
      id: `c-renew-${player.id}-${state.date}`,
      gamePlayerId: player.id,
      teamId: contract.teamId,
      weeklyWage: Math.round(contract.weeklyWage * (RENEWAL_WAGE_BASE + rng() * RENEWAL_WAGE_SPAN)),
      since: state.date,
      until: contractUntil(state.date, years),
      status: "active",
      /**
       * **지위 칸은 비워 둔다** (transfer.md §1) — 남의 구단의 재계약은 감독이 아무
       * 자리도 약속한 적 없는 계약이라, 적어 두면 그때의 서열이 굳어 약속인 척한다.
       * 살아나는 자리는 감독이 그 구단으로 이직한 다음 날이다: 몇 시즌 전 서열로
       * 굳은 지위가 그날부터 출전 불만을 낸다. 읽는 쪽이 그때그때 파생하면
       * (`squadStatusOf`) 언제나 지금의 서열이다.
       */
    };
    state.contracts.push(renewed);
    // 남의 구단의 새 계약에는 조항이 붙을 수 있다 — 세계와 같은 규칙이다 (§12-3)
    attachAiBuyout(state, renewed, player);
    // 남의 구단의 재계약도 예고를 거둔다 — 규칙이 하나여야 세계가 같은 세계다 (season.md §6)
    withdrawRetirement(state, player);

    /**
     * **우리가 노리던 선수라면 그 자리에서 끝난다.** 재계약은 협상 조건이
     * 나빠지는 게 아니라 문이 닫히는 일이다 — 그래야 기다림에 대가가 생긴다.
     */
    const ours = state.negotiations.find(
      (n) => n.gamePlayerId === player.id && n.status === "open",
    );
    if (ours) {
      ours.status = "rejected";
      digest.push(
        `${josa(teamName(contract.teamId), "이/가")} ${josa(player.name, "과/와")} 재계약했습니다 (${years}년) — 우리 협상은 끝났습니다`,
      );
      pushNarrative(state, `${player.name} 재계약 — 영입 무산`, 4);
    } else if (state.scoutReports.some((r) => r.gamePlayerId === player.id && r.completedOn)) {
      // 스카우팅해 둔 선수는 감독의 관심 목록이다 — 소식은 전한다
      digest.push(
        `${josa(teamName(contract.teamId), "이/가")} ${josa(player.name, "과/와")} 재계약했습니다 (${years}년)`,
      );
    }
  }
}
