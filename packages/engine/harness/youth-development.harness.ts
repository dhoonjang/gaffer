import { ATTRIBUTE_AXES, type AxisValues } from "@story-fm/domain";
import {
  AXIS_AGING,
  rollMonthlyAxes,
  MENTOR_BOOST_MAX,
  growChance,
  RESERVE_APP_BOOST_MAX,
  FOCUS_BOOST,
} from "@story-fm/engine";
import { describe, expect, it } from "vitest";
import { ageOf, AXIS_GROUPS, isReserveMatch, PLAYER_ARCHETYPE_TRAITS } from "@story-fm/domain";
import type { GamePlayer } from "@story-fm/domain";
import {
  academyUseOf,
  MENTEES_PER_MENTOR,
  mentorBlock,
  mentorPairOf,
  playerArchetypeOf,
  reservePlayers,
  seasonStatOf,
  setDevelopmentFocus,
  setMentor,
  squadLevelOf,
  transitionSeason,
  type GameState,
} from "@story-fm/engine";
import { createTestGame } from "../test/helpers";
import { playSeason } from "./season";
import { YOUTH_DEVELOPMENT } from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 유스 육성 — **2군 리그가 돌고, 감독의 선택이 유망주의 성장 속도를 가르는가**
 * (→ `docs/common/season.md` §2 2군 리그).
 *
 *   pnpm balance youth-development
 *
 * 네 팔을 나란히 놓는다 — 집중 육성 / **멘토링** / 무지정 우리 2군 / 배율 없는 타 팀
 * 기준선. 집중 육성 격차가 0이면 육성이 게임플레이가 아니라 배경 시뮬로 되돌아간 것이다.
 *
 * ⚠️ **멘토링 팔은 종합이 아니라 정신 6축 합으로 읽는다** — 멘토 항이 닿는 자리가
 * 그 여섯뿐이라(people.md §5-3) 종합으로 읽으면 자리별 가중치가 그 몫을 반으로 접는다.
 * 그래도 표본이 셋이라 격차 자체는 눈금 아래이고, 항이 세계에 닿았는가는 성장 로그의
 * `origin`이 결정적으로 답한다.
 */

