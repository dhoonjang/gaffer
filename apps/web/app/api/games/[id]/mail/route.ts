import { NextResponse } from "next/server";
import { z } from "zod";
import { MailSendSchema } from "@story-fm/domain";
import {
  buildMailView,
  readMailThread,
  sendMail,
  loadGame,
  saveGame,
  journal,
} from "@story-fm/engine";
import { traceBoard, withGameUsage } from "@story-fm/llm";
import { toPayload } from "@/application/lib/store";
import { busyResponse, LOCK_WAIT_MS, withGameLock } from "@/application/lib/turn-runner";
import { invalidGameId } from "@/app/api/games/game-id";
const RequestSchema = z.discriminatedUnion("kind", [
  MailSendSchema.extend({ kind: z.literal("send") }),
  z.object({ kind: z.literal("read"), threadId: z.string().trim().min(1).max(160) }).strict(),
]);
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const state = loadGame(id);
  if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  return NextResponse.json({ mail: buildMailView(state) });
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
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success)
    return NextResponse.json({ error: "메일 요청 형식이 올바르지 않습니다" }, { status: 400 });
  return withGameLock(id, LOCK_WAIT_MS.turn, () =>
    withGameUsage(id, () =>
      traceBoard(id, async () => {
        const state = loadGame(id);
        if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
        const { kind, ...values } = parsed.data;
        const result =
          kind === "read"
            ? readMailThread(state, parsed.data.kind === "read" ? parsed.data.threadId : "")
            : sendMail(state, values);
        journal({
          kind: "command",
          name: kind === "read" ? "read_mail" : "send_mail",
          input: parsed.data,
          ok: result.ok,
          message: result.message,
          source: "board",
        });
        if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
        const game = toPayload(state);
        saveGame(state);
        return NextResponse.json({ game, threadId: result.threadId, saved: true });
      }),
    ),
  ).catch(busyResponse);
}
