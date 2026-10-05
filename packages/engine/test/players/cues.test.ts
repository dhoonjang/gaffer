import {
  reviewBoard,
  advanceTime,
  applyForManagerJob,
  respondToInterview,
  acceptManagerOffer,
  BOARD_REQUEST,
  STADIUM_ASSET_MONTHS,
  addDays,
  clubProfileIn,
  financeOf,
  requestBoard,
  tickBoardRequests,
  type GameState,
} from "@story-fm/engine";
import { beforeAll, describe, expect, it } from "vitest";
import type { RequestBoardInput } from "@story-fm/domain";
import { createTestGame } from "../helpers";

describe("board construction decisions and execution", () => {
  let fixture: GameState;
  beforeAll(() => {
    fixture = createTestGame(11);
  });
  function world() {
    const state = structuredClone(fixture);
    financeOf(state, state.userTeamId).balance = 200_000_000;
    return state;
  }
  function decision(state: GameState, input: Partial<RequestBoardInput> = {}) {
    return requestBoard(state, {
      kind: "stadium",
      amount: 100,
      decision: "approved",
      authorizedBy: state.personas.find((p) => p.role === "owner")!.characterId,
      deliversOn: addDays(state.date, 30),
      ...input,
    });
  }
  it("pending requests keep distinct IDs and await an explicit board decision", () => {
    const state = world();
    for (let i = 0; i < 3; i++)
      expect(requestBoard(state, { kind: "stadium", amount: 100 }).ok).toBe(true);
    expect(new Set(state.boardRequests.map((r) => r.id)).size).toBe(3);
    state.date = addDays(state.date, 100);
    tickBoardRequests(state, []);
    expect(state.boardRequests.every((r) => r.status === "pending")).toBe(true);
    expect(decision(state, { requestId: state.boardRequests[0]!.id }).ok).toBe(true);
  });
  it("rejects wrong authority, dates, funds and concurrent construction without mutation", () => {
    const state = world();
    expect(decision(state, { authorizedBy: "stranger" }).ok).toBe(false);
    expect(decision(state, { deliversOn: state.date }).ok).toBe(false);
    financeOf(state, state.userTeamId).balance = 0;
    expect(decision(state).ok).toBe(false);
    expect(state.boardRequests).toHaveLength(0);
    financeOf(state, state.userTeamId).balance = 200_000_000;
    expect(decision(state).ok).toBe(true);
    expect(decision(state).ok).toBe(false);
    expect(state.boardRequests).toHaveLength(1);
  });
  it("scheduled decisions recheck funds and context conditions never self-approve", () => {
    const state = world();
    const f = financeOf(state, state.userTeamId);
    expect(decision(state, { respondOn: addDays(state.date, 4) }).ok).toBe(true);
    f.balance = 0;
    state.date = addDays(state.date, 4);
    tickBoardRequests(state, []);
    expect(state.boardRequests[0]!.status).toBe("pending");
    f.balance = 200_000_000;
    tickBoardRequests(state, []);
    expect(state.boardRequests[0]!.status).toBe("approved");
    const conditional = world();
    expect(
      decision(conditional, {
        decision: "conditional",
        condition: {
          kind: "context",
          amount: 0,
          since: conditional.date,
          until: addDays(conditional.date, 1),
        },
      }).ok,
    ).toBe(true);
    conditional.date = addDays(conditional.date, 5);
    tickBoardRequests(conditional, []);
    expect(conditional.boardRequests[0]!.status).toBe("conditional");
  });
  it("construction pays once and adds seats once on the agreed date, even after the manager leaves", () => {
    const state = world();
    const teamId = state.userTeamId;
    const f = financeOf(state, teamId);
    const before = f.balance;
    const capacity = clubProfileIn(state, teamId).capacity;
    const deliversOn = addDays(state.date, 30);
    expect(decision(state, { granted: 60, deliversOn }).ok).toBe(true);
    expect(f.balance).toBe(before - 60 * BOARD_REQUEST.SEAT_COST);
    expect(f.assets.at(-1)?.months).toBe(STADIUM_ASSET_MONTHS);
    expect(decision(state, { requestId: state.boardRequests[0]!.id }).ok).toBe(false);
    delete state.manager.contract;
    state.date = deliversOn;
    tickBoardRequests(state, []);
    tickBoardRequests(state, []);
    expect(clubProfileIn(state, teamId).capacity).toBe(capacity + 60);
    expect(f.balance).toBe(before - 60 * BOARD_REQUEST.SEAT_COST);
  });
  it("an unemployed manager can advance time and accept an explicit interview offer", () => {
    const state = world();
    expect(
      reviewBoard(state, { action: "dismiss", team: state.userTeamId, reason: "고용 종료" }).ok,
    ).toBe(true);
    const day = state.date;
    expect(advanceTime(state, { days: 1 }).ok).toBe(true);
    expect(state.date > day).toBe(true);
    expect(applyForManagerJob(state, "arsenal").ok).toBe(true);
    expect(
      respondToInterview(state, {
        team: "arsenal",
        offer: true,
        reason: "새 조건 합의",
        terms: { salary: 1_000_000, years: 2, expiresOn: addDays(state.date, 10) },
      }).ok,
    ).toBe(true);
    expect(state.dismissal).toBeDefined();
    expect(acceptManagerOffer(state, "arsenal").ok).toBe(true);
    expect(state.dismissal).toBeUndefined();
    expect(state.manager.contract?.salary).toBe(1_000_000);
    expect(acceptManagerOffer(state, "arsenal").ok).toBe(false);
  });
});
