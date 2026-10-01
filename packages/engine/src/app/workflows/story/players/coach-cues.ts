import { isReserveMatch } from "@story-fm/domain";
import { nextMatchFor } from "../../../../common/core/calendar";
import { diffDays } from "../../../../common/core/dates";
import { type GameState, managedTeamId } from "../../../../common/core/state";
import { matchdayRevenue } from "../../../../common/finance/finance";
import {
  captain,
  type CoachCue,
  type CoachEye,
  type CoachSight,
  derby,
  expectation,
  fixtureHead,
  h2hTally,
  headToHeadCue,
  injuryLog,
  injuryRisk,
  matchupAxis,
  opponentForm,
  opponentTable,
  prospects,
  reserveRecord,
  tiredStarters,
  trainingReportCue,
} from "../../../../story/players/coach-cues";

/** 다음 홈경기에 관중석이 얼마나 차는가 — 다음 경기가 원정이면 그 뒤의 홈경기다 */
const gate: CoachEye = (state) => {
  const home = state.matches
    .filter(
      (m) =>
        m.result === null &&
        !isReserveMatch(m) &&
        m.neutral !== true &&
        m.homeTeamId === state.userTeamId &&
        m.date >= state.date,
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0];
  if (!home) return null;
  const revenue = matchdayRevenue(state, home);
  return {
    code: "gate",
    fact:
      `다음 홈경기 ${home.date} ${fixtureHead(state, home)} — 예상 관중 ` +
      `${revenue.attendance.toLocaleString("en-US")} / ${revenue.capacity.toLocaleString("en-US")} ` +
      `(점유율 ${Math.round(revenue.occupancy * 100)}%)`,
    playerIds: [],
  };
};

export function coachCues(state: GameState, limit = Number.POSITIVE_INFINITY): CoachCue[] {
  if (managedTeamId(state) === null) return [];
  /**
   * 훈련 결산은 **원형 앞에** 선다 — 눈이 없는 원형(표에서 되찾지
   * 못한 라벨)에게도 이 장은 간다. 자리도 따로 갖는다: `limit`은 원형이 고르는
   * 장수다.
   */
  const settlement = trainingReportCue(state);
  const first = [settlement].filter((cue): cue is CoachCue => cue !== null);
  const eyes: readonly CoachEye[] = [
    tiredStarters,
    injuryLog,
    injuryRisk,
    opponentTable,
    opponentForm,
    matchupAxis,
    prospects,
    reserveRecord,
    captain,
    headToHeadCue,
    h2hTally,
    derby,
    gate,
    expectation,
  ];
  const next = nextMatchFor(state.matches, state.userTeamId, state.date);
  const sight: CoachSight = {
    next,
    opponentId: next
      ? next.homeTeamId === state.userTeamId
        ? next.awayTeamId
        : next.homeTeamId
      : null,
    daysToNext: next ? diffDays(state.date, next.date) : null,
  };

  const cues = eyes.map((eye) => eye(state, sight)).filter((cue): cue is CoachCue => cue !== null);
  if (cues.length === 0) return first;

  return [...first, ...cues].slice(0, limit);
}
