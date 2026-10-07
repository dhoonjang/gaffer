import { beforeAll, describe, expect, it } from "vitest";
import type { GameState, NegotiationActor } from "@gaffer/engine";
import { contractEndForYears, mailRecipientHandle, type ProposalTerms } from "@gaffer/domain";
import { addDays } from "../../src/core/dates";
import { progressMandates } from "../../src/team/negotiation-mandate";
import {
  processWorldMarket,
  marketReviewCohort,
  marketClubFingerprint,
  decideWorldManager,
  decideWorldMarket,
  applyWorldMarketIntent,
  progressWorldMarketDeals,
  actNegotiation,
  sendMail,
  completeMailReply,
  dueMailReplies,
  buildMailView,
  resolveMailRecipient,
  resolveMailRecipientText,
  searchMailRecipients,
  getMailRequestResult,
  staffOf,
  mailMessageForViewer,
  deliverIncomingMail,
  activeContract,
  applyNegotiationRequest,
  delegateNegotiation,
  buildNegotiationView,
  financeOf,
  isAvailable,
  openNegotiation,
  setTransferListing,
  buildTransferListingView,
  toFreeAgency,
  repairNegotiationSquads,
  settleNegotiations,
  signatureDeadlinesToday,
  advanceTime,
  summarise,
} from "@gaffer/engine";
import { createMiniGame, resultOf } from "../helpers";
let base: GameState;
beforeAll(() => {
  base = createMiniGame();
});
function setup(effectiveDay = "02") {
  const state = structuredClone(base);
  const player = state.players.find(
    (p) => p.teamId !== state.userTeamId && activeContract(state, p.id),
  );
  if (!player) throw new Error("fixture opponent missing");
  const result = openNegotiation(state, {
    playerId: player.id,
    buyerId: state.userTeamId,
    kind: "transfer",
    background: "영입 검토",
  });
  expect(result.ok).toBe(true);
  const n = state.negotiations[0];
  if (!n) throw new Error("case missing");
  const terms: ProposalTerms = {
    scope: "player",
    fee: 0,
    installments: [],
    weeklyWage: Math.max(1000, n.bounds.minWeeklyWage),
    signingBonus: 200,
    since: "2025-07-02",
    until: "2026-07-02",
    expiresOn: "2025-07-10",
    promises: [],
  };
  // Fixture's calendar is the source of the proposed effective date.
  terms.since = state.date.slice(0, 8) + effectiveDay;
  terms.until = String(Number(terms.since.slice(0, 4)) + 1) + terms.since.slice(4);
  terms.expiresOn = state.date.slice(0, 8) + "10";
  const user = { kind: "user" as const, partyId: state.userTeamId };
  const model = (partyId: string) => ({ kind: "model" as const, partyId });
  const action = (a: unknown, actor: NegotiationActor = user) =>
    actNegotiation(state, n.id, a, actor);
  return { state, player, n, terms, user, model, action, fee: Math.max(1000, n.bounds.minFee) };
}
function agreed(effectiveDay = "02") {
  const s = setup(effectiveDay);
  expect(
    s.action({
      kind: "send",
      terms: {
        ...s.terms,
        scope: "club",
        fee: s.fee,
        signingBonus: 0,
        weeklyWage: 0,
        installments: [{ date: s.terms.until, amount: 500 }],
      },
    }).ok,
  ).toBe(true);
  expect(
    actNegotiation(
      s.state,
      s.n.id,
      { kind: "accept", proposalId: s.n.proposals[0]!.id },
      s.model(s.n.sellerId),
    ).ok,
  ).toBe(true);
  expect(s.action({ kind: "send", terms: s.terms }).ok).toBe(true);
  expect(
    actNegotiation(
      s.state,
      s.n.id,
      { kind: "accept", proposalId: s.n.proposals[1]!.id },
      s.model(s.player.id),
    ).ok,
  ).toBe(true);
  return s;
}
describe("negotiation ledger", () => {
  it("rejects fabricated manager consent and stale requests without state mutations", () => {
    const s = setup();
    const before = structuredClone(s.state);
    expect(
      actNegotiation(s.state, s.n.id, { kind: "send", terms: s.terms }, s.model(s.state.userTeamId))
        .ok,
    ).toBe(false);
    expect(s.state).toEqual(before);
    expect(
      applyNegotiationRequest(s.state, {
        requestId: "stale",
        negotiationId: s.n.id,
        revision: 99,
        action: { kind: "withdraw", reason: "중단" },
      }).status,
    ).toBe(409);
    expect(s.state).toEqual(before);
  });
  it("supersedes consent with a new immutable proposal", () => {
    const s = agreed();
    const first = structuredClone(s.n.proposals[1]);
    expect(
      s.action({ kind: "send", terms: { ...s.terms, weeklyWage: s.terms.weeklyWage + 1000 } }).ok,
    ).toBe(true);
    expect(s.n.proposals[1]).toEqual({ ...first, status: "superseded" });
    expect(s.n.proposals[2]!.acceptedBy).toEqual([s.state.userTeamId]);
    expect(s.action({ kind: "medical" }).ok).toBe(false);
  });
  it("requires timed medical, settles dated money exactly once, and keeps registration separate", () => {
    const s = agreed();
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    const before = structuredClone(s.state);
    expect(s.action({ kind: "sign" }).ok).toBe(false);
    expect(s.state).toEqual(before);
    s.state.date = s.terms.since;
    settleNegotiations(s.state);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    const buyer = financeOf(s.state, s.n.buyerId).balance;
    const seller = financeOf(s.state, s.n.sellerId).balance;
    expect(s.action({ kind: "sign" }).ok).toBe(true);
    expect(s.player.teamId).toBe(s.n.buyerId);
    expect(activeContract(s.state, s.player.id)?.weeklyWage).toBe(s.terms.weeklyWage);
    expect(isAvailable(s.state, s.player)).toBe(false);
    expect(financeOf(s.state, s.n.buyerId).balance).toBe(buyer - s.fee - 200);
    expect(financeOf(s.state, s.n.sellerId).balance).toBe(seller + s.fee);
    settleNegotiations(s.state);
    expect(financeOf(s.state, s.n.buyerId).balance).toBe(buyer - s.fee - 200);
    const summary = summarise(financeOf(s.state, s.n.buyerId).ledger);
    expect(summary.cashNet).toBe(-s.fee - 200);
    expect(summary.pnlNet).toBe(0);
    for (const p of s.state.players)
      if (p.teamId === s.n.buyerId && p.id !== s.player.id) p.squadLevel = "reserve";
    expect(s.action({ kind: "register" }).ok).toBe(true);
    expect(activeContract(s.state, s.player.id)?.registrationStatus).toBe("registered");
    s.state.date = s.terms.until;
    settleNegotiations(s.state);
    expect(financeOf(s.state, s.n.buyerId).balance).toBe(buyer - s.fee - 700);
    expect(activeContract(s.state, s.player.id)?.acquisition?.amortized).toBe(s.fee + 700);
  });
  it("does not mutate injury facts during examination and refuses changed evidence", () => {
    const s = agreed();
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    const injuries = structuredClone(s.state.injuries);
    s.state.date = s.terms.since;
    settleNegotiations(s.state);
    expect(s.state.injuries).toEqual(injuries);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    s.state.injuries.push({
      id: "new-evidence",
      gamePlayerId: s.player.id,
      bodyPart: "발목",
      severity: "minor",
      cause: "training",
      occurredOn: s.state.date,
      expectedReturn: s.terms.expiresOn,
      returnedOn: null,
    });
    const before = structuredClone(s.state);
    expect(s.action({ kind: "sign" }).ok).toBe(false);
    expect(s.state).toEqual(before);
  });
  it("replays accepted request ids without submitting another proposal", () => {
    const s = setup();
    const request = {
      requestId: "send-once",
      negotiationId: s.n.id,
      revision: s.n.revision,
      action: { kind: "send", terms: s.terms },
    };
    expect(applyNegotiationRequest(s.state, request).ok).toBe(true);
    expect(applyNegotiationRequest(s.state, request).replayed).toBe(true);
    expect(s.n.proposals).toHaveLength(1);
  });
  it("seller office hides buyer and player private conditions", () => {
    const s = agreed();
    s.state.userTeamId = s.n.sellerId;
    const view = buildNegotiationView(s.state);
    const n = view.cases[0];
    if (!n) throw new Error("view missing");
    expect(n.proposals.every((p) => p.terms.scope === "club")).toBe(true);
    expect(n.medical).toBeNull();
    expect(n.drafts.every((p) => p.scope === "club")).toBe(true);
  });
});

