import {
  ATTRIBUTE_AXES,
  type AttributeAxis,
  AXIS_KO,
  type DeferredScout,
  formatMoney,
  type GamePlayer,
  naturalPositionOf,
  observedFit,
  observedOverall,
  RATING_TIERS,
  ratingLabel,
  ratingTier,
  type RatingTier,
  SCOUT_CONCURRENT_LIMIT,
  SCOUT_DEFER_DAYS,
  type ScoutMission,
  type ScoutReport,
} from "@story-fm/domain";
import { diffDays } from "../../common/core/dates";
import { type GameState, playerById, teamNameIn } from "../../common/core/state";
import { competitionName } from "../../common/data/cup-catalog";
import {
  type Knowledge,
  knowledgeOf,
  OBSERVATION_MARGIN,
  observationMargin,
  type ObservedPlayerFacts,
  observedPlayerFacts,
  observedRating,
  potentialMargin,
  scoutReportOf,
} from "../../common/players/observation";
import { settlingNote } from "../../common/players/settling";

/**
 * 눈금의 순서 — **얼마나 아는가**로 줄을 세운다. `OBSERVATION_MARGIN`이 좁아지는
 * 순서 그대로다(`adapting`은 스카우트 폭에서 시작해 적응만큼 더 걷힌다).
 * "스카우팅을 마친 선수만"처럼 **최소 수준**을 묻는 자리가 이 자를 읽는다.
 */
export const KNOWLEDGE_RANK: Record<Knowledge, number> = {
  rumoured: 0,
  seen: 1,
  scouted: 2,
  adapting: 3,
  own: 4,
};

/** 실행 계열의 오차 — 안개 안내문이 "무엇까지 믿어도 되나"를 말할 때 쓴다 */
export const KNOWLEDGE_MARGIN: Record<Knowledge, number> = OBSERVATION_MARGIN.observable;

/** 안개를 씌워 노출하는 축 — 16축 전부 */
export const SCOUT_ATTRS = ATTRIBUTE_AXES;

export type ScoutAttr = AttributeAxis;

export const ATTR_KO: Record<ScoutAttr, string> = AXIS_KO;

/** 파견 중인 리포트 (completedOn === null) */
export function openScoutReport(state: GameState, playerId: string): ScoutReport | null {
  const r = scoutReportOf(state, playerId);
  return r && r.completedOn === null ? r : null;
}

/**
 * **도착한 마지막 보고서** — 카드도 모달도 조회 도구도 여기서 같은 한 장을 본다.
 *
 * 같은 선수에게 세 번까지 보낼 수 있으므로(`SCOUT_REPEAT_LIMIT`) 완료된 것이 여럿일 수
 * 있다. 마지막 완료 시점이 현재 관측 수준에 해당한다 (player.md §9.4-1).
 */
export function arrivedScoutReport(state: GameState, playerId: string): ScoutReport | null {
  let last: ScoutReport | null = null;
  for (const r of state.scoutReports) {
    if (r.gamePlayerId === playerId && r.completedOn !== null) last = r;
  }
  return last;
}

/**
 * **표시 규칙은 도메인에 있다** — 오프셋을 얹는 일(`observedFit`·`observedOverall`)과
 * 수치를 등급으로 자르는 일(`RATING_TIERS`)은 세이브를 읽지 않는 순수 함수다.
 *
 * 여기서 다시 쓰지 않고 그대로 내보낸다: 전술판이 저장 전 배치의 전력을 낼 때 같은
 * 함수를 불러야 하는데, 화면이 엔진을 값으로 import하면 `node:fs`가 브라우저 번들에
 * 딸려 온다. 이 재수출 덕에 코어 쪽 호출자는 그대로 여기서 가져다 쓴다.
 *
 * **무엇을 얹을지**(오프셋의 크기)는 세이브가 정하므로 위 `observationOf`가 남는다.
 */
export { observedFit, observedOverall, RATING_TIERS, ratingLabel, ratingTier, type RatingTier };

