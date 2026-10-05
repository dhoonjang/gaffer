import {
  type LeaderboardKey,
  type MatchRecord,
  type MatchStage,
  type OutcomeBasis,
  type SeasonMatchRow,
  type SeasonTableRow,
  type Trophy,
  leaderboardTitle,
  josa,
  josaOf,
  isReserveMatch,
  MatchStageSchema,
  parseScorerEntry,
} from "@gaffer/domain";
import { outcomeFor, outcomeLabel } from "../views/attention";
import { dayOfWeek } from "../../core/dates";
import {
  competitionLabel,
  competitionName,
  competitionShortName,
  isCup,
  stageLabel,
} from "../../core/catalog/cup-catalog";
import {
  DOMESTIC_STAGES,
  domesticStageLabel,
  isDomesticCup,
} from "../../core/catalog/domestic-cup-catalog";
import { competitionHint, norm, resolveCompetitionId } from "../../team/player-pool";
import { domesticStageMatches } from "../../season/domestic-cup";
import { leagueOfTeamIn } from "../../core/league-membership";
import { computeStandings, standingsBySplit, type StandingSplitKey } from "../../season/standings";
import {
  LEADERBOARD_LIMIT,
  leaderboardOf,
  leaderboardsOf,
  teamStatsOf,
  type LeaderRow,
} from "../../season/leaderboard";
import { leagueTableOf, pastSeasonsOf, seasonHistoryOf, seasonLabelOf } from "../../season/records";
import { playerName, teamNameIn, teamShortNameIn, type GameState } from "../../core/state";
import { VENUE_KO } from "./match-report";
import { LookupResult, EVERY_TEAM, resolveTeam } from "./resolve";

// ── 리그 (순위·일정) ────────────────────────────────────