describe("negotiation boundaries", () => {
  it("retains a signed future obligation past proposal expiry and pays on the exact due day", () => {
    const s = agreed("12");
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    s.state.date = s.state.date.slice(0, 8) + "02";
    settleNegotiations(s.state);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    const oldTeam = s.player.teamId;
    expect(s.action({ kind: "sign" }).ok).toBe(true);
    expect(s.n.status).toBe("signed");
    s.state.date = s.state.date.slice(0, 8) + "11";
    settleNegotiations(s.state);
    expect(s.player.teamId).toBe(oldTeam);
    expect(s.n.status).toBe("signed");
    expect(s.state.transferPayments.every((p) => p.paidOn === null)).toBe(true);
    s.state.date = s.terms.since;
    settleNegotiations(s.state);
    expect(s.n.status).toBe("completed");
    expect(s.player.teamId).toBe(s.n.buyerId);
    expect(s.state.transferPayments.filter((p) => p.paidOn === s.state.date)).toHaveLength(2);
  });
  it("insufficient cash rejects signing atomically including future installments", () => {
    const s = agreed();
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    s.state.date = s.terms.since;
    settleNegotiations(s.state);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    financeOf(s.state, s.n.buyerId).balance = s.fee + 699;
    const before = structuredClone(s.state);
    expect(s.action({ kind: "sign" }).ok).toBe(false);
    expect(s.state).toEqual(before);
  });
  it("source replacement and invalid calendar dates cannot alter a case", () => {
    const s = setup();
    const before = structuredClone(s.state);
    expect(s.action({ kind: "send", terms: { ...s.terms, since: "2025-02-30" } }).ok).toBe(false);
    expect(s.state).toEqual(before);
    const contract = activeContract(s.state, s.player.id);
    if (!contract) throw new Error("contract missing");
    contract.id = "replacement";
    const changed = structuredClone(s.state);
    expect(s.action({ kind: "send", terms: s.terms }).ok).toBe(false);
    expect(s.state).toEqual(changed);
    expect(s.action({ kind: "withdraw", reason: "현재 소속 변경으로 중단" }).ok).toBe(true);
    expect(s.n.status).toBe("withdrawn");
  });
});

it("AI roster repair preserves manager control, familiarity, and unique assignments", () => {
  const s = setup();
  const ai = s.state.tactics.find((t) => t.teamId === s.n.sellerId);
  const user = s.state.tactics.find((t) => t.teamId === s.n.buyerId);
  if (!ai || !user) throw new Error("fixture tactics missing");
  const departing = ai.assignments.find((a) => a.role === "starting" && a.position === "GK");
  if (!departing) throw new Error("fixture goalkeeper missing");
  const original = s.state.players.find((p) => p.id === departing.playerId);
  if (!original) throw new Error("fixture player missing");
  const incoming = structuredClone(original);
  incoming.id = "registered-incoming-keeper";
  incoming.squadNumber = undefined;
  for (const key of Object.keys(incoming.attributes) as Array<keyof typeof incoming.attributes>)
    incoming.attributes[key] = 99;
  s.state.players.push(incoming);
  const oldContract = activeContract(s.state, original.id);
  if (!oldContract) throw new Error("fixture contract missing");
  s.state.contracts.push({
    ...oldContract,
    id: "incoming-contract",
    gamePlayerId: incoming.id,
    registrationStatus: "registered",
  });
  original.teamId = s.n.buyerId;
  for (const a of ai.assignments) a.familiarity = 77;
  const before = structuredClone(ai.assignments);
  const userBefore = structuredClone(user);
  repairNegotiationSquads(s.state, [ai.teamId, user.teamId, ai.teamId]);
  expect(user).toEqual(userBefore);
  expect(ai.assignments.some((a) => a.playerId === original.id)).toBe(false);
  expect(ai.assignments.some((a) => a.playerId === incoming.id && a.role === "starting")).toBe(
    true,
  );
  expect(new Set(ai.assignments.map((a) => a.playerId)).size).toBe(ai.assignments.length);
  for (const a of ai.assignments)
    if (
      before.some(
        (old) =>
          old.playerId === a.playerId && old.position === a.position && old.roleId === a.roleId,
      )
    )
      expect(a.familiarity).toBe(77);
});

