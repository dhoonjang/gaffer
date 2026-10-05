import { type Outcome, type MatchRecord } from "@gaffer/domain";
import { type GameState, teamNameIn, teamShortNameIn } from "../core/state";
import {
  leagueOfTeamIn,
  teamsOfLeagueIn,
  entrantsOf,
  predictionOf,
} from "../core/league-membership";
import { isMarketOnlyLeague } from "../core/catalog/league-catalog";
import { isCup } from "../core/catalog/cup-catalog";

/** 시즌 리뷰·전환 — 멀티시즌 코어 (season.md §6) */

export interface StandingRow {
  teamId: string;
  /** 우리 팀인가 — 이름을 견주면 같은 이름의 다른 팀에서 갈린다 (화면이 행을 짚는 근거) */
  ours: boolean;
  name: string;
  shortName: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
  /**
   * 홈/원정 소계 — 합계와 **같은 칸 구성**이고 ⚠️ **홈 + 원정 = 합계**다
   * (competition.md §2 · §7 불변식). 저장하지 않는다: 같은 루프의 파생이다.
   */
  home: StandingSplit;
  away: StandingSplit;
  /**
   * 최근 5경기 — **오래된 것부터.** 이 표가 센 경기와 같은 집합이라(그 시즌 그 대회의
   * 리그전) 녹아웃은 들어오지 않는다. 승점만 보면 무너지는 팀과 오르는 팀이 같다.
   */
  form: Outcome[];
  /**
   * 개막 전 언론이 매긴 예상 순위 (→ [prediction.ts](./prediction.ts) · season.md §2).
   *
   * 예상이 서지 않은 대회(컵 · 대항전)에는 없다 — **없는 것은 예상
   * 밖이라는 뜻이 아니라 예상이 없다는 뜻이다.** 순서에는 들어오지 않는다: 표를 세우는
   * 것은 승점이고, 이 칸은 그 옆에 서는 열이다.
   */
  predicted?: number;
}

