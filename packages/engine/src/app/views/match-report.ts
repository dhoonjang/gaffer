import {
  type MatchEventType,
  type ShotOrigin,
  type ClubColours,
  pickMotm,
  type MatchRecord,
  parseScorerEntry,
  matchMinutesOf,
  eventCauseText,
  subCauseText,
  outcomeFor,
  shootoutTally,
} from "@story-fm/domain";
import { type RatingTone, ratingTone } from "../../match/ratings";
import { type MatchShootoutKickView, roundTo } from "../../match/live-view";
import {
  type GameState,
  playerName,
  playerById,
  teamNameIn,
  teamShortNameIn,
} from "../../core/state";
import { type StandingRow, computeStandings } from "../../season/standings";
import {
  competitionShortName,
  competitionLabel,
  competitionStageLabel,
} from "../../core/catalog/cup-catalog";
import { clubColoursOf } from "../../core/club-colours";

// ── 경기 리포트 — 끝난 경기 하나를 통째로 (match.md §8) ─────────────

/**
 * **큰 기회의 문턱** — 이 xG 이상인 슛만 타임라인에 선다.
 *
 * 슛 하나의 기본 xG가 `BASE_SHOT_XG`(0.10)이므로 그 세 배다. 문턱이 없으면 슛
 * 스무 개가 한 줄씩 서서 골이 그 안에 묻히고, 문턱을 두지 않고 슛을 통째로 버리면
 * "0.6짜리를 놓친 경기"가 사라진다. 슛의 **총량**은 이미 팀 스탯의 숫자다.
 */
export const BIG_CHANCE_XG = 0.3;

/** 타임라인에 서는 사건 — 저장은 전부 하고(match.md §4) 세우는 것만 고른다 */
const TIMELINE_TYPES: ReadonlySet<MatchEventType> = new Set([
  "goal",
  "yellow_card",
  "red_card",
  "substitution",
  "injury",
  "tactical_shift",
  "half_time",
  "extra_time_start",
  "extra_half_time",
  "full_time",
]);

/** 타임라인 한 줄 — 사건 하나를 이름과 문장으로 옮긴 것 */
export interface MatchReportEventView {
  minute: number;
  /** 무엇이 일어났나 — 화면이 아이콘을, 조회가 말을 고른다 */
  type: MatchEventType;
  /** 어느 편의 사건인가 — 국면 표식은 편이 없다 */
  side: "home" | "away" | null;
  /** 우리 편의 사건인가 — 우리 경기가 아니면 null */
  ours: boolean | null;
  /** 주체의 이름 — goal은 [득점자, (도움)], substitution은 [아웃, 인] */
  actors: string[];
  /** 골·큰 기회가 어디서 나왔나 (열린 플레이·코너·프리킥·페널티) */
  origin: ShotOrigin | null;
  /** 그 슛의 질 — 골과 큰 기회에만 */
  xg: number | null;

  causes: string[];
  /** 교체의 갈래 한 마디 — 승부수인가 굳히기인가 */
  subCause: string | null;
}

/** 한 팀의 경기 스탯 — 선수별 기록과 사건의 합, 두 벌로 두지 않는다 */
interface MatchReportTeamView {
  /**
   * 팀 id — 문장(`crestOf`)과 구단 색의 열쇠다 (web/design-system.md §2). 종료 카드의
   * 머리가 스코어보드와 **같은 해부**(문장 · 이름 · 스코어)로 서려면 이름만으로는
   * 모자란다 — 어드민 편집으로 이름이 갈리면 문장도 함께 갈린다.
   */
  id: string;
  name: string;
  short: string;
  /** 카탈로그의 공식 색 — 화면은 엔진을 값으로 못 읽으므로 여기 실려 간다 */
  colours?: ClubColours;
  ours: boolean;
  goals: number;
  shots: number;
  /** 기회 xG의 합 */
  xg: number;
  /** 결정력을 반영한 기대 득점 */
  expectedGoals: number;
  /** 공을 쥔 몫 0~1 */
  possession: number;
  passes: number;
  progressive: number;
  corners: number;
  fouls: number;
  yellows: number;
  reds: number;
}

