import {
  ATTRIBUTE_AXES,
  type AttributeAxis,
  AXIS_KO,
  type GamePlayer,
  naturalPositionOf,
  observedFit,
  observedOverall,
  RATING_TIERS,
  ratingLabel,
  ratingTier,
  type RatingTier,
} from "@story-fm/domain";
import { type GameState } from "../../common/core/state";
import {
  type Knowledge,
  knowledgeOf,
  OBSERVATION_MARGIN,
  observationMargin,
  type ObservedPlayerFacts,
  observedPlayerFacts,
  observedRating,
  potentialMargin,
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

export function openScoutReport(state: GameState, playerId: string) {
  return (
    state.scoutingRequests.find(
      (r) => r.scope.playerIds.includes(playerId) && !["completed", "cancelled"].includes(r.status),
    ) ?? null
  );
}

export function arrivedScoutReport(state: GameState, playerId: string) {
  return (
    [...state.scoutReports]
      .reverse()
      .find((r) => r.candidates.some((c) => c.evidence.playerId === playerId)) ?? null
  );
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
        observationMargin(state, player.id, key, knowledge) === 0 ? facts.attributes[key] : null,
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
    return `OVR${facts.overall}`;
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
    const report = arrivedScoutReport(state, playerId);
    return `조사 보고 ${report?.completedOn ?? ""} — 항목별 근거와 불확실성을 확인한다. ${potential}${pending}`;
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

export function scoutingSummary(state: GameState): string[] {
  return state.scoutingRequests
    .filter((r) => r.status !== "completed" && r.status !== "cancelled")
    .map(
      (r) =>
        `${r.id} · ${r.question} · ${r.status}${r.dueOn ? ` · 보고 예정 ${r.dueOn}` : ""}${r.error ? " · 평가 오류, 재시도 필요" : ""}`,
    );
}
