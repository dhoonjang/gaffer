import {
  type GameState,
  roomPartyOf,
  defaultPartyOf,
  buildCounterpartyBrief,
  seatViewOf,
  roomNegotiationOf,
  seatAt,
  type TableReply,
  settleTableReply,
  closeNegotiation,
} from "@story-fm/engine";
import { buildGmReference } from "../common/context";
import { buildCounterpartyBlock } from "./counterparty-brief";
import { buildSituationBlock } from "./table-situation";
import { describeSeatAnchor } from "../../../negotiation/counterparty-brief";
import {
  type NegotiationToolContext,
  NEGOTIATION_TOOL_DEFINITIONS,
  NEGOTIATION_ORDERS_TOOL,
  NO_ROOM,
  CounterpartyReplySchema,
  COUNTERPARTY_REPLY_TOOL,
  LEAVE_NEGOTIATION_TOOL,
} from "../../../negotiation/negotiation-gm";
import { type Negotiation } from "@story-fm/domain";
import { buildToolSpecs } from "../../gm-tools";
import { runTableOrders } from "./table-orders";
import { applyOps, ordersGate } from "../../../common/orders-ops";
import { TABLE_OPS } from "../../../negotiation/table-orders";
import { type GameToolSpec } from "@story-fm/llm";
import { inputError } from "../../../common/tool-schema";
import { recordCall } from "../../../common/gm-types";

// ── 입력 — 레퍼런스와 스냅샷 ─────────────────────────────────

/**
 * 협상 방의 레퍼런스 — 구단·감독 블록에 이 협상의 **서류**(라운드마다 바뀌는 `<dossier>`는
 * 뺀다)와 `<situation>`을 더한다 (agents.md §4-1 · §5). 서류는 협상이 사는 동안 거의
 * 그대로라 여기 서고, 라운드마다 바뀌는 것은 `<table>` 스냅샷이 싣는다.
 */
export function buildNegotiationReference(state: GameState, negotiationId: string): string {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  return [
    buildGmReference(state),
    ...(negotiation
      ? [
          buildCounterpartyBlock(state, negotiation, {
            dossier: false,
            party: roomPartyOf(state) ?? defaultPartyOf(state, negotiation),
          }),
          buildSituationBlock(state, negotiation),
        ]
      : []),
  ]
    .filter((block): block is string => block !== null && block.length > 0)
    .join("\n\n");
}

/**
 * `<table>` — 방의 상태 스냅샷. 오퍼 이력 · 값의 자 · 조건서 · 개인 조건 · 남은 인내 ·
 * `<anchor>`. 매 턴 새 값이라 발화 뒤에 서고 이력에 남지 않는다 (agents.md §5).
 */
export function buildTableNote(state: GameState, negotiationId: string): string {
  const negotiation = state.negotiations.find((n) => n.id === negotiationId);
  if (!negotiation) return "";
  if (negotiation.status !== "open") {
    return [`<table>`, `협상이 끝났다 — ${negotiation.status}`, `</table>`].join("\n");
  }
  const brief = buildCounterpartyBrief(state, negotiation);
  return [
    `<table>`,
    ...(brief?.dossier ?? []),
    describeSeatAnchor(
      seatViewOf(state, negotiation, roomPartyOf(state) ?? defaultPartyOf(state, negotiation)),
    ),
    `</table>`,
  ].join("\n");
}

/**
 * 감독의 말 → 이 협상의 명령. 해석기가 두 번 실패하면 **반려로 답한다** — 턴은 이어지고 GM은
 * 반려된 대로 쓴다 (agents.md §1). 호출 실패(시한·혼잡)는 그대로 올라간다.
 */
