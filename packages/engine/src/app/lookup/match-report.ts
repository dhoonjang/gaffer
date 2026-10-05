import {
  type MatchEventType,
  type MatchRecord,
  type ShootoutOutcome,
  type ShotOrigin,
  josa,
  josaOf,
  isReserveMatch,
  tacticsBrief,
} from "@story-fm/domain";
import {
  buildMatchReport,
  type MatchReportEventView,
  type MatchReportPlayerView,
  type MatchReportView,
} from "../views/match-report";
import { outcomeLabel } from "../views/attention";
import {
  ABSENT_REASON_KO,
  buildOpponentReport,
  opponentFactFavours,
  opponentFactText,
} from "../../match/preview";
import { competitionName } from "../../core/catalog/cup-catalog";
import { competitionHint, resolveCompetitionId } from "../../team/player-pool";
import { teamNameIn, teamShortNameIn, type GameState } from "../../core/state";
import { LookupResult, DEFAULT_LIMIT, resolveTeam } from "./resolve";
import { dateLabel, competitionTag } from "./league";

// ── 끝난 경기 리포트 (match.md §8) ──────────────────────

/**
 * 리포트가 고를 경기 — **전부 optional**이고, 아무것도 없으면 가장 최근에 끝난
 * 우리 경기다. 감독은 "지난 리버풀전"이라고 부르지 경기 id를 모른다.
 */
interface MatchReportInput {
  /** 경기 id — 주면 나머지 조건은 보지 않는다 */
  matchId?: string;
  /** 상대 팀 이름·약칭 */
  opponent?: string;
  /** 대회 이름·약칭·id */
  competition?: string;
  /** 그날 치른 경기 — YYYY-MM-DD */
  date?: string;
}

/**
 * 타임라인 상한 — 골·카드·교체·부상·국면 표식 넷이 다 서고도 여유가 남는 폭.
 * 넘치면 **큰 기회부터** 걷어낸다: 슛의 총량은 이미 팀 스탯의 숫자이고, 골이
 * 큰 기회 스무 줄 사이에 묻히면 리포트가 답하는 것이 없다.
 */
const REPORT_TIMELINE_LIMIT = 30;
/** 우리 선수 줄 상한 — 한 경기의 출전 명단 (선발 11 + 교체 6, 연장까지) */
const REPORT_OUR_LIMIT = 17;
/** 상대 선수 줄 상한 — 이름이 남은 선수만 서므로 이 위로 갈 일이 드물다 */
const REPORT_THEIR_LIMIT = DEFAULT_LIMIT;

/** 사건의 이름 — 화면은 아이콘으로, 조회는 말로 가른다 (`MatchReportEventView.type`) */
const REPORT_EVENT_KO: Record<MatchEventType, string> = {
  kickoff: "킥오프",
  goal: "골",
  shot: "큰 기회",
  save: "선방",
  chance: "기회",
  foul: "파울",
  yellow_card: "경고",
  red_card: "퇴장",
  substitution: "교체",
  injury: "부상",
  tactical_shift: "전술 전환",
  half_time: "하프타임",
  extra_time_start: "연장 개시",
  extra_half_time: "연장 전반 종료",
  full_time: "종료",
};

const REPORT_ORIGIN_KO: Record<ShotOrigin, string> = {
  open: "열린 플레이",
  corner: "코너",
  free_kick: "프리킥",
  penalty: "페널티",
};

export const SHOOTOUT_KO: Record<ShootoutOutcome, string> = {
  scored: "성공",
  saved: "막힘",
  missed: "실축",
};

export const VENUE_KO: Record<"home" | "away" | "neutral", string> = {
  home: "홈",
  away: "원정",
  neutral: "중립",
};

/** 끝난 우리 경기 — 오래된 것부터. 2군 경기는 서지 않는다 (일정 조회와 같은 답) */
function finishedOurMatches(state: GameState): MatchRecord[] {
  return state.matches
    .filter(
      (m) =>
        m.result &&
        !isReserveMatch(m) &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )
    .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date < b.date ? -1 : 1));
}

/** 못 찾았을 때 돌려주는 후보 — 조용히 빈 결과를 주면 모델이 지어낸다 (파일 머리 규약) */
function reportCandidates(state: GameState): string[] {
  const recent = finishedOurMatches(state).slice(-DEFAULT_LIMIT).reverse();
  if (recent.length === 0) return ["  끝난 우리 경기가 아직 없다"];
  return recent.map(
    (m) =>
      `  ${m.id} · ${dateLabel(m.date)} ${competitionTag(m)} ` +
      `${teamShortNameIn(state, m.homeTeamId)} ${m.result?.homeGoals}-${m.result?.awayGoals} ` +
      `${teamShortNameIn(state, m.awayTeamId)}`,
  );
}

