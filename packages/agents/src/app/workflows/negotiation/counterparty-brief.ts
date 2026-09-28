import {
  type GameState,
  type TableParty,
  tableVoicesOf,
  defaultPartyOf,
  negotiationEvaluationContext,
} from "@story-fm/engine";
import { type Negotiation } from "@story-fm/domain";
export function buildCounterpartyBlock(
  state: GameState,
  n: Negotiation,
  options?: { dossier?: boolean; party?: TableParty },
): string {
  const party = options?.party ?? defaultPartyOf(state, n);
  const context = negotiationEvaluationContext(state, n, party);
  if (!context) return "";
  const { counterparty: _private, ...facts } = context.facts;
  void _private;
  return `<counterparty>${JSON.stringify({ voices: tableVoicesOf(state, n).filter((v) => v.speaker === party), facts })}</counterparty>`;
}
