import { type GameState, playerById, teamName } from "../core/state";
import { leagueOfTeamIn, teamsOfLeagueIn, leagueRounds } from "../core/league-membership";
import { isCup, competitionShortName } from "../core/catalog/cup-catalog";
import {
  isReserveMatch,
  type SeasonAward,
  type SeasonAwardCode,
  YOUNG_PLAYER_MAX_AGE,
  type MatchRecord,
  parseScorerEntry,
  pickMotm,
  awardTitle,
  awardDetail,
} from "@gaffer/domain";
import { seasonEndDate } from "../core/calendar";
import {
  type LeagueTally,
  talliesOf,
  pickWinner,
  MIN_LEADER_TALLY,
  TOP_SCORER_ORDER,
  TOP_ASSISTER_ORDER,
  RATING_APPS_DIVISOR,
  RATING_ORDER,
} from "./leaderboard";
import { type ClubRecordCode, type RecordBreak } from "./records";

/**
 * 그해 **리그전을 돈 리그** — 순위표 보관(`recordSeasonHistory`)과 시상이 같은
 * 창에서 같은 집합을 본다 (season.md §6). 친선(대회 없음)도 컵도 2군 리그도
 * 리그전이 아니다.
 */
export function leaguesPlayedIn(state: GameState): string[] {
  const leagueIds = new Set<string>();
  for (const match of state.matches) {
    if (match.season !== state.season || !match.result) continue;
    if (match.stage !== "league") continue;
    const id = match.competitionId;
    if (id === null || isCup(id) || isReserveMatch(match)) continue;
    leagueIds.add(id);
  }
  return [...leagueIds].sort();
}

/**
 * 영플레이어의 출전 문턱을 만드는 나눗수 — 올해의 선수의 절반이다(유망주는 원래 덜
 * 뛴다). 올해의 선수 쪽은 시즌 중 리더보드와 같은 자를 쓴다(`RATING_APPS_DIVISOR`).
 */
const YOUNG_PLAYER_APPS_DIVISOR = 4;

/**
 * 시즌 시상 — **결정적 순수 함수다.** `state`를 읽기만 하고, 같은 기록이면 같은
 * 수상자가 나온다 (season.md §6, §8 불변식). 저장은 `gradeAwards`가 한다.
 *
 * ⚠️ **승강을 적용하기 전에** 불러야 한다 — `leagueOfTeamIn`이 옛 소속을 주는
 * 동안이라야 방금 승격한 팀의 선수가 옛 리그의 상을 받지 않는다.
 */