type PickedMatch = { ok: true; matchId: string } | { ok: false; message: string };

function pickReportMatch(state: GameState, input: MatchReportInput): PickedMatch {
  if (input.matchId) {
    const m = state.matches.find((x) => x.id === input.matchId);
    if (!m) {
      return {
        ok: false,
        message: [
          `"${input.matchId}"${josaOf(input.matchId, "이라는/라는")} 경기를 찾지 못했습니다 — 최근 우리 경기:`,
        ]
          .concat(reportCandidates(state))
          .join("\n"),
      };
    }
    if (!m.result) {
      return {
        ok: false,
        message: `${dateLabel(m.date)} ${competitionTag(m)} 경기는 아직 치르지 않았습니다 — 리포트는 끝난 경기에만 있습니다`,
      };
    }
    return { ok: true, matchId: m.id };
  }

  let pool = finishedOurMatches(state);
  const filters: string[] = [];
  if (input.opponent) {
    const opponent = resolveTeam(state, input.opponent);
    if (!opponent.ok) return opponent;
    if (opponent.teamId === state.userTeamId) {
      return { ok: false, message: "상대가 우리 팀입니다 — 상대를 다시 지정하라" };
    }
    pool = pool.filter((m) => m.homeTeamId === opponent.teamId || m.awayTeamId === opponent.teamId);
    filters.push(`vs ${teamNameIn(state, opponent.teamId)}`);
  }
  if (input.competition) {
    const competitionId = resolveCompetitionId(input.competition);
    if (!competitionId) {
      return {
        ok: false,
        message: `"${input.competition}"${josaOf(input.competition, "이라는/라는")} 대회를 찾지 못했습니다 — ${competitionHint()}`,
      };
    }
    pool = pool.filter((m) => m.competitionId === competitionId);
    filters.push(competitionName(competitionId));
  }
  if (input.date) {
    pool = pool.filter((m) => m.date === input.date);
    filters.push(input.date);
  }

  const last = pool[pool.length - 1];
  if (!last) {
    return {
      ok: false,
      message: [
        `${filters.length > 0 ? `조건(${filters.join(" · ")})에 ` : ""}맞는 끝난 경기가 없습니다 — 최근 우리 경기:`,
      ]
        .concat(reportCandidates(state))
        .join("\n"),
    };
  }
  return { ok: true, matchId: last.id };
}

/** 팀 스탯 한 칸 — **양쪽 다 0이면 서지 않는다**: 사건 없는 경기의 빈칸이 0으로 읽힌다 */
function statPair(label: string, home: number, away: number, digits = 0): string | null {
  if (home === 0 && away === 0) return null;
  return `${label} ${home.toFixed(digits)}-${away.toFixed(digits)}`;
}

/** 타임라인 한 줄 — 뷰가 이미 고른 사건을 말로 옮기기만 한다 */
function timelineLine(e: MatchReportEventView, report: MatchReportView): string {
  const team =
    e.side === null ? "" : ` ${e.side === "home" ? report.home.short : report.away.short}`;
  const who =
    e.type === "goal"
      ? ` ${e.actors[0] ?? "?"}${e.actors[1] ? ` (도움 ${e.actors[1]})` : ""}`
      : e.type === "substitution"
        ? ` ${e.actors[0] ?? "?"} 나가고 ${e.actors[1] ?? "?"} 들어옴`
        : e.actors.length > 0
          ? ` ${e.actors.join(", ")}`
          : "";
  const tail = [
    e.origin === null ? null : REPORT_ORIGIN_KO[e.origin],
    e.xg === null ? null : `xG ${e.xg.toFixed(2)}`,
    e.subCause,
    ...e.causes,
  ].filter((x): x is string => x !== null && x !== "");
  return (
    `  ${e.minute}′ ${REPORT_EVENT_KO[e.type]}${team}${who}` +
    `${tail.length > 0 ? ` · ${tail.join(" · ")}` : ""}`
  );
}