/** 순위표의 한 칸 묶음 — 합계·홈·원정이 같은 모양이라 화면이 열을 하나로 그린다 */
interface StandingSplit {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

function emptySplit(): StandingSplit {
  return { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 };
}

/** 순위표에 붙는 폼의 길이 — 다섯이면 흐름이 보이고 열이 표를 밀어내지 않는다 */
export const FORM_MATCHES = 5;

/** 한 팀이 이 표 안에서 치른 경기 한 줄 — 폼은 **날짜순**이라 따로 모아 세운다 */
interface FormEntry {
  date: string;
  time: string;
  outcome: Outcome;
}

/**
 * 이 경기가 **순위표가 세는 경기**인가 — 그 시즌 그 대회의 리그전뿐이다.
 *
 * 녹아웃은 표에 들어가지 않으므로 폼에도 팀 열에도 들어가지 않는다
 * (competition.md §2). 표와 팀 열이 다른 집합을 세면 순위표의 실점과 팀 열의 실점이
 * 조용히 갈리므로, 세는 자리가 여럿이어도 **거르는 규칙은 여기 하나다.**
 */
export function countsInStandings(
  match: MatchRecord,
  season: number,
  competitionId: string,
): boolean {
  return (
    match.result !== null &&
    match.season === season &&
    match.competitionId === competitionId &&
    match.stage === "league"
  );
}

/**
 * 순위표 — **대회별로** 계산한다. 생략하면 유저 팀의 리그.
 *
 * 여러 리그가 동시에 진행되므로 팀·경기를 모두 그 대회로 좁혀야 한다. 대항전
 * 리그 페이즈도 단일 순위표라 같은 함수로 계산된다 — 참가 팀만 배정에서 가져온다.
 *
 * `counts`는 **그 위에 덧대는 체**다 (기본값은 전부 통과). 지난 어느 시점의 표를
 * 세우는 자리(리포트의 순위 변화 — match.md §8)가 쓴다 — 거르는 규칙 자체는 여전히
 * `countsInStandings` 하나이고, 이쪽은 "어디까지 치렀나"만 좁힌다.
 */
export function computeStandings(
  state: GameState,
  competitionId = leagueOfTeamIn(state, state.userTeamId),
  counts: (match: MatchRecord) => boolean = () => true,
): StandingRow[] {
  // 명단 전용 리그는 경기를 안 하므로 순위가 없다 — 국내 컵과 같은 취급
  if (isMarketOnlyLeague(competitionId)) return [];
  const members = isCup(competitionId)
    ? entrantsOf(state.euroEntrants, competitionId)
    : teamsOfLeagueIn(state, competitionId);
  const rows = new Map<string, StandingRow>();
  for (const teamId of members) {
    rows.set(teamId, {
      teamId,
      ours: teamId === state.userTeamId,
      name: teamNameIn(state, teamId),
      shortName: teamShortNameIn(state, teamId),
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDiff: 0,
      points: 0,
      home: emptySplit(),
      away: emptySplit(),
      form: [],
    });
  }
  const counted: CountedMatch[] = [];
  const recent = new Map<string, FormEntry[]>();
  const noteForm = (teamId: string, entry: FormEntry): void => {
    const list = recent.get(teamId) ?? [];
    list.push(entry);
    recent.set(teamId, list);
  };
  for (const match of state.matches) {
    if (!countsInStandings(match, state.season, competitionId) || !counts(match)) continue;
    const homeRow = rows.get(match.homeTeamId);
    const awayRow = rows.get(match.awayTeamId);
    const result = match.result;
    if (!homeRow || !awayRow || !result) continue;
    const { homeGoals, awayGoals } = result;
    // 맞대결 표는 이 표에 실제로 반영된 경기만 본다 (아래 sortStandings)
    counted.push({
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      homeGoals,
      awayGoals,
    });
    // 합계와 소계는 **한 자리에서** 얹는다 — 두 자리로 나누면 홈+원정=합계가 깨진다
    const sides = [
      { row: homeRow, split: homeRow.home, scored: homeGoals, conceded: awayGoals },
      { row: awayRow, split: awayRow.away, scored: awayGoals, conceded: homeGoals },
    ];
    for (const { row, split, scored, conceded } of sides) {
      const outcome: Outcome = scored > conceded ? "W" : scored < conceded ? "L" : "D";
      const points = outcome === "W" ? WIN_POINTS : outcome === "D" ? DRAW_POINTS : 0;
      for (const box of [row, split]) {
        box.played++;
        box.goalsFor += scored;
        box.goalsAgainst += conceded;
        box.points += points;
        if (outcome === "W") box.wins++;
        else if (outcome === "L") box.losses++;
        else box.draws++;
      }
      noteForm(row.teamId, { date: match.date, time: match.time, outcome });
    }
  }
  const list = [...rows.values()];
  /**
   * 예상 순위 — 그 대회의 예상 줄이 있을 때만 (season.md §2). 컵·대항전은 줄이 없어
   * 한 행도 채워지지 않는다.
   */
  const predictionRow = predictionOf(state, competitionId);
  for (const row of list) {
    const predicted = predictionRow ? predictionRow.order.indexOf(row.teamId) : -1;
    if (predicted >= 0) row.predicted = predicted + 1;
    row.goalDiff = row.goalsFor - row.goalsAgainst;
    // 경기 배열은 날짜순이 아니다(연기·추첨으로 뒤에 붙는다) — 폼은 달력이 정한다
    row.form = (recent.get(row.teamId) ?? [])
      .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date < b.date ? -1 : 1))
      .slice(-FORM_MATCHES)
      .map((e) => e.outcome);
  }
  return sortStandings(list, counted);
}

/** 승점 — 승 3 · 무 1 (competition.md §2) */
const WIN_POINTS = 3;

const DRAW_POINTS = 1;

/** 어느 표를 보는가 — 합계·홈·원정 (competition.md §2 「순위표 한 행이 아는 것」) */
export type StandingSplitKey = "all" | "home" | "away";