export function seasonAwards(state: GameState): SeasonAward[] {
  // 시즌 종료일 = 그 시즌 마지막 경기일. `state.date`로 대신하면 결산을 며칠 늦게
  // 돌린 세이브에서 영플레이어의 나이가 달라진다
  const endDate = seasonEndDate(state.matches.filter((m) => m.season === state.season));
  if (endDate === null) return [];

  const awards: SeasonAward[] = [];
  const add = (competitionId: string, code: SeasonAwardCode, winner: LeagueTally | null): void => {
    if (!winner) return;
    awards.push({
      code,
      season: state.season,
      competitionId,
      gamePlayerId: winner.gamePlayerId,
      playerName: winner.playerName,
      teamId: winner.teamId,
      apps: winner.apps,
      goals: winner.goals,
      assists: winner.assists,
      ...(winner.rating !== null ? { rating: winner.rating } : {}),
      ...(code === "young-player" ? { age: winner.age } : {}),
    });
  };

  for (const leagueId of leaguesPlayedIn(state)) {
    const tallies = talliesOf(state, leagueId, endDate);
    const rounds = leagueRounds(teamsOfLeagueIn(state, leagueId).length);
    const rated = tallies.filter((t) => t.rating !== null);

    add(
      leagueId,
      "top-scorer",
      pickWinner(
        tallies.filter((t) => t.goals >= MIN_LEADER_TALLY),
        TOP_SCORER_ORDER,
      ),
    );
    add(
      leagueId,
      "top-assister",
      pickWinner(
        tallies.filter((t) => t.assists >= MIN_LEADER_TALLY),
        TOP_ASSISTER_ORDER,
      ),
    );
    add(
      leagueId,
      "player-of-season",
      pickWinner(
        rated.filter((t) => t.apps >= Math.ceil(rounds / RATING_APPS_DIVISOR)),
        RATING_ORDER,
      ),
    );
    add(
      leagueId,
      "young-player",
      pickWinner(
        rated.filter(
          (t) =>
            t.age <= YOUNG_PLAYER_MAX_AGE &&
            t.apps >= Math.ceil(rounds / YOUNG_PLAYER_APPS_DIVISOR),
        ),
        RATING_ORDER,
      ),
    );
  }

  /**
   * 컵·대항전의 상 — **득점왕과 결승 MOM 둘뿐이다** (season.md §6). 평점의 상은
   * 서지 않는다: 대부분의 팀이 한두 경기라 평균 평점의 상은 뽑기가 된다.
   */
  for (const [competitionId, decider] of finalsPlayedIn(state)) {
    /**
     * **한 경기가 대회의 전부면 득점왕은 서지 않는다** — 슈퍼컵이 그렇다. 한 골로
     * 「득점왕」을 세우면 결승 MOM이 이미 말한 사실이 다른 이름으로 한 번 더 선다.
     */
    const played = state.matches.filter(
      (m) => m.season === state.season && m.competitionId === competitionId && m.result,
    ).length;
    if (played > 1) {
      add(
        competitionId,
        "top-scorer",
        pickWinner(
          talliesOf(state, competitionId, endDate).filter((t) => t.goals >= MIN_LEADER_TALLY),
          TOP_SCORER_ORDER,
        ),
      );
    }
    const motm = finalMotmOf(state, decider);
    if (motm) awards.push({ ...motm, season: state.season, competitionId, code: "final-motm" });
  }
  return awards;
}

/**
 * 그해 **결승이 치러진** 컵·대항전과 그 결승 경기 (season.md §6).
 *
 * 2차전제 결승은 마지막 경기가 결승이다 — 트로피가 들리는 경기의 평점이 그 대회의
 * 결승 MOM이다. 결승이 아직 없는 대회(열리지 않았거나 시즌 중)는 이 표에 없다.
 */
