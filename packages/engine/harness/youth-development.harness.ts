import { ATTRIBUTE_AXES, type AxisValues } from "@story-fm/domain";
import {
  AXIS_AGING,
  rollMonthlyAxes,
  growChance,
  RESERVE_APP_BOOST_MAX,
  FOCUS_BOOST,
} from "@story-fm/engine";
import { describe, expect, it } from "vitest";
import { ageOf, isReserveMatch } from "@story-fm/domain";
import type { GamePlayer } from "@story-fm/domain";
import {
  academyUseOf,
  assignmentsOf,
  groupOf,
  LOAN_BENCH_RUN_ALERT,
  LOAN_ROTATION_OVR_DROP,
  leagueOfTeamIn,
  loanPlayer,
  onLoanFromUs,
  reservePlayers,
  seasonStatOf,
  setDevelopmentFocus,
  squadLevelOf,
  teamShortNameIn,
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
 * 집중 육성·무지정·임대·타 팀 기준선의 실제 성장 경로를 비교한다.
 */

/** 임대 팔의 크기 — 평균을 낼 만큼은 되되, 우리 2군 팔을 비우지 않을 만큼 */
const LOAN_ARM_SIZE = 5;

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
    const otherContracts = state.contracts.filter(
      (c) => c.teamId !== state.userTeamId && leagueOfTeamIn(state, c.teamId) !== "laliga",
    );
    const calibration = {
      "동일 곡선 축 빈도 최대비": axisRatio,
      "개인 결정력 훈련 선택비": aimed.get("finishing")! / baseline.get("finishing")!,
      "개인 훈련 나머지 필드 선택비": sum(aimed, restAxes) / sum(baseline, restAxes),
      "19세 축당 시즌 기대": growChance(50, 19),
      "18세 집중육성 시즌 기대": growChance(50, 18) * RESERVE_APP_BOOST_MAX * FOCUS_BOOST,
      "기본 훈련 축 빈도비": Math.max(...menuCounts) / Math.min(...menuCounts),
      "비스페인 AI 바이아웃 비율":
        otherContracts.filter((c) => c.buyoutClause !== undefined).length / otherContracts.length,
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
     * **임대 팔** — 집중 육성과 겹치지 않는 U21 몇을 같은 리그의 다른 클럽으로
     * 보낸다(수준 계수 1.0). 창은 프리시즌 첫날(7/1)에 이미 열려 있다.
     *
     * 받는 쪽은 감독이 고르듯 **그 아이가 뛸 수 있는 곳부터** 고른다 — 그 구단의 같은
     * 포지션군 가장 약한 선발과의 차가 기량 창(`LOAN_ROTATION_OVR_DROP`) 안인 클럽을
     * 1군이 약한 순으로, **한 구단에 한 명씩**. 임대처 선택이 게임플레이가 되는 자리가
     * 그 창이라(season.md §2 임대) 창을 안 보고 보내면 재는 것이 상한의 문이 아니라
     * 그 시드가 뽑아 준 유망주의 종합이 된다. 창이 열린 구단이 하나도 없는 아이는
     * 가장 약한 구단으로 보낸다 — 한 경기도 못 뛰어야 하는 쪽의 표본이다. 한 명씩인
     * 것은 다섯을 한 구단에 몰면 재는 것이 그 구단 명단의 혼잡이 되기 때문이다.
     */
    const ourLeague = leagueOfTeamIn(state, state.userTeamId);
    const meanOverall = (squad: readonly { attributes: { overall: number } }[]) =>
      squad.reduce((sum, p) => sum + p.attributes.overall, 0) / (squad.length || 1);
    const hosts = state.teams
      .filter((t) => t.id !== state.userTeamId && leagueOfTeamIn(state, t.id) === ourLeague)
      .map((t) => ({
        id: t.id,
        strength: meanOverall(
          state.players.filter((p) => p.teamId === t.id && squadLevelOf(p) === "first"),
        ),
      }))
      .sort((a, b) => a.strength - b.strength)
      .map((t) => t.id);
    /**
     * 두 팔이 **같은 잠재력 분포**를 갖게 한 칸씩 걸러 뽑는다 — 여유가 큰 쪽부터
     * 잘라 가면 임대 팔이 무지정 팔의 위쪽을 통째로 가져가, 재는 것이 배율이 아니라
     * 표본의 잠재력 차이가 된다.
     */
    const loanCandidates = reservePlayers(state, state.userTeamId)
      .filter((p) => u21(state, p.birthdate) && !focusIds.includes(p.id))
      .sort(
        (a, b) =>
          b.attributes.potential -
          b.attributes.overall -
          (a.attributes.potential - a.attributes.overall),
      )
      .filter((_, index) => index % 2 === 0)
      .slice(0, LOAN_ARM_SIZE);
    /** 그 구단 선발 중 같은 포지션군에서 가장 약한 종합 — 자리가 없으면 창도 없다 */
    const weakestSeatOf = (teamId: string, player: GamePlayer): number | null => {
      const seats = assignmentsOf(state, teamId, "starting")
        .map((a) => state.players.find((p) => p.id === a.playerId))
        .filter((p): p is GamePlayer => p !== undefined && groupOf(p) === groupOf(player))
        .map((p) => p.attributes.overall);
      return seats.length === 0 ? null : Math.min(...seats);
    };
    const windowOpen = (teamId: string, player: GamePlayer) => {
      const weakest = weakestSeatOf(teamId, player);
      return weakest !== null && player.attributes.overall >= weakest - LOAN_ROTATION_OVR_DROP;
    };
    const loanedIds: string[] = [];
    /** 창이 열린 구단으로 보낸 아이 — 아래 「경보 전에 뛴 몫」의 분모다 */
    const inWindowIds = new Set<string>();
    const usedHosts = new Set<string>();
    for (const player of loanCandidates) {
      const rejected: string[] = [];
      const open = hosts.filter((teamId) => windowOpen(teamId, player));
      const closed = hosts.filter((teamId) => !open.includes(teamId));
      for (const teamId of [...open, ...closed]) {
        if (usedHosts.has(teamId)) continue;
        const sent = loanPlayer(state, { playerId: player.id, teamId });
        if (sent.ok) {
          loanedIds.push(player.id);
          usedHosts.add(teamId);
          if (open.includes(teamId)) inWindowIds.add(player.id);
          break;
        }
        rejected.push(`${teamShortNameIn(state, teamId)}: ${sent.message}`);
      }
      if (!loanedIds.includes(player.id)) {
        console.log(`임대 반려 — ${player.name}: ${rejected.slice(0, 3).join(" / ")}`);
      }
    }

    const before = new Map(state.players.map((p) => [p.id, p.attributes.overall]));
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

    playSeason(state);

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
            return player === undefined ? null : player.attributes.overall - before.get(id)!;
          })
          .filter((d): d is number => d !== null),
      );

    const focusGrowth = growthOf(focusIds);
    const baselineGrowth = growthOf(baselineU21);
    /**
     * 임대 표본은 **시즌이 끝난 시점에도 여전히 우리 임대인 선수**만 센다 — 중도
     * 복귀·이적으로 길이 갈린 선수의 성장은 임대의 몫이 아니다.
     */
    const stillOnLoan = loanedIds.filter((id) => {
      const player = state.players.find((p) => p.id === id);
      return player !== undefined && onLoanFromUs(state, player);
    });
    const loanGrowth = growthOf(stillOnLoan);
    /**
     * 임대처에서 실제로 뛴 경기와, **그 구단 경기에서 가장 길게 연속으로 명단 밖이던
     * 구간**. 앞 줄은 성장 배율에 곱할 분(分)이 있는가를 재고, 뒷줄은 리포트의
     * `no-minutes`(`LOAN_BENCH_RUN_ALERT` 4)가 배경음인지 사건인지를 가른다
     * (season.md §2 임대).
     */
    const hostMatchesOf = (teamId: string) =>
      state.matches
        .filter(
          (m) =>
            !isReserveMatch(m) &&
            m.result !== null &&
            (m.homeTeamId === teamId || m.awayTeamId === teamId),
        )
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const loanApps: number[] = [];
    /** 창 안 임대의 최장 연속 미출전 — 창 밖은 한 경기도 못 뛰어야 하는 쪽이라 세지 않는다 */
    const inWindowBenchRuns: number[] = [];
    for (const id of stillOnLoan) {
      const player = state.players.find((p) => p.id === id)!;
      let apps = 0;
      let run = 0;
      let longest = 0;
      for (const match of hostMatchesOf(player.teamId)) {
        const lineup =
          match.homeTeamId === player.teamId ? match.result?.homeLineup : match.result?.awayLineup;
        if (lineup?.includes(id)) {
          apps += 1;
          run = 0;
        } else {
          run += 1;
          longest = Math.max(longest, run);
        }
      }
      loanApps.push(apps);
      if (inWindowIds.has(id)) inWindowBenchRuns.push(longest);
      console.log(
        `임대 ${player.name}(${player.attributes.overall}) → ${teamShortNameIn(state, player.teamId)}` +
          `${inWindowIds.has(id) ? "" : " (창 밖)"}: ${apps}경기 · 최장 미출전 ${longest}`,
      );
    }

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
      "임대 표본": stillOnLoan.length,
      "임대 U21 성장": loanGrowth,
      "임대처 평균 출전": mean(loanApps),
      "기량 창 안의 임대": inWindowBenchRuns.length,
      "기량 창 밖의 임대": stillOnLoan.length - inWindowBenchRuns.length,
      "창 안 임대 중 경보 전에 뛴 몫": inWindowBenchRuns.length
        ? inWindowBenchRuns.filter((run) => run < LOAN_BENCH_RUN_ALERT).length /
          inWindowBenchRuns.length
        : 0,
      "임대 격차": loanGrowth - baselineGrowth,
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
