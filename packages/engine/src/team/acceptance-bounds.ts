import { affordableWageBill } from "./finance";
import { reservedTransferPayments } from "./transfer-accounting";
import { ageOf, type Negotiation, type ProposalTerms, totalTransferFee } from "@story-fm/domain";
import { activeContract, financeOf, type GameState } from "../core/state";
import { observedPlayerFacts } from "../players/observation";
const DAYS_PER_YEAR = 365.25;
const WEEKS_PER_YEAR = 52;
const FEE_SALARY_MULTIPLE = 3;
const SELLER_MINIMUM_SHARE = 0.25;
const PLAYER_MINIMUM_SHARE = 0.65;
const BUYER_WAGE_MULTIPLE = 4;
export function negotiationBounds(
  state: GameState,
  n: Pick<Negotiation, "playerId" | "buyerId" | "sellerId" | "kind">,
) {
  const player = state.players.find((p) => p.id === n.playerId)!;
  const contract = activeContract(state, player.id),
    overall = observedPlayerFacts(state, player).overall;
  const balance = financeOf(state, n.buyerId).balance;
  const reserved = reservedTransferPayments(state, n.buyerId);
  const available = Math.max(0, balance - reserved),
    wage = contract?.weeklyWage ?? 0;
  const listing = state.transferListings.find((l) => l.gamePlayerId === player.id);
  const injuries = state.injuries.filter(
    (i) => i.gamePlayerId === player.id && i.returnedOn === null,
  );
  const age = ageOf(player.birthdate, state.date);
  const years = contract
    ? Math.max(
        0.25,
        (Date.parse(contract.until) - Date.parse(state.date)) / (86400000 * DAYS_PER_YEAR),
      )
    : 0;
  const marketWage = Math.max(wage, 100 + overall * overall * 2);
  const feeAnchor = Math.max(
    0,
    marketWage *
      WEEKS_PER_YEAR *
      FEE_SALARY_MULTIPLE *
      Math.min(3, years) *
      (age > 30 ? 0.6 : 1) *
      (injuries.length ? 0.8 : 1),
  );
  const minFee = Math.floor(feeAnchor * SELLER_MINIMUM_SHARE * (listing ? 0.75 : 1));
  const maxFee = Math.floor(
    Math.min(available, Math.max(feeAnchor * 3, marketWage * WEEKS_PER_YEAR)),
  );
  const minWage = Math.floor(Math.max(wage * 0.5, marketWage * PLAYER_MINIMUM_SHARE));
  const clubWages = state.contracts
    .filter((c) => c.status === "active" && c.teamId === n.buyerId)
    .map((c) => c.weeklyWage);
  const existingWeekly =
    clubWages.reduce((s, w) => s + w, 0) - (contract?.teamId === n.buyerId ? wage : 0);
  const payrollHeadroom = Math.max(
    wage,
    affordableWageBill(n.buyerId, undefined, state) / WEEKS_PER_YEAR - existingWeekly,
  );
  const wageCapacity = Math.min(marketWage * BUYER_WAGE_MULTIPLE, payrollHeadroom);
  const maxWage = Math.floor(wageCapacity);
  return {
    fingerprint: JSON.stringify([
      contract?.id,
      contract?.weeklyWage,
      contract?.until,
      overall,
      age,
      years,
      injuries,
      listing,
      available,
      wageCapacity,
    ]),
    asOf: state.date,
    minFee,
    maxFee,
    minWeeklyWage: minWage,
    maxWeeklyWage: maxWage,
    maxSigningBonus: Math.floor(Math.min(available, marketWage * WEEKS_PER_YEAR)),
    minYears: 0.25,
    maxYears: 6,
    reasons: [
      "현재 계약 보수와 잔여 기간",
      "관측 선수 수준·나이·현재 부상",
      "이적 명단과 미지급 의무를 제외한 예산",
    ],
  };
}
export function acceptanceBoundError(
  state: GameState,
  n: Negotiation,
  terms: ProposalTerms,
  partyId: string,
): string | null {
  const bounds = negotiationBounds(state, n);
  if (terms.scope === "club") {
    const fee = totalTransferFee(terms);
    if (partyId === n.sellerId && fee < bounds.minFee)
      return "상대 구단의 현재 계약·선수 가치에 따른 최소 이적 대금에 못 미칩니다";
    if (fee > bounds.maxFee) return "영입 구단의 선수 가치·예산에 따른 이적 대금 한도를 넘습니다";
    return null;
  }
  const years =
    (Date.parse(terms.until) - Date.parse(terms.since) + 86400000) / (86400000 * DAYS_PER_YEAR);
  const annual = terms.weeklyWage * WEEKS_PER_YEAR + terms.signingBonus / years;
  if (years < bounds.minYears || years > bounds.maxYears + 0.01)
    return "상대가 수용할 수 있는 계약 기간을 벗어납니다";
  if (
    partyId === n.playerId &&
    (terms.weeklyWage < bounds.minWeeklyWage || annual < bounds.minWeeklyWage * WEEKS_PER_YEAR)
  )
    return "선수의 현재 보수·수준에 따른 보장 보수에 못 미칩니다";
  if (
    terms.weeklyWage > bounds.maxWeeklyWage ||
    terms.signingBonus > bounds.maxSigningBonus ||
    annual > bounds.maxWeeklyWage * WEEKS_PER_YEAR
  )
    return "영입 구단의 보수·계약금·총 보장 지출 한도를 넘습니다";
  return null;
}
