import type { Negotiation } from "@gaffer/domain";
import { agentForPlayer, directorOf, personaBookOf, type GameState } from "@gaffer/engine";

export function negotiationCounterparts(state: GameState, n: Negotiation) {
  return [
    directorOf(state, n.buyerId),
    ...(n.kind === "transfer" ? [directorOf(state, n.sellerId)] : []),
    agentForPlayer(state, n.playerId),
    ...state.personas.filter(
      (p) => p.role === "owner" && [n.buyerId, n.sellerId].includes(state.userTeamId),
    ),
  ]
    .filter((p) => p !== null)
    .map((p) => ({
      id: "lorebookId" in p ? p.lorebookId : `person:${p.characterId}`,
      name: p.name,
      role: p.role,
      information: personaBookOf(state, p).information,
    }));
}
