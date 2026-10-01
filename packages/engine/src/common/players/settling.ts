import type { Injury, TrainingSession, Transfer } from "@story-fm/domain";
import { isReserveMatch } from "@story-fm/domain";

import { diffDays } from "../core/dates";
import { playerById, teamNameIn, type GameState } from "../core/state";

/** Match appearances, completed training and elapsed days own adaptation progress. */
export const SETTLING_TARGET = 100;

/**
 * 경기 한 번 = 훈련 대엿새. 라커룸은 훈련장이 아니라 경기장에서 열린다 —
 * 감독이 쥔 가장 큰 손잡이가 출전이어야 "안 쓰면 안 녹아든다"가 성립한다.
 */
export const MATCH_CREDIT = 8;
/** 팀 훈련 하루 */
export const TRAINING_CREDIT = 1.5;
/** 그냥 함께 보낸 하루 — 바닥값이라 아무도 안 쓰는 선수도 언젠가는 적응한다 */
export const DAY_CREDIT = 0.5;

export interface Settling {
  /** 우리 팀에 온 날 (TRANSFER 원장) */
  joinedOn: string;
  /** 0~1 */
  progress: number;
  credit: number;
  target: number;
  /** 무엇이 쌓았나 — 화면·서사가 그대로 읽는다 */
  matches: number;
  trainings: number;
  days: number;
  done: boolean;
}

/**
 * 원장이 말하는, 그 줄 시점의 우리와 이 선수의 사이.
 * `type:"loan"`이 네 가지 이동을 다 적기 때문에 필요하다 (`joinedUserTeamOn`).
 */
type Tie =
  /** 우리 팀 사람이 아니다 */
  | "none"
  /** 우리 소속으로 여기 있다 */
  | "signed"
  /** 임대로 와 있다 — 계약은 저쪽에 있다 */
  | "borrowed"
  /** 우리 선수인데 임대로 나가 있다 */
  | "lent";

/**
 * 이 선수가 우리 팀에 들어온 날 — TRANSFER 원장의 마지막 영입 기록.
 * 원소속(게임 시작 스쿼드)은 기록이 없으므로 null.
 * **유스 콜업과 임대 복귀는 적응이 없다** — 이미 이 클럽 사람이고 훈련장도 같다.
 *
 * ⚠️ **`type:"loan"` 한 종류가 네 가지 이동을 적는다** — 임대 영입 · 그 선수의
 * 반납 · 우리 선수 임대 송출 · 그 선수의 복귀. 방향만 봐서는 복귀와 영입이 같은
 * 모양(`toTeamId` = 우리)이라, 원장을 날짜 순으로 걸으며 **직전까지의 사이**로
 * 가른다: 나가 있던 우리 선수가 돌아온 줄은 온 날이 아니고, 임대로 데려온 선수의
 * 줄은 온 날이다.
 */
export function joinedUserTeamOn(state: GameState, playerId: string): string | null {
  // 원장에 줄이 없는 선수가 대부분이다 — 정렬은 걸을 줄이 있을 때만 한다
  const ledger: Transfer[] = [];
  for (const t of state.transfers) if (t.gamePlayerId === playerId) ledger.push(t);
  if (ledger.length === 0) return null;
  ledger.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let tie: Tie = "none";
  let joined: string | null = null;
  for (const t of ledger) {
    if (t.toTeamId === state.userTeamId) {
      if (t.type === "youth") {
        tie = "signed"; // 콜업 — 이미 이 클럽 사람이라 온 날이 없다
        joined = null;
      } else if (t.type !== "loan") {
        tie = "signed";
        joined = t.date;
      } else if (tie === "lent") {
        tie = "signed"; // 우리가 내보낸 임대의 복귀 — 처음 온 날이 그대로 남는다
      } else {
        tie = "borrowed";
        joined = t.date;
      }
    } else if (t.fromTeamId === state.userTeamId) {
      if (t.type !== "loan") {
        tie = "none"; // 이적·방출·은퇴로 떠났다
        joined = null;
      } else if (tie === "borrowed") {
        tie = "none"; // 임대로 와 있던 선수를 원소속에 돌려보냈다
        joined = null;
      } else {
        tie = "lent"; // 우리 선수를 임대로 내보냈다 — 계약은 우리에게 남는다
      }
    }
  }
  return joined;
}

/** 그 날 부상 중이었나 — 부상 기간의 훈련은 적응에 쌓이지 않는다 */
function injuredOn(injuries: readonly Injury[], date: string): boolean {
  return injuries.some((i) => i.occurredOn <= date && date < (i.returnedOn ?? i.expectedReturn));
}

