import {
  type GameState,
  playerName,
  teamName,
  isPeaceTurn,
  playersOf,
  tacticsOf,
  buildMatchView,
  pointsSeenBy,
  subLimitsOf,
} from "@story-fm/engine";
import {
  type MatchEvent,
  TACTIC_TOGGLES,
  tacticToggleValue,
  tacticToggleWord,
  SET_PIECE_ROUTINE_AXES,
  setPieceRoutineLevel,
  SET_PIECE_ROUTINE_NEUTRAL,
  setPieceRoutineWord,
  SET_PIECE_KO,
  type BoardMove,
  tacticAxisOf,
  tacticWord,
  SET_PIECE_ROLE_KO,
  shootoutTally,
  formatScore,
} from "@story-fm/domain";
import { buildEventsBlock, scoreBeforeEvents } from "./match-script";

/** 이번 턴 층의 `<events>` — 지난 턴 뒤 장부에 앉은 사건을 대본으로 */
export function eventsBlockOf(state: GameState, events: readonly MatchEvent[]): string {
  const score = state.pendingMatch?.live.ledger.score ?? { home: 0, away: 0 };
  return buildEventsBlock(
    events,
    (id) => playerName(state, id),
    (side) => sideTeamName(state, side),
    scoreBeforeEvents(score, events),
  );
}

/** 홈/어웨이 → 팀 이름 (중계 대본 표기용) */
export function sideTeamName(state: GameState, side: "home" | "away"): string {
  const match = state.matches.find((m) => m.id === state.pendingMatch?.matchId);
  if (!match) return side === "home" ? "홈" : "어웨이";
  return teamName(side === "home" ? match.homeTeamId : match.awayTeamId);
}

/** 경기 브리핑에 그대로 싣는 직전 평시 감독 발화 수 */
const MATCH_BRIEF_TURNS = 3;

/**
 * 평시 → 경기 다리 — 직전 평시 턴의 감독 발화를 **그대로** 싣는다
 * (중계는 평시 이력을 보지 않고, 요약은 말투·의도를 가장 먼저 지운다).
 */
export function buildMatchBrief(state: GameState): string {
  const said = state.chat
    .filter((t) => isPeaceTurn(t) && t.role === "user")
    .slice(-MATCH_BRIEF_TURNS)
    .map((t) => `- “${t.text}”`);
  if (said.length === 0) return "";
  return [`<pre_match>`, ...said, `</pre_match>`].join("\n");
}

/**
 * 완장 한 줄 — **주장과 부주장은 이름 명단 안이 아니라 자기 줄에 선다.**
 *
 * 이름 뒤에 괄호로 붙이면 가운뎃점으로 이어진 스물다섯 이름 한가운데에 묻혀, GM이
 * 장부의 완장 대신 제가 아는 축구 상식의 주장을 라커룸에 세운다. 완장은 팀 토크와
 * 라커룸 장면이 두고 서는 축이라 자기 줄을 갖는다 (agents.md §6 `<club>`).
 *
 * `<club>`과 `<standing>`이 같은 문장을 쓴다 — 두 벌이면 경기 중과 평시의 완장이
 * 다른 낱말로 서고, 그 차이는 아무것도 뜻하지 않는다 (AGENTS.md §5 "한 규칙, 한 정의").
 */
export function armbandLine(state: GameState): string {
  const squad = playersOf(state, state.userTeamId);
  const captain = squad.find((p) => p.isCaptain);
  const vice = squad.find((p) => p.isViceCaptain === true);
  return (
    `완장: 주장 ${captain ? playerName(state, captain.id) : "없음"} · ` +
    `부주장 ${vice ? playerName(state, vice.id) : "없음"}`
  );
}

/**
 * `<standing>` — **지금 우리가 걸어 둔 것 전부**: 6축과 갈래·세트피스 인원·자리별
 * 역할·완장·세트피스 키커. 경기 장부 노트와 평시의 지시 해석이 같은 블록을 읽는다 —
 * 두 벌이면 "압박 올려"의 지금 값이 한쪽에서 지어내진다 (agents.md §1).
 *
 * 판독은 여기 서지 않는다 — 포인트는 `<points>`가, 시트는 코어가 갖는다 (match.md §1.6).
 */
