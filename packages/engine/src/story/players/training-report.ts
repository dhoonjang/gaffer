import {
  type GameState,
  seasonStatOf,
  squadLevelOf,
  isAvailable,
  assignmentsOf,
  latestTrainingReport,
  teamNameIn,
  recordTrainingReport,
} from "../../common/core/state";
import {
  playerOverall,
  seasonRating,
  type GamePlayer,
  attributeAxisOf,
  ageOf,
  type TrainingReport,
  type TrainAttr,
  type AttributeAxis,
  type TrainingMark,
  TRAINING_MARKS,
} from "@story-fm/domain";
import { turnFactLines } from "../../common/core/turn-facts";
import { SESSIONS_PER_WEEK } from "./training-plan";

/** 이번 시즌 기록 — 훈련장 밖의 맥락 */
export function statOf(state: GameState, playerId: string) {
  return seasonStatOf(state, playerId);
}

export function ratingOf(state: GameState, playerId: string): number | null {
  const stat = seasonStatOf(state, playerId);
  return stat ? seasonRating(stat) : null;
}

/**
 * **오늘 감독이 훈련에서 뺀 선수인가** (→ docs/common/season.md §4).
 *
 * 개인 휴식은 기간이라 「걸려 있다」와 「오늘 해당한다」가 다르다 — 기한이 지난 프로그램은
 * 지우지 않고 그냥 지나가므로, 묻는 자리는 전부 **날짜와 함께** 묻는다.
 */
export function restingOn(state: GameState, playerId: string, on = state.date): boolean {
  const until = state.playerTraining.find((t) => t.gamePlayerId === playerId)?.rest?.until;
  return until !== undefined && on <= until;
}

/**
 * **그 구간 훈련장에 선 선수인가** — 결산도 훈련 부상도 이 문 하나를 지난다
 * (→ docs/common/season.md §4·§8 불변식).
 *
 * 1군만 훈련장에 선다 — 2군은 코어 월간 성장으로 자란다(season.md §2). 재활 중이거나
 * 출장 정지인 선수는 팀과 함께 보내지 않았다(player.md §6.1). **감독이 기간을 정해
 * 훈련에서 뺀 선수**도 같다 — 훈련장에 서지 않았으니 결산의 대상도 훈련 부상의
 * 후보도 아니다. 두 문이 갈리면 훈련 부상만 맞고 결산은 받지 못하는 선수가 생긴다.
 */
export function trainsWithFirstTeam(state: GameState, player: GamePlayer): boolean {
  return (
    player.teamId === state.userTeamId &&
    squadLevelOf(player) === "first" &&
    isAvailable(state, player) &&
    !restingOn(state, player.id)
  );
}

