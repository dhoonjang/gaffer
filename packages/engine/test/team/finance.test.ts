import { beforeAll, describe, expect, it } from "vitest";
import { isReserveMatch, type FinanceCategory, type LedgerEntry } from "@gaffer/domain";
import type { GameState } from "@gaffer/engine";
import {
  annualRevenueEstimate,
  clubEconomyLevel,
  clubEconomyLevelIn,
  clubWageBudget,
  debtOf,
  runMonthlyFinance,
  applyMatchFinance,
  isCup,
  isTopFlight,
  isTopFlightIn,
  leagueOfTeamIn,
  payLeaguePrizes,
  parachuteSeasonAmount,
  isMarketOnlyLeague,
  isClubTeam,
  monthlyFixedCostOf,
  namedStaffMonthlyOf,
  staffWageBaseOf,
  depreciationOf,
  leagueTicketSpread,
  recordCapitalAsset,
  setTicketPrice,
  startParachute,
  stopParachute,
  ticketPriceOf,
  applyFinanceEvent,
  buildOfficeViews,
  weeklyWagesOf,
  clubProfile,
  currentMonthSummary,
  financeLookup,
  financeOf,
  ensureMonthlyPosted,
  paySeasonBonuses,
  isTelevised,
  leagueOfTeam,
  matchdayRevenue,
  monthOf,
  recordFinance,
  summarise,
  simulateOtherMatches,
  endSeason,
  closeSeasonBooks,
  skippedWageWeeks,
} from "@gaffer/engine";
import {
  advanceAndPlay,
  advanceDays,
  advanceToMatchday,
  resultOf,
  createMiniGame,
  createTestGame,
} from "../helpers";

/**
 * 구단 재정 (finance.md) — 원장·월간 보고서·수입 조항·부채·낙하산·자산 상각.
 * 모든 계산은 결정적이므로 LLM 없이 검증된다.
 */

