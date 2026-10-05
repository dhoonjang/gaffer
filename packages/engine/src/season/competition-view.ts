import { tieAggregate, settledTieWinner } from "../match/extra-time";
import {
  type AbsentReason,
  buildOpponentReport,
  opponentFactText,
  opponentFactFavours,
} from "../match/preview";
import { type TacticsView } from "../match/live-view";
import { type StandingRow, computeStandings, standingsBySplit } from "./standings";
import {
  type ClubColours,
  pairOfMatchId,
  formatScore,
  type MatchRecord,
  PHASE_END,
  outcomeFor,
  isReserveMatch,
} from "@story-fm/domain";
import { type LeaderBoard, type TeamStatRow, leaderboardsOf, teamStatsOf } from "./leaderboard";
import { type GameState, teamNameIn, teamShortNameIn } from "../core/state";
import { domesticCupById, DOMESTIC_STAGES } from "../core/catalog/domestic-cup-catalog";
import {
  cupCatalogById,
  knockoutStages,
  competitionStageLabel,
  competitionName,
  competitionShortName,
  isEuroCup,
  isCup,
  cupCatalog,
  fixtureLabel,
  competitionLabel,
} from "../core/catalog/cup-catalog";
import { isCupOnlyLeague } from "../core/catalog/league-catalog";
import {
  RELEGATION_SLOTS,
  hasRelegation,
  leagueOfTeamIn,
  euroCompetitionOf,
} from "../core/league-membership";
import { diffDays } from "../core/dates";
import { seasonLabelOf, leagueTableOf, championOf } from "./records";
import { nextMatchFor } from "../core/calendar";
import { userStillIn, domesticCupsOf } from "./domestic-cup";
import { clubColoursIn } from "../core/club-colours";

/** 대회 일정의 한 경기 */
interface CompetitionMatchView {
  id: string;
  date: string;
  time: string;
  /** 팀 id — 문장과 구단 색의 열쇠 */
  homeId: string;
  awayId: string;
  homeName: string;
  awayName: string;
  homeShort: string;
  awayShort: string;
  /** 결과 — 미진행이면 null. 승부차기는 괄호로 붙는다 */
  score: string | null;
  /** 우리 팀 경기 */
  ours: boolean;
  /** 우리 경기의 결과 (아니면 null) */
  win: "W" | "D" | "L" | null;
  neutral: boolean;
  /**
   * 양 팀의 **전력 한 숫자** — 스쿼드 상위 열한 명의 평균 OVR
   * (`squadRating` → docs/team/team.md §2.2). 스쿼드가 빈 팀은 `null`이다.
   *
   * 난이도를 색 레일로만 말하면 색을 못 가르는 감독에게는 없는 정보이고, 세 단계의
   * 레일은 78과 74의 차이를 담지 못한다. 그래서 숫자를 그대로 싣는다.
   */
  strength: { home: number; away: number } | null;
  /**
   * **옆 구장의 진행** — 우리와 같은 시각에 킥오프해 지금 굴러가고 있는 경기
   * (match.md §7 「같은 시각에 킥오프한 경기」). 결과가 이미 있는 경기와 우리보다
   * 늦게 시작하는 경기는 `null`이다.
   *
   * 골은 킥오프에 한 번 굴려 둔 것(`PendingMatch.otherScores`)에서 **우리 장부의 분
   * 이하**만 센다 — 감독은 진행을 보고 결과를 미리 알지 않는다.
   */
  live: { minute: number; home: number; away: number } | null;
}

/** 라운드/단계 하나 — 대회 일정의 묶음 단위 */
interface CompetitionRoundView {
  key: string;
  label: string;
  /** 이 라운드의 시작일 (표시·정렬용) */
  date: string;
  matches: CompetitionMatchView[];
  /** 오늘에 가장 가까운 라운드 — UI가 기본으로 펼친다 */
  current: boolean;
}

/**
 * 다음 경기 한 칸 — **팀 단위와 대회 단위가 같은 조각을 쓴다.**
 *
 * 조각으로 싣는 이유: 화면이 날짜·상대·홈원정을 각자 배치하려면 조각이 필요하고,
 * 무엇보다 **며칠 남았는지**가 있어야 한다. 체력이 자리마다 다르게 깎이고 회복이
 * 며칠에 걸리는 지금(match.md §3), "사흘 뒤"인지 "엿새 뒤"인지가 곧 로테이션 판단이다.
 */
interface NextMatchView {
  /**
   * 어느 경기인가 (`MATCH.id`) — 카드가 **그 경기의 상대 분석**을 집을 열쇠다
   * (match.md §1.8). 대회 탭이 세우는 경기와 팀의 다음 경기가 갈릴 수 있으므로
   * 이름·날짜로 맞춰 보게 두면 같은 날 두 경기가 있는 주에 엉뚱한 판이 붙는다.
   */
  matchId: string;
  date: string;
  /** 킥오프 시각 `20:00` */
  time: string;
  /** 어느 경기인가 — 팀 단위는 대회까지(`프리미어리그 R2`), 대회 단위는 그 대회의 라운드 */
  label: string;
  /** 상대 팀 이름 (풀네임) */
  opponent: string;
  venue: "home" | "away" | "neutral";
  /** 오늘로부터 며칠 뒤인가 — 0이면 오늘이다 */
  inDays: number;
}