/** 선수 한 줄 — 평점과 그 **한 줄 근거**까지. 근거는 결산 LLM이 남긴 경우에만 있다 */
function playerReportRow(p: MatchReportPlayerView, teamShort: string): string {
  const stats = [
    p.goals > 0 ? `골 ${p.goals}` : null,
    p.assists > 0 ? `도움 ${p.assists}` : null,
    p.shots > 0 ? `슛 ${p.shots}` : null,
    p.xg > 0 ? `xG ${p.xg.toFixed(2)}` : null,
    p.saves > 0 ? `선방 ${p.saves}` : null,
    p.passes > 0 ? `패스 ${p.passes}(전진 ${p.progressive})` : null,
    p.corners > 0 ? `코너 ${p.corners}` : null,
    p.fouls > 0 ? `파울 ${p.fouls}` : null,
    p.yellows > 0 ? `경고 ${p.yellows}` : null,
    p.red ? "퇴장" : null,
  ].filter((x): x is string => x !== null);
  return (
    `  ${p.rating === null ? "" : `평점 ${p.rating.toFixed(1)} · `}` +
    `${p.squadNumber === null ? "" : `${p.squadNumber} `}${p.name}` +
    `${teamShort === "" ? "" : `(${teamShort})`} ${p.minutes}′ ${p.started ? "선발" : "교체 투입"}` +
    `${stats.length > 0 ? ` · ${stats.join(" · ")}` : ""}` +
    `${p.note === null ? "" : ` — ${p.note}`}`
  );
}

/**
 * 끝난 경기 하나 — **사실은 뷰가 세고 여기서는 옮기기만 한다** (`buildMatchReport`).
 *
 * 스코어만 들고 답하면 "그 경기 왜 졌지"에 모델이 나머지를 지어낸다: 슛 3·xG 0.4로
 * 진 경기와 슛 18·xG 2.3으로 진 경기는 같은 1-2 패가 아니다 (match.md §8).
 *
 * 끝난 경기에서 **실제로 일어난 일**은 공개 사실이라 상대 쪽도 흐리지 않는다 —
 * 90분 동안 화면에 이미 서 있던 것들이다. 능력치는 여기 서지 않는다.
 */
export function matchReport(state: GameState, input: MatchReportInput = {}): LookupResult {
  const picked = pickReportMatch(state, input);
  if (!picked.ok) return picked;
  const report = buildMatchReport(state, picked.matchId);
  if (!report) return { ok: false, message: `${picked.matchId} 경기의 결과를 읽지 못했습니다` };

  const shootout = report.penalties;
  const lines: string[] = [
    `[경기 리포트] ${dateLabel(report.date)} ${report.label} — ` +
      `${report.home.name} ${report.home.goals}-${report.away.goals} ${report.away.name}` +
      `${report.aet ? " (연장)" : ""}` +
      `${shootout ? ` (승부차기 ${shootout.home}-${shootout.away})` : ""}`,
  ];

  const ourTeam = report.home.ours ? report.home : report.away.ours ? report.away : null;
  lines.push(
    ourTeam
      ? `우리 ${ourTeam.name}(${ourTeam.short}) · ${VENUE_KO[report.venue ?? "neutral"]} · ` +
          `${outcomeLabel(report.outcome)}`
      : "우리 경기가 아니다 — 평점과 MOTM은 우리 경기에만 남는다",
  );
  if (!report.hasDetail) {
    lines.push(
      "※ 사건 기록이 없는 경기다 (타 팀 간이 시뮬) — 타임라인은 득점 줄뿐이고 " +
        "선수별 기록도 없다. 빈 타임라인이 조용했던 경기라는 뜻이 아니다",
    );
  }

  const teamStats = [
    `점유 ${Math.round(report.home.possession * 100)}%-${Math.round(report.away.possession * 100)}%`,
    statPair("슛", report.home.shots, report.away.shots),
    statPair("xG", report.home.xg, report.away.xg, 2),
    statPair("기대 득점", report.home.expectedGoals, report.away.expectedGoals, 2),
    statPair("패스", report.home.passes, report.away.passes),
    statPair("전진 패스", report.home.progressive, report.away.progressive),
    statPair("코너", report.home.corners, report.away.corners),
    statPair("파울", report.home.fouls, report.away.fouls),
    statPair("경고", report.home.yellows, report.away.yellows),
    statPair("퇴장", report.home.reds, report.away.reds),
  ].filter((x): x is string => x !== null);
  if (teamStats.length > 0) {
    lines.push(`스탯 (${report.home.short}-${report.away.short}): ${teamStats.join(" · ")}`);
  }

  // 넘치면 큰 기회를 먼저 걷고, 그래도 넘치면 뒤(경기 후반)를 남긴다
  const trimmed =
    report.timeline.length <= REPORT_TIMELINE_LIMIT
      ? report.timeline
      : report.timeline.filter((e) => e.type !== "shot");
  const shownEvents = trimmed.slice(-REPORT_TIMELINE_LIMIT);
  if (shownEvents.length === 0) {
    lines.push("타임라인: 남은 사건이 없다");
  } else {
    if (report.timeline.length > shownEvents.length) {
      lines.push(
        `타임라인 (세우지 않은 사건 ${report.timeline.length - shownEvents.length}건 — 큰 기회부터 걷어냈다):`,
      );
    } else {
      lines.push("타임라인:");
    }
    lines.push(...shownEvents.map((e) => timelineLine(e, report)));
  }

  if (shootout && shootout.kicks.length > 0) {
    lines.push(`승부차기 ${shootout.home}-${shootout.away}:`);
    lines.push(
      ...shootout.kicks.map(
        (k) =>
          `  ${k.round} ${k.team} ${k.taker} ${SHOOTOUT_KO[k.outcome]}` +
          `${k.keeper === null ? "" : ` (GK ${k.keeper})`}`,
      ),
    );
  }

  const ourRows = report.players
    .filter((p) => p.ours)
    .sort(
      (a, b) =>
        (b.rating ?? -1) - (a.rating ?? -1) || b.minutes - a.minutes || a.id.localeCompare(b.id),
    );
  if (ourRows.length > 0) {
    lines.push("우리 선수 (평점 높은 순):");
    lines.push(...ourRows.slice(0, REPORT_OUR_LIMIT).map((p) => playerReportRow(p, "")));
    if (ourRows.length > REPORT_OUR_LIMIT) {
      lines.push(`  …그 외 ${ourRows.length - REPORT_OUR_LIMIT}명`);
    }
  }
  // 상대는 이름이 남은 선수만 — 스물두 명을 다 세우면 리포트가 명단표가 된다
  const theirRows = report.players.filter(
    (p) => !p.ours && (p.goals > 0 || p.assists > 0 || p.red),
  );
  if (theirRows.length > 0) {
    lines.push(`${ourTeam ? "상대" : "그 밖의"} 선수 (득점·도움·퇴장만):`);
    lines.push(
      ...theirRows
        .slice(0, REPORT_THEIR_LIMIT)
        .map((p) => playerReportRow(p, p.side === "home" ? report.home.short : report.away.short)),
    );
    if (theirRows.length > REPORT_THEIR_LIMIT) {
      lines.push(`  …그 외 ${theirRows.length - REPORT_THEIR_LIMIT}명`);
    }
  }

  if (report.motm) {
    lines.push(`MOTM: ${report.motm.name} 평점 ${report.motm.rating.toFixed(1)}`);
  }
  return { ok: true, message: lines.join("\n") };
}

