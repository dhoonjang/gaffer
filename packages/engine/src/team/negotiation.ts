import { negotiationBounds, acceptanceBoundError } from "./acceptance-bounds";
import {
  NegotiationActionSchema,
  NegotiationRequestSchema,
  OpenNegotiationSchema,
  currentProposal,
  proposalAgreed,
  proposalParties,
  isTransferWindow,
  totalTransferFee,
  SetTransferListingSchema,
  ageOf,
  naturalPositionsOf,
  registrationBlockText,
  type TransferListingView,
  type Negotiation,
  type NegotiationConfirmationPayload,
  type NegotiationAction,
  type NegotiationView,
  type ProposalTerms,
} from "@gaffer/domain";
import {
  activeContract,
  financeOf,
  managedTeamId,
  teamNameIn,
  type GameState,
} from "../core/state";
import { addDays } from "../core/dates";
import { clearDepartedState, FREE_AGENT_TEAM } from "./free-agency";
import { canRegisterFor } from "./registration";
import { recordFinance } from "../core/ledger";
import { reservedTransferPayments, amortizePlayerContract } from "./transfer-accounting";

interface NegotiationResult {
  ok: boolean;
  message: string;
  negotiationId?: string;
  replayed?: boolean;
  status?: number;
}
/**
 * 누가 움직였는가 — `mandate`는 **감독이 맡긴 협상에서 코어가** 우리 구단으로 움직인 것이다.
 * 그 권한은 제안 발송·메디컬 요청·위험 확인뿐이고 서명은 들지 않는다
 * (docs/team/transfers.md 「감독이 맡긴 협상」).
 */
export interface NegotiationActor {
  kind: "user" | "model" | "mandate";
  partyId: string;
}
const MANDATE_ACTIONS: readonly NegotiationAction["kind"][] = [
  "send",
  "medical",
  "acknowledge_medical",
];
const fail = (message: string): NegotiationResult => ({ ok: false, message, status: 400 });
const success = (n: Negotiation, message: string): NegotiationResult => ({
  ok: true,
  message,
  negotiationId: n.id,
});

