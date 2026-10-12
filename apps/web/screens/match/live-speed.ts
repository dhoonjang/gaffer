import type { LiveMatchState } from "@gaffer/domain";
import { XT_PITCH_LENGTH } from "@gaffer/sim";

/**
 * 실시간 경기의 **배속** — 벽시계와 경기 시계의 비율이다 (live-match.md §8.3). 계산 간격도
 * 난수도 판정 규칙도 바꾸지 않으므로, 어떤 배속으로 굴려도 같은 경기가 빠르거나 느리게
 * 지나갈 뿐이다.
 *
 * 배속은 공이 있는 자리를 따른다 — 골문 앞 장면은 눈으로 따라갈 만큼, 가운데 빌드업은 그보다
 * 빨리, 재시작을 기다리는 죽은 시간은 건너뛰듯.
 */

/** 양쪽 끝 3분의 1과 슈팅의 비행 */
const SCENE_SPEED = 3;
/** 가운데 3분의 1 */
const FLOW_SPEED = 6;
/** 재시작 전의 죽은 시간 */
const DEAD_SPEED = 16;
/** 끝 3분의 1의 경계 (m, 골라인에서) */
const FINAL_THIRD = XT_PITCH_LENGTH / 3;
/**
 * 한 프레임에 목표 배속으로 옮겨 가는 몫. 장면이 열리는 쪽(느려지는 쪽)은 슈팅을 놓치지
 * 않게 빨리, 장면이 닫히는 쪽은 천천히 옮겨 간다.
 */
const EASE_DOWN = 0.5;
const EASE_UP = 0.1;

/** 감독이 고르는 속도 — 세 갈래에 모두 곱한다 */
export const LIVE_PACES = [
  { key: "slow", label: "느리게", factor: 0.5 },
  { key: "normal", label: "보통", factor: 1 },
  { key: "fast", label: "빠르게", factor: 2 },
] as const;
export type LivePace = (typeof LIVE_PACES)[number]["key"];

/** 지금 장면의 목표 배속 */
export function sceneSpeedOf(state: Readonly<LiveMatchState>): number {
  if (state.restart && state.tick < state.restart.untilTick) return DEAD_SPEED;
  const { ball } = state;
  if (ball.flight?.xg !== undefined) return SCENE_SPEED;
  if (ball.x < FINAL_THIRD || ball.x > XT_PITCH_LENGTH - FINAL_THIRD) return SCENE_SPEED;
  return FLOW_SPEED;
}

/** 지금 배속에서 목표 배속으로 한 프레임만큼 옮긴다 */
export function easeSpeed(current: number, target: number): number {
  const share = target < current ? EASE_DOWN : EASE_UP;
  return current + (target - current) * share;
}