it("a rival transfer withdraws incompatible unsigned cases while preserving signed payments", () => {
  const s = agreed();
  const rival = s.state.teams.find(
    (t) => t.id !== s.n.sellerId && t.id !== s.n.buyerId && t.id !== "freeagents",
  );
  if (!rival) throw new Error("fixture rival missing");
  expect(
    openNegotiation(
      s.state,
      { playerId: s.player.id, buyerId: rival.id, kind: "transfer", background: "다른 구단 관심" },
      "world",
    ).ok,
  ).toBe(true);
  expect(s.action({ kind: "medical" }).ok).toBe(true);
  s.state.date = s.terms.since;
  settleNegotiations(s.state);
  expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
  expect(s.action({ kind: "sign" }).ok).toBe(true);
  expect(s.state.negotiations.find((n) => n.buyerId === rival.id)?.status).toBe("withdrawn");
  expect(s.state.transferPayments.some((p) => p.paidOn === null)).toBe(true);
});
it("transfer proceeds and sale gain do not count twice as operating revenue", () => {
  const summary = summarise([
    {
      id: "r",
      date: base.date,
      kind: "income",
      category: "commercial",
      label: "스폰서",
      amount: 1000,
    },
    {
      id: "cash",
      date: base.date,
      kind: "income",
      category: "transfer_income",
      label: "매각 현금",
      amount: 10000,
    },
    {
      id: "gain",
      date: base.date,
      kind: "income",
      category: "transfer_gain",
      label: "매각 이익",
      amount: 10000,
      accounting: "noncash",
    },
    {
      id: "w",
      date: base.date,
      kind: "expense",
      category: "player_wages",
      label: "주급",
      amount: 500,
    },
  ]);
  expect(summary.wageRatio).toBe(0.5);
  expect(summary.cashNet).toBe(10500);
  expect(summary.pnlNet).toBe(10500);
});

it("live-match checkpoints reject all negotiating mutations atomically", () => {
  const s = setup();
  s.state.phase = "match";
  const before = structuredClone(s.state);
  expect(s.action({ kind: "send", terms: s.terms }).ok).toBe(false);
  expect(s.action({ kind: "withdraw", reason: "중단" }).ok).toBe(false);
  expect(
    openNegotiation(s.state, {
      playerId: s.player.id,
      buyerId: s.n.buyerId,
      kind: "transfer",
      background: "재문의",
    }).ok,
  ).toBe(false);
  expect(s.state).toEqual(before);
});

it("a free-agent destination cannot become the buyer of a managed-club sale", () => {
  const state = structuredClone(base);
  const player = state.players.find(
    (p) => p.teamId === state.userTeamId && activeContract(state, p.id),
  );
  if (!player) throw new Error("fixture managed player missing");
  expect(state.teams.some((t) => t.id === "freeagents")).toBe(true);
  const before = structuredClone(state);
  const result = openNegotiation(state, {
    playerId: player.id,
    buyerId: "freeagents",
    kind: "transfer",
    background: "매각 협상",
  });
  expect(result.ok).toBe(false);
  expect(state).toEqual(before);
});

describe("natural-language offers require explicit current consent", () => {
  it("managed model drafts never create proposals or fabricate consent/signatures", () => {
    const s = setup();
    expect(
      actNegotiation(s.state, s.n.id, { kind: "draft", terms: s.terms }, s.model(s.n.buyerId)).ok,
    ).toBe(true);
    expect(s.n.proposals).toEqual([]);
    expect(s.n.drafts).toEqual([s.terms]);
    const before = structuredClone(s.state);
    for (const action of [
      { kind: "send", terms: s.terms },
      { kind: "accept", proposalId: "missing" },
      { kind: "sign" },
    ]) {
      expect(actNegotiation(s.state, s.n.id, action, s.model(s.n.buyerId)).ok).toBe(false);
      expect(s.state).toEqual(before);
    }
    expect(s.action({ kind: "sign" }).ok).toBe(false);
    expect(s.state).toEqual(before);
  });
  it("counterparty proposal consent excludes the managed club until exact user confirmation", () => {
    const s = setup();
    expect(
      actNegotiation(s.state, s.n.id, { kind: "draft", terms: s.terms }, s.model(s.n.buyerId)).ok,
    ).toBe(true);
    expect(
      actNegotiation(s.state, s.n.id, { kind: "send", terms: s.terms }, s.model(s.player.id)).ok,
    ).toBe(true);
    const proposal = s.n.proposals[0]!;
    expect(proposal.author).toBe(s.player.id);
    expect(proposal.acceptedBy).toEqual([s.player.id]);
    const before = structuredClone(s.state);
    expect(
      actNegotiation(
        s.state,
        s.n.id,
        { kind: "accept", proposalId: proposal.id },
        s.model(s.n.buyerId),
      ).ok,
    ).toBe(false);
    expect(s.state).toEqual(before);
    expect(
      applyNegotiationRequest(s.state, {
        requestId: "confirm-exact",
        negotiationId: s.n.id,
        revision: s.n.revision,
        action: { kind: "accept", proposalId: proposal.id },
      }).ok,
    ).toBe(true);
    expect(proposal.acceptedBy).toEqual([s.player.id, s.n.buyerId]);
  });
  it("stale, superseded, and expired confirmations fail atomically", () => {
    const s = setup();
    expect(
      actNegotiation(s.state, s.n.id, { kind: "send", terms: s.terms }, s.model(s.player.id)).ok,
    ).toBe(true);
    const old = s.n.proposals[0]!;
    const revision = s.n.revision;
    expect(
      actNegotiation(
        s.state,
        s.n.id,
        { kind: "send", terms: { ...s.terms, weeklyWage: s.terms.weeklyWage + 1000 } },
        s.model(s.player.id),
      ).ok,
    ).toBe(true);
    const current = s.n.proposals[1]!;
    let before = structuredClone(s.state);
    expect(
      applyNegotiationRequest(s.state, {
        requestId: "stale-confirm",
        negotiationId: s.n.id,
        revision,
        action: { kind: "accept", proposalId: current.id },
      }).status,
    ).toBe(409);
    expect(s.state).toEqual(before);
    expect(s.action({ kind: "accept", proposalId: old.id }).ok).toBe(false);
    expect(s.state).toEqual(before);
    s.state.date = s.state.date.slice(0, 8) + "11";
    before = structuredClone(s.state);
    expect(s.action({ kind: "accept", proposalId: current.id }).ok).toBe(false);
    expect(s.state).toEqual(before);
  });
  it("revised offers remove old agreement while retaining valid actual medical evidence", () => {
    const s = agreed();
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    s.state.date = s.terms.since;
    settleNegotiations(s.state);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    const medical = structuredClone(s.n.medical);
    expect(
      actNegotiation(
        s.state,
        s.n.id,
        { kind: "send", terms: { ...s.terms, weeklyWage: s.terms.weeklyWage + 1000 } },
        s.model(s.player.id),
      ).ok,
    ).toBe(true);
    const revised = s.n.proposals[2]!;
    expect(revised.acceptedBy).toEqual([s.player.id]);
    expect(s.n.medical).toEqual(medical);
    const before = structuredClone(s.state);
    expect(s.action({ kind: "sign" }).ok).toBe(false);
    expect(s.state).toEqual(before);
    expect(s.action({ kind: "accept", proposalId: revised.id }).ok).toBe(true);
    expect(s.action({ kind: "sign" }).ok).toBe(true);
    expect(activeContract(s.state, s.player.id)?.weeklyWage).toBe(s.terms.weeklyWage + 1000);
  });
  it("medical requires non-expired agreed offers even before expiry settlement", () => {
    const s = agreed();
    s.state.date = s.state.date.slice(0, 8) + "11";
    const before = structuredClone(s.state);
    expect(s.action({ kind: "medical" }).ok).toBe(false);
    expect(s.state).toEqual(before);
  });
});

