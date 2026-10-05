import {
  playerOverall,
  type TransitionMode,
  type TacklingLevel,
  type KeeperDistribution,
  type ClubColours,
  type ShootoutOutcome,
  type MatchEvent,
  type MatchSide,
  type MatchStatLine,
  ageOf,
  seasonRating,
  eventCausesText,
  shootoutTally,
} from "@gaffer/domain";
import { type ConditionRead, observationOf } from "../players/observation";
import {
  type MatchLedgerState,
  sideStatLine,
  liveInputOf,
  type LineupSlot,
  matchFactor,
  GASSED_CONDITION,
  subLimitsOf,
  possessionOf,
  liveDigest,
} from "@gaffer/sim";
import {
  type GameState,
  playerName,
  seasonStatOf,
  clubProfileIn,
  teamNameIn,
  teamShortNameIn,
  playerById,
} from "../core/state";
import { conditionShown } from "../players/observation-view";
import { lineupSlotsOf, slotsFor, pointsSeenBy } from "./match-flow";
import { competitionShortName, competitionStageLabel } from "../core/catalog/cup-catalog";
import { clubColoursOf } from "../core/club-colours";

/**
 * 리포트의 소수는 **여기서 자른다** — 읽는 곳이 셋이라(화면 둘 · 조회 하나) 각자
 * 반올림하면 같은 경기의 xG가 세 숫자로 보인다. xG는 두 자리, 점유는 세 자리다.
 */
export const roundTo = (value: number, digits: number): number => {
  const unit = 10 ** digits;
  return Math.round(value * unit) / unit;
};

/** 경기 화면의 전술 카드가 6축 위에 더 싣는 것 — 지시 적용률·전환 표식 */
interface MatchTacticsExtra {
  /** 지시 적용률 0.45~1 (match.md §2) */
  uptake: number;
  /** 그 벤치가 이 경기에서 마지막으로 판을 옮긴 정지점 — 장부의 `tactical_shift`에서 파생 */
  shift: { minute: number; note: string } | null;
}

/** 팀 전술 (TACTICS) — 스쿼드 탭에서 보고 편집한다 */
export interface TacticsView {
  formation: string;
  /** 1(수비적) ~ 5(공격적) */
  mentality: number;
  defensiveLine: number;
  pressing: number;
  tempo: number;
  /** 1(중앙) ~ 5(측면) */
  width: number;
  /** 1(짧게) ~ 5(길게) */
  passStyle: number;
  /**
   * ── 갈래 넷 — 눈금이 아니라 둘 중 하나다 (→ docs/match/match.md §1.2).
   * **감독이 그 갈래에 서지 않았으면 없다** — 중립인지는 화면이 다시 재지 않고
   * `tacticToggleValue`가 답한다.
   */
  transition?: TransitionMode | null;
  offsideTrap?: boolean;
  tackling?: TacklingLevel;
  keeperDistribution?: KeeperDistribution | null;
}

/**
 * 그 선수가 **이 경기에서 한 일** — 장부 사건(`ledger.events`)에서 파생한다.
 *
 * 감독이 중계를 보며 묻는 것은 셋이다: 누가 넣었나, 누가 위험한가(경고),
 * 누가 계속 때리는데 안 들어가나. 저장하지 않는다 — 사건 목록이 원본이다.
 */
interface MatchTally {
  goals: number;
  assists: number;
  shots: number;
  saves: number;
  yellows: number;
  red: boolean;
  /** 주고받은 패스 — 사건이 아니라 구간마다 쌓이는 양 (`MatchStatLine`) */
  passes: number;
  /** 그중 전진 패스 */
  progressive: number;
  /** 그 선수가 만든 기대 득점의 합 — 슛의 질이다 */
  xg: number;
  /** 실제 슈터의 결정력을 반영한 골 확률 합. */
  scoringExpectation: number;
  /** 그 선수가 찬 코너 — 죽은 공을 누가 올리는지가 여기 남는다 (match.md §4) */
  corners: number;
  /** 그 선수가 범한 파울 */
  fouls: number;
}

