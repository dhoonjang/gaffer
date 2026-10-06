import type { GamePlayer } from "@gaffer/domain";
import { RATING_MAX } from "@gaffer/domain";

/**
 * 폼은 경기 평점에 따른 개인 성과, 침착성에 따른 변동 폭, 일일 중앙 회귀로 갱신한다.
 * 양 끝에 가까울수록 변화를 감쇠한다. 정의역은 −1.0‥+1.0이며 표시 계수도 이 값에서 파생한다.
 */

const FORM_MIN = -1;
const FORM_MAX = 1;

/** 폼 값의 해상도 — 하루치 회귀가 0.0167이라 소수 셋째 자리가 필요하다 */
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * 폼의 중립점 — **평점 분포의 중앙**이지 평점 공식의 기준선(6.0)이 아니다.
 *
 * 앵커 공식은 양수 항이 많다(승 +0.4 · 골 +0.9~2.0 · 도움 +0.6 · 무실점 +0.5~0.8)
 * 반면 음수 항은 적어서(실점 −0.2 · 경고 −0.3), 이긴 팀은 기록이 없어도 6.4쯤
 * 받는다. 6.0을 중립으로 두면 **이기는 팀 전원이 폼이 오르고 하강이 사라진다.**
 * 반대로 중앙보다 높이 두면 평균적인 경기가 폼을 깎아 리그 전체가 가라앉는다 — 실측
 * 득점 분포의 리그에서 앵커 평점의 평균이 6.1이다.
 */
export const RATING_BASELINE = 6.1;
/** 평점 1점당 폼 변화 — 평점 7.5면 +0.33, 5.0이면 −0.26 (침착성 보정 전) */
const RATING_WEIGHT = 0.233;
/** 팀 결과는 약하게 얹는다 — 폼의 주인은 개인 활약이다 */
const OUTCOME_WEIGHT = 0.05;
/** 하루치 평균 회귀 — 경기 간격 5일이면 0.083이 빠진다 (경기당 변화의 3분의 1쯤) */
const DAILY_DECAY = 0.0167;
/** 양 끝 감쇠의 세기 — 1.0이면 상한에서 변화가 0이 된다 */
const EDGE_DAMPING = 0.75;

/** 폼 값은 소수 셋째 자리까지 — 매일 회귀가 0.0167씩이라 자리가 필요하다 */
export const clampForm = (x: number) => Math.max(FORM_MIN, Math.min(FORM_MAX, round3(x)));

/**
 * 기복의 폭 — 침착성이 낮은 선수는 같은 경기에도 폼이 크게 흔들린다.
 * 0.7(침착 99) ~ 1.3(침착 0).
 */
/** 침착 0이 갖는 기복 */
const SWING_AT_ZERO_COMPOSURE = 1.3;
/** 침착이 최고까지 잡아 주는 몫 — 0.7~1.3 */
const SWING_COMPOSURE_RELIEF = 0.6;

export function formSwing(player: GamePlayer): number {
  return (
    SWING_AT_ZERO_COMPOSURE - (player.attributes.composure / RATING_MAX) * SWING_COMPOSURE_RELIEF
  );
}

/**
 * 경기 한 판이 폼에 남기는 변화.
 *
 * @param rating 그 경기 평점 (없으면 팀 결과만 반영한다 — 출전하지 않은 선수는 부르지 않는다)
 */
export function formDeltaFromMatch(
  player: GamePlayer,
  rating: number | undefined,
  outcome: "win" | "draw" | "loss",
): number {
  const performance = rating === undefined ? 0 : (rating - RATING_BASELINE) * RATING_WEIGHT;
  const team = outcome === "win" ? OUTCOME_WEIGHT : outcome === "loss" ? -OUTCOME_WEIGHT : 0;
  const raw = (performance + team) * formSwing(player);
  return dampenAtEdge(player.state.form, raw);
}

/**
 * 양 끝 감쇠 — 이미 절정이면 더 오르기 어렵고, 바닥이면 더 내려가기 어렵다.
 * 반대 방향(식거나 반등)은 온전히 통한다.
 */
function dampenAtEdge(current: number, delta: number): number {
  if (delta === 0) return 0;
  const towardEdge = Math.sign(delta) === Math.sign(current);
  if (!towardEdge) return delta;
  const headroom = 1 - Math.abs(current) / FORM_MAX;
  return delta * (1 - EDGE_DAMPING * (1 - headroom));
}

/** 하루가 지나면 폼은 평균으로 조금 끌린다 — 경기가 없으면 이것만 작동한다 */
export function decayedForm(form: number): number {
  if (form === 0) return 0;
  const step = Math.min(Math.abs(form), DAILY_DECAY);
  return clampForm(form - Math.sign(form) * step);
}

/** 폼의 시기 — 대역으로 갈리는 자리는 전부 이 다섯 중 하나로 갈린다 */
type FormLabel = "절정" | "상승세" | "평소" | "침체" | "바닥";

/**
 * 폼의 말 — 숫자를 그대로 읊지 않고 시기로 부른다.
 * 채팅·심경 한 줄·명단이 같은 라벨을 쓴다 (표현이 갈리면 같은 값이 달라 보인다).
 *
 * **폼의 눈금은 여기 한 곳이다.** 문턱을 숫자로 옮겨 적는 자리가 생기면 한쪽만
 * 옮겨졌을 때 아무 소리 없이 갈린다 — 대역으로 갈리는 곳은 이 라벨로 갈라라.
 */
/** 라벨이 갈리는 폼 — 위아래 대칭이다 */
const FORM_LABEL_FROM = { 절정: 0.73, 상승세: 0.33 } as const;

export function formLabel(form: number): FormLabel {
  if (form >= FORM_LABEL_FROM.절정) return "절정";
  if (form >= FORM_LABEL_FROM.상승세) return "상승세";
  if (form > -FORM_LABEL_FROM.상승세) return "평소";
  if (form > -FORM_LABEL_FROM.절정) return "침체";
  return "바닥";
}

/** 화살표의 색 계열 — 좋음(위)·보통(가로)·나쁨(아래) */
/** 화살표가 기우는 폼 — 이 안쪽은 가로다 */
const FORM_TONE_FROM = 0.12;

export function formTone(form: number): "up" | "flat" | "down" {
  if (form >= FORM_TONE_FROM) return "up";
  if (form > -FORM_TONE_FROM) return "flat";
  return "down";
}

/**
 * 폼 → 화살표 각도(도, 시계 방향. 0이 12시).
 *
 * **절정(+1)에서만 정확히 12시를 본다.** 폼이 연속이므로 각도도 연속이다 —
 * 눈금 몇 개로 끊으면 "조금 올라왔다"가 화면에서 사라진다.
 *
 *   +1.0 → 0°   (12시, 절정)
 *    0.0 → 90°  (3시, 평소)
 *   −1.0 → 180° (6시, 바닥)
 *
 * 유니코드 화살표(`↑↗→↘↓`)를 쓰던 때는 7단계로 끊겼고, 이중 화살표(`⇑⇓`)만
 * 폴백 폰트로 빠져 **가장 강조돼야 할 절정·바닥이 가장 가늘게** 보였다.
 * 그래서 글자 대신 도형 하나를 돌린다.
 */
/** 폼 0(평소)이 가리키는 각 — 3시. 절정이 0°, 바닥이 180°다 */
const FLAT_ANGLE = 90;

export function formAngle(form: number): number {
  const clamped = Math.max(FORM_MIN, Math.min(FORM_MAX, form));
  return Math.round((FLAT_ANGLE - clamped * FLAT_ANGLE) * 10) / 10;
}