export function buildStandingBlock(state: GameState): string[] {
  const takers = tacticsOf(state, state.userTeamId).setPieceTakers ?? {};
  const takerName = (id: string | undefined): string => (id ? playerName(state, id) : "지정 없음");
  /**
   * **지금 내가 무엇을 걸어 뒀는가** — 경기 중에는 평시 스냅샷(6축이 적힌 줄)이
   * 실리지 않아 여기가 유일한 자리다. 없으면 "압박 올려"에 지금 값이 지어내진다.
   */
  const ourTeamTactics = tacticsOf(state, state.userTeamId);
  const ourTactics = ourTeamTactics.spec;
  const assignments = ourTeamTactics.assignments.filter((a) => a.role === "starting" && a.roleId);
  /**
   * 걸어 둔 갈래 — **중립인 것은 세우지 않는다** (`tacticsBrief`와 같은 규칙).
   * 낱말은 `TACTIC_TOGGLES` 하나에서 온다 — 손으로 적으면 해석 프롬프트가 가르치는
   * 낱말과 이 줄이 갈린다 (prompts.md §5-2).
   */
  const ourToggles = TACTIC_TOGGLES.flatMap((toggle) => {
    const value = tacticToggleValue(ourTactics, toggle.key);
    return value === null ? [] : [`${toggle.brief} ${tacticToggleWord(toggle.key, value)}`];
  });
  /**
   * 걸어 둔 세트피스 지시 — 갈래와 **같은 규칙으로 중립은 서지 않는다.** 이 줄이
   * 없으면 걸어 둔 축이 「지금 걸어 둔 것」 목록에서 빠져, 인원을 올려 둔 판을 두고
   * 모델이 세트피스는 손대지 않았다고 답한다 (match.md §2).
   */
  const ourRoutine = SET_PIECE_ROUTINE_AXES.flatMap((axis) => {
    const level = setPieceRoutineLevel(ourTeamTactics.setPieceRoutine, axis.key);
    return level === SET_PIECE_ROUTINE_NEUTRAL
      ? []
      : [`${axis.label} ${setPieceRoutineWord(axis.key, level)}`];
  });
  return [
    `<standing>`,
    `전술 ${ourTactics.formation} · 멘탈${ourTactics.mentality} 라인${ourTactics.defensiveLine} ` +
      `압박${ourTactics.pressing} 템포${ourTactics.tempo} 폭${ourTactics.width} 패스${ourTactics.passStyle}` +
      (ourToggles.length > 0 ? ` · ${ourToggles.join(" · ")}` : ``) +
      (ourRoutine.length > 0 ? ` · ${SET_PIECE_KO} ${ourRoutine.join(" · ")}` : ``),
    assignments.length > 0
      ? `자리별 역할: ${assignments
          .map((a) => `${playerName(state, a.playerId)}(${a.position} ${a.roleId})`)
          .join(", ")}`
      : `자리별 역할: 없음`,
    armbandLine(state),
    `세트피스 키커: 코너 ${takerName(takers.corner)} · 프리킥 ${takerName(takers.freeKick)} · 페널티 ${takerName(takers.penalty)}`,
    `</standing>`,
  ];
}

/**
 * `<board_moves>` — **이번 턴 감독이 전술판에서 직접 움직인 것.**
 *
 * 판 조작은 해석기를 거치지 않고 코어가 먼저 적용하므로 `<standing>`에 선 값은 이미
 * 그 조작이 반영된 뒤의 값이다. 그것만 주면 판에서 라인을 내리고 같은 턴에 "한 칸
 * 내려"라고 말한 감독이 두 칸 내려간 판을 받는다 — 해석기가 되풀이를 알아보려면
 * **판이 떠나온 값**이 있어야 한다 (agents.md §3 지시 해석).
 *
 * 지난 턴의 조작은 여기 서지 않는다. 이 블록의 뜻은 "걸려 있다"가 아니라 "이번 턴에
 * 이미 갔다"이고, 그 구별이 `<standing>`과 이것을 가른다.
 */
