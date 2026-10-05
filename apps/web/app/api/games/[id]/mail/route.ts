import { NextResponse } from "next/server";
import { z } from "zod";
import { MailUiSendSchema, MailRecipientSearchSchema } from "@story-fm/domain";
import {
  buildMailView,
  searchMailRecipients,
  resolveMailRecipientText,
  getMailRequestResult,
  readMailThread,
  sendMail,
  loadGame,
  saveGame,
  journal,
} from "@story-fm/engine";
import { traceBoard, withGameUsage } from "@story-fm/llm";
import { toPayload } from "@/game/store";
import { busyResponse, LOCK_WAIT_MS, withGameLock } from "@/game/turn-runner";
import { invalidGameId } from "@/app/api/games/game-id";
const RequestSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const { kind, ...values } = raw as Record<string, unknown>;
    return kind === "send" ? { kind, values } : raw;
  },
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("send"), values: MailUiSendSchema }).strict(),
    z.object({ kind: z.literal("read"), threadId: z.string().trim().min(1).max(160) }).strict(),
  ]),
);
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const bad = invalidGameId(id);
  if (bad) return bad;
  const state = loadGame(id);
  if (!state) return NextResponse.json({ error: "게임을 찾을 수 없습니다" }, { status: 404 });
  const query = new URL(request.url).searchParams;
  if (query.size > 0) {
    const keys = [...query.keys()];
    if (new Set(keys).size !== keys.length)
      return NextResponse.json({ error: "수신인 검색 형식이 올바르지 않습니다" }, { status: 400 });
    const parsed = MailRecipientSearchSchema.safeParse(
      Object.fromEntries(
        [...query].map(([key, value]) => [key, key === "limit" ? Number(value) : value]),
      ),
    );
    if (!parsed.success)
      return NextResponse.json({ error: "수신인 검색 형식이 올바르지 않습니다" }, { status: 400 });
    return NextResponse.json(searchMailRecipients(state, parsed.data));
  }
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
        const input = parsed.data;
        const journalInput = input.kind === "send" ? { kind: input.kind, ...input.values } : input;
        let result;
        if (input.kind === "read") result = readMailThread(state, input.threadId);
        else {
          const values = input.values;
          const replay = getMailRequestResult(state, values.requestId);
          const mail = {
            requestId: values.requestId,
            subject: values.subject,
            body: values.body,
            ...(values.negotiationId ? { negotiationId: values.negotiationId } : {}),
            ...(values.references ? { references: values.references } : {}),
          };
          if (replay) result = replay;
          else if (values.recipient)
            result = sendMail(state, { ...mail, recipient: values.recipient });
          else {
            const resolved = resolveMailRecipientText(state, values.recipientText ?? "");
            if (!resolved.ok) {
              journal({
                kind: "command",
                name: "send_mail",
                input: journalInput,
                ok: false,
                message: resolved.message,
                source: "board",
              });
              return NextResponse.json(
                { error: resolved.message, candidates: resolved.candidates },
                { status: 400 },
              );
            }
            result = sendMail(state, { ...mail, recipient: resolved.contact.recipient });
          }
        }
        journal({
          kind: "command",
          name: input.kind === "read" ? "read_mail" : "send_mail",
          input: journalInput,
          ok: result.ok,
          message: result.message,
          source: "board",
        });
        if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
        const game = toPayload(state);
        if (!result.replayed) saveGame(state);
        return NextResponse.json({
          game,
          threadId: result.threadId,
          messageId: result.messageId,
          replayed: result.replayed ?? false,
          saved: true,
        });
      }),
    ),
  ).catch(busyResponse);
}
