import { type GameState, managedTeamId } from "../core/state";
import {
  type SeasonHistory,
  type SeasonTableRow,
  type Trophy,
  type SeasonAward,
  isReserveMatch,
  type SeasonLeagueTable,
  type SeasonMatchRow,
} from "@story-fm/domain";
import { competitionShortName, cupCatalog } from "../core/catalog/cup-catalog";
import { seasonYear } from "../core/dates";
import { domesticCupCatalog } from "../core/catalog/domestic-cup-catalog";
import { domesticChampion, domesticRunnerUp } from "./domestic-cup";
import { euroChampion, euroStageMatches } from "./euro-knockout";
import { computeStandings } from "./standings";
import { leaguesPlayedIn } from "./awards";

/**
 * 구단의 역사 — **전부 파생이다** (career.md §6 · game-state.md §5).
 *
 * 원본은 셋이고 저장되는 것은 그 셋뿐이다: 시즌 결산 스냅샷(`state.history`),
 * 우승 원장(`state.trophies` — 전 구단), 게임 시작 전의 우승(카탈로그 `honours`).
 * 최다 승점도 "역대 13회"도 여기서 접는다 — 합계를 따로 저장하면 원장과 갈린다.
 *
 * ⚠️ **선수 통산은 여기 없다.** `careerTotalsOf`(`squad/career.ts`)가 `SEASON_STAT`을
 * 접는 유일한 자리이고, 이 파일은 그것을 다시 세지 않는다.
 */

// ── 시즌 표를 집는 자 ─────────────────────────────────

/** 지나간 시즌들 — 최근이 앞이다 */
export function pastSeasonsOf(state: GameState): SeasonHistory[] {
  return [...state.history].sort((a, b) => b.season - a.season);
}

export function seasonHistoryOf(state: GameState, season: number): SeasonHistory | null {
  return state.history.find((h) => h.season === season) ?? null;
}

/** 그 시즌 그 리그의 최종 순위표 — 없으면 null (그해 리그전을 돌지 않았다) */
export function leagueTableOf(
  state: GameState,
  season: number,
  leagueId: string,
): SeasonTableRow[] | null {
  return seasonHistoryOf(state, season)?.leagues.find((l) => l.leagueId === leagueId)?.rows ?? null;
}

/**
 * 그 시즌 그 대회의 우승 팀 — **리그는 순위표의 1위, 녹아웃은 트로피**다
 * (game-state.md §3.3). 우승자를 따로 적지 않는 이유는 표가 이미 답하기 때문이다.
 */
export function championOf(state: GameState, season: number, competitionId: string): string | null {
  const table = leagueTableOf(state, season, competitionId);
  if (table) return table[0]?.teamId ?? null;
  return (
    state.trophies.find((t) => t.season === season && t.competitionId === competitionId)?.teamId ??
    null
  );
}

// ── 감독의 보관함 ─────────────────────────────────────

/**
 * 감독이 **그 시즌 그 팀에 있었는가** — 트로피 보관함과 시상 줄이 같은 자를 쓴다
 * (career.md §6).
 *
 * 재임 여부는 `SEASON_RECORD`의 (시즌, 팀)이 답한다 — 커리어가 끝난 뒤 맞은 시즌 끝은
 * 그 표에 줄이 없으므로 옛 팀이 그해 든 컵도 감독의 것이 아니다 (career.md §5.1).
 * 이번 시즌은 아직 결산 전이라 그 표에 없어 지금 맡은 팀으로 함께 본다.
 */
export function managerTenureOf(state: GameState): (season: number, teamId: string) => boolean {
  const tenure = new Set(state.seasonRecords.map((r) => `${r.season}:${r.teamId}`));
  const now = managedTeamId(state);
  if (now !== null) tenure.add(`${state.season}:${now}`);
  return (season, teamId) => tenure.has(`${season}:${teamId}`);
}

/**
 * 트로피 원장에서 **감독의 것만** — 원장은 전 구단의 우승을 든다 (career.md §6).
 * 그대로 실으면 AI 구단의 우승이 감독의 보관함에 선다.
 */
export function managerTrophiesOf(state: GameState): Trophy[] {
  const managed = managerTenureOf(state);
  return state.trophies.filter((t) => managed(t.season, t.teamId));
}

// ── 구단 기록 ─────────────────────────────────────────

/** 한 대회의 역대 우승 — 카탈로그 시드와 게임 안의 우승을 더한 것 */
interface ClubTitleCount {
  competitionId: string;
  /** 시드 + 게임 안 = 역대 */
  count: number;
  /** 게임이 시작되기 전의 몫 (카탈로그 `honours`) */
  seeded: number;
  /** 게임 안에서 든 시즌 — 최근이 앞 */
  seasons: number[];
  /** 카탈로그가 든 마지막 연도 — 게임 안의 우승이 있으면 그쪽이 최신이다 */
  lastYear?: number;
}

