import { type GameState, recomputeOverall, recordGrowth } from "../core/state";
import {
  type GamePlayer,
  type AttributeAxis,
  type GrowthOrigin,
  RATING_MAX,
  ageOf,
} from "@story-fm/domain";
import { attributeGainScale, attributeDeclineScale } from "../world/attributes";

/**
 * 능력치가 한 번에 움직이는 폭 — **−1 ~ +1**.
 *
 * 오르기만 하는 능력치는 없다. 서른을 넘긴 선수의 스피드는 훈련해도 내려가고,
 * 몇 주를 통째로 쉰 선수의 지구력도 그렇다. 그 판단을 결산이 한다.
 */
export const ATTR_STEP_MIN = -1;

export const ATTR_STEP_MAX = 1;

/**
 * 하락이 멈추는 능력치 — 스키마의 0이 아니라 1이다. 축 하나가 0이 되면 그 선수는
 * 그 축을 **아예 갖지 않은** 것으로 읽혀 곱셈이 걸린 공식이 통째로 죽는다.
 */
export const ATTR_DECLINE_FLOOR = 1;

export const MATCH_ATTR_CAP = 11;

/**
 * 능력치를 한 칸 움직인다 — **훈련 결산과 경기 결산이 같은 규칙을 쓴다.**
 *
 * 어느 판정이든 한 번에 움직이는 건 **한 축 ±1**이고, 인원 상한과 잠재력 상한을
 * 넘지 못한다. 규칙을 두 곳에 복제하면 한쪽만 조여지고 다른 쪽이 샌다.
 *
 * **잠재력은 오를 때만 막는다.** 내려가는 데는 천장이 무의미하고(이미 넘은 선수도
 * 늙는다), 대신 1 아래로는 안 내려간다.
 *
 * @param allowed 허용 축 (훈련은 그 구간에 훈련한 축만, 경기는 제한 없음 → null)
 * @returns 이 판정이 **이 선수를 건드렸으면** 그 축·넘어간 방향·결과값. 캐리만
 *          움직이고 눈금이 안 넘어갔으면 `step`이 0이다 — 그래도 인원 상한의 한
 *          자리를 쓴다(호출 자리가 그렇게 센다). 아무 일도 못 하면 null.
 *          ⚠️ 넘어간 인원만 세면 하루치 결산에서는 아무도 안 넘어가 상한이
 *          전원에게 열린다 (docs/common/player.md §6.1).
 */
export function applyAttributeStep(
  state: GameState,
  player: GamePlayer,
  axis: AttributeAxis | null,
  step: number | null | undefined,
  opts: {
    allowed: ReadonlySet<AttributeAxis> | null;
    spent: number;
    cap: number;
    /**
     * 감독 계수 (기본 1) — **상승에만** 곱한다. 하락에 곱하면 나쁜 감독 밑에서
     * 노화가 느려지는 거꾸로 된 결과가 된다. 경기 결산은 주지 않는다.
     */
    factor?: number;
    /**
     * 이 결산이 덮는 주 수 (기본 1 · `settlementWeeks`) — **상승과 하락 양쪽에**
     * 곱한다. 사람의 항이 아니라 「며칠치인가」라, 하락만 한 주치로 남으면 페이스가
     * 다시 성장 속도를 정한다. 경기 결산은 한 경기가 곧 한 번이라 주지 않는다.
     */
    weeks?: number;
    source: "training" | "match";
    /** 어느 경로로 올랐나 — 문장이 아니라 코드다 (records.ts `GrowthOrigin`) */
    origin: GrowthOrigin;
    /** 출처 일정·날짜 — 결산은 지나간 훈련 날짜를 가리킨다 */
    entryId?: string;
    on?: string;
  },
): { axis: AttributeAxis; step: number; value: number } | null {
  if (!axis) return null;
  if (opts.allowed && !opts.allowed.has(axis)) return null;
  if (opts.spent >= opts.cap) return null;
  const raw = typeof step === "number" && Number.isFinite(step) ? Math.round(step) : 1;
  const move = Math.max(ATTR_STEP_MIN, Math.min(ATTR_STEP_MAX, raw));
  if (move === 0) return null;

  const value = player.attributes[axis] ?? 0;
  if (move > 0 && (value >= player.attributes.potential || value >= RATING_MAX)) return null;
  if (move < 0 && value <= ATTR_DECLINE_FLOOR) return null;

  /**
   * 판정이 "한 칸"이라고 해도 그대로 오르지는 않는다 — 잠재력 여유·나이·현재
   * 수준이 정한 만큼만 남고, 못 채운 몫은 `growthCarry`에 쌓인다. 이게 없으면
   * 서른의 주전은 아무리 훈련해도 그대로이고(곡선이 늘 1보다 작다) 열여덟은
   * 판정 한 번에 한 칸씩 오른다.
   */
  const age = ageOf(player.birthdate, state.date);
  const scale =
    move > 0
      ? attributeGainScale(axis, value, player.attributes.potential, age) * (opts.factor ?? 1)
      : attributeDeclineScale(axis, age);
  if (scale <= 0) return null;

  const carry = (player.growthCarry[axis] ?? 0) + move * scale * (opts.weeks ?? 1);
  // 한 칸을 채웠나 — 0 쪽으로 자른다(−0.7은 아직 −1이 아니다)
  const whole = Math.trunc(carry);
  if (whole === 0) {
    player.growthCarry = { ...player.growthCarry, [axis]: carry };
    // 장부는 그대로지만 이 판정은 이 선수를 건드렸다 — 인원 상한의 한 자리를 쓴다
    return { axis, step: 0, value };
  }

  // 한 번에 한 칸까지만 — 캐리가 밀려 있어도 장부가 갑자기 두 칸 뛰지 않는다
  const applied = Math.sign(whole);
  player.growthCarry = { ...player.growthCarry, [axis]: carry - applied };

  player.attributes[axis] = value + applied;
  recomputeOverall(player);
  recordGrowth(
    state,
    player.id,
    opts.entryId ?? null,
    opts.source,
    axis,
    applied,
    opts.origin,
    opts.on,
  );
  return { axis, step: applied, value: player.attributes[axis] };
}