/**
 * 경기 전 상대 분석 — **다음 경기 카드에 접혀 붙는다** (match.md §1.8 · §8).
 *
 * 조립은 코어 한 곳(`buildOpponentReport`)이고 여기서 하는 일은 문장으로 옮기는
 * 것뿐이다: 사실은 `opponentFactText`가, 6축의 낱말은 화면이 `TACTIC_AXES`로 만든다.
 * 조회 도구(`get_opponent_report`)와 GM 입력의 브리핑도 같은 리포트를 읽는다 —
 * 셋이 각자 세우면 같은 상대가 세 가지로 읽힌다.
 */
interface MatchPreviewView {
  matchId: string;
  /**
   * 상대 예상 XI — **직전 경기 선발에서 투영**한 것이라 예상이다 (match.md §1.8).
   * `carried`가 `false`인 줄은 코어가 메운 자리다.
   */
  expectedXI: {
    id: string;
    name: string;
    position: string;
    squadNumber: number | null;
    carried: boolean;
  }[];
  /** 투영의 근거가 된 상대의 직전 경기 — 없으면 개막전이다 */
  basis: { date: string; label: string } | null;
  /** 직전 경기 선발에서 이어지지 못해 코어가 메운 인원 — 예상의 흐릿한 정도다 */
  guessed: number;
  /**
   * 부상·정지·대표팀 소집으로 못 나오는 상대 선수 (`AbsentReason` — `match/preview.ts`).
   * **id가 함께 선다** — 이름을 눌러 그 선수의 카드를 여는 손잡이의 열쇠다
   * (player.md §9.5). 이름으로 되찾으면 동명이인에서 갈린다.
   */
  absent: { id: string; name: string; position: string; reason: AbsentReason; note: string }[];
  /** 상대가 세워 둔 모양과 6축 — 전술판과 같은 조각이라 화면이 같은 낱말을 쓴다 */
  shape: TacticsView;
  /**
   * 상성·키포인트 — `ours`는 **우리 편에 이로운 줄인가**다.
   */
  keyPoints: { text: string; ours: boolean | null }[];
}

/**
 * 최근 결과 한 줄 — **사실만** (competition.md §7).
 *
 * `"EPL R7 TOT 2-1 ARS (승부차기 4-3)"`처럼 붙여 내면 화면은 승패 색을 칠하려고 그
 * 문자열을 도로 가르고, 승부차기 괄호 규칙이 코어의 템플릿 문자열 안에 숨는다.
 * 조각으로 내려가면 화면이 스코어를 굵게, 우리 편을 진하게, 승패를 색으로 세운다.
 */
interface RecentResultView {
  /** 어느 경기인가 — `EPL R7` · `FA컵 8강` · `친선` */
  label: string;
  /** 홈 팀 약칭 — 우리 편이 어느 쪽인지는 `venue`가 말한다 */
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  /** 승부차기로 갈린 경기만 — 스코어를 바꾸지 않고 옆에 선다 (competition.md §6) */
  penalties: { home: number; away: number } | null;
  /** 우리가 어느 쪽이었나 — 중립 결승도 있다 */
  venue: "home" | "away" | "neutral";
  /** 우리 시점의 결과 */
  outcome: "W" | "D" | "L";
}

/**
 * 지난 시즌 순위표의 한 줄 — **이름은 코어가 붙여 내린다.**
 *
 * 결산 스냅샷은 팀 id만 들고(game-state.md §3.3) 이름은 카탈로그·세이브가 갖는데,
 * 화면이 그걸 뒤지면 엔진을 값으로 import하게 된다 (AGENTS.md §5).
 */
interface SeasonTableRowView {
  /** 1부터 — 스냅샷의 행 순서가 곧 순위다 */
  position: number;
  teamId: string;
  name: string;
  short: string;
  /** 우리 구단인가 — 지금 맡은 구단 기준이다 (아래 `pastSeasons`) */
  ours: boolean;
  /** 그 시즌 성적 */
  record: {
    played: number;
    wins: number;
    draws: number;
    losses: number;
    goalsFor: number;
    goalsAgainst: number;
    goalDiff: number;
    points: number;
  };
}

/**
 * 그 시즌 그 리그의 시상 한 건 — **코드와 근거 수치만** (season.md §6 · 철칙 4).
 * 상의 이름은 `awardTitle(code)`가 주고 문장은 화면이 쓴다.
 */
interface CompetitionAwardView {
  code: string;
  playerName: string;
  teamName: string;
  teamShort: string;
  apps: number;
  goals: number;
  assists: number;
  /** 시즌 평점 — 출전이 없으면 없다 */
  rating?: number;
  /** `young-player`가 센 나이 */
  age?: number;
}

/** 역대 절에 서는 팀 한 칸 — 우승·준우승이 같은 조각을 쓴다 */
interface SeasonTeamView {
  teamId: string;
  name: string;
  short: string;
  /** 우리 구단인가 — 컵은 순위표가 없어 이 칸만이 "우리 해였나"를 말한다 */
  ours: boolean;
}

/**
 * 지나간 시즌 한 줄 — 그 시즌 이 대회가 남긴 것 (season.md §6).
 *
 * 우승·준우승은 **표와 트로피에서 파생한다**: 리그는 순위표의 1위·2위, 녹아웃은
 * `TROPHY`의 우승 팀·결승에서 진 팀. 우승자를 따로 적지 않는 이유가 그것이다
 * (game-state.md §3.3).
 *
 * 모든 구단의 결과를 포함한다. **우리** 표시는 지금 맡은 구단을 기준으로 하며,
 * 감독의 개인 이력은 커리어 화면이 따로 든다 (career.md §6).
 */