export function openNegotiation(
  state: GameState,
  raw: unknown,
  mode: "user" | "world" = "user",
): NegotiationResult {
  if (state.phase === "match") return fail("경기 중에는 협상을 변경할 수 없습니다");
  const parsed = OpenNegotiationSchema.safeParse(raw);
  if (!parsed.success) return fail("협상 요청이 올바르지 않습니다");
  const input = parsed.data;
  const player = state.players.find((p) => p.id === input.playerId);
  if (!player || !state.teams.some((t) => t.id === input.buyerId))
    return fail("선수 또는 구단을 찾을 수 없습니다");
  if (!state.finances.some((finance) => finance.teamId === input.buyerId))
    return fail("선수 계약을 체결할 수 있는 영입 구단이 아닙니다");
  if (mode === "user" && ![input.buyerId, player.teamId].includes(managedTeamId(state) ?? ""))
    return fail("맡은 구단의 협상만 열 수 있습니다");
  if (
    input.kind === "renewal"
      ? player.teamId !== input.buyerId
      : input.kind === "free"
        ? player.teamId !== FREE_AGENT_TEAM
        : player.teamId === FREE_AGENT_TEAM || player.teamId === input.buyerId
  )
    return fail("협상 종류와 현재 소속이 일치하지 않습니다");
  const source = activeContract(state, player.id);
  if (input.kind !== "free" && (!source || source.until < state.date))
    return fail("유효한 현재 선수 계약이 없습니다");
  const existing = state.negotiations.find(
    (n) =>
      n.playerId === player.id &&
      n.buyerId === input.buyerId &&
      n.sellerId === player.teamId &&
      n.kind === input.kind &&
      (n.status === "open" || n.status === "signed"),
  );
  if (existing && (existing.status === "signed" || sourceValid(state, existing)))
    return success(existing, "진행 중인 협상이 있습니다");
  if (existing)
    return fail(
      "기존 협상의 현재 계약 또는 소속이 변경되었습니다. 해당 협상을 철회한 뒤 다시 문의하세요",
    );
  const previous = [...state.negotiations]
    .reverse()
    .find(
      (n) =>
        n.playerId === player.id &&
        n.buyerId === input.buyerId &&
        n.sellerId === player.teamId &&
        n.kind === input.kind &&
        (n.status === "withdrawn" || n.status === "completed"),
    );
  if (previous) {
    for (const proposal of previous.proposals)
      if (proposal.status === "open") proposal.status = "superseded";
    previous.status = "open";
    previous.closed = null;
    previous.sourceContractId = source?.id ?? null;
    previous.bounds = negotiationBounds(state, previous);
    previous.background = input.background;
    previous.drafts = [];
    previous.medical = null;
    previous.signed = null;
    previous.registration = "not_submitted";
    previous.mandate = null;
    previous.revision += 1;
    return success(previous, "이전 협상을 이어갑니다");
  }
  const n: Negotiation = {
    id: `neg-${state.date}-${state.negotiations.length + 1}`,
    playerId: player.id,
    buyerId: input.buyerId,
    sellerId: player.teamId,
    kind: input.kind,
    openedOn: state.date,
    background: input.background,
    sourceContractId: activeContract(state, player.id)?.id ?? null,
    bounds: negotiationBounds(state, {
      playerId: player.id,
      buyerId: input.buyerId,
      sellerId: player.teamId,
      kind: input.kind,
    }),
    status: "open",
    closed: null,
    revision: 0,
    proposals: [],
    drafts: [],
    medical: null,
    signed: null,
    registration: "not_submitted",
    mandate: null,
  };
  state.negotiations.push(n);
  return success(n, "협상을 열었습니다");
}
function validateTerms(state: GameState, n: Negotiation, terms: ProposalTerms): string | null {
  if (
    [terms.expiresOn, terms.since, terms.until, ...terms.installments.map((p) => p.date)].some(
      (date) => {
        const parsed = new Date(`${date}T00:00:00Z`);
        return !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date;
      },
    )
  )
    return "실제 달력에 없는 날짜입니다";
  if (terms.expiresOn < state.date || terms.since < state.date || terms.until <= terms.since)
    return "제안 날짜가 올바르지 않습니다";
  if (terms.installments.some((p) => p.date < terms.since))
    return "분할금은 합류일 이후 지급해야 합니다";
  const source = activeContract(state, n.playerId);
  if (source && terms.since > source.until) return "합류일은 현재 계약 만료일까지여야 합니다";
  if (terms.scope === "club" && n.kind !== "transfer") return "구단 간 조건이 필요 없는 협상입니다";
  if (terms.scope === "player" && (terms.fee !== 0 || terms.installments.length > 0))
    return "선수 계약에 구단 간 대금을 넣을 수 없습니다";
  if (
    terms.scope === "club" &&
    (terms.weeklyWage !== 0 || terms.signingBonus !== 0 || terms.promises.length > 0)
  )
    return "구단 제안에는 이적 대금만 넣을 수 있습니다";
  if (
    terms.promises.some((p) => /(?:£|\$|€|%|퍼센트|수당|보너스|분할|이적료|계약금|주급)/u.test(p))
  )
    return "금전 약속은 지원되는 구조화된 조건으로 작성해야 합니다";
  return null;
}
function sourceValid(state: GameState, n: Negotiation): boolean {
  const p = state.players.find((p) => p.id === n.playerId);
  return (
    p?.teamId === n.sellerId &&
    (activeContract(state, n.playerId)?.id ?? null) === n.sourceContractId
  );
}
export function actNegotiation(
  state: GameState,
  id: string,
  raw: unknown,
  actor: NegotiationActor,
): NegotiationResult {
  const parsed = NegotiationActionSchema.safeParse(raw);
  const n = state.negotiations.find((n) => n.id === id);
  if (!parsed.success || !n) return fail("협상 또는 요청을 찾을 수 없습니다");
  const a: NegotiationAction = parsed.data;
  if (state.phase === "match") return fail("경기 중에는 협상을 변경할 수 없습니다");
  const managed = managedTeamId(state);
  if (![n.buyerId, n.sellerId, n.playerId].includes(actor.partyId))
    return fail("협상 당사자가 아닙니다");
  if (actor.kind === "user" && actor.partyId !== managed)
    return fail("맡은 구단만 조작할 수 있습니다");
  if (actor.kind === "model" && actor.partyId === managed && a.kind !== "draft")
    return fail("모델은 유저 구단의 동의나 서명을 대신할 수 없습니다");
  if (
    actor.kind === "mandate" &&
    (actor.partyId !== managed ||
      !MANDATE_ACTIONS.includes(a.kind) ||
      (n.mandate?.stage !== "pending" && n.mandate?.stage !== "agreed"))
  )
    return fail("감독이 맡긴 범위 밖의 조작입니다");
  if (a.kind === "register") {
    if (n.status !== "completed" || actor.partyId !== n.buyerId)
      return fail("합류한 선수를 영입 구단이 등록해야 합니다");
    const p = state.players.find((p) => p.id === n.playerId);
    if (n.registration === "registered") return success(n, "이미 등록한 선수입니다");
    if (!p || p.teamId !== n.buyerId) return fail("현재 소속이 변경되었습니다");
    if (n.kind === "transfer" && !isTransferWindow(state.date)) return fail("등록 기간이 아닙니다");
    const allowed = canRegisterFor(state, p, n.buyerId);
    if (!allowed.ok) return fail(`선수단 등록 제한: ${registrationBlockText(allowed.block)}`);
    n.registration = "registered";
    const contract = activeContract(state, p.id);
    if (contract) contract.registrationStatus = "registered";
    p.squadLevel = "first";
    n.revision += 1;
    return success(n, "등록 완료");
  }
  if (n.status !== "open") return fail("진행 중인 협상이 아닙니다");
  if (a.kind !== "withdraw" && !sourceValid(state, n))
    return fail("현재 계약 또는 소속이 변경되었습니다");
  switch (a.kind) {
    case "draft":
    case "send": {
      const invalid = validateTerms(state, n, a.terms);
      if (invalid) return fail(invalid);
      if (!proposalParties(n, a.terms.scope).includes(actor.partyId))
        return fail("이 조건의 당사자가 아닙니다");
      if (a.kind === "send" && actor.kind !== "user") {
        const error = acceptanceBoundError(state, n, a.terms, actor.partyId);
        if (error) return fail(error);
      }
      if (a.kind === "draft")
        n.drafts = [...n.drafts.filter((t) => t.scope !== a.terms.scope), a.terms];
      else {
        for (const p of n.proposals)
          if (p.terms.scope === a.terms.scope && p.status === "open") p.status = "superseded";
        n.proposals.push({
          id: `${n.id}-p${n.proposals.length + 1}`,
          author: actor.partyId,
          sentOn: state.date,
          terms: structuredClone(a.terms),
          acceptedBy: [actor.partyId],
          status: "open",
          reason: "",
        });
        n.drafts = n.drafts.filter((t) => t.scope !== a.terms.scope);
      }
      break;
    }
    case "accept":
    case "reject": {
      const p = n.proposals.find((p) => p.id === a.proposalId);
      if (
        !p ||
        p.status !== "open" ||
        p.terms.expiresOn < state.date ||
        !proposalParties(n, p.terms.scope).includes(actor.partyId)
      )
        return fail("동의할 수 있는 유효한 제안이 아닙니다");
      if (a.kind === "accept" && actor.kind === "model") {
        const error = acceptanceBoundError(state, n, p.terms, actor.partyId);
        if (error) return fail(error);
      }
      if (a.kind === "reject") {
        p.status = "rejected";
        p.reason = a.reason;
      } else if (!p.acceptedBy.includes(actor.partyId)) p.acceptedBy.push(actor.partyId);
      break;
    }
    case "medical": {
      const player = currentProposal(n, "player"),
        club = currentProposal(n, "club");
      if (
        actor.partyId !== n.buyerId ||
        n.kind === "renewal" ||
        !proposalAgreed(n, player) ||
        !player ||
        player.terms.expiresOn < state.date ||
        (n.kind === "transfer" &&
          (!proposalAgreed(n, club) || !club || club.terms.expiresOn < state.date))
      )
        return fail("양측 합의 후 영입 구단이 검사할 수 있습니다");
      if (n.medical && n.medical.examinedOn === null) return fail("검사가 진행 중입니다");
      n.medical = {
        requestedOn: state.date,
        readyOn: addDays(state.date, 1),
        examinedOn: null,
        injuries: [],
        acknowledgedBy: [],
      };
      break;
    }
    case "acknowledge_medical":
      if (actor.partyId !== n.buyerId || !n.medical?.examinedOn)
        return fail("완료된 검사 결과가 없습니다");
      if (!n.medical.acknowledgedBy.includes(actor.partyId))
        n.medical.acknowledgedBy.push(actor.partyId);
      break;
    case "sign": {
      if (actor.partyId !== n.buyerId) return fail("영입 구단이 서명해야 합니다");
      const player = currentProposal(n, "player"),
        club = currentProposal(n, "club");
      if (
        !proposalAgreed(n, player) ||
        !player ||
        player.terms.expiresOn < state.date ||
        (n.kind === "transfer" &&
          (!proposalAgreed(n, club) || !club || club.terms.expiresOn < state.date))
      )
        return fail("유효한 모든 당사자의 동의가 필요합니다");
      if (player.terms.since < state.date) return fail("합류일이 지났습니다. 새 제안이 필요합니다");
      if (club && club.terms.since !== player.terms.since)
        return fail("구단과 선수 합류일이 다릅니다");
      if (
        n.kind !== "renewal" &&
        (!n.medical?.examinedOn || !n.medical.acknowledgedBy.includes(n.buyerId))
      )
        return fail("메디컬 완료와 위험 확인이 필요합니다");
      if (
        n.kind !== "renewal" &&
        JSON.stringify(n.medical?.injuries) !==
          JSON.stringify(
            state.injuries.filter((i) => i.gamePlayerId === n.playerId && i.returnedOn === null),
          )
      )
        return fail("건강 상태가 변경되었습니다. 다시 검사하세요");
      if (
        state.negotiations.some(
          (other) =>
            other.id !== n.id && other.playerId === n.playerId && other.status === "signed",
        )
      )
        return fail("이미 서명한 다른 계약이 있습니다");
      for (const proposal of [player, ...(club ? [club] : [])])
        for (const party of proposalParties(n, proposal.terms.scope)) {
          if (party === managedTeamId(state)) continue;
          const error = acceptanceBoundError(state, n, proposal.terms, party);
          if (error) return fail(error);
        }
      const fee = club ? totalTransferFee(club.terms) : 0;
      const reserved = reservedTransferPayments(state, n.buyerId);
      if (financeOf(state, n.buyerId).balance < fee + player.terms.signingBonus + reserved)
        return fail("미래 지급 의무를 포함한 자금이 부족합니다");
      n.signed = { on: state.date, playerProposalId: player.id, clubProposalId: club?.id ?? null };
      n.status = "signed";
      const payments = [
        ...(club
          ? [{ date: player.terms.since, amount: club.terms.fee }, ...club.terms.installments].map(
              (p) => ({ ...p, kind: "fee" as const, toTeamId: n.sellerId }),
            )
          : []),
        {
          date: player.terms.since,
          amount: player.terms.signingBonus,
          kind: "signing_bonus" as const,
          toTeamId: null,
        },
      ];
      payments.forEach((p, i) => {
        if (p.amount > 0)
          state.transferPayments.push({
            id: `${player.id}-pay${i}`,
            negotiationId: n.id,
            playerId: n.playerId,
            fromTeamId: n.buyerId,
            toTeamId: p.toTeamId,
            dueOn: p.date,
            amount: p.amount,
            paidOn: null,
            kind: p.kind,
          });
      });
      settleNegotiations(state);
      break;
    }
    case "withdraw":
      n.status = "withdrawn";
      n.closed = { on: state.date, reason: a.reason };
      break;
  }
  // 감독이 직접 우리 조건을 내거나 협상을 거두면 맡겨 둔 위임은 그 자리에서 닫힌다
  if (
    actor.kind === "user" &&
    n.mandate?.stage === "pending" &&
    (a.kind === "send" || a.kind === "withdraw")
  )
    n.mandate = {
      ...n.mandate,
      stage: "revoked",
      updatedOn: state.date,
      reason: "감독이 직접 협상을 이어 갔다",
    };
  if (state.players.some((p) => p.id === n.playerId)) {
    const bounds = negotiationBounds(state, n);
    if (bounds.fingerprint !== n.bounds.fingerprint) n.bounds = bounds;
  }
  n.revision += 1;
  return success(n, "협상 요청을 처리했습니다");
}
export function applyNegotiationRequest(state: GameState, raw: unknown): NegotiationResult {
  const parsed = NegotiationRequestSchema.safeParse(raw);
  if (!parsed.success) return fail("요청이 올바르지 않습니다");
  const r = parsed.data;
  if (state.negotiationRequests.includes(r.requestId))
    return {
      ok: true,
      replayed: true,
      message: "이미 처리한 요청입니다",
      negotiationId: r.negotiationId,
    };
  const team = managedTeamId(state);
  if (!team) return fail("현재 맡은 구단이 없습니다");
  const n = state.negotiations.find((n) => n.id === r.negotiationId);
  if (!n || n.revision !== r.revision)
    return {
      ok: false,
      status: 409,
      message: "협상이 변경되었습니다. 최신 상태에서 다시 요청하세요",
    };
  const result = actNegotiation(state, n.id, r.action, { kind: "user", partyId: team });
  if (result.ok) state.negotiationRequests.push(r.requestId);
  return result;
}
export function settleNegotiations(state: GameState): void {
  for (const n of state.negotiations) {
    if (n.status === "open") {
      for (const p of n.proposals)
        if (p.status === "open" && p.terms.expiresOn < state.date) {
          p.status = "expired";
          n.revision += 1;
        }
      if (n.medical && !n.medical.examinedOn && n.medical.readyOn <= state.date) {
        n.medical.examinedOn = state.date;
        n.medical.injuries = structuredClone(
          state.injuries.filter((i) => i.gamePlayerId === n.playerId && i.returnedOn === null),
        );
        n.revision += 1;
      }
    }
    if (n.status !== "signed" || !n.signed) continue;
    const proposal = n.proposals.find((p) => p.id === n.signed?.playerProposalId);
    const player = state.players.find((p) => p.id === n.playerId);
    if (!proposal || !player || proposal.terms.since > state.date) continue;
    if (!sourceValid(state, n)) continue;
    const old = activeContract(state, player.id);
    if (old) amortizePlayerContract(state, old);
    const club = n.proposals.find((p) => p.id === n.signed?.clubProposalId);
    const fee = club ? totalTransferFee(club.terms) : 0;
    if (n.kind === "transfer") {
      const carrying = old?.acquisition ? old.acquisition.cost - old.acquisition.amortized : 0;
      recordFinance(state, n.sellerId, {
        kind: fee >= carrying ? "income" : "expense",
        category: fee >= carrying ? "transfer_gain" : "transfer_loss",
        amount: Math.abs(fee - carrying),
        label: `선수 매각 ${n.id}`,
        accounting: "noncash",
        ref: { type: "player", id: player.id },
      });
    }
    if (old) old.status = "ended";
    if (n.kind !== "renewal") {
      clearDepartedState(state, player, player.teamId);
      const from = player.teamId;
      player.teamId = n.buyerId;
      player.squadNumber = undefined;
      player.squadLevel = "reserve";
      state.moves.push({
        id: `${proposal.id}-move`,
        gamePlayerId: player.id,
        fromTeamId: from,
        toTeamId: n.buyerId,
        date: state.date,
        kind: n.kind,
      });
    }
    state.contracts.push({
      id: `${proposal.id}-contract`,
      gamePlayerId: player.id,
      teamId: n.buyerId,
      weeklyWage: proposal.terms.weeklyWage,
      since: proposal.terms.since,
      until: proposal.terms.until,
      status: "active",
      registrationStatus:
        n.kind === "renewal" ? (old?.registrationStatus ?? "registered") : "pending",
      acquisition: {
        cost:
          fee +
          proposal.terms.signingBonus +
          (n.kind === "renewal" && old?.acquisition
            ? old.acquisition.cost - old.acquisition.amortized
            : 0),
        amortized: 0,
        lastAmortizedOn: proposal.terms.since,
      },
    });
    n.status = "completed";
    n.registration = n.kind === "renewal" ? (old?.registrationStatus ?? "registered") : "pending";
    n.revision += 1;
  }
  for (const n of state.negotiations) {
    if (n.status === "open" && !sourceValid(state, n)) {
      n.status = "withdrawn";
      n.closed = { on: state.date, reason: "선수의 현재 계약 또는 소속이 변경되었습니다" };
      n.revision += 1;
    }
  }
  for (const contract of state.contracts)
    if (contract.status === "active") amortizePlayerContract(state, contract);
  for (const p of state.transferPayments) {
    if (p.paidOn || p.dueOn > state.date) continue;
    recordFinance(state, p.fromTeamId, {
      kind: "expense",
      category: p.kind === "fee" ? "transfer_fee" : "signing_bonus",
      amount: p.amount,
      label: `협상 ${p.negotiationId}`,
      ref: { type: "player", id: p.playerId },
    });
    if (p.toTeamId)
      recordFinance(state, p.toTeamId, {
        kind: "income",
        category: "transfer_income",
        amount: p.amount,
        label: `협상 ${p.negotiationId}`,
        ref: { type: "player", id: p.playerId },
      });
    p.paidOn = state.date;
  }
}
function publicNegotiation(n: Negotiation) {
  const { bounds: _bounds, ...visible } = structuredClone(n);
  void _bounds;
  return visible;
}
export function buildNegotiationConfirmation(
  state: GameState,
  id: string,
  stage: NegotiationConfirmationPayload["stage"],
): NegotiationConfirmationPayload | null {
  const n = state.negotiations.find((n) => n.id === id),
    team = managedTeamId(state);
  if (!n || n.status !== "open" || !team || !isNegotiationParty(n, team) || !sourceValid(state, n))
    return null;
  const player = currentProposal(n, "player"),
    club = currentProposal(n, "club");
  const visiblePlayer = n.buyerId === team ? player : undefined;
  const proposals = [...(visiblePlayer ? [visiblePlayer] : []), ...(club ? [club] : [])];
  if (!proposals.length || proposals.some((p) => p.terms.expiresOn < state.date)) return null;
  if (
    stage !== "agreement" &&
    (team !== n.buyerId ||
      !proposalAgreed(n, player) ||
      (n.kind === "transfer" && !proposalAgreed(n, club)))
  )
    return null;
  if (stage === "medical" && !n.medical?.examinedOn) return null;
  if (
    stage === "sign" &&
    n.kind !== "renewal" &&
    (!n.medical?.examinedOn || !n.medical.acknowledgedBy.includes(team))
  )
    return null;
  return {
    kind: "negotiation-confirmation",
    negotiationId: id,
    revision: n.revision,
    stage,
    playerProposalId: visiblePlayer?.id ?? null,
    clubProposalId: club?.id ?? null,
  };
}
/**
 * **오늘이 서명할 수 있는 마지막 날인 계약** — 감독 구단이 영입 구단이고 모든 당사자가
 * 합의했으며 메디컬 결과가 나와 확인 카드만 남은 협상 가운데, 합류일이나 제안 기한이
 * 오늘인 것. 내일이 되면 `sign`이 거부하므로 날짜 진행은 이 날에 멈춘다.
 */
