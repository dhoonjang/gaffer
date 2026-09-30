import { isFreeAgent } from "./departures";
import {
  isPlayerDeal,
  type Negotiation,
  type NegotiationMethod,
  type NegotiationTable,
  type TableSpeaker,
} from "@story-fm/domain";
import { agentForPlayer, directorOf } from "../../common/people/persona";
import { type GameState, playerById } from "../../common/core/state";
import { openTalks, type TalksKind } from "./negotiation";

export type TableParty = TableSpeaker;
export interface RoomResult {
  ok: boolean;
  message: string;
}

export function partiesOf(_state: GameState, negotiation: Negotiation): TableParty[] {
  const player = playerById(_state, negotiation.gamePlayerId);
  if (
    isPlayerDeal(negotiation.kind) ||
    negotiation.precontract ||
    (player !== null && isFreeAgent(player))
  )
    return ["agent"];
  return negotiation.kind === "sell" || negotiation.kind === "loan_out"
    ? ["club"]
    : ["club", "agent"];
}
export function defaultPartyOf(state: GameState, negotiation: Negotiation): TableParty {
  return partiesOf(state, negotiation)[0]!;
}

export function contactIdentity(state: GameState, negotiation: Negotiation, party: TableParty) {
  if (party === "club") {
    const teamId = negotiation.counterpartTeamId;
    if (!teamId || !state.teams.some((t) => t.id === teamId)) return null;
    const director = directorOf(state, teamId);
    return { counterpartyId: `club:${teamId}`, representativeId: director.characterId };
  }
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return null;
  const agent = agentForPlayer(state, player.id);
  return {
    counterpartyId: agent ? `agent:${agent.characterId}` : `player:${player.id}`,
    representativeId: agent?.characterId ?? player.id,
  };
}

export function tableOf(
  state: GameState,
  negotiation: Negotiation,
  party: TableParty,
): NegotiationTable | undefined {
  const id = negotiation.tables?.[party];
  return state.negotiationContacts.find((t) => t.id === id);
}
export function ensureNegotiationContact(
  state: GameState,
  negotiation: Negotiation,
  party: TableParty,
): NegotiationTable | null {
  if (!partiesOf(state, negotiation).includes(party)) return null;
  const delegation = state.delegations.find((d) => d.kind === negotiation.kind);
  if (negotiation.mandate === undefined && delegation) negotiation.mandate = delegation.limit ?? {};
  const identity = contactIdentity(state, negotiation, party);
  if (!identity) return null;
  let table = state.negotiationContacts.find(
    (t) =>
      t.counterpartyId === identity.counterpartyId &&
      t.representativeId === identity.representativeId &&
      t.party === party,
  );
  if (!table) {
    table = {
      id: `contact-${state.negotiationContacts.length + 1}`,
      ...identity,
      party,
      openedOn: state.date,
    };
    state.negotiationContacts.push(table);
  }
  negotiation.tables = { ...negotiation.tables, [party]: table.id };
  return table;
}
export function ensureNegotiationExchange(
  state: GameState,
  negotiation: Negotiation,
  party: TableParty,
  method: NegotiationMethod = "proposal",
) {
  const table = ensureNegotiationContact(state, negotiation, party);
  if (!table) return null;
  const current =
    state.pendingNegotiation?.negotiationId === negotiation.id &&
    state.pendingNegotiation.party === party
      ? state.negotiationExchanges.find(
          (e) => e.id === state.pendingNegotiation!.exchangeId && e.closedOn === null,
        )
      : undefined;
  if (current) return current;
  const reusable = [...state.negotiationExchanges]
    .reverse()
    .find(
      (e) =>
        e.contactId === table.id &&
        e.negotiationId === negotiation.id &&
        e.party === party &&
        e.closedOn === null,
    );
  if (reusable) {
    reusable.method = method;
    return reusable;
  }
  const exchange = {
    id: `exchange-${state.negotiationExchanges.length + 1}`,
    contactId: table.id,
    negotiationId: negotiation.id,
    party,
    method,
    openedOn: state.date,
    closedOn: null,
    summary: "",
    evaluationId: null,
  };
  state.negotiationExchanges.push(exchange);
  return exchange;
}
/** Conversation text lives only in chat, shared across deals with this counterparty. */
export function negotiationChat(state: GameState, negotiation: Negotiation, party: TableParty) {
  const contact = tableOf(state, negotiation, party);
  return contact ? state.chat.filter((turn) => turn.negotiationContactId === contact.id) : [];
}