/** 영입 이후 우리 팀에서 그라운드를 밟은 횟수 */
function matchesSince(state: GameState, playerId: string, since: string): number {
  let count = 0;
  for (const match of state.matches) {
    if (!match.result || match.date < since) continue;
    // 정착은 1군 무대의 것이다 — 2군 경기로는 새 팀에 녹아들었다고 말하지 않는다
    if (isReserveMatch(match)) continue;
    const lineup =
      match.homeTeamId === state.userTeamId
        ? match.result.homeLineup
        : match.awayTeamId === state.userTeamId
          ? match.result.awayLineup
          : undefined;
    if (lineup?.includes(playerId)) count += 1;
  }
  return count;
}

/**
 * 영입 이후 실제로 치른 팀 훈련 일수 (휴식 세션·부상 기간 제외).
 *
 * 세션과 부상은 **하루마다가 아니라 한 번** 추린다 — 일정 × 세션 × 부상이던
 * 자리다. `find`가 첫 줄을 고르므로 색인도 먼저 만난 줄을 남긴다.
 */
function trainingsSince(state: GameState, playerId: string, since: string): number {
  const sessions = new Map<string, TrainingSession>();
  for (const session of state.trainingSessions) {
    if (!sessions.has(session.id)) sessions.set(session.id, session);
  }
  const injuries = state.injuries.filter((i) => i.gamePlayerId === playerId);
  let count = 0;
  for (const entry of state.schedule) {
    if (entry.type !== "training" || entry.status !== "done") continue;
    if (entry.date < since || entry.date > state.date) continue;
    if (sessions.get(entry.refId)?.rest) continue; // 쉬는 날은 함께한 훈련이 아니다
    if (injuredOn(injuries, entry.date)) continue;
    count += 1;
  }
  return count;
}

/**
 * 지금 이 선수의 적응 상태 — 적응 대상이 아니면 null
 * (원소속 선수 · 유스 콜업 · 타 팀 선수).
 */
export function settlingOf(state: GameState, playerId: string): Settling | null {
  const player = playerById(state, playerId);
  if (!player || player.teamId !== state.userTeamId) return null;
  const joinedOn = joinedUserTeamOn(state, playerId);
  if (joinedOn === null) return null;

  const days = Math.max(0, diffDays(joinedOn, state.date));
  const matches = matchesSince(state, playerId, joinedOn);
  const trainings = trainingsSince(state, playerId, joinedOn);
  const credit = Math.max(
    0,
    matches * MATCH_CREDIT + trainings * TRAINING_CREDIT + days * DAY_CREDIT,
  );

  const target = SETTLING_TARGET;
  const progress = Math.min(1, credit / target);
  return {
    joinedOn,
    progress,
    credit,
    target,
    matches,
    trainings,
    days,
    done: progress >= 1,
  };
}

/** 아직 적응 중인가 */
export function isSettling(state: GameState, playerId: string): boolean {
  const a = settlingOf(state, playerId);
  return a !== null && !a.done;
}

/** 적응 진행도(0~100 정수) — 적응 대상이 아니거나 끝났으면 null */
export function settlingPercent(state: GameState, playerId: string): number | null {
  const a = settlingOf(state, playerId);
  if (!a || a.done) return null;
  return Math.round(a.progress * 100);
}

/**
 * 적응 상태 한 줄 — **남은 일수를 약속하지 않는다.**
 * 얼마나 걸릴지는 감독이 앞으로 무엇을 하느냐에 달렸으므로, 지금까지 무엇이
 * 쌓였는지만 말한다.
 */
export function settlingNote(state: GameState, playerId: string): string | null {
  const a = settlingOf(state, playerId);
  if (!a || a.done) return null;
  const done: string[] = [];
  if (a.matches > 0) done.push(`${a.matches}경기 출전`);
  if (a.trainings > 0) done.push(`팀 훈련 ${a.trainings}일`);
  const from = state.transfers.find(
    (t) => t.gamePlayerId === playerId && t.date === a.joinedOn && t.fromTeamId !== null,
  );
  const origin = from?.fromTeamId ? `${teamNameIn(state, from.fromTeamId)}에서 온 뒤 ` : "";
  return `적응 ${Math.round(a.progress * 100)}% — ${origin}${done.length > 0 ? done.join(" · ") : "아직 경기도 훈련도 없다"}`;
}
