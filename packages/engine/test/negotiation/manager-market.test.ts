import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  reviewBoard,
  acceptManagerOffer,
  addDays,
  applyForManagerJob,
  counterManagerOffer,
  financeOf,
  managerSeveranceOf,
  resignPost,
  offerManagerJob,
  openManagerOffers,
  pendingManagerInterview,
  pendingManagerInterviews,
  pushManagerInterview,
  KEPT_MANAGER_INTERVIEWS,
  respondToInterview,
  reviewManagerContract,
  expireStaleOffers,
  managedTeamId,
  seatStatus,
  ensureStaffPool,
  refreshStaffPool,
  releaseStaff,
  hireStaff,
  expireStaffContracts,
  staffOf,
  STAFF_LIMIT,
  headCoachOf,
  reseatClubPersonas,
  type GameState,
} from "@story-fm/engine";
import { createTestGame, resultOf } from "../helpers";

describe("감독 고용 — 명시적 결정과 계약 원장", () => {
  let fixture: GameState;
  let state: GameState;
  beforeAll(() => {
    fixture = createTestGame(7);
  });
  beforeEach(() => {
    state = structuredClone(fixture);
  });
  const targetId = "chelsea";
  const dismiss = (team = targetId) =>
    reviewBoard(state, { action: "dismiss", team, reason: "구단주가 감독 교체를 결정했다" });
  const propose = (team = targetId, salary = 2_000_000) =>
    offerManagerJob(state, {
      team,
      salary,
      years: 3,
      budgetPledge: 0,
      expiresOn: addDays(state.date, 10),
      reason: "구단이 조건을 제시했다",
    });
  const fund = (team = targetId) => {
    financeOf(state, team).balance = 1_000_000_000;
  };

  it("날짜 진행이 감독을 자르거나 후임·접근을 만들지 않고 공석은 14일 후에도 유지된다", () => {
    const names = state.teams.map((team) => team.managerName);
    state.date = addDays(state.date, 200);
    expireStaleOffers(state, []);
    expect(state.teams.map((team) => team.managerName)).toEqual(names);
    expect(state.managerOffers).toHaveLength(0);
    expect(dismiss().ok).toBe(true);
    state.date = addDays(state.date, 50);
    expireStaleOffers(state, []);
    expect(state.managerVacancies.some((v) => v.teamId === targetId)).toBe(true);
    expect(applyForManagerJob(state, targetId).ok).toBe(true);
  });

  it("면접·제안·퇴직은 체급 목표가 아닌 실제 리그 순위를 보존한다", () => {
    const match = state.matches.find(
      (entry) =>
        entry.competitionId === "epl" &&
        (entry.homeTeamId === targetId || entry.awayTeamId === targetId),
    )!;
    const home = match.homeTeamId === targetId;
    match.result = resultOf({ homeGoals: home ? 3 : 0, awayGoals: home ? 0 : 3 });
    const position = seatStatus(state, targetId)!.position;
    state.teams.find((team) => team.id === targetId)!.tier = 4;
    dismiss();
    fund();
    expect(applyForManagerJob(state, targetId).ok).toBe(true);
    const interview = pendingManagerInterview(state)!;
    expect(interview.facts.find((fact) => fact.kind === "standing")?.data.values?.rank).toBe(
      position,
    );
    expect(interview.contextCard).toEqual({ code: "interview", value: position });
    expect(propose().ok).toBe(true);
    expect(openManagerOffers(state)[0]).toMatchObject({ position, tier: 4 });
    expect(openManagerOffers(state)[0]).not.toHaveProperty("target");
    expect(openManagerOffers(state)[0]).not.toHaveProperty("expectationCode");
    expect(state.managerVacancies[0]?.position).toBe(position);
    expect(dismiss("arsenal").ok).toBe(true);
    expect(state.dismissal).not.toHaveProperty("target");
    expect(state.dismissal).not.toHaveProperty("expectationCode");
  });

  it("경질→풀→선임은 같은 날·같은 구단도 가능하고 이력과 역량을 보존한다", () => {
    const team = state.teams.find((entry) => entry.id === targetId)!;
    const name = team.managerName!;
    const rating = team.aiManagerTacticsRating;
    expect(dismiss().ok).toBe(true);
    expect(team.managerName).toBeUndefined();
    const pooled = state.managerPool.find((entry) => entry.name === name)!;
    expect(pooled.spells.at(-1)?.teamId).toBe(targetId);
    expect(
      reviewBoard(state, {
        action: "appoint",
        team: targetId,
        managerName: name,
        rating: 1,
        reason: "철회 뒤 재선임",
      }).ok,
    ).toBe(true);
    expect(team.aiManagerTacticsRating).toBe(rating);
    expect(team.managerSpells).toEqual(pooled.spells);
    expect(state.managerPool.some((entry) => entry.name === name)).toBe(false);
    expect(state.managerVacancies).toHaveLength(0);
  });

  it("유저 복제·중복 재직·비공석 선임·잘못된 역량을 원장 변경 없이 거절한다", () => {
    dismiss();
    const before = structuredClone(state);
    for (const managerName of [
      state.manager.name,
      state.teams.find((team) => team.id === "liverpool")!.managerName!,
    ]) {
      expect(
        reviewBoard(state, {
          action: "appoint",
          team: targetId,
          managerName,
          rating: 70,
          reason: "선임",
        }).ok,
      ).toBe(false);
    }
    expect(
      reviewBoard(state, {
        action: "appoint",
        team: "liverpool",
        managerName: "새 감독",
        rating: 70,
        reason: "선임",
      }).ok,
    ).toBe(false);
    expect(
      reviewBoard(state, {
        action: "appoint",
        team: targetId,
        managerName: "새 감독",
        rating: 100,
        reason: "선임",
      }).ok,
    ).toBe(false);
    expect(state).toEqual(before);
  });

  it("현역 선수와 계약 중인 스태프는 중복 고용하지 않고 무직 인물은 신원을 보존한다", () => {
    dismiss();
    const staff = staffOf(state, "medic")[0]!;
    const before = structuredClone(state);
    for (const name of [staff.name, state.players[0]!.name]) {
      expect(
        reviewBoard(state, {
          action: "appoint",
          team: targetId,
          managerName: name,
          rating: 60,
          reason: "선임",
        }).ok,
      ).toBe(false);
    }
    expect(state).toEqual(before);
    staff.employment!.contract.until = addDays(state.date, -2);
    const endedOn = addDays(staff.employment!.contract.until, 1);
    const id = staff.characterId;
    const book = structuredClone(staff.characterBook);
    const result = reviewBoard(state, {
      action: "appoint",
      team: targetId,
      managerName: staff.name,
      rating: 60,
      reason: "만료 뒤 감독 부임",
    });
    expect(result.ok).toBe(true);
    expect(result.brief?.items.length).toBeGreaterThan(0);
    expect(staff.characterId).toBe(id);
    expect(staff.characterBook).toEqual(book);
    expect(staff.role).toBe("manager");
    expect(staff.employment).toBeUndefined();
    expect(staff.employmentHistory?.at(-1)).toMatchObject({ endedOn, reason: "expired" });
    expect(state.teams.find((team) => team.id === targetId)?.managerName).toBe(staff.name);
  });

  it("기존 비고용 인물도 새 전술 역량을 명시해 감독이 된다", () => {
    dismiss();
    const person = state.personas.find((entry) => !entry.employment && entry.role !== "owner")!;
    const id = person.characterId;
    const book = structuredClone(person.characterBook);
    expect(
      reviewBoard(state, {
        action: "appoint",
        team: targetId,
        managerName: person.name,
        rating: 61,
        reason: "새 역할 합의",
      }).ok,
    ).toBe(true);
    expect(person.characterId).toBe(id);
    expect(person.characterBook).toEqual(book);
    expect(person.role).toBe("manager");
  });

  it("실제 고용·제안·수정·면접 결과는 화면용 요약을 반환하며 동일 수정은 비변경이다", () => {
    expect(dismiss().brief?.items.length).toBeGreaterThan(0);
    fund();
    expect(propose().brief?.items.length).toBeGreaterThan(0);
    const offer = openManagerOffers(state)[0]!;
    expect(
      counterManagerOffer(state, offer.id, { salary: 1000 }).brief?.items.length,
    ).toBeGreaterThan(0);
    const identical = counterManagerOffer(state, offer.id, { salary: 1000 });
    expect(identical.ok).toBe(true);
    expect(identical.unchanged).toBe(true);
    applyForManagerJob(state, targetId);
    expect(
      respondToInterview(state, { offer: false, reason: "논의 종료" }).brief?.items.length,
    ).toBeGreaterThan(0);
    fund("arsenal");
    expect(propose("arsenal").ok).toBe(true);
    expect(acceptManagerOffer(state, "arsenal").brief?.items.length).toBeGreaterThan(0);
  });

  it("선임은 해당 구단 제안·면접만 닫는다", () => {
    dismiss();
    fund();
    expect(propose().ok).toBe(true);
    expect(applyForManagerJob(state, targetId).ok).toBe(true);
    dismiss("fulham");
    fund("fulham");
    expect(propose("fulham").ok).toBe(true);
    expect(
      reviewBoard(state, {
        action: "appoint",
        team: targetId,
        managerName: "새 감독",
        rating: 60,
        reason: "선임 합의",
      }).ok,
    ).toBe(true);
    expect(pendingManagerInterview(state)).toBeNull();
    expect(openManagerOffers(state).map((offer) => offer.teamId)).toEqual(["fulham"]);
    expect(acceptManagerOffer(state, targetId).ok).toBe(false);
  });

  it("서로 다른 구단 면접을 함께 진행하고 중복·모호한 응답은 변경 없이 거절한다", () => {
    dismiss();
    fund();
    dismiss("fulham");
    fund("fulham");
    expect(applyForManagerJob(state, targetId).ok).toBe(true);
    expect(applyForManagerJob(state, "fulham").ok).toBe(true);
    const pending = pendingManagerInterviews(state);
    expect(pending).toHaveLength(2);
    const before = structuredClone(state);
    expect(applyForManagerJob(state, targetId).ok).toBe(false);
    expect(respondToInterview(state, { offer: false, reason: "보류" }).ok).toBe(false);
    expect(
      respondToInterview(state, {
        interviewId: pending[0]!.id,
        team: "fulham",
        offer: false,
        reason: "보류",
      }).ok,
    ).toBe(false);
    expect(respondToInterview(state, { team: "없는 구단", offer: false, reason: "보류" }).ok).toBe(
      false,
    );
    expect(state).toEqual(before);
    expect(
      respondToInterview(state, {
        interviewId: pending[0]!.id,
        offer: false,
        reason: "해당 구단과 논의 종료",
      }).ok,
    ).toBe(true);
    expect(pendingManagerInterviews(state).map((interview) => interview.teamId)).toEqual([
      "fulham",
    ]);
    expect(
      respondToInterview(state, {
        offer: true,
        terms: { salary: 1000, years: 2, budgetPledge: 0, expiresOn: addDays(state.date, 10) },
        reason: "남은 구단의 제안",
      }).ok,
    ).toBe(true);
    expect(openManagerOffers(state).map((offer) => offer.teamId)).toEqual(["fulham"]);
  });

  it("구단 참조로 응답하면 다른 구단의 면접과 제안은 그대로 남는다", () => {
    dismiss();
    fund();
    dismiss("fulham");
    fund("fulham");
    applyForManagerJob(state, targetId);
    applyForManagerJob(state, "fulham");
    const other = structuredClone(pendingManagerInterview(state, "fulham"));
    expect(
      respondToInterview(state, {
        team: targetId,
        offer: true,
        terms: { salary: 1234, years: 2, budgetPledge: 0, expiresOn: addDays(state.date, 10) },
        reason: "구단의 제안",
      }).ok,
    ).toBe(true);
    expect(pendingManagerInterview(state, "fulham")).toEqual(other);
    expect(openManagerOffers(state)[0]?.teamId).toBe(targetId);
    expect(propose().ok).toBe(false);
  });

  it("지난 면접 보존 한도가 열린 면접을 밀어내지 않는다", () => {
    dismiss();
    applyForManagerJob(state, targetId);
    const original = pendingManagerInterview(state)!;
    for (let index = 0; index < KEPT_MANAGER_INTERVIEWS + 5; index += 1) {
      pushManagerInterview(state, { ...original, id: `closed-${index}`, status: "answered" });
      pushManagerInterview(state, {
        ...original,
        id: `pending-${index}`,
        teamId: state.teams[index]!.id,
      });
    }
    expect(
      state.managerInterviews.filter((interview) => interview.status !== "pending"),
    ).toHaveLength(KEPT_MANAGER_INTERVIEWS);
    expect(pendingManagerInterviews(state)).toHaveLength(KEPT_MANAGER_INTERVIEWS + 6);
    expect(state.managerInterviews).toContain(original);
  });

  it("제안·반복 흥정은 계약을 수락하지 않고 30% 초과 인상과 인하를 기록한다", () => {
    dismiss();
    fund();
    const contract = structuredClone(state.manager.contract);
    expect(propose().ok).toBe(true);
    const offer = openManagerOffers(state)[0]!;
    expect(counterManagerOffer(state, offer.id, { salary: 6_000_000 }).ok).toBe(true);
    expect(offer.salary).toBe(6_000_000);
    expect(counterManagerOffer(state, offer.id, { salary: 500_000, years: 1 }).ok).toBe(true);
    expect(offer.salary).toBe(500_000);
    expect(state.manager.contract).toEqual(contract);
    expect(state.userTeamId).toBe("arsenal");
    expect(offer.status).toBe("open");
  });

  it("금액·기한·가용 현금 검증은 부분 변경을 남기지 않는다", () => {
    dismiss();
    fund();
    propose();
    const offer = openManagerOffers(state)[0]!;
    const before = structuredClone(offer);
    for (const salary of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(counterManagerOffer(state, offer.id, { salary }).ok).toBe(false);
    }
    expect(counterManagerOffer(state, offer.id, { expiresOn: addDays(state.date, -1) }).ok).toBe(
      false,
    );
    expect(counterManagerOffer(state, offer.id, { transferBudget: 2_000_000_000 }).ok).toBe(false);
    expect(counterManagerOffer(state, offer.id, { expiresOn: "2027-02-31" }).ok).toBe(false);
    expect(offer).toEqual(before);
    financeOf(state, targetId).balance = 0;
    const stateBefore = structuredClone(state);
    expect(acceptManagerOffer(state, offer.id).ok).toBe(false);
    expect(state).toEqual(stateBefore);
  });

  it("지원 제안은 명시한 조건 그대로이며 할인·흥정 소진이 없다", () => {
    dismiss();
    fund();
    expect(applyForManagerJob(state, targetId).ok).toBe(true);
    expect(respondToInterview(state, { offer: true, reason: "조건 합의" }).ok).toBe(false);
    expect(pendingManagerInterview(state)).not.toBeNull();
    expect(
      respondToInterview(state, {
        offer: true,
        terms: { salary: 777_777, years: 2, budgetPledge: 0, expiresOn: addDays(state.date, 30) },
        reason: "구단 제안",
      }).ok,
    ).toBe(true);
    const offer = openManagerOffers(state)[0]!;
    expect(offer.salary).toBe(777_777);
    expect(counterManagerOffer(state, offer.id, { salary: 3_000_000 }).ok).toBe(true);
    expect(pendingManagerInterview(state)).toBeNull();
  });

  it("재계약은 90일보다 일찍 반복 제안할 수 있고 수락만 계약과 예산을 바꾼다", () => {
    fund("arsenal");
    const before = structuredClone(state.manager.contract);
    expect(propose("arsenal", 123_456).ok).toBe(true);
    expect(state.manager.contract).toEqual(before);
    const first = openManagerOffers(state)[0]!;
    state.date = addDays(first.expiresOn, 1);
    expireStaleOffers(state, []);
    expect(first.status).toBe("expired");
    expect(propose("arsenal", 200_000).ok).toBe(true);
    const second = openManagerOffers(state)[0]!;
    expect(counterManagerOffer(state, second.id, { transferBudget: 1000 }).ok).toBe(true);
    const budget = financeOf(state, "arsenal").transferBudget;
    expect(acceptManagerOffer(state, second.id).ok).toBe(true);
    expect(state.manager.contract?.salary).toBe(200_000);
    expect(financeOf(state, "arsenal").transferBudget).toBe(budget + 1000);
    expect(acceptManagerOffer(state, second.id).ok).toBe(false);
    expect(financeOf(state, "arsenal").transferBudget).toBe(budget + 1000);
    expect(propose("arsenal").ok).toBe(true);
  });

  it("이직 수락은 보상금을 두 구단에 한 번 정산하고 옛 공석을 유지한다", () => {
    dismiss();
    dismiss("fulham");
    fund();
    propose();
    const offer = openManagerOffers(state)[0]!;
    const compensation = offer.compensation!;
    const oldCash = financeOf(state, "arsenal").balance;
    const newCash = financeOf(state, targetId).balance;
    expect(acceptManagerOffer(state, offer.id).ok).toBe(true);
    expect(state.userTeamId).toBe(targetId);
    expect(financeOf(state, "arsenal").balance).toBe(oldCash + compensation);
    expect(financeOf(state, targetId).balance).toBe(newCash - compensation);
    expect(state.dismissals.at(-1)?.kind).toBe("moved");
    expect(state.managerVacancies.map((v) => v.teamId).sort()).toEqual(["arsenal", "fulham"]);
    expect(state.managerPool.some((entry) => entry.name === state.manager.name)).toBe(false);
    expect(acceptManagerOffer(state, offer.id).ok).toBe(false);
    expect(financeOf(state, targetId).balance).toBe(newCash - compensation);
  });

  it("무직 감독은 만료일 당일까지 제안을 수락하고 재임 권한을 되찾는다", () => {
    dismiss("arsenal");
    fund("arsenal");
    expect(propose("arsenal").ok).toBe(true);
    const offer = openManagerOffers(state)[0]!;
    state.date = offer.expiresOn;
    expireStaleOffers(state, []);
    expect(offer.status).toBe("open");
    expect(acceptManagerOffer(state, offer.id).ok).toBe(true);
    expect(managedTeamId(state)).toBe("arsenal");
    expect(state.dismissal).toBeUndefined();
    expect(state.dismissals.at(-1)?.kind).toBe("sacked");
  });

  it("경질·사임·만료는 한 번 정산하고 더 이상 구단을 운영하지 않는다", () => {
    const severance = managerSeveranceOf(state.manager.contract!, state.date);
    const before = financeOf(state, "arsenal").balance;
    expect(dismiss("arsenal").ok).toBe(true);
    expect(financeOf(state, "arsenal").balance).toBe(before - severance);
    expect(managedTeamId(state)).toBeNull();
    expect(dismiss("arsenal").ok).toBe(false);
    expect(financeOf(state, "arsenal").balance).toBe(before - severance);
    state = structuredClone(fixture);
    const resignationCash = financeOf(state, "arsenal").balance;
    expect(resignPost(state).ok).toBe(true);
    expect(financeOf(state, "arsenal").balance).toBe(resignationCash + severance);
    expect(resignPost(state).ok).toBe(false);
    state = structuredClone(fixture);
    const expiryCash = financeOf(state, "arsenal").balance;
    state.date = state.manager.contract!.until;
    expect(reviewManagerContract(state, [])).toBeNull();
    state.date = addDays(state.date, 5);
    expect(reviewManagerContract(state, [])).toBe("expired");
    expect(reviewManagerContract(state, [])).toBeNull();
    expect(financeOf(state, "arsenal").balance).toBe(expiryCash);
  });
});