interface CompetitionSeasonView {
  season: number;
  /** `2026-27` — 시즌 번호를 연도로 읽는 한 자리 (`seasonLabelOf`) */
  label: string;
  champion: SeasonTeamView | null;
  /** 준우승 — 리그는 표의 2위, 녹아웃은 결승에서 진 팀. 리그의 트로피 줄엔 없다 */
  runnerUp: SeasonTeamView | null;
  /** 그 시즌 우리 구단의 순위 — 그 리그에 없었으면 null (다른 리그·컵) */
  ourPosition: number | null;
  /** 그 시즌 최종 순위표 — 리그전을 돈 대회만. 컵은 빈 배열이다 */
  table: SeasonTableRowView[];
  /**
   * 그 시즌 **이 대회의** 시상 (season.md §6) — 리그는 넷, 컵·대항전은 득점왕과
   * 결승 MOM 둘.
   */
  awards: CompetitionAwardView[];
}

/**
 * 대회 하나 — 순위표 + 라운드별 일정 (+ 대항전이면 브래킷).
 * 우리가 나가는 대회만 만든다 (감독의 관심 범위 = 우리 리그 + 우리 대항전).
 */
interface CompetitionView {
  id: string;
  name: string;
  short: string;
  kind: "league" | "cup";
  /** 순위표 — 국내 컵은 순수 녹아웃이라 **빈 배열**이다 (표 대신 브래킷을 본다) */
  standings: StandingRow[];
  /**
   * 홈 소계·원정 소계로 다시 세운 표 — **같은 행이고 순서만 다르다**
   * (competition.md §2). 화면은 셋 중 하나를 고를 뿐 순서를 만들지 않는다
   * (overview.md §5) — 정렬 규칙이 화면에 서면 순위표가 두 곳에서 정의된다.
   */
  homeTable: StandingRow[];
  awayTable: StandingRow[];
  /**
   * 개인 순위와 팀 열 — **대회 다섯 곳 전부에 선다.** 둘 다 빌 때만 null이다.
   *
   * 개인 순위는 그 대회의 기록만 접고(`talliesOf`) 출전 문턱도 그 대회의 경기에서
   * 나온다 (competition.md §2 「개인 순위」). 팀 열은 순위표가 센 경기와 같은
   * 집합이라 순수 녹아웃(국내 컵)에서는 빈 배열이다.
   */
  leaders: CompetitionLeadersView | null;
  /** 순위 구역 — 챔스·유로파 진출권(리그) 또는 본선 직행·플레이오프(대항전) */
  zones: StandingZone[];
  /** 우리 순위 (0 = 순위표에 없음) */
  userPosition: number;
  /**
   * **이 대회의** 다음 우리 경기 — 남은 경기가 없으면 null(탈락·일정 종료·추첨 전).
   * 팀 단위 `competitions.nextMatch`와 같은 조각이고, 무엇을 세울지는 화면이 고른다
   * (메인 UI는 보고 있는 대회, 경기 중 탭은 팀 — overview §5 · match.md §8).
   */
  nextMatch: NextMatchView | null;
  rounds: CompetitionRoundView[];
  /**
   * 이 대회에 선 구단들의 공식 색 — 팀 id → `colours`. 순위표 행과 라운드 일정이
   * 문장을 그릴 때 같은 사전을 읽는다. 카탈로그에 색이 없는 클럽은 빠진다
   * (문장이 id 해시로 색을 낸다 — team.md §3.1).
   */
  clubColours: Record<string, ClubColours>;
  /** 녹아웃 단계별 대진 — 리그는 빈 배열 */
  bracket: BracketStageView[];
  /** 컵에서 우리가 어디까지 갔나 — 순위표가 없는 대회의 "현재 위치" */
  cupProgress: CupProgressView;
  /** 대항전 전용 — 리그 페이즈 통과 경계선 */
  europe: EuropeView | null;
  /** 완료 기록이 있는 시즌 — 최근이 앞이며 결산 없이 트로피만 있는 시즌도 포함한다. */
  pastSeasons: CompetitionSeasonView[];
}

/** 대회 화면의 개인 순위·팀 열 (competition.md §2 「개인 순위」) */
interface CompetitionLeadersView {
  /** 축별 상위 열 — 줄이 하나도 없는 축은 빠진다 */
  players: LeaderBoard[];
  /** 팀 열 — 순위표와 같은 순서다. 순위표가 없는 국내 컵은 빈 배열 */
  teams: TeamStatRow[];
}

/**
 * 컵 진행 — **브래킷 해석은 코어가 한다.**
 *
 * 화면이 대진을 뒤져 "우리가 마지막으로 선 단계"를 찾으면 같은 장부를 두 곳에서
 * 읽게 되고, 그 규칙이 갈리면 순위표 없는 대회의 머리줄만 조용히 틀린다.
 * 코어는 단계와 결말만 내고 "8강 탈락"이라는 문장은 화면이 잇는다.
 */
