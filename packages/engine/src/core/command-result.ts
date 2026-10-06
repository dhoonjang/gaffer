import { type CommandBrief, type CommandBriefItem } from "./state";

/**
 * 도구와 코어 명령 = 상태 변경의 유일한 통로 (overview §2.2·§5).
 * 판정형: LLM은 {outcome, intensity}만 정하고 변화량은 코어 공식이 정한다
 * (overview §7 · career.md §2).
 *
 * 반환 계약은 명령이 어느 갈래든 같은 것을 쓴다 — 대화도 라인업도 훈련도
 * 이 타입 하나로 답한다.
 */

export interface CommandResult {
  ok: boolean;
  /** LLM에게 돌려주는 줄 — 모델이 읽을 것이므로 길어도 된다 */
  message: string;
  /**
   * **화면이 항목으로 세우는 요약** (`CommandBrief`) — 말풍선과 칩이 이걸 읽는다.
   *
   * 손댄 것을 다 이어 붙인 `message`를 화면이 되쪼개면 한 줄이 글자 벽이 된다.
   *
   * ⚠️ **말풍선을 갖는 호출(`PANEL_OF`)은 모두 채운다** — 비우면 그 호출은 말풍선에
   * 서지 않는다. `message`는 모델에게 돌려주는 줄이지 화면의 항목이 아니라서,
   * 화면이 그 줄을 갈라 세우면 코어가 쓴 문장의 첫 줄이 곧 UI가 된다
   * (→ docs/core/game-state.md §3.6).
   */
  brief?: CommandBrief;
  /**
   * 화면이 카드로 그릴 **구조화된 결과** — 채우는 호출만 채운다.
   * 넣지 않는 것이 기본이다.
   */
  payload?: unknown;
  /** 결이 좋은가 — 대화형 스킬의 칩 색 (펼치지 않아도 알게) */
  tone?: "good" | "bad";
  /**
   * **아무것도 달라지지 않은 성공** — 이미 그 자리, 이미 그 층.
   *
   * 부르는 쪽은 "바꾼 것"과 "이미 그랬던 것"을 갈라야 하는데, 반려 문구를
   * `includes("이미")`로 뒤지면 문장을 다듬는 것만으로 판정이 뒤집힌다
   * (→ docs/players/player.md §3.1).
   */
  unchanged?: boolean;
}

/**
 * **말풍선 항목을 짓는 한 벌** — 명령이 어느 폴더에 있든 같은 모양으로 낸다.
 *
 * 항목은 `label`(무엇에 대한 것) · `text`(바뀐 값) · `note`(갈래) · `delta`(증감)로
 * 나뉜다. 화면이 그 자리마다 톤을 정하므로, 코어가 셋을 한 문자열로 붙여 내면
 * 화면은 되쪼개는 수밖에 없다 (→ docs/core/game-state.md §3.6).
 */

/**
 * **머리줄(`brief.head`)은 그 행동의 이름이다** — 그 행동을 부른 도구의 이름과 같은
 * 말이면 **같은 말로 적는다.**
 *
 * 머리줄이 가는 곳은 둘이다: 프롬프트의 장부 줄(`toolCallFactLine` — 호출 하나에 한
 * 줄이라 이름이 있어야 무슨 일이 있었는지가 남는다)과, 화면의 칩을 펼친 속. 화면의
 * 칩은 그 이름을 이미 버튼에 쓰고 있으므로 **같으면 화면이 하나만 세운다**
 * (`chat.tsx`). 「완장」과 「완장 지정」처럼 한 글자씩 다르면
 * 화면은 둘을 다른 말로 보고 나란히 세운다 — 그래서 이름을 맞춘다.
 */

/** 한 항목에 이름을 몇 개까지 적나 — 항목 하나가 말풍선 한 줄이라 둘에서 접는다 */
const BRIEF_NAMES_SHOWN = 2;

/**
 * 항목에 적는 이름 — **둘에서 접는다.**
 *
 * `message`는 모델이 읽으므로 더 길어도 되지만(`nameList`) 항목 하나는 한 줄이라
 * 더 좁다. 누가 더 있는지는 스쿼드 화면이 갖고 있다.
 */
export const briefNames = (names: readonly string[]): string =>
  names.slice(0, BRIEF_NAMES_SHOWN).join(", ") +
  (names.length > BRIEF_NAMES_SHOWN ? ` 외 ${names.length - BRIEF_NAMES_SHOWN}명` : "");

/**
 * 부호를 붙인 수 — 항목의 증감 표기 (`+2` · `−2`).
 *
 * 감소는 유니코드 −(U+2212)다. ASCII 하이픈을 쓰면 포메이션(`4-2-3-1`)과 같은 자를
 * 지나 사람 눈에도 갈리지 않는다.
 */
export const signed = (n: number): string => (n < 0 ? `−${Math.abs(n)}` : `+${n}`);

/**
 * 말풍선 항목 하나 — **앞의 이름(`label`) · 값(`text`) · 뒤의 갈래(`note`) · 증감(`delta`).**
 *
 * 빈 조각은 달지 않는다 (없는 키와 빈 문자열이 화면에서 달리 그려지지 않게).
 * `delta`만은 `0`도 싣는다 — "안 움직였다"는 증감을 말하지 않는 것과 다른 사실이다.
 */
export const item = (parts: {
  label?: string;
  text: string;
  note?: string;
  delta?: number;
}): CommandBriefItem => ({
  ...(parts.label ? { label: parts.label } : {}),
  text: parts.text,
  ...(parts.note ? { note: parts.note } : {}),
  ...(parts.delta === undefined ? {} : { delta: parts.delta }),
});
