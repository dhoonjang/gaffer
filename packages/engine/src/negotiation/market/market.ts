import type {
  DealTerm,
  GamePlayer,
  NegotiationKind,
  PitchClaim,
  SquadStatus,
} from "@story-fm/domain";

import { MAX_PAYMENT_YEARS, PRECONTRACT_DAYS, ageOf, josa } from "@story-fm/domain";

import { buildSeasonCalendar, windowOpenOn } from "../../common/core/calendar";

import { tierOfTeamIn } from "../../common/core/club-tier";

import { diffDays } from "../../common/core/dates";

import { leagueOfTeamIn } from "../../common/core/league-membership";

import {
  activeContract,
  contractYearsLeft,
  financeOf,
  pendingContractOf,
  playerById,
  squadShortfall,
  teamName,
  type GameState,
  type SquadShortfall,
} from "../../common/core/state";

import { isMarketOnlyLeague, leagueCatalogById } from "../../common/data/league-catalog";

import { leagueEconomyLevel } from "../../common/data/league-economy";

import { isClubTeam, teamCatalogById } from "../../common/data/team-catalog";

import { squadDepthOf, squadRatingsOf, type SquadDepth } from "../../common/players/squad-depth";

import { euroCompetitionOf } from "../../common/views/europe";

import { playerValueOf } from "../economy/valuation";

import { signingBudgetOf, userWageRoom } from "../finance/board-request";

import { budgetFreezeLabel, formatMoney } from "../finance/finance";

export { LEAGUE_FACTOR_EXPONENT, MARKET_VALUE_AT_PEAK, baseValueOf } from "../economy/valuation";

export const SUITORS_MANY = 3;

const STAGE_RATING_SPAN = 6;

const STAGE_LEAGUE_STEP = 0.35;

const STAGE_ECONOMY_FLOOR = 0.05;

const STAGE_EURO_STEP: Record<string, number> = { ucl: 0.5, uel: 0.25, uecl: 0.12 };

const STAGE_TIER_STEP = 0.35;

const STAGE_TIER_PIVOT = 3;

const STAGE_GAP_CAP = 2.5;

export const VETERAN_AGE = 30;

const STAGE_VETERAN_STEP = 0.6;

const STAGE_PULL_STARTER = 0.8;

const STAGE_PULL_SURPLUS = -0.5;

export const DEADLINE_DAYS = 7;

export function marketValueOf(state: GameState, player: GamePlayer): number {
  return playerValueOf({
    overall: player.attributes.overall,
    potential: player.attributes.potential,
    age: ageOf(player.birthdate, state.date),
    form: player.state.form,
    yearsLeft: contractYearsLeft(state, player.id),
    // 지금 뛰는 리그로 잰다 — 강등되면 그 시즌부터 값이 따라 내려간다 (transfer.md §3)
    economy: leagueEconomyLevel(leagueOfTeamIn(state, player.teamId)),
  });
}

const WAGE_BASE_RATING = 38.5;

export function wageByRating(overall: number): number {
  return Math.pow(Math.max(WAGE_BASE_RATING, overall) / WAGE_BASE_RATING, 4.2) * 6_000;
}

export const MARKET_NEAR_LOW = 0.85;

export const MARKET_NEAR_HIGH = 1.2;

export function isSeriousOffer(state: GameState, player: GamePlayer, fee: number): boolean {
  return fee >= marketValueOf(state, player) * MARKET_NEAR_LOW;
}

