import {
  ATTRIBUTE_AXES,
  type AttributeAxis,
  AXIS_KO,
  type GamePlayer,
  naturalPositionOf,
  ratingLabel,
  clampCondition,
  conditionLabel,
} from "@gaffer/domain";
import { type GameState } from "../core/state";
import {
  type Knowledge,
  knowledgeOf,
  OBSERVATION_MARGIN,
  observationMargin,
  type ObservedPlayerFacts,
  observedPlayerFacts,
  observedRating,
  type ConditionRead,
  readCondition,
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
const KNOWLEDGE_MARGIN: Record<Knowledge, number> = OBSERVATION_MARGIN.observable;

interface ObservedAttribute {
  key: AttributeAxis;
  ko: string;
  /** 안개가 없을 때만 숫자 — 있으면 null (라벨만 노출) */
  exact: number | null;
  label: string;
}

/** 능력치 16축을 지식 수준 × 축별 관측 가능성에 맞춰 노출 */
function observedAttributes(
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

export function growthView(
  state: GameState,
  player: GamePlayer,
  facts: ObservedPlayerFacts = observedPlayerFacts(state, player),
): string {
  return facts.growth?.label ?? "판단 보류";
}

/** 한 줄 요약이 꼽는 강점·약점 축의 수 */
const HIGHLIGHT_AXES = 2;

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
 * 안내문이 성장 가능성에 대해 할 수 있는 말 — **실제로 주는 것과 어긋나면 안 된다.**
 * 등급을 주면서 "알 수 없다"고 하면 모델이 손에 든 정보를 버린다 (player.md §10).
 */
function growthNote(knowledge: Knowledge): string {
  return knowledge === "own" ? "성장 가능성은 등급으로 안다" : "성장 가능성은 판단할 근거가 없다";
}

/**
 * 안개 상태 **카드** — 눈금·오차폭·성장 가능성을 아는가의 사실만 싣는다.
 *
 * ⚠️ **지시문은 여기 서지 않는다.** 눈금이 낮을 때 어떻게 말할지는 그 선수에 대한
 * 사실이 아니라 모델에게 내리는 지시라 GM 시스템 프롬프트가 한 줄로 갖는다
 * (player.md §10, agents/prompts.md §5).
 */
export function knowledgeNote(state: GameState, playerId: string): string {
  const knowledge = knowledgeOf(state, playerId);
  const growth = growthNote(knowledge);
  if (knowledge === "own") return `우리 선수 — 능력치는 정확하다 · ${growth}`;
  const margin = KNOWLEDGE_MARGIN[knowledge];
  const analytical = OBSERVATION_MARGIN.analytical[knowledge];
  const source = knowledge === "seen" ? "직접 상대해 봤다" : "리그 평판·소문 수준";
  return `${source} — 평가에 오차가 있다(실행 ±${margin} · 판단 ±${analytical}). ${growth}`;
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

/**
 * 화면에 서는 체력 — **판세 탭과 팀 탭이 이 함수 하나를 지난다.**
 *
 * 경기 중이면 저장값에서 이 경기가 가져간 만큼을 뺀 지금 값에 안개를 씌운다
 * (`readCondition` · player.md §9.2) — 뛰는 동안 남은 다리는 아무도 못 재기
 * 때문이다. 두 탭이 같은 인자로 이 문을 지나므로 같은 선수가 두 숫자로 보이지
 * 않고, 팀 탭이 참값을 쓰던 시절처럼 **두 탭을 견줘 안개를 걷을 수도 없다.**
 *
 * `live`가 없으면(경기 밖 · 출전 명단 밖) 아침에 잰 값 그대로라 폭이 0이다 —
 * 그때는 읽은 값이 아니라 잰 값이다.
 */
export function conditionShown(
  state: GameState,
  playerId: string,
  saved: number,
  live: { drain: number; matchId: string } | null,
): ConditionRead {
  if (!live) {
    const value = clampCondition(saved);
    return { value, low: value, high: value, margin: 0, label: conditionLabel(value) };
  }
  return readCondition(state, playerId, Math.max(0, saved - live.drain), live.drain, live.matchId);
}