interface LeagueViewInput {
  view: "standings" | "fixtures" | "leaders";
  /**
   * 기준 팀 — 생략하면 우리 팀. "all"이면 대회 전체 경기를 본다.
   * standings에서는 그 팀이 속한 리그의 순위표를 뜻한다.
   */
  team?: string;
  /** fixtures 전용 — 상대 팀. 주면 그 팀과의 맞대결만 (전적 요약 포함) */
  opponent?: string;
  /** 대회 이름·약어·id — 생략하면 모든 대회 (team이 "all"이면 우리 리그) */
  competition?: string;
  /**
   * 지나간 시즌 — 생략하면 지금 시즌이다. 순위표는 그 시즌의 **최종 표**를, 일정은
   * 결산 스냅샷에 남은 **감독 팀의 경기**를, 개인 순위는 그 시즌의 표를 낸다
   * (game-state.md §3.3: 지난 시즌은 경기가 아니라 표로 남고, 경기는 감독 팀의 것만
   * 남는다 — 그래서 개인 순위의 팀 열은 지나간 시즌에 서지 않는다).
   */
  season?: number;
  /** 지난 경기만 / 예정만 / 둘 다 (기본 both) */
  when?: "past" | "upcoming" | "both";
  /** 날짜 범위 (YYYY-MM-DD, 포함) */
  from?: string;
  to?: string;
  /** 라운드 (리그는 R번호, 녹아웃은 차수) */
  round?: number;
  /** 방향별 최대 경기 수 (기본 5, 맞대결·대회 전체는 10) · leaders에서는 표당 줄 수 */
  count?: number;
  /**
   * standings 전용 — 합계 표인가 홈 표인가 원정 표인가 (기본 `all`).
   * 행은 같고 **순서만 다르다** (competition.md §2).
   */
  split?: StandingSplitKey;
  /** leaders 전용 — 한 축만 보기. 생략하면 다섯 축 전부 */
  key?: LeaderboardKey;
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

export function dateLabel(date: string): string {
  return `${date}(${WEEKDAY[dayOfWeek(date)]})`;
}

/**
 * "2026-27 시즌 (시즌 1)" — 날짜를 묻는 답에 시즌 번호만 주면 연도를 지어내게 된다.
 * 연도 표기는 `seasonLabelOf`가 갖는다 (역대 표와 같은 눈금).
 */
export function seasonLabel(season: number): string {
  return `${seasonLabelOf(season)} 시즌 (시즌 ${season})`;
}

/** 대회·단계 태그 — "EPL R7", "UCL 8강 1차전", "친선" */
export function competitionTag(m: MatchRecord): string {
  return competitionLabel(m.competitionId, m.stage, m.round);
}

/** 기준 팀 시점의 승패 — 정규시간이 같으면 승부차기로 갈린다 */
function scorerNote(state: GameState, m: MatchRecord): string {
  const scorers = m.result?.scorers ?? [];
  if (scorers.length === 0) return "";
  const minutes = m.result?.goalMinutes ?? [];
  const named = scorers.map((entry, i) => {
    const goal = parseScorerEntry(entry);
    const team = goal.side === "home" ? m.homeTeamId : goal.side === "away" ? m.awayTeamId : null;
    const at = minutes[i] !== undefined ? ` ${minutes[i]}′` : "";
    return `${playerName(state, goal.playerId)}${at}${team ? `(${teamShortNameIn(state, team)})` : ""}`;
  });
  return ` · 득점 ${named.join(", ")}`;
}

/**
 * 슛·xG 한 마디 — **스코어만 남으면 진 경기가 다 같아 보인다** (match.md §8).
 * 슛 3·xG 0.4로 진 경기와 슛 18·xG 2.3으로 진 경기가 달력에서 같은 "1-2 패"였다.
 */
export function shotNote(m: MatchRecord): string {
  const r = m.result;
  if (!r) return "";
  return ` · 슛 ${r.homeShots}-${r.awayShots} · xG ${r.homeXg.toFixed(2)}-${r.awayXg.toFixed(2)}`;
}

/**
 * 경기 한 줄. `teamId`가 있으면 그 팀 시점(홈/원정·승패), null이면 중립 서술.
 * `detail`이면 슛·xG와 득점자까지 — 결과를 묻는 질문엔 스코어만으론 부족하다.
 */
function matchLine(
  state: GameState,
  m: MatchRecord,
  teamId: string | null,
  detail: boolean,
): string {
  const when = `${dateLabel(m.date)}${m.time ? ` ${m.time}` : ""}`;
  const tag = competitionTag(m);
  if (!m.result) {
    const side =
      teamId === null ? "" : m.neutral ? "중립 " : m.homeTeamId === teamId ? "홈 " : "원정 ";
    const versus =
      teamId === null
        ? `${teamNameIn(state, m.homeTeamId)} vs ${teamNameIn(state, m.awayTeamId)}`
        : `vs ${teamNameIn(state, m.homeTeamId === teamId ? m.awayTeamId : m.homeTeamId)}`;
    return `  예정 ${when} ${tag} ${side}${versus}`;
  }
  const pens = m.result.penalties
    ? ` (승부차기 ${m.result.penalties.home}-${m.result.penalties.away})`
    : "";
  const score =
    `${teamShortNameIn(state, m.homeTeamId)} ${m.result.homeGoals}-${m.result.awayGoals} ` +
    `${teamShortNameIn(state, m.awayTeamId)}${pens}`;
  const side = teamId === null ? "" : ` ${m.homeTeamId === teamId ? "홈" : "원정"}`;
  const mark = teamId === null ? "" : ` ${outcomeLabel(outcomeFor(m, teamId))}`;
  return (
    `  지난 ${when} ${tag}${side} ${score}${mark}` +
    `${detail ? `${shotNote(m)}${scorerNote(state, m)}` : ""}`
  );
}

/**
 * 국내 컵 대진표 — 순위표를 대신한다.
 * 아직 안 열린 라운드는 없는 것이고, 우리 대진은 화살표로 표시한다.
 */
function cupBracketView(state: GameState, cupId: string): LookupResult {
  const lines: string[] = [];
  for (const stage of DOMESTIC_STAGES) {
    const matches = domesticStageMatches(state, cupId, stage);
    if (matches.length === 0) continue;
    lines.push(`· ${domesticStageLabel(cupId, stage)}`);
    for (const m of matches) {
      const ours = m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId;
      const pens = m.result?.penalties;
      const score = m.result
        ? `${m.result.homeGoals}-${m.result.awayGoals}${pens ? ` (승부차기 ${pens.home}-${pens.away})` : ""}`
        : "예정";
      lines.push(
        `  ${m.date} ${teamShortNameIn(state, m.homeTeamId)} ${score} ${teamShortNameIn(state, m.awayTeamId)}` +
          `${ours ? " ←우리" : ""}`,
      );
    }
  }
  if (lines.length === 0) {
    return { ok: true, message: `${josa(competitionName(cupId), "은/는")} 아직 추첨 전입니다` };
  }
  return {
    ok: true,
    message: [
      `[${competitionName(cupId)} 대진] ${seasonLabel(state.season)} · ${state.date}`,
      ...lines,
    ].join("\n"),
  };
}

/** 그 시즌 그 팀이 뛴 리그 — 결산 스냅샷의 표가 답한다. 모르면 null */
export function leagueOfTeamInSeason(
  state: GameState,
  season: number,
  teamId: string,
): string | null {
  const snapshot = seasonHistoryOf(state, season);
  return snapshot?.leagues.find((l) => l.rows.some((r) => r.teamId === teamId))?.leagueId ?? null;
}

/**
 * 지나간 시즌의 순위표 한 행 (game-state.md §3.3).
 */
function historyTableRow(
  state: GameState,
  row: SeasonTableRow,
  rank: number,
  mineTeamId?: string,
): string {
  const mark = row.teamId === mineTeamId ? " ←우리" : "";
  const head = `${String(rank).padStart(2)} ${teamNameIn(state, row.teamId)}`;
  const r = row.record;
  const diff = r.goalsFor - r.goalsAgainst;
  return (
    `${head} ${r.played}경기 ${r.wins}승 ${r.draws}무 ${r.losses}패 ` +
    `${r.points}점 (${diff >= 0 ? "+" : ""}${diff})${mark}`
  );
}

/** 그 시즌 그 대회의 트로피 — 표가 없는 녹아웃 대회는 이 원장이 답한다 (§3.3) */
export function trophyOf(state: GameState, season: number, competitionId: string): Trophy | null {
  return (
    state.trophies.find((t) => t.season === season && t.competitionId === competitionId) ?? null
  );
}

/** 우승 팀과 준우승 팀 — 준우승은 그 우승이 누구를 꺾은 것인가라는 사실이다 */
export function championText(state: GameState, trophy: Trophy): string {
  return (
    teamNameIn(state, trophy.teamId) +
    (trophy.runnerUpTeamId ? ` (준우승 ${teamNameIn(state, trophy.runnerUpTeamId)})` : "")
  );
}

/**
 * 지나간 시즌 그 대회의 결과 — 리그면 최종 순위표, 녹아웃이면 우승·준우승 한 줄.
 * **둘 다 없으면 없다고 말한다**: 장부에 남는 것은 표와 감독 팀의 경기뿐이다.
 */
export function pastCompetitionView(
  state: GameState,
  season: number,
  competitionId: string,
): LookupResult {
  const head = `[역대] ${seasonLabel(season)} · ${competitionName(competitionId)}`;
  const table = leagueTableOf(state, season, competitionId);
  if (table) {
    const mine = seasonHistoryOf(state, season)?.teamId;
    return {
      ok: true,
      message: [
        `${head} 최종 순위`,
        ...table.map((row, i) => historyTableRow(state, row, i + 1, mine)),
      ].join("\n"),
    };
  }
  const trophy = trophyOf(state, season, competitionId);
  if (trophy) {
    return { ok: true, message: [head, `우승 ${championText(state, trophy)}`].join("\n") };
  }
  return {
    ok: true,
    message: `${head} — 장부에 없습니다 (그 시즌 그 대회의 순위표도 우승 기록도 남지 않았습니다)`,
  };
}

/**
 * 어느 대회의 표인가 — 순위표와 개인 순위가 **같은 자로** 고른다. 지나간 시즌이면
 * 그때의 소속을 본다(지금 승격한 팀이 옛 리그의 표에 서지 않게 한다).
 */
function competitionOfInput(
  state: GameState,
  input: LeagueViewInput,
  past: number | null,
): { ok: true; competitionId: string } | LookupResult {
  let competitionId =
    (past === null ? null : leagueOfTeamInSeason(state, past, state.userTeamId)) ??
    leagueOfTeamIn(state, state.userTeamId);
  if (input.competition) {
    const resolved = resolveCompetitionId(input.competition);
    if (!resolved) {
      return {
        ok: false,
        message: `"${input.competition}"${josaOf(input.competition, "이라는/라는")} 대회를 찾지 못했습니다 — ${competitionHint()}`,
      };
    }
    competitionId = resolved;
  } else if (input.team && !EVERY_TEAM.has(norm(input.team))) {
    // 팀을 주면 그 팀이 속한 리그의 표를 본다 — 지나간 시즌은 **그때의** 소속이다
    const team = resolveTeam(state, input.team);
    if (!team.ok) return team;
    competitionId =
      (past === null ? null : leagueOfTeamInSeason(state, past, team.teamId)) ??
      leagueOfTeamIn(state, team.teamId);
  }
  return { ok: true, competitionId };
}

/** 지나간 시즌인가 — 지금 시즌이면 null (표를 세우는 자리가 갈린다) */
function pastSeasonOf(state: GameState, input: LeagueViewInput): number | null {
  return input.season !== undefined && input.season !== state.season ? input.season : null;
}

/** 표 머리줄 — 리그와 대항전 리그 페이즈가 같은 모양으로 선다 */
function tableTitle(competitionId: string, what: string): string {
  return isCup(competitionId)
    ? `[${competitionShortName(competitionId)} 리그 페이즈 ${what}]`
    : `[리그 ${what}] ${competitionName(competitionId)}`;
}

/** 홈 표·원정 표의 머리줄 꼬리 — 합계표는 아무것도 붙이지 않는다 */
const SPLIT_KO: Record<StandingSplitKey, string> = { all: "", home: " · 홈", away: " · 원정" };

function standingsView(state: GameState, input: LeagueViewInput): LookupResult {
  const past = pastSeasonOf(state, input);
  const picked = competitionOfInput(state, input, past);
  if (!("competitionId" in picked)) return picked;
  const { competitionId } = picked;

  // 지나간 시즌은 결산 스냅샷이 답한다 — 지금 경기로 세우는 표가 아니다 (§3.3)
  if (past !== null) return pastCompetitionView(state, past, competitionId);

  // 국내 컵은 순수 녹아웃이라 순위표가 없다 — 대신 대진표를 돌려준다
  if (isDomesticCup(competitionId)) return cupBracketView(state, competitionId);

  const split = input.split ?? "all";
  const table = standingsBySplit(computeStandings(state, competitionId), split);
  if (table.length === 0) {
    return {
      ok: true,
      message: `${competitionName(competitionId)} 순위표가 없습니다 — 아직 참가 팀이 배정되지 않았습니다`,
    };
  }
  const rows = table.map((r, i) => {
    const mark = r.teamId === state.userTeamId ? " ←우리" : "";
    // 홈 표·원정 표는 그 소계를 찍는다 — 합계를 찍으면 순서와 숫자가 어긋난다
    const box = split === "all" ? r : r[split];
    const diff = box.goalsFor - box.goalsAgainst;
    const form = r.form.map(outcomeLabel).join("");
    return (
      `${String(i + 1).padStart(2)} ${r.name} ${box.played}경기 ${box.wins}승 ${box.draws}무 ${box.losses}패 ` +
      `${box.points}점 (${diff >= 0 ? "+" : ""}${diff})${form ? ` 폼 ${form}` : ""}${mark}`
    );
  });
  return {
    ok: true,
    message: [
      `${tableTitle(competitionId, "순위")}${SPLIT_KO[split]} ${seasonLabel(state.season)} · ${state.date}`,
      ...rows,
    ].join("\n"),
  };
}

/** 개인 순위 한 줄이 찍는 값 — 표가 줄 세운 그 값이다 (competition.md §2) */
function leaderValueLine(key: LeaderboardKey, row: LeaderRow): string {
  switch (key) {
    case "goals":
      return `${row.goals}골 ${row.assists}도움`;
    case "assists":
      return `${row.assists}도움 ${row.goals}골`;
    case "rating":
      return `평점 ${(row.rating ?? 0).toFixed(2)}`;
    case "cleanSheets":
      return `무실점 ${row.cleanSheets}경기`;
    default:
      return `징계 ${row.value}점 (경고 ${row.yellows} 퇴장 ${row.reds})`;
  }
}

/**
 * 개인 순위의 머리줄 — 순위표의 `tableTitle`과 **다른 자다.**
 *
 * 개인 순위는 그 대회의 경기를 전부 세므로(녹아웃 포함) 컵에 「리그 페이즈」를 붙이면
 * 거짓이 된다. 날짜 꼬리는 이번 시즌에만 붙는다 — 지나간 시즌의 표는 오늘과 무관하다.
 */
function leadersTitle(state: GameState, competitionId: string, past: number | null): string {
  const head = isCup(competitionId)
    ? `[${competitionShortName(competitionId)} 개인 순위]`
    : `[리그 개인 순위] ${competitionName(competitionId)}`;
  return past === null
    ? `${head} ${seasonLabel(state.season)} · ${state.date}`
    : `${head} ${seasonLabel(past)}`;
}

/**
 * 대회 개인 순위 + 팀 열 — 시즌 끝의 시상을 시즌 중에 미리 읽는 자리다.
 *
 * **대회 다섯 곳에 다 선다** — 리그·국내 컵·대항전이 같은 함수를 지나고
 * (`leaderboardsOf`), `season`을 주면 지나간 시즌의 표다. 지나간 시즌에는 평점 축이
 * 리그에만 서고(문턱을 셀 경기가 남지 않는다 — `ratingFloorOf`) 나머지 네 축은 그대로다.
 *
 * ⚠️ **팀 열은 이번 시즌에만 싣는다.** `teamStatsOf`는 `state.matches`를 세는데 시즌
 * 전환이 그것을 갈아 끼우므로(game-state.md §3.3), 지나간 시즌에 부르면 이번 시즌의
 * 표가 지난 시즌의 머리줄 아래에 선다.
 */
function leadersView(state: GameState, input: LeagueViewInput): LookupResult {
  const past = pastSeasonOf(state, input);
  const season = past ?? state.season;
  const picked = competitionOfInput(state, input, past);
  if (!("competitionId" in picked)) return picked;
  const { competitionId } = picked;

  const limit = input.count ?? LEADERBOARD_LIMIT;
  const lines: string[] = [];
  const boards = input.key
    ? [{ key: input.key, rows: leaderboardOf(state, competitionId, input.key, limit, season) }]
    : leaderboardsOf(state, competitionId, limit, season);
  for (const board of boards) {
    if (board.rows.length === 0) continue;
    lines.push(`· ${leaderboardTitle(board.key)}`);
    board.rows.forEach((row, i) => {
      lines.push(
        `  ${String(i + 1).padStart(2)} ${row.playerName} (${row.teamShortName}) ` +
          `${leaderValueLine(board.key, row)} · ${row.apps}경기${row.ours ? " ←우리" : ""}`,
      );
    });
  }

  const teams = past === null ? teamStatsOf(state, competitionId) : [];
  if (teams.length > 0) {
    // 컵의 팀 열은 순위표가 센 경기, 곧 리그 페이즈뿐이다 — 개인 순위와 세는 집합이 다르다
    lines.push(isCup(competitionId) ? "· 팀 (리그 페이즈)" : "· 팀");
    teams.forEach((t, i) => {
      lines.push(
        `  ${String(i + 1).padStart(2)} ${t.shortName} ${t.played}경기 ${t.goalsFor}득점 ${t.goalsAgainst}실점 ` +
          `무실점${t.cleanSheets} 슛${t.shots} xG${t.xg.toFixed(1)}${t.ours ? " ←우리" : ""}`,
      );
    });
  }
  if (lines.length === 0) {
    return {
      ok: true,
      message:
        past === null
          ? `${competitionName(competitionId)} — 아직 기록이 없습니다`
          : `${seasonLabel(past)} ${competitionName(competitionId)} — 개인 기록이 장부에 없습니다`,
    };
  }
  return { ok: true, message: [leadersTitle(state, competitionId, past), ...lines].join("\n") };
}

/** 지난 시즌 맞대결 줄의 상한 — 한 상대와 한 시즌에 넷까지 붙으므로 셋이면 흐름이 보인다 */
const PAST_H2H_SHOWN = 4;

/** 결산 스냅샷의 경기 한 줄이 남긴 승패·스코어 요약 */
interface PastHeadToHead {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  scored: number;
  conceded: number;
  /** 최근 것부터 — "시즌 3 FA컵 결승 2-1" */
  lines: string[];
}

/**
 * 지난 시즌들의 맞대결 — **장부에 남는 것은 감독 팀의 경기뿐이다**
 * (game-state.md §3.3). 그 시즌 감독이 그 팀에 있었을 때의 줄만 세므로, 남의 팀끼리의
 * 지난 시즌 스코어는 여기서도 나오지 않는다 — 그 물음에는 없다는 것이 답이다.
 */
function pastHeadToHead(state: GameState, teamId: string, opponentId: string): PastHeadToHead {
  const tally: PastHeadToHead = {
    played: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    scored: 0,
    conceded: 0,
    lines: [],
  };
  for (const snapshot of pastSeasonsOf(state)) {
    if (snapshot.teamId !== teamId) continue;
    for (const row of [...snapshot.matches].reverse()) {
      if (row.opponentTeamId !== opponentId) continue;
      // 승패는 지금 시즌의 경기와 **같은 자**를 지난다 — 연장·승부차기의 규칙이 하나다
      const outcome = outcomeFor(asOutcomeBasis(row, teamId), teamId);
      tally.played += 1;
      tally.scored += row.goalsFor;
      tally.conceded += row.goalsAgainst;
      if (outcome === "W") tally.wins += 1;
      else if (outcome === "L") tally.losses += 1;
      else tally.draws += 1;
      tally.lines.push(
        `시즌 ${snapshot.season} ${pastMatchLabel(row)} ` +
          `${row.goalsFor}-${row.goalsAgainst}` +
          (row.penalties ? ` (승부차기 ${row.penalties.for}-${row.penalties.against})` : ""),
      );
    }
  }
  return tally;
}

/** 스냅샷이 든 단계 문자열을 대회 라벨이 아는 갈래로 — 모르는 값은 리그 경기다 */
function stageOf(stage: string | undefined): MatchStage {
  const parsed = MatchStageSchema.safeParse(stage);
  return parsed.success ? parsed.data : "league";
}

/**
 * 스냅샷의 경기가 서는 대회 표기 — **라운드도 차수도 남지 않는다** (§3.3).
 * 없는 것을 `R1`·`1차전`으로 지어내지 않으므로 단계 이름까지만 붙인다.
 */
function pastMatchLabel(row: SeasonMatchRow): string {
  const stage = stageOf(row.stage);
  const name = competitionShortName(row.competitionId);
  if (stage === "league") return name;
  const label = isDomesticCup(row.competitionId)
    ? domesticStageLabel(row.competitionId, stage)
    : stageLabel(stage, 1, false);
  return label ? `${name} ${label}` : name;
}

/**
 * 결산 스냅샷의 경기 한 줄을 **승패 판정의 모양으로** — 지금 시즌의 경기와 같은
 * 함수(`outcomeFor`)를 지나게 하는 자리다. 스냅샷은 감독 팀 시점으로 적히므로 그 팀을
 * 홈에 세운다 (실제 홈·원정은 `venue`가 따로 답한다 — 승패는 그것을 보지 않는다).
 */
function asOutcomeBasis(row: SeasonMatchRow, teamId: string): OutcomeBasis {
  return {
    homeTeamId: teamId,
    awayTeamId: row.opponentTeamId,
    result: {
      homeGoals: row.goalsFor,
      awayGoals: row.goalsAgainst,
      ...(row.penalties
        ? { penalties: { home: row.penalties.for, away: row.penalties.against } }
        : {}),
    },
  };
}

/**
 * 지나간 시즌의 경기 — `state.matches`는 새 시즌 일정으로 갈아 끼워지므로 여기 답할
 * 것은 결산 스냅샷에 남은 **감독 팀의 경기**뿐이다 (game-state.md §3.3).
 *
 * 그 밖의 물음(남의 팀의 지난 시즌 일정, 대회 전체)에는 **없다고 말한다** — 이 자리가
 * 조용히 이번 시즌의 경기를 내면 모델은 그것을 지난 시즌의 일로 옮겨 적는다.
 */
function pastFixturesView(
  state: GameState,
  season: number,
  query: { teamId: string | null; opponentId: string | null; competitionId: string | null },
  input: LeagueViewInput,
): LookupResult {
  const head = `[일정] ${seasonLabel(season)} — 지나간 시즌`;
  if (input.round !== undefined) {
    return {
      ok: false,
      message: `${head}\n지난 시즌 장부에는 라운드가 없습니다 — 날짜 범위로 조회하세요`,
    };
  }
  const snapshot = seasonHistoryOf(state, season);
  const mine = snapshot?.teamId;
  if (snapshot === null || mine === undefined) {
    return {
      ok: true,
      message: `${head}\n장부에 그 시즌의 경기가 없습니다 — 남는 것은 감독 팀의 경기뿐입니다`,
    };
  }
  if (query.teamId !== mine) {
    const asked = query.teamId === null ? "대회 전체" : teamNameIn(state, query.teamId);
    return {
      ok: true,
      message:
        `${head}\n${asked}의 그 시즌 경기는 장부에 없습니다 —` +
        ` 남는 것은 그때 감독이 맡은 ${teamNameIn(state, mine)}의 경기뿐입니다`,
    };
  }
  const rows = snapshot.matches.filter(
    (row) =>
      (query.opponentId === null || row.opponentTeamId === query.opponentId) &&
      (query.competitionId === null || row.competitionId === query.competitionId) &&
      (!input.from || row.date >= input.from) &&
      (!input.to || row.date <= input.to) &&
      input.when !== "upcoming",
  );
  if (rows.length === 0) {
    return { ok: true, message: `${head}\n조건에 맞는 경기가 없습니다` };
  }
  const count = Math.min(Math.max(input.count ?? (query.opponentId ? 10 : 5), 1), 20);
  const shown = [...rows].sort((a, b) => a.date.localeCompare(b.date)).slice(-count);
  return {
    ok: true,
    message: [
      `${head} · ${teamNameIn(state, mine)} ${rows.length}경기 (최근 ${shown.length}경기 표시)`,
      ...shown.map((row) => {
        const pens = row.penalties
          ? ` (승부차기 ${row.penalties.for}-${row.penalties.against})`
          : "";
        const outcome = outcomeFor(asOutcomeBasis(row, mine), mine);
        return (
          `  ${dateLabel(row.date)} ${pastMatchLabel(row)} ` +
          `${VENUE_KO[row.venue]} ${row.goalsFor}-${row.goalsAgainst}${pens} ` +
          `vs ${teamNameIn(state, row.opponentTeamId)} ${outcomeLabel(outcome)}`
        );
      }),
    ].join("\n"),
  };
}

/**
 * 일정 검색 — 팀·상대·대회·라운드·날짜 범위·방향으로 좁힌다.
 *
 * 왜 "가까운 N경기"로는 부족한가: 감독은 "다음 맨유전 언제야", "토트넘과 지난
 * 맞대결 어떻게 됐지"처럼 **특정 경기**를 묻는다. 창을 넓히는 대신 조건으로
 * 찾게 해야 모델이 지어내지 않는다. 절단은 항상 남은 수를 함께 알린다.
 */
function fixturesView(state: GameState, input: LeagueViewInput): LookupResult {
  const everyTeam = input.team !== undefined && EVERY_TEAM.has(norm(input.team));
  let teamId: string | null = null;
  if (!everyTeam) {
    const team = resolveTeam(state, input.team);
    if (!team.ok) return team;
    teamId = team.teamId;
  }

  let opponentId: string | null = null;
  if (input.opponent) {
    const opponent = resolveTeam(state, input.opponent);
    if (!opponent.ok) return opponent;
    opponentId = opponent.teamId;
    // 맞대결의 기준은 언제나 한 팀이어야 한다 — 팀을 안 줬으면 우리 팀
    teamId ??= state.userTeamId;
    if (opponentId === teamId) {
      return { ok: false, message: "기준 팀과 상대 팀이 같습니다 — 상대를 다시 지정하라" };
    }
  }

  let competitionId: string | null = null;
  if (input.competition) {
    competitionId = resolveCompetitionId(input.competition);
    if (!competitionId) {
      return {
        ok: false,
        message: `"${input.competition}"${josaOf(input.competition, "이라는/라는")} 대회를 찾지 못했습니다 — ${competitionHint()}`,
      };
    }
  } else if (teamId === null) {
    // 팀을 안 좁혔으면 5대 리그 전 경기가 쏟아진다 — 우리 리그로 기본을 잡는다
    competitionId = leagueOfTeamIn(state, state.userTeamId);
  }

  // 지나간 시즌은 일정 장부에 없다 — 결산 스냅샷이 답한다 (§3.3)
  if (input.season !== undefined && input.season !== state.season) {
    return pastFixturesView(state, input.season, { teamId, opponentId, competitionId }, input);
  }

  const pool = state.matches
    .filter((m) => {
      // 2군 경기는 일정 조회에 서지 않는다 — 달력과 같은 답이어야 한다 (season.md §2)
      if (isReserveMatch(m)) return false;
      if (teamId && m.homeTeamId !== teamId && m.awayTeamId !== teamId) return false;
      if (opponentId && m.homeTeamId !== opponentId && m.awayTeamId !== opponentId) return false;
      if (competitionId && m.competitionId !== competitionId) return false;
      if (input.round !== undefined && m.round !== input.round) return false;
      if (input.from && m.date < input.from) return false;
      if (input.to && m.date > input.to) return false;
      return true;
    })
    .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date < b.date ? -1 : 1));

  const when = input.when ?? "both";
  const played = pool.filter((m) => m.result);
  const upcoming = pool.filter((m) => !m.result);
  const count = Math.min(Math.max(input.count ?? (opponentId || everyTeam ? 10 : 5), 1), 20);
  // 지난 경기는 **최근**부터, 예정 경기는 **가까운 것**부터 잘라낸다
  const shownPast = when === "upcoming" ? [] : played.slice(-count);
  const shownUpcoming = when === "past" ? [] : upcoming.slice(0, count);
  const detail = shownPast.length <= 8;

  const scopeName = teamId
    ? teamNameIn(state, teamId)
    : `${competitionName(competitionId!)} 전체 (모든 팀)`;
  const filters = [
    opponentId ? `vs ${teamNameIn(state, opponentId)}` : null,
    competitionId && teamId ? competitionName(competitionId) : null,
    input.round !== undefined ? `${input.round}라운드` : null,
    input.from || input.to ? `${input.from ?? "시즌 시작"}~${input.to ?? "시즌 끝"}` : null,
    when === "past" ? "지난 경기만" : when === "upcoming" ? "예정만" : null,
  ].filter((x): x is string => x !== null);
  const head =
    `[일정] ${scopeName}${filters.length > 0 ? ` · ${filters.join(" · ")}` : ""}` +
    ` — 오늘 ${dateLabel(state.date)} · ${seasonLabel(state.season)}`;

  const lines: string[] = [head];

  if (opponentId && teamId) {
    if (played.length === 0) {
      lines.push(`이번 시즌 맞대결 기록 없음`);
    } else {
      let w = 0;
      let d = 0;
      let l = 0;
      let scored = 0;
      let conceded = 0;
      for (const m of played) {
        const outcome = outcomeFor(m, teamId);
        if (outcome === "W") w++;
        else if (outcome === "L") l++;
        else d++;
        const home = m.homeTeamId === teamId;
        scored += home ? m.result!.homeGoals : m.result!.awayGoals;
        conceded += home ? m.result!.awayGoals : m.result!.homeGoals;
      }
      lines.push(
        `이번 시즌 맞대결 ${played.length}경기 — ${w}승 ${d}무 ${l}패 (득 ${scored} · 실 ${conceded})`,
      );
    }
    /**
     * **지난 시즌도 남는다 — 다만 감독 팀의 경기만이다** (game-state.md §3.3).
     * 남의 팀끼리의 지난 시즌 스코어는 시즌이 넘어가며 사라졌고, 그 물음에는 없다는
     * 것이 답이다. 두 답을 가르는 것은 장부에 그 팀의 시즌이 남았는가다.
     */
    const past = pastHeadToHead(state, teamId, opponentId);
    const kept = pastSeasonsOf(state).some((h) => h.teamId === teamId);
    if (past.played > 0) {
      const shown = past.lines.slice(0, PAST_H2H_SHOWN);
      lines.push(
        `지난 시즌 맞대결 ${past.played}경기 — ${past.wins}승 ${past.draws}무 ${past.losses}패` +
          ` (득 ${past.scored} · 실 ${past.conceded}) — ${shown.join(" / ")}` +
          (past.lines.length > shown.length
            ? ` …그 외 ${past.lines.length - shown.length}경기`
            : ""),
      );
    } else {
      lines.push(
        kept
          ? `지난 시즌 맞대결 없음 — 장부에 남은 지난 시즌 경기에 이 상대가 없다`
          : `지난 시즌 맞대결은 장부에 없다 — 남는 것은 감독 팀의 경기뿐이다`,
      );
    }
  }

  if (shownPast.length === 0 && shownUpcoming.length === 0) {
    lines.push("조건에 맞는 경기가 없습니다 — 조건을 넓혀라 (상대·대회·라운드·날짜 범위 확인)");
    return { ok: true, message: lines.join("\n") };
  }

  if (played.length > shownPast.length && when !== "upcoming") {
    lines.push(
      `  …더 이전 경기 ${played.length - shownPast.length}건 (count를 올리거나 날짜 범위를 주라)`,
    );
  }
  lines.push(...shownPast.map((m) => matchLine(state, m, teamId, detail)));
  lines.push(...shownUpcoming.map((m) => matchLine(state, m, teamId, detail)));
  if (upcoming.length > shownUpcoming.length && when !== "past") {
    lines.push(`  …더 뒤의 예정 경기 ${upcoming.length - shownUpcoming.length}건`);
  }
  return { ok: true, message: lines.join("\n") };
}

export function leagueView(state: GameState, input: LeagueViewInput): LookupResult {
  if (input.view === "standings") return standingsView(state, input);
  if (input.view === "leaders") return leadersView(state, input);
  return fixturesView(state, input);
}
