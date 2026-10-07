import { describe, expect, it } from "vitest";
import type { Formation, TacticsSpec } from "@gaffer/domain";
import { createTestGame } from "../test/helpers";
import { LIVE_TACTICS } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";
import {
  FORMATION_ARMS,
  leagueFixtures,
  liveMatchIn,
  mean,
  playToEnd,
  sampleOf,
  type TeamSample,
} from "./live-runs";

/**
 * **전술이 말의 움직임을 통해 결과를 옮기는가** — 같은 대진에서 홈 팀의 전술 하나만 바꿔
 * 굴리고, 기준 판과의 차이를 연속값으로 잰다 (live-match.md §6 · §9.3).
 *
 * 판정은 **방향**이다 — 크기는 읽는 값이다. 전술이 방향조차 옮기지 못하면 감독의 지시는
 * 장식이다. 판의 난수 채널이 틱마다 같으므로 두 판의 차이는 전술에서 온다.
 *
 * **방향은 모양마다 선다.** 홈 팀을 프리셋 일곱 각각으로 세우고 상대는 모양을 돌려 가며 붙인다
 * — 백5의 라인 1, 투톱의 압박 5가 4-2-3-1과 같은 쪽으로 움직이는지가 여기서만 보인다.
 *
 *   pnpm balance live-tactics
 */

/** 모양마다 시드 둘 × 리그 6경기 = 12대진 — 모은 판은 팔마다 84대진이다 */
const SEEDS = [42, 7];
const MATCHES = 6;

type Arm = "기준" | "멘탈리티 5" | "압박 5" | "수비 라인 1" | "템포 5";
const ARMS: Record<Arm, Partial<TacticsSpec>> = {
  기준: {},
  "멘탈리티 5": { mentality: 5 },
  "압박 5": { pressing: 5 },
  "수비 라인 1": { defensiveLine: 1 },
  "템포 5": { tempo: 5 },
};

interface ArmResult {
  us: TeamSample[];
  them: TeamSample[];
}

type ArmResults = Record<Arm, ArmResult>;

const emptyResults = (): ArmResults =>
  Object.fromEntries(
    Object.keys(ARMS).map((arm): [string, ArmResult] => [arm, { us: [], them: [] }]),
  ) as Record<Arm, ArmResult>;

describe("전술의 방향", () => {
  const perFormation = new Map<Formation, ArmResults>();

  for (const formation of FORMATION_ARMS) {
    it(`${formation} — 시드 ${SEEDS.join("·")} × 리그 ${MATCHES}경기 × 팔 ${Object.keys(ARMS).length}`, () => {
      const results = emptyResults();
      for (const [seedIndex, seed] of SEEDS.entries()) {
        const state = createTestGame(seed);
        for (const [i, fixture] of leagueFixtures(state, MATCHES).entries()) {
          const away = FORMATION_ARMS[(i * SEEDS.length + seedIndex) % FORMATION_ARMS.length]!;
          for (const arm of Object.keys(ARMS) as Arm[]) {
            const live = liveMatchIn(state, fixture, [formation, away], { home: ARMS[arm] });
            playToEnd(live);
            const [home, other] = sampleOf(live).teams;
            results[arm].us.push(home!);
            results[arm].them.push(other!);
          }
        }
      }
      perFormation.set(formation, results);
      expect(results.기준.us).toHaveLength(SEEDS.length * MATCHES);
    });
  }

  it("멘탈리티·압박·라인·템포가 모든 모양에서 슈팅·점유·거리를 예상한 쪽으로 옮긴다", () => {
    const pooled = emptyResults();
    for (const results of perFormation.values())
      for (const arm of Object.keys(ARMS) as Arm[]) {
        pooled[arm].us.push(...results[arm].us);
        pooled[arm].them.push(...results[arm].them);
      }
    const shots = (t: TeamSample) => t.line.shots;
    const xg = (t: TeamSample) => t.line.xg;
    const km = (t: TeamSample) => t.line.distance / 1000;
    const poss = (t: TeamSample) => t.possession;
    const passes = (t: TeamSample) => t.line.passes;
    const reader = (results: ArmResults) => {
      const avg = (arm: Arm, who: keyof ArmResult, pick: (t: TeamSample) => number) =>
        mean(results[arm][who].map(pick));
      const delta = (arm: Arm, who: keyof ArmResult, pick: (t: TeamSample) => number) =>
        avg(arm, who, pick) - avg("기준", who, pick);
      return { avg, delta };
    };
    const { avg, delta } = reader(pooled);
    const readings: Readings<typeof LIVE_TACTICS> = {
      "기준 — 우리 슈팅": avg("기준", "us", shots),
      "기준 — 우리 xG": avg("기준", "us", xg),
      "멘탈리티 5 — 우리 슈팅 변화": delta("멘탈리티 5", "us", shots),
      "멘탈리티 5 — 우리 xG 변화": delta("멘탈리티 5", "us", xg),
      "멘탈리티 5 — 상대 xG 변화": delta("멘탈리티 5", "them", xg),
      "압박 5 — 우리 거리 변화 (km)": delta("압박 5", "us", km),
      "압박 5 — 상대 패스 변화": delta("압박 5", "them", passes),
      "압박 5 — 우리 점유 변화": delta("압박 5", "us", poss),
      "수비 라인 1 — 상대 점유 변화": delta("수비 라인 1", "them", poss),
      "수비 라인 1 — 상대 xG 변화": delta("수비 라인 1", "them", xg),
      "템포 5 — 우리 패스 변화": delta("템포 5", "us", passes),
      "템포 5 — 우리 슈팅 변화": delta("템포 5", "us", shots),
    };
    for (const [f, results] of perFormation) {
      const one = reader(results).delta;
      readings[`${f} — 멘탈리티 5 우리 슈팅 변화`] = one("멘탈리티 5", "us", shots);
      readings[`${f} — 멘탈리티 5 우리 xG 변화`] = one("멘탈리티 5", "us", xg);
      readings[`${f} — 압박 5 우리 거리 변화 (km)`] = one("압박 5", "us", km);
      readings[`${f} — 압박 5 상대 패스 변화`] = one("압박 5", "them", passes);
      readings[`${f} — 수비 라인 1 상대 점유 변화`] = one("수비 라인 1", "them", poss);
      readings[`${f} — 템포 5 우리 패스 변화`] = one("템포 5", "us", passes);
    }
    console.log(
      reportOf(
        LIVE_TACTICS,
        readings,
        `모양 ${perFormation.size} × 시드 ${SEEDS.join("·")} × 리그 ${MATCHES}경기 × 팔 ${Object.keys(ARMS).length}`,
      ),
    );
    expect(perFormation.size).toBe(FORMATION_ARMS.length);
    expect(outOfBand(LIVE_TACTICS, readings)).toEqual([]);
  });
});
