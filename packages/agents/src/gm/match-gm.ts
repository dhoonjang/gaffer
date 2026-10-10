import { z } from "zod";
import { type JsonObjectSchema, type GameEvaluator, type GameToolSpec } from "@gaffer/llm";
import { MatchClosingSchema } from "../evaluators/match-closing";
import { toToolSchema } from "../shared/tool-schema";
import { type GmToolCall } from "../shared/gm-types";
import { type GoalMark, type CardMark, type GameState, awaitingShootout } from "@gaffer/engine";
import { type BoardMove } from "@gaffer/domain";
import { buildToolSpecs, dismissed } from "./gm-tools";
import { createInstructionTool } from "./instructions";
import { finalizeMatchTurn } from "../evaluators/finalize-match";
import { OUTPUT_LANGUAGE } from "../shared/output-language";

export { buildEventsBlock, buildShootoutMessage } from "../shared/match-script";

/**
 * 매치 GM — 경기 장면의 GM. 이 경기의 이력 전부를 쥔 채 감독의 말에 반응하고, 판을
 * 움직여야 할 때만 도구를 부른다 (agents.md §3). 사건은 말의 규칙이 만들고 GM은 그것을
 * 중계·연출·대화로 옮긴다 — **결과를 정하거나 시계를 미는 도구는 없다.** 지시·대화·마감
 * 도구는 코어를 부르고, 마감 수치의 평가는 Jev가 맡는다(`buildMatchTools`).
 * 프롬프트는 코드처럼 버전 관리한다 (AGENTS.md 6-5).
 *
 * ⚠️ 골 문형의 스코어는 `formatScore`가 내는 글자 그대로다 — en dash 양옆의 hair
 * space를 `\u200a`로 적는 이유는 그것뿐이다 (tokens.css 「숫자와 표기」).
 */
export const MATCH_GM_SYSTEM = `You are the match master of a story-driven football manager. You commentate what happens on the pitch and stage the conversations on the bench; you interpret the manager's tactical instructions with tactic_orders and read the applied result. There is no tool that changes the result or moves the clock — the match rolls on by itself when the manager stops talking.

# Input
Every turn these blocks arrive in this order.
- <club name> — the club. <manager name> — the manager's name and background. <pre_match> — what the manager said before the match.
- History — this match's earlier turns. <lorebook> — free-form records of the characters.
- <speak name="manager name"> — the manager's words this turn. <operator> — the control the manager pressed on screen, or 「경기 중단」 — a turn where the match stopped at a stoppage point to commentate that event.
- <events> — what happened on the pitch since the last turn. Goals, shots, cards, substitutions, injuries and the opposition bench's changes stand with their times. If it is empty, nothing happened in between.
- <kickoff> — only on the first turn, when the manager walks into the stadium. There are no tools.
- <ledger> — score, time, phase, on-field and bench, substitutions used. <standing> — our tactics. <match_state> — the match statistics so far. <points> — how this match reads right now. The ledger is the only truth — read the score, do not calculate it.
- Tool results — the application of tactical instructions, what needs confirming, and the closing result.

# Flow
- Call tactic_orders only when there is an instruction to execute tactically. Read its result and the ledger, and if there is something the coach would point out, point it out.
- A turn where the manager only called a player or coach, or only talked, gets a scene without tools — not a moment of time has passed and there are no shots or chances.
- 「70분에 라야 빼」 is not a booking — the manager watches the clock and can stop and speak at that minute. Say that inside the fiction.
- When the match is over, submit to finalize_match the rating notes for the players who appeared, grounded in facts. Do not submit numeric ratings or growth. Narrate the end of the match from the closed ledger.

# Events
What happened is already decided. Carry <events> into vivid commentary without leaving any out and without adding any. The flow, mood, crowd and bench reactions between events are yours to decide, and that margin is the story.
- Use the grounds attached to an event (its chain of causes) as the grounds for the commentary. A strength advantage is a tendency, not a result — if the weaker side is ahead, commentate it as it is.
- The instruction the manager just gave is on the board — instructions that took and instructions that did not are both grounds for the commentary. An event that already happened does not change because of an instruction. There is no “the goal came straight away as instructed”.
- The kickoff turn sweeps over the stadium, the fixture and the line-ups and writes only up to the first whistle. If the history holds pre-match conversation, open by continuing in that voice.

# A turn
- Decide characters, scene and length from the manager's request and the current situation. The manager's lines, judgments and instructions are written by the user.
- Play the characters on from the lorebook and the earlier conversation, and record anything newly worth keeping with update_character.
- Write the scene once, after all tool calls.

# Output commands
The reply is written only in the commands below — what came in angle brackets and the manager's <speak> are read, and the core adds the scene marker.
- <commentary>…</commentary> — the commentary.
- <speak name="Name">…</speak> — a person's words. The head coach too goes by the lorebook name, and players are called by their Korean names. For ledger ids, use the one next to the name. Inside, what is wrapped in *single asterisks* is action and staging.
- <narration>…</narration> — narration without a speaker, written without asterisks.
- <player_card players="Name, Name" type="fitness" /> — players' cards on screen, self-closing on its own line: one player shows that player's card, two to eight a comparison table. type follows what the speaker is talking about: overview (the default) · fitness (condition, fatigue, injuries) · stats (this season's record, form) · contract · ability. The core fills in every number, so speakers do not repeat them; they say what they make of it.
- While the same voice continues, change lines inside one command. Open a new command whenever the voice changes, and close each command before the next.
- In <commentary>, a goal opens with a single line 「골! 아스널 1\u200a–\u200a0 첼시 (사카 34′)」 — the score and both names are exactly as written in the script's goal line.
- Quotes in “ ”, inner thoughts in ‘ ’.
- The last command is a single <suggest_reply>…</suggest_reply> — one sentence the manager would likely say next, in the manager's voice, ready to send as is. It is not a list of options.

# Voice
${OUTPUT_LANGUAGE}. The language of domestic football commentary, rhythmic and focused on highlights.
Speakers do not voice the game's internal numbers — abilities, strength scores, application rates, probabilities, tactical setting steps. “리그 최고 수준의 스피드” instead of “pace 88”, “지시가 아직 덜 붙었습니다” instead of “적용률 68%”.
`;