interface OpponentReportInput {
  /** 경기 id — 주면 나머지 조건은 보지 않는다 */
  matchId?: string;
  /** 상대 팀 이름·약칭 */
  opponent?: string;
  /** 대회 이름·약칭·id */
  competition?: string;
  /** 그날 치를 경기 — YYYY-MM-DD */
  date?: string;
}

/** 아직 치르지 않은 우리 경기 — 가까운 것부터. 2군 경기는 서지 않는다 */
function upcomingOurMatches(state: GameState): MatchRecord[] {
  return state.matches
    .filter(
      (m) =>
        !m.result &&
        !isReserveMatch(m) &&
        m.date >= state.date &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )
    .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date < b.date ? -1 : 1));
}

/** 못 찾았을 때 돌려주는 후보 — 조용히 빈 결과를 주면 모델이 지어낸다 (파일 머리 규약) */
function previewCandidates(state: GameState): string[] {
  const upcoming = upcomingOurMatches(state).slice(0, DEFAULT_LIMIT);
  if (upcoming.length === 0) return ["  남은 우리 경기가 없다"];
  return upcoming.map(
    (m) =>
      `  ${m.id} · ${dateLabel(m.date)} ${competitionTag(m)} ` +
      `vs ${teamShortNameIn(state, m.homeTeamId === state.userTeamId ? m.awayTeamId : m.homeTeamId)}`,
  );
}

