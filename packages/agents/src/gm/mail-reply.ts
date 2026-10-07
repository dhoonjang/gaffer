import { z } from "zod";
import {
  NegotiationActionSchema,
  FREE_AGENT_TEAM,
  type MailReplyJob,
  type MailThread,
  type Negotiation,
} from "@gaffer/domain";
import {
  actNegotiation,
  completeMailReply,
  dueMailReplies,
  managedTeamId,
  openNegotiation,
  resolveMailRecipient,
  isNegotiationContact,
  isNegotiationParty,
  journal,
  pickPlayerAmong,
  type GameState,
  type JournalEntry,
} from "@gaffer/engine";
import {
  agentConfig,
  createGameLLM,
  resolveLlmMode,
  ScriptedGameLLM,
  type GameLLM,
  type GameToolSpec,
} from "@gaffer/llm";
import { MailReplyOutputSchema, MAIL_REPLY_SYSTEM, MAIL_REPLY_OUTPUT } from "./mail-reply-prompt";
import { toToolSchema, inputError } from "../shared/tool-schema";
import { ModelOutputError, readOutput, retryOnce } from "../shared/retry";
import { buildGmReference } from "../shared/context";
import { negotiationCounterparts } from "./negotiation-counterparts";

const ReplyActionSchema = z
  .object({ negotiationId: z.string().min(1), action: NegotiationActionSchema })
  .strict();

function permitted(state: GameState, thread: MailThread, n: Negotiation): boolean {
  const team = managedTeamId(state);
  return !!team && isNegotiationParty(n, team) && isNegotiationContact(state, n, thread);
}
function scopedCases(state: GameState, thread: MailThread, job: MailReplyJob) {
  const through = thread.messages.findIndex((m) => m.id === job.throughMessageId);
  const messages = thread.messages.slice(0, through + 1);
  const mentioned = new Set(messages.flatMap((m) => (m.negotiationId ? [m.negotiationId] : [])));
  const players = new Set(messages.flatMap((m) => m.references.playerIds));
  if (thread.recipient.kind === "agent") players.add(thread.recipient.playerId);
  return state.negotiations
    .filter((n) => permitted(state, thread, n) && (mentioned.has(n.id) || players.has(n.playerId)))
    .slice(-12);
}