interface CupProgressView {
  /** 우리 대진이 마지막으로 선 단계 이름 — 아직 서 본 적이 없으면 null */
  stage: string | null;
  /**
   * 그 단계에서 무슨 일이 있었나.
   * `undrawn` 추첨 전 · `out` 대진에 우리가 없다 · `eliminated` 그 단계에서 졌다 ·
   * `champion` 결승에서 이겼다 · `through` 통과해 다음을 기다린다
   */
  outcome: "undrawn" | "out" | "eliminated" | "champion" | "through";
}

/** 브래킷에서 우리 자리를 읽는다 — `cupProgress`의 단일 규칙 */
export function cupProgressOf(bracket: readonly BracketStageView[]): CupProgressView {
  const ours = bracket.filter((stage) => stage.ties.some((t) => t.ours));
  const last = ours[ours.length - 1];
  if (!last) return { stage: null, outcome: bracket.length === 0 ? "undrawn" : "out" };
  const tie = last.ties.find((t) => t.ours)!;
  if (tie.won === false) return { stage: last.label, outcome: "eliminated" };
  if (tie.won === true && last.stage === "final") return { stage: last.label, outcome: "champion" };
  return { stage: last.label, outcome: "through" };
}

export interface BracketStageView {
  stage: string;
  label: string;
  ties: Array<{
    /** 마지막 경기 날짜 — 순수 녹아웃 대회는 브래킷이 곧 일정표다 */
    date: string;
    home: string;
    away: string;
    score: string | null;
    ours: boolean;
    won: boolean | null;
  }>;
}

/**
 * 순위표 구역 — 그 순위에 무슨 뜻이 붙는가 (챔스 진출·본선 직행 등).
 * 대회 카탈로그의 티켓 수에서 파생되고, 강등·승격 구역은 승강 규칙에서 나온다.
 */
interface StandingZone {
  /** 이 구역이 끝나는 순위 (1부터, 포함) */
  through: number;
  label: string;
  /** 색 키 — 리그는 대회 id(`ucl`·`uel`·`uecl`), 대항전은 통과 방식(`direct`·`playoff`) */
  kind: string;
}

/** 대항전 뷰 — 리그 페이즈 순위표에 긋는 통과 경계선 (우리 팀 대회만) */
interface EuropeView {
  competitionId: string;
  competition: string;
  short: string;
  standings: StandingRow[];
  ourPosition: number;
  /** 리그 페이즈 통과 기준 — 직행 / 플레이오프 경계 (순위표에 선을 긋는다) */
  directSlots: number;
  playoffCutoff: number;
}

/**
 * 녹아웃 브래킷 — 유럽 대항전과 국내 컵이 같은 모양을 쓴다.
 *
 * 읽기 전용이다. 승부차기는 이미 장부에 기록된 것만 읽는다 (여기서 판정하면
 * 뷰를 여는 것이 게임 상태를 바꾸는 셈이 된다 — 판정은 tick·경기 종료가 한다).
 */
function buildBracket(state: GameState, competitionId: string): BracketStageView[] {
  const domestic = domesticCupById(competitionId);
  const euroCup = cupCatalogById(competitionId);
  const stages = domestic ? DOMESTIC_STAGES : euroCup ? knockoutStages(euroCup) : [];
  const bracket: BracketStageView[] = [];

  for (const stage of stages) {
    const matches = state.matches
      .filter(
        (m) => m.season === state.season && m.competitionId === competitionId && m.stage === stage,
      )
      .sort((a, b) => a.id.localeCompare(b.id) || a.round - b.round);
    if (matches.length === 0) continue;
    const byPair = new Map<string, typeof matches>();
    for (const m of matches) {
      const pair = pairOfMatchId(m.id);
      const legs = byPair.get(pair);
      if (legs) legs.push(m);
      else byPair.set(pair, [m]);
    }
    const ties = [...byPair.values()].map((legs) => {
      const decider = legs[legs.length - 1]!;
      const home = decider.homeTeamId;
      const away = decider.awayTeamId;
      const ours = home === state.userTeamId || away === state.userTeamId;
      const played = legs.filter((m) => m.result);
      let score: string | null = null;
      let won: boolean | null = null;
      if (played.length === legs.length) {
        const agg = tieAggregate(played, decider);
        score = formatScore(agg.home, agg.away, decider.result?.penalties);
        const winner = settledTieWinner(played);
        if (ours && winner) won = winner === state.userTeamId;
      } else if (played.length > 0) {
        // 1차전만 끝난 대진 — 진행 중임을 스코어로 보인다
        const leg = played[0]!;
        score = `1차전 ${formatScore(leg.result!.homeGoals, leg.result!.awayGoals)}`;
      }
      return {
        date: decider.date,
        home: teamNameIn(state, home),
        away: teamNameIn(state, away),
        score,
        ours,
        won,
      };
    });
    bracket.push({ stage, label: competitionStageLabel(competitionId, stage), ties });
  }
  return bracket;
}

/** 대항전 뷰 — 우리 팀이 나가는 대회의 리그 페이즈 통과 경계선 */
function buildEuropeView(state: GameState, cupId: string): EuropeView | null {
  const cup = cupCatalogById(cupId);
  if (!cup) return null;
  const standings = computeStandings(state, cupId);
  return {
    competitionId: cupId,
    competition: competitionName(cupId),
    short: competitionShortName(cupId),
    standings,
    ourPosition: standings.findIndex((r) => r.teamId === state.userTeamId) + 1,
    directSlots: cup.directSlots,
    playoffCutoff: cup.directSlots + cup.playoffSlots,
  };
}

