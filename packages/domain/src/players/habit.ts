import {
  CARD_WORDS,
  CARD_WORD_DEFS,
  cardWordsAt,
  type CardSteps,
  type CardWord,
} from "./role-card";
import { INCLINATION_AXES, weightSlotOf, type InclinationAxis } from "./player";
import { SLOT_INCLINATION } from "./slot-reference";

/**
 * **타고난 버릇** — 성향 축이 같은 낱말을 기울인다 (player.md §3.4).
 *
 * 버릇은 그 자리 선수의 평균에서 벗어난 만큼이라, 평균적인 선수는 0이다. 리그 전체를 한쪽으로
 * 기울이지 않고 선수마다의 퍼짐만 만든다.
 */

/** 성향 축 → 그 축이 기울이는 낱말 */
export const HABIT_WORDS: Readonly<Record<InclinationAxis, readonly CardWord[]>> = {
  flair: ["dribble"],
  aggression: ["press"],
  workRate: ["attack", "recover"],
  rushingOut: ["sweep"],
  commandOfArea: [],
};

/** 성향 축 몇 점이 낱말 한 단계인가 — 자리 안의 표준편차(10~14)가 한 단계 남짓이다 */
export const HABIT_SCALE = 12;

/** 버릇 한 낱말의 끝 — 카드의 반 */
export const HABIT_MAX = 1.5;

/** 카드와 반대쪽인 버릇이 남는 몫 — 팀워크는 숫자가 아니라 모두에게 같다 */
export const HABIT_AGAINST_CARD = 0.5;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** 그 자리에서 이 선수의 버릇 — 버릇이 없는 낱말은 싣지 않는다 */
export function habitSteps(
  inclinations: Readonly<Record<InclinationAxis, number>>,
  position: string,
): CardSteps {
  const slot = weightSlotOf(position);
  const reference = SLOT_INCLINATION[slot];
  const words = cardWordsAt(slot === "GK");
  const out: CardSteps = {};
  for (const axis of INCLINATION_AXES) {
    const lean = (inclinations[axis] - reference[axis]) / HABIT_SCALE;
    const step = round2(Math.max(-HABIT_MAX, Math.min(HABIT_MAX, lean)));
    if (step === 0) continue;
    for (const word of HABIT_WORDS[axis]) if (words.includes(word)) out[word] = step;
  }
  return out;
}

/**
 * 카드(경기 중 수정을 덮은 것)에 버릇을 얹는다 — 같은 쪽이거나 카드가 0이면 온전히 더하고,
 * 반대쪽이면 `HABIT_AGAINST_CARD`만 남는다.
 */
export function withHabit(card: CardSteps, habit: CardSteps): CardSteps {
  const out: CardSteps = { ...card };
  for (const word of CARD_WORDS) {
    const lean = habit[word] ?? 0;
    if (lean === 0) continue;
    const step = card[word] ?? 0;
    const against = step !== 0 && step > 0 !== lean > 0;
    out[word] = round2(step + lean * (against ? HABIT_AGAINST_CARD : 1));
  }
  return out;
}

/** 버릇을 말로 — `드리블 +1.2 · 압박 −0.5`. 카드 단계와 달리 소수가 선다. 버릇이 없으면 빈 문자열 */
export function habitLine(habit: CardSteps): string {
  return CARD_WORDS.flatMap((word) => {
    const lean = habit[word] ?? 0;
    if (lean === 0) return [];
    return [`${CARD_WORD_DEFS[word].ko} ${lean > 0 ? "+" : "−"}${Math.abs(lean).toFixed(1)}`];
  }).join(" · ");
}