export async function replyToMail(
  state: GameState,
  jobId: string,
  llm?: GameLLM,
): Promise<boolean> {
  const initial = state.mailReplyJobs.find((j) => j.id === jobId);
  if (!initial || initial.status !== "pending" || initial.dueOn > state.date) return false;
  const contact = state.mailThreads.find((t) => t.id === initial.threadId);
  if (!contact || contact.ownerTeamId !== managedTeamId(state)) return false;
  const answer = await retryOnce("mail-reply", async () => {
    const draft = structuredClone(state);
    const job = draft.mailReplyJobs.find((j) => j.id === jobId)!;
    const cursor = job.throughMessageId;
    const thread = draft.mailThreads.find((t) => t.id === job.threadId)!;
    const records: JournalEntry[] = [];
    const openedIds = new Set<string>();
    const allowedCases = () => [
      ...new Map(
        [
          ...scopedCases(draft, thread, job),
          ...draft.negotiations.filter((n) => openedIds.has(n.id) && permitted(draft, thread, n)),
        ].map((n) => [n.id, n]),
      ).values(),
    ];
    const caseFacts = () =>
      allowedCases().map((n) => ({
        id: n.id,
        playerId: n.playerId,
        buyerId: n.buyerId,
        sellerId: n.sellerId,
        kind: n.kind,
        status: n.status,
        revision: n.revision,
        player: draft.players.find((p) => p.id === n.playerId),
        counterparts: negotiationCounterparts(draft, n),
        proposals: n.proposals.filter(
          (p) =>
            p.status === "open" &&
            p.terms.scope === (thread.recipient.kind === "club" ? "club" : "player"),
        ),
        drafts: n.drafts.filter(
          (p) => p.scope === (thread.recipient.kind === "club" ? "club" : "player"),
        ),
        signed: n.signed ? { on: n.signed.on } : null,
      }));
    const tools: GameToolSpec[] = [
      {
        name: "search_players",
        description:
          "Looks up only the current contact club's players and the manager's club's players, or the players the current agent represents. name is a real name or id.",
        inputSchema: toToolSchema(z.object({ name: z.string().trim().min(1).optional() }).strict()),
        readOnly: true,
        handle(raw) {
          const parsed = z
            .object({ name: z.string().trim().min(1).optional() })
            .strict()
            .safeParse(raw);
          if (!parsed.success) return inputError(parsed.error);
          const recipient = thread.recipient;
          const pool = draft.players.filter((player) =>
            recipient.kind === "club"
              ? [recipient.teamId, thread.ownerTeamId].includes(player.teamId)
              : recipient.kind === "agent" &&
                resolveMailRecipient(draft, { kind: "agent", playerId: player.id })?.contactId ===
                  thread.contactId,
          );
          const result = parsed.data.name
            ? pickPlayerAmong(draft, pool, parsed.data.name, "연락 상대의 선수 명단")
            : null;
          const players = result?.ok ? [result.player] : parsed.data.name ? [] : pool.slice(0, 40);
          return {
            ok: result?.ok ?? true,
            message: JSON.stringify({
              players: players.map((p) => ({
                id: p.id,
                name: p.name,
                teamId: p.teamId,
                positions: p.positions,
              })),
              ...(result && !result.ok ? { reason: result.message } : {}),
            }),
          };
        },
      },
      {
        name: "get_negotiations",
        description:
          "Looks up the exact terms of only the related negotiations the current mail contact takes part in.",
        inputSchema: toToolSchema(z.object({}).strict()),
        readOnly: true,
        handle: () => ({ ok: true, message: JSON.stringify(caseFacts()) }),
      },
      {
        name: "negotiation_action",
        description:
          "Records the current contact's actual negotiation proposal, acceptance, rejection or withdrawal. partyId is set from the contact. Actions on the manager's behalf are not possible.",
        inputSchema: toToolSchema(ReplyActionSchema),
        handle(raw) {
          const parsed = ReplyActionSchema.safeParse(raw);
          if (!parsed.success) return inputError(parsed.error);
          const n = allowedCases().find((n) => n.id === parsed.data.negotiationId);
          const recipient = thread.recipient;
          if (!n || recipient.kind === "staff")
            return { ok: false, message: "이 메일 상대의 협상 권한이 없습니다" };
          const action = parsed.data.action;
          const scope = recipient.kind === "club" ? "club" : "player";
          if (!["send", "accept", "reject", "withdraw"].includes(action.kind))
            return {
              ok: false,
              message: "회신은 감독의 제안·동의·메디컬·서명을 대신할 수 없습니다",
            };
          if (
            (action.kind === "send" && action.terms.scope !== scope) ||
            ((action.kind === "accept" || action.kind === "reject") &&
              !n.proposals.some((p) => p.id === action.proposalId && p.terms.scope === scope))
          )
            return { ok: false, message: "현재 연락 상대의 조건 범위가 아닙니다" };
          const partyId = recipient.kind === "club" ? recipient.teamId : n.playerId;
          const result = actNegotiation(draft, n.id, action, { kind: "model", partyId });
          records.push({
            kind: "command",
            name: "mail_negotiation_action",
            input: { jobId, negotiationId: n.id, partyId, action },
            ok: result.ok,
            message: result.message,
            source: "tool",
          });
          return result;
        },
      },
      {
        name: "start_negotiation",
        description:
          "Opens the negotiation ledger for a player the contact takes part in. It creates no proposal or agreement from the manager.",
        inputSchema: toToolSchema(z.object({ playerId: z.string().min(1) }).strict()),
        handle(raw) {
          const parsed = z
            .object({ playerId: z.string().min(1) })
            .strict()
            .safeParse(raw);
          if (!parsed.success) return inputError(parsed.error);
          const player = draft.players.find((p) => p.id === parsed.data.playerId);
          const team = managedTeamId(draft),
            recipient = thread.recipient;
          if (!player || !team || recipient.kind === "staff")
            return { ok: false, message: "현재 연락 상대의 협상을 열 수 없습니다" };
          if (
            recipient.kind === "agent" &&
            resolveMailRecipient(draft, { kind: "agent", playerId: player.id })?.contactId !==
              thread.contactId
          )
            return { ok: false, message: "다른 대리인의 선수입니다" };
          const buyerId =
            recipient.kind === "club" && player.teamId === team ? recipient.teamId : team;
          if (
            recipient.kind === "club" &&
            player.teamId !== team &&
            player.teamId !== recipient.teamId
          )
            return { ok: false, message: "현재 구단의 선수가 아닙니다" };
          const outcome = openNegotiation(
            draft,
            {
              playerId: player.id,
              buyerId,
              kind:
                player.teamId === buyerId
                  ? "renewal"
                  : player.teamId === FREE_AGENT_TEAM
                    ? "free"
                    : "transfer",
              background: "메일에서 논의한 협상",
            },
            "world",
          );
          if (outcome.ok && outcome.negotiationId) {
            openedIds.add(outcome.negotiationId);
          }
          return outcome;
        },
      },
    ];
    const through = thread.messages.findIndex((m) => m.id === cursor);
    const messages = thread.messages.slice(Math.max(0, through - 11), through + 1);
    const config = agentConfig("gm");
    const client =
      llm ??
      (resolveLlmMode() === "mock"
        ? new ScriptedGameLLM(config, () => ({
            output: {
              subject: `Re: ${messages.at(-1)?.subject ?? "연락"}`,
              body: `${thread.label}입니다. 보내 주신 연락을 확인했습니다. 관련 조건과 자료를 검토하고 있습니다.`,
            },
          }))
        : createGameLLM(config));
    const result = await client.runTurn({
      system: [MAIL_REPLY_SYSTEM, buildGmReference(draft)],
      history: [],
      user: JSON.stringify({
        task: "reply",
        contact: { label: thread.label, contactId: thread.contactId, recipient: thread.recipient },
        externalMail: messages,
      }),
      stateNote: JSON.stringify({
        date: draft.date,
        managedClub: managedTeamId(draft),
        cases: caseFacts(),
      }),
      tools,
      outputSchema: MAIL_REPLY_OUTPUT,
    });
    const output = readOutput("mail-reply", MailReplyOutputSchema, result);
    const live = state.mailReplyJobs.find((j) => j.id === jobId);
    if (live?.status !== "pending" || live.throughMessageId !== cursor)
      throw new ModelOutputError(
        "회신 중 새로운 연락이 도착했습니다. 최신 작업을 다시 읽어야 합니다",
      );
    const completed = completeMailReply(draft, jobId, { ...output, throughMessageId: cursor });
    if (!completed.ok) throw new ModelOutputError(completed.message);
    return { draft, records, completed, cursor };
  });
  Object.assign(state, answer.draft);
  for (const record of answer.records) journal(record);
  journal({
    kind: "command",
    name: "complete_mail_reply",
    input: { jobId, throughMessageId: answer.cursor },
    ok: true,
    message: answer.completed.message,
    source: "tool",
  });
  return true;
}

export async function processMailReplies(state: GameState, llm?: GameLLM) {
  let replied = 0;
  for (const job of [...dueMailReplies(state)].sort(
    (a, b) =>
      a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id, undefined, { numeric: true }),
  )) {
    try {
      if (await replyToMail(state, job.id, llm)) replied++;
    } catch (error) {
      journal({
        kind: "command",
        name: "complete_mail_reply",
        input: { jobId: job.id },
        ok: false,
        message: error instanceof Error ? error.message : "메일 회신을 처리하지 못했습니다",
        source: "tool",
      });
    }
  }
  return { replied };
}