/** 경기 중 한 선수 — 지금 내는 전력과 남은 다리 */
interface MatchPlayerView {
  id: string;
  name: string;
  /** 현재 소속팀 등번호. 아직 배정되지 않았으면 null */
  squadNumber: number | null;
  /** 나이 — 안개를 지나지 않는다 (등번호와 같이 90분 동안 보이는 사실) */
  age: number;
  /** 이번 시즌 평점, 출전이 없으면 null — 공개 기록이라 상대도 같은 값이다 */
  seasonRating: number | null;
  position: string;
  /** 경기가 계산에 사용한 실제 전술판 좌표. */
  point?: import("@gaffer/domain").BoardPoint;
  /**
   * 이 자리에서 지금 내는 전력 (상태·적응도 반영) — **정수로 반올림해 넘긴다.**
   * 코어는 소수로 셈하지만 감독이 89.7과 89.6을 견줄 일은 없고, 명단의 OVR·
   * `slotOverall`이 전부 정수라 소수 한 자리만 다른 눈금을 쓰면 같은 값으로
   * 안 읽힌다.
   *
   * **상대 선수는 안개를 지난 값**이다 — 명단 화면의 OVR과 **같은 채널**
   * (`observationOf`의 `overallOffset`)을 쓴다. 채널이 갈리면 같은 상대 선수가
   * 스쿼드 화면과 경기 화면에서 다른 숫자로 보인다.
   */
  effective: number;
  /** 그 전력의 오차 폭 (±) — 0이면 정확히 아는 선수다 (우리 선수) */
  margin: number;
  /**
   * 지금 남은 체력 0~100, 높을수록 좋다 (저장값 − 경기 중 소모).
   * **상대 선수는 감독이 읽은 값**이다 — 참값은 `low~high` 안에 있다 (observation.ts).
   */
  condition: ConditionRead;
  /** 다리가 멈췄나 — 이 자리에 구멍이 나 있다 (stamina.ts). 상대는 읽은 값 기준 */
  gassed: boolean;
  /** 우리 팀 선수인가 — 교체 대상을 가린다 */
  ours: boolean;
  /** 이 경기에서 한 일 — 사건 목록의 파생 */
  tally: MatchTally;
}

/** 선발 평균 전력 — 그라운드 위 열한 명의 평균(정수). 빈 명단이면 0 */
function xiRatingOf(players: readonly MatchPlayerView[]): number {
  if (players.length === 0) return 0;
  return Math.round(players.reduce((sum, p) => sum + p.effective, 0) / players.length);
}

/** 팀 합계 — 선수별 `tally`를 더한다. 경고·퇴장은 사람 단위라 세지 않는다 */
function tallyTotal(players: readonly MatchPlayerView[]): MatchTally {
  return players.reduce<MatchTally>(
    (acc, p) => ({
      goals: acc.goals + p.tally.goals,
      assists: acc.assists + p.tally.assists,
      shots: acc.shots + p.tally.shots,
      saves: acc.saves + p.tally.saves,
      yellows: acc.yellows + p.tally.yellows,
      red: acc.red || p.tally.red,
      passes: acc.passes + p.tally.passes,
      progressive: acc.progressive + p.tally.progressive,
      xg: acc.xg + p.tally.xg,
      scoringExpectation: acc.scoringExpectation + p.tally.scoringExpectation,
      corners: acc.corners + p.tally.corners,
      fouls: acc.fouls + p.tally.fouls,
    }),
    {
      goals: 0,
      assists: 0,
      shots: 0,
      saves: 0,
      yellows: 0,
      red: false,
      passes: 0,
      progressive: 0,
      xg: 0,
      scoringExpectation: 0,
      corners: 0,
      fouls: 0,
    },
  );
}

