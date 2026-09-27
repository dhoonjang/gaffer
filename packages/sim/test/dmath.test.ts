import { describe, expect, it } from "vitest";
import { LN2, dexp, dhypot, dlog, dsigmoid } from "../src/live/dmath";

/** 양끝을 포함하는 균일 격자 */
const grid = (from: number, to: number, steps: number): number[] =>
  Array.from({ length: steps + 1 }, (_, i) => from + ((to - from) * i) / steps);

/** 기준이 0이면 절대 오차가 곧 상대 오차다 */
const relErr = (got: number, ref: number): number =>
  ref === 0 ? Math.abs(got) : Math.abs((got - ref) / ref);

const worstOf = (xs: readonly number[], err: (x: number) => number): number =>
  xs.reduce((m, x) => Math.max(m, err(x)), 0);

/**
 * 기준은 `Math.*`다 — 이 테스트는 결정성(엔진마다 같은 비트)을 잴 수 없고 정확도만 잰다.
 * 결정성은 초월 `Math.*`를 쓰지 않는다는 lint 규칙과 서버의 체크포인트 검증이 지킨다.
 */
describe("dmath — 실시간 경기의 결정적 수학", () => {
  it("dexp: [-50, 50]에서 Math.exp와 상대 오차 1e-12 안, 포화 밖에서도 유한", () => {
    const xs = [...grid(-50, 50, 4000), 0, LN2 / 2, -LN2 / 2, 1, -1];
    expect(worstOf(xs, (x) => relErr(dexp(x), Math.exp(x)))).toBeLessThan(1e-12);
    expect(dexp(0)).toBe(1);
    // 포화 한계 ±700은 정규수 안이라 정확하고, 그 밖은 한계값으로 잘린다
    expect(relErr(dexp(700), Math.exp(700))).toBeLessThan(1e-12);
    expect(relErr(dexp(-700), Math.exp(-700))).toBeLessThan(1e-12);
    for (const x of [1e6, -1e6, Infinity, -Infinity]) expect(Number.isFinite(dexp(x))).toBe(true);
    expect(dexp(NaN)).toBeNaN();
  });

  it("dlog: [1e-6, 1e6]에서 Math.log와 상대 오차 1e-12 안, 경계값과 왕복", () => {
    const xs = grid(-6, 6, 4000).map((k) => Math.pow(10, k));
    expect(worstOf(xs, (x) => relErr(dlog(x), Math.log(x)))).toBeLessThan(1e-12);
    // 1 근처 — m − 1이 정확해야 상대 정밀도가 산다
    const near1 = grid(1 - 1e-6, 1 + 1e-6, 2000).filter((x) => x !== 1);
    expect(worstOf(near1, (x) => relErr(dlog(x), Math.log(x)))).toBeLessThan(1e-12);
    expect(dlog(1)).toBe(0);
    expect(dlog(2)).toBe(LN2);
    expect(dlog(0)).toBe(-Infinity);
    expect(dlog(-1)).toBeNaN();
    expect(dlog(Infinity)).toBe(Infinity);
    // 비정규수도 정규수로 올려 읽는다
    expect(relErr(dlog(5e-324), Math.log(5e-324))).toBeLessThan(1e-12);
    // dlog(dexp(x)) = x — 두 함수의 구간 축소가 서로 맞물린다
    expect(worstOf(grid(-600, 600, 1201), (x) => relErr(dlog(dexp(x)), x))).toBeLessThan(1e-12);
  });

  it("dsigmoid: 상대 오차 1e-12 안, 끝에서 0/1로 포화", () => {
    expect(
      worstOf(grid(-700, 700, 2800), (x) => relErr(dsigmoid(x), 1 / (1 + Math.exp(-x)))),
    ).toBeLessThan(1e-12);
    expect(dsigmoid(0)).toBe(0.5);
    expect(dsigmoid(800)).toBe(1);
    expect(dsigmoid(-800)).toBeGreaterThan(0);
  });

  it("dhypot: 경기장 좌표 범위에서 Math.hypot과 상대 오차 1e-14 안", () => {
    let worst = 0;
    for (const x of grid(-120, 120, 48))
      for (const y of grid(-80, 80, 32))
        worst = Math.max(worst, relErr(dhypot(x, y), Math.hypot(x, y)));
    expect(worst).toBeLessThan(1e-14);
    expect(dhypot(3, 4)).toBe(5);
    expect(dhypot(0, 0)).toBe(0);
  });
});