/** 결산 브리프를 짓는다 — 없으면 null (훈련이 없었던 구간) */
export function buildTrainingBrief(
  state: GameState,
  sessions: TrainedSession[],
  window: { from: string; to: string },
): TrainingBrief | null {
  if (sessions.length === 0) return null;
  const assignments = new Map(
    assignmentsOf(state, state.userTeamId).map((a) => [a.playerId, a] as const),
  );
  const subjects: TrainingSubject[] = [];
  const axes = teamAxesOf(sessions);
  for (const player of state.players) {
    if (!trainsWithFirstTeam(state, player)) continue;
    const assignment = assignments.get(player.id);
    const program = state.playerTraining.find((t) => t.gamePlayerId === player.id);
    // 개인 훈련 축은 팀 세션에 없어도 그 선수의 허용 축이다 — 판정자에게도 알린다
    const personal = attributeAxisOf(program?.axis);
    if (personal) axes.add(personal);
    subjects.push({
      program: program
        ? {
            ...(program.axis ? { axis: program.axis } : {}),
            ...(program.position ? { position: program.position } : {}),
          }
        : null,
      playerId: player.id,
      name: player.name,
      age: ageOf(player.birthdate, state.date),
      position: assignment?.position ?? player.positions[0]?.position ?? "?",
      familiarity: assignment?.familiarity ?? 0,
      condition: player.state.condition,
      form: Math.round(player.state.form * 100) / 100,
      room: Math.max(0, player.attributes.potential - playerOverall(player)),
      overall: playerOverall(player),
      apps: statOf(state, player.id)?.apps ?? 0,
      rating: ratingOf(state, player.id),
    });
  }
  if (subjects.length === 0) return null;

  /**
   * 대화 창의 시작 — **마지막 결산 카드의 끝 날짜**, 없으면 이 턴의 시작.
   *
   * 이 턴이 시작한 날짜로 자르면 시계가 움직이지 않은 턴이 이어지거나 훈련 없는
   * 구간이 끼었을 때 그 사이의 대화가 어느 브리프에도 실리지 않는다 — 감독이
   * 걸어 둔 주문이 판정에 닿지 않는 자리다. 결산 카드는 판정이 돌지 않은 구간에도
   * 서므로 이 기준은 언제나 있다 (docs/common/season.md §4). 카드는 이 턴의
   * 모델 장면이 `state.chat`에 실리기 **전에** 서므로, 그 장면은 다음 브리프의
   * 첫 줄이 된다 — 같은 턴이 두 결산에 겹쳐 실리지 않는다.
   */
  const lastSettled = latestTrainingReport(state)?.to;
  const chatFrom =
    lastSettled !== undefined && lastSettled < window.from ? lastSettled : window.from;

  return {
    teamName: teamNameIn(state, state.userTeamId),
    from: window.from,
    to: window.to,
    sessions,
    subjects,
    /**
     * **지난 결산 이후**의 대화 — 판정자가 "감독이 무엇을 주문했나"를 읽는 자리다.
     * **화면 조작(`operator`)은 뺀다** — 시간 이동 손잡이는 감독의 말이 아니라
     * 훈련 의도와 아무 상관이 없는데, 섞이면 판정자가 그것도 지시로 읽는다.
     */
    chat: state.chat
      .filter((t) => t.at >= chatFrom && t.role !== "operator")
      .slice(-CHAT_KEEP)
      .map((t) => ({
        at: t.at,
        role: t.role as "user" | "model",
        text: t.text.slice(0, CHAT_LINE_MAX),
        facts: turnFactLines(t),
      })),
    trainedAxes: [...axes],
  };
}

/**
 * 아직 결산이 얹히지 않은 훈련 세션 — 표식은 일정 엔트리의 `settled`다.
 *
 * 엔트리를 찾지 못한 세션(합성 브리프)은 표식을 남길 자리가 없어 언제나
 * 미반영으로 센다 — 자리 없는 브리프까지 막으면 결산이 아예 돌지 않는다.
 */
export function unsettledSessions(state: GameState, brief: TrainingBrief): TrainedSession[] {
  return brief.sessions.filter((s) => {
    const entry = state.schedule.find((e) => e.id === s.entryId);
    return entry === undefined || entry.settled !== true;
  });
}

/**
 * 이 구간의 훈련이 **전부** 이미 반영됐나 — 도구 핸들러와 재시도 가드가 보는 값.
 *
 * 요약 줄의 유무로는 가를 수 없다: 적응도가 소수로만 움직인 구간은 줄이 하나도
 * 없지만 장부는 이미 움직였다.
 */
export function trainingSettled(state: GameState, brief: TrainingBrief): boolean {
  return unsettledSessions(state, brief).length === 0;
}

/**
 * 판정이 한 번도 닿지 않은 구간의 카드 — **빈 결산.**
 *
 * mock 모드거나 모델이 두 번 다 실패한 구간이다. "장부가 움직이지 않았다"는 것이
 * 사실이고, 카드가 없으면 다음 턴의 GM은 훈련장에서 무슨 일이 있었는지 지어낸다
 * (docs/common/season.md §4).
 *
 * ⚠️ **반영 표식(`settled`)은 세우지 않는다** — 장부는 정말로 움직이지 않았다.
 * 실패한 판정을 "반영됨"으로 적으면 표식이 카드와 다른 말을 한다.
 */
export function recordEmptyTrainingReport(state: GameState, brief: TrainingBrief): TrainingReport {
  return cardFor(state, brief, [], []);
}