/**
 * 순위표에 긋는 구역 — "이 순위가 무슨 뜻인가".
 *
 * 감독이 순위표를 볼 때 알고 싶은 건 등수가 아니라 **경계**다. 4위와 5위의 차이는
 * 한 계단이 아니라 챔피언스리그와 유로파리그의 차이다. 그래서 구역은 UI가 고르는
 * 장식이 아니라 **대회 카탈로그에서 파생되는 사실**이다 — 리그별 티켓 수가 바뀌면
 * 표의 선도 따라 움직인다.
 *
 * ⚠️ **구역은 1위부터 빈틈없이 이어져야 한다** — 화면이 "이 순위 이하"로 구역을
 * 찾기 때문이다(`zoneAt`). 그래서 강등선 위의 중위권도 `잔류`로 이름을 갖는다.
 * 구멍을 두면 7위가 강등 구역으로 읽힌다.
 *
 * 리그의 마지막 자리는 **국내 컵 우승팀이 순위 밖일 때 바뀔 수 있다**(europe.ts의
 * 연쇄 배정) — 경계선은 규정이고, 자리의 주인은 시즌이 끝나고 정해진다.
 */
export function buildStandingZones(
  state: GameState,
  competitionId: string,
  /** 그 대회의 팀 수 — 강등선은 아래에서 세므로 필요하다 */
  size: number,
): StandingZone[] {
  // 대항전 리그 페이즈 — 통과 기준이 곧 구역이다
  if (isEuroCup(competitionId)) {
    const cup = cupCatalogById(competitionId);
    if (!cup) return [];
    const zones: StandingZone[] = [
      { through: cup.directSlots, label: "본선 직행", kind: "direct" },
    ];
    if (cup.playoffSlots > 0) {
      zones.push({
        through: cup.directSlots + cup.playoffSlots,
        label: "플레이오프",
        kind: "playoff",
      });
    }
    return zones;
  }
  if (isCup(competitionId)) return []; // 국내 컵은 순위표가 없다
  // 2부 — 티켓도 강등도 없고 위로 가는 문만 있다 (`promotion.ts`)
  if (isCupOnlyLeague(competitionId)) {
    return size > RELEGATION_SLOTS
      ? [{ through: RELEGATION_SLOTS, label: "승격", kind: "promotion" }]
      : [];
  }
  // 리그 — 유럽 진출 티켓을 상위부터 채운다 (europe.ts의 배정 순서와 같은 규칙)
  const zones: StandingZone[] = [];
  let cursor = 0;
  for (const cup of cupCatalog()) {
    const count = cup.slots[competitionId] ?? 0;
    if (count === 0) continue;
    cursor += count;
    zones.push({ through: cursor, label: competitionName(cup.id), kind: cup.id });
  }
  // 강등 — 아래 리그가 이 세계에 실제로 있을 때만 선을 긋는다 (축소 세계엔 없다)
  const cut = size - RELEGATION_SLOTS;
  if (hasRelegation(state, competitionId) && cut > cursor) {
    zones.push({ through: cut, label: "잔류", kind: "safe" });
    zones.push({ through: size, label: "강등", kind: "relegation" });
  }
  return zones;
}

/** 경기 결과 표기 — 승부차기까지, 자는 `formatScore` 하나 (미진행이면 null) */
export function scoreOf(match: MatchRecord): string | null {
  if (!match.result) return null;
  const { homeGoals, awayGoals, penalties } = match.result;
  return formatScore(homeGoals, awayGoals, penalties);
}

/**
 * 옆 구장의 진행 — 경기 id → 지금까지의 스코어 (match.md §7).
 *
 * 킥오프에 한 번 굴려 둔 골 시각(`PendingMatch.otherScores`)에서 **우리 장부의 분
 * 이하**만 센다. 우리 경기가 연장으로 가면 그쪽은 이미 끝났으므로 분은 정규 90′에서
 * 멎는다 — 「연장 105′」이라고 적으면 끝난 경기가 아직 뛰고 있는 것처럼 읽힌다.
 */
function liveScoresOf(state: GameState): Map<string, NonNullable<CompetitionMatchView["live"]>> {
  const live = new Map<string, NonNullable<CompetitionMatchView["live"]>>();
  const pending = state.pendingMatch;
  if (!pending || state.phase !== "match") return live;
  /**
   * 입장 전에도 문을 따로 두지 않는다 — 그때 장부의 분은 0이라 아무 골도 실리지
   * 않는다. 분이 이미 하는 일을 조건으로 한 번 더 쓰면, 그 조건을 지나지 않는
   * 호출부(mock GM·테스트)에서만 옆 구장이 조용해진다.
   */
  const minute = Math.min(pending.live.ledger.minute, PHASE_END.second_half);
  for (const row of pending.otherScores) {
    const played = row.goals.filter((g) => g.minute <= minute);
    live.set(row.matchId, {
      minute,
      home: played.filter((g) => g.side === "home").length,
      away: played.filter((g) => g.side === "away").length,
    });
  }
  return live;
}

/**
 * 팀 하나의 전력 숫자 — 정수로 자른 `squadRating` (docs/team/team.md §2.2).
 * 스쿼드가 빈 팀(어드민이 막 만든 클럽)은 `null`이라 화면이 자리를 비운다.
 */
export function strengthOf(ratings: ReadonlyMap<string, number>, teamId: string): number | null {
  const value = ratings.get(teamId);
  return value === undefined || value <= 0 ? null : Math.round(value);
}

