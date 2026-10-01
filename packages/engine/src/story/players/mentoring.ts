import { type GameState, playerById } from "../../common/core/state";
import { type Mentoring, type GamePlayer, josa } from "@story-fm/domain";
import { activeMentorings } from "../../common/players/mentoring";
import { diffDays } from "../../common/core/dates";

/** 이 멘토에게 현재 배정된 선수 — 배정 순서대로 */
export function menteePairsOf(state: GameState, mentorId: string): Mentoring[] {
  return activeMentorings(state).filter((m) => m.mentorId === mentorId);
}

export function mentoringReadOf(state: GameState, playerId: string): MentoringRead | null {
  const rows = state.mentoring;
  const mine = rows.filter((m) => m.mentorId === playerId || m.menteeId === playerId);
  if (mine.length === 0) return null;
  /** 현재 배정을 우선하고, 없으면 조회 기간 내 최근 종료된 배정을 읽는다. */
  const open = mine.filter((m) => m.until === undefined);
  const pick =
    open.sort((a, b) => (a.since < b.since ? 1 : -1))[0] ??
    mine
      .filter((m) => m.until !== undefined && diffDays(m.until, state.date) <= MENTORING_ECHO_DAYS)
      .sort((a, b) => (a.until! < b.until! ? 1 : -1))[0];
  if (!pick) return null;

  const side = pick.mentorId === playerId ? "mentor" : "mentee";
  const otherId = side === "mentor" ? pick.menteeId : pick.mentorId;
  const from = pick.until ?? pick.since;
  return {
    side,
    pair: pick,
    other: playerById(state, otherId) ?? null,
    days: Math.max(0, diffDays(from, state.date)),
    count: side === "mentor" ? menteePairsOf(state, playerId).length : 0,
  };
}

export function pruneMentoring(state: GameState): void {
  const rows = state.mentoring;
  if (rows.length === 0) return;

  for (const pair of rows) {
    if (pair.until !== undefined) continue;
    const mentor = playerById(state, pair.mentorId);
    const mentee = playerById(state, pair.menteeId);
    if (!mentor || !mentee || !ourPlayer(state, mentor) || !ourPlayer(state, mentee)) {
      pair.until = state.date;
      pair.endedBy = "departure";
      continue;
    }
  }

  state.mentoring = rows.filter(
    (p) => p.until === undefined || diffDays(p.until, state.date) <= MENTORING_ECHO_DAYS,
  );
}

/** 종료된 배정을 조회할 수 있는 기간. */
export const MENTORING_ECHO_DAYS = 7;

export interface MentoringRead {
  side: "mentor" | "mentee";
  pair: Mentoring;
  /** 상대 — 이미 세계에서 사라졌으면 null */
  other: GamePlayer | null;
  /** 현재 배정은 시작일부터, 종료된 배정은 종료일부터 경과한 일수 */
  days: number;
  /** 이 멘토에게 현재 배정된 선수 수 (멘티 쪽은 0) */
  count: number;
}

// ── 자격 ─────────────────────────────────────────────

/** 우리 선수인가 — 소속(`teamId`)이 우리 팀이어야 한다 */
export function ourPlayer(state: GameState, player: GamePlayer): boolean {
  return player.teamId === state.userTeamId;
}

/**
 * 멘토가 될 수 있는가 — **막는 이유 한 문장**, 자격이 되면 null.
 *
 * 문장을 여기서 짓는 것은 명령이 감독에게 그대로 답하기 때문이다(`setMentor`) —
 * 반려는 무엇이 모자란지를 말해야 감독이 다음 수를 둔다.
 */
export function mentorBlock(state: GameState, player: GamePlayer): string | null {
  if (!ourPlayer(state, player)) return `${josa(player.name, "은/는")} 우리 선수가 아닙니다`;
  return null;
}

/** 멘티가 될 수 있는가 — 막는 이유 한 문장, 자격이 되면 null */
export function menteeBlock(state: GameState, player: GamePlayer): string | null {
  if (!ourPlayer(state, player)) return `${josa(player.name, "은/는")} 우리 선수가 아닙니다`;
  return null;
}
