import {
  acceptDeal,
  buildTransferWindows,
  computeStandings,
  domesticCupEntrants,
  isMarketOnlyLeague,
  isOutsideOurEconomy,
  LEAGUE_FACTOR_EXPONENT,
  leagueCatalog,
  leagueCatalogById,
  leagueEconomyLevel,
  leagueOfTeam,
  marketBiasOf,
  marketLeagues,
  marketValueOf,
  offerPlayerOut,
  playerById,
  playersOf,
  respondOffer,
  secondTierOf,
  teamCatalog,
  validateDeal,
  windowOpenForTeam,
  type GameState,
} from "@story-fm/engine";
import { describe, expect, it } from "vitest";
import { createTestGame } from "../helpers";

/**
 * 이적 시장 전용 리그 (사우디·MLS) — 경기를 하지 않고 이적 시장에만 존재한다.
 * 설계 근거는 docs/negotiation/transfer.md.
 */

const marketTeams = () => teamCatalog().filter((t) => isMarketOnlyLeague(t.leagueId));

describe("세계에서의 자리 — 경기를 하지 않는다", () => {
  it("일정에 한 경기도 없다 — 리그전도 컵도", () => {
    const state = createTestGame();
    const ids = new Set(marketTeams().map((t) => t.id));
    const played = state.matches.filter((m) => ids.has(m.homeTeamId) || ids.has(m.awayTeamId));
    expect(played).toEqual([]);
  });

  it("순위표에 오르지 않고 국내 컵에도 안 들어간다", () => {
    const state = createTestGame();
    for (const league of marketLeagues()) {
      expect(computeStandings(state, league.id)).toEqual([]);
    }
    const ids = new Set(marketTeams().map((t) => t.id));
    for (const cupId of ["facup", "carabao", "copadelrey", "dfbpokal"]) {
      for (const teamId of domesticCupEntrants(cupId)) {
        expect(ids.has(teamId), `${cupId}에 ${teamId}`).toBe(false);
      }
    }
  });

  it("우리 재정 세계 밖이다 — 원장 대신 상시 예산만 유지한다", () => {
    const state = createTestGame();
    for (const team of marketTeams()) {
      expect(isOutsideOurEconomy(team.id)).toBe(true);
      const finance = state.finances.find((f) => f.teamId === team.id);
      expect(finance, team.id).toBeDefined();
    }
  });
});