export interface DealTerms {
  playerId: string;
  fee: number;
  weeklyWage: number;
  /** 계약 연수 */
  years: number;
  /**
   * 영입·매각·재계약·해지 — 기본은 영입.
   * 매각이면 관문이 뒤집히고(**사는 쪽이 낼까** + **선수가 떠날까**),
   * 재계약은 관문이 하나다 (**선수가 남을까**) — 이적료가 없다.
   * 해지도 관문이 하나이고(**선수가 합의해 줄까**) `fee`가 제시 **정산금**이다.
   */
  kind?: NegotiationKind;
  /**
   * 매각 상대 구단 — 주면 **그 협회의 이적창**으로 판정한다.
   * 사우디·MLS는 우리보다 늦게 닫히므로 이 값이 없으면 판정이 틀린다.
   */
  counterpartTeamId?: string;
  /**
   * 감독의 설득 논거 — 숫자로 넘을 수 없는 벽을 넘는 유일한 수단이다.
   * 실제 사실과 대조한 논거를 상대 평가의 근거로 전달한다.
   */
  pitch?: readonly PitchClaim[];
  /** 이 협상에서 이미 인정된 논거 — 반복은 다시 쳐주지 않는다 */
  pitched?: readonly string[];
  /**
   * 이적료·정산금의 **분할 연수** — 없거나 1이면 일시금 (transfer.md §5-2).
   * 현재 지출과 앞으로 지급할 잔액을 원장에 구분해 기록한다.
   */
  paymentYears?: number;
  /**
   * 감독이 제시하는 **스쿼드 지위** — 합의되면 계약에 적히는 약속이다
   * (people.md §5-2). 없으면 선수 관문의 지위 항이 서지 않는다: 말하지 않은 것은
   * 약속이 아니다.
   */
  squadStatus?: SquadStatus;
  /**
   * 감독이 건 **조건** — 조건서에서 온다 (transfer.md §12-3). 코어가 믿을 만하다고
   * 확인한 것마다 선수 관문에 지위 한 칸이 얹힌다. 없으면 항이 서지 않는다.
   */
  terms?: readonly DealTerm[];
  /** 감독이 거절한 상대의 요구 수 — 한 칸씩 뺀다 */
  refusedTerms?: number;
  /**
   * **개인 조건이 먼저 굳은 오퍼인가** (transfer.md §12-3) — 선수 쪽은 이미 답했으므로
   * 선수 관문이 합의로 열린다. 오퍼가 굳은 값을 그대로 실었을 때만 부르는 쪽이 켠다.
   */
  personalAgreed?: boolean;
}

export function signingBonusOf(terms: readonly DealTerm[] | undefined): number {
  return terms?.find((t) => t.kind === "bonus")?.fee ?? 0;
}

export function paymentYearsOf(years?: number): number | undefined {
  if (years === undefined) return undefined;
  const n = Math.floor(years);
  if (n <= 1) return undefined;
  return Math.min(MAX_PAYMENT_YEARS, n);
}

export function firstInstallmentOf(total: number, paymentYears?: number): number {
  const n = paymentYearsOf(paymentYears);
  return n === undefined ? total : Math.floor(total / n);
}

export function loanedInBy(state: GameState, player: GamePlayer): boolean {
  return player.loan !== undefined && player.teamId === state.userTeamId;
}

export function loanLockOf(player: GamePlayer): string | null {
  if (!player.loan) return null;
  return (
    `${josa(player.name, "은/는")} 임대 중입니다 — 계약은 ${teamName(player.loan.fromTeamId)}에 있어 ` +
    "그쪽이 먼저 불러들여야 움직입니다"
  );
}

export function contractOwnerOf(state: GameState, player: GamePlayer): string {
  return activeContract(state, player.id)?.teamId ?? player.loan?.fromTeamId ?? player.teamId;
}

/** Public transaction reference; a recorded fee is not the seller's current asking price. */
export function observedMarketValue(state: GameState, player: GamePlayer): number | null {
  let latest: GameState["transfers"][number] | undefined;
  for (const transfer of state.transfers) {
    if (
      transfer.gamePlayerId !== player.id ||
      transfer.type !== "transfer" ||
      transfer.date > state.date
    )
      continue;
    if (!latest || transfer.date >= latest.date) latest = transfer;
  }
  return latest?.fee ?? null;
}

export function precontractDaysLeft(state: GameState, playerId: string): number | null {
  const contract = activeContract(state, playerId);
  if (!contract) return null;
  const days = diffDays(state.date, contract.until);
  if (days < 0 || days > PRECONTRACT_DAYS) return null;
  return days;
}

export function isPrecontractTerms(state: GameState, terms: DealTerms): boolean {
  if (terms.kind !== undefined && terms.kind !== "buy") return false;
  if (terms.fee > 0) return false;
  const player = playerById(state, terms.playerId);
  if (!player) return false;
  return isPrecontractTarget(state, player);
}

