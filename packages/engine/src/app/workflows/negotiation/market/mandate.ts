import { type Delegation, josaOf, mandateLimitText, type NegotiationKind } from "@story-fm/domain";
import { type CommandResult } from "../../../../common/commands/result";
import { pickAnyPlayer } from "../../../../common/core/player-ref";
import { type GameState } from "../../../../common/core/state";
import {
  clubDirector,
  type DelegateInput,
  kindKo,
  limitOf,
  openFor,
  unavailable,
} from "../../../../negotiation/market/mandate";
import { negotiationKindKo, openNegotiationFor } from "../../../../negotiation/market/negotiation";

export function delegateNegotiation(state: GameState, input: DelegateInput): CommandResult {
  const limit = limitOf(input);
  const director = clubDirector(state);
  if (input.playerId === undefined) {
    const kinds: NegotiationKind[] = input.kind
      ? [input.kind]
      : ["buy", "sell", "renew", "loan", "loan_out", "release"];
    const rest = state.delegations.filter((d) => !kinds.includes(d.kind));
    state.delegations = [
      ...rest,
      ...kinds.map((kind): Delegation => ({ kind, limit, since: state.date })),
    ];
    const label = kinds.length === 1 ? kindKo(kinds[0]!) : "이적·재계약";
    return {
      ok: true,
      message:
        `${label}${josaOf(label, "을/를")} ${director.name} 단장에게 맡겼습니다 — ` +
        `${mandateLimitText(limit, kinds[0]!)}. 앞으로 열리는 자리는 단장이 봅니다`,
    };
  }

  const pick = pickAnyPlayer(state, input.playerId);
  if (!pick.ok) return { ok: false, message: pick.message };
  const player = pick.player;
  const open = openNegotiationFor(state, player.id);
  const negotiation = open && (input.kind === undefined || open.kind === input.kind) ? open : null;
  let opened: string | null = null;
  let target = negotiation;
  if (target) {
    const blocked = unavailable(state, target, player.name);
    if (blocked) return { ok: false, message: blocked };
  } else {
    const kind = input.kind ?? (player.teamId === state.userTeamId ? "renew" : "buy");
    const first = openFor(state, player, kind, limit);
    if (!first.ok) return first;
    opened = first.message;
    target = openNegotiationFor(state, player.id);
    if (!target) return { ok: false, message: `${player.name} 협상이 열리지 않았습니다` };
  }
  target.mandate = limit;
  const lines: string[] = [];
  return {
    ok: true,
    message:
      `${player.name} ${negotiationKindKo(target)} 협상을 ${director.name} 단장에게 맡겼습니다 — ` +
      `${mandateLimitText(limit, target.kind)}.` +
      (opened ? ` ${opened}` : "") +
      (lines.length > 0 ? ` ${lines.join(" ")}` : ""),
  };
}