describe("agent center ledger and bounded search", () => {
  it("resumes a withdrawn case without carrying agreement or erasing its history", () => {
    const s = agreed();
    const oldProposal = s.n.proposals[0]!;
    expect(s.action({ kind: "withdraw", reason: "보류" }).ok).toBe(true);
    const revision = s.n.revision;
    const input = {
      playerId: s.player.id,
      buyerId: s.n.buyerId,
      kind: "transfer",
      background: "다시 논의",
    };
    expect(openNegotiation(s.state, input).negotiationId).toBe(s.n.id);
    expect(s.state.negotiations).toHaveLength(1);
    expect(s.n.revision).toBeGreaterThan(revision);
    expect(s.n.proposals.every((p) => p.status === "superseded")).toBe(true);
    expect(s.action({ kind: "accept", proposalId: oldProposal.id }).ok).toBe(false);
    const before = structuredClone(s.state);
    expect(openNegotiation(s.state, input).negotiationId).toBe(s.n.id);
    expect(s.state).toEqual(before);
    const buyer = s.state.finances.find((f) => ![s.n.buyerId, s.n.sellerId].includes(f.teamId))!;
    expect(
      openNegotiation(s.state, { ...input, buyerId: buyer.teamId }, "world").negotiationId,
    ).not.toBe(s.n.id);
  });
  it("reuses completed renewal history with unique contracts and payment obligations", () => {
    const s = setup("01");
    const own = s.state.players.find((p) => p.teamId === s.state.userTeamId)!;
    const input = { playerId: own.id, buyerId: own.teamId, kind: "renewal", background: "재계약" };
    const id = openNegotiation(s.state, input).negotiationId!;
    for (let round = 0; round < 2; round++) {
      expect(openNegotiation(s.state, input).negotiationId).toBe(id);
      const action = (a: unknown, partyId = own.teamId) =>
        actNegotiation(s.state, id, a, {
          kind: partyId === own.teamId ? "user" : "model",
          partyId,
        });
      expect(action({ kind: "send", terms: s.terms }).ok).toBe(true);
      const n = s.state.negotiations.find((n) => n.id === id)!;
      expect(action({ kind: "accept", proposalId: n.proposals.at(-1)!.id }, own.id).ok).toBe(true);
      expect(action({ kind: "sign" }).ok).toBe(true);
      expect(n.status).toBe("completed");
    }
    const contracts = s.state.contracts.filter((c) => c.id.startsWith(id));
    expect(contracts).toHaveLength(2);
    expect(new Set(contracts.map((c) => c.id)).size).toBe(2);
    expect(contracts.filter((c) => c.status === "active")).toHaveLength(1);
    const payments = s.state.transferPayments.filter((p) => p.negotiationId === id);
    expect(payments).toHaveLength(2);
    expect(new Set(payments.map((p) => p.id)).size).toBe(2);
    expect(payments.every((p) => p.paidOn === s.state.date)).toBe(true);
    const settled = structuredClone(s.state);
    settleNegotiations(s.state);
    settleNegotiations(s.state);
    expect(s.state).toEqual(settled);
  });
  it("lists only owned players, preserves date and repeated requests, and never sells", () => {
    const state = structuredClone(base);
    const own = state.players.find((p) => p.teamId === state.userTeamId)!;
    const other = state.players.find((p) => p.teamId !== state.userTeamId)!;
    own.positions.forEach((p, index) => (p.isNatural = index === 0));
    const originalContract = structuredClone(activeContract(state, own.id));
    const originalCash = financeOf(state, state.userTeamId).balance;
    for (const input of [
      { playerId: other.id, listed: true },
      { playerId: own.id, listed: true, askingPrice: 1.5 },
      { playerId: own.id, listed: true, askingPrice: -1 },
    ]) {
      const before = structuredClone(state);
      expect(setTransferListing(state, input).ok).toBe(false);
      expect(state).toEqual(before);
    }
    expect(
      setTransferListing(state, { playerId: own.id, listed: true, askingPrice: 123456 }).ok,
    ).toBe(true);
    const listed = structuredClone(state);
    expect(buildTransferListingView(state).transferList[0]?.positions).toEqual([
      own.positions[0]!.position,
    ]);
    expect(
      setTransferListing(state, { playerId: own.id, listed: true, askingPrice: 123456 }).ok,
    ).toBe(true);
    expect(state).toEqual(listed);
    state.date = state.date.slice(0, 8) + "02";
    expect(setTransferListing(state, { playerId: own.id, listed: true, askingPrice: 0 }).ok).toBe(
      true,
    );
    expect(state.transferListings[0]?.listedOn).toBe(listed.date);
    expect(state.transferListings[0]?.askingPrice).toBe(0);
    expect(activeContract(state, own.id)).toEqual(originalContract);
    expect(financeOf(state, state.userTeamId).balance).toBe(originalCash);
    expect(state.negotiations).toEqual([]);
    expect(setTransferListing(state, { playerId: own.id, listed: false }).ok).toBe(true);
    const removed = structuredClone(state);
    expect(setTransferListing(state, { playerId: own.id, listed: false }).ok).toBe(true);
    expect(state).toEqual(removed);
  });
  it("listing live-match and unemployed mutations fail while read views remain available", () => {
    const state = structuredClone(base);
    const own = state.players.find((p) => p.teamId === state.userTeamId)!;
    state.phase = "match";
    let before = structuredClone(state);
    expect(setTransferListing(state, { playerId: own.id, listed: true }).ok).toBe(false);
    expect(state).toEqual(before);
    state.phase = "idle";
    state.dismissal = {
      on: state.date,
      season: state.season,
      kind: "sacked",
      teamId: state.userTeamId,
      tier: 1,
    };
    before = structuredClone(state);
    expect(setTransferListing(state, { playerId: own.id, listed: true }).ok).toBe(false);
    expect(state).toEqual(before);
  });
  it("shows related sale cases and removes departure listings without exposing former ownership", () => {
    const state = structuredClone(base);
    const own = state.players.find((p) => p.teamId === state.userTeamId)!;
    const buyer = state.finances.find((f) => f.teamId !== state.userTeamId)!;
    expect(setTransferListing(state, { playerId: own.id, listed: true }).ok).toBe(true);
    const opened = openNegotiation(state, {
      playerId: own.id,
      buyerId: buyer.teamId,
      kind: "transfer",
      background: "매각 문의",
    });
    expect(buildTransferListingView(state).transferList[0]?.negotiationIds).toEqual([
      opened.negotiationId,
    ]);
    toFreeAgency(state, own);
    expect(state.transferListings).toEqual([]);
    expect(buildTransferListingView(state).transferList).toEqual([]);
    state.transferListings.push({ gamePlayerId: own.id, listedOn: state.date });
    expect(buildTransferListingView(state).transferList).toEqual([]);
  });
  it("reopening a signed future inquiry returns its case without duplicating commitments", () => {
    const s = agreed("12");
    expect(s.action({ kind: "medical" }).ok).toBe(true);
    s.state.date = s.state.date.slice(0, 8) + "02";
    settleNegotiations(s.state);
    expect(s.action({ kind: "acknowledge_medical" }).ok).toBe(true);
    expect(s.action({ kind: "sign" }).ok).toBe(true);
    const before = structuredClone(s.state);
    expect(
      openNegotiation(s.state, {
        playerId: s.player.id,
        buyerId: s.n.buyerId,
        kind: "transfer",
        background: "재문의",
      }).negotiationId,
    ).toBe(s.n.id);
    expect(s.state).toEqual(before);
  });
});

