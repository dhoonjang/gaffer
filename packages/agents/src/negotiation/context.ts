import { type ManagerOffer, formatMoney, boardExpectationText } from "@story-fm/domain";
import { teamName } from "@story-fm/engine";

/**
 * 제안이 부른 자리 — 어느 구단이 어떤 자리로 부르는가 (career.md §5.1).
 * 무직의 목록과 재직 중의 줄이 같은 함수를 읽는다.
 */
export function offerSeat(offer: ManagerOffer): string {
  return [
    `${teamName(offer.teamId)} (${offer.tier}티어)`,
    `기대 ${offerExpectation(offer)}`,
    offer.position ? `현재 ${offer.position}위` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

/** 제안이 들고 온 조건과 기한 — 자리와 마찬가지로 두 스냅샷이 같은 것을 읽는다 */
export function offerTerms(offer: ManagerOffer): string {
  return [
    offer.salary
      ? `연봉 ${formatMoney(offer.salary)}·${offer.years}년·이적 예산 약속 ${formatMoney(offer.budgetPledge)}`
      : null,
    // 보상금은 감독의 지갑을 지나지 않는다 — 새 구단이 지금 구단에 무는 돈이다
    offer.compensation ? `지금 구단에 보상금 ${formatMoney(offer.compensation)}` : null,
    offer.counteredOn ? `흥정은 끝났다 — 수락 여부만 남았다` : null,
    `${offer.expiresOn}까지`,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

/** 제안이 선 갈래 — 재직 중에는 갈래가 곧 사실이다 (career.md §5.1) */
export const OFFER_VIA_KO: Record<NonNullable<ManagerOffer["via"]>, string> = {
  renewal: "보드의 재계약 제안",
  poach: "다른 구단의 접근",
  knock: "두드린 자리의 제안",
  vacancy: "감독직 제안",
};

/** 제안에 걸린 기대 한 줄 — 갈래 코드가 원본이다 (career.md §5.1) */
function offerExpectation(offer: ManagerOffer): string {
  return boardExpectationText(offer.expectationCode, offer.target);
}
