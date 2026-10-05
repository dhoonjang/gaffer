import {
  playerOverall,
  type AttributeAxis,
  type AxisValues,
  ATTRIBUTE_AXES,
  ageOf,
  naturalPositionOf,
  isReserveMatch,
  RATING_MAX,
  type GamePlayer,
  observedOverall,
  clampCondition,
  conditionLabel,
  growthOutlookOf,
  type GrowthOutlook,
} from "@gaffer/domain";
import { type GameState, playerById, isOurPlayer } from "../core/state";
import { hashChannel } from "../core/rng";
import { GASSED_CONDITION } from "@gaffer/sim";

/** 감독이 그 선수를 얼마나 아는가 — 우리 선수 · 직접 상대해 본 선수 · 평판 */
export type Knowledge = "own" | "seen" | "rumoured";

export const KNOWLEDGE_KO: Record<Knowledge, string> = {
  own: "우리 선수",
  seen: "직접 상대해 본 선수",
  rumoured: "평판으로만 아는 선수",
};

/**
 * 축의 **관측 가능성** — 히든 레이어의 대체물 (player.md §9).
 * 경계선은 *실행 vs 판단*이다: 몸과 발로 하는 건 경기에서 드러나고,
 * 머리와 마음으로 하는 건 표본이 필요하다.
 */
type Observability = "observable" | "analytical";

const AXIS_OBSERVABILITY: Record<AttributeAxis, Observability> = {
  // 관측형 — 패스 성공률·파울 수처럼 한 경기에도 드러난다
  pace: "observable",
  stamina: "observable",
  strength: "observable",
  aerial: "observable",
  dribbling: "observable",
  passing: "observable",
  kicking: "observable",
  tackling: "observable",
  aggression: "observable",
  // GK는 매 경기 슛을 받으니 표본이 빨리 쌓인다
  goalkeeping: "observable",
  // 분석형 — 결정력은 경기당 유효 슈팅이 2~3회뿐이고, 위치선정·침투·시야는 화면 밖에서
  // 일어나며, 침착성·리더십은 큰 경기와 라커룸에서만 확인된다
  finishing: "analytical",
  vision: "analytical",
  positioning: "analytical",
  offTheBall: "analytical",
  composure: "analytical",
  leadership: "analytical",
};

/** 지식 수준별 표시 오차 (±) */
export const OBSERVATION_MARGIN: Record<Observability, Record<Knowledge, number>> = {
  observable: { own: 0, seen: 3, rumoured: 6 },
  analytical: { own: 0, seen: 6, rumoured: 10 },
};

/**
 * 이 축을 그 지식 수준에서 얼마나 틀리게 아는가.
 * 축이 아닌 합성값(`"overall"`)은 판단 계열을 포함하므로 **분석형**으로 다룬다 —
 * 종합 평가가 실행 계열보다 정확할 수는 없다.
 */
function marginFor(axis: string, knowledge: Knowledge): number {
  const layer = AXIS_OBSERVABILITY[axis as AttributeAxis] ?? "analytical";
  return OBSERVATION_MARGIN[layer][knowledge];
}

/** 실제로 적용되는 오차 */
export function observationMargin(
  state: GameState,
  playerId: string,
  axis: string,
  knowledge = knowledgeOf(state, playerId),
): number {
  return marginFor(axis, knowledge);
}

// ── 지식 수준 파생 ──────────────────────────────────────

/**
 * 우리와의 경기에서 그라운드를 밟은 걸 봤는가 — MATCH 결과의 출전 명단에서 파생.
 */
function hasSeenPlay(state: GameState, playerId: string): boolean {
  const player = playerById(state, playerId);
  if (!player) return false;
  for (const match of state.matches) {
    if (!match.result) continue;
    // 2군 경기는 감독이 보지 않는다 — 결과는 출전·성장에만 닿는다 (season.md §2)
    if (isReserveMatch(match)) continue;
    const userIsHome = match.homeTeamId === state.userTeamId;
    const userIsAway = match.awayTeamId === state.userTeamId;
    if (!userIsHome && !userIsAway) continue; // 우리가 없던 경기는 못 봤다
    const theirLineup = userIsHome ? match.result.awayLineup : match.result.homeLineup;
    if (theirLineup.includes(playerId)) return true;
  }
  return false;
}

export function knowledgeOf(state: GameState, playerId: string): Knowledge {
  const player = playerById(state, playerId);
  if (!player) return "rumoured";
  if (isOurPlayer(state, player)) return "own";
  if (hasSeenPlay(state, playerId)) return "seen";
  return "rumoured";
}

// ── 관측값 (결정적 오차) ────────────────────────────────

