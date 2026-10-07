import { weightSlotOf, type WeightSlot } from "@gaffer/domain";
import { describe, expect, it } from "vitest";
import { createTestGame } from "../test/helpers";
import { LIVE_FORMATION_ARMS, LIVE_FORMATIONS } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";
import {
  leagueFixtures,
  liveMatchWith,
  mean,
  playToEnd,
  sampleOf,
  withFormation,
  type TeamSample,
} from "./live-runs";

/**
 * **포메이션마다 축구가 서는가** — 양 팀을 같은 프리셋 모양으로 다시 세우고 같은 대진을 굴린다
 * (live-match.md §9.3). 시드 세계는 대개 4-3-3·4-2-3-1을 고르므로 `live-baseline`은 백3·백5·
 * 투톱을 거의 재지 않는다 — 그 모양에서만 무너지는 규칙(윙백의 가담, 투톱의 박스 점유)은 여기서
 * 드러난다.
 *
 *   pnpm balance live-formations
 */

const SEEDS = [42, 7];
const MATCHES_PER_SEED = 6;

type ShotGroup = "front" | "wide" | "mid" | "back";
const SHOT_GROUP_OF: Partial<Record<WeightSlot, ShotGroup>> = {
  ST: "front",
  CF: "front",
  W: "wide",
  AM: "mid",
  CM: "mid",
  DM: "mid",
  FB: "back",
  CB: "back",
};

interface Arm {
  teams: TeamSample[];
  shots: Record<ShotGroup, number>;
}

describe("포메이션마다", () => {
  const arms = new Map<string, Arm>();

  for (const formation of LIVE_FORMATION_ARMS) {
    it(`${formation} — 시드 ${SEEDS.join("·")} × 리그 ${MATCHES_PER_SEED}경기`, () => {
      const arm: Arm = { teams: [], shots: { front: 0, wide: 0, mid: 0, back: 0 } };
      for (const seed of SEEDS) {
        const state = createTestGame(seed);
        for (const fixture of leagueFixtures(state, MATCHES_PER_SEED)) {
          withFormation(state, fixture.homeTeamId, formation);
          withFormation(state, fixture.awayTeamId, formation);
          const live = liveMatchWith(state, fixture);
          playToEnd(live);
          arm.teams.push(...sampleOf(live).teams);
          for (const e of live.ledger.events) {
            if (e.type !== "shot" && e.type !== "goal") continue;
            const group =
              SHOT_GROUP_OF[weightSlotOf(live.positionsPlayed[e.actors[0] ?? ""] ?? "")];
            if (group) arm.shots[group] += 1;
          }
        }
      }
      arms.set(formation, arm);
      expect(arm.teams.length).toBe(SEEDS.length * MATCHES_PER_SEED * 2);
    });
  }

  it("모양마다 같은 가드에 선다", () => {
    const readings: Readings<typeof LIVE_FORMATIONS> = {};
    const goals: number[] = [];
    const km: number[] = [];
    for (const formation of LIVE_FORMATION_ARMS) {
      const arm = arms.get(formation);
      if (!arm) continue;
      const of = (pick: (t: TeamSample) => number) => mean(arm.teams.map(pick));
      const shotTotal = Math.max(
        1,
        Object.values(arm.shots).reduce((a, b) => a + b, 0),
      );
      const teamGoals = of((t) => t.goals);
      const teamKm = of((t) => t.line.distance / 1000);
      goals.push(teamGoals);
      km.push(teamKm);
      readings[`${formation} — 팀 득점`] = teamGoals;
      readings[`${formation} — 슈팅`] = of((t) => t.line.shots);
      readings[`${formation} — xG`] = of((t) => t.line.xg);
      readings[`${formation} — 팀 총 거리 (km)`] = teamKm;
      readings[`${formation} — 패스 시도`] = of((t) => t.line.passes);
      readings[`${formation} — 크로스`] = of((t) => t.line.crosses);
      readings[`${formation} — 슈팅 몫 · 최전방`] = arm.shots.front / shotTotal;
      readings[`${formation} — 슈팅 몫 · 측면`] = arm.shots.wide / shotTotal;
      readings[`${formation} — 슈팅 몫 · 미드`] = arm.shots.mid / shotTotal;
      readings[`${formation} — 슈팅 몫 · 수비`] = arm.shots.back / shotTotal;
    }
    readings["모양 사이 팀 득점 폭"] = Math.max(...goals) - Math.min(...goals);
    readings["모양 사이 거리 폭 (km)"] = Math.max(...km) - Math.min(...km);
    console.log(
      reportOf(
        LIVE_FORMATIONS,
        readings,
        `시드 ${SEEDS.join("·")} × 리그 ${MATCHES_PER_SEED}경기 × 모양 ${LIVE_FORMATION_ARMS.length} · 양 팀 같은 모양`,
      ),
    );
    expect(outOfBand(LIVE_FORMATIONS, readings)).toEqual([]);
  });
});