/** 카드 한 장을 지어 장부에 얹는다 — 구간의 꼴은 여기 한 곳에서 정해진다 */
export function cardFor(
  state: GameState,
  brief: TrainingBrief,
  moved: TrainingReport["moved"],
  marks: TrainingReport["marks"],
): TrainingReport {
  const report: TrainingReport = {
    from: brief.from,
    to: brief.to,
    sessions: brief.sessions.length,
    moved,
    marks,
  };
  recordTrainingReport(state, report);
  return report;
}

/**
 * 전향 훈련이 한 결산에서 올릴 수 있는 최대 폭 — 판정의 눈금이자 반영의 천장이다.
 * 경기 한 번이 +1이니 며칠치 훈련이 그보다 크게 오르지 않는다. 여러 주를 한 번에
 * 넘긴 구간의 나머지는 캐리에 남아 다음 결산에서 나간다.
 */
export const POSITION_TRAIN_MAX = 2;

/**
 * **한 주치** 훈련이 전술 적응도에 남기는 폭 — **−1 ~ 3 중 하나**.
 *
 * 눈금을 잘게 두는 이유는 빈도다. `advance_time`은 시즌에 수십 번 돌고, 한 번에 크게
 * 움직일 수 있으면 게임이 흔들린다. **−1**을 둔 건 훈련이 늘 남기는 건 아니기
 * 때문이다 — 지친 선수를 굴리면 오히려 흐트러진다.
 *
 * 판정자는 구간의 길이와 상관없이 이 사다리를 그대로 내고, 실제 폭은 코어가
 * 훈련 날짜마다 `settlementWeeks()`로 접어 나눠 반영한다.
 */
export const TACTIC_GAIN_MIN = -1;

export const TACTIC_GAIN_MAX = 3;

/** 능력치를 움직일 수 있는 인원 — **훈련 날짜(칸)마다** 선다 (player.md §6.1) */
export const TRAINING_ATTR_CAP = 6;

/** 한 결산 판정이 실을 수 있는 질문 수 — 평가기 한 요청의 한도다 (agents.md §4) */
export const TRAINING_QUESTION_LIMIT = 512;

/** 날짜와 무관하게 선수마다 서는 질문 — 전술 적응도 · 태도 (전향 중이면 자리가 하나 더) */
const SUBJECT_QUESTIONS = 2;

/**
 * 능력치 판정의 칸 하나 — 이어진 훈련 날짜 하나 이상. 판정은 칸의 마지막 날짜에 남고,
 * 폭은 칸에 든 세션 수가 정한다.
 */
export interface TrainingSlot {
  /** 칸의 마지막 훈련 날짜 — 판정이 장부에 서는 날 */
  date: string;
  dates: string[];
  sessions: number;
}

/**
 * 훈련 날짜 → 능력치 판정 칸. **날짜마다 한 칸이 기본이다** — 질문이
 * `TRAINING_QUESTION_LIMIT`을 넘을 때만 이어진 날짜를 고르게 합친다. 판정자와 코어가
 * 이 함수 하나를 읽으므로 칸이 두 벌로 갈리지 않는다.
 */
export function trainingSlots(brief: TrainingBrief): TrainingSlot[] {
  const byDate = new Map<string, number>();
  for (const s of brief.sessions) byDate.set(s.date, (byDate.get(s.date) ?? 0) + 1);
  const dates = [...byDate.keys()];
  if (dates.length === 0) return [];
  const fixed = brief.subjects.reduce(
    (n, subject) => n + SUBJECT_QUESTIONS + (subject.program?.position ? 1 : 0),
    0,
  );
  const room = Math.floor((TRAINING_QUESTION_LIMIT - fixed) / Math.max(1, brief.subjects.length));
  const count = Math.max(1, Math.min(dates.length, room));
  return Array.from({ length: count }, (_, k) => {
    const group = dates.slice(
      Math.floor((k * dates.length) / count),
      Math.floor(((k + 1) * dates.length) / count),
    );
    return {
      date: group[group.length - 1]!,
      dates: group,
      sessions: group.reduce((n, d) => n + byDate.get(d)!, 0),
    };
  });
}

