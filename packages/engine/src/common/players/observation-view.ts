import {
  ATTRIBUTE_AXES,
  type AttributeAxis,
  AXIS_KO,
  type GamePlayer,
  naturalPositionOf,
  ratingLabel,
} from "@story-fm/domain";
import { type GameState } from "../core/state";
import {
  type Knowledge,
  knowledgeOf,
  OBSERVATION_MARGIN,
  observationMargin,
  type ObservedPlayerFacts,
  observedPlayerFacts,
  observedRating,
  potentialMargin,
} from "./observation";

/**
 * 눈금의 순서 — **얼마나 아는가**로 줄을 세운다. `OBSERVATION_MARGIN`이 좁아지는
 * 순서 그대로다. "직접 본 선수만"처럼 **최소 수준**을 묻는 자리가 이 자를 읽는다.
 */
export const KNOWLEDGE_RANK: Record<Knowledge, number> = {
  rumoured: 0,
  seen: 1,
  own: 2,
};

/** 실행 계열의 오차 — 안개 안내문이 "무엇까지 믿어도 되나"를 말할 때 쓴다 */
export const KNOWLEDGE_MARGIN: Record<Knowledge, number> = OBSERVATION_MARGIN.observable;

export interface ObservedAttribute {
  key: AttributeAxis;
  ko: string;
  /** 안개가 없을 때만 숫자 — 있으면 null (라벨만 노출) */
  exact: number | null;
  label: string;
}

/** 능력치 16축을 지식 수준 × 축별 관측 가능성에 맞춰 노출 */
export function observedAttributes(
  state: GameState,
  player: GamePlayer,
  facts: ObservedPlayerFacts = observedPlayerFacts(state, player),
): ObservedAttribute[] {
  const { knowledge } = facts;
  return ATTRIBUTE_AXES.map((key) => ({
    key,
    ko: AXIS_KO[key],
    exact: observationMargin(state, player.id, key, knowledge) === 0 ? facts.attributes[key] : null,
    label: ratingLabel(facts.attributes[key]),
  }));
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
  return observedAttributes(state, player, facts)
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
 * 안개 상태 **카드** — 눈금·오차폭·잠재력 마진의 사실만 싣는다.
 *
 * ⚠️ **지시문은 여기 서지 않는다.** 눈금이 낮을 때 어떻게 말할지는 그 선수에 대한
 * 사실이 아니라 모델에게 내리는 지시라 GM 시스템 프롬프트가 한 줄로 갖는다
 * (player.md §10, llm/prompts.md §5).
 */
export function knowledgeNote(state: GameState, playerId: string): string {
  const knowledge = knowledgeOf(state, playerId);
  const potential = potentialNote(state, playerId, knowledge);
  if (knowledge === "own") return `우리 선수 — 능력치는 정확하다 · ${potential}`;
  const margin = KNOWLEDGE_MARGIN[knowledge];
  const analytical = OBSERVATION_MARGIN.analytical[knowledge];
  const source = knowledge === "seen" ? "직접 상대해 봤다" : "리그 평판·소문 수준";
  return `${source} — 평가에 오차가 있다(실행 ±${margin} · 판단 ±${analytical}). ${potential}`;
}

/** 강점·약점 지목 — seen 이상에서만 의미가 있다 (관측값 기준) */
export function strengthsAndWeaknesses(
  state: GameState,
  player: GamePlayer,
): { strengths: string[]; weaknesses: string[] } {
  const knowledge = knowledgeOf(state, player.id);
  const ranked = ATTRIBUTE_AXES.filter(
    (k) => k !== "goalkeeping" || naturalPositionOf(player).position === "GK",
  )
    .map((key) => ({
      key,
      value: observedRating(state, player.id, key, player.attributes[key], knowledge),
    }))
    .sort((a, b) => b.value - a.value);
  return {
    strengths: ranked.slice(0, HIGHLIGHT_AXES).map((r) => AXIS_KO[r.key]),
    weaknesses: ranked
      .slice(-HIGHLIGHT_AXES)
      .reverse()
      .map((r) => AXIS_KO[r.key]),
  };
}