/** 한 대진의 두 숫자 — 한쪽이라도 없으면 칸을 세우지 않는다 (반쪽 비교는 오독을 만든다) */
function strengthPairOf(
  ratings: ReadonlyMap<string, number>,
  homeTeamId: string,
  awayTeamId: string,
): CompetitionMatchView["strength"] {
  const home = strengthOf(ratings, homeTeamId);
  const away = strengthOf(ratings, awayTeamId);
  return home === null || away === null ? null : { home, away };
}

/**
 * 경기 하나를 "다음 경기" 조각으로 — 팀 단위와 대회 단위가 같은 함수를 쓴다.
 * 갈리는 것은 **무엇을 골랐는가**와 표기(`label`)뿐이라, 같은 경기를 두 자리에서
 * 다르게 적을 길이 없다.
 */
/**
 * 경기 전 상대 분석 한 장 — 코어의 리포트를 화면 조각으로 옮긴다 (match.md §3.6).
 * 사실을 문장으로 바꾸는 자리는 하나다(`opponentFactText`) — 조회 도구·GM 스냅샷과
 * 같은 렌더러이므로 같은 사실이 세 문장으로 갈리지 않는다.
 */
function matchPreviewView(state: GameState, matchId: string): MatchPreviewView | null {
  const report = buildOpponentReport(state, { matchId });
  if (!report) return null;
  return {
    matchId: report.matchId,
    expectedXI: report.expectedXI.map((p) => ({ ...p })),
    basis: report.basis ? { date: report.basis.date, label: report.basis.label } : null,
    /**
     * 근거가 없으면 **열한 명이 다 추정이라** 세는 뜻이 없다 — 그때 0이다.
     * 표시는 관측과 추정이 섞였을 때만 값을 하고, 화면은 이 수로 그것을 가른다.
     */
    guessed: report.basis === null ? 0 : report.expectedXI.filter((p) => !p.carried).length,
    absent: report.absent.map((a) => ({
      id: a.id,
      name: a.name,
      position: a.position,
      reason: a.reason,
      note: a.note,
    })),
    shape: { ...report.shape },
    keyPoints: report.facts.map((fact) => ({
      text: opponentFactText(fact),
      ours: opponentFactFavours(fact),
    })),
  };
}

function nextMatchView(state: GameState, m: MatchRecord, label: string): NextMatchView {
  const userTeamId = state.userTeamId;
  return {
    matchId: m.id,
    date: m.date,
    time: m.time,
    label,
    opponent: teamNameIn(state, m.homeTeamId === userTeamId ? m.awayTeamId : m.homeTeamId),
    venue: m.neutral ? "neutral" : m.homeTeamId === userTeamId ? "home" : "away",
    inDays: Math.max(0, diffDays(state.date, m.date)),
  };
}

/** 지난 시즌 표·트로피에 서는 팀 한 칸 — 이름은 그때가 아니라 지금 것이다 */
function seasonTeamView(state: GameState, teamId: string): SeasonTeamView {
  return {
    teamId,
    name: teamNameIn(state, teamId),
    short: teamShortNameIn(state, teamId),
    ours: teamId === state.userTeamId,
  };
}

/**
 * 완료된 시즌들 — 결산 스냅샷과 우승 원장에서 이 대회의 몫만 접는다.
 *
 * ⚠️ **이 대회에 대해 아는 것이 하나도 없는 해는 줄을 세우지 않는다.** 다른 리그에
 * 있었거나 그해 이 컵이 열리지 않았으면 표도 우승자도 없고, 빈 줄은 "우승 없음"이라는
 * 없는 사실이 된다.
 */
export function competitionSeasonsOf(
  state: GameState,
  competitionId: string,
): CompetitionSeasonView[] {
  const awards = state.awards;
  const seasons: CompetitionSeasonView[] = [];
  const completed = new Set([
    ...state.history.map((history) => history.season),
    ...state.trophies.filter((t) => t.competitionId === competitionId).map((t) => t.season),
  ]);
  for (const season of [...completed].sort((a, b) => b - a)) {
    const rows = leagueTableOf(state, season, competitionId);
    const champion = championOf(state, season, competitionId);
    if (!rows?.length && champion === null) continue;
    // 녹아웃은 트로피가 준우승까지 한 줄에 든다. 리그는 결승이 없어 2위가 그 자리다
    const runnerUp = rows
      ? (rows[1]?.teamId ?? null)
      : (state.trophies.find((t) => t.season === season && t.competitionId === competitionId)
          ?.runnerUpTeamId ?? null);
    const table = (rows ?? []).map((row, i): SeasonTableRowView => {
      const record = row.record;
      return {
        position: i + 1,
        teamId: row.teamId,
        name: teamNameIn(state, row.teamId),
        short: teamShortNameIn(state, row.teamId),
        ours: row.teamId === state.userTeamId,
        record: { ...record, goalDiff: record.goalsFor - record.goalsAgainst },
      };
    });
    const ourRow = table.findIndex((r) => r.ours);
    seasons.push({
      season,
      label: seasonLabelOf(season),
      champion: champion === null ? null : seasonTeamView(state, champion),
      runnerUp: runnerUp === null ? null : seasonTeamView(state, runnerUp),
      ourPosition: ourRow < 0 ? null : ourRow + 1,
      table,
      // 대회마다 상이 선다 — 컵 탭에는 그 컵의 득점왕과 결승 MOM이 걸린다 (season.md §6)
      awards: awards
        .filter((a) => a.season === season && a.competitionId === competitionId)
        .map((a) => ({
          code: a.code,
          playerName: a.playerName,
          teamName: teamNameIn(state, a.teamId),
          teamShort: teamShortNameIn(state, a.teamId),
          apps: a.apps,
          goals: a.goals,
          assists: a.assists,
          ...(a.rating === undefined ? {} : { rating: a.rating }),
          ...(a.age === undefined ? {} : { age: a.age }),
        })),
    });
  }
  return seasons;
}