/** 선수 한 명의 경기 기록 — 평점과 그 근거까지 */
export interface MatchReportPlayerView {
  id: string;
  name: string;
  side: "home" | "away";
  ours: boolean;
  /** 등번호 — 지금 달고 있는 번호다 */
  squadNumber: number | null;
  /** 뛴 시간 — 사건 목록이 원본이다 (`matchMinutesOf`) */
  minutes: number;
  /** 선발이었나 — 교체로 들어온 선수가 아니면 선발이다 */
  started: boolean;
  goals: number;
  assists: number;
  shots: number;
  xg: number;
  saves: number;
  passes: number;
  progressive: number;
  corners: number;
  fouls: number;
  yellows: number;
  red: boolean;
  /** 평점 — 감독 팀 경기의 우리 선수만 갖는다 (match.md §6) */
  rating: number | null;
  /** 평점의 색 — 문턱은 코어가 갖는다 (`ratingTone`) */
  tone: RatingTone | null;
  /** 평점 한 줄 근거 — 결산 LLM이 남긴 경우에만 */
  note: string | null;
}

/**
 * 끝난 경기 한 장 — **읽는 곳이 셋이라 만드는 곳은 하나다** (match.md §8).
 *
 * 달력 상세의 접이식 · 종료 카드 · GM 조회(`get_match_report`)가 이 한 벌을 읽는다.
 * 셋이 각자 접으면 같은 경기가 세 가지로 보인다.
 */
export interface MatchReportView {
  matchId: string;
  date: string;
  /** 어느 경기인가 — `프리미어리그 R7` · `FA컵 8강 1차전` */
  label: string;
  /** 대회 약칭 */
  competition: string;
  stage: string;
  home: MatchReportTeamView;
  away: MatchReportTeamView;
  /** 우리가 어느 쪽이었나 — 우리 경기가 아니면 null */
  venue: "home" | "away" | "neutral" | null;
  /** 우리 시점의 결과 — 우리 경기가 아니면 null */
  outcome: "W" | "D" | "L" | null;
  /** 연장을 치렀다 */
  aet: boolean;
  /** 승부차기 — 갈린 경기만. 킥이 원본이라 합계도 거기서 센다 */
  penalties: {
    home: number;
    away: number;
    kicks: MatchShootoutKickView[];
  } | null;
  timeline: MatchReportEventView[];
  players: MatchReportPlayerView[];
  /** 최우수 선수 — 평점에서 파생한다 (`motmOf`) */
  motm: { id: string; name: string; rating: number } | null;
  /**
   * **이 경기가 표를 옮긴 몫** — 「12위 → 9위」 (match.md §8).
   *
   * 리그전이면서 우리 팀이 뛴 경기에만 선다. `after`는 이 경기의 킥오프 시각까지
   * 치러진 경기로 세운 표, `before`는 거기서 **이 경기만** 뺀 표다 — 같은 라운드의
   * 남의 결과는 양쪽에 다 들어 있으므로 두 순위의 차이는 오직 이 경기가 낸 것이고,
   * 반년 뒤에 리포트를 열어도 같은 값이 나온다.
   */
  standings: { competition: string; before: number; after: number } | null;
  /**
   * **사건이 남아 있는 경기인가.** 타 팀 간이 시뮬에는 사건이 없어
   * 타임라인이 득점 줄뿐이다 — 읽는 쪽이 그것을 "조용했던 경기"로 읽지 않게 한다.
   */
  hasDetail: boolean;
}

/**
 * **최우수 선수 — 평점이 원본이다** (game-state.md §5 파생).
 *
 * 저장하지 않는 이유는 평점이 두 번 정해지기 때문이다: 코어가 앵커를 박고 결산
 * 판정이 그 위에서 다듬는다(match.md §6). 저장하면 다듬어진 뒤에도 MOTM만 옛
 * 값으로 남는다.
 *
 * 동점 사슬은 **도메인이 갖는다**(`compareMotm`) — 대회의 결승 MOM 시상이 같은
 * 사슬을 쓰기 때문이다 (season.md §6). 두 벌로 두면 같은 결승의 최우수 선수가
 * 화면과 시상에서 다른 사람이 된다.
 */
export function motmOf(players: readonly MatchReportPlayerView[]): MatchReportPlayerView | null {
  return pickMotm(players);
}

/** 사건이 없는 간이 시뮬 경기의 타임라인 — 결과에 남은 득점 줄만 세운다 */
function goalTimelineOf(
  state: GameState,
  result: NonNullable<MatchRecord["result"]>,
  ourSide: "home" | "away" | null,
): MatchReportEventView[] {
  const { assists, goalMinutes: minutes, goalOrigins: origins } = result;
  return result.scorers.map((entry, i) => {
    const goal = parseScorerEntry(entry);
    const assist = parseScorerEntry(assists[i] ?? "");
    return {
      minute: minutes[i] ?? 0,
      type: "goal" as const,
      side: goal.side,
      ours: ourSide === null || goal.side === null ? null : goal.side === ourSide,
      actors: [
        playerName(state, goal.playerId),
        ...(assist.playerId ? [playerName(state, assist.playerId)] : []),
      ],
      origin: origins[i] ?? null,
      xg: null,
      causes: [],
      subCause: null,
    };
  });
}