/** 한 시즌이 세운 최고치 — 어느 시즌 어느 리그에서였나 */
interface ClubSeasonBest {
  season: number;
  leagueId: string;
  value: number;
}

interface ClubRecords {
  teamId: string;
  /** 역대 우승 — 횟수가 많은 대회부터, 같으면 대회 id 사전순 */
  titles: ClubTitleCount[];
  /** 한 시즌 최다 승점 · 최다 득점 · 최고 리그 순위 (`value`는 순위 그대로다) */
  bestPoints: ClubSeasonBest | null;
  mostGoals: ClubSeasonBest | null;
  bestPosition: ClubSeasonBest | null;
  /** 그 구단 소속으로 받은 시상 — 리그·컵·대항전, 최근 시즌이 앞 */
  awards: SeasonAward[];
  /** 장부가 아는 시즌 수 — 0이면 아직 지나간 시즌이 없다 */
  seasons: number;
}

/** 그 구단의 역대 기록 — 원장을 한 번씩만 훑는다 */
export function clubRecordsOf(state: GameState, teamId: string): ClubRecords {
  let bestPoints: ClubSeasonBest | null = null;
  let mostGoals: ClubSeasonBest | null = null;
  let bestPosition: ClubSeasonBest | null = null;
  let seasons = 0;

  for (const season of state.history) {
    let counted = false;
    for (const league of season.leagues) {
      const index = league.rows.findIndex((r) => r.teamId === teamId);
      if (index < 0) continue;
      counted = true;
      const at = { season: season.season, leagueId: league.leagueId };
      const position = index + 1;
      if (bestPosition === null || position < bestPosition.value) {
        bestPosition = { ...at, value: position };
      }
      const record = league.rows[index]!.record;
      if (bestPoints === null || record.points > bestPoints.value) {
        bestPoints = { ...at, value: record.points };
      }
      if (mostGoals === null || record.goalsFor > mostGoals.value) {
        mostGoals = { ...at, value: record.goalsFor };
      }
    }
    if (counted) seasons += 1;
  }

  const titles = new Map<string, ClubTitleCount>();
  for (const honour of state.teams.find((team) => team.id === teamId)?.honours ?? []) {
    titles.set(honour.competitionId, {
      competitionId: honour.competitionId,
      count: honour.count,
      seeded: honour.count,
      seasons: [],
      ...(honour.lastYear === undefined ? {} : { lastYear: honour.lastYear }),
    });
  }
  for (const trophy of state.trophies) {
    if (trophy.teamId !== teamId) continue;
    const id = trophy.competitionId;
    const row = titles.get(id) ?? { competitionId: id, count: 0, seeded: 0, seasons: [] };
    row.count += 1;
    row.seasons.push(trophy.season);
    titles.set(id, row);
  }
  for (const row of titles.values()) row.seasons.sort((a, b) => b - a);

  return {
    teamId,
    titles: [...titles.values()].sort(
      (a, b) => b.count - a.count || a.competitionId.localeCompare(b.competitionId),
    ),
    bestPoints,
    mostGoals,
    bestPosition,
    awards: state.awards
      .filter((a) => a.teamId === teamId)
      .sort((a, b) => b.season - a.season || a.code.localeCompare(b.code)),
    seasons,
  };
}

/**
 * 역대 한 줄 — 우승이 있는 구단만 (team.md §1).
 *
 * 조회(`get_team`)·화면·GM 레퍼런스가 같은 문장을 읽는다. 시드가 없고 게임 안의
 * 우승도 없으면 **줄이 서지 않는다** — 없는 것은 0회가 아니라 모르는 것이다.
 */
export function clubHonoursLine(state: GameState, teamId: string): string | null {
  const records = clubRecordsOf(state, teamId);
  if (records.titles.length === 0) return null;
  return records.titles
    .map((t) => {
      const last = t.seasons[0];
      const when =
        last !== undefined
          ? `, 마지막 시즌 ${last}`
          : t.lastYear !== undefined
            ? `, 마지막 ${t.lastYear}`
            : "";
      return `${competitionShortName(t.competitionId)} ${t.count}회${when}`;
    })
    .join(" · ");
}

// ── 기록 경신 ─────────────────────────────────────────

/**
 * 구단 기록 경신의 갈래 — **코드와 수치만 남긴다** (overview.md §1 철칙 4).
 * "구단 역사상 최다 승점"이라는 문장은 이것을 읽는 쪽(GM·화면)이 쓴다.
 */
export const CLUB_RECORD_CODES = [
  "club-record:points",
  "club-record:goals",
  "club-record:position",
] as const;

