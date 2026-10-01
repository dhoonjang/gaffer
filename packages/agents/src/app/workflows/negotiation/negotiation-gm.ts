import {
  type GameState,
  roomPartyOf,
  defaultPartyOf,
  roomNegotiationOf,
  closeNegotiation,
  negotiationEvaluationContext,
  tableOf,
  assessmentText,
  acceptTableTerms,
} from "@story-fm/engine";
import {
  type NegotiationToolContext,
  NEGOTIATION_TOOL_DEFINITIONS,
  NO_ROOM,
  EvaluationRequestSchema,
  EVALUATE_NEGOTIATION_TOOL,
  LEAVE_NEGOTIATION_TOOL,
  ACCEPT_NEGOTIATION_TOOL,
  AcceptNegotiationSchema,
} from "../../../negotiation/negotiation-gm";
import { type GameToolSpec } from "@story-fm/llm";
import { inputError } from "../../../common/tool-schema";
import { createInstructionTool } from "../instructions";
import { recordCall } from "../../../common/gm-types";
import { evaluateNegotiation } from "./evaluation";
import { buildToolSpecs } from "../../gm-tools";
import { buildGmReference } from "../common/context";

export function buildNegotiationReference(state: GameState, negotiationId: string): string {
  const n = state.negotiations.find((n) => n.id === negotiationId);
  if (!n) return "";
  const party = roomPartyOf(state) ?? defaultPartyOf(state, n);
  const context = negotiationEvaluationContext(state, n, party);
  if (!context) return "";
  // The conversation receives observable facts, not the evaluator's private financial inputs.
  const { counterparty: _private, history: _history, ...facts } = context.facts;
  void _private;
  void _history;
  const counterparty = `<counterparty>${JSON.stringify({ kind: n.kind, party, facts })}</counterparty>`;
  return `${buildGmReference(state)}\n\n${counterparty}`;
}
export function buildTableNote(state: GameState, negotiationId: string): string {
  const n = state.negotiations.find((n) => n.id === negotiationId);
  if (!n) return "";
  const party = roomPartyOf(state) ?? defaultPartyOf(state, n);
  const contact = tableOf(state, n, party);
  const exchange = state.negotiationExchanges.find(
    (e) => e.id === state.pendingNegotiation?.exchangeId,
  );
  const evaluations = state.negotiationEvaluations
    .filter((e) => e.negotiationId === n.id && e.party === party)
    .map(assessmentText);
  return `<table>${JSON.stringify({ status: n.status, method: exchange?.method, contactId: contact?.id, evaluations })}</table>`;
}
export function buildNegotiationTools(
  state: GameState,
  ctx: NegotiationToolContext,
  onCheckpoint?: (state: GameState) => void | Promise<void>,
): GameToolSpec[] {
  const definition = (name: string) => NEGOTIATION_TOOL_DEFINITIONS.find((t) => t.name === name)!;
  return [
    ...buildToolSpecs(state, ctx.calls).filter((tool) => tool.name === "update_character"),
    createInstructionTool(state, ctx.calls, {
      name: "negotiation_orders",
      agent: "table-orders",
      said: ctx.said,
      description: definition("negotiation_orders").description,
    }),
    {
      ...definition(EVALUATE_NEGOTIATION_TOOL),
      handle: async (input: unknown) => {
        const parsed = EvaluationRequestSchema.safeParse(input ?? {});
        if (!parsed.success) return inputError(parsed.error);
        const room = roomNegotiationOf(state);
        if (!room) return NO_ROOM;
        const result = await evaluateNegotiation(state, {
          negotiationId: room.id,
          party: roomPartyOf(state) ?? undefined,
          exchangeId: state.pendingNegotiation?.exchangeId,
        });
        await onCheckpoint?.(state);
        return recordCall(ctx.calls, EVALUATE_NEGOTIATION_TOOL, result, {
          input: parsed.data,
          silent: true,
        });
      },
    },
    {
      ...definition(ACCEPT_NEGOTIATION_TOOL),
      handle: async (input: unknown) => {
        const parsed = AcceptNegotiationSchema.safeParse(input ?? {});
        if (!parsed.success) return inputError(parsed.error);
        const room = roomNegotiationOf(state);
        if (!room) return NO_ROOM;
        const result = acceptTableTerms(state, {
          negotiationId: room.id,
          party: roomPartyOf(state) ?? defaultPartyOf(state, room),
          side: parsed.data.side,
        });
        await onCheckpoint?.(state);
        // 계약서가 선 합의만 카드다 — 이적료만 닿은 합의는 남은 개인 조건이 있어 카드가 없다
        return recordCall(ctx.calls, ACCEPT_NEGOTIATION_TOOL, result, {
          input: parsed.data,
          ...(result.payload === undefined ? { silent: true } : {}),
        });
      },
    },
    {
      ...definition(LEAVE_NEGOTIATION_TOOL),
      handle: async () => {
        const room = roomNegotiationOf(state);
        if (!room) return NO_ROOM;
        const assessment = await evaluateNegotiation(state, {
          negotiationId: room.id,
          party: roomPartyOf(state) ?? undefined,
          exchangeId: state.pendingNegotiation?.exchangeId,
          ending: true,
        });
        const left = closeNegotiation(state, "left");
        await onCheckpoint?.(state);
        return recordCall(
          ctx.calls,
          LEAVE_NEGOTIATION_TOOL,
          { ...left, message: `${assessment.message} · ${left.message}` },
          { silent: true },
        );
      },
    },
  ];
}