export interface ScoutedAttribute {
  key: ScoutAttr;
  ko: string;
  /** 안개가 없을 때만 숫자 — 있으면 null (라벨만 노출) */
  exact: number | null;
  label: string;
}

/** 능력치 16축을 지식 수준 × 축별 관측 가능성에 맞춰 노출 */
export function scoutedAttributes(
  state: GameState,
  player: GamePlayer,
  facts: ObservedPlayerFacts = observedPlayerFacts(state, player),
): ScoutedAttribute[] {
  const { knowledge } = facts;
  return SCOUT_ATTRS.map((key) => {
    const observed = facts.attributes[key];
    return {
      key,
      ko: ATTR_KO[key],
      // 축마다 다르다 — 스카우팅을 마쳐도 분석형은 숫자를 주지 않는다
      exact:
        observationMargin(state, player.id, key, knowledge) === 0 ? player.attributes[key] : null,
      label: ratingLabel(observed),
    };
  });
}

/** 종합 평가 — 안개가 있으면 티어 서술만 */
export function overallView(
  state: GameState,
  player: GamePlayer,
  facts: ObservedPlayerFacts = observedPlayerFacts(state, player),
): string {
  const { knowledge } = facts;
  if (observationMargin(state, player.id, "overall", knowledge) === 0) {
    return `OVR${player.attributes.overall}`;
  }
  // 화면·서버가 쓰는 단일 규칙과 같은 값이어야 한다 (LLM이 읽는 텍스트도 마찬가지)
  return ratingLabel(facts.overall);
}

export function potentialView(
  state: GameState,
  player: GamePlayer,
  facts: ObservedPlayerFacts = observedPlayerFacts(state, player),
): string {
  const band = facts.potential;
  if (!band) return "미지 (성장 여력을 짐작할 근거가 없다)";
  return `${band.low}~${band.high} (${band.confidence} · ±${band.margin})`;
}

/** 한 줄 요약이 꼽는 강점·약점 축의 수 */
export const HIGHLIGHT_AXES = 2;

/** 능력치 한 줄 요약 — 조회 도구 결과에 쓴다 */
export function attributeLine(
  state: GameState,
  player: GamePlayer,
  facts: ObservedPlayerFacts = observedPlayerFacts(state, player),
): string {
  return scoutedAttributes(state, player, facts)
    .map((a) => `${a.ko} ${a.exact ?? a.label}`)
    .join(" · ");
}

/**
 * 안내문이 잠재력에 대해 할 수 있는 말 — **실제로 주는 구간과 어긋나면 안 된다.**
 * 구간을 주면서 "알 수 없다"고 하면 모델이 손에 든 정보를 버린다 (player.md §10).
 */
export function potentialNote(state: GameState, playerId: string, knowledge: Knowledge): string {
  const margin = potentialMargin(state, playerId, knowledge);
  return margin === null ? "잠재력은 짐작할 근거가 없다" : `잠재력은 구간으로만 안다(±${margin})`;
}

/**
 * 안개 상태 **카드** — 눈금·오차폭·잠재력 마진·파견 예정일까지의 사실만 싣는다.
 *
 * ⚠️ **지시문은 여기 서지 않는다.** 눈금이 낮을 때 어떻게 말할지는 그 선수에 대한
 * 사실이 아니라 모델에게 내리는 지시라 GM 시스템 프롬프트가 한 줄로 갖는다
 * (player.md §10, llm/prompts.md §5).
 */