export function signatureDeadlinesToday(state: GameState): Negotiation[] {
  const team = managedTeamId(state);
  if (!team) return [];
  return state.negotiations.filter((n) => {
    if (n.buyerId !== team || n.status !== "open" || !sourceValid(state, n)) return false;
    const player = currentProposal(n, "player"),
      club = currentProposal(n, "club");
    if (!player || !proposalAgreed(n, player)) return false;
    if (n.kind === "transfer" && (!club || !proposalAgreed(n, club))) return false;
    if (n.kind !== "renewal" && !n.medical?.examinedOn) return false;
    const last = [player, ...(club ? [club] : [])]
      .flatMap((p) => [p.terms.since, p.terms.expiresOn])
      .sort()[0];
    return last === state.date;
  });
}
/** 이 구단이 그 협상의 당사자(영입 구단 또는 매도 구단)인가 */
export function isNegotiationParty(n: Negotiation, teamId: string): boolean {
  return n.buyerId === teamId || n.sellerId === teamId;
}

/**
 * 이 구단이 그 제안을 볼 수 있는가 — 당사자여야 하고, 영입 구단이 아니면 구단 간
 * 조건(`scope: "club"`)만 보인다. 선수와의 개인 조건은 영입 구단의 것이다.
 */
export function proposalVisibleTo(
  n: Negotiation,
  proposal: Negotiation["proposals"][number],
  teamId: string,
): boolean {
  return isNegotiationParty(n, teamId) && (n.buyerId === teamId || proposal.terms.scope === "club");
}