/**
 * 경기 화면 — **중계 채팅 밖에서도 판세가 보여야 한다.**
 *
 * 채팅은 흘러가고, 감독은 "지금 어디가 밀리는지 · 무엇이 통하고 있는지 · 누구를
 * 빼야 하는지"를 한눈에 봐야 한다. 전부 이미 코어가 계산해 둔 값이고 여기서는
 * 화면이 읽을 모양으로만 옮긴다.
 */
export interface MatchView {
  /**
   * 실시간 경기의 확정 상태 — 클라이언트가 이어받는 출발점이다 (live-match.md §8).
   * `digest`는 서버가 확정한 상태의 것이라 클라이언트는 자기 상태와 견줘 어긋남을 안다.
   */
  live: {
    tick: number;
    seconds: number;
    interval: boolean;
    finished: boolean;
    /** 감독이 걸어 둔 교체 — 다음 중단에 실행된다 */
    pendingSubs: number;
    digest: string;
  };
  /** 어느 경기인가 (`MATCH.id`) — 화면이 종료 시점을 잡고 기록을 찾는 데 쓴다 */
  matchId: string;
  competition: string;
  stage: string;
  /**
   * 어디서 치르나 — **홈 팀의 구장**(`clubProfileIn`). 킥오프 게이트의 데이트라인이
   * 「대회 · 단계 · 경기장 · 날짜」로 읽는 값이다 (match.md §9.1). 미등재 클럽은 `null`이다.
   */
  stadium: string | null;
  /**
   * `id`는 문장(`crestOf`)과 구단 색의 열쇠다. `colours`는 카탈로그의 공식 색 — 화면은
   * 엔진을 값으로 못 읽으므로 여기 실려 간다 (web/design-system.md §2).
   */
  home: { id: string; name: string; short: string; ours: boolean; colours?: ClubColours };
  away: { id: string; name: string; short: string; ours: boolean; colours?: ClubColours };
  score: { home: number; away: number };
  /** 규정분 — 추가시간이면 `added`가 0보다 크다 (`45+2′`) */
  minute: number;
  added: number;
  /** "전반" · "후반" · "종료" */
  phase: string;
  /**
   * 아직 경기장에 들어서기 전인가 — `start_match`는 준비만 하고 **감독이 문을 지날 때**
   * 화면이 경기로 넘어간다. 화면은 이 값으로 입장 확인 창을 세운다.
   */
  beforeKickoff: boolean;
  /**
   * 득점 기록 — **스코어 옆에 이름이 서야 한다.**
   */
  goals: {
    minute: number;
    side: "home" | "away";
    scorer: string;
    assist: string | null;
    /** 우리 골인가 — 색으로 가른다 */
    ours: boolean;
  }[];
  /**
   * **누적 xG의 계단선** — 90분 안에서 감독이 읽는 유일한 xG (match.md §9). 슛 하나마다
   * 한 점이고 값은 그 시각까지의 **누적**이다. 장부의 슛·골 사건이 그 장면의 xG를 싣고
   * 있어 여기서 시간순으로 접기만 한다.
   */
  xgTimeline: { minute: number; home: number; away: number }[];
  /** 팀 통계 — 장부 `stats`의 합과 점유 (match.md §9). 상대 것도 같은 열이다 */
  stats: { home: MatchTeamStatsView; away: MatchTeamStatsView };

