/**
 * 사건의 **꼬리표** — 종류 하나에 낱말 하나.
 *
 * 코어가 내는 것은 `kind`와 문장뿐이다(`TickEvent`). 「부상」이라는 낱말은 화면의 것이라
 * 여기 있다 — 코어가 그것을 알면 종류가 두 벌로 선다.
 *
 * 꼬리표의 색은 여기 없다. 색은 토큰이고 토큰은 CSS의 것이라
 * `.fact[data-kind=…]`가 갖는다 (shared/marks.css).
 */
import type { TickEventKind } from "@gaffer/domain";

const LABEL: Record<TickEventKind, string> = {
  injury: "부상",
  board: "보드",
  draw: "추첨",
  contract: "계약",
  matchday: "경기",
  news: "소식",
};

/**
 * 종류 하나의 꼬리표.
 *
 * ⚠️ 모르는 종류는 **소식**이다. 코어가 종류를 하나 늘린 날 이미 저장된 세이브를
 * 읽으면 표에 없는 낱말이 오는데, 그때 줄이 아예 서지 않으면 사실 하나가
 * 사라진다 — 문장은 종류를 몰라도 읽힌다.
 */
export function tickEventLabel(kind: TickEventKind): string {
  // 타입은 아는 종류만 말하지만 값은 옛 세이브에서 온다
  return (LABEL as Partial<Record<string, string>>)[kind] ?? LABEL.news;
}