describe("이적창 — 우리와 시기가 다르다", () => {
  const seasonWindows = () => buildTransferWindows(1);

  it("우리 창이 닫힌 뒤에도 사우디는 열려 있다", () => {
    const state = createTestGame();
    state.windows = seasonWindows();
    state.date = "2026-09-20"; // 우리 여름 창은 9/1에 닫혔다

    expect(windowOpenForTeam(state, state.userTeamId)).toBeNull();
    expect(windowOpenForTeam(state, "alnassr")).not.toBeNull();
  });

  it("그래서 우리 창 밖에도 **팔 수는 있고 살 수는 없다**", () => {
    const state = createTestGame();
    state.windows = seasonWindows();
    state.date = "2026-09-20";
    const ours = playersOf(state, state.userTeamId)[0]!;
    const theirs = playersOf(state, "alnassr")[0]!;

    // 사우디로 매각 — 사는 쪽 협회 창이 열려 있으므로 막히지 않는다
    const sell = validateDeal(state, {
      playerId: ours.id,
      fee: 30_000_000,
      weeklyWage: 200_000,
      years: 3,
      kind: "sell",
      counterpartTeamId: "alnassr",
    });
    expect(sell.blockers.join()).not.toContain("이적시장이 닫혀");

    // 우리가 사오는 건 우리 협회 규정이라 막힌다
    const buy = validateDeal(state, {
      playerId: theirs.id,
      fee: 10_000_000,
      weeklyWage: 400_000,
      years: 2,
    });
    expect(buy.blockers.join()).toContain("이적시장이 닫혀");
  });

  /**
   * 오퍼가 열어 준 창을 **확정도 같은 창으로 재야 한다.** 확정만 우리 창으로 재면
   * 감독이 수락한 딜이 메디컬 다음 날 반드시 무산되고 `agreed`에 고착된다.
   */
  it("9월에 사우디로 파는 딜이 확정(`completed`)까지 간다", () => {
    const state = createTestGame();
    state.windows = seasonWindows();
    state.date = "2026-09-20";

    // 자리가 막힌 선수를 싸게 내민다 — 사는 쪽도 선수도 응할 조건
    const spare = [...playersOf(state, state.userTeamId)].sort(
      (a, b) => a.attributes.overall - b.attributes.overall,
    )[0]!;
    const offered = offerPlayerOut(state, {
      playerId: spare.id,
      teamId: "alnassr",
      fee: Math.round(marketValueOf(state, spare) / 2),
    });
    expect(offered.ok, offered.message).toBe(true);

    const negotiation = state.negotiations.find((n) => n.gamePlayerId === spare.id)!;
    state.date = negotiation.rounds[0]!.respondsOn ?? state.date;
    const answer = respondOffer(state, { negotiationId: negotiation.id, verdict: "accept" });
    expect(answer.ok, answer.message).toBe(true);
    expect(negotiation.status).toBe("agreed");

    const accepted = acceptDeal(state, negotiation.id);
    expect(accepted.ok, accepted.message).toBe(true);
    expect(negotiation.status).toBe("completed");
    expect(playerById(state, spare.id)?.teamId).toBe("alnassr");
  });

  it("MLS는 아예 다른 계절에 연다 — 우리 시즌 한복판", () => {
    const state = createTestGame();
    state.windows = seasonWindows();
    state.date = "2027-03-10";
    expect(windowOpenForTeam(state, state.userTeamId)).toBeNull();
    expect(windowOpenForTeam(state, "intermiami")).not.toBeNull();
  });
});

describe("시장 전용 리그의 경제 성향", () => {
  it("사우디는 지르고 MLS는 아낀다 — 둘 다 노장을 반긴다", () => {
    const state = createTestGame();
    const saudi = marketBiasOf(state, "alnassr");
    const mls = marketBiasOf(state, "intermiami");
    const ours = marketBiasOf(state, "arsenal");

    expect(saudi.fee).toBeGreaterThan(ours.fee);
    expect(saudi.wage).toBeGreaterThan(2);
    expect(mls.fee).toBeLessThan(ours.fee);
    for (const bias of [saudi, mls]) expect(bias.veteranAppetite).toBeGreaterThan(1);
  });
});

/**
 * 승강은 세이브(`state.leagueOf`)에만 남는다 — 카탈로그의 `leagueId`는 불변이다.
 * 그래서 "이 팀이 지금 어느 리그에 있나"를 묻는 시장 쪽 자리는 전부
 * `leagueOfTeamIn`을 지나야 한다 (docs/common/game-state.md §1).
 */
describe("시장은 세이브의 리그 소속을 본다", () => {
  it("시장가는 지금 뛰는 리그의 보정을 쓴다", () => {
    const state = createTestGame();
    const player = playersOf(state, state.userTeamId)[0]!;
    const before = marketValueOf(state, player);
    // 경제 수준이 더 낮은 리그로 옮기면(EPL 1.00 → 리그 1 0.42) 몸값이 따라 내려간다
    state.leagueOf = { ...(state.leagueOf ?? {}), [state.userTeamId]: "ligue1" };
    expect(marketValueOf(state, player)).toBeLessThan(before);
  });

  it("돈 성향과 이적창도 카탈로그가 아니라 세이브를 따라간다", () => {
    const state = createTestGame();
    state.windows = buildTransferWindows(1);
    state.date = "2027-03-10"; // 우리 창은 닫히고 MLS만 열린 날
    expect(marketBiasOf(state, state.userTeamId)).toEqual({ fee: 1, wage: 1, veteranAppetite: 1 });
    expect(windowOpenForTeam(state, state.userTeamId)).toBeNull();

    state.leagueOf = { ...(state.leagueOf ?? {}), [state.userTeamId]: "mls" };
    expect(marketBiasOf(state, state.userTeamId)).toEqual(marketBiasOf(state, "intermiami"));
    expect(windowOpenForTeam(state, state.userTeamId)).not.toBeNull();
  });
});

