import {
  playerOverall,
  ATTRIBUTE_AXES,
  type AxisValues,
  ageOf,
  isReserveMatch,
} from "@gaffer/domain";
import {
  AXIS_AGING,
  rollMonthlyAxes,
  growChance,
  RESERVE_APP_BOOST_MAX,
  FOCUS_BOOST,
  academyUseOf,
  reservePlayers,
  seasonStatOf,
  setDevelopmentFocus,
  squadLevelOf,
  transitionSeason,
  type GameState,
} from "@gaffer/engine";
import { describe, expect, it } from "vitest";
import { createTestGame } from "../test/helpers";
import { playSeason } from "./season";
import { YOUTH_DEVELOPMENT } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

describe("한 시즌의 유스 육성", () => {
  it("시드 42", () => {
    const state = createTestGame(42);
    const values = Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, 50])) as AxisValues;
    const picks = (count: number, extra: { personal?: "finishing"; boost?: number } = {}) => {
      const counts = new Map(ATTRIBUTE_AXES.map((a) => [a, 0]));
      for (let seed = 1; seed <= count; seed++)
        for (const row of rollMonthlyAxes({
          seed,
          date: "2027-03-01",
          playerId: "gp-42",
          age: 19,
          values,
          potential: 99,
          ...extra,
        })) {
          if (row.step > 0) counts.set(row.axis, counts.get(row.axis)! + 1);
        }
      return counts;
    };
    const balanced = picks(8000, { boost: 3 });
    const axisRatio = Math.max(
      ...(["early", "mid", "late"] as const).map((curve) => {
        const xs = ATTRIBUTE_AXES.filter((a) => AXIS_AGING[a] === curve).map((a) =>
          balanced.get(a)!,
        );
        return Math.max(...xs) / Math.min(...xs);
      }),
    );
    const baseline = picks(3000),
      aimed = picks(3000, { personal: "finishing" });
    const sum = (counts: typeof baseline, axes: readonly (typeof ATTRIBUTE_AXES)[number][]) =>
      axes.reduce((n, a) => n + counts.get(a)!, 0);
    const restAxes = ATTRIBUTE_AXES.filter((a) => a !== "finishing" && a !== "goalkeeping");
    const menuCounts = ATTRIBUTE_AXES.map(
      (a) => state.trainingSessions.filter((t) => t.focus.includes(a)).length,
    );
    const calibration = {
      "동일 곡선 축 빈도 최대비": axisRatio,
      "개인 결정력 훈련 선택비": aimed.get("finishing")! / baseline.get("finishing")!,
      "개인 훈련 나머지 필드 선택비": sum(aimed, restAxes) / sum(baseline, restAxes),
      "19세 축당 시즌 기대": growChance(50, 19),
      "18세 집중육성 시즌 기대": growChance(50, 18) * RESERVE_APP_BOOST_MAX * FOCUS_BOOST,
      "기본 훈련 축 빈도비": Math.max(...menuCounts) / Math.min(...menuCounts),
    };

    const u21 = (s: GameState, birthdate: string) => ageOf(birthdate, s.date) <= 21;

    // 잠재력 여유가 가장 큰 U21 셋에 집중 육성을 건다 — 감독이 할 법한 선택
    const focusIds = reservePlayers(state, state.userTeamId)
      .filter((p) => u21(state, p.birthdate))
      .sort(
        (a, b) =>
          b.attributes.potential - playerOverall(b) - (a.attributes.potential - playerOverall(a)),
      )
      .slice(0, 3)
      .map((p) => p.id);
    const set = setDevelopmentFocus(state, { playerIds: focusIds });
    expect(set.ok).toBe(true);

    const before = new Map(state.players.map((p) => [p.id, playerOverall(p)]));
    const ourReserveU21 = state.players
      .filter(
        (p) =>
          p.teamId === state.userTeamId &&
          squadLevelOf(p) === "reserve" &&
          u21(state, p.birthdate) &&
          !focusIds.includes(p.id),
      )
      .map((p) => p.id);
    const baselineU21 = state.players
      .filter(
        (p) =>
          p.teamId !== state.userTeamId && squadLevelOf(p) === "reserve" && u21(state, p.birthdate),
      )
      .map((p) => p.id);

    // 재는 것은 2군·육성이다 — 감독의 1군 경기는 결과만 있으면 된다
    playSeason(state, undefined, undefined, "quick");

    const reserveMatches = state.matches.filter(isReserveMatch);
    const unplayed = reserveMatches.filter((m) => m.result === null).length;
    const reserveApps = reservePlayers(state, state.userTeamId).map(
      (p) => seasonStatOf(state, p.id)?.reserveApps ?? 0,
    );
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    // 시즌 중 이적·은퇴로 떠난 선수는 표본에서 빠진다 — 성장을 잰 창이 다르다
    const growthOf = (ids: string[]) =>
      mean(
        ids
          .map((id) => {
            const player = state.players.find((p) => p.id === id);
            return player === undefined ? null : playerOverall(player) - before.get(id)!;
          })
          .filter((d): d is number => d !== null),
      );

    const focusGrowth = growthOf(focusIds);
    const baselineGrowth = growthOf(baselineU21);
    /**
     * **다음 여름의 인테이크** — 이 시즌 2군에 누구를 세웠는가가 한 해 뒤 후보의
     * 수와 여지로 돌아온다 (season.md §6 유스 인테이크). 전환 한 번을 더 굴리는 것은
     * 그 되돌아옴이 이 하네스가 이미 만든 2군 시즌 위에서만 보이기 때문이다 —
     * 활용도는 그 시즌 2군 출전 장부에서 나온다.
     *
     * ⚠️ **맨 마지막에 굴린다.** 위의 성장·표본은 전부 방금 끝난 시즌의 것이라, 전환이
     * 명단과 나이를 바꾼 뒤에 세면 다른 시즌을 재게 된다.
     */
    const academyUse = academyUseOf(state, state.userTeamId, state.season);
    transitionSeason(state);
    const intake = state.youthCandidates.map((row) => row.player);
    const intakeUpside = intake.map((p) => p.attributes.potential - playerOverall(p));

    const readings: Readings<typeof YOUTH_DEVELOPMENT> = {
      ...calibration,
      "2군 경기 수": reserveMatches.length,
      "결과 없는 2군 경기": unplayed,
      "2군 평균 출전": mean(reserveApps),
      "집중 육성 시즌 성장": focusGrowth,
      "무지정 우리 2군 U21 성장": growthOf(ourReserveU21),
      "타 팀 2군 U21 성장": baselineGrowth,
      "집중 육성 격차": focusGrowth - baselineGrowth,
      "아카데미 활용도": academyUse,
      "다음 여름 유스 후보": intake.length,
      "유스 후보 천장 — 평균": mean(intake.map((p) => p.attributes.potential)),
      "유스 후보 잠재력 여지 — 평균": mean(intakeUpside),
      "유스 후보 잠재력 여지 — 최대": Math.max(...intakeUpside),
    };
    console.log(reportOf(YOUTH_DEVELOPMENT, readings, `시드 42 · ${state.date}`));
    expect(outOfBand(YOUTH_DEVELOPMENT, readings)).toEqual([]);
  });
});