export function knowledgeNote(state: GameState, playerId: string): string {
  const knowledge = knowledgeOf(state, playerId);
  const margin = KNOWLEDGE_MARGIN[knowledge];
  const potential = potentialNote(state, playerId, knowledge);
  if (knowledge === "own") return `우리 선수 — 능력치는 정확하다 · ${potential}`;
  if (knowledge === "adapting") {
    const observable = observationMargin(state, playerId, "pace", knowledge);
    const analytical = observationMargin(state, playerId, "vision", knowledge);
    return (
      `${settlingNote(state, playerId)} · 훈련장에서 본 게 전부다` +
      `(실행 ±${observable} · 판단 ±${analytical}) — 경기와 훈련이 쌓일수록 정확해진다 · ` +
      potential
    );
  }
  const open = openScoutReport(state, playerId);
  const pending = open ? ` · 스카우트 파견 중 (보고 예정 ${open.dueOn})` : "";
  const analytical = OBSERVATION_MARGIN.analytical[knowledge];
  if (knowledge === "scouted") {
    return (
      `스카우팅 완료 — 실행 계열(스피드·패스·태클 등)은 거의 정확하나(±${margin}), ` +
      `판단 계열(결정력·시야·위치선정·침착성·리더십)은 ±${analytical} 오차가 남는다. ` +
      `${potential}${pending}`
    );
  }
  const source = knowledge === "seen" ? "직접 상대해 봤다" : "리그 평판·소문 수준";
  return `${source} — 평가에 오차가 있다(실행 ±${margin} · 판단 ±${analytical}). ${potential}${pending}`;
}

/** 강점·약점 지목 — seen 이상에서만 의미가 있다 (관측값 기준) */
export function strengthsAndWeaknesses(
  state: GameState,
  player: GamePlayer,
): { strengths: string[]; weaknesses: string[] } {
  const knowledge = knowledgeOf(state, player.id);
  const ranked = SCOUT_ATTRS.filter(
    (k) => k !== "goalkeeping" || naturalPositionOf(player).position === "GK",
  )
    .map((key) => ({
      key,
      value: observedRating(state, player.id, key, player.attributes[key], knowledge),
    }))
    .sort((a, b) => b.value - a.value);
  return {
    strengths: ranked.slice(0, HIGHLIGHT_AXES).map((r) => ATTR_KO[r.key]),
    weaknesses: ranked
      .slice(-HIGHLIGHT_AXES)
      .reverse()
      .map((r) => ATTR_KO[r.key]),
  };
}

// ── 못 나간 파견 (한도에 막힌 요청) ─────────────────────
/** 대기 줄에 이름을 몇까지 적는가 — 나머지는 수로만 (주의 줄은 매 턴 정가다) */
export const SCOUT_SUMMARY_NAMES = 3;

/**
 * 아직 살아 있는 대기 요청 — 요청 뒤 `SCOUT_DEFER_DAYS`까지, 그리고 여전히 타 팀
 * 선수인 것만. 우리가 데려온 선수는 스카우트를 보낼 대상이 아니다.
 */
export function deferredScouts(state: GameState): DeferredScout[] {
  return state.deferredScouts.filter((d) => {
    if (diffDays(d.requestedOn, state.date) > SCOUT_DEFER_DAYS) return false;
    const p = playerById(state, d.gamePlayerId);
    return !!p && p.teamId !== state.userTeamId;
  });
}

/** 한도에 막힌 요청을 대기로 남긴다 — 같은 선수는 한 번만, 날짜는 첫 요청 그대로 */
export function deferScout(state: GameState, playerId: string): void {
  const queue = state.deferredScouts;
  if (queue.some((d) => d.gamePlayerId === playerId)) return;
  queue.push({ gamePlayerId: playerId, requestedOn: state.date });
}

/** 나갔거나 더는 대상이 아닌 요청을 지운다 */
export function dropDeferredScout(state: GameState, playerId: string): void {
  state.deferredScouts = state.deferredScouts.filter((d) => d.gamePlayerId !== playerId);
}

/** 만료·무효 요청 정리 — tick이 하루에 한 번 부른다 */
export function pruneDeferredScouts(state: GameState): void {
  if (state.deferredScouts.length === 0) return;
  state.deferredScouts = deferredScouts(state);
}

// ── 임무 (조건으로 나가는 파견) ─────────────────────────
/**
 * 지금 나가 있는 임무 — `dueOn`이 섰고 아직 안 돌아온 것.
 *
 * 대기(`dueOn === null`)와 완료(`completedOn`)가 한 표에 함께 앉으므로, 자리를
 * 세는 쪽은 반드시 이 자를 쓴다 (player.md §9.4).
 */