export function buildBoardMovesBlock(state: GameState, moves: readonly BoardMove[]): string[] {
  if (moves.length === 0) return [];
  const who = (id: string): string => playerName(state, id);
  const lines = moves.map((move) => {
    switch (move.kind) {
      case "tactic": {
        const axis = tacticAxisOf(move.axis);
        return `- ${axis.label} ${move.from} → ${move.to}(${tacticWord(move.axis, move.to)})`;
      }
      case "position":
        return `- ${who(move.playerId)} 자리 → ${move.position}`;
      case "role":
        return `- ${who(move.playerId)} 역할 → ${move.role}`;
      case "substitution":
        return `- 교체: ${who(move.out)} → ${who(move.in)}`;
      case "setPiece":
        return `- ${SET_PIECE_KO} ${SET_PIECE_ROLE_KO[move.role]} 키커 → ${
          move.playerId === null ? "지정 해제" : who(move.playerId)
        }`;
    }
  });
  return [`<board_moves>`, ...lines, `</board_moves>`];
}

export function buildLedgerNote(state: GameState, options: { withState?: boolean } = {}): string {
  const pending = state.pendingMatch;
  if (!pending) return "";
  const live = pending.live;
  const ledger = live.ledger;
  const view = buildMatchView(state);
  const rows = new Map(
    [
      ...(view?.onPitch.home ?? []),
      ...(view?.onPitch.away ?? []),
      ...(view?.bench.home ?? []),
      ...(view?.bench.away ?? []),
    ].map((p) => [p.id, p] as const),
  );
  const withNames = (ids: readonly string[] | undefined): string =>
    (ids ?? [])
      .map((id) => {
        const row = rows.get(id);
        return row
          ? `${id}(${playerName(state, id)} ${row.position} ${row.effective})`
          : `${id}(${playerName(state, id)})`;
      })
      .join(", ");
  const seen = pointsSeenBy(state);
  const pointLines =
    seen.length > 0 ? [`<points>`, ...seen.map((p) => `- ${p.text}`), `</points>`] : [];
  const standingLines = ["", ...buildStandingBlock(state)];
  /** 교체 한도는 **그 경기가 정한다** — 연장은 6인/4회, 친선은 9인/3회다 (match.md §5) */
  const subLimits = subLimitsOf(ledger.phase, ledger.friendly);
  const minute = ledger.added > 0 ? `${ledger.minute}+${ledger.added}′` : `${ledger.minute}′`;
  const stateLines =
    options.withState === true && view
      ? [
          ``,
          `<match_state>`,
          ...(["home", "away"] as const).map((side) => {
            const s = view.stats[side];
            return (
              `${side === "home" ? view.home.name : view.away.name} — 점유 ${Math.round(s.possession * 100)}% · ` +
              `슈팅 ${s.shots} (유효 ${s.shotsOnTarget}) · xG ${s.xg.toFixed(2)} · ` +
              `패스 ${s.passes}(${s.passes > 0 ? Math.round((s.passesCompleted / s.passes) * 100) : 0}%) · ` +
              `태클 ${s.tackles} · 파울 ${s.fouls} · 코너 ${s.corners} · 뛴 거리 ${s.distanceKm.toFixed(1)}km`
            );
          }),
          `</match_state>`,
        ]
      : [];
  const shootoutLines = pending.shootout
    ? [
        `승부차기 ${shootoutTally(pending.shootout.kicks).home}:${shootoutTally(pending.shootout.kicks).away} · ${pending.shootout.kicks.length}발`,
      ]
    : [];
  return [
    `<ledger>`,
    // 스코어의 자는 하나다 — 모델이 되받아 쓰는 자리라 화면과 같은 표기로 싣는다
    `스코어 ${formatScore(ledger.score.home, ledger.score.away)} · ${minute} · ${ledger.phase}${live.state.interval ? " · 휴식 중" : ""}`,
    ...shootoutLines,
    `홈 온필드: ${withNames(ledger.home.onPitch)}`,
    `홈 벤치: ${withNames(ledger.home.bench)} (교체 ${ledger.home.subsUsed}/${subLimits.maxSubs}, 기회 ${ledger.home.subWindows}/${subLimits.maxSubWindows})`,
    `어웨이 온필드: ${withNames(ledger.away.onPitch)}`,
    `어웨이 벤치: ${withNames(ledger.away.bench)} (교체 ${ledger.away.subsUsed}/${subLimits.maxSubs}, 기회 ${ledger.away.subWindows}/${subLimits.maxSubWindows})`,
    ledger.sentOff.length > 0 ? `퇴장: ${withNames(ledger.sentOff)}` : "",
    `</ledger>`,
    ...standingLines,
    ...stateLines,
    ...pointLines,
  ]
    .filter(Boolean)
    .join("\n");
}
