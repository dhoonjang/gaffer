import { type GameState } from "../core/state";
import { type Mentoring, type MentoringEnd } from "@story-fm/domain";

// ── 장부 읽기 ────────────────────────────────────────

/** 현재 유효한 훈련 배정 */
export function activeMentorings(state: GameState): Mentoring[] {
  return state.mentoring.filter((m) => m.until === undefined);
}

/** 이 멘티의 현재 훈련 배정 — 없으면 null */
export function mentorPairOf(state: GameState, menteeId: string): Mentoring | null {
  return activeMentorings(state).find((m) => m.menteeId === menteeId) ?? null;
}

// ── 여닫기 ───────────────────────────────────────────

/**
 * 배정 종료일과 사유를 기록한다 (people.md §5-3).
 *
 * @returns 이번 호출로 종료된 배정
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

/** 이 선수가 포함된 현재 배정을 모두 종료한다. */
export function closeMentoringsFor(
  state: GameState,
  playerId: string,
  endedBy: MentoringEnd,
): Mentoring[] {
  return closeMentorings(state, (p) => p.mentorId === playerId || p.menteeId === playerId, endedBy);
}
