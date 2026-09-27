import {
  type MatchSide,
  type MatchEventType,
  ShootoutOutcomeSchema,
  type ShootoutKick,
  type MatchEvent,
} from "../common/match-events";
import { z } from "zod";

/** 반대편 — 이득과 대가, 약점을 가진 쪽과 이로운 쪽을 뒤집는 자리가 하나여야 한다 */
export const otherSide = (side: MatchSide): MatchSide => (side === "home" ? "away" : "home");

/** 팀 귀속이 필요한 이벤트 타입 */
export const TEAM_EVENT_TYPES: ReadonlySet<MatchEventType> = new Set([
  "goal",
  "shot",
  "save",
  "chance",
  "foul",
  "yellow_card",
  "red_card",
  "substitution",
  "injury",
  "tactical_shift",
]);

export type ShootoutOutcome = z.infer<typeof ShootoutOutcomeSchema>;

/** 정규 라운드 — 5킥씩 차고도 같으면 서든데스다 */
export const SHOOTOUT_ROUNDS = 5;

/** 지금까지의 승부차기 합계 — 킥 목록이 원본이라 따로 세지 않는다 */
export function shootoutTally(kicks: readonly ShootoutKick[]): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const kick of kicks) {
    if (kick.outcome !== "scored") continue;
    if (kick.team === "home") home += 1;
    else away += 1;
  }
  return { home, away };
}

/**
 * **승부가 갈렸는가** — 남은 킥으로 뒤집을 수 없으면 거기서 끝난다.
 *
 * 조기 확정의 규칙이 여기 한 벌만 있다: 코어가 킥을 굴릴 때도, 화면이 승부차기가
 * 끝났는지 물을 때도 이 함수를 읽는다. 5킥을 다 차기 전이면 **남은 킥 수**로 재고,
 * 다 찼으면 양 팀이 같은 수를 찬 자리에서만 갈린다(서든데스는 한 라운드가 통째로
 * 끝나야 판정한다).
 */
export function shootoutSettled(kicks: readonly ShootoutKick[]): boolean {
  const taken = {
    home: kicks.filter((k) => k.team === "home").length,
    away: kicks.filter((k) => k.team === "away").length,
  };
  const { home, away } = shootoutTally(kicks);
  const left = {
    home: Math.max(0, SHOOTOUT_ROUNDS - taken.home),
    away: Math.max(0, SHOOTOUT_ROUNDS - taken.away),
  };
  if (left.home > 0 || left.away > 0) {
    return home > away + left.away || away > home + left.home;
  }
  /**
   * 서든데스는 **한 라운드가 통째로 끝나야** 판정한다 — 남은 킥으로 재면 먼저 찬
   * 팀이 넣은 순간 갈렸다고 읽혀 상대가 차 보지도 못한다.
   */
  return taken.home === taken.away && home !== away;
}

/**
 * 다음에 차는 사람이 선 자리 — 갈렸으면 `null`.
 *
 * 순서는 먼저 차는 쪽(`first`)부터 한 발씩 번갈아 간다. 누가 먼저인지는 동전이
 * 정하므로(shootout.ts) 목록만으로는 알 수 없어 인자로 받는다.
 */
export function nextShootoutKick(
  kicks: readonly ShootoutKick[],
  first: MatchSide,
): { round: number; team: MatchSide } | null {
  if (shootoutSettled(kicks)) return null;
  const index = kicks.length;
  const other: MatchSide = first === "home" ? "away" : "home";
  return { round: Math.floor(index / 2) + 1, team: index % 2 === 0 ? first : other };
}

/** 정규 경기의 길이 — 출전 시간의 분모다 */
export const FULL_TIME_MINUTES = 90;

/** 연장까지 간 경기의 길이 */
export const EXTRA_TIME_FULL_MINUTES = 120;

/**
 * 한 경기의 **출전 시간** — 사건 목록이 원본이다.
 *
 * 교체의 [나가는 선수, 들어오는 선수] 짝과 **퇴장**이 같은 자격으로 시간을 끊는다 —
 * 퇴장을 세지 않으면 20′에 나간 선수도 90분으로 남는다.
 *
 * 규칙이 여기 한 벌만 있는 이유는 읽는 자리가 둘이기 때문이다: 진행 중인 장부를
 * 읽는 평점 브리프(`match-flow.ts`)와 끝난 경기의 결과를 읽는 리포트·MOTM
 * (`views.ts`). 두 벌로 두면 같은 선수의 출전 시간이 화면과 판정에서 갈린다.
 */
export function matchMinutesOf(
  events: readonly MatchEvent[],
  aet: boolean,
): (playerId: string) => number {
  const full = aet ? EXTRA_TIME_FULL_MINUTES : FULL_TIME_MINUTES;
  const wentOff = new Map<string, number>();
  const cameOn = new Map<string, number>();
  for (const e of events) {
    const [first, second] = e.actors;
    if (e.type === "substitution") {
      if (first) wentOff.set(first, Math.min(wentOff.get(first) ?? e.minute, e.minute));
      if (second) cameOn.set(second, e.minute);
    } else if (e.type === "red_card" && first) {
      wentOff.set(first, Math.min(wentOff.get(first) ?? e.minute, e.minute));
    }
  }
  return (playerId) => {
    const from = Math.min(cameOn.get(playerId) ?? 0, full);
    const to = Math.min(wentOff.get(playerId) ?? full, full);
    return Math.max(0, to - from);
  };
}

export const MatchPhaseSchema = z.enum([
  "first_half",
  "second_half",
  "extra_first",
  "extra_second",
  "finished",
]);

export type MatchPhase = z.infer<typeof MatchPhaseSchema>;

/** 공이 굴러가는 국면 — 종료를 뺀 넷 */
export type PlayPhase = Exclude<MatchPhase, "finished">;

/** 각 국면이 끝나는 시각(추가시간 전) — 45 · 90 · 105 · 120 */
export const PHASE_END: Record<PlayPhase, number> = {
  first_half: 45,
  second_half: 90,
  extra_first: 105,
  extra_second: 120,
};

/** 각 국면이 시작하는 시각 */
export const PHASE_START: Record<PlayPhase, number> = {
  first_half: 0,
  second_half: 45,
  extra_first: 90,
  extra_second: 105,
};

/** 연장 국면인가 — 교체 한도·발생률이 여기서 갈린다 */
export function isExtraTime(phase: MatchPhase): boolean {
  return phase === "extra_first" || phase === "extra_second";
}