/**
 * 홈 표·원정 표 — **같은 행을 그 소계로 다시 세운다.** 행은 그대로이고 순서만 다르다.
 *
 * ⚠️ **맞대결 칸이 없다.** 한 팀에게 홈인 경기는 상대에게 원정이라 "그들끼리의 홈
 * 표"라는 것이 없다 — 합계표의 맞대결 규칙을 여기 끌어오면 홈 경기 한 짝만으로
 * 순위가 갈린다.
 */
export function standingsBySplit(
  rows: readonly StandingRow[],
  split: StandingSplitKey,
): StandingRow[] {
  if (split === "all") return [...rows];
  const diff = (s: StandingSplit): number => s.goalsFor - s.goalsAgainst;
  return [...rows].sort((a, b) => {
    const x = a[split];
    const y = b[split];
    return (
      y.points - x.points ||
      diff(y) - diff(x) ||
      y.goalsFor - x.goalsFor ||
      y.wins - x.wins ||
      byTeamId(a, b)
    );
  });
}

/** 순위표에 실제로 반영된 리그 경기 — 맞대결 표가 다시 도는 대상 */
interface CountedMatch {
  homeTeamId: string;
  awayTeamId: string;
  homeGoals: number;
  awayGoals: number;
}

/** 승점 → 골득실 → 다득점. 여기까지 같은 팀들이 "완전 동률" 무리다. */
function byMainKeys(a: StandingRow, b: StandingRow): number {
  return b.points - a.points || b.goalDiff - a.goalDiff || b.goalsFor - a.goalsFor;
}

/** 마지막 못 — 팀이 세이브에 담긴 순서가 아니라 팀 자체에서 나오는 키 */
function byTeamId(a: StandingRow, b: StandingRow): number {
  return a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0;
}

interface MiniRow {
  points: number;
  goalDiff: number;
  goalsFor: number;
}

/** 무리 안 팀들끼리 치른 경기만으로 다시 만든 표 */
function headToHead(
  group: readonly StandingRow[],
  matches: readonly CountedMatch[],
): Map<string, MiniRow> {
  const mini = new Map<string, MiniRow>();
  for (const row of group) mini.set(row.teamId, { points: 0, goalDiff: 0, goalsFor: 0 });
  for (const m of matches) {
    const home = mini.get(m.homeTeamId);
    const away = mini.get(m.awayTeamId);
    if (!home || !away) continue;
    home.goalsFor += m.homeGoals;
    away.goalsFor += m.awayGoals;
    home.goalDiff += m.homeGoals - m.awayGoals;
    away.goalDiff += m.awayGoals - m.homeGoals;
    if (m.homeGoals > m.awayGoals) home.points += 3;
    else if (m.homeGoals < m.awayGoals) away.points += 3;
    else {
      home.points++;
      away.points++;
    }
  }
  return mini;
}

/**
 * 순위 정렬 — 승점 → 골득실 → 다득점 → **맞대결** → 다승 → `teamId` 사전순
 * (competition.md §2).
 *
 * ⚠️ **맞대결은 앞 세 키가 같은 무리 안에서 표를 다시 만들어 가른다.** 비교 함수
 * 안에서 두 팀을 짝지어 붙이면 세 팀이 물고 물릴 때 추이성이 깨지고, `Array.sort`
 * 결과가 다시 입력 순서를 탄다 — 이 함수가 없애려는 그 의존이다.
 */
function sortStandings(list: StandingRow[], matches: readonly CountedMatch[]): StandingRow[] {
  const sorted = list.sort((a, b) => byMainKeys(a, b) || b.wins - a.wins || byTeamId(a, b));
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && byMainKeys(sorted[i]!, sorted[j]!) === 0) j++;
    if (j - i > 1) {
      const group = sorted.slice(i, j);
      const mini = headToHead(group, matches);
      group.sort((a, b) => {
        const x = mini.get(a.teamId)!;
        const y = mini.get(b.teamId)!;
        return (
          y.points - x.points ||
          y.goalDiff - x.goalDiff ||
          y.goalsFor - x.goalsFor ||
          b.wins - a.wins ||
          byTeamId(a, b)
        );
      });
      sorted.splice(i, group.length, ...group);
    }
    i = j;
  }
  return sorted;
}
