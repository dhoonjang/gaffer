import { describe, expect, it } from "vitest";
import { RATING_MAX, type AttributeAxis } from "@gaffer/domain";
import { createTestGame } from "../test/helpers";
import { AXIS_VALUE, AXIS_VALUE_AXES, AXIS_VALUE_STEP, axisValueMetric } from "./catalog";
import { reportOf, type Readings } from "./harness";
import {
  FORMATION_ARMS,
  editAttributes,
  leagueFixtures,
  liveMatchIn,
  mean,
  playToEnd,
  sampleOf,
} from "./live-runs";

/**
 * **축 한 칸의 경기 가치** — 같은 대진에서 홈 팀 전원의 축 하나만 올려 굴리고, 기준 판과의
 * xG 차를 잰다 (player.md §1 「크기」). 능력치는 킥오프 직전에 그 경기 명단에만 얹는다 —
 * 시뮬 코드는 그대로다. 골키퍼 축은 골키퍼만, 필드 축은 필드 선수만 판정에 쓰므로 전원에게
 * 올려도 같다.
 *
 * 재는 값이다 — 밴드는 아직 걸지 않는다. 0에 붙은 축은 통로가 없거나 약하고, 다른 축의 몇
 * 배인 축은 종합 가중치(A8)와 어긋난다.
 *
 *   pnpm balance axis-value
 */

const SEEDS = [42, 7];
const MATCHES = 4;

interface Sample {
  xgFor: number;
  xgAgainst: number;
}

const ARMS: readonly (AttributeAxis | null)[] = [null, ...AXIS_VALUE_AXES];

describe("축 한 칸의 경기 가치", () => {
  const pooled = new Map<string, Sample[]>(ARMS.map((axis) => [axis ?? "기준", []]));

  for (const [seedIndex, seed] of SEEDS.entries()) {
    it(`시드 ${seed} × 리그 ${MATCHES}경기 × 팔 ${ARMS.length}`, () => {
      const state = createTestGame(seed);
      for (const [i, fixture] of leagueFixtures(state, MATCHES).entries()) {
        const k = i * SEEDS.length + seedIndex;
        const shapes = [
          FORMATION_ARMS[k % FORMATION_ARMS.length]!,
          FORMATION_ARMS[(k + 3) % FORMATION_ARMS.length]!,
        ] as const;
        for (const axis of ARMS) {
          const live = liveMatchIn(state, fixture, shapes);
          if (axis)
            editAttributes(live, "home", (a) => {
              a[axis] = Math.min(RATING_MAX, a[axis] + AXIS_VALUE_STEP);
            });
          playToEnd(live);
          const [home, away] = sampleOf(live).teams;
          pooled.get(axis ?? "기준")!.push({ xgFor: home!.line.xg, xgAgainst: away!.line.xg });
        }
      }
      expect(pooled.get("기준")).toHaveLength((seedIndex + 1) * MATCHES);
    });
  }

  it("축마다 공격·수비·득실 가치", () => {
    const avg = (label: string, pick: (s: Sample) => number) => mean(pooled.get(label)!.map(pick));
    const per10 = 10 / AXIS_VALUE_STEP;
    const readings: Readings<typeof AXIS_VALUE> = {
      "기준 — 우리 xG": avg("기준", (s) => s.xgFor),
    };
    for (const axis of AXIS_VALUE_AXES) {
      const attack = (avg(axis, (s) => s.xgFor) - avg("기준", (s) => s.xgFor)) * per10;
      const defence = (avg("기준", (s) => s.xgAgainst) - avg(axis, (s) => s.xgAgainst)) * per10;
      readings[axisValueMetric(axis, "공격")] = attack;
      readings[axisValueMetric(axis, "수비")] = defence;
      readings[axisValueMetric(axis, "득실")] = attack + defence;
    }
    console.log(
      reportOf(
        AXIS_VALUE,
        readings,
        `시드 ${SEEDS.join("·")} × 리그 ${MATCHES}경기 × 팔 ${ARMS.length}`,
      ),
    );
    expect(pooled.size).toBe(ARMS.length);
  });
});