export type ClubRecordCode = (typeof CLUB_RECORD_CODES)[number];

export interface RecordBreak {
  code: ClubRecordCode;
  /** 기록을 세운 시즌 */
  season: number;
  leagueId: string;
  /** 이번 시즌의 값 — `club-record:position`은 순위 그대로다 */
  value: number;
  /** 넘어선 옛 기록과 그 시즌 */
  previous: number;
  previousSeason: number;
}

/** 이번 시즌 그 구단의 리그 성적 — `computeStandings`가 낸 행에서 온다 */
interface SeasonMark {
  season: number;
  leagueId: string;
  points: number;
  goalsFor: number;
  position: number;
}

/**
 * 이번 시즌이 구단 기록을 넘었나 — **지나간 시즌들과 견줘** 사실 카드를 낸다
 * (season.md §6 기록 경신).
 *
 * `state`를 읽되 이번 시즌의 성적은 **인자로 받는다**: 시즌 리뷰는 결산 스냅샷이
 * 남기 전에 돌고(스냅샷은 전환이 남긴다), 순위표를 세우는 자는 `season.ts`다.
 *
 * **견줄 표가 없으면 카드도 없다** — 첫 시즌은 무엇을 해도 경신이 아니다.
 * 승점·득점을 모르는 이관 행은 그 축의 비교에서 빠지고(순위만 견준다), 카탈로그의
 * `honours`는 우승 횟수일 뿐 시즌 성적이 아니라 여기 들어오지 않는다.
 */
export function recordBreaksOf(state: GameState, teamId: string, mark: SeasonMark): RecordBreak[] {
  const past = clubRecordsOf(state, teamId);
  const breaks: RecordBreak[] = [];
  const at = { season: mark.season, leagueId: mark.leagueId };
  if (past.bestPoints && mark.points > past.bestPoints.value) {
    breaks.push({
      code: "club-record:points",
      ...at,
      value: mark.points,
      previous: past.bestPoints.value,
      previousSeason: past.bestPoints.season,
    });
  }
  if (past.mostGoals && mark.goalsFor > past.mostGoals.value) {
    breaks.push({
      code: "club-record:goals",
      ...at,
      value: mark.goalsFor,
      previous: past.mostGoals.value,
      previousSeason: past.mostGoals.season,
    });
  }
  if (past.bestPosition && mark.position < past.bestPosition.value) {
    breaks.push({
      code: "club-record:position",
      ...at,
      value: mark.position,
      previous: past.bestPosition.value,
      previousSeason: past.bestPosition.season,
    });
  }
  return breaks;
}