/**
 * 이 경기가 표를 옮긴 몫 — **같은 시점의 표를 두 번 세워 뺀다** (match.md §8).
 *
 * 기준선을 "오늘의 표"로 잡으면 그 사이 치러진 남의 경기까지 우리 결과인 양 읽히고,
 * 리포트를 여는 날짜에 따라 값이 달라진다. 그래서 두 표 모두 **이 경기의 킥오프
 * 시각까지**로 좁히고, 뺀 것은 이 경기 하나뿐이다.
 */
function standingsMoveOf(
  state: GameState,
  match: MatchRecord,
  ourSide: "home" | "away" | null,
): MatchReportView["standings"] {
  // 녹아웃은 표에 들어가지 않고(`countsInStandings`), 남의 경기에는 물을 순위가 없다
  const competitionId = match.competitionId;
  if (ourSide === null || competitionId === null) return null;
  if (match.stage !== "league") return null;
  const kickoff = { date: match.date, time: match.time };
  const playedBy = (m: MatchRecord) =>
    m.date < kickoff.date || (m.date === kickoff.date && m.time <= kickoff.time);
  const placeIn = (rows: readonly StandingRow[]) =>
    rows.findIndex((r) => r.teamId === state.userTeamId) + 1;
  const after = placeIn(computeStandings(state, competitionId, playedBy));
  const before = placeIn(
    computeStandings(state, competitionId, (m) => playedBy(m) && m.id !== match.id),
  );
  // 표에 우리 행이 없는 대회(국내 컵·미배정 대항전)는 순위를 말하지 않는다
  if (after === 0 || before === 0) return null;
  return { competition: competitionShortName(competitionId), before, after };
}

/**
 * 끝난 경기 한 장을 세운다 — 결과가 없으면 null.
 *
 * 진행 중인 경기는 여기서 만들지 않는다: 90분 동안 감독이 보는 것은 판세 화면
 * (`buildMatchView`)이고, 그 화면은 장부를 직접 읽는다.
 */