/** 회계 기간의 경기 결과는 고정하고, 실제 재정 정산과 날짜 진행을 검증한다. */
function advanceUntil(state: GameState, date: string): void {
  let guard = 220;
  while (state.date < date && guard-- > 0) {
    const before = state.date;
    advanceToMatchday(state);
    if (state.phase === "matchday") {
      const match = state.matches.find(
        (m) =>
          m.date === state.date &&
          m.result === null &&
          !isReserveMatch(m) &&
          (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
      );
      if (!match) throw new Error("회계 픽스처의 경기일에 경기가 없습니다");
      match.result = resultOf({ homeGoals: 0, awayGoals: 0 });
      applyMatchFinance(state, match, "draw", []);
      const entry = state.schedule.find((e) => e.type === "match" && e.refId === match.id);
      if (entry) entry.status = "done";
      simulateOtherMatches(state, []);
      state.phase = "idle";
    }
    if (state.date === before) break;
    if (state.season > 1) break;
  }
}

/** 원장의 현금 흐름 합 (상각은 통장을 건드리지 않는다) */
function cashFlow(state: GameState): number {
  return financeOf(state, state.userTeamId)
    .ledger.filter((e) => e.accounting !== "noncash")
    .reduce((s, e) => s + (e.kind === "income" ? e.amount : -e.amount), 0);
}

describe("원장", () => {
  it("모든 엔트리에 카테고리가 붙고 잔고와 합이 맞는다", () => {
    const state = createTestGame();
    const opening = financeOf(state, state.userTeamId).balance;
    advanceDays(state, 14);
    const finance = financeOf(state, state.userTeamId);
    expect(finance.ledger.length).toBeGreaterThan(0);
    for (const entry of finance.ledger) {
      expect(entry.category).toBeTruthy();
      expect(entry.amount).toBeGreaterThan(0);
      expect(entry.id).toBeTruthy();
    }
    expect(finance.balance).toBe(opening + cashFlow(state));
  });

  it("AI 팀은 상세 원장을 쌓지 않고 잔고만 움직인다", () => {
    const state = createTestGame();
    const other = state.teams.find((t) => t.id !== state.userTeamId)!;
    const before = financeOf(state, other.id).balance;
    advanceDays(state, 14);
    expect(financeOf(state, other.id).ledger).toHaveLength(0);
    expect(financeOf(state, other.id).balance).not.toBe(before);
  });

  it("주급은 매주, 정액 항목은 매월 1일에만 기록된다", () => {
    const state = createMiniGame();
    advanceUntil(state, "2026-09-05");
    const ledger = financeOf(state, state.userTeamId).ledger;
    const monthlyDates = new Set(
      ledger.filter((e) => e.category === "facility").map((e) => e.date),
    );
    // 게임 시작 달만 예외 — 7/1엔 tick이 돌지 않아 첫 tick(7/2)이 보정한다
    for (const date of monthlyDates) {
      expect(date.endsWith("-01") || date === "2026-07-02").toBe(true);
    }
    expect(monthlyDates.has("2026-07-02")).toBe(true);
    // 주급은 월요일마다
    const wageDates = ledger.filter((e) => e.category === "player_wages").map((e) => e.date);
    expect(wageDates.length).toBeGreaterThan(2);
    for (const date of wageDates) {
      expect(new Date(`${date}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });
});

describe("매치데이", () => {
  it("관중은 수용인원 안에서 결정적으로 정해진다", () => {
    const state = createTestGame();
    const match = state.matches.find((m) => m.homeTeamId === state.userTeamId && !m.neutral)!;
    const first = matchdayRevenue(state, match);
    const again = matchdayRevenue(state, match);
    expect(first).toEqual(again); // 같은 세이브·같은 경기 = 같은 관중
    const { capacity } = clubProfile(state.userTeamId, 1);
    expect(first.attendance).toBeLessThanOrEqual(capacity);
    expect(first.attendance).toBeGreaterThan(capacity * 0.4);
    expect(first.income).toBeGreaterThan(0);
    expect(first.opex).toBeLessThan(first.income);
  });

  /**
   * 더비 항은 **상대 매력도와 따로 선다** — 같은 체급 상대와 갈리는 것이 그 항
   * 하나뿐이라, 차이가 곧 `OCCUPANCY_DERBY_BONUS × heat`다 (finance.md §5.2).
   */
  it("더비는 같은 체급의 다른 상대보다 관중을 더 부른다 — 결정적으로", () => {
    const state = createTestGame(7, "everton");
    const home = state.matches.find(
      (m) => m.homeTeamId === state.userTeamId && m.competitionId !== null && !m.neutral,
    )!;
    // 리버풀(머지사이드 더비 heat 3)과 첼시 — 둘 다 tier 1이고 표에는 하나만 있다
    const rival = matchdayRevenue(state, { ...home, awayTeamId: "liverpool" });
    const plain = matchdayRevenue(state, { ...home, awayTeamId: "chelsea" });
    expect(rival.occupancy, "만석에 잘려 더비 항이 사라졌다").toBeLessThan(1);
    expect(rival.occupancy - plain.occupancy).toBeCloseTo(0.09, 10);
    expect(matchdayRevenue(state, { ...home, awayTeamId: "liverpool" })).toEqual(rival);
  });

  it("구장이 작은 구단은 매치데이 수입도 작다", () => {
    const big = createTestGame(7, "manutd"); // 올드 트래퍼드 74,310
    const small = createTestGame(7, "bournemouth"); // 바이탈리티 11,307
    const revenueOf = (state: GameState) => {
      const match = state.matches.find((m) => m.homeTeamId === state.userTeamId && !m.neutral)!;
      return matchdayRevenue(state, match).income;
    };
    expect(revenueOf(big)).toBeGreaterThan(revenueOf(small) * 3);
  });

  it("생중계 수당은 토요일 15:00 경기와 대항전에는 없다", () => {
    const state = createTestGame();
    const league = state.matches.filter(
      (m) =>
        leagueOfTeam(state.userTeamId) === m.competitionId &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    );
    const blackout = league.filter(
      (m) => new Date(`${m.date}T00:00:00Z`).getUTCDay() === 6 && m.time === "15:00",
    );
    expect(blackout.length).toBeGreaterThan(0); // 편성에 토 15:00이 존재한다
    for (const m of blackout) expect(isTelevised(m)).toBe(false);
    const televised = league.filter(isTelevised);
    expect(televised.length).toBe(league.length - blackout.length);
    // 대항전 방송 수입은 UEFA 배분에 이미 들어 있다
    const cup = state.matches.find((m) => m.competitionId === "ucl");
    if (cup) expect(isTelevised(cup)).toBe(false);
  });

  /**
   * 유저 경기의 **상대 구단**도 경기 재정을 갖는다. 간이 시뮬은 두 팀을 다 챙기는데
   * 유저 경기만 유저 쪽을 기록해, 유저가 원정 가는 열아홉 경기의 홈 팀이 입장 수입을
   * 못 받고 있었다.
   */
  it("유저가 원정 간 경기의 홈 팀도 입장 수입을 받는다", () => {
    const state = createTestGame();
    const away = state.matches.find(
      (m) => m.awayTeamId === state.userTeamId && !m.neutral && !isCup(m.competitionId),
    )!;
    const host = away.homeTeamId;
    const before = financeOf(state, host).balance;

    applyMatchFinance(state, away, "loss", []);

    // AI 팀은 원장을 남기지 않으므로(§4.5) 잔고로 확인한다
    expect(financeOf(state, host).balance).toBeGreaterThan(before);
    // 유저 쪽은 원정이라 입장 수입이 없다 — 대신 원정 비용이 나간다
    expect(financeOf(state, state.userTeamId).ledger.some((e) => e.category === "matchday")).toBe(
      false,
    );
  });

  /**
   * 중립 결승은 **홈 표기가 자리 이름일 뿐**이다. 게이트는 개최지의 몫이라 어느 쪽도
   * 받지 않는데, 원정비를 홈 표기로 가르면 같은 결승에서 한 팀만 £400k를 낸다
   * (finance.md §5.2). 컵 경기라 생중계 수당도 없어 움직이는 돈이 원정비뿐이다.
   */
  it("중립 결승은 홈 수입이 없고 양 팀 다 원정비를 낸다", () => {
    const league = leagueOfTeam(createTestGame().userTeamId);

    const travel = (userIsHome: boolean): { user: number; rival: number } => {
      const state = createTestGame();
      const rival = state.teams.find(
        (t) => t.id !== state.userTeamId && leagueOfTeam(t.id) === league,
      )!.id;
      const final = {
        ...state.matches.find((m) => m.competitionId === league)!,
        id: `neutral-final-${userIsHome ? "home" : "away"}`,
        competitionId: "ucl",
        stage: "final" as const,
        homeTeamId: userIsHome ? state.userTeamId : rival,
        awayTeamId: userIsHome ? rival : state.userTeamId,
        neutral: true,
        result: null,
      };
      const before = financeOf(state, rival).balance;
      applyMatchFinance(state, final, "win", []);

      const ledger = financeOf(state, state.userTeamId).ledger;
      // 개최지의 게이트는 어느 쪽의 수입도 아니다
      expect(ledger.some((e) => e.category === "matchday")).toBe(false);
      return {
        user: ledger
          .filter((e) => e.category === "travel_medical")
          .reduce((sum, e) => sum + e.amount, 0),
        // AI 팀은 원장을 남기지 않으므로(§4.5) 잔고로 읽는다
        rival: before - financeOf(state, rival).balance,
      };
    };

    const asHome = travel(true);
    const asAway = travel(false);
    // 표기가 어느 쪽이든 우리가 내는 돈이 같고, 상대도 같은 돈을 낸다
    expect(asHome.user).toBeGreaterThan(0);
    expect(asAway.user).toBe(asHome.user);
    expect(asHome.rival).toBe(asHome.user);
    expect(asAway.rival).toBe(asHome.user);
  });

  it("경기 후 홈 입장 수입·운영비가 원장에 남는다", () => {
    const state = createMiniGame();
    let guard = 12;
    while (guard-- > 0) {
      advanceAndPlay(state);
      const ledger = financeOf(state, state.userTeamId).ledger;
      if (ledger.some((e) => e.category === "matchday")) break;
    }
    const ledger = financeOf(state, state.userTeamId).ledger;
    const gate = ledger.find((e) => e.category === "matchday");
    expect(gate).toBeTruthy();
    expect(gate!.label).toMatch(/명\)$/); // 관중 수가 항목명에 남는다
    expect(gate!.ref?.type).toBe("match");
    expect(ledger.some((e) => e.category === "matchday_opex")).toBe(true);
  });

  /**
   * 리그전을 굴리지 않는 리그는 홈 경기가 없어 매치데이가 0이다 — 그 몫을 월 정산이
   * 같은 공식으로 되돌린다 (finance.md §5.1). **굴리는 리그에는 붙지 않는다**:
   * 그쪽 매치데이는 경기가 만든다. 둘 다 붙으면 1부가 입장 수입을 두 번 번다.
   *
   * 아무 경기도 치르지 않은 t=0에서 재므로 매치데이 항목의 출처는 이 보정 하나뿐이다.
   */
  it("리그 홈경기 보정은 리그전을 굴리지 않는 리그에만 붙는다", () => {
    const matchdayIncome = (state: GameState) =>
      financeOf(state, state.userTeamId)
        .ledger.filter((e) => e.kind === "income" && e.category === "matchday")
        .reduce((sum, e) => sum + e.amount, 0);

    const top = createTestGame();
    ensureMonthlyPosted(top);
    expect(matchdayIncome(top)).toBe(0);

    const second = createTestGame();
    (second.leagueOf ??= {})[second.userTeamId] = "championship";
    ensureMonthlyPosted(second);
    expect(matchdayIncome(second)).toBeGreaterThan(0);
  });
});

/**
 * 원장·보고서는 **세계의 크기와 무관하다** — 달력이 돌고 우리 팀이 경기를 치르면
 * 같은 규칙이 같은 순서로 돈다. 그래서 여기서는 축소 세계로 달을 넘긴다
 * (전체 세계는 한 달에 200경기를 곁들여 굴린다).
 */
describe("월간 보고서", () => {
  it("매월 1일에 지난달이 마감되고 두 번 발행되지 않는다", () => {
    const state = createMiniGame();
    advanceUntil(state, "2026-09-03");
    const july = state.financeReports.filter((r) => r.month === "2026-07");
    expect(july).toHaveLength(1);
    expect(state.financeReports.some((r) => r.month === "2026-08")).toBe(true);
    // 이번 달(진행 중)은 아직 보고서가 없다
    expect(state.financeReports.some((r) => r.month === monthOf(state.date))).toBe(false);
    // 같은 달을 다시 마감하지 않는다
    advanceDays(state, 3);
    expect(state.financeReports.filter((r) => r.month === "2026-07")).toHaveLength(1);
  });

  it("보고서 합계가 그 달 원장과 일치하고 기초·기말이 이어진다", () => {
    const state = createMiniGame();
    advanceUntil(state, "2026-09-03");
    const report = state.financeReports.find((r) => r.month === "2026-08")!;
    const entries = financeOf(state, state.userTeamId).ledger.filter(
      (e) => monthOf(e.date) === "2026-08",
    );
    const direct = summarise(entries);
    expect(report.incomeTotal).toBe(direct.incomeTotal);
    expect(report.expenseTotal).toBe(direct.expenseTotal);
    expect(report.cashNet).toBe(direct.cashNet);
    expect(report.closingBalance - report.openingBalance).toBe(report.cashNet);
    // 앞선 달의 기말이 다음 달의 기초다
    const july = state.financeReports.find((r) => r.month === "2026-07")!;
    expect(report.openingBalance).toBe(july.closingBalance);
  });

  it("보고서 기초 잔고에서 이후 흐름을 더하면 현재 잔고가 된다 (절단 후에도)", () => {
    const state = createMiniGame();
    advanceUntil(state, "2026-12-05");
    const reports = [...state.financeReports].sort((a, b) => (a.month < b.month ? -1 : 1));
    const oldest = reports[0]!;
    const later = reports.filter((r) => r.month > oldest.month).reduce((s, r) => s + r.cashNet, 0);
    const thisMonth = currentMonthSummary(state).cashNet;
    expect(financeOf(state, state.userTeamId).balance).toBe(
      oldest.closingBalance + later + thisMonth,
    );
  });

  it("상세 원장은 3개월만 남고 보고서는 남는다", () => {
    const state = createMiniGame();
    advanceUntil(state, "2026-12-05");
    const months = new Set(financeOf(state, state.userTeamId).ledger.map((e) => monthOf(e.date)));
    expect(months.size).toBeLessThanOrEqual(3);
    expect(months.has("2026-07")).toBe(false); // 잘렸다
    expect(state.financeReports.some((r) => r.month === "2026-07")).toBe(true); // 요약은 영구
  });

  /**
   * 절단 기준월은 **월 번호를 빼서** 만든다 — 1·2월이면 그 뺄셈이 0 이하로 내려가
   * 지난해로 넘어가는 갈래를 탄다(`12 + cutoffMonth`). 그 갈래가 틀리면 겨울에
   * 원장이 통째로 날아가거나 한 해치가 그대로 쌓이는데, 보고서는 남으므로 화면의
   * 숫자는 어디도 달라지지 않는다.
   */
  it("원장 절단의 창은 해를 넘어서도 석 달이다", () => {
    /** 원장을 손으로 깔고 그 달 1일의 월초 정산만 돌린다 — 반년을 흘려보내지 않는다 */
    const monthsAfterPrune = (today: string, months: string[]): string[] => {
      const state = createMiniGame();
      state.date = today;
      const finance = financeOf(state, state.userTeamId);
      finance.ledger = months.map((m) => ({
        id: `led-${m}`,
        date: `${m}-05`,
        kind: "expense" as const,
        category: "matchday_opex" as const,
        label: "테스트 지출",
        amount: 1_000,
      }));
      runMonthlyFinance(state, []);
      return [...new Set(finance.ledger.map((e) => monthOf(e.date)))].sort();
    };

    // 1월 — 창의 앞끝이 **지난해 11월**이다
    expect(monthsAfterPrune("2027-01-01", ["2026-09", "2026-10", "2026-11", "2026-12"])).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
    ]);
    // 2월 — 뺄셈이 정확히 0인 자리 (12월이 앞끝)
    expect(monthsAfterPrune("2027-02-01", ["2026-10", "2026-11", "2026-12", "2027-01"])).toEqual([
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  it("석 달이 지나 원장이 잘려도 큰 건의 날짜는 달력 일지에 남는다", () => {
    const state = createMiniGame();
    const bigDate = state.date;
    const label = "창단 기념 스폰서 보너스";
    expect(
      applyFinanceEvent(state, {
        kind: "income",
        category: "commercial",
        amount: 2_000_000,
        note: label,
      }).ok,
    ).toBe(true);

    advanceUntil(state, "2026-12-05");

    // 원장에서 그날은 잘려 나갔다
    expect(financeOf(state, state.userTeamId).ledger.some((e) => e.date === bigDate)).toBe(false);
    // 그래도 달력은 날짜와 금액을 안다 — 보고서의 highlights에서 파생하기 때문
    const day = buildOfficeViews(state).calendar.events[bigDate] ?? [];
    expect(day.filter((e) => e.kind === "money").map((e) => e.text)).toEqual([`${label} +£2.0M`]);
  });

  it("급여 비중과 판단 재료가 붙는다 — 노트는 문장이 아니라 카드다", () => {
    const state = createMiniGame();
    advanceUntil(state, "2026-10-03");
    const report = state.financeReports.find((r) => r.month === "2026-09")!;
    expect(report.wageRatio).toBeGreaterThan(0);
    expect(report.wageRatio).toBeLessThan(2);
    expect(Array.isArray(report.noteCards)).toBe(true);
  });
});

/**
 * 명명 스태프 — 파생 비율에서 덜어 낸다 (finance.md §6.3).
 *
 * 고용은 스태프 급여를 **늘리는 것이 아니라 그 안에서 이름을 얻는 것**이다. 파생 줄에서
 * 명명된 만큼을 빼지 않으면 새 게임의 인건비가 조용히 무거워져 §10.2의 실측이 어긋나고,
 * 반대로 대상별 줄을 접어 합계 한 줄로 두면 감독이 사람 단위로 드릴다운할 곳이 사라진다.
 */
describe("스태프 급여", () => {
  it("명명 스태프가 이름으로 서고 총액은 파생 기준액 그대로다", () => {
    const state = createMiniGame();
    const teamId = state.userTeamId;
    runMonthlyFinance(state, []);

    const lines = financeOf(state, teamId).ledger.filter((e) => e.category === "staff_wages");
    // 감독은 스태프가 아니다 — 파생 몫 위에 따로 얹힌다
    const total = lines.filter((e) => e.label !== "감독 연봉").reduce((s, e) => s + e.amount, 0);

    const base = staffWageBaseOf(state, teamId);
    const named = namedStaffMonthlyOf(state, teamId);
    // 시작 인원(수석코치 + 코치 2 · 의료진 1 · 스카우트 1)은 기준액 한참 아래다
    expect(named).toBeGreaterThan(0);
    expect(named).toBeLessThan(base);
    expect(total).toBe(Math.round(Math.max(base, named)));
    expect(lines.find((e) => e.label === "코칭·사무 스태프 급여")?.amount).toBe(
      Math.round(base) - named,
    );

    // 대상별로 이름과 직책을 달고 선다
    const people = state.personas.filter((p) => p.employment?.teamId === teamId);
    expect(people.length).toBeGreaterThanOrEqual(5);
    for (const person of people) {
      const job = person.employment!;
      expect(
        lines.find((e) => e.label === `${person.name} (${job.title})`)?.amount,
        `${person.name} 급여 줄`,
      ).toBe(Math.round(job.contract.salary / 12));
    }

    // AI 구단은 명명 스태프가 없다 — 파생 줄 하나뿐이라 예전과 같다
    const rival = state.teams.find((t) => t.id !== teamId && isClubTeam(t.id))!;
    expect(namedStaffMonthlyOf(state, rival.id)).toBe(0);
  });
});

describe("성적이 돈이 되는 자리", () => {
  /** 그달 스폰서십 수입 — 조항이 곱해진 값 */
  function sponsorship(state: GameState, month: string): number {
    return financeOf(state, state.userTeamId)
      .ledger.filter((e) => monthOf(e.date) === month && e.label === "스폰서십")
      .reduce((sum, e) => sum + e.amount, 0);
  }

  it("대항전 진출은 대회마다 붙고, 트로피는 종류를 가리지 않고 한 번 붙는다", () => {
    const state = createTestGame(42, "arsenal");
    const us = state.userTeamId;
    /**
     * 달만 넘겨 같은 세이브에서 조항을 갈아 끼운다 — 세계를 여섯 번 세우지 않는다.
     * 월초 정액 항목은 그달에 한 번만 붙으므로(`ensureMonthlyPosted`) 달이 곧 표본이다.
     */
    const clause = (month: string, set: () => void): number => {
      set();
      state.date = `${month}-01`;
      ensureMonthlyPosted(state);
      return sponsorship(state, month);
    };

    const bare = clause("2026-07", () => {
      state.euroEntrants = [];
      state.trophies = [];
    });
    const ucl = clause("2026-08", () => {
      state.euroEntrants = [{ cupId: "ucl", teams: [us] }];
    });
    const uel = clause("2026-09", () => {
      state.euroEntrants = [{ cupId: "uel", teams: [us] }];
    });
    const uecl = clause("2026-10", () => {
      state.euroEntrants = [{ cupId: "uecl", teams: [us] }];
    });
    const cup = clause("2026-11", () => {
      state.euroEntrants = [];
      state.trophies = [{ season: state.season - 1, competitionId: "facup", teamId: us }];
    });
    const two = clause("2026-12", () => {
      state.trophies = [
        { season: state.season - 1, competitionId: "facup", teamId: us },
        { season: state.season - 1, competitionId: "epl", teamId: us },
      ];
    });

    expect(bare).toBeGreaterThan(0);
    expect(ucl / bare).toBeCloseTo(1.15, 3);
    expect(uel / bare).toBeCloseTo(1.06, 3);
    expect(uecl / bare).toBeCloseTo(1.03, 3);
    // 리그든 컵이든 트로피 하나 — 두 개를 들어도 값이 같다
    expect(cup / bare).toBeCloseTo(1.2, 3);
    expect(two).toBe(cup);
  });

  /**
   * **우승은 전 구단의 것으로 쌓이므로 AI 구단도 같은 조항을 받는다** (finance.md §5.3).
   * 유저 팀만 트로피를 적던 시절엔 이 조항이 감독 구단에만 붙어, 우승한 AI 구단이
   * 다음 시즌 살림에서 아무것도 얻지 못했다.
   *
   * AI 구단은 원장을 남기지 않으므로(`recordFinance`) 잰 자리는 **잔고의 변화**다.
   * 절대액 대신 **UCL 조항과의 비**를 보는 것은 상업 정액이 브랜드 등급에서 나와
   * 이 테스트가 그 눈금을 다시 적지 않게 하기 위해서다 — 두 조항의 밑이 같다.
   */
  it("트로피 조항은 AI 구단에도 붙는다 — 원장이 없을 뿐 조항은 같다", () => {
    const state = createTestGame(42, "arsenal");
    const ai = state.teams.find(
      (t) => t.id !== state.userTeamId && leagueOfTeam(t.id) === "epl",
    )!.id;

    /** 그달 AI 구단 잔고의 변화 — 월초 정액 항목은 그달에 한 번만 붙는다 */
    const monthly = (month: string, set: () => void): number => {
      set();
      state.date = `${month}-01`;
      const before = financeOf(state, ai).balance;
      ensureMonthlyPosted(state);
      return financeOf(state, ai).balance - before;
    };

    const bare = monthly("2026-08", () => {
      state.euroEntrants = [];
      state.trophies = [];
    });
    const ucl = monthly("2026-09", () => {
      state.euroEntrants = [{ cupId: "ucl", teams: [ai] }];
    });
    const trophy = monthly("2026-10", () => {
      state.euroEntrants = [];
      state.trophies = [{ season: state.season - 1, competitionId: "epl", teamId: ai }];
    });

    expect(ucl).toBeGreaterThan(bare);
    // 트로피 +0.20 대 UCL +0.15 — 같은 상업 정액에 붙는 두 조항의 비다
    expect((trophy - bare) / (ucl - bare)).toBeCloseTo(0.2 / 0.15, 3);
  });

  it("시즌 성과 보너스는 순위 계단마다 주급 총액의 배수다", () => {
    const state = createTestGame(42, "arsenal");
    const wages = weeklyWagesOf(state, state.userTeamId);
    expect(wages).toBeGreaterThan(0);

    /** 멱등 키가 시즌을 달고 있으므로 시즌을 넘겨 계단마다 새로 받는다 */
    const bonusAt = (position: number): number => {
      const before = financeOf(state, state.userTeamId).balance;
      paySeasonBonuses(state, position, []);
      state.season += 1;
      return before - financeOf(state, state.userTeamId).balance;
    };

    expect(bonusAt(1)).toBe(Math.round(wages * 4));
    expect(bonusAt(2)).toBe(Math.round(wages * 2));
    expect(bonusAt(4)).toBe(Math.round(wages * 2));
    expect(bonusAt(5)).toBe(Math.round(wages));
    expect(bonusAt(6)).toBe(Math.round(wages));
    // 계단은 고정이다 — 리그 팀 수도, 대항전 티켓 수(EPL은 UCL 5)도 보지 않는다
    expect(bonusAt(7)).toBe(0);
  });
});

describe("리그별 편차", () => {
  it("같은 등급이어도 리그에 따라 방송 수입이 다르다", () => {
    const epl = createTestGame(11, "arsenal");
    const ligue1 = createTestGame(11, "psg");
    const broadcastOf = (state: GameState) => {
      advanceDays(state, 40); // 8월 1일 정산까지
      return financeOf(state, state.userTeamId)
        .ledger.filter((e) => e.category.startsWith("broadcast"))
        .reduce((sum, e) => sum + e.amount, 0);
    };
    const eplTotal = broadcastOf(epl);
    const ligue1Total = broadcastOf(ligue1);
    expect(eplTotal).toBeGreaterThan(0);
    // 균등분은 리그 무관, 성적 수당·생중계 수당은 리그 규모에 비례한다
    expect(ligue1Total).toBeLessThan(eplTotal);
  });
});

/**
 * 시즌 마감 — 마지막 달과 전환이 건너뛰는 주급 (finance.md §7.1).
 */
describe("시즌 마감", () => {
  it("시즌 종료는 전환 전에 마지막 달을 마감한다", () => {
    const state = createTestGame(42, "arsenal");
    state.date = "2027-06-01";
    runMonthlyFinance(state, []); // 6월 정액 항목
    state.date = "2027-06-05";
    recordFinance(state, state.userTeamId, {
      kind: "income",
      category: "commercial",
      label: "시즌 마지막 달의 큰 수입",
      amount: 300_000_000,
    });

    endSeason(state);

    const june = state.financeReports.find(
      (r) => r.month === "2027-06" && r.teamId === state.userTeamId,
    );
    expect(june).toBeTruthy();
    // 끝난 시즌의 보고서다 — 시즌 번호는 전환 전의 달력으로 역산된다
    expect(june!.season).toBe(1);
    expect(state.season).toBe(2);
    expect(june!.incomeTotal).toBeGreaterThanOrEqual(300_000_000);
  });

  /**
   * 마지막 달의 주급 — 전환이 건너뛰는 월요일만큼 마감이 함께 문다 (finance.md §7.1).
   * 경계는 양 끝이다: 종료일의 주급은 그날의 tick이 이미 물었고, 7월 1일은 새 시즌의
   * 몫이다. 세는 자리가 하루 어긋나면 전 구단의 한 시즌 지출이 한 주씩 틀린다.
   */
  it("마지막 달은 전환이 건너뛰는 월요일 수만큼 주급을 문다", () => {
    // 종료일이 월요일이어도 그날은 이미 물었다 — 6/14·21·28 세 번
    expect(skippedWageWeeks("2027-06-07", "2027-07-01")).toBe(3);
    // 시작 **전날**까지다 — 7월 1일이 월요일이어도 그 주급은 새 시즌의 몫이다
    expect(skippedWageWeeks("2024-06-04", "2024-07-01")).toBe(3);
    expect(skippedWageWeeks("2024-06-24", "2024-07-01")).toBe(0);
    // 마지막 월요일을 지나 끝난 시즌은 물 것이 없다
    expect(skippedWageWeeks("2027-06-29", "2027-07-01")).toBe(0);

    const state = createTestGame(42, "arsenal");
    state.date = "2027-06-05"; // 6/7·14·21·28 — 네 번
    // AI 팀은 주급을 한 줄로 문다 — 반올림이 한 번뿐이라 눈금이 그대로 보인다
    const ai = state.teams.find(
      (t) =>
        t.id !== state.userTeamId && isClubTeam(t.id) && !isMarketOnlyLeague(leagueOfTeam(t.id)),
    )!;
    const weekly = weeklyWagesOf(state, ai.id);
    const before = financeOf(state, ai.id).balance;

    closeSeasonBooks(state, []);

    expect(weekly).toBeGreaterThan(0);
    expect(financeOf(state, ai.id).balance).toBe(before - Math.round(weekly * 4));
  });
});

/**
 * 리그 순위 상금 — 리그를 어느 축으로 읽는가 (finance.md §5.1.1).
 * 승강은 `state.leagueOf`로만 표현되므로 카탈로그 리그로 읽으면 상금이 사라진다.
 */
describe("리그 순위 상금", () => {
  const key = (season: number) => `league-prize:S${season}`;

  it("승격한 구단은 새 리그의 상금을 받는다 — 리그는 세이브 기준이다", () => {
    const state = createTestGame();
    // 승격 한 팀 · 강등 한 팀 (승강의 유일한 표현이 이 표다)
    state.leagueOf = { wolves: "epl", coventry: "championship" };

    payLeaguePrizes(state, []);

    // 올라온 팀은 1부 순위표에 있으므로 상금을 받는다
    expect(financeOf(state, "wolves").prizesPaid).toContain(key(state.season));
    // 남아 있는 팀도 그대로 받는다
    expect(financeOf(state, "arsenal").prizesPaid).toContain(key(state.season));
    // 내려간 팀은 리그전을 하지 않는 리그로 갔으므로 순위 상금이 없다
    expect(financeOf(state, "coventry").prizesPaid).not.toContain(key(state.season));
  });

  it("리그전을 하지 않는 2부는 순위 상금을 받지 않는다", () => {
    const state = createTestGame();
    payLeaguePrizes(state, []);

    const paidIn = (league: string) =>
      state.finances.filter(
        (f) => leagueOfTeam(f.teamId) === league && f.prizesPaid.includes(key(state.season)),
      ).length;

    // 0경기 0승점 순위표는 카탈로그 등재 순서를 그대로 순위로 만든다 — 상금을 줄 수 없다
    for (const league of ["championship", "serieb", "ligue2", "segunda", "bundesliga2"]) {
      expect(paidIn(league), league).toBe(0);
    }
    expect(paidIn("epl")).toBeGreaterThan(0);
  });
});

/**
 * 부채 (finance.md §9.2) — 음수 잔고에 값이 붙는다.
 * 지금 세계엔 한도까지 가는 구단이 없으므로 잔고를 손으로 밀어 경로를 고정한다.
 */
describe("부채", () => {
  /** 잔고를 빚으로 밀고 한 달을 넘긴다 */
  function intoDebt(state: GameState, teamId: string, debt: number): void {
    financeOf(state, teamId).balance = -debt;
  }

  it("빚에는 이자가 붙고 이자·세금과 같은 항목에 들어간다", () => {
    const state = createMiniGame();
    intoDebt(state, state.userTeamId, 50_000_000);
    expect(debtOf(state, state.userTeamId)).toBe(50_000_000);

    advanceUntil(state, "2026-09-03");

    const interest = financeOf(state, state.userTeamId).ledger.filter(
      (e) => e.label === "부채 이자",
    );
    expect(interest.length).toBeGreaterThan(0);
    // 새 카테고리를 만들지 않는다 — 이자·세금과 같은 자리다
    for (const entry of interest) expect(entry.category).toBe("facility");
    // 연 8%의 한 달치 — £50M이면 월 £333k 언저리에서 시작한다
    expect(interest[0]!.amount).toBeGreaterThan(300_000);
    expect(interest[0]!.amount).toBeLessThan(400_000);
    // 이자는 현금이다(상각과 다르다) — 빚이 더 깊어진다
    expect(financeOf(state, state.userTeamId).balance).toBeLessThan(0);
  });

  it("원금은 자본 이동이라 손익에 없다 — 이자만 손익에 잡힌다", () => {
    const plain = createMiniGame();
    const indebted = createMiniGame();
    indebted.finances.find((f) => f.teamId === indebted.userTeamId)!.balance = -50_000_000;

    advanceUntil(plain, "2026-09-03");
    advanceUntil(indebted, "2026-09-03");

    const pnlOf = (state: GameState) =>
      state.financeReports.filter((r) => r.month === "2026-08").reduce((s, r) => s + r.pnlNet, 0);
    // 빚을 진 쪽이 딱 이자만큼 나쁘다 — 원금 £50M은 손익에 없다
    const gap = pnlOf(plain) - pnlOf(indebted);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(1_000_000);
  });
});

describe("조회", () => {
  it("get_finance는 잔고·보고서·이번 달 잠정을 한 번에 준다", () => {
    const state = createMiniGame();
    advanceUntil(state, "2026-09-03");
    const result = financeLookup(state);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("잔고");
    expect(result.message).toContain("월간 보고서");
    expect(result.message).toContain("진행 중");
    // 없는 달을 물으면 발행된 달을 알려준다
    expect(financeLookup(state, "2099-01").message).toContain("보고서가 없습니다");
  });
});

/**
 * 살림의 구조 — **시뮬 없이 t=0에서 잰다.** 리그 배율·고정비·초기치는 상수와
 * 생성 규칙이 정하므로 시즌을 굴릴 필요가 없고, 어떤 상수를 건드려도 즉시 걸린다.
 */
describe("재정 구조 (t=0)", () => {
  /**
   * 리그 배율 — **지출과 초기치도 리그를 안다** (finance.md §6.2).
   *
   * 수입만 `broadcastPool`을 타고 지출은 tier만 보던 시절, 세리에B 구단의 시설·이자
   * 고정비가 선수단 인건비의 1.9배였고 PSG가 아스날과 같은 £120M으로 시작했다.
   * 시뮬 없이 t=0에서 재므로 어떤 상수를 건드려도 즉시 걸린다.
   */
  it("어느 구단도 구조적으로 매출을 넘겨 쓰지 않는다", () => {
    const state = createTestGame(42, "arsenal");
    for (const team of state.teams) {
      const league = leagueOfTeam(team.id);
      // 무소속·시장 전용 리그는 재정을 굴리지 않는다
      if (league === "free" || isMarketOnlyLeague(league)) continue;
      const wages = weeklyWagesOf(state, team.id) * 52;
      if (wages <= 0) continue;

      const revenue = annualRevenueEstimate(state, team.id);
      // 인건비만으로 매출을 다 쓰면 그 구단은 아무것도 할 수 없다
      expect(wages / revenue, `${team.id} 주급/매출`).toBeLessThan(1);
      /**
       * 경기를 하든 안 하든 나가는 돈이 매출의 4할을 넘으면 그 리그는 가라앉는다.
       * 세리에B가 리그 배율 전에 0.91이었다 — tier 정액을 리그 무관하게 물던 자리다.
       */
      expect((monthlyFixedCostOf(team.id) * 12) / revenue, `${team.id} 고정비/매출`).toBeLessThan(
        0.4,
      );
    }
  });

  it("같은 등급이어도 리그에 따라 살림의 크기가 다르다", () => {
    const state = createTestGame(42, "arsenal");
    // tier1 · 브랜드1이 같아도 리그가 다르면 고정비·초기치가 갈린다
    expect(monthlyFixedCostOf("psg")).toBeLessThan(monthlyFixedCostOf("arsenal"));
    expect(financeOf(state, "psg").balance).toBeLessThan(financeOf(state, "arsenal").balance);

    // 2부는 그 나라 1부에서 파생한다 — 네 나라의 2부가 더 이상 같은 살림이 아니다
    const second = ["westham", "sampdoria", "saintetienne"] as const; // 챔피언십·세리에B·리그2, 전부 tier3
    const wages = second.map((id) => weeklyWagesOf(state, id));
    expect(new Set(wages).size, "2부 주급이 리그마다 갈린다").toBe(second.length);
    expect(wages[0]!).toBeGreaterThan(wages[1]!); // 챔피언십 > 세리에B
    expect(wages[1]!).toBeGreaterThan(wages[2]!); // 세리에B > 리그2
  });
});

describe("재정이 도는 범위", () => {
  /** 그 달의 정액 항목이 붙을 때까지 하루씩 넘긴다 (월초 정산) */
  function postAMonth(state: GameState): void {
    advanceDays(state, 40);
  }

  it("무소속은 구단이 아니므로 장부가 서지 않는다", () => {
    const state = createTestGame(42, "arsenal");
    const free = state.teams.find((t) => leagueOfTeam(t.id) === "free");
    expect(free, "무소속 자리가 있다").toBeDefined();
    const hasLedger = () => state.finances.some((f) => f.teamId === free!.id);
    expect(hasLedger(), "새 게임의 무소속엔 장부가 없다").toBe(false);

    postAMonth(state);

    /**
     * 예전엔 무소속이 £4.8M 장부를 갖고 시작했고 `postMonthlyItems`가 전 팀을 돌며
     * 시설비·이자를 물려 자유계약 선수단이 매달 적자를 쌓았다(세 시즌에 −£6M).
     * 이제 장부 자체가 없다 — 월초 정산이 그 자리를 만들어 내지도 않는다.
     */
    expect(hasLedger(), "월초 정산이 무소속 장부를 만들었다").toBe(false);
  });
});

/**
 * 구장 투자 — **현금은 한 번, 손익은 내용연수에 나눠** (finance.md §6.1).
 */
describe("자본 자산 — capex와 상각", () => {
  const DAY = "2026-08-01";
  const line = (
    kind: "income" | "expense",
    category: FinanceCategory,
    amount: number,
    noncash = false,
  ): LedgerEntry => ({
    id: `led-${category}-${kind}-${amount}`,
    date: DAY,
    kind,
    category,
    label: category,
    amount,
    ...(noncash ? { accounting: "noncash" as const } : {}),
  });

  it("capex는 현금에서만, 상각은 손익에서만 빠진다", () => {
    const s = summarise([
      line("income", "matchday", 10_000_000),
      line("expense", "capex", 8_000_000),
      line("expense", "depreciation", 66_667, true),
    ]);
    // 통장에서 나간 것은 공사비뿐이다
    expect(s.cashNet).toBe(10_000_000 - 8_000_000);
    // 장부에 선 것은 상각뿐이다 — 자산을 산 값은 손익이 아니다
    expect(s.pnlNet).toBe(10_000_000 - 66_667);
  });

  it("상각 총합은 취득원가와 같고 내용연수가 지나면 멈춘다", () => {
    const state = createMiniGame();
    const teamId = state.userTeamId;
    const MONTHS = 12;
    const COST = 12_000_000;
    const before = financeOf(state, teamId).balance;
    recordCapitalAsset(state, teamId, {
      id: "asset-test",
      label: "구장 증설 (1,500석)",
      cost: COST,
      months: MONTHS,
    });
    // 현금은 그날 한 번 나간다
    expect(financeOf(state, teamId).balance).toBe(before - COST);
    const spent = financeOf(state, teamId).ledger.filter((e) => e.category === "capex");
    expect(spent).toHaveLength(1);
    expect(spent[0]!.accounting).toBeUndefined(); // 현금이다

    // 취득한 달의 다음 달부터 정확히 MONTHS번 선다
    const [year, month] = monthOf(state.date).split("-").map(Number) as [number, number];
    let posts = 0;
    let total = 0;
    for (let step = 0; step <= MONTHS + 2; step++) {
      const m = month + step;
      state.date = `${year + Math.floor((m - 1) / 12)}-${String(((m - 1) % 12) + 1).padStart(2, "0")}-01`;
      for (const l of depreciationOf(state, teamId)) {
        posts += 1;
        total += l.monthly;
      }
    }
    expect(posts).toBe(MONTHS);
    expect(total).toBeCloseTo(COST, 6);
  });
});

/**
 * 강등의 재정 타격 — 소속은 세이브(`state.leagueOf`)에만 남고, 재정은 그 값을 읽는다.
 * 승강 규칙 자체는 promotion.test.ts가 본다.
 *
 * 시즌을 굴리지 않고 소속만 못 박는다 — 승강이 상태에 남기는 것이 그것뿐이다.
 */

/** 그 팀을 2부로 내리고 낙하산을 세운다 — 시즌 전환이 하는 일과 같다 */
function relegate(state: GameState, teamId: string, to = "championship"): void {
  (state.leagueOf ??= {})[teamId] = to;
  startParachute(state, teamId, "epl");
  state.season += 1;
}

function monthIncome(state: GameState, teamId: string, label: string): number {
  const finance = state.finances.find((f) => f.teamId === teamId)!;
  return finance.ledger
    .filter((l) => l.label === label)
    .reduce((sum, l) => sum + Math.abs(l.amount), 0);
}

describe("강등의 재정 타격", () => {
  it("소속은 카탈로그가 아니라 세이브가 정한다 — 강등되면 그 리그 수입을 받는다", () => {
    const state = createTestGame(42, "arsenal");
    expect(leagueOfTeamIn(state, "arsenal")).toBe("epl");
    relegate(state, "arsenal");
    expect(leagueOfTeamIn(state, "arsenal")).toBe("championship");
  });

  it("낙하산이 해마다 줄다가 끊긴다", () => {
    const state = createTestGame(42, "arsenal");
    relegate(state, "arsenal"); // 1년차
    const first = parachuteSeasonAmount(state, "arsenal");
    expect(first).toBeGreaterThan(0);

    state.season += 1; // 2년차
    const second = parachuteSeasonAmount(state, "arsenal");
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(first);

    state.season += 1; // 3년차
    const third = parachuteSeasonAmount(state, "arsenal");
    expect(third).toBeGreaterThan(0);
    expect(third).toBeLessThan(second);

    state.season += 1; // 4년차 — 끝
    expect(parachuteSeasonAmount(state, "arsenal")).toBe(0);
  });

  it("승격하면 낙하산은 그 자리에서 끝난다 — 1부 배분과 겹쳐 받을 수 없다", () => {
    const state = createTestGame(42, "arsenal");
    relegate(state, "arsenal");
    expect(parachuteSeasonAmount(state, "arsenal")).toBeGreaterThan(0);
    stopParachute(state, "arsenal");
    expect(parachuteSeasonAmount(state, "arsenal")).toBe(0);
  });

  /**
   * 실제 EPL엔 "승격 한 시즌 만에 다시 내려가면 2년" 조항이 있다. 우리 세계엔 그
   * 상태가 남지 않는다 — 승격이 낙하산 기록을 지우므로(`stopParachute`) 재강등은
   * 언제나 처음부터 세 해다 (finance.md §9-1).
   */
  it("낙하산은 언제나 세 해다 — 승격이 '아직 받는 중'을 지운다", () => {
    const state = createTestGame(42, "arsenal");
    relegate(state, "arsenal");
    expect(state.finances.find((f) => f.teamId === "arsenal")!.parachute!.years).toBe(3);

    // 승격 → 재강등: 실제 규칙이 2년으로 줄일 유일한 경로다
    stopParachute(state, "arsenal");
    startParachute(state, "arsenal", "epl");
    expect(state.finances.find((f) => f.teamId === "arsenal")!.parachute!.years).toBe(3);
  });

  it("강등되면 월 수입이 크게 줄지만 낙하산이 절벽을 막는다", () => {
    const top = createTestGame(42, "arsenal");
    ensureMonthlyPosted(top);
    const topEqual = monthIncome(top, "arsenal", "중계권 균등 배분");

    const down = createTestGame(42, "arsenal");
    relegate(down, "arsenal");
    ensureMonthlyPosted(down);
    const downEqual = monthIncome(down, "arsenal", "중계권 균등 배분");
    const parachute = monthIncome(down, "arsenal", "파라슈트 페이먼트");

    // 2부 중계권은 1부의 몇 분의 일이다
    expect(downEqual).toBeLessThan(topEqual);
    // 낙하산이 그 빈자리의 상당 부분을 메운다 — 강등이 곧 파산은 아니다
    expect(parachute).toBeGreaterThan(0);
    expect(parachute).toBe(Math.round(parachuteSeasonAmount(down, "arsenal") / 12));
    // 그래도 1부에 있을 때보다는 확실히 적다
    expect(downEqual + parachute).toBeLessThan(topEqual);
  });

  it("고정비도 함께 내려간다 — 살림이 구단 경제 수준 한 눈금 위에 선다", () => {
    const state = createTestGame(42, "arsenal");
    const fixedTop = monthlyFixedCostOf("arsenal", state);
    const levelTop = clubEconomyLevelIn(state, "arsenal");

    relegate(state, "arsenal");
    const fixedDown = monthlyFixedCostOf("arsenal", state);
    const levelDown = clubEconomyLevelIn(state, "arsenal");

    expect(fixedDown).toBeLessThan(fixedTop);
    // 체급은 그대로 두고 소속만 내렸으므로 움직인 것은 구단 경제 수준 하나다 —
    // 고정비가 그 눈금을 읽는다면 낙폭의 비율도 같아야 한다
    expect(fixedDown / fixedTop).toBeCloseTo(levelDown / levelTop, 6);
  });

  /**
   * 천장이 카탈로그 소속을 읽으면 강등 구단은 2부 수입 위에 1부 급여 천장을 그대로
   * 갖고 승격 구단은 1부 수입에 2부 천장으로 묶인다 (finance.md §6.4).
   */
  it("주급 천장도 지금 소속을 읽는다 — 두 방향 다", () => {
    const state = createTestGame(42, "arsenal");
    const catalogBudget = clubWageBudget("arsenal");
    const topBudget = clubWageBudget("arsenal", undefined, state);

    const promoted = state.teams.find((t) => leagueOfTeamIn(state, t.id) === "championship")!;
    const secondBudget = clubWageBudget(promoted.id, undefined, state);

    relegate(state, "arsenal");
    (state.leagueOf ??= {})[promoted.id] = "epl";

    expect(clubWageBudget("arsenal", undefined, state)).toBeLessThan(topBudget);
    expect(clubWageBudget(promoted.id, undefined, state)).toBeGreaterThan(secondBudget);
    // 세이브를 넘기지 않는 자리는 세계 생성뿐이라 카탈로그 소속 그대로다
    expect(clubWageBudget("arsenal")).toBe(catalogBudget);
  });

  it("승격한 클럽은 그 자리에서 1부로 셈해진다", () => {
    const state = createTestGame(42, "arsenal");
    const promoted = state.teams.find((t) => leagueOfTeamIn(state, t.id) === "championship")!;
    expect(isTopFlightIn(state, promoted.id)).toBe(false);
    const before = monthlyFixedCostOf(promoted.id, state);

    (state.leagueOf ??= {})[promoted.id] = "epl";

    expect(isTopFlightIn(state, promoted.id)).toBe(true);
    expect(monthlyFixedCostOf(promoted.id, state)).toBeGreaterThan(before);
  });

  it("카탈로그판은 승강을 보지 않는다 — 세계 생성이 읽는 자리다", () => {
    const state = createTestGame(42, "arsenal");
    relegate(state, "arsenal");

    expect(isTopFlight("arsenal")).toBe(true);
    expect(isTopFlightIn(state, "arsenal")).toBe(false);
    expect(clubEconomyLevelIn(state, "arsenal")).toBeLessThan(clubEconomyLevel("arsenal"));
  });

  it("상업 수입은 늦게 떨어진다 — 스폰서 계약은 그날 끝나지 않는다", () => {
    const top = createTestGame(42, "arsenal");
    ensureMonthlyPosted(top);
    const before = monthIncome(top, "arsenal", "스폰서십");

    const down = createTestGame(42, "arsenal");
    relegate(down, "arsenal");
    ensureMonthlyPosted(down);
    const year1 = monthIncome(down, "arsenal", "스폰서십");
    expect(year1).toBeLessThan(before);
    // 첫해 낙폭은 중계권만큼 크지 않다
    expect(year1).toBeGreaterThan(before * 0.8);
  });

  /**
   * **감소는 세 해짜리 지연이지 2부의 상업 수준이 아니다.** 상업 정액은 리그를 모르는
   * 브랜드 등급에서 나오므로(finance.md §5.3), 표의 마지막 해를 넘기면 그 등급의 값으로
   * 돌아온다. 여기를 늘리려면 상업 정액 자체가 리그를 알아야 한다 (§9-1).
   */
  it("감소는 세 해에서 끝난다 — 4년차 상업은 브랜드 정액으로 돌아온다", () => {
    const top = createTestGame(42, "arsenal");
    ensureMonthlyPosted(top);
    const full = monthIncome(top, "arsenal", "스폰서십");

    const worst = createTestGame(42, "arsenal");
    relegate(worst, "arsenal");
    worst.season += 2; // 3년차 — 감소가 가장 깊은 해
    ensureMonthlyPosted(worst);
    expect(monthIncome(worst, "arsenal", "스폰서십")).toBeLessThan(full * 0.7);

    const later = createTestGame(42, "arsenal");
    relegate(later, "arsenal");
    later.season += 3; // 4년차
    ensureMonthlyPosted(later);
    expect(monthIncome(later, "arsenal", "스폰서십")).toBe(full);
  });
});

/**
 * 서사가 재정에 닿는 통로 — 매출·비용은 원장으로, 구단주 출자는 예산으로.
 * 두 축을 나누는 이유가 여기서 검증된다: 구단주 돈으로 PSR을 풀 수 없어야 한다.
 */
describe("재정 이벤트 명령", () => {
  it("확정된 일상 비용도 원장과 잔고에 반영된다", () => {
    const state = createTestGame(7, "tottenham");
    const finance = financeOf(state, state.userTeamId);
    const balanceBefore = finance.balance;
    const ledgerBefore = finance.ledger.length;

    const res = applyFinanceEvent(state, {
      kind: "expense",
      category: "bonus",
      amount: 9_999,
      note: "선수단 회식비",
    });

    expect(res.ok).toBe(true);
    expect(finance.balance).toBe(balanceBefore - 9_999);
    expect(finance.ledger).toHaveLength(ledgerBefore + 1);
  });

  it("£10k부터는 서사 재정 이벤트로 기록할 수 있다", () => {
    const state = createTestGame(7, "tottenham");
    const finance = financeOf(state, state.userTeamId);
    const balanceBefore = finance.balance;

    const res = applyFinanceEvent(state, {
      kind: "expense",
      category: "bonus",
      amount: 10_000,
      note: "선수단 공식 포상",
    });

    expect(res.ok).toBe(true);
    expect(finance.balance).toBe(balanceBefore - 10_000);
  });

  it("서사 매출은 원장에 남아 잔고와 손익에 함께 반영된다", () => {
    const state = createTestGame(7, "tottenham");
    const finance = financeOf(state, state.userTeamId);
    const before = finance.balance;

    const res = applyFinanceEvent(state, {
      kind: "income",
      category: "merchandising",
      amount: 500_000,
      note: "개막전 유니폼 완판",
    });
    expect(res.ok).toBe(true);
    expect(finance.balance).toBe(before + 500_000);

    const entry = finance.ledger.at(-1)!;
    expect(entry.category).toBe("merchandising");
    expect(entry.source).toBe("narrative");
    expect(finance.ledger.filter((e) => e.source === "narrative")).toHaveLength(1);
  });

  it("코어가 계산하는 축은 서사가 건드릴 수 없다", () => {
    const state = createTestGame(7, "tottenham");
    for (const category of ["broadcast_equal", "player_wages", "depreciation"] as const) {
      const res = applyFinanceEvent(state, {
        kind: "income",
        category,
        amount: 1_000_000,
        note: "장부 조작",
      });
      expect(res.ok, category).toBe(false);
    }
  });

  it("확정된 금액은 크기와 일일 합계에 관계없이 같은 원장에 반영된다", () => {
    const state = createMiniGame();
    const finance = financeOf(state, state.userTeamId);
    const before = finance.balance;
    for (const amount of [1, 100_000_000, 100_000_000]) {
      expect(
        applyFinanceEvent(state, {
          kind: "income",
          category: "commercial",
          amount,
          note: "후원 계약 지급",
        }).ok,
      ).toBe(true);
    }
    expect(finance.balance).toBe(before + 200_000_001);
    const snapshot = structuredClone(finance);
    for (const amount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        applyFinanceEvent(state, { kind: "expense", category: "bonus", amount, note: "포상" }).ok,
      ).toBe(false);
      expect(finance).toEqual(snapshot);
    }
  });
});

/**
 * 티켓 — **리그 폭**(카탈로그 층)과 **감독이 매기는 값**(finance.md §5.2).
 * 화면에 드러나지 않는 곡선이라 여기서 고정한다.
 */
describe("티켓 — 리그 폭과 감독이 매기는 값", () => {
  /** 96팀이 다 들어 있는 세계 하나면 리그 폭은 전부 읽힌다 — describe 하나가 나눠 쓴다 */
  let world: GameState;
  beforeAll(() => {
    world = createTestGame();
  });

  /** 그 리그에서 제일 비싼 표 ÷ 제일 싼 표 — 리그 평균가를 타지 않는 순수한 폭 */
  function spreadRatio(state: GameState, leagueId: string): number {
    const bases = state.teams
      .filter((t) => leagueOfTeam(t.id) === leagueId)
      .map((t) => ticketPriceOf(state, t.id).base);
    return Math.max(...bases) / Math.min(...bases);
  }

  it("리그 폭이 tier 보정을 1을 축으로 늘이고 줄인다", () => {
    // EPL이 표를 잰 자리다 — 축이라 1이고, 표에 없는 리그도 1이라 아무 일이 없다
    expect(leagueTicketSpread("epl")).toBe(1);
    expect(leagueTicketSpread("nowhere-league")).toBe(1);
    // 2부는 그 나라 1부의 폭을 쓴다 — 값을 매기는 문화는 리그가 아니라 나라의 것이다
    expect(leagueTicketSpread("serieb")).toBe(leagueTicketSpread("seriea"));
    expect(leagueTicketSpread("championship")).toBe(leagueTicketSpread("epl"));

    // 폭이 넓은 리그는 위아래가 더 벌어지고, 좁은 리그는 붙는다
    expect(spreadRatio(world, "seriea")).toBeGreaterThan(spreadRatio(world, "epl"));
    expect(spreadRatio(world, "bundesliga")).toBeLessThan(spreadRatio(world, "epl"));
  });

  it("부른 값은 폭에서 잘려 들어가고 배율로 남는다", () => {
    const state = createMiniGame();
    const teamId = state.userTeamId;
    const { base, max } = ticketPriceOf(state, teamId);

    expect(setTicketPrice(state, { price: Math.round(base * 3) }).ok).toBe(true);
    const dear = ticketPriceOf(state, teamId);
    expect(dear.price).toBeCloseTo(max, 6);
    expect(dear.ratio).toBeCloseTo(max / base, 6);

    expect(setTicketPrice(state, { price: Math.round(base) }).ok).toBe(true);
    expect(ticketPriceOf(state, teamId).ratio).toBeCloseTo(1, 2);
  });

  it("값을 올리면 관중이 줄고, 수입이 가장 큰 자리는 기준가 근처다", () => {
    const state = createTestGame();
    const teamId = state.userTeamId;
    const match = state.matches.find((m) => m.homeTeamId === teamId && !m.neutral)!;
    const at = (ratio: number) => {
      financeOf(state, teamId).ticketPrice = { ratio, setOn: state.date };
      return matchdayRevenue(state, match);
    };

    const par = at(1);
    // 비싸게 팔면 관중이 줄고, 폭 끝에서는 수입까지 준다
    const dear = at(1.5);
    expect(dear.attendance).toBeLessThan(par.attendance);
    expect(dear.income).toBeLessThan(par.income);
    // 싸게 팔면 관중은 늘고 수입은 준다 — 관중을 사는 데 값을 치르는 것이다
    const cheap = at(0.7);
    expect(cheap.attendance).toBeGreaterThanOrEqual(par.attendance);
    expect(cheap.income).toBeLessThan(par.income);

    /**
     * **`avgTicketPrice`는 이미 시장이 찾아 놓은 값이다** — 최적점이 폭 끝으로
     * 밀리면 "언제나 최대로 올린다"가 되어 결정이 아니라 공짜 수입이 된다.
     * `TICKET_ELASTICITY`를 낮추면 조용히 그렇게 되는 자리다.
     */
    const ratios = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
    const best = ratios.reduce((a, b) => (at(b).income > at(a).income ? b : a));
    expect(best).toBeGreaterThanOrEqual(0.9);
    expect(best).toBeLessThanOrEqual(1.2);
  });
});