export function activeMissions(state: GameState): ScoutMission[] {
  return state.scoutMissions.filter((m) => m.dueOn !== null && m.completedOn === null);
}

/** 아직 살아 있는 대기 임무 — 요청 뒤 `SCOUT_DEFER_DAYS`까지 */
export function waitingMissions(state: GameState): ScoutMission[] {
  return state.scoutMissions.filter(
    (m) => m.dueOn === null && diffDays(m.requestedOn, state.date) <= SCOUT_DEFER_DAYS,
  );
}

/** 만료된 대기 임무를 지운다 — tick이 하루에 한 번 부른다 (지목의 `pruneDeferredScouts`와 같은 자리) */
export function pruneWaitingMissions(state: GameState): void {
  if (state.scoutMissions.length === 0) return;
  const alive = new Set(waitingMissions(state).map((m) => m.id));
  state.scoutMissions = state.scoutMissions.filter((m) => m.dueOn !== null || alive.has(m.id));
}

/** 임무가 뒤지는 곳 — 대회 이름, 대회를 안 주면 검색과 같은 전체 풀 */
export function missionScope(mission: ScoutMission): string {
  return mission.competitionId ? competitionName(mission.competitionId) : "5대 리그 1·2부 전체";
}

/** 나이 조건 한 마디 — 없으면 빈 문자열 */
export function missionAgeText(mission: ScoutMission): string {
  const { minAge, maxAge } = mission;
  if (minAge !== undefined && maxAge !== undefined) return `${minAge}~${maxAge}세`;
  if (maxAge !== undefined) return `${maxAge}세 이하`;
  if (minAge !== undefined) return `${minAge}세 이상`;
  return "";
}

/**
 * **임무가 무엇을 찾는가** — 뒤지는 곳(`missionScope`)을 뺀 조건들.
 *
 * 곳과 조건을 가르는 이유는 카드가 둘을 다른 자리에 세우기 때문이다 — 한 줄로만
 * 두면 「대상: 프리미어리그」 옆에 「프리미어리그 · LB · 23세 이하」가 다시 선다.
 */
export function missionBrief(mission: ScoutMission): string {
  const parts = [
    mission.position,
    missionAgeText(mission),
    mission.maxValue === undefined ? "" : `${formatMoney(mission.maxValue)} 이하`,
  ].filter((part): part is string => part !== undefined && part !== "");
  return parts.length > 0 ? parts.join(" · ") : "조건 없음";
}

/**
 * **임무의 이름표** — 곳과 조건을 붙인 한 줄.
 *
 * 지목은 선수 이름으로 불리지만 임무에는 이름이 없다. 반려 문구와 요약 줄이 이
 * 한 줄을 함께 쓴다 — 자리마다 조건을 다시 엮으면 같은 임무가 두 가지로 불린다.
 */
export function missionLabel(mission: ScoutMission): string {
  return `${missionScope(mission)} · ${missionBrief(mission)}`;
}

/**
 * **두 임무가 같은 조건인가** — 나가 있거나 대기 중인 임무를 또 부르는 것을 막는 자.
 *
 * 완료된 임무와 같은 조건은 다시 나갈 수 있다: 그 사이 값도 나이도 움직였고,
 * 후보 다섯이 `seen`이 되어 관측값 자체가 달라졌다 (player.md §9.4).
 */
export function sameMissionConditions(a: ScoutMission, b: ScoutMission): boolean {
  return (
    a.competitionId === b.competitionId &&
    a.position === b.position &&
    a.minAge === b.minAge &&
    a.maxAge === b.maxAge &&
    a.maxValue === b.maxValue
  );
}

/**
 * **지금 나가 있는 파견을 한 줄씩** — 반려 문구가 「무엇이 나갔는가」를 말하는 자.
 *
 * 지목은 선수 이름으로, 임무는 조건으로 불린다. 두 명령이 각자 엮으면 같은 파견이
 * 반려 문구에 따라 다르게 불린다.
 */
