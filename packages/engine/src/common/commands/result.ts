import type { CommandBrief } from "../core/state";

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
   * (→ docs/common/game-state.md §3.6).
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
   * (→ docs/common/player.md §3.1).
   */
  unchanged?: boolean;
}