/** Link the current chat input; never create a second transcript of the same words. */
export function linkNegotiationChat(state: GameState, exchangeId: string): void {
  const exchange = state.negotiationExchanges.find((e) => e.id === exchangeId);
  const turn = state.chat.at(-1);
  if (!exchange || !turn || turn.role === "model") return;
  if (turn.negotiationContactId && turn.negotiationContactId !== exchange.contactId) return;
  turn.negotiationContactId = exchange.contactId;
  turn.negotiationExchangeId = exchange.id;
  turn.negotiationId = exchange.negotiationId;
}
export function startNegotiation(
  state: GameState,
  input: {
    negotiationId?: string;
    playerId?: string;
    kind?: TalksKind;
    party?: TableParty;
    method?: NegotiationMethod;
    counterpartTeamId?: string;
    mode?: "continue" | "request";
  },
): RoomResult & { negotiationId?: string; exchangeId?: string; contactId?: string } {
  if (state.phase === "match")
    return { ok: false, message: "경기 중 연락은 보관하고 경기 뒤 이어갑니다" };
  if (state.pendingNegotiation) return { ok: false, message: "현재 교환을 먼저 마쳐야 합니다" };
  let n = state.negotiations.find((n) => n.id === input.negotiationId);
  if (!n && input.playerId) {
    const opened = openTalks(state, {
      playerId: input.playerId,
      kind: input.kind,
      counterpartTeamId: input.counterpartTeamId,
    });
    if (!opened.ok) return opened;
    n = opened.negotiation;
  }
  if (!n || !["open", "agreed"].includes(n.status))
    return { ok: false, message: "이어갈 거래를 찾지 못했습니다" };
  const party = input.party ?? defaultPartyOf(state, n);
  const exchange = ensureNegotiationExchange(state, n, party, input.method ?? "meeting");
  if (!exchange) return { ok: false, message: "거래 대상과 대표 권한을 확인해야 합니다" };
  state.pendingNegotiation = {
    negotiationId: n.id,
    exchangeId: exchange.id,
    method: exchange.method,
    seated: input.mode === "request",
    party,
    openedOn: state.date,
    phaseBefore: state.phase === "matchday" ? "matchday" : "idle",
  };
  state.phase = "negotiation";
  return {
    ok: true,
    negotiationId: n.id,
    exchangeId: exchange.id,
    contactId: exchange.contactId,
    message: `${playerById(state, n.gamePlayerId)?.name ?? n.gamePlayerId} 협상 이어가기 (${exchange.method})`,
  };
}
export function markSeated(state: GameState): void {
  if (state.pendingNegotiation) state.pendingNegotiation.seated = true;
}
export function roomNegotiationOf(state: GameState): Negotiation | null {
  return state.phase === "negotiation"
    ? (state.negotiations.find((n) => n.id === state.pendingNegotiation?.negotiationId) ?? null)
    : null;
}
export function roomPartyOf(state: GameState): TableParty | null {
  return state.pendingNegotiation?.party ?? null;
}
export function closeNegotiation(
  state: GameState,
  reason: "left" | "closed" = "closed",
): RoomResult {
  const room = state.pendingNegotiation;
  if (!room) return { ok: false, message: "마칠 교환이 없습니다" };
  const exchange = state.negotiationExchanges.find((e) => e.id === room.exchangeId);
  const n = state.negotiations.find((n) => n.id === room.negotiationId);
  if (exchange && exchange.closedOn === null) {
    exchange.closedOn = state.date;
    exchange.summary = `${n?.kind ?? "거래"} · ${n?.status ?? "미확인"} · ${state.negotiationEvaluations.some((e) => e.exchangeId === exchange.id && e.status === "pending") ? "평가 처리 대기" : "기록에 따라 다음 연락을 이어간다"}`;
  }
  state.phase = room.phaseBefore;
  state.pendingNegotiation = null;
  return {
    ok: true,
    message: `${reason === "left" ? "일상으로 돌아갑니다" : "이번 교환을 마쳤습니다"} — ${exchange?.summary ?? "기록 보존"}`,
  };
}