function pickUpcomingMatch(state: GameState, input: OpponentReportInput): PickedMatch {
  if (input.matchId) {
    const m = state.matches.find((x) => x.id === input.matchId);
    if (!m) return { ok: false, message: `${input.matchId} 경기를 찾지 못했습니다` };
    if (m.result)
      return { ok: false, message: `${josa(input.matchId, "은/는")} 이미 끝난 경기입니다` };
    return { ok: true, matchId: m.id };
  }
  let list = upcomingOurMatches(state);
  const filters: string[] = [];
  if (input.opponent) {
    const resolved = resolveTeam(state, input.opponent);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    list = list.filter((m) => m.homeTeamId === resolved.teamId || m.awayTeamId === resolved.teamId);
    filters.push(teamNameIn(state, resolved.teamId));
  }
  if (input.competition) {
    const id = resolveCompetitionId(input.competition);
    if (id === null) return { ok: false, message: `${input.competition} 대회를 찾지 못했습니다` };
    list = list.filter((m) => m.competitionId === id);
    filters.push(competitionName(id));
  }
  if (input.date) {
    list = list.filter((m) => m.date === input.date);
    filters.push(input.date);
  }
  const picked = list[0];
  if (!picked) {
    return {
      ok: false,
      message: [
        filters.length > 0
          ? `${filters.join(" · ")} 조건에 맞는 예정 경기를 찾지 못했습니다`
          : "예정된 우리 경기가 없습니다",
        "예정 경기:",
        ...previewCandidates(state),
      ].join("\n"),
    };
  }
  return { ok: true, matchId: picked.id };
}

/**
 * 경기 전 상대 분석 (`get_opponent_report`) — 예정된 우리 경기 하나
 * (→ docs/match/match.md §1.8).
 *
 * **예상 XI에 능력치는 서지 않는다.** 이름과 자리뿐이고, 그 열한 명을 대조해 나온
 * 수치는 이미 아래 지점 줄(`facts`)에 있다. 여기에 OVR을
 * 얹으면 안개를 지나지 않은 값이 명단표로 새어 나온다 (player.md §10).
 */
export function opponentReport(state: GameState, input: OpponentReportInput = {}): LookupResult {
  const picked = pickUpcomingMatch(state, input);
  if (!picked.ok) return picked;
  const report = buildOpponentReport(state, { matchId: picked.matchId });
  if (!report) {
    return {
      ok: false,
      message:
        state.pendingMatch !== null
          ? "경기 중에는 다음 상대의 분석을 세우지 않습니다 — 지금 판은 판세 화면이 들고 있습니다"
          : `${picked.matchId} 경기의 상대 분석을 세우지 못했습니다 (배치·전술을 읽지 못했습니다)`,
    };
  }

  const venue = VENUE_KO[report.venue];
  const when = report.inDays === 0 ? "오늘" : `D-${report.inDays}`;
  const lines: string[] = [
    `[상대 분석] ${dateLabel(report.date)} ${report.time} (${when}) ` +
      `${report.label} · ${venue} vs ${report.opponent.name}`,
  ];

  /**
   * 근거가 없으면 **열한 명이 다 추정이다** — 그때 이름마다 `?`를 붙이는 것은
   * 머리줄이 이미 한 말의 되풀이다. 표시는 관측과 추정이 섞였을 때만 뜻을 갖는다.
   */
  const guessed = report.basis === null ? 0 : report.expectedXI.filter((p) => !p.carried).length;
  const basis =
    report.basis === null
      ? "직전 경기가 없다 — 배치에서 세운 추정이다"
      : `직전 ${dateLabel(report.basis.date)} ${report.basis.label} 선발에서 투영` +
        (guessed > 0 ? ` · ?는 추정으로 메운 ${guessed}자리` : "");
  lines.push(
    `예상 XI (${basis}):`,
    "  " +
      report.expectedXI
        .map((p) => `${p.name}(${p.position})${guessed > 0 && !p.carried ? "?" : ""}`)
        .join(" · "),
  );

  lines.push(
    report.absent.length === 0
      ? "결장: 없다"
      : "결장: " +
          report.absent
            .map((a) => `${a.name}(${a.position}) ${ABSENT_REASON_KO[a.reason]}(${a.note})`)
            .join(" · "),
  );

  lines.push(`상대 전술: ${tacticsBrief(report.shape)}`);

  if (report.facts.length === 0) {
    lines.push("읽어 낸 지점: 없다 — 두 판이 맞물리는 곳이 보이지 않는다");
  } else {
    lines.push("읽어 낸 지점:");
    lines.push(
      ...report.facts.map((fact) => {
        const favours = opponentFactFavours(fact);
        const side = favours === null ? "  · " : favours ? "  + " : "  - ";
        return side + opponentFactText(fact);
      }),
    );
  }

  lines.push("※ 예상 XI는 직전 경기 선발에서 투영한 것이다 — 상대가 로테이션을 돌리면 갈린다");
  return { ok: true, message: lines.join("\n") };
}