describe("mail ledger and economic acceptance", () => {
  it("sends once, coalesces the cursor, waits for game time and rejects stale completion atomically", () => {
    const s = setup();
    const recipient = { kind: "club", teamId: s.n.sellerId };
    const input = {
      requestId: "mail-test-1",
      recipient,
      subject: "문의",
      body: "첫 연락",
      negotiationId: s.n.id,
    };
    const sent = sendMail(s.state, input);
    expect(sent.ok).toBe(true);
    const saved = structuredClone(s.state);
    expect(sendMail(s.state, input)).toMatchObject({
      ok: true,
      threadId: sent.threadId,
      messageId: sent.messageId,
      replayed: true,
    });
    expect(s.state).toEqual(saved);
    expect(dueMailReplies(s.state)).toEqual([]);
    const cursor = sent.messageId!;
    expect(sendMail(s.state, { ...input, requestId: "mail-test-2", body: "추가 연락" }).ok).toBe(
      true,
    );
    expect(s.state.mailReplyJobs).toHaveLength(1);
    s.state.date = s.terms.since;
    const job = dueMailReplies(s.state)[0]!;
    expect(job).toBeDefined();
    const before = structuredClone(s.state);
    expect(
      completeMailReply(s.state, job.id, {
        throughMessageId: cursor,
        subject: "회신",
        body: "답변",
      }).ok,
    ).toBe(false);
    expect(s.state).toEqual(before);
    expect(
      completeMailReply(s.state, job.id, {
        throughMessageId: job.throughMessageId,
        subject: "회신",
        body: "답변",
        negotiationId: s.n.id,
      }).ok,
    ).toBe(true);
    const completed = structuredClone(s.state);
    expect(
      completeMailReply(s.state, job.id, {
        throughMessageId: job.throughMessageId,
        subject: "회신",
        body: "답변",
      }).replayed,
    ).toBe(true);
    expect(s.state).toEqual(completed);
    expect(buildMailView(s.state).unread).toBe(1);
    expect(sendMail(s.state, { ...input, requestId: "mail-test-3" }).ok).toBe(true);
    expect(s.state.mailReplyJobs).toHaveLength(2);
  });
  it("uses stable contacts, validates recipient and attachments, and isolates a former manager's mail", () => {
    const s = setup();
    const recipient = { kind: "agent", playerId: s.player.id };
    const first = resolveMailRecipient(s.state, recipient)!;
    const another = s.state.players.find(
      (p) =>
        p.id !== s.player.id &&
        resolveMailRecipient(s.state, { kind: "agent", playerId: p.id })?.contactId ===
          first.contactId,
    );
    const alternative = another ?? s.state.players.find((p) => p.id !== s.player.id)!;
    const input = {
      requestId: "agent-mail",
      recipient,
      subject: "조건",
      body: "문의",
      negotiationId: s.n.id,
    };
    const sent = sendMail(s.state, input);
    expect(sent.ok).toBe(true);
    const second = sendMail(s.state, {
      ...input,
      requestId: "agent-mail-2",
      recipient: { kind: "agent", playerId: alternative.id },
    });
    if (another) expect(second.threadId).toBe(sent.threadId);
    else expect(second.ok).toBe(false);
    const before = structuredClone(s.state);
    expect(
      sendMail(s.state, {
        ...input,
        requestId: "bad-staff",
        recipient: { kind: "staff", personId: "nonexistent" },
      }).ok,
    ).toBe(false);
    expect(s.state).toEqual(before);
    expect(mailMessageForViewer(s.state, sent.messageId!)).not.toBeNull();
    s.state.dismissal = {
      on: s.state.date,
      season: s.state.season,
      kind: "sacked",
      teamId: s.state.userTeamId,
      tier: 1,
    };
    expect(buildMailView(s.state).threads).toEqual([]);
    expect(mailMessageForViewer(s.state, sent.messageId!)).toBeNull();
  });
  it("records incoming reports once without inventing an outbound message or reply task", () => {
    const s = setup();
    const input = {
      requestId: "inbound-test",
      recipient: { kind: "club", teamId: s.n.sellerId },
      subject: "접근",
      body: "실제 연락",
      negotiationId: s.n.id,
    };
    expect(deliverIncomingMail(s.state, input).ok).toBe(true);
    const before = structuredClone(s.state);
    expect(deliverIncomingMail(s.state, input).replayed).toBe(true);
    expect(s.state).toEqual(before);
    expect(s.state.mailReplyJobs).toEqual([]);
    expect(s.state.mailThreads[0]!.messages[0]!.direction).toBe("inbound");
  });
  it("lets the manager offer unrealistic terms but blocks NPC consent and hides private reservations", () => {
    const s = setup();
    const terms = { ...s.terms, scope: "club", fee: 1, weeklyWage: 0, signingBonus: 0 };
    expect(s.action({ kind: "send", terms }).ok).toBe(true);
    const before = structuredClone(s.state),
      proposal = s.n.proposals[0]!;
    expect(s.action({ kind: "accept", proposalId: proposal.id }, s.model(s.n.sellerId)).ok).toBe(
      false,
    );
    expect(s.state).toEqual(before);
    expect(s.action({ kind: "send", terms }, s.model(s.n.sellerId)).ok).toBe(false);
    expect(s.state).toEqual(before);
    expect(buildNegotiationView(s.state).cases[0]).not.toHaveProperty("bounds");
    expect(s.action({ kind: "draft", terms: s.terms }).ok).toBe(true);
    expect(s.n.bounds.fingerprint).toBe(before.negotiations[0]!.bounds.fingerprint);
    expect(s.action({ kind: "send", terms: { ...s.terms, weeklyWage: 1000000000 } }).ok).toBe(true);
    const wageBefore = structuredClone(s.state);
    expect(
      s.action({ kind: "accept", proposalId: s.n.proposals.at(-1)!.id }, s.model(s.player.id)).ok,
    ).toBe(false);
    expect(s.state).toEqual(wageBefore);
  });
});

