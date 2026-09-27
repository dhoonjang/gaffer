import { domesticCupById } from "../data/domestic-cup-catalog";
import { clubsOfCountry } from "../data/team-catalog";

/**
 * 이 컵의 참가 **명단** — 그 나라 1부 + 2부 전체 (카탈로그가 32팀으로 맞춰져 있다).
 * 시드 진입 라운드가 있는 대회는 이 중 누가 실제로 뛰는지를 `domesticCupField`가
 * 가른다 — 32라는 수는 대회 성립의 불변식이라 여기서 줄이지 않는다.
 */
export function domesticCupEntrants(cupId: string): string[] {
  const cup = domesticCupById(cupId);
  if (!cup) return [];
  return clubsOfCountry(cup.country).map((t) => t.id);
}
