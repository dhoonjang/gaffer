import { it, expect } from "vitest";
import {
  cupCatalogById,
  leagueOfTeamIn,
  simSquadOf,
  quickSimulate,
  simulateExtraTime,
} from "@gaffer/engine";
import { positionGroupOfPlayer } from "@gaffer/domain";
import { createTestGame } from "../test/helpers";
import { QUICK_OUTCOMES } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

it("quick outcomes calibration", () => {
  const state = createTestGame(3);
  const squad = (id: string) => simSquadOf(state, id, leagueOfTeamIn(state, id));
  const home = squad("mancity"),
    away = squad("arsenal");
  let goals = 0,
    cards = 0;
  for (let i = 0; i < 200; i++) {
    const r = simulateExtraTime(home, away, 500 + i, `extra:${i}`);
    goals += r.homeGoals + r.awayGoals;
    cards += r.cards.length;
  }
  const total = { eleven: { scored: 0, conceded: 0 }, ten: { scored: 0, conceded: 0 } };
  for (const [h, a] of [
    ["mancity", "hull"],
    ["arsenal", "everton"],
    ["fulham", "wolves"],
  ] as const) {
    const eleven = squad(h),
      opponent = squad(a);
    const gone = eleven.starters.find((p) => positionGroupOfPlayer(p) === "MF")!;
    const ten = { ...eleven, starters: eleven.starters.filter((p) => p.id !== gone.id) };
    for (const key of ["eleven", "ten"] as const)
      for (let i = 0; i < 150; i++) {
        const r = quickSimulate(
          key === "eleven" ? eleven : ten,
          opponent,
          10000 + i,
          `red:${h}:${i}`,
        );
        total[key].scored += r.homeGoals;
        total[key].conceded += r.awayGoals;
      }
  }
  const cup = cupCatalogById("ucl")!;
  const prize =
    cup.prize.participation +
    5 * cup.prize.win +
    2 * cup.prize.draw +
    Object.values(cup.prize.stage).reduce((a, b) => a + (b ?? 0), 0) +
    cup.prize.winner;
  const readings: Readings<typeof QUICK_OUTCOMES> = {
    extraGoals: goals / 200,
    extraCards: cards / 200,
    redConcededRatio: total.ten.conceded / total.eleven.conceded,
    redScoredRatio: total.ten.scored / total.eleven.scored,
    prizeIncomeRatio: prize / (12 * (13000000 + 6000000)),
  };
  console.log(reportOf(QUICK_OUTCOMES, readings, "fixed paired inputs"));
  expect(outOfBand(QUICK_OUTCOMES, readings)).toEqual([]);
});
