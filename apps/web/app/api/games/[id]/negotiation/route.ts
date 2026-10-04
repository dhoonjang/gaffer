import { after, NextResponse } from "next/server";
import { NegotiationRequestSchema } from "@story-fm/domain";
import {
  applyNegotiationRequest,
  buildNegotiationView,
  loadGame,
  saveGame,
  journal,
} from "@story-fm/engine";
import { traceBoard, withGameUsage } from "@story-fm/llm";
import { toPayload } from "@/application/lib/store";
import { processLorebookJobs } from "@/application/lib/lorebook-jobs";
import { busyResponse, LOCK_WAIT_MS, withGameLock } from "@/application/lib/turn-runner";
import { invalidGameId } from "@/app/api/games/game-id";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const state = loadGame(id);
  if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json({ negotiation: buildNegotiationView(state) });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const parsed = NegotiationRequestSchema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json({ error: "협상 요청 형식이 올바르지 않습니다" }, { status: 400 });
  return withGameLock(id, LOCK_WAIT_MS.turn, () =>
    withGameUsage(id, () =>
      traceBoard(id, async () => {
        const state = loadGame(id);
        if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
        const result = applyNegotiationRequest(state, parsed.data);
        journal({
          kind: "command",
          name: "negotiation_request",
          input: parsed.data,
          ok: result.ok,
          message: result.message,
          source: "board",
        });
        if (!result.ok)
          return NextResponse.json({ error: result.message }, { status: result.status ?? 400 });
        const payload = toPayload(state);
        saveGame(state);
        if (state.lorebookJobs.length > 0) after(() => processLorebookJobs(id));
        return NextResponse.json({
          game: payload,
          negotiationId: result.negotiationId ?? parsed.data.negotiationId,
          saved: true,
        });
      }),
    ),
  ).catch(busyResponse);
}
