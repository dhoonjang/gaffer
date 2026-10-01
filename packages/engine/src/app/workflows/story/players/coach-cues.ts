import { isReserveMatch } from "@story-fm/domain";
import { nextMatchFor } from "../../../../common/core/calendar";
import { diffDays } from "../../../../common/core/dates";
import { type GameState, managedTeamId, teamShortNameIn } from "../../../../common/core/state";
import { matchdayRevenue } from "../../../../negotiation/finance/finance";
import { loanReports } from "../../../../negotiation/market/departures";
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
  LOAN_REPORT_FRESH_DAYS,
  matchupAxis,
  NAMES_SHOWN,
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

/**
 * 이달 **임대 리포트** — 훈련 결산과 같이 원형이 고르지 않는 한 장
 * (season.md §2 임대 · people.md §7-1).
 *
 * 임대 보낸 유망주의 소식을 여섯 눈 중 하나로 넣으면 유스형 코치를 쓰는 감독에게만
 * 닿는다. 리콜은 이적 창이 열려 있는 동안에만 가능한 결정이라, 그 한 원형을 안
 * 쓴 감독은 근거 없이 복귀일을 맞는다.
 *
 * ⚠️ **싣는 것은 이름과 한 토막씩이다.** 낱낱의 수치는 조회가 갖는다 — 스냅샷은
 * 매 턴 정가로 읽히는 층이라 임대 인원만큼 줄을 부으면 안 된다 (agents.md §6).
 */
function loanReportCue(state: GameState): CoachCue | null {
  // 세이브에 새로 적는 것은 없다 — 이달 1일과 장부에서 파생한다
  const monthStart = `${state.date.slice(0, 7)}-01`;
  if (diffDays(monthStart, state.date) > LOAN_REPORT_FRESH_DAYS) return null;
  const reports = loanReports(state);
  if (reports.length === 0) return null;
  /**
   * **근거가 붙은 건이 앞에 선다** — 자리는 세 토막인데 리포트가 그보다 많으면
   * 뛰지 못하는 선수가 이름 순서에 밀려 잘린다. 정렬은 안정적이라 나머지는
   * `loanReports`의 id 순서 그대로다(결정적).
   */
  const ordered = [...reports].sort(
    (a, b) => Number(b.concerns.length > 0) - Number(a.concerns.length > 0),
  );
  const shown = ordered.slice(0, NAMES_SHOWN).map((r) => {
    const bits = [
      r.apps > 0
        ? `${r.apps}경기 ${r.goals}골${r.rating !== null ? ` 평점 ${r.rating.toFixed(1)}` : ""}`
        : "1군 출전 없음",
      // 근거 코드는 코드가 아니라 그것이 **뜻하는 사실**로 적는다 (`LoanConcern`)
      r.concerns.includes("no-minutes") ? `최근 ${r.benchRun}경기 명단 밖` : null,
      r.injury ? `부상 ${r.injury.bodyPart}` : null,
    ].filter((x): x is string => x !== null);
    return `${r.name}(${teamShortNameIn(state, r.teamId)}) ${bits.join(" · ")}`;
  });
  return {
    code: "loan-report",
    by: "coach",
    fact:
      `${state.date.slice(0, 7)} 임대 ${reports.length}건 — ` +
      `${shown.join(" / ")}${reports.length > shown.length ? " …" : ""}`,
    playerIds: reports.map((r) => r.playerId),
  };
}

export function coachCues(state: GameState, limit = Number.POSITIVE_INFINITY): CoachCue[] {
  if (managedTeamId(state) === null) return [];
  /**
   * 훈련 결산과 임대 리포트는 **원형 앞에** 선다 — 눈이 없는 원형(표에서 되찾지
   * 못한 라벨)에게도 이 두 장은 간다. 자리도 따로 갖는다: `limit`은 원형이 고르는
   * 장수다.
   */
  const settlement = trainingReportCue(state);
  const loan = loanReportCue(state);
  const first = [settlement, loan].filter((cue): cue is CoachCue => cue !== null);
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
