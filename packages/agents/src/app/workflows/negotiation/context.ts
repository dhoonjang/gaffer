import { type GameState, teamName, openManagerOffers } from "@story-fm/engine";
import { OFFER_VIA_KO, offerTerms, offerSeat } from "../../../negotiation/context";

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
