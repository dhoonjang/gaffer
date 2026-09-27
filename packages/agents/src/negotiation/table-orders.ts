import { type OpsOrders, tagged } from "../common/orders-ops";
import {
  type GameState,
  roomPartyOf,
  defaultPartyOf,
  tableOf,
  describeNegotiation,
} from "@story-fm/engine";
import { type Negotiation } from "@story-fm/domain";

export const TABLE_OPS: readonly string[] = [
  "respond_offer",
  "accept_deal",
  "withdraw_offer",
  "answer_term",
  "offer_terms",
  "send_offer",
  "open_renewal",
  "propose_personal",
];

export type TableOrders = OpsOrders;

const TABLE_LOG_TAIL = 6;

export function buildTableOrdersContext(state: GameState, negotiation: Negotiation): string[] {
  const party = roomPartyOf(state) ?? defaultPartyOf(state, negotiation);
  const log = (tableOf(negotiation, party)?.lines ?? []).slice(-TABLE_LOG_TAIL).map((line) => {
    const who = line.by === "us" ? "@감독" : "[장부]";
    return `${line.date} ${who}: ${line.text}`;
  });
  return [
    ...tagged("negotiation", describeNegotiation(state, negotiation.id)),
    ...tagged("table_log", log.join("\n")),
  ];
}

export const BY_NEGOTIATION = new Set([
  "respond_offer",
  "accept_deal",
  "withdraw_offer",
  "answer_term",
  "offer_terms",
  "propose_personal",
]);

export const BY_PLAYER = new Set(["send_offer", "open_renewal", "propose_personal"]);