function finalsPlayedIn(state: GameState): Map<string, MatchRecord> {
  const finals = new Map<string, MatchRecord>();
  for (const match of state.matches) {
    if (match.season !== state.season || !match.result) continue;
    if (match.stage !== "final" || match.competitionId === null) continue;
    const before = finals.get(match.competitionId);
    // 날짜가 같으면 id로 끊는다 — 순위와 마찬가지로 배열 순서가 답을 정하면 안 된다
    if (
      before &&
      (before.date > match.date || (before.date === match.date && before.id > match.id))
    )
      continue;
    finals.set(match.competitionId, match);
  }
  return new Map([...finals].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/**
 * 결승 **한 경기**의 최우수 선수 — 시즌 합계가 아니다 (season.md §6).
 *
 * 사슬은 경기 리포트의 MOTM과 **같은 하나다**(`compareMotm` — domain/records.ts).
 * 출전 분은 경기 결과에 남지 않으므로 전원 0으로 두고 앞 세 칸과 id로 끊는다.
 * 근거 수치도 그 경기의 것이라 `apps`는 언제나 1이다.
 *
 * 평점이 없는 결승은 상이 서지 않는다 (match.md §6).
 */
function finalMotmOf(
  state: GameState,
  decider: MatchRecord,
): Omit<SeasonAward, "season" | "competitionId" | "code"> | null {
  const result = decider.result;
  const ratings = result?.ratings;
  if (!result || !ratings) return null;
  const goalsOf = (tags: readonly string[], playerId: string): number =>
    tags.filter((tag) => parseScorerEntry(tag).playerId === playerId).length;
  const best = pickMotm(
    Object.entries(ratings).map(([id, rating]) => ({
      id,
      rating,
      goals: goalsOf(result.scorers, id),
      assists: goalsOf(result.assists, id),
      minutes: 0,
    })),
  );
  if (!best) return null;
  const player = playerById(state, best.id);
  if (!player) return null;
  /**
   * 팀은 **그날 어느 쪽에 섰는가**다 — 지금 소속으로 적으면 결승 뒤 소속이 바뀐 선수의
   * 상이 새 셔츠로 남는다.
   */
  const home = result.homeLineup.includes(best.id);
  const away = result.awayLineup.includes(best.id);
  return {
    gamePlayerId: best.id,
    playerName: player.name,
    teamId: home ? decider.homeTeamId : away ? decider.awayTeamId : player.teamId,
    apps: 1,
    goals: best.goals,
    assists: best.assists,
    rating: best.rating ?? undefined,
  };
}

/**
 * 시상 한 줄 — 코드가 주는 이름과 근거 수치로 **읽는 자리에서** 쓴다.
 * 세이브에는 코드와 수치뿐이라 문구를 고치면 옛 시상도 새 문구로 읽힌다
 * (`achievementLine`과 같은 규약 — season.md §6).
 */
export function awardLine(a: SeasonAward): string {
  return (
    `${competitionShortName(a.competitionId)} ${awardTitle(a.code)}: ` +
    `${a.playerName} (${teamName(a.teamId)}) — ${awardDetail(a)}`
  );
}

/** 기록 경신 코드가 가리키는 것 — 세이브에 남는 것은 코드와 수치뿐이다 (season.md §6) */
const CLUB_RECORD_TITLE: Record<ClubRecordCode, string> = {
  "club-record:points": "한 시즌 최다 승점",
  "club-record:goals": "한 시즌 최다 득점",
  "club-record:position": "역대 최고 리그 순위",
};

/**
 * 기록 경신 한 줄 — 코드가 주는 이름과 근거 수치로 **읽는 자리에서** 쓴다
 * (`achievementLine`·`awardLine`과 같은 규약). 물음표도 평가어도 없는 사실이다.
 */
export function recordBreakLine(broken: RecordBreak): string {
  const unit = broken.code === "club-record:position" ? "위" : "";
  return (
    `구단 기록 경신 — ${CLUB_RECORD_TITLE[broken.code]} ${broken.value}${unit}` +
    ` (종전 ${broken.previous}${unit}, 시즌 ${broken.previousSeason})`
  );
}

/**
 * 시상을 매겨 세이브에 앉히고 **우리 리그의 것만** 다이제스트에 남긴다 —
 * 다섯 리그 스무 줄은 감독의 화면이 아니다.
 */
export function gradeAwards(state: GameState): string[] {
  const awards = state.awards;
  const lines: string[] = [];
  for (const a of seasonAwards(state)) {
    // 재실행 방어 — 같은 시즌·같은 대회·같은 코드는 한 번만 선다
    const dup = awards.some(
      (x) => x.season === a.season && x.competitionId === a.competitionId && x.code === a.code,
    );
    if (dup) continue;
    awards.push(a);
    if (awardReachesManager(state, a)) lines.push(awardLine(a));
  }
  return lines;
}

/**
 * 감독에게 가는 상인가 — **우리 리그의 상과 컵·대항전의 상 전부** (season.md §6).
 *
 * 다섯 리그 스무 줄은 감독의 화면이 아니라 남의 리그 득점왕이 빠지지만, 컵과
 * 대항전의 상은 대회마다 두 줄뿐이고 **챔피언스리그 득점왕은 세계의 뉴스**다 —
 * 우리가 그 대회에 나갔는지로 자르면 8강에서 떨어진 해에 그해 유럽의 득점왕을
 * 모르는 감독이 된다.
 *
 * 시즌 다이제스트(`gradeAwards`)와 오프시즌 사실 블록(agents `awardFacts`)이 같은
 * 문을 쓴다 — 두 벌로 두면 결산 그 턴과 그 다음 턴이 다른 상을 말한다.
 */
export function awardReachesManager(state: GameState, award: SeasonAward): boolean {
  return (
    isCup(award.competitionId) || award.competitionId === leagueOfTeamIn(state, state.userTeamId)
  );
}
