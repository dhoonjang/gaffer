import {
  type AttributeAxis,
  type AxisValues,
  ATTRIBUTE_AXES,
  ageOf,
  naturalPositionOf,
  type ScoutingReport,
  isReserveMatch,
  RATING_MAX,
  type GamePlayer,
  observedOverall,
  clampCondition,
  conditionLabel,
} from "@story-fm/domain";
import { type GameState, playerById, isOurPlayer } from "../core/state";
import { settlingOf, isSettling } from "./settling";
import { hashChannel } from "../core/rng";
import { GASSED_CONDITION } from "@story-fm/sim";

/** Shared display of club observations and dated investigation results. */
export type Knowledge = "own" | "adapting" | "scouted" | "seen" | "rumoured";

export const KNOWLEDGE_KO: Record<Knowledge, string> = {
  own: "우리 선수",
  adapting: "적응 중인 새 영입",
  scouted: "스카우팅 완료",
  seen: "직접 상대해 본 선수",
  rumoured: "평판으로만 아는 선수",
};

/**
 * 축의 **관측 가능성** — 히든 레이어의 대체물 (player.md §9).
 * 경계선은 *실행 vs 판단*이다: 몸과 발로 하는 건 경기에서 드러나고,
 * 머리와 마음으로 하는 건 표본이 필요하다.
 */
export type Observability = "observable" | "analytical";