export function buildMatchReport(state: GameState, matchId: string): MatchReportView | null {
  const match = state.matches.find((m) => m.id === matchId);
  const result = match?.result;
  if (!match || !result) return null;

  const ourSide: "home" | "away" | null =
    match.homeTeamId === state.userTeamId
      ? "home"
      : match.awayTeamId === state.userTeamId
        ? "away"
        : null;
  const events = result.events ?? [];
  const stats = result.playerStats ?? {};
  const lineups = { home: result.homeLineup, away: result.awayLineup } as const;
  /**
   * **선발은 장부가 든다** — 킥오프에 뜬 명단이다 (`homeStarters` — people.md §5-2).
   * 사건 목록에서 「교체로 들어오지 않은 사람」으로 되짚는 것은 사건이 온전한 경기에만
   * 참이라, 사건을 남기지 않는 간이 시뮬의 경기는 벤치까지 선발로 읽힌다. 지위 대비
   * 출전을 재는 자와 리포트가 **같은 값**을 읽어야 감독이 본 선발과 라커룸이 센 선발이
   * 갈리지 않는다.
   */
  const starters = { home: result.homeStarters, away: result.awayStarters } as const;
  const teamIdOf = { home: match.homeTeamId, away: match.awayTeamId } as const;
  const sideOfPlayer = new Map<string, "home" | "away">();
  for (const side of ["home", "away"] as const) {
    for (const id of lineups[side]) sideOfPlayer.set(id, side);
  }

  const minutesOf = matchMinutesOf(events, result.aet === true);
  const countOf = (id: string, type: MatchEventType, slot = 0) =>
    events.filter((e) => e.type === type && e.actors[slot] === id).length;
  const players: MatchReportPlayerView[] = [];
  for (const side of ["home", "away"] as const) {
    for (const id of lineups[side]) {
      const p = playerById(state, id);
      const line = stats[id];
      const rating = result.ratings?.[id] ?? null;
      players.push({
        id,
        name: playerName(state, id),
        side,
        ours: teamIdOf[side] === state.userTeamId,
        squadNumber: p?.squadNumber ?? null,
        minutes: minutesOf(id),
        started: starters[side].includes(id),
        goals: countOf(id, "goal"),
        assists: countOf(id, "goal", 1),
        shots: line?.shots ?? 0,
        xg: roundTo(line?.xg ?? 0, 2),
        saves: line?.saves ?? 0,
        passes: line?.passes ?? 0,
        progressive: line?.progressive ?? 0,
        corners: line?.corners ?? 0,
        fouls: line?.fouls ?? 0,
        yellows: countOf(id, "yellow_card"),
        red: countOf(id, "red_card") > 0,
        rating,
        tone: rating === null ? null : ratingTone(rating),
        note: result.ratingNotes?.[id] ?? null,
      });
    }
  }
  /** 선발이 먼저, 그다음 오래 뛴 순 — 리포트를 위에서부터 읽으면 그게 그 경기의 열한 명이다 */
  players.sort(
    (a, b) =>
      (a.side === b.side ? 0 : a.side === "home" ? -1 : 1) ||
      Number(b.started) - Number(a.started) ||
      b.minutes - a.minutes ||
      a.id.localeCompare(b.id),
  );

  const sumOf = (side: "home" | "away", read: (p: MatchReportPlayerView) => number) =>
    players.reduce((sum, p) => (p.side === side ? sum + read(p) : sum), 0);
  const teamOf = (side: "home" | "away"): MatchReportTeamView => ({
    id: teamIdOf[side],
    name: teamNameIn(state, teamIdOf[side]),
    short: teamShortNameIn(state, teamIdOf[side]),
    colours: clubColoursOf(teamIdOf[side]),
    ours: teamIdOf[side] === state.userTeamId,
    goals: side === "home" ? result.homeGoals : result.awayGoals,
    // 팀 합계는 마감이 이미 적어 두었다
    shots: side === "home" ? result.homeShots : result.awayShots,
    xg: roundTo(side === "home" ? result.homeXg : result.awayXg, 2),
    expectedGoals: roundTo(
      side === "home" ? result.homeExpectedGoals : result.awayExpectedGoals,
      2,
    ),
    possession: roundTo(result.possession[side], 3),
    passes: sumOf(side, (p) => p.passes),
    progressive: sumOf(side, (p) => p.progressive),
    corners: sumOf(side, (p) => p.corners),
    fouls: sumOf(side, (p) => p.fouls),
    yellows: sumOf(side, (p) => p.yellows),
    reds: sumOf(side, (p) => (p.red ? 1 : 0)),
  });

  const timeline: MatchReportEventView[] =
    events.length === 0
      ? goalTimelineOf(state, result, ourSide)
      : events
          .filter(
            (e) =>
              TIMELINE_TYPES.has(e.type) || (e.type === "shot" && (e.xg ?? 0) >= BIG_CHANCE_XG),
          )
          .map((e) => ({
            minute: e.minute,
            type: e.type,
            side: e.team ?? null,
            ours: ourSide === null || !e.team ? null : e.team === ourSide,
            actors: e.actors.map((id) => playerName(state, id)),
            origin: e.shotOrigin ?? null,
            xg: e.xg === undefined ? null : roundTo(e.xg, 2),
            causes: e.causes.map((cause) => eventCauseText(cause, (id) => playerName(state, id))),
            subCause: e.subCause ? subCauseText(e.subCause) : null,
          }));

  const kicks = result.penalties?.kicks ?? [];
  const motm = motmOf(players);
  return {
    standings: standingsMoveOf(state, match, ourSide),
    matchId: match.id,
    date: match.date,
    label: competitionLabel(match.competitionId, match.stage, match.round),
    competition: competitionShortName(match.competitionId),
    stage: competitionStageLabel(match.competitionId, match.stage, match.round),
    home: teamOf("home"),
    away: teamOf("away"),
    venue: ourSide === null ? null : match.neutral ? "neutral" : ourSide,
    outcome: ourSide === null ? null : outcomeFor(match, state.userTeamId),
    aet: result.aet === true,
    penalties: result.penalties
      ? {
          // 킥이 원본이라 합계도 거기서 센다 — 킥 없는 옛 승부차기만 저장된 합계를 쓴다
          ...(kicks.length > 0
            ? shootoutTally(kicks)
            : { home: result.penalties.home, away: result.penalties.away }),
          kicks: kicks.map((k) => ({
            round: k.round,
            side: k.team,
            team: teamShortNameIn(state, teamIdOf[k.team]),
            taker: playerName(state, k.taker),
            keeper: k.keeper ? playerName(state, k.keeper) : null,
            outcome: k.outcome,
            ours: teamIdOf[k.team] === state.userTeamId,
          })),
        }
      : null,
    timeline,
    players,
    motm: motm ? { id: motm.id, name: motm.name, rating: motm.rating ?? 0 } : null,
    hasDetail: events.length > 0,
  };
}
