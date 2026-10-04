import { currentProposal } from "@story-fm/domain";
import {
  agentForPlayer,
  personaBookOf,
  buildTransferListingView,
  managedTeamId,
  playerName,
  teamNameIn,
  type GameState,
} from "@story-fm/engine";

/** Exact ledgers plus a bounded, visible narrative excerpt; mail prose never grants execution authority. */
export function managedNegotiationOverview(state: GameState) {
  const teamId = managedTeamId(state);
  const transferList = buildTransferListingView(state).transferList;
  return {
    transferList,
    cases: state.negotiations
      .filter((n) => teamId !== null && [n.buyerId, n.sellerId].includes(teamId))
      .sort(
        (a, b) =>
          Number(b.status === "open") - Number(a.status === "open") ||
          b.openedOn.localeCompare(a.openedOn),
      )
      .slice(0, 12)
      .map((n) => {
        const scopes =
          n.sellerId === teamId && n.buyerId !== teamId
            ? (["club"] as const)
            : (["club", "player"] as const);
        const visible = state.mailThreads
          .filter(
            (thread) =>
              thread.ownerTeamId === teamId &&
              (!(n.sellerId === teamId && n.buyerId !== teamId) ||
                thread.recipient.kind === "club"),
          )
          .flatMap((thread) => thread.messages)
          .filter((message) => message.negotiationId === n.id)
          .sort((a, b) => a.on.localeCompare(b.on) || a.at.localeCompare(b.at));
        const last = visible.at(-1);
        const representative = agentForPlayer(state, n.playerId);
        return {
          id: n.id,
          playerId: n.playerId,
          buyerId: n.buyerId,
          sellerId: n.sellerId,
          player: playerName(state, n.playerId),
          playerRepresentative: {
            partyId: n.playerId,
            name: representative?.name ?? "선수 대리인",
            information: representative
              ? personaBookOf(state, representative).information.slice(0, 1500)
              : "",
          },
          kind: n.kind,
          buyer: teamNameIn(state, n.buyerId),
          seller: teamNameIn(state, n.sellerId),
          status: n.status,
          closed: n.closed,
          revision: n.revision,
          currentConditions: scopes.map((scope) => ({
            scope,
            draft: n.drafts.find((draft) => draft.scope === scope) ?? null,
            proposal: currentProposal(n, scope) ?? null,
          })),
          recentClosed: scopes
            .map((scope) => {
              const proposal = [...n.proposals]
                .reverse()
                .find((p) => p.terms.scope === scope && p.status !== "open");
              return proposal
                ? {
                    id: proposal.id,
                    scope,
                    status: proposal.status,
                    reason: proposal.reason.slice(0, 400),
                    terms: proposal.terms,
                  }
                : null;
            })
            .filter((proposal) => proposal !== null),
          narrativeContext: {
            nonbinding: true,
            latestExchange: ["outbound", "inbound"].flatMap((direction) => {
              const message = [...visible].reverse().find((m) => m.direction === direction);
              return message
                ? [
                    {
                      direction: message.direction,
                      on: message.on,
                      subject: message.subject,
                      excerpt: message.body.slice(0, 400),
                    },
                  ]
                : [];
            }),
          },
          lastUpdate: last ? { on: last.on, at: last.at, direction: last.direction } : null,
          medical: n.medical
            ? {
                readyOn: n.medical.readyOn,
                examinedOn: n.medical.examinedOn,
                acknowledgedBy: n.medical.acknowledgedBy,
              }
            : null,
          signed: n.signed,
          registration: n.registration,
        };
      }),
  };
}
