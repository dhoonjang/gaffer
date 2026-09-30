import { tagged } from "../common/orders-ops";
import {
  type GameState,
  roomPartyOf,
  defaultPartyOf,
  negotiationChat,
  describeNegotiation,
} from "@story-fm/engine";
import { type Negotiation } from "@story-fm/domain";

export const TABLE_OPS: readonly string[] = [
  "respond_offer",
  "withdraw_offer",
  "answer_term",
  "offer_terms",
  "send_offer",
  "open_renewal",
  "open_release",
  "propose_personal",
];

const TABLE_LOG_TAIL = 6;

export function buildTableOrdersContext(state: GameState, negotiation: Negotiation): string[] {
  const party = roomPartyOf(state) ?? defaultPartyOf(state, negotiation);
  const log = negotiationChat(state, negotiation, party)
    .slice(-TABLE_LOG_TAIL)
    .map((line) => {
      const who = line.role === "model" ? "@상대" : "@감독";
      return `${line.at} ${who}: ${line.text}`;
    });
  return [
    ...tagged("negotiation", describeNegotiation(state, negotiation.id)),
    ...tagged("table_log", log.join("\n")),
  ];
}

export const BY_NEGOTIATION = new Set([
  "respond_offer",
  "withdraw_offer",
  "answer_term",
  "offer_terms",
  "propose_personal",
]);

export const BY_PLAYER = new Set([
  "send_offer",
  "open_renewal",
  "open_release",
  "propose_personal",
]);