/** 시즌 번호 → `2026-27` — 역대 표가 연도로 읽히게 하는 한 자리 */
export function seasonLabelOf(season: number): string {
  const year = seasonYear(season);
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

/**
 * 넘어가는 시즌이 장부에 남기는 **결산 스냅샷** — 리그별 최종 순위표 전체와 감독
 * 팀의 경기다 (season.md §6 · game-state.md §3.3).
 *
 * ⚠️ **승강을 적용하기 전에, 새 일정을 짜기 전에** 불러야 한다. `computeStandings`는
 * 지금 소속(`leagueOfTeamIn`)과 `state.season`의 경기로 표를 세우므로, 승강 뒤에
 * 부르면 방금 올라온 팀이 0경기로 표에 서고 강등된 팀은 사라진다. 경기 쪽은 더
 * 급하다 — `state.matches`가 새 시즌 일정으로 통째로 교체되면 되돌릴 길이 없다.
 *
 * **시즌을 잘라내지 않는다** — 역사는 다 쌓인다. 최근 세 시즌만 보는 것은 구단 체급의
 * 성적 축이고, 자르는 자리는 읽는 쪽이다(`recentForm`, `RECENT_SEASONS`).
 */
export function recordSeasonHistory(state: GameState): void {
  /**
   * 아래 경기 줄이 누구의 것인가. `managedTeamId`가 아니라 `state.userTeamId`인 이유는
   * **경질이 소속을 지우지 않기** 때문이다 — 잘린 감독의 옛 구단은 시즌 끝까지 그
   * 팀이고, 그 경기를 감독 자리가 비었다는 이유로 버리면 그 시즌만 경기가 비어 남는다.
   */
  const teamId = state.userTeamId;
  const leagues: SeasonLeagueTable[] = leaguesPlayedIn(state).map((leagueId) => ({
    leagueId,
    rows: computeStandings(state, leagueId).map((r): SeasonTableRow => ({
      teamId: r.teamId,
      // 골득실과 이름은 파생이라 적지 않는다 (game-state.md §3.3)
      record: {
        played: r.played,
        wins: r.wins,
        draws: r.draws,
        losses: r.losses,
        goalsFor: r.goalsFor,
        goalsAgainst: r.goalsAgainst,
        points: r.points,
      },
    })),
  }));

  const matches: SeasonMatchRow[] = [];
  for (const match of state.matches) {
    if (match.season !== state.season || !match.result) continue;
    // 친선(대회 없음)도 2군 리그도 시즌의 것이 아니다 (season.md §2)
    if (match.competitionId === null || isReserveMatch(match)) continue;
    const home = match.homeTeamId === teamId;
    if (!home && match.awayTeamId !== teamId) continue;
    const { homeGoals, awayGoals, penalties } = match.result;
    const stage = match.stage === "league" ? undefined : match.stage;
    matches.push({
      date: match.date,
      competitionId: match.competitionId,
      ...(stage === undefined ? {} : { stage }),
      opponentTeamId: home ? match.awayTeamId : match.homeTeamId,
      // 중립이 홈/원정보다 앞선다 — 결승은 편성상 한쪽이 홈이지만 구장은 누구의 것도 아니다
      venue: match.neutral === true ? "neutral" : home ? "home" : "away",
      goalsFor: home ? homeGoals : awayGoals,
      goalsAgainst: home ? awayGoals : homeGoals,
      ...(penalties === undefined
        ? {}
        : {
            penalties: {
              for: home ? penalties.home : penalties.away,
              against: home ? penalties.away : penalties.home,
            },
          }),
    });
  }
  // 같은 날 두 경기는 없지만, 정렬이 세이브의 배열 순서를 타면 안 된다
  matches.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // 같은 시즌을 두 번 결산해도 행은 하나다 — 그 시즌의 행을 지우고 다시 쓴다
  const kept = state.history.filter((row) => row.season !== state.season);
  kept.push({ season: state.season, leagues, teamId, matches });
  kept.sort((a, b) => a.season - b.season);
  state.history = kept;
}

/**
 * 그 시즌 우승을 **전 구단의 것으로** 원장에 적는다 (season.md §6 · career.md §6).
 *
 * 유저 팀만 적던 시절엔 AI 구단의 우승이 어디에도 남지 않아, 세계에 기억이 없고
 * 스폰서 성과 조항이 감독 구단에만 붙었다(finance.md §5.3). 그래서 이것은 감독의
 * 일이 아니라 **리그가 주는 것**이다 — 시상·상금과 같이 감독 자리가 비어도 돈다.
 *
 * 준우승은 **결승에서 진 팀**이라 녹아웃에만 선다 — 리그의 2위는 순위표가 이미 답한다.
 */
export function recordChampions(state: GameState): void {
  for (const leagueId of leaguesPlayedIn(state)) {
    const champion = computeStandings(state, leagueId)[0];
    if (champion) putTrophy(state, leagueId, champion.teamId, null);
  }
  for (const cup of domesticCupCatalog()) {
    const champion = domesticChampion(state, cup.id);
    if (champion) putTrophy(state, cup.id, champion, domesticRunnerUp(state, cup.id));
  }
  for (const cup of cupCatalog()) {
    const champion = euroChampion(state, cup.id);
    if (!champion) continue;
    const decider = euroStageMatches(state, cup.id, "final")[0];
    const runnerUp =
      decider === undefined
        ? null
        : decider.homeTeamId === champion
          ? decider.awayTeamId
          : decider.homeTeamId;
    putTrophy(state, cup.id, champion, runnerUp);
  }
}

/**
 * 한 대회 한 시즌의 우승은 원장에 **한 줄**이다 — 같은 시즌을 두 번 결산해도 덧나지
 * 않게 그 줄을 갈아 끼운다. 슈퍼컵은 tick이 먼저 적으므로(super-cup.ts) 여기 없다.
 */
function putTrophy(
  state: GameState,
  competitionId: string,
  teamId: string,
  runnerUpTeamId: string | null,
): void {
  const row: Trophy = {
    season: state.season,
    competitionId,
    teamId,
    ...(runnerUpTeamId === null ? {} : { runnerUpTeamId }),
  };
  const at = state.trophies.findIndex(
    (t) => t.season === state.season && t.competitionId === competitionId,
  );
  if (at < 0) state.trophies.push(row);
  else state.trophies[at] = row;
}

/**
 * 대회별 우승 팀 — 우승자가 없는 대회는 목록에서 빠진다.
 * 슈퍼컵 대진의 원본이라 "없다"가 곧 "그 슈퍼컵은 그해 서지 않는다"가 된다.
 */
export function championsOf(
  cups: readonly { id: string }[],
  championOf: (cupId: string) => string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cup of cups) {
    const champion = championOf(cup.id);
    if (champion) out[cup.id] = champion;
  }
  return out;
}
