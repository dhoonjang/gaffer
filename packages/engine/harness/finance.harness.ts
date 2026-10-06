import { describe, expect, it } from "vitest";
import {
  annualRevenueEstimate,
  cupCatalogById,
  financeOf,
  isMarketOnlyLeague,
  isTopLeague,
  leagueOfTeam,
  type GameState,
} from "@gaffer/engine";
import { advanceAndPlay, createTestGame, keepSeat } from "../test/helpers";
import {
  FINANCE_LEAGUES,
  FINANCE_MULTI_SEASON,
  FINANCE_SECOND_TIER,
  FINANCE_TIER1,
} from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";

/**
 * 한 시즌을 굴려 **살림의 크기**를 잰다 — 장부 손익 · 현금 · 급여 비중 · 수입,
 * 그리고 리그별 잔고.
 *
 *   pnpm balance finance
 *
 * 네 서술자가 **같은 진행을 나눠 쓴다.** 시드 42의 한 시즌은 세 시즌 실행의 첫 시즌이다 —
 * 같은 세계·같은 루프라, 따로 굴리면 감독 경기 오십 판(20분 남짓)을 한 번 더 치른다.
 */

/** 리그전을 굴리지 않는 리그 — 매치데이 보정이 붙는 자리 (finance.md §5.1) */
const SECOND_TIERS = ["championship", "serieb", "bundesliga2", "segunda"];

/**
 * 자리를 지킨 채 `seasons`번째 시즌이 끝날 때까지 돈다 — 경질은 시계를 멈추므로
 * (`state.dismissal`) 재정을 재는 동안 보드는 인내한다. 한 시즌이 끝날 때마다
 * `onSeasonEnd`가 그 자리의 원장을 본다.
 */
function playSeasonsKeepingSeat(
  state: GameState,
  seasons: number,
  onSeasonEnd: (state: GameState) => void = () => {},
): void {
  let guard = 120 * seasons;
  let season = state.season;
  while (guard-- > 0) {
    const before = state.date;
    keepSeat(state);
    advanceAndPlay(state, { userBench: true });
    if (state.season !== season) {
      season = state.season;
      onSeasonEnd(state);
    }
    if (state.date === before || state.season > seasons) break;
  }
}

/** UCL 우승 경로의 상금 합 — 참가 · 리그 단계 5승 2무 · 단계 수당 · 우승 */
function uclWinnerPrize(): number {
  const prize = cupCatalogById("ucl")!.prize;
  const stages = Object.values(prize.stage).reduce((a, b) => a + (b ?? 0), 0);
  return prize.participation + 5 * prize.win + 2 * prize.draw + stages + prize.winner;
}