  points: MatchPointView[];
  /**
   * 양팀 전술 6축 + 지시 적용률. `shift`는 그 팀 벤치가 **이 경기에서 마지막으로 판을
   * 옮긴 정지점** — 장부의 `tactical_shift` 사건에서 파생한다 (match.md §4·§9).
   */
  tactics: {
    home: TacticsView & MatchTacticsExtra;
    away: TacticsView & MatchTacticsExtra;
  };
  onPitch: { home: MatchPlayerView[]; away: MatchPlayerView[] };
  bench: { home: MatchPlayerView[]; away: MatchPlayerView[] };
  /**
   * 선발 평균 전력 — 그라운드 위 열한 명의 `effective` 평균(정수).
   * 상대 쪽은 안개를 지난 값이라 **화면이 다시 평균 내면** 우리 쪽과 다른 자로 잰 값이 된다.
   */
  xiRating: { home: number; away: number };
  /** 팀 합계 — 선수별 `tally`의 합 */
  totals: { home: MatchTally; away: MatchTally };
  /**
   * 교체 사용량과 **그 경기의 한도** — 한도는 장부의 `subLimitsOf`가 정한다
   * (연장 6인/4회 · 친선 9인/3회).
   */
  subs: {
    home: { used: number; windows: number };
    away: { used: number; windows: number };
    limit: { subs: number; windows: number };
  };
  sentOff: string[];
  /** 승부차기 — 120분이 승부를 못 가른 경기에만 선다. 합계는 킥 목록에서 다시 센다 */
  shootout: { tally: { home: number; away: number }; kicks: MatchShootoutKickView[] } | null;
}

/** 한 팀의 경기 통계 — 장부 `stats`의 합 (match.md §9). 점유는 공을 가졌던 시간의 몫(0~1) */
interface MatchTeamStatsView {
  possession: number;
  shots: number;
  shotsOnTarget: number;
  xg: number;
  scoringExpectation: number;
  passes: number;
  passesCompleted: number;
  progressive: number;
  tackles: number;
  tacklesWon: number;
  interceptions: number;
  fouls: number;
  corners: number;
  offsides: number;
  /** 뛴 거리 (km) */
  distanceKm: number;
  sprints: number;
}

interface MatchPointView {
  id: string;
  text: string;
  importance: 1 | 2 | 3;
  /** 우리 편에 이로운 판독인가 — 걸린 시트가 없으면 null */
  ours: boolean | null;
}

/**
 * 승부차기 한 발 — **찬 순서 그대로** 화면에 남는다 (match.md §8).
 *
 * 감독이 다음 키커를 정하려면 누가 찼고 들어갔는지 막혔는지가 보여야 한다.
 * 성공 확률은 넘기지 않는다 — 화면이 입에 담지 않는 게임 내부 수치다.
 */
export interface MatchShootoutKickView {
  round: number;
  side: "home" | "away";
  /** 팀 약칭 — 우리 편 색만으로는 두 줄이 갈리지 않는다 */
  team: string;
  taker: string;
  /** 막아선 골키퍼 — 경기를 끝낸 열한 명에 골키퍼가 없으면 빈다 */
  keeper: string | null;
  outcome: ShootoutOutcome;
  ours: boolean;
}

const MATCH_PHASE_KO: Record<string, string> = {
  first_half: "전반",
  second_half: "후반",
  extra_first: "연장 전반",
  extra_second: "연장 후반",
  finished: "종료",
};

/**
 * 경기 화면 — 코어가 이미 계산한 값을 화면이 읽을 모양으로 옮긴다.
 *
 * 채팅은 흘러가지만 판세는 남아 있어야 한다. 감독이 정지점에서 보고 싶은 건
 * "어디가 밀리나 · 무엇이 통하나 · 누구를 빼야 하나" 셋이다.
 */
/**
 * 누적 xG의 계단선 — **장부가 원본이다** (match.md §8).
 *
 * 슛과 골 사건이 각자 그 장면의 xG를 싣고 있으므로(`MatchEvent.xg`) 시간순으로
 * 누적하면 그것이 곧 계단선이다. 값을 싣지 않는 사건(슛이 아닌 것)은 지나가고, 아무
 * 사건도 값을 싣지 않으면 빈 배열이 나가 화면이 자리를 비운다.
 *
 * 소수는 둘째 자리까지 — 리포트의 xG와 같은 자다(match.md §8). 자리수가 갈리면 같은
 * 경기의 xG가 화면마다 다른 숫자로 보인다.
 */