describe("mail recipient name resolution", () => {
  it("resolves club aliases and player English/Korean shorthand while typos remain suggestions only", () => {
    const s = setup();
    s.player.id = "sandro-tonali";
    s.player.name = "산드로 토날리";
    const club = s.state.teams.find((t) => t.id === s.n.sellerId)!;
    club.id = "mancity";
    s.state.finances.find((f) => f.teamId === s.n.sellerId)!.teamId = club.id;
    s.player.teamId = club.id;
    for (const query of [
      "토날리",
      "산드로 토날리",
      "Sandro Tonali",
      "tonali",
      "토날리 에이전트",
      "토날리의 대리인",
    ]) {
      const result = resolveMailRecipientText(s.state, query);
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.contact.recipient).toEqual({ kind: "agent", playerId: s.player.id });
    }
    for (const query of ["맨시티", "Manchester City", "mancity"]) {
      const result = resolveMailRecipientText(s.state, query);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.contact.recipient).toEqual({ kind: "club", teamId: club.id });
    }
    const before = structuredClone(s.state);
    expect(resolveMailRecipientText(s.state, "Sandor Tonali").ok).toBe(false);
    expect(
      searchMailRecipients(s.state, { query: "Sandor Tonali" }).candidates.some(
        (c) => c.recipient.kind === "agent" && c.recipient.playerId === s.player.id,
      ),
    ).toBe(true);
    expect(resolveMailRecipientText(s.state, "zzzz-nonexistent").ok).toBe(false);
    expect(s.state).toEqual(before);
  });
  it("rejects duplicate club names and cross-kind ambiguity instead of silently choosing a recipient", () => {
    const s = setup();
    const clubs = s.state.teams
      .filter((t) => t.id !== s.state.userTeamId && s.state.finances.some((f) => f.teamId === t.id))
      .slice(0, 2);
    expect(clubs).toHaveLength(2);
    clubs.forEach((t) => (t.name = "같은 구단"));
    const duplicate = resolveMailRecipientText(s.state, "같은 구단");
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok)
      expect(duplicate.candidates.filter((c) => c.recipient.kind === "club")).toHaveLength(2);
    clubs[0]!.name = "토날리";
    s.player.name = "토날리";
    const cross = resolveMailRecipientText(s.state, "토날리");
    expect(cross.ok).toBe(false);
    if (!cross.ok)
      expect(new Set(cross.candidates.map((c) => c.recipient.kind))).toEqual(
        new Set(["club", "agent"]),
      );
    if (!duplicate.ok)
      for (const candidate of duplicate.candidates) {
        const picked = resolveMailRecipientText(s.state, mailRecipientHandle(candidate.recipient));
        expect(picked.ok && picked.contact.recipient).toEqual(candidate.recipient);
      }
    expect(resolveMailRecipientText(s.state, `club:${s.state.userTeamId}`).ok).toBe(false);
  });
  it("bounds autocomplete payloads, resolves actual own staff and replays successful delivery before new name lookup", () => {
    const s = setup();
    const person = staffOf(s.state, "coach")[0]!;
    expect(person).toBeDefined();
    const staff = resolveMailRecipientText(s.state, person.name);
    expect(staff.ok).toBe(true);
    if (staff.ok)
      expect(staff.contact.recipient).toEqual({ kind: "staff", personId: person.characterId });
    const found = searchMailRecipients(s.state, { query: s.player.name, limit: 1 });
    expect(found.candidates).toHaveLength(1);
    expect(Object.keys(found.candidates[0]!).sort()).toEqual(
      ["contactId", "description", "label", "recipient"].sort(),
    );
    expect(() => searchMailRecipients(s.state, { query: "abc", limit: 21 })).toThrow(RangeError);
    expect(() => searchMailRecipients(s.state, { query: "" })).toThrow(RangeError);
    const sent = sendMail(s.state, {
      requestId: "named-delivery",
      recipient: { kind: "club", teamId: s.n.sellerId },
      subject: "문의",
      body: "원문",
    });
    expect(sent.ok).toBe(true);
    const before = structuredClone(s.state);
    expect(getMailRequestResult(s.state, "named-delivery")).toMatchObject({
      replayed: true,
      threadId: sent.threadId,
      messageId: sent.messageId,
    });
    expect(getMailRequestResult(s.state, "unknown-request")).toBeNull();
    expect(s.state).toEqual(before);
  });
});