async function runTableOrdersTool(
  state: GameState,
  ctx: NegotiationToolContext,
  negotiation: Negotiation,
  said: string,
  specs: ReadonlyMap<string, GameToolSpec>,
): Promise<{ ok: boolean; message: string }> {
  const moved = await runTableOrders(state, specs, negotiation, said);
  if (!moved.ok) return { ok: false, message: moved.message };
  const notes: string[] = [];
  const outcomes = applyOps(specs, moved.orders, TABLE_OPS, notes);
  const replies =
    notes.length > 0 ? ["<core_replies>", ...notes.map((n) => `- ${n}`), "</core_replies>"] : [];
  return {
    // 아무 명령도 걸리지 않은 턴은 성공이 아니다 — 장부는 그대로이고 GM은 반려된 대로 쓴다
    ok: outcomes.applied > 0,
    message: [...replies, buildTableNote(state, negotiation.id)].join("\n"),
  };
}

/**
 * 이 턴의 협상 도구 — 진행 턴은 셋. 감독이 나선 첫 턴과 물러나는 손잡이 턴은 부르지 않는다.
 */
export function buildNegotiationTools(
  state: GameState,
  ctx: NegotiationToolContext,
): GameToolSpec[] {
  const [orders, reply, leave] = NEGOTIATION_TOOL_DEFINITIONS;
  const specs = new Map(buildToolSpecs(state, ctx.calls).map((t) => [t.name, t] as const));
  /**
   * 손잡이는 인자가 없다 — 이번 턴 감독의 말은 `ctx.said`가 쥔다 (agents.md §1). 같은 턴의
   * 두 번째 호출은 같은 말을 다시 옮기므로 문이 닫는다.
   */
  const gate = ordersGate(ctx.said);
  /** 답은 한 턴에 하나다 — 두 번째 판정은 인내를 두 번 깎는다 */
  let replied = false;
  return [
    {
      ...orders!,
      handle: async () => {
        const opened = gate(NEGOTIATION_ORDERS_TOOL);
        if (!opened.ok) return opened;
        const room = roomNegotiationOf(state);
        if (!room) return NO_ROOM;
        return runTableOrdersTool(state, ctx, room, opened.said, specs);
      },
    },
    {
      ...reply!,
      handle: async (input: unknown) => {
        const parsed = CounterpartyReplySchema.safeParse(input ?? {});
        if (!parsed.success) return inputError(parsed.error);
        if (replied) {
          return {
            ok: false,
            message: "이번 턴의 답은 이미 판정했습니다 — 결과는 앞의 호출에 있습니다",
          };
        }
        const room = roomNegotiationOf(state);
        if (!room) return NO_ROOM;
        // 감독의 말은 턴이 열릴 때 코어가 적었다 — 여기서는 줄 없이 자리만 세워 앵커를 읽는다
        const seated = seatAt(state, room.id, roomPartyOf(state) ?? undefined);
        if (!seated.ok) return seated;
        replied = true;
        const got = parsed.data;
        const heard: TableReply = {
          stance: got.stance,
          heard: got.heard,
          ...(got.ruling ? { ruling: got.ruling } : {}),
          ...(got.asks && got.asks.length > 0 ? { asks: got.asks } : {}),
        };
        /**
         * 판정된 오퍼의 카드(`payload`)가 기록에 실린다 — 화면이 그 턴에 카드로 세운다. 말만
         * 오간 답은 세울 카드가 없으므로 `silent`다 — 카드 자리의 호출이 카드 없이 서면 화면이
         * 그것을 깨진 카드로 읽는다 (`market-calls.ts`).
         */
        const outcome = settleTableReply(state, seated.seat, heard);
        return recordCall(ctx.calls, COUNTERPARTY_REPLY_TOOL, outcome, {
          input: got,
          ...(outcome.payload ? {} : { silent: true }),
        });
      },
    },
    {
      ...leave!,
      handle: async () => {
        const left = closeNegotiation(state, "left");
        if (!left.ok) return left;
        // 방을 닫은 것은 코어의 처리 결과다 — 칩으로 세우지 않는다
        return recordCall(ctx.calls, LEAVE_NEGOTIATION_TOOL, left, { silent: true });
      },
    },
  ];
}