function xgTimelineOf(events: readonly MatchEvent[]): MatchView["xgTimeline"] {
  const points: MatchView["xgTimeline"] = [];
  let home = 0;
  let away = 0;
  for (const event of events) {
    if (event.xg === undefined) continue;
    if (event.team === "away") away += event.xg;
    else home += event.xg;
    points.push({ minute: event.minute, home: roundTo(home, 2), away: roundTo(away, 2) });
  }
  return points;
}

/** 한 팀의 통계 — 그 편이 그라운드를 밟은 사람 전원의 줄을 합친다 */
function matchTeamStatsOf(
  ledger: MatchLedgerState,
  side: MatchSide,
  possession: number,
): MatchTeamStatsView {
  const line = sideStatLine(ledger, side);
  const sum = (read: (line: MatchStatLine) => number) => read(line);
  return {
    possession: roundTo(possession, 3),
    shots: sum((l) => l.shots),
    shotsOnTarget: sum((l) => l.shotsOnTarget),
    xg: roundTo(
      sum((l) => l.xg),
      2,
    ),
    scoringExpectation: roundTo(
      sum((l) => l.scoringExpectation),
      2,
    ),
    passes: sum((l) => l.passes),
    passesCompleted: sum((l) => l.passesCompleted),
    progressive: sum((l) => l.progressive),
    tackles: sum((l) => l.tackles),
    tacklesWon: sum((l) => l.tacklesWon),
    interceptions: sum((l) => l.interceptions),
    fouls: sum((l) => l.fouls),
    corners: sum((l) => l.corners),
    offsides: sum((l) => l.offsides),
    distanceKm: roundTo(sum((l) => l.distance) / 1000, 1),
    sprints: sum((l) => l.sprints),
  };
}