/**
 * 이 결산이 덮는 **주 수** — 판정의 눈금을 실제 폭으로 접는 배율이다.
 *
 * 결산은 **턴이 넘긴 구간**마다 돈다(`buildTrainingBrief` 호출 자리 — agents.md §4).
 * 폭이 결산당 고정이면 같은 한 주도 손잡이로 넘기면 한 번, 장면 헤더로 하루씩 가면
 * 다섯 번 매겨져 **감독의 턴 페이스가 성장 속도를 정한다.** 그래서 판정자는 한 주치
 * 사다리를 그대로 내고(`TACTIC_GAIN_MAX` · `ATTR_STEP_MAX` · `POSITION_TRAIN_MAX`),
 * 코어가 여기에 이 배율을 곱한다 — 하루치는 0.2, 한 주치는 1, 한 달치는 4쯤.
 *
 * ⚠️ **위로 자르지 않는다.** 스무 세션은 어떻게 쪼개도 스무 세션이고, 천장을 두면
 * 이번엔 큰 걸음이 손해를 봐 페이스가 다시 성장 속도를 정한다. 한 번에 넘어가는
 * 눈금은 반영하는 쪽이 잡는다 (능력치는 한 칸, 자리는 `POSITION_TRAIN_MAX`).
 */
export function settlementWeeks(sessions: number): number {
  return sessions / SESSIONS_PER_WEEK;
}

/** 이 구간에 소화된 훈련 세션 하나 */
export interface TrainedSession {
  /** 일정 축의 엔트리 id — 성장 로그가 출처를 가리킬 수 있게 */
  entryId: string;
  date: string;
  slot: "am" | "pm";
  label: string;
  focus: TrainAttr[];
  /** 감독이 직접 지시한 세션인가 — 기본 훈련과 구분해 판정 근거로 준다 */
  ordered: boolean;
}

/** 판정에 넘길 선수 한 명 */
export interface TrainingSubject {
  playerId: string;
  name: string;
  age: number;
  position: string;
  familiarity: number;
  condition: number;
  /** 폼 −1~1 — 지금 올라와 있나 */
  form: number;
  /** 잠재력까지 남은 여유 (overall 기준). 클수록 자랄 자리가 있다 */
  room: number;
  overall: number;
  /** 이번 시즌 출전·평점 — 훈련장 밖에서 무엇을 겪고 있나 */
  apps: number;
  rating: number | null;
  /**
   * 감독이 이 선수에게 건 **개인 훈련** (없으면 null).
   *
   * `position`이 있으면 그 자리를 배우는 중이라 결산이 적응도를 움직일 수 있고,
   * `axis`가 있으면 팀 세션이 그 축을 하지 않은 구간에도 **이 선수만** 그 축을
   * 가져갈 수 있다 (`allowedAxesFor`).
   */
  program: { axis?: string; position?: string } | null;
}

/** 한 구간의 훈련 결산 브리프 — LLM 입력의 원본 */
export interface TrainingBrief {
  teamName: string;
  from: string;
  to: string;
  sessions: TrainedSession[];
  subjects: TrainingSubject[];
  /**
   * 이 기간의 대화 (최근 것부터 잘라 넣는다) — 모델 턴은 **장면**이지 코치의 말이
   * 아니고, `facts`가 그 턴의 장부 골격(`turnFactLines`)이다: 감독이 실제로 무엇을
   * 걸었는지는 대사가 아니라 이 줄이 말한다 (agents.md §4).
   */
  chat: Array<{ at: string; role: "user" | "model"; text: string; facts: string[] }>;
  /**
   * 이 구간에 훈련한 능력치 축 — 팀 세션의 축 + 대상들에게 걸린 개인 훈련 축.
   *
   * 판정자에게는 이 합집합을 후보로 보이고, **누가 어느 축을 가져갈 수 있는지는
   * 코어가 선수마다 다시 자른다** (`allowedAxesFor`) — 개인 훈련 축은 걸어 둔
   * 그 한 명에게만 열린다.
   */
  trainedAxes: AttributeAxis[];
}