/** (seed, playerId, 능력치) → [-margin, +margin] 결정적 오프셋 */
function offsetFor(seed: number, playerId: string, attr: string, margin: number): number {
  if (margin <= 0) return 0;
  const h = hashChannel(`${seed}:${playerId}:${attr}`);
  return (h % (margin * 2 + 1)) - margin;
}

/** 안개가 낀 값의 아래끝 — 0은 "값이 없다"로 읽히므로 쓰지 않는다 */
const OBSERVED_RATING_MIN = 1;

/** 지식 수준을 반영한 관측 능력치 — 참값이 아니라 "감독이 그렇게 알고 있는 값" */
export function observedRating(
  state: GameState,
  playerId: string,
  attr: string,
  trueValue: number,
  knowledge = knowledgeOf(state, playerId),
): number {
  const margin = observationMargin(state, playerId, attr, knowledge);
  if (margin === 0) return trueValue;
  const offset = offsetFor(state.seed, playerId, attr, margin);
  return Math.max(OBSERVED_RATING_MIN, Math.min(RATING_MAX, trueValue + offset));
}

/**
 * **감독이 이 선수를 얼마나 정확히 아는가** — 화면과 서버가 같은 계산을 하기 위한 묶음.
 *
 * 서버가 `overall`·자리별 전력을 값마다 따로 관측값으로 바꿔 내려보내면,
 * 클라이언트가 자리를 옮겨 볼 때 같은 규칙을 재현할 수 없어(참값이 없으니)
 * "서버 값에 차이만 얹는" 보정이 필요해지고, 그 보정이 화면마다 달라 같은
 * 선수의 OVR이 명단과 전술판에서 갈린다.
 *
 * 그래서 안개는 **축에만** 씌우고(`AxisValues`가 이미 관측값이다) 합성값은 그
 * 축에서 파생시킨다 — 그러면 어느 자리로 옮겨 계산해도 서로 어긋날 수 없다.
 * `overallOffset`은 그 파생값에 얹는 **하나의** 오프셋이다: 축 평균만으로는
 * 오차가 상쇄돼(16축이 각자 흩어진다) 평판만 아는 선수의 종합이 실제보다
 * 정확해진다. 자리마다 같은 값이 얹히므로 **자리끼리의 비교는 흔들리지 않는다.**
 */
export interface Observation {
  knowledge: Knowledge;
  /**
   * 사람이 읽는 이름 — 화면이 코어를 import하지 않고 쓰기 위해 **함께 실어 보낸다**
   * (`speakerRoles`의 `{kind, label}`과 같은 결이다). 화면은 타입만 가져온다.
   */
  label: string;
  /** 종합값의 오차 폭 (±) — 0이면 정확히 안다 */
  margin: number;
  /** 종합·자리 전력에 얹는 결정적 오프셋 */
  overallOffset: number;
}

export function observationOf(state: GameState, playerId: string): Observation {
  return observationAt(state, playerId, knowledgeOf(state, playerId));
}

/** 그 지식 수준에서의 관측 — 종합과 자리 전력에 얹는 오프셋 하나까지 */
function observationAt(state: GameState, playerId: string, knowledge: Knowledge): Observation {
  const margin = observationMargin(state, playerId, "overall", knowledge);
  return {
    knowledge,
    label: KNOWLEDGE_KO[knowledge],
    margin,
    overallOffset: offsetFor(state.seed, playerId, "overall", margin),
  };
}

/** 유스 후보의 종합 오차 (±) — 훈련장에서 본 것이 전부라 우리 선수보다 넓다 */
const YOUTH_CANDIDATE_OVERALL_MARGIN = 3;

/** 유스 후보의 천장 오차 (±) — 아직 계약 전이라 잠재력을 정확히 모른다 */
const YOUTH_CANDIDATE_POTENTIAL_FUZZ = 4;

/**
 * **유스 후보의 안개** — 아직 우리 선수가 아니다 (season.md §6 · player.md §9.1).
 *
 * `state`가 아니라 시드만 받는 것은 후보가 `state.players`에 없기 때문이다 —
 * `knowledgeOf`가 그를 찾지 못한다. 오차는 `(seed, 선수 id)` 해시라 같은 후보를 몇
 * 번을 물어도 같은 값이 나온다.
 */
export function youthCandidateFog(
  seed: number,
  player: GamePlayer,
): { overall: number; growth: GrowthOutlook } {
  const overall = observedOverall(playerOverall(player), {
    overallOffset: offsetFor(seed, player.id, "overall", YOUTH_CANDIDATE_OVERALL_MARGIN),
  });
  const ceiling =
    player.attributes.potential +
    offsetFor(seed, player.id, "potential", YOUTH_CANDIDATE_POTENTIAL_FUZZ);
  return { overall, growth: growthOutlookOf(overall, ceiling) };
}

