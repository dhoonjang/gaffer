import { type GameState, playerById, isOurPlayer } from "../core/state";
import { MOOD_NOTE_MAX } from "@story-fm/domain";

// ── 잔향 — 그 선수와 있었던 일을 쓴 호출이 한 문장을 남기는 자리 ────────────────────

/**
 * 한 호출이 한 번에 남길 수 있는 심경 문장의 상한 — 경기 결산(`settle_match`)이
 * 출전 선수에게 쓰는 수다. 열한 명이 뛰어도 그 경기에 할 말이 있는 사람은 그보다 적다
 * (people.md §5).
 */
export const MOOD_BATCH = 8;

/** 팀토크 한 번이 남길 수 있는 심경 문장의 상한 — 라커룸 전체에 한 말이라 셋에서 접는다 */
export const TEAM_TALK_MOODS = 3;

/** 이미 끝난 문장 — `?`·`!`도 종결이라 마침표를 덧붙이지 않는다 */
const SENTENCE_END = /[.!?]$/u;

/**
 * 호출이 제출하는 한 줄 — **문장과 그 문장에 대한 사실 하나.**
 *
 * `acknowledgesIssue`는 문장을 쓴 쪽만 답할 수 있는 것이다. 코어가 `"불만"`이라는
 * 낱말이 들어 있는지 세던 자리라, 같은 뜻의 다른 말("서운하다", "받아들이지
 * 못한다")은 전부 버려지고 낱말만 박아 넣은 문장은 통과했다 — 문구를 판정에 쓰면
 * 언제나 그렇게 갈린다 (overview.md §1 철칙 4). 생략하면 안지 않은 것이다.
 */
export interface MoodNoteSubmission {
  playerId: string;
  text: string;
  /** 이 문장이 그 선수에게 걸린 불만을 안고 있는가 — 쓴 쪽이 말한다 */
  acknowledgesIssue?: boolean;
}

/** 대상이 하나로 정해진 자리(면담·회견·응대)의 심경 인자 — 선수는 그 호출이 안다 */
export type MoodLine = Omit<MoodNoteSubmission, "playerId">;

/**
 * 호출이 남긴 심경 문장을 장부에 적는다 — **사실은 코어가 잡고 결만 받는다**
 * (people.md §5 「잔향」 · agents.md §4-3).
 *
 * `allowed`는 **그 호출이 실제로 닿은 선수**다 — 면담이면 그 한 명, 팀토크면 그 말을
 * 들은 명단, 경기 결산이면 출전 선수. 밖의 이름은 버린다: 면담의 문장이 다른 선수에게
 * 서면 대화가 없던 사람의 심경이 대화로 움직인다.
 *
 * 버려지는 문장은 사실 카드를 남긴다(빈 자리가 되지 않는다). 거르는 조건은 셋이다:
 * ① 닿지 않은 선수 ② 한 문장이 아니거나 너무 긴 문장 — **저장할 문장의 형태 검사다**
 * ③ **불만이 걸린 선수인데 그 사실을 안지 않은 문장** — 감독이 손을 써야 하는 일이
 * 결에 묻히면 안 된다. 같은 선수가 두 줄로 오면 첫 줄만 받는다.
 *
 * @returns 실제로 반영된 수
 */
export function applyMoodNotes(
  state: GameState,
  notes: readonly MoodNoteSubmission[],
  allowed: ReadonlySet<string>,
): number {
  let applied = 0;
  const seen = new Set<string>();
  for (const note of notes) {
    if (!allowed.has(note.playerId) || seen.has(note.playerId)) continue;
    seen.add(note.playerId);
    const text = note.text.trim();
    if (text.length === 0) continue;
    // 한 문장 — 마침표가 문장 중간에 여러 번 나오면 여러 문장이다
    if ((text.match(/[.!?]/gu) ?? []).length > 1) continue;
    // 재는 것은 **저장할 문장**이다 — 마침표를 붙인 뒤 재지 않으면 121자가 세이브로 나간다
    const sentence = SENTENCE_END.test(text) ? text : `${text}.`;
    if (sentence.length > MOOD_NOTE_MAX) continue;
    const hasIssue = state.issues.some((i) => i.gamePlayerId === note.playerId);
    if (hasIssue && note.acknowledgesIssue !== true) continue;
    const player = playerById(state, note.playerId);
    if (!player || !isOurPlayer(state, player)) continue;
    player.state.moodNote = { text: sentence, on: state.date };
    applied += 1;
  }
  return applied;
}