export function inFlightScoutLabels(state: GameState): string[] {
  return [
    ...state.scoutReports
      .filter((r) => r.completedOn === null)
      .map((r) => `${playerById(state, r.gamePlayerId)?.name ?? r.gamePlayerId} 보고 ${r.dueOn}`),
    ...activeMissions(state).map((m) => `임무 ${missionLabel(m)} 보고 ${m.dueOn}`),
  ];
}

/** 자리가 나는 가장 이른 날 — 나가 있는 게 없으면 null */
export function earliestScoutReturn(state: GameState): string | null {
  const dates = [
    ...state.scoutReports.filter((r) => r.completedOn === null).map((r) => r.dueOn),
    ...activeMissions(state).map((m) => m.dueOn ?? ""),
  ].filter((d) => d !== "");
  return dates.length === 0 ? null : dates.sort()[0]!;
}

/**
 * 지금 비어 있는 파견 자리 — **지목과 임무가 함께 센다** (player.md §9.4).
 * 한쪽만 세면 임무 셋이 나가 있는 날에도 지목이 넷째로 나간다.
 */
export function freeScoutSlots(state: GameState): number {
  const inFlight =
    state.scoutReports.filter((r) => r.completedOn === null).length + activeMissions(state).length;
  return Math.max(0, SCOUT_CONCURRENT_LIMIT - inFlight);
}

/**
 * 스카우팅 진행 현황 요약 — 상태 헤더·다이제스트용.
 *
 * 파견 중인 것 **다음에 못 나간 것**이 온다. 반려 문구는 그 턴에만 살아 있어서,
 * 이 줄이 없으면 다음 턴의 모델에는 넷째를 읽을 자리가 없다 (player.md §9.4).
 */
export function scoutingSummary(state: GameState): string[] {
  const lines = state.scoutReports
    .filter((r) => r.completedOn === null)
    .map((r) => {
      const p = playerById(state, r.gamePlayerId);
      if (!p) return `스카우트 파견 중 (보고 ${r.dueOn})`;
      return `${p.name} (${teamNameIn(state, p.teamId)}) 스카우트 파견 중 — 보고 ${r.dueOn}`;
    });
  // 임무는 이름이 없다 — 조건 한 줄이 그 자리에 선다 (player.md §9.4)
  for (const m of activeMissions(state)) {
    lines.push(`스카우트 임무 파견 중 — ${missionLabel(m)} · 보고 ${m.dueOn}`);
  }
  /**
   * **못 나간 것은 갈래를 가리지 않고 한 줄에 선다.** 지목과 임무가 각자 줄을
   * 세우면 같은 「동시 한도 · 빈 자리」가 두 번 서서 어느 쪽 자리인지가 흐려진다.
   */
  const waiting: string[] = [
    ...deferredScouts(state).map((d) => {
      const p = playerById(state, d.gamePlayerId);
      return p ? `${p.name} (${teamNameIn(state, p.teamId)})` : d.gamePlayerId;
    }),
    ...waitingMissions(state).map((m) => `임무: ${missionLabel(m)}`),
  ];
  if (waiting.length > 0) {
    const names = waiting.slice(0, SCOUT_SUMMARY_NAMES).join(", ");
    const free = freeScoutSlots(state);
    lines.push(
      `스카우트 미파견 ${waiting.length}건 (${names}${waiting.length > SCOUT_SUMMARY_NAMES ? " …" : ""}) — ` +
        `동시 한도 ${SCOUT_CONCURRENT_LIMIT}에 막혀 아직 안 나갔다 · ` +
        (free > 0 ? `지금 자리 ${free}` : "빈 자리 없음"),
    );
  }
  return lines;
}

/** 같은 선수에게 보낼 수 있는 스카우트 횟수 */
export const SCOUT_REPEAT_LIMIT = 3;
