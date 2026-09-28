import { isFreeAgent } from "./departures";
import {
  TABLE_LINE_MAX,
  isPlayerDeal,
  type Negotiation,
  type NegotiationMethod,
  type NegotiationTable,
  type TableSpeaker,
} from "@story-fm/domain";
import { agentForPlayer, directorOf } from "../../common/people/persona";
import { type GameState, playerById } from "../../common/core/state";
import { type CounterpartyVoice, tableVoicesOf } from "./counterparty";
import { openTalks, type TalksKind } from "./negotiation";

export type TableParty = TableSpeaker;
export interface TableSeat {
  negotiation: Negotiation;
  party: TableParty;
  table: NegotiationTable;
  voices: CounterpartyVoice[];
}
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
      lines: [],
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
export function recordExchangeLine(
  state: GameState,
  exchangeId: string,
  by: "us" | "ledger",
  text: string,
): void {
  const exchange = state.negotiationExchanges.find((e) => e.id === exchangeId);
  const table = state.negotiationContacts.find((t) => t.id === exchange?.contactId);
  if (!exchange || !table || !text.trim()) return;
  table.lines.push({
    date: state.date,
    by,
    text: text.trim().slice(0, TABLE_LINE_MAX),
    negotiationId: exchange.negotiationId,
    exchangeId,
  });
}
export function seatViewOf(
  state: GameState,
  negotiation: Negotiation,
  party: TableParty,
): TableSeat {
  const identity = contactIdentity(state, negotiation, party);
  return {
    negotiation,
    party,
    table: tableOf(state, negotiation, party) ?? {
      id: "",
      counterpartyId: identity?.counterpartyId ?? "",
      representativeId: identity?.representativeId ?? "",
      party,
      openedOn: state.date,
      lines: [],
    },
    voices: tableVoicesOf(state, negotiation).filter((v) => v.speaker === party),
  };
}
export function seatAt(
  state: GameState,
  negotiationId: string,
  party?: TableParty,
): { ok: false; message: string } | { ok: true; seat: TableSeat } {
  const n = state.negotiations.find((n) => n.id === negotiationId);
  if (!n || n.status !== "open") return { ok: false, message: "진행 중인 거래가 필요합니다" };
  const who = party ?? defaultPartyOf(state, n);
  if (!ensureNegotiationContact(state, n, who))
    return { ok: false, message: "이 거래를 대표할 권한이 없는 상대입니다" };
  return { ok: true, seat: seatViewOf(state, n, who) };
}
export function sitAtTable(
  state: GameState,
  negotiationId: string,
  line: string,
  party?: TableParty,
) {
  if (!line.trim()) return { ok: false as const, message: "감독의 원문이 필요합니다" };
  const seated = seatAt(state, negotiationId, party);
  if (!seated.ok) return seated;
  const exchange = ensureNegotiationExchange(
    state,
    seated.seat.negotiation,
    seated.seat.party,
    state.pendingNegotiation?.method ?? "proposal",
  );
  if (exchange) recordExchangeLine(state, exchange.id, "us", line);
  return seated;
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

export function selectNegotiationMethod(state: GameState, method: NegotiationMethod): RoomResult {
  const room = state.pendingNegotiation;
  const exchange = state.negotiationExchanges.find((e) => e.id === room?.exchangeId);
  if (!room || !exchange || room.seated || exchange.closedOn !== null)
    return { ok: false, message: "시작 전 교환만 방식을 바꿀 수 있습니다" };
  room.method = method;
  exchange.method = method;
  return { ok: true, message: `협상 방식: ${method}` };
}