export function buildMatchView(state: GameState): MatchView | null {
  const pending = state.pendingMatch;
  if (!pending || state.phase !== "match") return null;
  const match = state.matches.find((m) => m.id === pending.matchId);
  if (!match) return null;
  const { live } = pending;
  const ledger = live.ledger;
  const shootout = pending.shootout;
  /** 이 틱의 입력 — 시트가 접힌 결과(걸린 줄·버려진 줄)와 지시 적용률이 여기 있다 */
  const input = liveInputOf(live);
  const teamIdOf = { home: match.homeTeamId, away: match.awayTeamId } as const;
  const ourSide: MatchSide = match.homeTeamId === state.userTeamId ? "home" : "away";
  const nameOf = (id: string) => playerName(state, id);

  /**
   * 선수별 기록 — 사건 목록을 한 번 훑어 접는다. 저장하지 않는 이유는 원본이
   * `ledger.events`이기 때문이다: 두 벌로 두면 조용히 갈린다.
   */
  const tallies = new Map<string, MatchTally>();
  const emptyTally = (): MatchTally => ({
    goals: 0,
    assists: 0,
    shots: 0,
    saves: 0,
    yellows: 0,
    red: false,
    passes: 0,
    progressive: 0,
    xg: 0,
    scoringExpectation: 0,
    corners: 0,
    fouls: 0,
  });
  const tallyOf = (id: string): MatchTally => {
    const found = tallies.get(id);
    if (found) return found;
    const fresh = emptyTally();
    tallies.set(id, fresh);
    return fresh;
  };
  /** 슛·선방·패스·xg는 **누적 기록**이 원본이다 (`ledger.stats`) — 사건에서 오는 건 골·도움·카드뿐 */
  for (const [id, line] of Object.entries(ledger.stats)) {
    const t = tallyOf(id);
    t.shots = line.shots;
    t.saves = line.saves;
    t.passes = line.passes;
    t.progressive = line.progressive;
    t.xg = line.xg;
    t.scoringExpectation = line.scoringExpectation;
    t.corners = line.corners;
    t.fouls = line.fouls;
  }
  for (const event of ledger.events) {
    const [first, second] = event.actors;
    switch (event.type) {
      case "goal":
        if (first) tallyOf(first).goals += 1;
        if (second) tallyOf(second).assists += 1;
        break;
      case "yellow_card":
        if (first) tallyOf(first).yellows += 1;
        break;
      case "red_card":
        if (first) tallyOf(first).red = true;
        break;
      default:
        break;
    }
  }
  /** 말의 지금 체력 — 그라운드를 떠난 사람은 마지막 값, 아직 안 들어온 사람은 출발값 */
  const liveCondition = new Map(live.state.players.map((p) => [p.id, p.condition] as const));
  const conditionNow = (slot: LineupSlot): { start: number; now: number } => {
    const id = slot.player.id;
    const start = live.startCondition[id] ?? slot.player.state.condition;
    const now = liveCondition.get(id) ?? live.leftCondition[id] ?? start;
    return { start, now };
  };
  const player = (slot: LineupSlot, teamId: string): MatchPlayerView => {
    const p = slot.player;
    const { start, now } = conditionNow(slot);
    // 다리는 눈으로 읽는다 — 코어는 참값으로 계산하고 여기서만 흐려진다
    const condition = conditionShown(state, p.id, start, {
      drain: Math.max(0, start - now),
      matchId: match.id,
    });
    /**
     * 전력도 안개를 지난다 — **명단 화면과 같은 채널**(`observationOf`)이라 같은 상대
     * 선수가 두 화면에서 다른 숫자로 보이지 않는다. 우리 선수는 오프셋 0이라 참값 그대로다.
     */
    const observation = observationOf(state, p.id);
    const effective = Math.round(playerOverall(p) * matchFactor(slot, now));
    return {
      id: p.id,
      name: p.name,
      squadNumber: p.squadNumber ?? null,
      age: ageOf(p.birthdate, state.date),
      seasonRating: seasonRating(seasonStatOf(state, p.id)),
      position: slot.position,
      ...(slot.point ? { point: slot.point } : {}),
      effective: Math.max(1, effective + observation.overallOffset),
      margin: observation.margin,
      condition,
      gassed: condition.value <= GASSED_CONDITION,
      ours: teamId === state.userTeamId,
      tally: tallies.get(p.id) ?? emptyTally(),
    };
  };
  const rowsOf = (slots: readonly LineupSlot[], teamId: string) =>
    slots.map((s) => player(s, teamId));
  const onPitch = {
    home: rowsOf(lineupSlotsOf(state, live.slots.home), match.homeTeamId),
    away: rowsOf(lineupSlotsOf(state, live.slots.away), match.awayTeamId),
  };
  const benchOf = (side: MatchSide) =>
    rowsOf(
      lineupSlotsOf(state, slotsFor(state, teamIdOf[side], ledger[side].bench, false)),
      teamIdOf[side],
    );

  const subLimits = subLimitsOf(ledger.phase, ledger.friendly);

  /**
   * **판을 옮긴 정지점의 표식** — 장부의 마지막 `tactical_shift`에서 파생한다
   * (match.md §4·§9). 화면이 따로 기억하는 상태가 아니라 사건이 원본이므로, 표식과
   * 중계가 같은 한 줄에서 나온다.
   */
  const shiftOfSide = (side: MatchSide) => {
    const found = [...ledger.events]
      .reverse()
      .find((e) => e.type === "tactical_shift" && e.team === side);
    return found ? { minute: found.minute, note: eventCausesText(found.causes, nameOf) } : null;
  };
  const tacticsOfSide = (side: MatchSide): TacticsView & MatchTacticsExtra => ({
    ...live.tactics[side],
    uptake: input[side].uptake,
    shift: shiftOfSide(side),
  });

  const points: MatchPointView[] = pointsSeenBy(state).map((point) => {
    const applied = input.sheet.applied.filter((tag) => tag.pointId === point.id);
    const favours = applied.map((tag) => tag.favours === ourSide);
    return {
      id: point.id,
      text: point.text,
      importance: point.importance,
      ours:
        favours.length === 0
          ? null
          : favours.every(Boolean)
            ? true
            : favours.every((f) => !f)
              ? false
              : null,
    };
  });

  const possession = possessionOf(live);
  return {
    live: {
      tick: live.state.tick,
      seconds: live.state.seconds,
      interval: live.state.interval,
      finished: ledger.phase === "finished",
      pendingSubs: live.pendingSubs.length,
      digest: liveDigest(live),
    },
    matchId: match.id,
    competition: competitionShortName(match.competitionId),
    stage: competitionStageLabel(match.competitionId, match.stage, match.round),
    stadium: clubProfileIn(state, match.homeTeamId).stadium || null,
    home: {
      id: match.homeTeamId,
      name: teamNameIn(state, match.homeTeamId),
      short: teamShortNameIn(state, match.homeTeamId),
      ours: match.homeTeamId === state.userTeamId,
      colours: clubColoursOf(match.homeTeamId),
    },
    away: {
      id: match.awayTeamId,
      name: teamNameIn(state, match.awayTeamId),
      short: teamShortNameIn(state, match.awayTeamId),
      ours: match.awayTeamId === state.userTeamId,
      colours: clubColoursOf(match.awayTeamId),
    },
    score: { ...ledger.score },
    minute: ledger.minute,
    added: ledger.added,
    // 승부차기는 장부가 `finished`인 채로 진행된다 — "종료"로 적으면 화면이 끝난
    // 경기를 말하고, 감독은 아직 키커를 세우는 중이다
    phase: shootout ? "승부차기" : (MATCH_PHASE_KO[ledger.phase] ?? ledger.phase),
    beforeKickoff: !pending.entered,
    goals: ledger.events
      .filter((e) => e.type === "goal")
      .map((e) => {
        const side = e.team === "away" ? ("away" as const) : ("home" as const);
        const teamId = teamIdOf[side];
        const name = (id: string | undefined) => (id ? (playerById(state, id)?.name ?? id) : null);
        return {
          minute: e.minute,
          side,
          scorer: name(e.actors[0]) ?? "미상",
          assist: name(e.actors[1]),
          ours: teamId === state.userTeamId,
        };
      }),
    xgTimeline: xgTimelineOf(ledger.events),
    stats: {
      home: matchTeamStatsOf(ledger, "home", possession.home),
      away: matchTeamStatsOf(ledger, "away", possession.away),
    },
    points,
    tactics: { home: tacticsOfSide("home"), away: tacticsOfSide("away") },
    onPitch,
    xiRating: { home: xiRatingOf(onPitch.home), away: xiRatingOf(onPitch.away) },
    totals: { home: tallyTotal(onPitch.home), away: tallyTotal(onPitch.away) },
    bench: { home: benchOf("home"), away: benchOf("away") },
    subs: {
      home: { used: ledger.home.subsUsed, windows: ledger.home.subWindows },
      away: { used: ledger.away.subsUsed, windows: ledger.away.subWindows },
      limit: { subs: subLimits.maxSubs, windows: subLimits.maxSubWindows },
    },
    sentOff: ledger.sentOff.map((id) => playerName(state, id)),
    shootout: shootout
      ? {
          tally: shootoutTally(shootout.kicks),
          kicks: shootout.kicks.map((kick) => {
            const teamId = kick.team === "home" ? match.homeTeamId : match.awayTeamId;
            return {
              round: kick.round,
              side: kick.team,
              team: teamShortNameIn(state, teamId),
              taker: playerName(state, kick.taker),
              keeper: kick.keeper ? playerName(state, kick.keeper) : null,
              outcome: kick.outcome,
              ours: teamId === state.userTeamId,
            };
          }),
        }
      : null,
  };
}
