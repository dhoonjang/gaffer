import { managedTeamId, type GameState } from "../../common/core/state";
import { deliverIncomingMail } from "../../common/mail/mail";
import { reviewBoard } from "./story/world/board";
import { repairNegotiationSquads } from "./negotiation-squad";
import {
  decideWorldManager,
  decideWorldMarket,
  applyWorldMarketIntent,
  progressWorldMarketDeals,
  marketReviewCohort,
  marketClubFingerprint,
  MARKET_DAILY_DEALS,
} from "../../negotiation/world-market";
export interface WorldMarketResult {
  reviewed: number;
  transfers: number;
  renewals: number;
  interests: number;
  appointments: number;
  dismissals: number;
}
export function processWorldMarket(state: GameState): WorldMarketResult {
  const result: WorldMarketResult = {
    reviewed: 0,
    transfers: 0,
    renewals: 0,
    interests: 0,
    appointments: 0,
    dismissals: 0,
  };
  if (state.phase === "match" || state.pendingMatch) return result;
  const changed = progressWorldMarketDeals(state);
  repairNegotiationSquads(state, changed);
  const managed = managedTeamId(state);
  for (const n of state.negotiations.filter(
    (n) => n.sellerId === managed && n.buyerId !== managed && n.status === "completed" && n.signed,
  )) {
    const p = state.players.find((p) => p.id === n.playerId),
      buyer = state.teams.find((t) => t.id === n.buyerId);
    deliverIncomingMail(state, {
      requestId: `npc-sale-completed:${n.id}:${n.signed!.clubProposalId ?? n.signed!.playerProposalId}`,
      recipient: { kind: "club", teamId: n.buyerId },
      subject: `${p?.name ?? n.playerId} 이적 완료`,
      body: `${p?.name ?? n.playerId} 선수의 계약 서명과 ${buyer?.name ?? n.buyerId} 합류가 완료되었습니다.`,
      negotiationId: n.id,
      references: {
        playerIds: [n.playerId],
        proposalIds: n.signed!.clubProposalId ? [n.signed!.clubProposalId] : [],
        reportIds: [],
      },
    });
  }
  if (state.marketReview.lastDate === state.date) return result;
  const cohort = marketReviewCohort(state);
  for (const teamId of cohort) {
    const board = decideWorldManager(state, teamId);
    if (board && reviewBoard(state, board).ok) {
      if (board.action === "appoint") result.appointments++;
      else result.dismissals++;
    }
    if (result.transfers + result.renewals + result.interests < MARKET_DAILY_DEALS) {
      const intent = decideWorldMarket(state, teamId);
      if (intent?.interest) {
        const p = state.players.find((p) => p.id === intent.playerId)!;
        const source = state.contracts.find(
          (c) => c.gamePlayerId === p.id && c.status === "active",
        );
        const incoming = deliverIncomingMail(state, {
          requestId: `npc-interest:${teamId}:${p.id}:${source?.id ?? "free"}`,
          recipient: { kind: "club", teamId },
          subject: `${p.name} 이적 관심`,
          body: `${p.name} 선수의 이적 명단 등재를 확인했습니다. ${intent.reason}에 따라 영입 가능 여부를 문의합니다. 구체적인 조건과 감독님의 의사를 확인한 뒤 논의하겠습니다.`,
          references: { playerIds: [p.id], proposalIds: [], reportIds: [] },
        });
        if (incoming.ok && !incoming.replayed) result.interests++;
      } else if (intent) {
        const id = applyWorldMarketIntent(state, intent);
        if (id) {
          if (intent.kind === "renewal") result.renewals++;
          else result.transfers++;
        }
      }
    }
    const record = {
        teamId,
        reviewedOn: state.date,
        fingerprint: marketClubFingerprint(state, teamId),
      },
      index = state.marketReview.clubs.findIndex((r) => r.teamId === teamId);
    if (index < 0) state.marketReview.clubs.push(record);
    else state.marketReview.clubs[index] = record;
    result.reviewed++;
  }
  state.marketReview.lastDate = state.date;
  return result;
}