/** LLM이 돌려주는 선수 한 명의 결과 */
/** 한 훈련 날짜(칸)의 능력치 판정 — `date`는 그 칸의 마지막 날짜다 (`trainingSlots`) */
export interface TrainingAttributeChange {
  date: string;
  axis: AttributeAxis | null;
  /** 방향 — −1 또는 +1 */
  step?: number | null;
}

export interface TrainingOutcome {
  playerId: string;
  /** 이 구간의 전술 적응도 변화 (한 주치 눈금) — −1~3. 밖은 코어가 잘라 낸다 */
  tacticGain: number;
  /**
   * 훈련 날짜마다의 능력치 판정 — **칸 하나에 한 줄까지.** 한 선수가 한 구간에 여러
   * 날짜·여러 축을 움직일 수 있다. 판정이 없는 날짜는 적지 않는다.
   */
  attributes?: readonly TrainingAttributeChange[];
  /**
   * 배우는 자리의 적응도 변화 — **개인 훈련에 `position`이 걸린 선수만.**
   * 0~2로 가둔다. 자리는 커리어가 만드는 것이라 경기 한 번(+1)보다 크게 오르지
   * 않고, 훈련만으로 하루아침에 전향되지 않는다.
   */
  positionGain?: number | null;
  /** 한 줄 근거 — 감독이 읽는다 */
  note: string;
  /**
   * 훈련장에서 눈에 띈 갈래 — `standout`·`slack`·`tired` (없으면 null).
   *
   * 수치가 하나도 안 움직인 구간에도 훈련장의 일은 있다. 갈래가 없으면 "태만"도
   * "지쳐서 흐트러짐"도 사실로 남지 않아, 감독은 판정이 실패한 구간과 아무 일도
   * 없던 구간을 구분할 수 없다.
   */
  mark?: TrainingMark | null;
}

export const CHAT_KEEP = 12;

/** 그중 한 줄이 브리프에 실리는 길이 — 긴 지시는 앞머리만 있어도 무엇인지 읽힌다 */
export const CHAT_LINE_MAX = 400;

/** 팀 세션이 겨냥한 능력치 축 (tactical·recovery는 능력치가 아니다) */
export function teamAxesOf(sessions: readonly TrainedSession[]): Set<AttributeAxis> {
  const set = new Set<AttributeAxis>();
  for (const s of sessions) {
    for (const f of s.focus) {
      const axis = attributeAxisOf(f);
      if (axis) set.add(axis);
    }
  }
  return set;
}

/**
 * 이 선수의 허용 축 — **팀 세션의 축 + 자기에게 걸린 개인 훈련 축.**
 *
 * 개인 훈련은 팀 메뉴 위에 한 명만 겨냥해 얹는 것이라(`set_player_training`),
 * 팀이 그 축을 하지 않은 구간에도 열려야 지시가 장부에 닿는다. 대신 **그 한
 * 명에게만** 연다 — 전원에게 열면 한 선수의 개인 훈련이 팀 전체의 성장 축을
 * 넓힌다 (docs/common/player.md §6.1).
 */
export function allowedAxesFor(
  teamAxes: ReadonlySet<AttributeAxis>,
  personal: AttributeAxis | null,
): ReadonlySet<AttributeAxis> {
  return personal ? new Set([...teamAxes, personal]) : teamAxes;
}

/** 판정이 적은 갈래 — 표에 없는 코드는 받지 않는다 */
export function markOf(value: unknown): TrainingMark | null {
  return typeof value === "string" && (TRAINING_MARKS as readonly string[]).includes(value)
    ? (value as TrainingMark)
    : null;
}

/** 판정값을 −1~3으로 접는다 — 값이 없거나 숫자가 아니면 0 */
export function clampGain(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(TACTIC_GAIN_MIN, Math.min(TACTIC_GAIN_MAX, Math.round(value)));
}

/** Collapse whitespace in optional report notes; typed training supplies no prose. */
export function oneLine(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}