export function isPrecontractTarget(state: GameState, player: GamePlayer): boolean {
  if (player.teamId === state.userTeamId) return false;
  if (!isClubTeam(player.teamId)) return false;
  return precontractDaysLeft(state, player.id) !== null;
}

export function precontractStartOf(state: GameState): string {
  return buildSeasonCalendar(state.season + 1).preseasonStart;
}

export function precontractBlockerOf(state: GameState, player: GamePlayer): string | null {
  const pending = pendingContractOf(state, player.id);
  if (pending) {
    return pending.teamId === state.userTeamId
      ? `${josa(player.name, "과/와")}는 이미 사전 계약을 맺었습니다`
      : `${josa(player.name, "은/는")} 이미 ${josa(teamName(pending.teamId), "과/와")} 사전 계약을 맺었습니다`;
  }
  if (player.state.retiringAfterSeason) {
    return `${josa(player.name, "은/는")} 이번 시즌 뒤 은퇴를 예고했습니다`;
  }
  return null;
}

export const LOAN_FEE_RATE = 0.08;

export interface StageScale {
  /** 이 구단의 무대 값 — 견주는 것은 `gapTo`다 */
  stageOf(teamId: string): number;
  /** 우리 무대와의 차 — 양수면 우리보다 큰 무대. `STAGE_GAP_CAP`에서 멈춘다 */
  gapTo(teamId: string): number;
}

export function stageScaleOf(state: GameState): StageScale {
  const ratings = squadRatingsOf(state);
  const cache = new Map<string, number>();
  const stageOf = (teamId: string): number => {
    const seen = cache.get(teamId);
    if (seen !== undefined) return seen;
    const economy = Math.max(
      STAGE_ECONOMY_FLOOR,
      leagueEconomyLevel(leagueOfTeamIn(state, teamId)),
    );
    const cup = euroCompetitionOf(state.euroEntrants, teamId);
    const value =
      (ratings.get(teamId) ?? 0) / STAGE_RATING_SPAN +
      Math.log2(economy) * STAGE_LEAGUE_STEP +
      (cup === null ? 0 : (STAGE_EURO_STEP[cup] ?? 0)) +
      (STAGE_TIER_PIVOT - tierOfTeamIn(state, teamId)) * STAGE_TIER_STEP;
    cache.set(teamId, value);
    return value;
  };
  return {
    stageOf,
    gapTo: (teamId) => {
      const gap = stageOf(teamId) - stageOf(state.userTeamId);
      return Math.max(-STAGE_GAP_CAP, Math.min(STAGE_GAP_CAP, gap));
    },
  };
}

export function stageGapFor(
  state: GameState,
  teamId: string,
  player: GamePlayer,
  scale: StageScale = stageScaleOf(state),
): number {
  const gap = scale.gapTo(teamId);
  if (ageOf(player.birthdate, state.date) < VETERAN_AGE) return gap;
  const appetite = marketBiasOf(state, teamId).veteranAppetite;
  return appetite <= 1 ? gap : gap + (appetite - 1) * STAGE_VETERAN_STEP;
}

export function suitorWeightOf(
  state: GameState,
  teamId: string,
  player: GamePlayer,
  scale: StageScale,
  blockedHere: number,
): number {
  const pull = blockedHere === 0 ? STAGE_PULL_STARTER : STAGE_PULL_SURPLUS;
  return Math.exp(stageGapFor(state, teamId, player, scale) * pull);
}

export function isDeadlineWeek(date: string, closesOn: string): boolean {
  const left = diffDays(date, closesOn);
  return left >= 0 && left < DEADLINE_DAYS;
}

export function inDeadlineWeek(state: GameState, teamId: string, date = state.date): boolean {
  const window = windowOpenForTeam(state, teamId, date);
  return window !== null && isDeadlineWeek(date, window.closesOn);
}

export function suitorsOf(
  state: GameState,
  player: GamePlayer,
  depth: SquadDepth = squadDepthOf(state),
): string[] {
  const squadSize = new Map<string, number>();
  for (const p of state.players) squadSize.set(p.teamId, (squadSize.get(p.teamId) ?? 0) + 1);
  const suitors: string[] = [];
  for (const team of state.teams) {
    if (team.id === state.userTeamId || !isClubTeam(team.id)) continue;
    if ((squadSize.get(team.id) ?? 0) === 0) continue;
    if (depth.betterThan(team.id, player) === 0) suitors.push(team.id);
  }
  return suitors;
}