/**
 * 대회 하나의 뷰 — 순위표 + 라운드별 일정.
 *
 * 라운드 묶음은 `(stage, round)`로 만든다. 리그는 stage가 없어 `R3`이 곧 라운드고,
 * 대항전은 리그 페이즈(R1~8) 뒤에 2차전제 녹아웃 단계가 붙는다. `current`는 오늘
 * 이후 첫 라운드(전부 끝났으면 마지막)로, UI가 여기서부터 보여준다.
 */
function buildCompetitionView(
  state: GameState,
  competitionId: string,
  /**
   * 전 팀의 전력 한 숫자 — 호출부가 **한 번 훑어** 세운 것을 받는다
   * (`squadRatingsOf` → docs/team/team.md §2.2). 대회마다 다시 세우면 그 자리가
   * 「대회 수 × 선수 수」가 된다.
   */
  squadRatings: ReadonlyMap<string, number>,
): CompetitionView {
  // 옆 구장 — 경기 중에만 값이 있다 (match.md §7)
  const live = liveScoresOf(state);
  const cup = isCup(competitionId);
  const matches = state.matches
    .filter((m) => m.competitionId === competitionId && m.season === state.season)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.time.localeCompare(b.time)));

  const order = new Map<string, number>();
  for (const stage of ["league", "playoff", "r32", "r16", "qf", "sf", "final"]) {
    order.set(stage, order.size);
  }
  // 라운드 표기는 한 번만 적는다 — 묶음 머리와 "다음 경기" 카드가 같은 문장을 쓴다
  const roundLabelOf = (m: MatchRecord): string => {
    const stage = m.stage;
    return cup
      ? stage === "league"
        ? `리그 페이즈 ${m.round}R`
        : competitionStageLabel(competitionId, stage, m.round)
      : `${m.round}라운드`;
  };
  const grouped = new Map<string, CompetitionRoundView>();
  for (const m of matches) {
    const stage = m.stage;
    const key = `${stage}:${m.round}`;
    const label = roundLabelOf(m);
    const round = grouped.get(key) ?? { key, label, date: m.date, matches: [], current: false };
    round.matches.push({
      id: m.id,
      date: m.date,
      time: m.time,
      homeId: m.homeTeamId,
      awayId: m.awayTeamId,
      homeName: teamNameIn(state, m.homeTeamId),
      awayName: teamNameIn(state, m.awayTeamId),
      homeShort: teamShortNameIn(state, m.homeTeamId),
      awayShort: teamShortNameIn(state, m.awayTeamId),
      score: scoreOf(m),
      ours: m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
      win: outcomeFor(m, state.userTeamId),
      neutral: m.neutral === true,
      strength: strengthPairOf(squadRatings, m.homeTeamId, m.awayTeamId),
      live: live.get(m.id) ?? null,
    });
    if (m.date < round.date) round.date = m.date;
    grouped.set(key, round);
  }

  const rounds = [...grouped.values()].sort((a, b) => {
    const [aStage, aRound] = a.key.split(":") as [string, string];
    const [bStage, bRound] = b.key.split(":") as [string, string];
    return (order.get(aStage) ?? 9) - (order.get(bStage) ?? 9) || Number(aRound) - Number(bRound);
  });
  // 오늘 이후 첫 라운드 = 지금 보고 싶은 라운드 (전부 끝났으면 마지막)
  const currentIndex = rounds.findIndex((r) => r.matches.some((m) => m.date >= state.date));
  const current = rounds[currentIndex >= 0 ? currentIndex : rounds.length - 1];
  if (current) current.current = true;

  const standings = computeStandings(state, competitionId);
  /**
   * 개인 순위는 대회마다 선다 — 국내 컵도 라운드가 적을 뿐 표는 표다
   * (competition.md §2 「개인 순위」). 팀 열은 순위표가 센 경기와 같은 집합이라
   * 순수 녹아웃에서는 비고, 그때는 개인 순위만 남는다.
   */
  const leaderRows = leaderboardsOf(state, competitionId);
  const teamRows = teamStatsOf(state, competitionId);
  const leaders: CompetitionLeadersView | null =
    leaderRows.length === 0 && teamRows.length === 0
      ? null
      : { players: leaderRows, teams: teamRows };
  /**
   * 이 대회의 다음 우리 경기 — **팀 단위와 같은 함수로 고른다.**
   *
   * 결과가 없는 첫 경기를 그냥 집으면 경기 중에는 그게 **지금 이 경기**다(결과는
   * 종료 시점에 쓰인다). 그러면 대회 머리줄이 "다음 · 오늘 · 지금 상대"가 된다.
   */
  const nextOurs = nextMatchFor(
    matches,
    state.userTeamId,
    state.date,
    state.pendingMatch?.matchId ?? null,
  );
  const bracket = cup ? buildBracket(state, competitionId) : [];
  const progress = cupProgressOf(bracket);
  // 시드는 진입 라운드 전까지 대진에 없어도 탈락이 아니다 — 아직 안 뽑힌 것으로 읽는다
  const cupProgress =
    progress.outcome === "out" &&
    domesticCupById(competitionId) !== null &&
    userStillIn(state, competitionId)
      ? { stage: null, outcome: "undrawn" as const }
      : progress;
  const pastSeasons = competitionSeasonsOf(state, competitionId);
  return {
    id: competitionId,
    name: competitionName(competitionId),
    short: competitionShortName(competitionId),
    kind: cup ? "cup" : "league",
    standings,
    homeTable: standingsBySplit(standings, "home"),
    awayTable: standingsBySplit(standings, "away"),
    leaders,
    zones: buildStandingZones(state, competitionId, standings.length),
    userPosition: standings.findIndex((r) => r.teamId === state.userTeamId) + 1,
    nextMatch: nextOurs ? nextMatchView(state, nextOurs, roundLabelOf(nextOurs)) : null,
    rounds,
    clubColours: clubColoursIn([
      ...standings.map((r) => r.teamId),
      ...matches.flatMap((m) => [m.homeTeamId, m.awayTeamId]),
      ...pastSeasons.flatMap((s) =>
        [s.champion?.teamId, s.runnerUp?.teamId].filter((id): id is string => id !== undefined),
      ),
    ]),
    bracket,
    cupProgress,
    // 통과 경계선은 리그 페이즈가 있는 대항전에만 있다 (국내 컵은 순위표가 없다)
    europe: isEuroCup(competitionId) ? buildEuropeView(state, competitionId) : null,
    pastSeasons,
  };
}