describe("deterministic world market", () => {
  it("reviews at seven days, never mutates the managed club, and repeats a date without duplicate obligations", () => {
    const state = structuredClone(base);
    const managedPlayers = structuredClone(
      state.players.filter((p) => p.teamId === state.userTeamId),
    );
    const managedContracts = structuredClone(
      state.contracts.filter((c) => managedPlayers.some((p) => p.id === c.gamePlayerId)),
    );
    state.marketReview.clubs = state.finances
      .filter((f) => f.teamId !== state.userTeamId)
      .map((f) => ({
        teamId: f.teamId,
        reviewedOn: state.date,
        fingerprint: marketClubFingerprint(state, f.teamId),
      }));
    state.date = addDays(state.date, 6);
    expect(marketReviewCohort(state)).toEqual([]);
    state.date = addDays(state.date, 1);
    expect(marketReviewCohort(state).length).toBeGreaterThan(0);
    processWorldMarket(state);
    const after = structuredClone(state);
    processWorldMarket(state);
    expect(state).toEqual(after);
    expect(state.players.filter((p) => p.teamId === state.userTeamId)).toEqual(managedPlayers);
    expect(
      state.contracts.filter((c) => managedPlayers.some((p) => p.id === c.gamePlayerId)),
    ).toEqual(managedContracts);
  });
  it("only finishes an NPC buyer after recorded seller consent and a clean timed exam, exactly once", () => {
    const s = agreed();
    s.state.userTeamId = s.n.sellerId;
    s.n.proposals.find((p) => p.terms.scope === "club")!.acceptedBy = [s.n.buyerId];
    progressWorldMarketDeals(s.state);
    expect(s.n.medical).toBeNull();
    expect(
      actNegotiation(
        s.state,
        s.n.id,
        { kind: "accept", proposalId: s.n.proposals.find((p) => p.terms.scope === "club")!.id },
        { kind: "user", partyId: s.n.sellerId },
      ).ok,
    ).toBe(true);
    processWorldMarket(s.state);
    expect(s.n.medical?.examinedOn).toBeNull();
    s.state.date = s.terms.since;
    processWorldMarket(s.state);
    expect(s.n.status).toBe("completed");
    expect(s.player.teamId).toBe(s.n.buyerId);
    const balances = s.state.finances.map((f) => f.balance),
      payments = structuredClone(s.state.transferPayments),
      mails = structuredClone(s.state.mailThreads);
    processWorldMarket(s.state);
    expect(s.state.finances.map((f) => f.balance)).toEqual(balances);
    expect(s.state.transferPayments).toEqual(payments);
    expect(s.state.mailThreads).toEqual(mails);
  });
  it("withdraws an NPC acquisition when actual injury appears before examination instead of acknowledging risk", () => {
    const s = agreed();
    s.state.userTeamId = s.n.sellerId;
    processWorldMarket(s.state);
    s.state.injuries.push({
      id: "market-injury",
      gamePlayerId: s.player.id,
      bodyPart: "발목",
      severity: "minor",
      cause: "training",
      occurredOn: s.state.date,
      expectedReturn: addDays(s.state.date, 14),
      returnedOn: null,
    });
    const injuries = structuredClone(s.state.injuries),
      balance = financeOf(s.state, s.n.buyerId).balance;
    s.state.date = s.terms.since;
    processWorldMarket(s.state);
    expect(s.n.status).toBe("withdrawn");
    expect(s.player.teamId).toBe(s.n.sellerId);
    expect(s.n.medical?.acknowledgedBy).toEqual([]);
    expect(s.state.injuries).toEqual(injuries);
    expect(financeOf(s.state, s.n.buyerId).balance).toBe(balance);
  });
  it("rejects attempts to use deterministic automation to renew a managed player", () => {
    const state = structuredClone(base),
      player = state.players.find((p) => p.teamId === state.userTeamId)!;
    const before = structuredClone(state);
    expect(
      applyWorldMarketIntent(state, {
        playerId: player.id,
        buyerId: state.userTeamId,
        kind: "renewal",
        interest: false,
        reason: "automation",
      }),
    ).toBeNull();
    expect(decideWorldManager(state, state.userTeamId)).toBeNull();
    expect(state).toEqual(before);
  });
});

it("manager review waits ninety days and treats fourteen-day injury absences as mitigating evidence", () => {
  const state = structuredClone(base),
    team = state.teams.find((t) => t.id !== state.userTeamId && t.managerName)!;
  team.managerSince = state.date;
  state.date = addDays(state.date, 89);
  const template = state.matches[0]!;
  state.matches = Array.from({ length: 8 }, (_, i) => ({
    ...template,
    id: `board-loss-${i}`,
    season: state.season,
    date: state.date,
    competitionId: "premier",
    homeTeamId: team.id,
    awayTeamId: state.userTeamId,
    result: resultOf({ homeGoals: 0, awayGoals: 1 }),
  }));
  expect(decideWorldManager(state, team.id)).toBeNull();
  state.date = addDays(state.date, 1);
  expect(decideWorldManager(state, team.id)?.action).toBe("dismiss");
  const players = state.players.filter((p) => p.teamId === team.id).slice(0, 4);
  expect(players).toHaveLength(4);
  state.injuries = players.map((p) => ({
    id: `board-injury-${p.id}`,
    gamePlayerId: p.id,
    bodyPart: "발목",
    severity: "moderate",
    cause: "training",
    occurredOn: state.date,
    expectedReturn: addDays(state.date, 14),
    returnedOn: null,
  }));
  expect(decideWorldManager(state, team.id)).toBeNull();
  state.injuries.forEach((i) => (i.expectedReturn = addDays(state.date, 13)));
  expect(decideWorldManager(state, team.id)?.action).toBe("dismiss");
  state.matches.forEach((m) => (m.competitionId = "reserve:premier"));
  expect(decideWorldManager(state, team.id)).toBeNull();
});

it("NPC renewal uses the contract ledger while an unaffordable acquisition leaves no partial case", () => {
  const state = structuredClone(base),
    player = state.players.find(
      (p) => p.teamId !== state.userTeamId && activeContract(state, p.id),
    )!;
  const contract = activeContract(state, player.id)!,
    oldId = contract.id;
  contract.until = addDays(state.date, 100);
  const id = applyWorldMarketIntent(state, {
    playerId: player.id,
    buyerId: player.teamId,
    kind: "renewal",
    interest: false,
    reason: "계약 유지",
  });
  expect(id).not.toBeNull();
  expect(activeContract(state, player.id)?.id).not.toBe(oldId);
  expect(state.negotiations.find((n) => n.id === id)?.status).toBe("completed");
  expect(state.contracts.find((c) => c.id === oldId)?.status).toBe("ended");
  const failed = structuredClone(base),
    buyer = failed.finances.find(
      (f) => f.teamId !== failed.userTeamId && f.teamId !== player.teamId,
    )!;
  buyer.balance = 0;
  const before = structuredClone(failed);
  expect(
    applyWorldMarketIntent(failed, {
      playerId: player.id,
      buyerId: buyer.teamId,
      kind: "transfer",
      interest: false,
      reason: "현금 부족",
    }),
  ).toBeNull();
  expect(failed).toEqual(before);
});

