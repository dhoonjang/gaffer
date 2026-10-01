import {
  BOARD_REQUEST,
  acceptManagerOffer,
  offerManagerJob,
  reviewBoard,
  boardView,
  describeBoardRequests,
  buildingStadium,
  advanceTime,
  STADIUM_ASSET_MONTHS,
  addDays,
  clubProfileIn,
  consumeEarmark,
  earmarkedFor,
  financeOf,
  requestBoard,
  signingBudgetOf,
  tickBoardRequests,
  userWageRoom,
  wageLiftOf,
  type GameState,
} from "@story-fm/engine";
import type { RequestBoardInput } from "@story-fm/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestGame } from "../helpers";

describe("board financial decisions and execution", () => {
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
      kind: "transfer-budget",
      amount: 1_000_000,
      decision: "approved",
      authorizedBy: state.personas.find((p) => p.role === "owner")!.characterId,
      ...input,
    });
  }
  it("pending requests remain undecided and independent requests have unique IDs", () => {
    const state = world();
    for (let i = 0; i < 3; i++)
      expect(requestBoard(state, { kind: "transfer-budget", amount: 100 }).ok).toBe(true);
    expect(new Set(state.boardRequests.map((r) => r.id)).size).toBe(3);
    state.date = addDays(state.date, 100);
    tickBoardRequests(state, []);
    expect(state.boardRequests.every((r) => r.status === "pending")).toBe(true);
    expect(decision(state, { requestId: state.boardRequests[0]!.id, amount: 100 }).ok).toBe(true);
    expect(decision(state, { amount: 100 }).ok).toBe(true);
  });
  it("explicit partial approval applies once, creates no cash or income, and cannot replay", () => {
    const state = world();
    const f = financeOf(state, state.userTeamId);
    const budget = f.transferBudget;
    const balance = f.balance;
    expect(decision(state, { granted: 400_000 }).ok).toBe(true);
    expect(f.transferBudget).toBe(budget + 400_000);
    expect(f.balance).toBe(balance);
    tickBoardRequests(state, []);
    expect(f.transferBudget).toBe(budget + 400_000);
    expect(decision(state, { requestId: state.boardRequests[0]!.id }).ok).toBe(false);
  });
  it("rejects wrong authority, frozen finances, invalid dates and aggregate overcommitment atomically", () => {
    const state = world();
    const f = financeOf(state, state.userTeamId);
    expect(decision(state, { authorizedBy: "stranger" }).ok).toBe(false);
    f.budgetFrozen = true;
    expect(decision(state).ok).toBe(false);
    f.budgetFrozen = false;
    expect(decision(state, { respondOn: "garbage" }).ok).toBe(false);
    const available = f.balance - f.transferBudget;
    expect(decision(state, { amount: available }).ok).toBe(true);
    expect(decision(state, { amount: 1 }).ok).toBe(false);
    expect(state.boardRequests).toHaveLength(1);
  });
  it("scheduled decisions recheck funds on execution and do not silently shrink the grant", () => {
    const state = world();
    const f = financeOf(state, state.userTeamId);
    const old = f.transferBudget;
    expect(decision(state, { respondOn: addDays(state.date, 4) }).ok).toBe(true);
    f.balance = old;
    state.date = addDays(state.date, 4);
    tickBoardRequests(state, []);
    expect(state.boardRequests[0]!.status).toBe("pending");
    expect(f.transferBudget).toBe(old);
    f.balance += 1_000_000;
    tickBoardRequests(state, []);
    expect(f.transferBudget).toBe(old + 1_000_000);
  });
  it("conditions cannot fulfill after their deadline and context conditions require a GM decision", () => {
    const state = world();
    decision(state, {
      decision: "conditional",
      condition: { kind: "wage-cut", amount: 0, since: state.date, until: addDays(state.date, 1) },
    });
    state.date = addDays(state.date, 2);
    tickBoardRequests(state, []);
    expect(state.boardRequests[0]!.status).toBe("rejected");
    decision(state, {
      decision: "conditional",
      condition: { kind: "context", amount: 0, since: state.date, until: addDays(state.date, 20) },
    });
    expect(state.boardRequests[1]!.status).toBe("conditional");
    expect(decision(state, { requestId: state.boardRequests[1]!.id }).ok).toBe(true);
    expect(state.boardRequests[1]!.status).toBe("approved");
  });
  it("earmarks are player-specific, expire on agreed dates and consume once", () => {
    const state = world();
    const target = state.players.find((p) => p.teamId !== state.userTeamId)!;
    const until = addDays(state.date, 9);
    const base = signingBudgetOf(state, target.id);
    expect(decision(state, { kind: "signing", playerId: target.id, validUntil: until }).ok).toBe(
      true,
    );
    expect(signingBudgetOf(state, target.id)).toBe(base + 1_000_000);
    expect(earmarkedFor(state, state.players.find((p) => p.id !== target.id)!.id)).toBe(0);
    expect(consumeEarmark(state, target.id, 500_000)).toBe(500_000);
    expect(consumeEarmark(state, target.id, 500_000)).toBe(0);
    decision(state, { kind: "signing", playerId: target.id, validUntil: until });
    state.date = addDays(until, 1);
    expect(earmarkedFor(state, target.id)).toBe(0);
  });
  it("wage grants retain independent end dates", () => {
    const state = world();
    const room = userWageRoom(state);
    decision(state, { kind: "wage-room", amount: 1000, validUntil: addDays(state.date, 1) });
    decision(state, { kind: "wage-room", amount: 2000, validUntil: addDays(state.date, 20) });
    expect(wageLiftOf(state, state.userTeamId)).toBe(3000);
    expect(userWageRoom(state)).toBe(room + 3000);
    state.date = addDays(state.date, 2);
    expect(wageLiftOf(state, state.userTeamId)).toBe(2000);
  });
  it("construction pays for an asset and adds seats once on the agreed completion date", () => {
    const state = world();
    const f = financeOf(state, state.userTeamId);
    const before = f.balance;
    const capacity = clubProfileIn(state, state.userTeamId).capacity;
    const deliversOn = addDays(state.date, 30);
    expect(decision(state, { kind: "stadium", amount: 100, deliversOn }).ok).toBe(true);
    expect(f.balance).toBe(before - 100 * BOARD_REQUEST.SEAT_COST);
    expect(f.assets.at(-1)?.months).toBe(STADIUM_ASSET_MONTHS);
    expect(decision(state, { kind: "stadium", amount: 100, deliversOn }).ok).toBe(false);
    state.date = deliversOn;
    tickBoardRequests(state, []);
    tickBoardRequests(state, []);
    expect(clubProfileIn(state, state.userTeamId).capacity).toBe(capacity + 100);
  });
  function moveToChelsea(state: GameState) {
    financeOf(state, "chelsea").balance = 500_000_000;
    expect(reviewBoard(state, { action: "dismiss", team: "chelsea", reason: "후임 선임" }).ok).toBe(
      true,
    );
    expect(
      offerManagerJob(state, {
        team: "chelsea",
        salary: 2_000_000,
        years: 3,
        budgetPledge: 0,
        expiresOn: addDays(state.date, 10),
        reason: "합의한 이직",
      }).ok,
    ).toBe(true);
    expect(acceptManagerOffer(state, "chelsea").ok).toBe(true);
  }
  it("moving clubs preserves old construction and grants without exposing or transferring them to the new club", () => {
    const state = world();
    const oldClub = state.userTeamId;
    const oldCapacity = clubProfileIn(state, oldClub).capacity;
    const newCapacity = clubProfileIn(state, "chelsea").capacity;
    const deliversOn = addDays(state.date, 2);
    expect(decision(state, { kind: "stadium", amount: 100, deliversOn }).ok).toBe(true);
    const construction = state.boardRequests.at(-1)!;
    const target = state.players.find((p) => p.teamId !== oldClub)!;
    expect(
      decision(state, { kind: "signing", playerId: target.id, validUntil: addDays(state.date, 1) })
        .ok,
    ).toBe(true);
    expect(
      decision(state, { kind: "wage-room", amount: 100, validUntil: addDays(state.date, 10) }).ok,
    ).toBe(true);
    requestBoard(state, { kind: "transfer-budget", amount: 500 });
    const pending = state.boardRequests.at(-1)!;
    moveToChelsea(state);
    expect(construction.teamId).toBe(oldClub);
    expect(state.boardRequests).toHaveLength(4);
    expect(financeOf(state, oldClub).earmarked).toHaveLength(1);
    expect(earmarkedFor(state, target.id)).toBe(0);
    expect(wageLiftOf(state, "chelsea")).toBe(0);
    expect(wageLiftOf(state, oldClub)).toBe(100);
    expect(buildingStadium(state)).toBeNull();
    expect(boardView(state).requests).toHaveLength(0);
    expect(describeBoardRequests(state)).toBeNull();
    expect(decision(state, { requestId: pending.id, amount: 500 }).ok).toBe(false);
    expect(pending.status).toBe("pending");
    expect(decision(state, { kind: "stadium", amount: 10, deliversOn }).ok).toBe(true);
    state.date = deliversOn;
    tickBoardRequests(state, []);
    tickBoardRequests(state, []);
    expect(clubProfileIn(state, oldClub).capacity).toBe(oldCapacity + 100);
    expect(clubProfileIn(state, "chelsea").capacity).toBe(newCapacity + 10);
    expect(financeOf(state, oldClub).earmarked).toHaveLength(0);
    expect(construction.deliveredOn).toBe(deliversOn);
  });
  it("scheduled grants and construction pay the owning club after a move, and delivery continues while unemployed", () => {
    const state = world();
    const oldClub = state.userTeamId;
    const respondOn = addDays(state.date, 1);
    const deliversOn = addDays(state.date, 2);
    expect(decision(state, { amount: 1000, respondOn }).ok).toBe(true);
    expect(decision(state, { kind: "stadium", amount: 25, respondOn, deliversOn }).ok).toBe(true);
    moveToChelsea(state);
    const oldFinance = financeOf(state, oldClub);
    const newFinance = financeOf(state, "chelsea");
    const oldBalance = oldFinance.balance;
    const oldBudget = oldFinance.transferBudget;
    const newBalance = newFinance.balance;
    const newBudget = newFinance.transferBudget;
    const oldCapacity = clubProfileIn(state, oldClub).capacity;
    state.date = respondOn;
    oldFinance.balance = oldBudget;
    tickBoardRequests(state, []);
    expect(state.boardRequests.every((r) => r.status === "pending")).toBe(true);
    expect(oldFinance.transferBudget).toBe(oldBudget);
    oldFinance.balance = oldBalance;
    tickBoardRequests(state, []);
    tickBoardRequests(state, []);
    expect(oldFinance.transferBudget).toBe(oldBudget + 1000);
    expect(oldFinance.balance).toBe(oldBalance - 25 * BOARD_REQUEST.SEAT_COST);
    expect(oldFinance.assets.at(-1)?.cost).toBe(25 * BOARD_REQUEST.SEAT_COST);
    expect(newFinance.balance).toBe(newBalance);
    expect(newFinance.transferBudget).toBe(newBudget);
    expect(
      reviewBoard(state, { action: "dismiss", team: state.userTeamId, reason: "계약 종료" }).ok,
    ).toBe(true);
    advanceTime(state, { days: 1 });
    expect(state.date).toBe(deliversOn);
    expect(clubProfileIn(state, oldClub).capacity).toBe(oldCapacity + 25);
    expect(state.boardRequests.find((r) => r.kind === "stadium")?.deliveredOn).toBe(deliversOn);
  });
});