export function buildNegotiationView(state: GameState): NegotiationView {
  const teamId = managedTeamId(state);
  const cases = state.negotiations.filter((n) => teamId !== null && isNegotiationParty(n, teamId));
  return {
    teamId,
    date: state.date,
    cases: cases.map((n) => ({
      ...publicNegotiation(n),
      ...(n.sellerId === teamId && n.buyerId !== teamId
        ? {
            proposals: structuredClone(n.proposals.filter((p) => proposalVisibleTo(n, p, teamId))),
            drafts: structuredClone(n.drafts.filter((t) => t.scope === "club")),
            medical: null,
            background: "",
          }
        : {}),
      playerName: state.players.find((p) => p.id === n.playerId)?.name ?? n.playerId,
      buyerName: teamNameIn(state, n.buyerId),
      sellerName: teamNameIn(state, n.sellerId),
    })),
    payments: state.transferPayments.filter(
      (p) => p.fromTeamId === teamId || p.toTeamId === teamId,
    ),
  };
}
export function setTransferListing(state: GameState, raw: unknown): NegotiationResult {
  const parsed = SetTransferListingSchema.safeParse(raw);
  if (!parsed.success) return fail("이적 명단 요청이 올바르지 않습니다");
  const teamId = managedTeamId(state);
  if (!teamId) return fail("현재 맡은 구단이 없습니다");
  if (state.phase === "match") return fail("경기 중에는 이적 명단을 변경할 수 없습니다");
  const input = parsed.data;
  const player = state.players.find((p) => p.id === input.playerId);
  if (!player || player.teamId !== teamId)
    return fail("우리 구단의 선수만 이적 명단에 올리거나 내릴 수 있습니다");
  const listing = state.transferListings.find((l) => l.gamePlayerId === player.id);
  if (!input.listed) {
    if (listing)
      state.transferListings = state.transferListings.filter((l) => l.gamePlayerId !== player.id);
    return {
      ok: true,
      message: listing ? "이적 명단에서 해제했습니다" : "이미 이적 명단에 없는 선수입니다",
    };
  }
  if (listing) {
    if (input.askingPrice !== undefined) listing.askingPrice = input.askingPrice;
    if (input.note !== undefined) listing.note = input.note;
  } else
    state.transferListings.push({
      gamePlayerId: player.id,
      listedOn: state.date,
      ...(input.askingPrice === undefined ? {} : { askingPrice: input.askingPrice }),
      ...(input.note === undefined ? {} : { note: input.note }),
    });
  return { ok: true, message: listing ? "이적 명단을 확인했습니다" : "이적 명단에 올렸습니다" };
}
export function buildTransferListingView(state: GameState): TransferListingView {
  const teamId = managedTeamId(state);
  const players = new Map(state.players.filter((p) => p.teamId === teamId).map((p) => [p.id, p]));
  return {
    teamId,
    date: state.date,
    transferList: state.transferListings
      .flatMap((listing) => {
        const player = players.get(listing.gamePlayerId);
        if (!player) return [];
        return [
          {
            playerId: player.id,
            name: player.name,
            age: ageOf(player.birthdate, state.date),
            positions: naturalPositionsOf(player).map((p) => p.position),
            listedOn: listing.listedOn,
            ...(listing.askingPrice === undefined ? {} : { askingPrice: listing.askingPrice }),
            ...(listing.note === undefined ? {} : { note: listing.note }),
            negotiationIds: state.negotiations
              .filter(
                (n) =>
                  n.playerId === player.id &&
                  n.sellerId === teamId &&
                  n.buyerId !== teamId &&
                  (n.status === "open" || n.status === "signed"),
              )
              .map((n) => n.id),
          },
        ];
      })
      .sort((a, b) =>
        a.listedOn < b.listedOn
          ? -1
          : a.listedOn > b.listedOn
            ? 1
            : a.playerId < b.playerId
              ? -1
              : a.playerId > b.playerId
                ? 1
                : 0,
      ),
  };
}