/**
 * 성장 가능성 — **우리 선수만 안다** (player.md §9.1). 16축이 정확한 것과 같이 우리
 * 훈련장은 잠재력도 안다. 남의 선수는 판단 보류(null)다.
 */
export function growthOutlook(
  state: GameState,
  player: GamePlayer,
  knowledge = knowledgeOf(state, player.id),
): GrowthOutlook | null {
  if (knowledge !== "own") return null;
  const overall = observedOverall(
    playerOverall(player),
    observationAt(state, player.id, knowledge),
  );
  return growthOutlookOf(overall, player.attributes.potential);
}

// ── 체력 (리포트가 아니라 눈으로 읽는다) ─────────────────

const CONDITION_UNCERTAINTY = {
  ours: { base: 2, perDrain: 0.15 },
  theirs: { base: 12, perDrain: 0.28 },
} as const;

/**
 * 이 선수의 체력을 얼마나 틀리게 읽는가 (반폭, 최소 1).
 * `drain`은 이 경기에서 소모한 양 — 경기 밖에서는 0이다.
 */
function conditionMargin(state: GameState, playerId: string, drain = 0): number {
  const ours = playerById(state, playerId)?.teamId === state.userTeamId;
  const { base, perDrain } = CONDITION_UNCERTAINTY[ours ? "ours" : "theirs"];
  return Math.max(1, Math.round(base + Math.max(0, drain) * perDrain));
}

/** 감독이 읽은 체력 — 참값은 언제나 [low, high] 안에 있다 */
export interface ConditionRead {
  /** 감독이 그렇게 알고 있는 값 */
  value: number;
  low: number;
  high: number;
  /** 추정 반폭 — 좁을수록 확신이 크다 */
  margin: number;
  /** 숫자 대신 남는 말 (domain의 `conditionLabel` — 화면마다 다르면 안 된다) */
  label: string;
}

/**
 * 체력을 읽는다 — 중심을 결정적으로 흔들고 폭을 펼치되 참값을 항상 품는다. 편향은 `matchKey`(보통 경기 id)마다 한 번 정해져 **경기 내내
 * 흔들리지 않는다** — 매 정지점마다 값이 튀면 감독은 상대가 지치는 중인지
 * 자기 눈이 흔들리는지 구분할 수 없다.
 *
 * `drain`은 이 경기에서 소모한 양이고, 폭이 그만큼 벌어진다 (`conditionMargin`).
 */
export function readCondition(
  state: GameState,
  playerId: string,
  trueValue: number,
  drain = 0,
  matchKey = "",
): ConditionRead {
  const margin = conditionMargin(state, playerId, drain);
  const clamp = clampCondition;
  const truth = clamp(trueValue);
  const drift = offsetFor(state.seed, playerId, `condition:${matchKey}`, Math.floor(margin / 2));
  const center = clamp(truth + drift);
  let low = Math.min(truth, clamp(center - margin));
  let high = Math.max(truth, clamp(center + margin));
  /**
   * **다리가 멈춘 건 눈에 보인다.** 걷기 시작한 윙어는 스탠드에서도 알아본다 —
   * 안개가 가리는 건 "얼마나 남았나"이지 "갔나 안 갔나"가 아니다. 그래서 추정
   * 구간은 문턱(`GASSED_CONDITION`)을 넘지 않는다: 넘게 두면 다리가 멈췄다고
   * 적힌 선수의 막대가 멀쩡해 보여 같은 화면이 두 말을 한다.
   */
  if (truth <= GASSED_CONDITION) high = Math.min(high, GASSED_CONDITION);
  else low = Math.max(low, GASSED_CONDITION + 1);
  const value = Math.max(low, Math.min(high, center));
  return { value, low, high, margin, label: conditionLabel(value) };
}

/** Shared observed facts for prose lookups and squad rows; neither renderer reads hidden axes. */
export function observedPlayerFacts(state: GameState, player: GamePlayer) {
  const knowledge = knowledgeOf(state, player.id);
  const observation = observationAt(state, player.id, knowledge);
  return {
    knowledge,
    observation,
    age: ageOf(player.birthdate, state.date),
    position: naturalPositionOf(player).position,
    overall: observedOverall(playerOverall(player), observation),
    growth: growthOutlook(state, player, knowledge),
    attributes: Object.fromEntries(
      ATTRIBUTE_AXES.map((axis) => [
        axis,
        observedRating(state, player.id, axis, player.attributes[axis], knowledge),
      ]),
    ) as AxisValues,
  };
}
export type ObservedPlayerFacts = ReturnType<typeof observedPlayerFacts>;
