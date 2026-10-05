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