describe("감독 위약금 — 계약 잔여와 상한", () => {
  it("잔여 기간 비례·연봉 상한·만료 뒤 0", () => {
    const contract = { salary: 1_000_000, until: "2027-07-01" };
    expect(managerSeveranceOf(contract, "2026-07-01")).toBe(500_000);
    expect(managerSeveranceOf(contract, "2020-07-01")).toBe(1_000_000);
    expect(managerSeveranceOf(contract, "2027-07-01")).toBe(0);
    expect(managerSeveranceOf(contract, "2028-07-01")).toBe(0);
  });
});

describe("스태프 시장 — 고용과 해고 (people.md §2-2)", () => {
  let fixture: GameState;
  beforeAll(() => {
    fixture = createTestGame(42);
  });
  const world = () => structuredClone(fixture);
  const poolOf = (state: GameState) => {
    ensureStaffPool(state);
    return state.staffPool!.filter((e) => e.role === "coach");
  };

  it("negotiated salary below the pool ask and explicit duration are honored", () => {
    const state = world();
    const entry = poolOf(state)[0]!;
    const salary = Math.floor(entry.ask / 2);
    const until = addDays(state.date, 90);
    expect(hireStaff(state, { name: entry.name, salary, until }).ok).toBe(true);
    expect(
      staffOf(state, "coach").find((p) => p.name === entry.name)?.employment?.contract,
    ).toEqual({ salary, until });
    expect(state.staffPool!.some((e) => e.name === entry.name)).toBe(false);
  });
  it("creates a legitimate person outside the pool and renews the same identity with contract history", () => {
    const state = world();
    const name = "새로운 코치";
    const characterBook = {
      name,
      keywords: [name],
      description: "훈련 코치",
      information: "구단과 조건을 합의했다.",
    };
    const until = addDays(state.date, 30);
    expect(
      hireStaff(state, {
        name,
        salary: 1000,
        until,
        role: "coach",
        title: "기술 코치",
        characterBook,
      }).ok,
    ).toBe(true);
    const person = staffOf(state).find((p) => p.name === name)!;
    expect(hireStaff(state, { name, salary: 2000, until: addDays(until, 400) }).ok).toBe(true);
    expect(state.personas.filter((p) => p.characterId === person.characterId)).toHaveLength(1);
    expect(person.employmentHistory?.[0]).toMatchObject({
      reason: "renewed",
      contract: { salary: 1000, until },
    });
    expect(person.employment?.contract.salary).toBe(2000);
    expect(person.characterBook).toEqual(characterBook);
  });
  it("validates authority, existing identities, contract dates and cumulative salary", () => {
    const state = world();
    const entry = poolOf(state)[0]!;
    const until = addDays(state.date, 30);
    expect(hireStaff(state, { name: entry.name, salary: 1000, until: state.date }).ok).toBe(false);
    expect(hireStaff(state, { name: entry.name, salary: NaN, until }).ok).toBe(false);
    expect(hireStaff(state, { name: entry.name, salary: 1_000_000_000, until }).ok).toBe(false);
    expect(hireStaff(state, { name: state.players[0]!.name, salary: 1000, until }).ok).toBe(false);
    delete state.manager.contract;
    expect(hireStaff(state, { name: entry.name, salary: 1000, until }).ok).toBe(false);
  });
  it("respects real staff vacancies and allows renewal when all slots are filled", () => {
    const state = world();
    const until = addDays(state.date, 90);
    for (const entry of poolOf(state)) hireStaff(state, { name: entry.name, salary: 1000, until });
    expect(staffOf(state, "coach")).toHaveLength(STAFF_LIMIT.coach);
    const leftover = poolOf(state)[0]!;
    expect(hireStaff(state, { name: leftover.name, salary: 1000, until }).ok).toBe(false);
    expect(
      hireStaff(state, { name: staffOf(state, "coach")[0]!.name, salary: 1000, until }).ok,
    ).toBe(true);
  });
  it("release pays severance once and preserves person and employment history", () => {
    const state = world();
    const person = staffOf(state, "medic")[0]!;
    const severance = managerSeveranceOf(person.employment!.contract, state.date);
    const finance = financeOf(state, state.userTeamId);
    const before = finance.balance;
    expect(releaseStaff(state, { name: person.name }).ok).toBe(true);
    expect(staffOf(state, "medic")).toHaveLength(0);
    expect(finance.balance).toBe(before - severance);
    expect(person.employmentHistory?.[0]?.reason).toBe("released");
    expect(state.personas.includes(person)).toBe(true);
    expect(releaseStaff(state, { name: person.name }).ok).toBe(false);
    expect(finance.balance).toBe(before - severance);
  });
  it("contract expiry leaves a vacancy and rehiring appends to the same person's ledger", () => {
    const state = world();
    const person = staffOf(state, "medic")[0]!;
    const name = person.name;
    person.employment!.contract.until = addDays(state.date, 1);
    expect(expireStaffContracts(state, person.employment!.contract.until)).not.toContain(name);
    state.date = addDays(state.date, 2);
    expect(expireStaffContracts(state, state.date)).toContain(name);
    expect(person.employment).toBeUndefined();
    expect(person.employmentHistory?.[0]?.reason).toBe("expired");
    expect(expireStaffContracts(state, state.date)).not.toContain(name);
    expect(hireStaff(state, { name, salary: 1000, until: addDays(state.date, 100) }).ok).toBe(true);
    expect(person.employmentHistory).toHaveLength(1);
    expect(staffOf(state, "medic")[0]).toBe(person);
  });
  it("head coach release and expiry do not manufacture a replacement contract", () => {
    const state = world();
    const coach = headCoachOf(state);
    expect(releaseStaff(state, { name: coach.name }).ok).toBe(true);
    expect(headCoachOf(state).employment).toBeUndefined();
    expect(
      state.personas.find((p) => p.characterId === coach.characterId)?.employmentHistory?.[0]
        ?.reason,
    ).toBe("released");
  });
  it("season pool refresh does not discard former staff identity or contract history", () => {
    const state = world();
    const person = staffOf(state, "scout")[0]!;
    releaseStaff(state, { name: person.name });
    refreshStaffPool(state, state.season + 2);
    expect(state.personas.find((p) => p.name === person.name)?.employmentHistory).toHaveLength(1);
    expect(
      hireStaff(state, {
        name: person.name,
        role: "scout",
        title: "스카우트",
        salary: 1000,
        until: addDays(state.date, 20),
      }).ok,
    ).toBe(true);
  });
  it("moving clubs preserves contracts and returning restores vacancies instead of new seed contracts", () => {
    const state = world();
    const oldTeam = state.userTeamId;
    const medic = staffOf(state, "medic")[0]!;
    const coach = headCoachOf(state);
    const contract = structuredClone(coach.employment!.contract);
    releaseStaff(state, { name: medic.name });
    state.userTeamId = "chelsea";
    reseatClubPersonas(state, "chelsea", { crossedLeague: false });
    expect(staffOf(state).every((p) => p.employment?.teamId === "chelsea")).toBe(true);
    expect(headCoachOf(state).employment?.teamId).toBe("chelsea");
    expect(
      state.personas.find((p) => p.characterId === coach.characterId)?.employment?.contract,
    ).toEqual(contract);
    state.userTeamId = oldTeam;
    reseatClubPersonas(state, oldTeam, { crossedLeague: false });
    expect(staffOf(state, "medic")).toHaveLength(0);
    expect(headCoachOf(state).characterId).toBe(coach.characterId);
    expect(medic.employmentHistory?.[0]?.reason).toBe("released");
    expect(new Set(state.personas.map((p) => p.characterId)).size).toBe(state.personas.length);
  });
});
