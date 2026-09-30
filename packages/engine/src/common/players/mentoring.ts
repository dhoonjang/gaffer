import { type GameState } from "../core/state";
import { type Mentoring, type MentoringEnd } from "@story-fm/domain";

// ── 장부 읽기 ────────────────────────────────────────

/** 지금 서 있는 사이 — 닫힌 줄은 빠진다 */
export function activeMentorings(state: GameState): Mentoring[] {
  return state.mentoring.filter((m) => m.until === undefined);
}

/** 이 멘티에게 붙어 있는 멘토 — 없으면 null */
export function mentorPairOf(state: GameState, menteeId: string): Mentoring | null {
  return activeMentorings(state).find((m) => m.menteeId === menteeId) ?? null;
}

// ── 여닫기 ───────────────────────────────────────────

/**
 * 사이를 닫는다 — **지우지 않는다** (people.md §5-3).
 *
 * @returns 닫힌 쌍들 (이미 닫혀 있던 줄은 세지 않는다)
 */
export function closeMentorings(
  state: GameState,
  match: (pair: Mentoring) => boolean,
  endedBy: MentoringEnd,
): Mentoring[] {
  const closed: Mentoring[] = [];
  for (const pair of state.mentoring) {
    if (pair.until !== undefined || !match(pair)) continue;
    pair.until = state.date;
    pair.endedBy = endedBy;
    closed.push(pair);
  }
  return closed;
}

/** 이 선수가 든 사이를 전부 닫는다 — 떠남·층 이동이 부르는 자리 */
export function closeMentoringsFor(
  state: GameState,
  playerId: string,
  endedBy: MentoringEnd,
): Mentoring[] {
  return closeMentorings(state, (p) => p.mentorId === playerId || p.menteeId === playerId, endedBy);
}
