// 도메인에서 가져온다 — 엔진을 값으로 import하면 `node:fs`가 브라우저 번들에 딸려 온다
import { ratingTier, type RatingTier } from "@story-fm/domain";

/**
 * 숫자의 강약만 은은하게 구분하는 네 구간 — **경계는 코어의 등급표가 갖는다.**
 *
 * 카드가 자기 경계를 따로 들고 있으면 같은 86이 여기서는 `top`이고 GM의 말에서는
 * `리그 최정상`이라, 같은 선수를 두 자로 재게 된다. 코어가 일곱 등급으로 자른 뒤
 * (`ratingTier`) 화면은 그것을 **색 넷으로 묶기만** 한다 — 묶는 것은 색 고르기지
 * 등급 매기기가 아니다.
 */
const TONE_OF_TIER: Record<RatingTier, "top" | "strong" | "solid" | "low"> = {
  world: "top",
  elite: "top",
  first: "strong",
  squad: "solid",
  par: "solid",
  below: "low",
  weak: "low",
};

export function ratingTone(value: number): "top" | "strong" | "solid" | "low" {
  return TONE_OF_TIER[ratingTier(value)];
}

export const GROWTH_LABELS = ["매우 낮음", "낮음", "보통", "높음", "매우 높음", "탁월함"] as const;

/** 관측된 성장 여지의 단계. 배치 전력이나 참 잠재력은 입력으로 받지 않는다. */
export function growthTier(
  overall: number | null,
  potential: { low: number; high: number } | null,
): number | null {
  if (overall === null || potential === null) return null;
  const ceiling = (potential.low + potential.high) / 2;
  const headroom = Math.max(0, ceiling - overall);
  const tier = [3, 6, 10, 15, 20].findIndex((ceiling) => headroom < ceiling);
  if (tier !== -1) return tier;
  const ceilingTier = ratingTier(ceiling);
  return ceilingTier === "elite" || ceilingTier === "world" ? 5 : 4;
}

/** Stored observation intervals remain intervals; missing evidence stays unknown. */
export function observationRange(range: { low: number; high: number } | null): string {
  if (range === null) return "판단 보류";
  return range.low === range.high ? String(range.low) : `${range.low}–${range.high}`;
}
