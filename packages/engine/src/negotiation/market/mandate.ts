import {
  type GamePlayer,
  isMandated,
  type MandateLimit,
  type Negotiation,
  type NegotiationKind,
} from "@story-fm/domain";
import { type CommandResult } from "../../common/commands/result";
import { pickAnyPlayer } from "../../common/core/player-ref";
import { type GameState } from "../../common/core/state";
import { directorOf } from "../../common/people/persona";
import { formatMoney } from "../finance/finance";
import {
  incomingOffer,
  negotiationKindKo,
  openNegotiationFor,
  openTalks,
  pendingOffer,
  standingCounter,
} from "./negotiation";

export function clubDirector(state: GameState) {
  return directorOf(state, state.userTeamId);
}

function isOutgoing(kind: NegotiationKind): boolean {
  return kind === "sell" || kind === "loan_out";
}

export function kindKo(kind: NegotiationKind): string {
  return negotiationKindKo({ kind } as Negotiation);
}

export function limitOf(input: {
  fee?: number;
  weeklyWage?: number;
  years?: number;
}): MandateLimit {
  return {
    ...(input.fee === undefined ? {} : { fee: Math.round(input.fee) }),
    ...(input.weeklyWage === undefined ? {} : { weeklyWage: Math.round(input.weeklyWage) }),
    ...(input.years === undefined ? {} : { contractYears: input.years }),
  };
}

export function openFor(
  state: GameState,
  player: GamePlayer,
  kind: NegotiationKind,
  limit: MandateLimit,
): CommandResult {
  void limit;
  if (kind !== "buy" && kind !== "loan" && kind !== "renew" && kind !== "release")
    return { ok: false, message: "대상 구단과 구체적인 매각 조건을 먼저 지정해야 합니다" };
  const opened = openTalks(state, { playerId: player.id, kind });
  return opened.ok
    ? { ok: true, message: "명시한 한도로 상대 조건을 평가할 문의를 열었습니다" }
    : opened;
}

export function unavailable(
  state: GameState,
  negotiation: Negotiation,
  who: string,
): string | null {
  if (negotiation.buyout) {
    return `${who} 건은 바이아웃 조항이 발동한 매각입니다 — 맡길 것이 없습니다`;
  }
  if (state.pendingNegotiation?.negotiationId === negotiation.id) {
    return `${who} 협상에는 감독이 마주 앉아 있습니다 — 먼저 일어서야 맡길 수 있습니다`;
  }
  return null;
}

export interface DelegateInput {
  playerId?: string;
  kind?: NegotiationKind;
  fee?: number;
  weeklyWage?: number;
  years?: number;
}

export function revokeMandate(
  state: GameState,
  input: { playerId?: string; kind?: NegotiationKind },
): CommandResult {
  if (input.playerId !== undefined) {
    const pick = pickAnyPlayer(state, input.playerId);
    if (!pick.ok) return { ok: false, message: pick.message };
    const player = pick.player;
    const negotiation = openNegotiationFor(state, player.id);
    if (!negotiation || !isMandated(negotiation)) {
      return { ok: false, message: `${player.name} 협상은 지금 단장이 쥔 협상이 아닙니다` };
    }
    negotiation.mandate = null;
    return {
      ok: true,
      message: `${player.name} ${negotiationKindKo(negotiation)} 협상을 도로 가져왔습니다 — 이제 감독의 테이블입니다`,
    };
  }
  const kinds = input.kind ? [input.kind] : state.delegations.map((d) => d.kind);
  if (kinds.length === 0) return { ok: false, message: "단장에게 맡겨 둔 일이 없습니다" };
  state.delegations = state.delegations.filter((d) => !kinds.includes(d.kind));
  // 방침으로 맡겨 둔 협상도 함께 돌아온다 — 방침만 거두면 굴러가던 자리가 남는다
  for (const negotiation of state.negotiations) {
    if (isMandated(negotiation) && kinds.includes(negotiation.kind)) negotiation.mandate = null;
  }
  const label = kinds.length === 1 ? kindKo(kinds[0]!) : "이적·재계약";
  return {
    ok: true,
    message: `${label} 위임을 거뒀습니다 — 진행 중이던 자리도 감독에게 돌아옵니다`,
  };
}

export function standingDemand(
  negotiation: Negotiation,
): { fee: number; weeklyWage: number; contractYears: number } | null {
  const counter = standingCounter(negotiation) ?? incomingOffer(negotiation);
  if (counter) {
    return {
      fee: counter.fee,
      weeklyWage: counter.weeklyWage,
      contractYears: counter.contractYears,
    };
  }
  const personal = negotiation.personal;
  if (personal?.counter && personal.agreedOn === undefined && !pendingOffer(negotiation)) {
    return {
      fee: 0,
      weeklyWage: personal.counter.weeklyWage,
      contractYears: personal.counter.contractYears,
    };
  }
  return null;
}

export function overLimit(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
  demand: { fee: number; weeklyWage: number; contractYears: number },
): string | null {
  void state;
  void player;
  const limit = negotiation.mandate ?? {};
  const kind = negotiation.kind;
  if (isOutgoing(kind)) {
    if (limit.fee === undefined) return "이적료 하한 권한이 없습니다";
    const floor = limit.fee;
    return demand.fee < floor ? `${formatMoney(demand.fee)} — 하한 ${formatMoney(floor)}` : null;
  }
  if (kind !== "renew" && limit.fee === undefined) return "이적료/정산금 한도 권한이 없습니다";
  if (limit.fee !== undefined && kind !== "renew" && demand.fee > limit.fee) {
    return `${formatMoney(demand.fee)} — 상한 ${formatMoney(limit.fee)}`;
  }
  if (kind === "release") return null;
  if (limit.weeklyWage === undefined || limit.contractYears === undefined)
    return "주급과 계약 기간 한도 권한이 없습니다";
  if (limit.weeklyWage !== undefined && demand.weeklyWage > limit.weeklyWage) {
    return `주급 ${formatMoney(demand.weeklyWage)} — 상한 ${formatMoney(limit.weeklyWage)}`;
  }
  if (limit.contractYears !== undefined && demand.contractYears > limit.contractYears) {
    return `${demand.contractYears}년 — 상한 ${limit.contractYears}년`;
  }
  return null;
}

export function statusAfter(negotiation: Negotiation): Negotiation["status"] {
  return negotiation.status;
}
