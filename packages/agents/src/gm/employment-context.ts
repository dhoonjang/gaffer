import { type ManagerOffer, formatMoney, CLUB_TIER_KO } from "@story-fm/domain";
import { teamName, type GameState, openManagerOffers } from "@story-fm/engine";

/**
 * 제안이 부른 자리 — 어느 구단이 어떤 자리로 부르는가 (career.md §5.1).
 * 무직의 목록과 재직 중의 줄이 같은 함수를 읽는다.
 */
export function offerSeat(offer: ManagerOffer): string {
  return [
    `${teamName(offer.teamId)} (${CLUB_TIER_KO[offer.tier]})`,
    offer.position ? `현재 ${offer.position}위` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

/** 제안이 들고 온 조건과 기한 — 자리와 마찬가지로 두 스냅샷이 같은 것을 읽는다 */
export function offerTerms(offer: ManagerOffer): string {
  return [
    offer.salary ? `연봉 ${formatMoney(offer.salary)}·${offer.years}년` : null,
    // 보상금은 새 구단이 지금 구단에 지급하는 계약 정산이다
    offer.compensation ? `지금 구단에 보상금 ${formatMoney(offer.compensation)}` : null,
    `${offer.expiresOn}까지`,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

/** 제안이 선 갈래 — 재직 중에는 갈래가 곧 사실이다 (career.md §5.1) */
const OFFER_VIA_KO: Record<NonNullable<ManagerOffer["via"]>, string> = {
  renewal: "보드의 재계약 제안",
  poach: "다른 구단의 접근",
  knock: "두드린 자리의 제안",
  vacancy: "감독직 제안",
};

/** 두드릴 수 있는 공석 한 줄씩 — 무직의 명부와 재직 중의 줄이 같은 것을 읽는다 */
export function vacancyRows(state: GameState): string[] {
  return state.managerVacancies.map(
    (v) => `- ${teamName(v.teamId)}${v.position ? ` · 현재 ${v.position}위` : ""} · ${v.on} 공석`,
  );
}

/** 재직 중에도 제안과 실제 공석을 읽는다. */
export function managerSeatLines(state: GameState): string[] {
  const offers = openManagerOffers(state).map((o) =>
    o.via === "renewal"
      ? `${OFFER_VIA_KO.renewal}: ${o.id} · ${offerTerms(o)}`
      : `${OFFER_VIA_KO[o.via]}: ${o.id} · ${offerSeat(o)} · ${offerTerms(o)}`,
  );
  const vacancies = vacancyRows(state);
  return vacancies.length > 0 ? [...offers, `공석 (후임 선임 전):`, ...vacancies] : offers;
}