export type CompetitionsView = {
  /**
   * **우리 팀의 당장 다음 경기** — 대회를 가리지 않는다. 경기 중 대회 탭이
   * 세우는 것이 이것이다(match.md §8): 90분 안에 묻는 것은 이 경기가 끝난 뒤
   * 언제 누구인가지 그 대회의 다음 라운드가 아니다.
   */
  nextMatch: NextMatchView | null;
  /**
   * 그 경기의 **상대 분석** — 위 `nextMatch`와 같은 경기다 (match.md §1.8).
   * 경기 중에는 `null`이다: 90분 안에 다음 상대를 분석하는 자리는 없고, 지금
   * 판은 판세 탭이 이미 들고 있다.
   */
  preview: MatchPreviewView | null;
  /** 최근 다섯 경기 — **사실만**. 문장은 화면이 잇는다 (competition.md §7) */
  recentResults: RecentResultView[];
  /** 탭 순서: 우리 리그 → 우리 대항전 */
  list: CompetitionView[];
};

export function buildCompetitionsView(
  state: GameState,
  squadRatings: ReadonlyMap<string, number>,
  next: MatchRecord | null,
): CompetitionsView {
  const userTeamId = state.userTeamId;
  // 대회 탭 — 우리 리그 → 우리가 나가는 대항전 → 우리 나라 국내 컵 (명성 순)
  // 리그는 **지금 뛰는 리그**다 — 강등되면 카탈로그와 갈린다 (`promotion.ts`)
  const ourLeague = leagueOfTeamIn(state, userTeamId);
  const ourEuroCup = euroCompetitionOf(state.euroEntrants, userTeamId);
  const competitionList = [
    ourLeague,
    ...(ourEuroCup ? [ourEuroCup] : []),
    ...domesticCupsOf(userTeamId).map((c) => c.id),
  ].map((id) => buildCompetitionView(state, id, squadRatings));
  const recentResults = state.matches
    // 2군 경기는 1군의 최근 결과가 아니다 — 다이제스트와 선수 기록으로만 보인다
    .filter(
      (m) =>
        m.result &&
        !isReserveMatch(m) &&
        (m.homeTeamId === userTeamId || m.awayTeamId === userTeamId),
    )
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-5)
    .map((m): RecentResultView | null => {
      const result = m.result;
      const outcome = outcomeFor(m, userTeamId);
      // 위 필터가 결과 있는 우리 경기만 남긴다 — 타입을 좁히는 자리다
      if (!result || !outcome) return null;
      return {
        label: fixtureLabel(m.competitionId, m.stage, m.round),
        home: teamShortNameIn(state, m.homeTeamId),
        away: teamShortNameIn(state, m.awayTeamId),
        homeGoals: result.homeGoals,
        awayGoals: result.awayGoals,
        penalties: result.penalties
          ? { home: result.penalties.home, away: result.penalties.away }
          : null,
        venue: m.neutral ? "neutral" : m.homeTeamId === userTeamId ? "home" : "away",
        outcome,
      };
    })
    .filter((r): r is RecentResultView => r !== null);

  return {
    // 대회 이름을 **언제나** 붙인다 — 이 카드 하나가 유일한 일정 정보라
    // "R2"만 적으면 무슨 대회의 2라운드인지 화면 어디에도 없다
    nextMatch: next
      ? nextMatchView(state, next, competitionLabel(next.competitionId, next.stage, next.round))
      : null,
    // 같은 경기의 상대 분석 — 코어가 경기 중에는 빈손을 낸다 (`buildOpponentReport`)
    preview: next ? matchPreviewView(state, next.id) : null,
    recentResults,
    list: competitionList,
  };
}