/** EPL 구단의 중간 연 매출 추정 */
function eplMedianRevenue(state: GameState): number {
  return medianOf(
    state.teams
      .filter((t) => leagueOfTeam(t.id) === "epl")
      .map((t) => annualRevenueEstimate(state, t.id)),
  );
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** 리그전을 굴리지 않는 리그의 시작 잔고 — 한 시즌 수지의 기준선 */
function secondTierBalances(state: GameState): Map<string, number> {
  return new Map(
    state.teams
      .filter((t) => SECOND_TIERS.includes(leagueOfTeam(t.id) ?? ""))
      .map((t) => [t.id, financeOf(state, t.id).balance] as const),
  );
}

/** 시즌 1이 끝난 자리에서 읽은 세 서술자의 측정값 */
interface FirstSeason {
  tier1: Readings<typeof FINANCE_TIER1>;
  leagues: Readings<typeof FINANCE_LEAGUES>;
  leagueCount: number;
  worstLeague: string;
  secondTier: Readings<typeof FINANCE_SECOND_TIER>;
}

function firstSeasonOf(state: GameState, secondTierBefore: Map<string, number>): FirstSeason {
  const season1 = state.financeReports.filter((r) => r.season === 1);
  const sum = (pick: (r: (typeof season1)[number]) => number) =>
    season1.reduce((total, r) => total + pick(r), 0);
  // 프리시즌 달은 매치데이 수입이 없어 급여 비중이 자연히 높다 — 대상에서 뺀다
  const inSeason = season1.filter((r) => r.income.some((l) => l.category === "matchday"));
  const ratios = inSeason.map((r) => r.wageRatio);

  const byLeague = new Map<string, number[]>();
  for (const f of state.finances) {
    const league = leagueOfTeam(f.teamId);
    if (league === null) continue;
    byLeague.set(league, [...(byLeague.get(league) ?? []), f.balance]);
  }
  const worst = [...byLeague.entries()].sort((a, b) => medianOf(a[1]) - medianOf(b[1]))[0];
  const deltas = [...secondTierBefore].map(
    ([teamId, before]) => financeOf(state, teamId).balance - before,
  );
  return {
    tier1: {
      "시즌 1 보고서 수": season1.length,
      "연 장부 손익": sum((r) => r.pnlNet),
      "연 현금 순증": sum((r) => r.cashNet),
      "연 수입": sum((r) => r.incomeTotal),
      "연 지출": sum((r) => r.expenseTotal),
      "경기 달 수": inSeason.length,
      "경기 달 급여 비중 (최저)": ratios.length ? Math.min(...ratios) : Number.NaN,
      "경기 달 급여 비중 (최고)": ratios.length ? Math.max(...ratios) : Number.NaN,
      "대항전 우승 상금/1부 중간 연 매출": uclWinnerPrize() / eplMedianRevenue(state),
    },
    leagues: {
      "리그별 중간 잔고의 최소": Math.min(...[...byLeague.values()].map(medianOf)),
      "리그별 최저 잔고의 최소": Math.min(...[...byLeague.values()].map((xs) => Math.min(...xs))),
    },
    leagueCount: byLeague.size,
    worstLeague: worst?.[0] ?? "",
    secondTier: {
      "2부 구단 수": deltas.length,
      "2부 한 시즌 수지 중간값": medianOf(deltas),
    },
  };
}

/** 세 시즌을 돈 뒤의 다년 불변식 (finance.md §10.3) */
function multiSeasonOf(state: GameState): {
  readings: Readings<typeof FINANCE_MULTI_SEASON>;
  label: string;
} {
  const byLeague = new Map<string, { balance: number; revenue: number }[]>();
  for (const f of state.finances) {
    const league = leagueOfTeam(f.teamId);
    // 자유계약 자리와 시장 전용 리그는 클럽이 아니다 — 낼 것도 받을 것도 없다
    if (league === null || league === "free" || isMarketOnlyLeague(league)) continue;
    byLeague.set(league, [
      ...(byLeague.get(league) ?? []),
      { balance: f.balance, revenue: annualRevenueEstimate(state, f.teamId) },
    ]);
  }
  /**
   * 불변식 2의 자 — **그 리그 중간 구단의 연 매출**이다 (finance.md §10.3).
   * AI 구단은 원장을 남기지 않으므로(§4.5) 매출은 공식의 어림값을 쓴다.
   */
  const ceilings = [...byLeague.entries()].map(([league, xs]) => {
    const balance = medianOf(xs.map((x) => x.balance));
    const revenue = medianOf(xs.map((x) => x.revenue));
    return { league, balance, ratio: revenue > 0 ? balance / revenue : 0 };
  });
  const tallest = [...ceilings].sort((a, b) => b.ratio - a.ratio)[0];
  const topFlight = Math.max(...ceilings.filter((c) => isTopLeague(c.league)).map((c) => c.ratio));
  return {
    readings: {
      "도달한 시즌": state.season,
      "리그별 중간 잔고의 최소": Math.min(...ceilings.map((c) => c.balance)),
      "1부 중간 잔고 ÷ 중간 연 매출의 최대": topFlight,
      "전 리그 중간 잔고 ÷ 중간 연 매출의 최대": tallest?.ratio ?? 0,
      "천장에 가장 가까운 리그의 중간 잔고": tallest?.balance ?? 0,
    },
    label: `리그 ${byLeague.size}개 · 천장 ${tallest?.league}`,
  };
}

/**
 * 시드를 둘 재는 이유: 한 시즌의 총액이 성적 하나에 몇 %씩 움직여, 한 시드만으로는
 * 밴드 안인지 시드 운인지 가를 수 없다 (finance.md §10.2). 다년 불변식은 시드 42 하나를
 * 세 시즌 굴린다 — 한 시즌은 발산을 감추기에 충분히 짧다.
 */
const SEEDS = [42, 7];
const MULTI_SEED = 42;
const MULTI_SEASONS = 3;

describe("재정", () => {
  const firstSeasons = new Map<number, FirstSeason>();
  let multi: ReturnType<typeof multiSeasonOf> | null = null;

  it(`시드 ${MULTI_SEED} — 세 시즌 (시즌 1은 한 시즌 표본으로도 읽는다)`, () => {
    const state = createTestGame(MULTI_SEED, "arsenal");
    const before = secondTierBalances(state);
    playSeasonsKeepingSeat(state, MULTI_SEASONS, (s) => {
      if (!firstSeasons.has(MULTI_SEED)) firstSeasons.set(MULTI_SEED, firstSeasonOf(s, before));
    });
    multi = multiSeasonOf(state);
    // 세 시즌 — 감독 경기 백오십 판을 실시간으로 치른다(재정은 그 경기의 장부를 읽는다).
    // 전역 상한보다 넉넉하게만 준다
  }, 5_400_000);

  for (const seed of SEEDS.filter((s) => s !== MULTI_SEED)) {
    it(`시드 ${seed} — 한 시즌`, () => {
      const state = createTestGame(seed, "arsenal");
      const before = secondTierBalances(state);
      playSeasonsKeepingSeat(state, 1);
      firstSeasons.set(seed, firstSeasonOf(state, before));
    });
  }

  for (const seed of SEEDS) {
    it(`시드 ${seed} — tier1 유저 구단`, () => {
      const one = firstSeasons.get(seed)!;
      console.log(reportOf(FINANCE_TIER1, one.tier1, `시드 ${seed} · 아스날 · 시즌 1`));
      expect(outOfBand(FINANCE_TIER1, one.tier1)).toEqual([]);
    });

    it(`시드 ${seed} — 어떤 리그의 AI 구단도 한 시즌에 파산하지 않는다`, () => {
      const one = firstSeasons.get(seed)!;
      console.log(
        reportOf(
          FINANCE_LEAGUES,
          one.leagues,
          `시드 ${seed} · 리그 ${one.leagueCount}개 · 최저 ${one.worstLeague}`,
        ),
      );
      expect(outOfBand(FINANCE_LEAGUES, one.leagues)).toEqual([]);
    });

    it(`시드 ${seed} — 리그전을 굴리지 않는 리그도 한 시즌을 버틴다`, () => {
      const one = firstSeasons.get(seed)!;
      console.log(
        reportOf(FINANCE_SECOND_TIER, one.secondTier, `시드 ${seed} · ${SECOND_TIERS.join(" · ")}`),
      );
      expect(outOfBand(FINANCE_SECOND_TIER, one.secondTier)).toEqual([]);
    });
  }

  it(`시드 ${MULTI_SEED} — 세 시즌 뒤 가라앉는 리그가 없다`, () => {
    const { readings, label } = multi!;
    console.log(reportOf(FINANCE_MULTI_SEASON, readings, label));
    expect(outOfBand(FINANCE_MULTI_SEASON, readings)).toEqual([]);
  });
});
