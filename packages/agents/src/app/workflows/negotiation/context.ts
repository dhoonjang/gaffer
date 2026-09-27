import { type GameState, teamName, openManagerOffers, VACANCY_KNOCK_DAYS } from "@story-fm/engine";
import { OFFER_VIA_KO, offerTerms, offerSeat } from "../../../negotiation/context";

/** 두드릴 수 있는 공석 한 줄씩 — 무직의 명부와 재직 중의 줄이 같은 것을 읽는다 */
export function vacancyRows(state: GameState): string[] {
  return state.managerVacancies.map(
    (v) => `- ${teamName(v.teamId)}${v.position ? ` · 현재 ${v.position}위` : ""} · ${v.on} 공석`,
  );
}

/**
 * **재직 중인 감독의 거취** — 열린 감독직 제안과 두드릴 수 있는 공석
 * (career.md §5.1 「재직 중 접근·노크」 · §5.4).
 *
 * 열흘이면 사라지는 답할 자리라 스냅샷에 서야 한다 — 화면에만 있으면 모델은 감독이
 * 무엇을 두고 답하는지 모른 채 장면을 쓴다. 갈래는 셋이다: 보드의 재계약, 다른
 * 구단의 접근, 감독이 두드려 얻은 자리.
 *
 * 재계약은 구단도 자리도 그대로라 구단·기대를 다시 적지 않는다 — 바로 위의 보드
 * 기대 줄이 그것이다.
 */
export function managerSeatLines(state: GameState): string[] {
  const offers = openManagerOffers(state).map((o) =>
    o.via === "renewal"
      ? `${OFFER_VIA_KO.renewal}: ${o.id} · ${offerTerms(o)}`
      : `${OFFER_VIA_KO[o.via]}: ${o.id} · ${offerSeat(o)} · ${offerTerms(o)}`,
  );
  const vacancies = vacancyRows(state);
  return vacancies.length > 0
    ? [...offers, `공석 (경질 뒤 ${VACANCY_KNOCK_DAYS}일 안):`, ...vacancies]
    : offers;
}
