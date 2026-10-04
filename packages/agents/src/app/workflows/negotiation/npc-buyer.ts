import { currentProposal, proposalAgreed } from "@story-fm/domain";
import {
  actNegotiation,
  deliverIncomingMail,
  journal,
  managedTeamId,
  repairNegotiationSquads,
  type GameState,
} from "@story-fm/engine";

/** Economic consent is already in the ledger; only the NPC buyer's procedure advances here. */
export function progressNpcBuyerNegotiations(state: GameState): void {
  const team = managedTeamId(state);
  if (!team || state.phase === "match") return;
  for (const n of state.negotiations.filter((n) => n.sellerId === team && n.buyerId !== team)) {
    const act = (kind: "medical" | "acknowledge_medical" | "sign" | "register") => {
      const result = actNegotiation(state, n.id, { kind }, { kind: "model", partyId: n.buyerId });
      journal({
        kind: "command",
        name: "npc_buyer_procedure",
        input: { negotiationId: n.id, partyId: n.buyerId, action: { kind } },
        ok: result.ok,
        message: result.message,
        source: "tool",
      });
      return result.ok;
    };
    const notifyCompleted = () => {
      if (n.status !== "completed" || !n.signed) return;
      const player = state.players.find((p) => p.id === n.playerId);
      const buyer = state.teams.find((t) => t.id === n.buyerId);
      const result = deliverIncomingMail(state, {
        requestId: `npc-sale-completed:${n.id}:${n.signed.clubProposalId ?? n.signed.playerProposalId}`,
        recipient: { kind: "club", teamId: n.buyerId },
        subject: `${player?.name ?? n.playerId} 이적 완료`,
        body: `${player?.name ?? n.playerId} 선수의 계약 서명과 ${buyer?.name ?? n.buyerId} 합류가 완료되었습니다.`,
        negotiationId: n.id,
        references: {
          playerIds: [n.playerId],
          proposalIds: n.signed.clubProposalId ? [n.signed.clubProposalId] : [],
          reportIds: [],
        },
      });
      if (!result.ok)
        journal({
          kind: "command",
          name: "npc_sale_report",
          input: { negotiationId: n.id },
          ok: false,
          message: result.message,
          source: "tool",
        });
    };
    notifyCompleted();
    if (n.status === "completed" && n.registration !== "registered") {
      if (act("register")) repairNegotiationSquads(state, [n.buyerId]);
      continue;
    }
    if (n.status !== "open") continue;
    const club = currentProposal(n, "club"),
      player = currentProposal(n, "player");
    if (
      !club ||
      !player ||
      club.terms.expiresOn < state.date ||
      player.terms.expiresOn < state.date ||
      !proposalAgreed(n, club) ||
      !proposalAgreed(n, player)
    )
      continue;
    if (!n.medical) {
      act("medical");
      continue;
    }
    if (!n.medical.examinedOn) continue;
    if (!n.medical.acknowledgedBy.includes(n.buyerId)) {
      if (n.medical.injuries.length > 0 || !act("acknowledge_medical")) continue;
    }
    const moves = state.moves.length;
    if (act("sign") && state.moves.length > moves) repairNegotiationSquads(state, [n.sellerId]);
    notifyCompleted();
    if (
      state.negotiations.find((current) => current.id === n.id)?.status === "completed" &&
      act("register")
    )
      repairNegotiationSquads(state, [n.buyerId]);
  }
}