export const AXIS_OBSERVABILITY: Record<AttributeAxis, Observability> = {
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

/** Club and public display uncertainty. Recorded scouting ranges take precedence per field. */
export const OBSERVATION_MARGIN: Record<Observability, Record<Knowledge, number>> = {
  // Settling changes internal club knowledge; a report does not unlock unknown axes.
  observable: { own: 0, adapting: 1, scouted: 6, seen: 3, rumoured: 6 },
  analytical: { own: 0, adapting: 3, scouted: 10, seen: 6, rumoured: 10 },
};

/**
 * 이 축을 그 지식 수준에서 얼마나 틀리게 아는가.
 * 축이 아닌 합성값(`"overall"`)은 판단 계열을 포함하므로 **분석형**으로 다룬다 —
 * 종합 평가가 실행 계열보다 정확할 수는 없다.
 */
export function marginFor(axis: string, knowledge: Knowledge): number {
  const layer = AXIS_OBSERVABILITY[axis as AttributeAxis] ?? "analytical";
  return OBSERVATION_MARGIN[layer][knowledge];
}

/**
 * 실제로 적용되는 오차 — 적응 중이면 **진행도만큼 걷힌다.**
 *
 * 안개가 날짜로 걷히면 감독이 할 수 있는 일이 없다. 경기에 내보내고 훈련을
 * 시킬수록 그 선수가 어떤 선수인지 알게 된다 — 그게 "데려와 봐야 안다"의
 * 실제 형태다 (adaptation.ts).
 */
export function observationMargin(
  state: GameState,
  playerId: string,
  axis: string,
  knowledge = knowledgeOf(state, playerId),
): number {
  const recorded = knowledge === "scouted" ? observedRange(state, playerId, axis) : null;
  if (recorded) return (recorded.high - recorded.low) / 2;
  const base = marginFor(axis, knowledge);
  if (knowledge !== "adapting") return base;
  const a = settlingOf(state, playerId);
  if (!a || a.done) return 0;
  return Math.round(base * (1 - a.progress));
}

// ── 지식 수준 파생 ──────────────────────────────────────

export function scoutReportOf(state: GameState, playerId: string): ScoutingReport | null {
  return (
    [...state.scoutReports]
      .reverse()
      .find((r) => r.candidates.some((c) => c.evidence.playerId === playerId)) ?? null
  );
}

function recordedAssessment(state: GameState, playerId: string) {
  return scoutReportOf(state, playerId)?.candidates.find((c) => c.evidence.playerId === playerId)
    ?.assessment;
}

function observedRange(state: GameState, playerId: string, axis: string) {
  const assessment = recordedAssessment(state, playerId);
  return axis === "overall" ? assessment?.overall : assessment?.attributes[axis];
}

export function isScouted(state: GameState, playerId: string): boolean {
  return scoutReportOf(state, playerId) !== null;
}

/**
 * 우리와의 경기에서 그라운드를 밟은 걸 봤는가 — MATCH 결과의 출전 명단에서 파생.
 */
export function hasSeenPlay(state: GameState, playerId: string): boolean {
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
  /**
   * **소속이 아니라 계약을 읽는다** (player.md §9). 임대 보낸 선수는 남에게 준 것이
   * 아니라 남의 경기장에 보낸 것이라, 우리 코치진은 스카우팅과 무관하게 그를 안다 —
   * `teamId`로 가르면 우리 계약의 유망주가 나가는 순간 능력치에 오차가 붙어, 돌아온
   * 날 감독이 "누가 얼마나 자랐는가"를 잃는다.
   */
  if (isOurPlayer(state, player)) {
    return isSettling(state, playerId) ? "adapting" : "own";
  }
  if (isScouted(state, playerId)) return "scouted";
  if (hasSeenPlay(state, playerId)) return "seen";
  return "rumoured";
}

// ── 관측값 (결정적 오차) ────────────────────────────────

/** (seed, playerId, 능력치) → [-margin, +margin] 결정적 오프셋 */
export function offsetFor(seed: number, playerId: string, attr: string, margin: number): number {
  if (margin <= 0) return 0;
  const h = hashChannel(`${seed}:${playerId}:${attr}`);
  return (h % (margin * 2 + 1)) - margin;
}

/** 안개가 낀 값의 아래끝 — 0은 "값이 없다"로 읽히므로 쓰지 않는다 */
export const OBSERVED_RATING_MIN = 1;

/** 지식 수준을 반영한 관측 능력치 — 참값이 아니라 "감독이 그렇게 알고 있는 값" */
export function observedRating(
  state: GameState,
  playerId: string,
  attr: string,
  trueValue: number,
  knowledge = knowledgeOf(state, playerId),
): number {
  const recorded = knowledge === "scouted" ? observedRange(state, playerId, attr) : null;
  if (recorded) return Math.round((recorded.low + recorded.high) / 2);
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

/** Use the dated report estimate when available, otherwise retain existing public observations. */
export function observationAt(
  state: GameState,
  playerId: string,
  knowledge: Knowledge,
): Observation {
  const margin = observationMargin(state, playerId, "overall", knowledge);
  const recorded = knowledge === "scouted" ? observedRange(state, playerId, "overall") : null;
  const player = playerById(state, playerId);
  return {
    knowledge,
    label: KNOWLEDGE_KO[knowledge],
    margin,
    overallOffset:
      recorded && player
        ? Math.round((recorded.low + recorded.high) / 2) - player.attributes.overall
        : offsetFor(state.seed, playerId, "overall", margin),
  };
}

/**
 * 잠재력 — **아무도 단정하지 못한다.** 구간 + 확신의 정도로 말한다.
 * 우리 선수는 데리고 뛸수록, 타 팀 선수는 근거가 담긴 새 보고서에서만 달라진다.
 */
/** 추정 폭이 이 안이면 그 말로 부른다 — 넘으면 "대강 짐작"이다 */
export const CONFIDENCE_MARGIN = { 거의확실: 3, 대체로신뢰: 6 } as const;

/** 추정 폭을 부르는 말 — 구간을 내는 자리는 모두 이 함수를 지난다 */
export function potentialConfidence(margin: number): string {
  if (margin <= CONFIDENCE_MARGIN.거의확실) return "거의 확실";
  if (margin <= CONFIDENCE_MARGIN.대체로신뢰) return "대체로 신뢰";
  return "대강 짐작";
}

/**
 * **유스 후보의 안개** — 아직 우리 선수가 아니다 (season.md §6 · player.md §9).
 *
 * 계약서에 사인하기 전이라 훈련장에서 본 것이 전부인데, 그것은 갓 영입한 선수의
 * 처지와 같다 — 그래서 `adapting` 눈금을 그대로 읽는다. 다만 좁혀 줄 정착 진행도가
 * 없으므로 폭은 **출발 폭 그대로** 선다(`observationMargin`이 정착 row를 못 찾으면
 * 0을 내므로 그 문을 지나지 않는다).
 *
 * `state`가 아니라 시드만 받는 것은 후보가 `state.players`에 없기 때문이다 —
 * `knowledgeOf`도 `settlingOf`도 그를 찾지 못한다. 오차는 `(seed, 선수 id)` 해시라
 * 같은 후보를 몇 번을 물어도 같은 구간이 나온다.
 */
export function youthCandidateFog(
  seed: number,
  player: GamePlayer,
): { overall: number; potential: PotentialBand } {
  const knowledge: Knowledge = "adapting";
  const overallMargin = marginFor("overall", knowledge);
  const overall = observedOverall(player.attributes.overall, {
    overallOffset: offsetFor(seed, player.id, "overall", overallMargin),
  });
  // `adapting`은 표에서 결코 `null`이 아니다 — 폭을 짐작조차 못 하는 것은 `rumoured`뿐이다
  const margin = POTENTIAL_MARGIN[knowledge] ?? POTENTIAL_FLOOR;
  const truth = player.attributes.potential;
  const center = truth + offsetFor(seed, player.id, "potential", Math.floor(margin / 2));
  return {
    overall,
    potential: {
      // 하한은 관측 종합 아래로 내려가지 않는다 — 이미 가진 것을 못 가질 수는 없다
      low: Math.max(Math.min(truth, overall), center - margin),
      high: Math.min(99, Math.max(truth, center + margin)),
      margin,
      confidence: potentialConfidence(margin),
    },
  };
}

// ── 잠재력 (폭으로만 안다) ──────────────────────────────
/**
 * 잠재력 추정 폭 — 지식 수준별 **출발점**. 여기서부터 표본이 쌓이면 좁아진다.
 * `null`은 짐작조차 못 한다는 뜻이다.
 */
export const POTENTIAL_MARGIN: Record<Knowledge, number | null> = {
  own: 6,
  // 계약서에 사인해도 훈련장에서 본 게 전부다 — 출전이 쌓이면 우리 선수와 같아진다
  adapting: 9,
  scouted: null,
  seen: null,
  rumoured: null,
};

/** 아무리 봐도 이 아래로는 못 좁힌다 — 성장 여력은 끝까지 단정할 수 없다 */
export const POTENTIAL_FLOOR = 2;

/** Club appearances narrow internal development observations. */
export const POTENTIAL_APPS_PER_STEP = 10;

/**
 * **우리 셔츠로** 뛴 총 경기 수 — 잠재력을 좁히는 표본 (시즌을 넘어 누적).
 *
 * 임대 나간 선수는 지식이 `own`이어도 그 구단의 출전으로는 폭이 좁아지지 않는다 —
 * 매일 보는 것과 리포트로 받는 것은 같은 표본이 아니다 (player.md §9.1).
 */
export function appsForUs(state: GameState, playerId: string): number {
  return state.seasonStats
    .filter((s) => s.gamePlayerId === playerId && s.teamId === state.userTeamId)
    .reduce((sum, s) => sum + s.apps, 0);
}

/** 지금 이 선수의 잠재력을 얼마나 좁혀 아는가 (null = 미지) */
export function potentialMargin(
  state: GameState,
  playerId: string,
  knowledge = knowledgeOf(state, playerId),
): number | null {
  if (knowledge !== "own" && knowledge !== "adapting") {
    const band = recordedAssessment(state, playerId)?.potential;
    return band ? (band.high - band.low) / 2 : null;
  }
  const base = POTENTIAL_MARGIN[knowledge];
  if (base === null) return null;
  if (knowledge === "own" || knowledge === "adapting") {
    const narrowed = base - Math.floor(appsForUs(state, playerId) / POTENTIAL_APPS_PER_STEP);
    return Math.max(POTENTIAL_FLOOR, narrowed);
  }
  return base;
}

export interface PotentialBand {
  low: number;
  high: number;
  /** 추정 반폭 — 좁을수록 확신이 크다 */
  margin: number;
  /**
   * 그 폭을 부르는 말 — `거의 확실` · `대체로 신뢰` · `대강 짐작` (player.md §9.1).
   * 구간과 **함께** 낸다: 경계는 코어의 것이고, 읽는 쪽이 폭을 다시 재면 표를 고치는
   * 날 한쪽만 따라간다.
   */
  confidence: string;
}

/** External estimates are stored observations; club development observations remain internal. */
export function potentialBand(
  state: GameState,
  player: GamePlayer,
  knowledge = knowledgeOf(state, player.id),
): PotentialBand | null {
  if (knowledge !== "own" && knowledge !== "adapting") {
    const band = recordedAssessment(state, player.id)?.potential;
    return band
      ? { ...band, margin: (band.high - band.low) / 2, confidence: "조사 근거에 따른 추정" }
      : null;
  }
  const margin = potentialMargin(state, player.id, knowledge);
  if (margin === null) return null;
  const truth = player.attributes.potential;
  const center = truth + offsetFor(state.seed, player.id, "potential", Math.floor(margin / 2));
  const floor = Math.min(
    truth,
    observedOverall(player.attributes.overall, observationAt(state, player.id, knowledge)),
  );
  return {
    low: Math.max(floor, center - margin),
    high: Math.min(99, Math.max(truth, center + margin)),
    margin,
    confidence: potentialConfidence(margin),
  };
}

// ── 체력 (리포트가 아니라 눈으로 읽는다) ─────────────────

export const CONDITION_UNCERTAINTY = {
  ours: { base: 2, perDrain: 0.15 },
  theirs: { base: 12, perDrain: 0.28 },
} as const;

/**
 * 이 선수의 체력을 얼마나 틀리게 읽는가 (반폭, 최소 1).
 * `drain`은 이 경기에서 소모한 양 — 경기 밖에서는 0이다.
 */
export function conditionMargin(state: GameState, playerId: string, drain = 0): number {
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
 * 체력을 읽는다 — 잠재력 구간과 같은 모양이다(중심을 결정적으로 흔들고 폭을 펼치되
 * 참값을 항상 품는다). 편향은 `matchKey`(보통 경기 id)마다 한 번 정해져 **경기 내내
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
    overall: observedOverall(player.attributes.overall, observation),
    potential: potentialBand(state, player, knowledge),
    attributes: Object.fromEntries(
      ATTRIBUTE_AXES.map((axis) => [
        axis,
        observedRating(state, player.id, axis, player.attributes[axis], knowledge),
      ]),
    ) as AxisValues,
  };
}
export type ObservedPlayerFacts = ReturnType<typeof observedPlayerFacts>;