export function biggerSuitorsOf(
  state: GameState,
  suitors: readonly string[],
  scale: StageScale = stageScaleOf(state),
): string[] {
  return suitors.filter((id) => scale.gapTo(id) > 0);
}

export { teamCatalogById, teamName };

export function windowOpenForTeam(state: GameState, teamId: string, date = state.date) {
  const leagueId = leagueOfTeamIn(state, teamId);
  return windowOpenOn(state.windows, date, isMarketOnlyLeague(leagueId) ? leagueId : undefined);
}

export function windowStartFor(state: GameState, teamId: string, date = state.date): string | null {
  const leagueId = leagueOfTeamIn(state, teamId);
  const key = isMarketOnlyLeague(leagueId) ? leagueId : undefined;
  let latest: string | null = null;
  for (const w of state.windows) {
    if (w.leagueId !== key || w.opensOn > date) continue;
    if (latest === null || w.opensOn > latest) latest = w.opensOn;
  }
  return latest;
}

export function transferWindowLabel(state: GameState, teamId: string): string {
  const leagueId = leagueOfTeamIn(state, teamId);
  return isMarketOnlyLeague(leagueId)
    ? `${leagueCatalogById(leagueId)?.name ?? "상대 리그"}의 이적시장`
    : "이적시장";
}

export type DepartureAction = "sell" | "release" | "loan-out";

const DEPARTURE_VERB: Record<DepartureAction, string> = {
  sell: "팔",
  release: "해지할",
  "loan-out": "보낼",
};

export function squadShortfallText(short: SquadShortfall, action: DepartureAction): string {
  const subject = short.code === "squad-min" ? "스쿼드" : "골키퍼";
  return `${subject}가 ${short.limit}명 아래로 내려가 ${DEPARTURE_VERB[action]} 수 없습니다`;
}

export interface MarketBias {
  /** 이적료 배율 */
  fee: number;
  /** 주급 배율 */
  wage: number;
  /** 30세 이상을 얼마나 더 좋아하는가 (1 = 차이 없음) */
  veteranAppetite: number;
}

const DEFAULT_BIAS: MarketBias = { fee: 1, wage: 1, veteranAppetite: 1 };

const LEAGUE_BIAS: Record<string, MarketBias> = {
  saudi: { fee: 1.45, wage: 3.5, veteranAppetite: 2.2 },
  mls: { fee: 0.75, wage: 1.3, veteranAppetite: 1.6 },
};

export function marketBiasOf(state: GameState, teamId: string): MarketBias {
  return LEAGUE_BIAS[leagueOfTeamIn(state, teamId)] ?? DEFAULT_BIAS;
}