it("withdrawal cooldown runs fourteen days from actual closure rather than original inquiry", () => {
  const state = structuredClone(base),
    player = state.players.find(
      (p) => p.teamId !== state.userTeamId && activeContract(state, p.id),
    )!;
  activeContract(state, player.id)!.until = addDays(state.date, 100);
  const opened = openNegotiation(
    state,
    { playerId: player.id, buyerId: player.teamId, kind: "renewal", background: "계약 검토" },
    "world",
  );
  const n = state.negotiations.find((n) => n.id === opened.negotiationId)!;
  state.date = addDays(state.date, 30);
  expect(
    actNegotiation(
      state,
      n.id,
      { kind: "withdraw", reason: "조건 보류" },
      { kind: "model", partyId: player.teamId },
    ).ok,
  ).toBe(true);
  expect(n.closed).toEqual({ on: state.date, reason: "조건 보류" });
  state.date = addDays(state.date, 13);
  expect(decideWorldMarket(state, player.teamId)?.playerId).not.toBe(player.id);
  state.date = addDays(state.date, 1);
  expect(decideWorldMarket(state, player.teamId)?.playerId).toBe(player.id);
});

/**
 * 감독이 맡긴 협상 (docs/team/transfers.md 「감독이 맡긴 협상」) — 결론일에 시장 공식으로
 * 조건을 정하고, 위임 권한은 서명에 닿지 않는다.
 */
describe("manager mandate", () => {
  const grant = (s: ReturnType<typeof setup>, over: Record<string, number> = {}) =>
    delegateNegotiation(s.state, s.n.id, {
      action: "grant",
      maxFee: s.n.bounds.maxFee,
      maxWeeklyWage: s.n.bounds.maxWeeklyWage,
      minYears: 1,
      maxYears: 5,
      days: 3,
      ...over,
    });
  /** 하루를 넘긴다 — tick이 부르는 순서 그대로(정산 → 위임) */
  const nextDay = (state: GameState) => {
    state.date = addDays(state.date, 1);
    settleNegotiations(state);
    const events: string[] = [];
    progressMandates(state, events);
    return events;
  };

  it("waits for the decision day, agrees on the market formula, clears a clean medical and leaves the signature to the manager", () => {
    const s = setup();
    expect(grant(s).ok).toBe(true);
    expect(nextDay(s.state)).toEqual([]);
    expect(nextDay(s.state)).toEqual([]);
    expect(s.n.proposals).toEqual([]);
    const agreedOn = nextDay(s.state);
    expect(agreedOn).toHaveLength(1);
    expect(s.n.mandate?.stage).toBe("agreed");
    const club = s.n.proposals.find((p) => p.terms.scope === "club")!;
    expect(club.terms.fee).toBe(Math.ceil(s.n.bounds.minFee * 1.25));
    expect(club.acceptedBy).toEqual([s.n.buyerId, s.n.sellerId]);
    expect(s.n.medical?.examinedOn).toBeNull();
    expect(nextDay(s.state)).toHaveLength(1);
    expect(s.n.mandate?.stage).toBe("ready");
    expect(s.n.medical?.acknowledgedBy).toEqual([s.n.buyerId]);
    expect(s.n.status).toBe("open");
    // 합류일은 합의 이틀 뒤 — 메디컬이 끝난 날은 아직 마감일이 아니다
    expect(signatureDeadlinesToday(s.state)).toEqual([]);
    expect(s.action({ kind: "sign" }, { kind: "mandate", partyId: s.n.buyerId }).ok).toBe(false);
    expect(s.action({ kind: "sign" }).ok).toBe(true);
    expect(s.n.status).toBe("signed");
  });

  it("cuts the price at the ceiling and closes as failed, leaving no proposal, when the ceiling is below the seller's floor", () => {
    const capped = setup();
    const ceiling = Math.floor((capped.n.bounds.minFee * 1.25 + capped.n.bounds.minFee) / 2);
    expect(grant(capped, { maxFee: ceiling, days: 1 }).ok).toBe(true);
    nextDay(capped.state);
    expect(capped.n.proposals.find((p) => p.terms.scope === "club")?.terms.fee).toBe(ceiling);

    const short = setup();
    expect(grant(short, { maxFee: Math.floor(short.n.bounds.minFee / 2), days: 1 }).ok).toBe(true);
    const events = nextDay(short.state);
    expect(events).toHaveLength(1);
    expect(short.n.mandate?.stage).toBe("failed");
    expect(short.n.proposals).toEqual([]);
    expect(short.n.medical).toBeNull();
  });

  it("closes a pending mandate when the manager sends terms directly and refuses to revoke a concluded one", () => {
    const s = setup();
    expect(grant(s).ok).toBe(true);
    expect(s.action({ kind: "send", terms: s.terms }).ok).toBe(true);
    expect(s.n.mandate?.stage).toBe("revoked");
    expect(nextDay(s.state)).toEqual([]);
    expect(delegateNegotiation(s.state, s.n.id, { action: "revoke" }).ok).toBe(false);
  });

  it("renews without a medical and stops at the manager's signature", () => {
    const state = structuredClone(base);
    const own = state.players.find(
      (p) => p.teamId === state.userTeamId && activeContract(state, p.id),
    )!;
    const opened = openNegotiation(state, {
      playerId: own.id,
      buyerId: state.userTeamId,
      kind: "renewal",
      background: "재계약",
    });
    const n = state.negotiations.find((n) => n.id === opened.negotiationId)!;
    expect(
      delegateNegotiation(state, n.id, {
        action: "grant",
        maxFee: 999,
        maxWeeklyWage: n.bounds.maxWeeklyWage,
        minYears: 2,
        maxYears: 2,
        days: 1,
      }).ok,
    ).toBe(true);
    expect(n.mandate?.maxFee).toBe(0);
    const granted = state.date;
    // 재계약의 합류일은 합의한 그날이다 — 시계는 그날 서서 감독의 서명을 기다린다
    const advanced = advanceTime(state, { days: 5 });
    expect(advanced.stopped).toBe("attention");
    expect(state.date).toBe(addDays(granted, 1));
    expect(n.mandate?.stage).toBe("ready");
    expect(n.medical).toBeNull();
    expect(n.status).toBe("open");
    expect(signatureDeadlinesToday(state)).toEqual([n]);
    const player = n.proposals.find((p) => p.terms.scope === "player")!;
    expect(player.terms.until).toBe(contractEndForYears(player.terms.since, 2));
    nextDay(state);
    expect(signatureDeadlinesToday(state)).toEqual([]);
  });
});