describe("한 시즌의 유스 육성", () => {
  it("시드 42", () => {
    const state = createTestGame(42);
    const values = Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, 50])) as AxisValues;
    const picks = (
      count: number,
      extra: { personal?: "finishing"; mentor?: number; boost?: number } = {},
    ) => {
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
    const plainMentalPicks = picks(1500),
      withMentor = picks(1500, { mentor: MENTOR_BOOST_MAX });
    const menuCounts = ATTRIBUTE_AXES.map(
      (a) => state.trainingSessions.filter((t) => t.focus.includes(a)).length,
    );
    const calibration = {
      "동일 곡선 축 빈도 최대비": axisRatio,
      "개인 결정력 훈련 선택비": aimed.get("finishing")! / baseline.get("finishing")!,
      "개인 훈련 나머지 필드 선택비": sum(aimed, restAxes) / sum(baseline, restAxes),
      "멘토 정신축 선택비":
        sum(withMentor, AXIS_GROUPS.mental) / sum(plainMentalPicks, AXIS_GROUPS.mental),
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
          b.attributes.potential -
          b.attributes.overall -
          (a.attributes.potential - a.attributes.overall),
      )
      .slice(0, 3)
      .map((p) => p.id);
    const set = setDevelopmentFocus(state, { playerIds: focusIds });
    expect(set.ok).toBe(true);

    /**
     * **멘토링 팔** — 우리 1군에서 자격을 통과하는 고참 중 리더십 최상위 하나에게,
     * 남은 2군 U21을 `MENTEES_PER_MENTOR`까지 맡긴다 (people.md §5-3).
     *
     * 무지정 팔과 **같은 잠재력 분포**를 갖게 여유 순으로 세운 뒤 홀수 자리를 뽑는다 —
     * 여유가 큰 쪽부터 잘라 가면 재는 것이 배율이 아니라 표본의 잠재력 차이가 된다.
     */
    const mentor = state.players
      .filter((p) => p.teamId === state.userTeamId && mentorBlock(state, p) === null)
      .sort((a, b) => b.attributes.leadership - a.attributes.leadership)[0];
    const restU21 = reservePlayers(state, state.userTeamId)
      .filter((p) => u21(state, p.birthdate) && !focusIds.includes(p.id))
      .sort(
        (a, b) =>
          b.attributes.potential -
          b.attributes.overall -
          (a.attributes.potential - a.attributes.overall),
      );
    const menteeIds = restU21
      .filter((_, index) => index % 2 === 1)
      .slice(0, MENTEES_PER_MENTOR)
      .map((p) => p.id);
    if (mentor && menteeIds.length > 0) {
      const assigned = setMentor(state, { mentorId: mentor.id, menteeIds });
      expect(assigned.ok).toBe(true);
      console.log(
        `멘토 ${mentor.name}(${ageOf(mentor.birthdate, state.date)}세 · 리더십 ` +
          `${mentor.attributes.leadership}) → ${menteeIds.length}명`,
      );
    } else {
      console.log("멘토 자격자가 없다 — 멘토링 팔이 비었다");
    }

    const before = new Map(state.players.map((p) => [p.id, p.attributes.overall]));
    /** 정신 6축 합 — 멘토 항이 닿는 자리가 그 여섯뿐이라 종합 대신 이 자를 쓴다 */
    const mentalSum = (p: GamePlayer) =>
      AXIS_GROUPS.mental.reduce((sum, axis) => sum + p.attributes[axis], 0);
    const mentalBefore = new Map(state.players.map((p) => [p.id, mentalSum(p)]));
    const ourReserveU21 = state.players
      .filter(
        (p) =>
          p.teamId === state.userTeamId &&
          squadLevelOf(p) === "reserve" &&
          u21(state, p.birthdate) &&
          !focusIds.includes(p.id) &&
          !menteeIds.includes(p.id),
      )
      .map((p) => p.id);
    const baselineU21 = state.players
      .filter(
        (p) =>
          p.teamId !== state.userTeamId && squadLevelOf(p) === "reserve" && u21(state, p.birthdate),
      )
      .map((p) => p.id);

    playSeason(state);

    const reserveMatches = state.matches.filter(isReserveMatch);
    const unplayed = reserveMatches.filter((m) => m.result === null).length;
    const reserveApps = reservePlayers(state, state.userTeamId).map(
      (p) => seasonStatOf(state, p.id)?.reserveApps ?? 0,
    );
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    // 시즌 중 계약 만료·은퇴로 떠난 선수는 표본에서 빠진다 — 성장을 잰 창이 다르다
    const growthOf = (ids: string[]) =>
      mean(
        ids
          .map((id) => {
            const player = state.players.find((p) => p.id === id);
            return player === undefined ? null : player.attributes.overall - before.get(id)!;
          })
          .filter((d): d is number => d !== null),
      );

    const focusGrowth = growthOf(focusIds);
    const baselineGrowth = growthOf(baselineU21);
    /**
     * 멘토링 표본은 **시즌이 끝난 시점에도 사이가 서 있는 선수**만 센다 — 멘토가
     * 떠나거나 승격으로 빠져 사이가 닫힌 아이의 성장은 이 팔의 몫이 아니다.
     */
    const stillMentored = menteeIds.filter((id) => mentorPairOf(state, id) !== null);
    const mentalGrowthOf = (ids: string[]) =>
      mean(
        ids
          .map((id) => {
            const player = state.players.find((p) => p.id === id);
            return player === undefined ? null : mentalSum(player) - mentalBefore.get(id)!;
          })
          .filter((d): d is number => d !== null),
      );
    const mentoredMental = mentalGrowthOf(stillMentored);
    const plainMental = mentalGrowthOf(ourReserveU21);
    const mentoringRows = state.growthLog.filter((g) => g.origin === "mentoring").length;
    /**
     * **직업의식이 세계 규모에서 실제로 갈리는가** (people.md §6).
     *
     * 집중 육성 표본은 셋뿐이라 원형 추첨의 잡음이 계수를 덮는다 — 배율 없는 타 팀
     * 2군 U21 전체를 성실/게으름으로 갈라야 계수의 몫만 남는다.
     */
    const professionalismOf = (id: string) => {
      const player = state.players.find((p) => p.id === id);
      return player === undefined
        ? null
        : PLAYER_ARCHETYPE_TRAITS[playerArchetypeOf(state.seed, player)].professionalism;
    };
    const DILIGENT_AT = 1.1;
    const LAZY_AT = 0.95;
    const diligent = baselineU21.filter((id) => (professionalismOf(id) ?? 0) >= DILIGENT_AT);
    const lazy = baselineU21.filter((id) => (professionalismOf(id) ?? 1) <= LAZY_AT);
    /** 멘토 자격자 — **전환 전의 명단**으로 센다 (아래 전환이 나이와 명단을 바꾼다) */
    const mentorEligible = state.players.filter(
      (p) => p.teamId === state.userTeamId && mentorBlock(state, p) === null,
    ).length;
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
    const intakeUpside = intake.map((p) => p.attributes.potential - p.attributes.overall);

    const readings: Readings<typeof YOUTH_DEVELOPMENT> = {
      ...calibration,
      "2군 경기 수": reserveMatches.length,
      "결과 없는 2군 경기": unplayed,
      "2군 평균 출전": mean(reserveApps),
      "집중 육성 시즌 성장": focusGrowth,
      "무지정 우리 2군 U21 성장": growthOf(ourReserveU21),
      "타 팀 2군 U21 성장": baselineGrowth,
      "집중 육성 격차": focusGrowth - baselineGrowth,
      "멘토 자격자": mentorEligible,
      "멘토링 표본": stillMentored.length,
      "멘토링 성장 로그": mentoringRows,
      "멘토링 정신축 성장": mentoredMental,
      "무지정 정신축 성장": plainMental,
      "멘토링 격차": mentoredMental - plainMental,
      "성실한 U21 표본": diligent.length,
      "게으른 U21 표본": lazy.length,
      "직업의식 격차": growthOf(diligent) - growthOf(lazy),
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