/** Only legal, ownership and ledger constraints; the counterparty evaluation owns consent. */
export function validateDeal(state: GameState, terms: DealTerms): { blockers: string[] } {
  const player = playerById(state, terms.playerId);
  if (!player) return { blockers: [`선수를 찾지 못했습니다: ${terms.playerId}`] };
  if (
    ![terms.fee, terms.weeklyWage, terms.years].every(Number.isFinite) ||
    terms.fee < 0 ||
    terms.weeklyWage < 0 ||
    !Number.isInteger(terms.years) ||
    terms.years < 0 ||
    terms.years > 6
  )
    return { blockers: ["금액과 계약 기간이 유효하지 않습니다"] };
  const blockers: string[] = [];
  const window = windowOpenOn(state.windows, state.date);
  const freeAgent = contractYearsLeft(state, player.id) <= 0;
  /**
   * **사전 계약** — 잔여 반년 이하인 남의 클럽 선수에게 이적료 0을 부른 자리 (§1-4).
   * `freeAgent`(계약이 이미 끝났다)와는 다른 축이다: 계약이 아직 남아 있는 사람이라,
   * 이 판을 여는 것은 협회의 창이 아니라 그 계약의 만료일이다.
   */
  const precontract = isPrecontractTerms(state, terms);

  /**
   * 임대는 갈래를 가리지 않고 막힌다 — 영입·매각·임대·재계약이 모두 남의 계약을 건드린다.
   * **열린 문은 하나다**: 우리에게 빌려 온 선수를 원소속에서 데려오는 영입 (transfer.md §2).
   * 그 오퍼의 상대는 계약을 가진 구단이라 남의 계약을 건드리는 것이 아니라 사는 것이다.
   */
  const buyingLoanee =
    (terms.kind === undefined || terms.kind === "buy") && loanedInBy(state, player);
  const loanLock = loanLockOf(player);
  if (loanLock && !buyingLoanee) blockers.push(loanLock);

  if (terms.kind === "sell" || terms.kind === "loan_out") {
    if (player.teamId !== state.userTeamId) {
      blockers.push(`${josa(player.name, "은/는")} 우리 선수가 아닙니다`);
    }
    /**
     * 매각은 **사는 쪽 협회의 창**을 본다. 우리 창이 닫혀도 사우디·MLS 창이
     * 열려 있으면 팔 수 있다 — 대신 대체 영입은 못 한다.
     */
    const buyerTeamId = terms.counterpartTeamId;
    const buyerWindow = buyerTeamId ? windowOpenForTeam(state, buyerTeamId) : window;
    if (!buyerWindow) {
      blockers.push(
        `${josa(buyerTeamId ? transferWindowLabel(state, buyerTeamId) : "이적시장", "이/가")} 닫혀 있습니다`,
      );
    }
  } else if (terms.kind === "renew" || terms.kind === "release") {
    // 재계약·해지는 이적창과 무관하다 — 상대가 선수 본인이기 때문이다
    if (player.teamId !== state.userTeamId) {
      blockers.push(`${josa(player.name, "은/는")} 우리 선수가 아닙니다`);
    }
    if (terms.kind === "release") {
      // 계약이 없으면 해지할 것이 없다 — 그날로 끝난 계약은 이미 무소속으로 간다
      if (!activeContract(state, player.id)) {
        blockers.push(`${josa(player.name, "은/는")} 해지할 계약이 없습니다`);
      }
      // 나가는 문은 다 같은 하한을 지킨다 — 다 내보내고 경기를 못 뛰는 일이 없게
      const short = squadShortfall(state, state.userTeamId, player);
      if (short) blockers.push(`우리 ${squadShortfallText(short, "release")}`);
      // 정산금은 합의한 날 즉시 나간다 — 낼 수 없는 값으로 흥정을 시작하지 않는다.
      // 분할이면 오늘 나갈 것은 첫 회분뿐이다 (transfer.md §5-2)
      const dueNow = firstInstallmentOf(terms.fee, terms.paymentYears);
      if (dueNow > financeOf(state, state.userTeamId).balance) {
        blockers.push(`정산금 ${josa(formatMoney(dueNow), "을/를")} 감당할 잔고가 없습니다`);
      }
    }
  } else {
    // 빌려 온 선수는 우리 스쿼드에 있지만 우리 선수가 아니다 — 데려올 수 있다
    if (player.teamId === state.userTeamId && !buyingLoanee) {
      blockers.push(`${josa(player.name, "은/는")} 이미 우리 선수입니다`);
    }
    /**
     * **사전 계약은 돈이 나가지 않는 영입이다** (§1-4). 그래서 나갈 돈을 재는 문이
     * 통째로 빠진다 — 이적창·무소속 이적료·예산 동결·이적 예산. 창이 빠지는 것은
     * 이 판을 여는 것이 협회의 달력이 아니라 계약의 만료일이기 때문이고, 예산이
     * 빠지는 것은 가난한 구단의 유일한 큰 영입 수단이 여기이기 때문이다.
     */
    if (precontract) {
      const reserved = precontractBlockerOf(state, player);
      if (reserved) blockers.push(reserved);
    } else {
      if (!window && !freeAgent) {
        blockers.push("이적시장이 닫혀 있습니다");
      }
      /**
       * **무소속엔 이적료를 받을 구단이 없다** (team.md §4). 막지 않으면 그 돈이
       * 세계 밖으로 나간다 — 아무도 쓰지 않는 잔고로 사라진다.
       */
      if (!isClubTeam(player.teamId) && terms.fee > 0) {
        blockers.push(`${josa(player.name, "은/는")} 무소속이라 이적료가 붙지 않습니다`);
      }
      const ourFinance = financeOf(state, state.userTeamId);
      if (ourFinance.budgetFrozen && terms.fee > 0) {
        // 동결에는 두 출구가 있다 — PSR과 부채 (finance.md §9.2·§9.4)
        blockers.push(
          `보드가 이적 예산을 동결했습니다${budgetFreezeLabel(state, state.userTeamId)} — 먼저 매각해야 합니다`,
        );
      }
      /**
       * **보드가 그 선수 앞으로 승인한 몫은 예산 위에 얹혀 있다** (finance.md §9.6).
       * 확정 관문(`negotiation.ts`의 `affordabilityGate`)이 보는 자와 같아야 한다 —
       * 갈리면 "가능하다"고 말한 오퍼가 도장 앞에서 막힌다 (transfer.md §11).
       *
       * 임대는 그 자를 쓰지 않는다: 보드가 승인한 것은 영입이지 임대가 아니다.
       */
      const signingBudget =
        terms.kind === "loan" ? ourFinance.transferBudget : signingBudgetOf(state, player.id);
      // 분할이면 이번 창에 나갈 것은 첫 회분뿐이다 (transfer.md §5-2).
      // 사이닝 보너스는 서명하는 날 같은 주머니에서 나간다 (transfer.md §12-3)
      if (
        firstInstallmentOf(terms.fee, terms.paymentYears) + signingBonusOf(terms.terms) >
        signingBudget
      ) {
        blockers.push(`이적 예산을 넘습니다 — 가용 ${formatMoney(signingBudget)}`);
      }
    }
    /**
     * **주급 여력** — 이적료를 낼 수 있어도 매주 나갈 돈이 없으면 못 데려온다.
     * AI 시장이 지키는 것과 같은 자다(`wageRoomOf`) — 이 관문이 감독에게도
     * 걸려야 임금 총액이 구단 한도 안에 머문다. **사전 계약에도 걸린다**: 돈이
     * 나가지 않아도 다음 시즌부터 매주 나갈 주급은 구단 한도 안이어야 한다 —
     * 이 문이 없으면 겨울마다 여력 밖의 스타 다섯을 공짜로 예약할 수 있다 (§1-4).
     */
    const room = userWageRoom(state);
    if (terms.weeklyWage > room) {
      blockers.push(
        room <= 0
          ? "주급 여력이 없습니다 — 임금 총액이 이미 구단 한도를 넘었습니다"
          : `주급 여력을 넘습니다 — 주당 ${formatMoney(room)}까지 가능합니다`,
      );
    }
  }

  return { blockers };
}