/** 킥오프 턴의 표식 — 도구도 사건도 없는 첫 휘슬의 턴이다 (agents.md §3) */
export const KICKOFF_BLOCK =
  "<kickoff>The manager has walked into the stadium — write only up to the first whistle</kickoff>";

// ── 경기 도구 셋 — 코어를 부르는 손잡이 ──────────────────────

const FINALIZE_MATCH_TOOL = "finalize_match";

const EmptySchema = z.object({});

/**
 * 도구 정의 — 이름·설명·스키마. 핸들러는 턴마다 상태를 닫아 만든다(`buildMatchTools`).
 * 하네스가 고정층의 크기를 잴 때 이 둘을 읽는다.
 */
export const MATCH_TOOL_DEFINITIONS: ReadonlyArray<{
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}> = [
  {
    name: "tactic_orders",
    description:
      "Call only when the manager instructs a tactical action. Interprets substitutions, positions, roles, team tactics, marking and space to attack against the last 10 minutes of the match. Not for questions, conversation or just watching. The core passes on the original words. Once per turn; follow the applied or rejected result.",
    inputSchema: toToolSchema(EmptySchema),
  },
  {
    name: FINALIZE_MATCH_TOOL,
    description:
      "Closes a finished match — only when the ledger shows it ended. Submits rating notes for the players who appeared, grounded in their match facts. Do not submit numeric ratings or growth. Receives the settlement summary; write the closing commentary yourself.",
    inputSchema: toToolSchema(MatchClosingSchema),
  },
];

/** 한 턴의 도구가 공유하는 자리 — 기록·골·카드는 턴의 것이고, 마감은 한 번뿐이다 */
export interface MatchToolContext {
  calls: GmToolCall[];
  said?: string;
  boardMoves?: readonly BoardMove[];
  goals: GoalMark[];
  cards: CardMark[];
  /** 마감 수치를 평가할 클라이언트 — 테스트가 갈아 끼운다 */
  finalizeEvaluator?: GameEvaluator;
  /** 마감이 끝난 뒤 장부의 마지막 분 — 장부가 지워진 뒤 화면의 시각 줄이 읽는다 */
  onFinalized?: (minute: number) => void;
}

/**
 * 이 턴의 경기 도구 — 감독 발화에는 지시·대화·마감, 손잡이 턴에는 마감. 킥오프 턴은 부르지 않는다.
 */
export function buildMatchTools(
  state: GameState,
  ctx: MatchToolContext,
  options: { operator?: boolean } = {},
): GameToolSpec[] {
  const finalize = MATCH_TOOL_DEFINITIONS.find((tool) => tool.name === "finalize_match")!;
  const tools: GameToolSpec[] = options.operator
    ? []
    : buildToolSpecs(state, ctx.calls).filter((tool) => tool.name === "update_character");
  if (!options.operator)
    tools.push(
      createInstructionTool(state, ctx.calls, {
        name: "tactic_orders",
        agent: "match-reader",
        said: ctx.said,
        boardMoves: ctx.boardMoves,
        allowed: () => dismissed(state, true) ?? undefined,
        description: MATCH_TOOL_DEFINITIONS.find((tool) => tool.name === "tactic_orders")!
          .description,
      }),
    );
  tools.push({
    ...finalize,
    handle: async (args: unknown) => {
      const parsed = MatchClosingSchema.safeParse(args);
      if (!parsed.success)
        return { ok: false, message: "경기 마감에는 출전 선수의 평점 설명만 제출하세요" };
      const pending = state.pendingMatch;
      if (!pending) return { ok: false, message: "마감할 경기가 없습니다" };
      if (pending.live.ledger.phase !== "finished" || awaitingShootout(state)) {
        return { ok: false, message: "아직 경기가 끝나지 않았습니다" };
      }
      const minute = pending.live.ledger.minute;
      const outcome = await finalizeMatchTurn(state, ctx.calls, ctx.finalizeEvaluator, parsed.data);
      if (!outcome) return { ok: false, message: "마감할 경기가 없습니다" };
      ctx.onFinalized?.(minute);
      return {
        ok: true,
        message: `경기 마감 — 결산 ${outcome.settled}명. 장부를 근거로 마무리 장면을 쓰세요.`,
      };
    },
  });
  return tools;
}