/**
 * 몸값의 리그 보정은 **티어를 아는 축**(경제 수준)을 쓴다. 리그 계수(`coefficient`)는
 * 나라 축이라 2부가 그 나라 1부와 같은 값이고, 승강은 언제나 한 나라 안에서 일어나므로
 * 계수로는 강등이 몸값에 닿지 않는다 (docs/negotiation/transfer.md §3).
 */
describe("리그 보정은 승강을 따라 움직인다", () => {
  // 세계를 한 번만 세운다 — 리그 소속(`leagueOf`) 말고는 아무것도 건드리지 않는다
  const state: GameState = createTestGame();
  const home = leagueOfTeam(state.userTeamId)!;
  const second = secondTierOf(home)!;
  /** 반올림(10만 단위)이 비율을 흐리지 않도록 스쿼드 최상위를 쓴다 */
  const player = [...playersOf(state, state.userTeamId)].sort(
    (a, b) => b.attributes.overall - a.attributes.overall,
  )[0]!;

  /** 그 리그에서 뛴다면 이 선수는 얼마인가 */
  const valueIn = (leagueId: string) => {
    state.leagueOf = { ...(state.leagueOf ?? {}), [state.userTeamId]: leagueId };
    return marketValueOf(state, player);
  };

  /** 어느 리그에서 강등해도 같은 비율이다 — 2부는 그 나라 1부의 0.15배다 */
  const RELEGATION_RATIO = Math.pow(0.15, LEAGUE_FACTOR_EXPONENT);

  it("강등하면 더 싸게, 승격하면 원래대로", () => {
    const inTop = valueIn(home);
    const inSecond = valueIn(second);
    expect(inSecond).toBeLessThan(inTop);
    expect(inSecond / inTop).toBeCloseTo(RELEGATION_RATIO, 2);
    // 되돌아오는 것까지가 한 쌍이다 — 강등이 값을 영구히 깎으면 승격이 보상이 아니다
    expect(valueIn(home)).toBe(inTop);
  });

  it("계수는 그대로인데도 값이 움직인다 — 나라 축이 아니라 티어 축이다", () => {
    // 같은 나라 1·2부는 계수가 같다. 이 값에 비례시키던 때는 한 푼도 안 움직였다
    expect(leagueCatalogById(second)!.coefficient).toBe(leagueCatalogById(home)!.coefficient);
  });

  it("눈금은 경제 수준의 거듭제곱이다 — 리그마다 문서의 표와 같은 값이 나온다", () => {
    // 우리 팀은 EPL(경제 수준 1.00)이라 보정이 곧 기준점이고, 비율은 상대 리그의 눈금이다
    expect(home).toBe("epl");
    const inEpl = valueIn(home);

    for (const league of leagueCatalog()) {
      expect(valueIn(league.id) / inEpl, league.id).toBeCloseTo(
        Math.pow(leagueEconomyLevel(league.id) / leagueEconomyLevel(home), LEAGUE_FACTOR_EXPONENT),
        2,
      );
    }
  });

  it("시장 전용 리그는 헐값이 아니다 — 계수 20·21이 식에 딸려 들어가던 자리", () => {
    const inEpl = valueIn(home);
    for (const league of marketLeagues()) {
      // 계수를 쓰던 때는 보정이 0.15·0.10이라 레전드가 동급의 7분의 1에 팔렸다
      expect(valueIn(league.id) / inEpl, league.id).toBeGreaterThan(RELEGATION_RATIO);
    }
  });
});