/** Display/seed estimate, never a requested or accepted condition. */
export function askingPriceFor(state: GameState, player: GamePlayer): number {
  return marketValueOf(state, player);
}
export function wageExpectationOf(state: GameState, player: GamePlayer): number {
  return (
    activeContract(state, player.id)?.weeklyWage ??
    Math.round(wageByRating(player.attributes.overall) / 1000) * 1000
  );
}
export function renewalExpectation(state: GameState, player: GamePlayer): number {
  return wageExpectationOf(state, player);
}
/** Remaining contractual wages are the unilateral termination obligation; no negotiated discount. */
export function unilateralSeveranceOf(state: GameState, playerId: string): number {
  const contract = activeContract(state, playerId);
  return contract
    ? Math.round(contract.weeklyWage * Math.max(0, diffDays(state.date, contract.until) / 7))
    : 0;
}
export function severanceOf(state: GameState, playerId: string): number {
  return unilateralSeveranceOf(state, playerId);
}
/** A reply date exists only after a recorded evaluation schedules it. */
export function describePending(_days?: number, kind: "deal" | "release" = "deal"): string {
  return kind === "release"
    ? "상대의 응답 대기 — 아직 해지가 확정되지 않았습니다"
    : "상대의 응답 대기 — 아직 계약이 확정되지 않았습니다";
}
