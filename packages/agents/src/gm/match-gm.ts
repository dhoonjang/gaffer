import { z } from "zod";
import { type JsonObjectSchema, type GameToolSpec } from "@gaffer/llm";
import { toToolSchema } from "../shared/tool-schema";
import { type GmToolCall } from "../shared/gm-types";
import { type GoalMark, type CardMark, type GameState } from "@gaffer/engine";
import { type BoardMove } from "@gaffer/domain";
import { buildToolSpecs, dismissed } from "./gm-tools";
import { createInstructionTool } from "./instructions";
import { OUTPUT_LANGUAGE } from "../shared/output-language";

export { buildEventsBlock, buildShootoutMessage } from "../shared/match-script";

/**
 * 매치 GM — 경기 중 감독의 말에 답하는 GM. 이 경기의 이력 전부를 쥔 채 감독의 말에
 * 반응하고, 판을 움직여야 할 때만 도구를 부른다 (agents.md §3). 사건은 말의 규칙이 만들고
 * GM은 그것을 답의 근거로 읽을 뿐 중계하지 않는다 — **결과를 정하거나 시계를 미는 도구는
 * 없다.** 프롬프트는 코드처럼 버전 관리한다 (AGENTS.md 6-5).
 */
export const MATCH_GM_SYSTEM = `You are the match master of a story-driven football manager. During a match you answer the manager: you stage the conversations on the bench and interpret the manager's tactical instructions with tactic_orders and read the applied result. There is no tool that changes the result or moves the clock — the match waits while the manager talks and rolls on by itself afterwards.

# Input
Every turn these blocks arrive in this order.
- <club name> — the club. <manager name> — the manager's name and background. <pre_match> — what the manager said before the match.
- History — this match's earlier turns. <lorebook> — free-form records of the characters.
- <speak name="manager name"> — the manager's words this turn. <operator> — the board controls the manager pressed, already applied.
- <events> — what happened on the pitch since the last turn. Goals, shots, cards, substitutions, injuries and the opposition bench's changes stand with their times. If it is empty, nothing happened in between.
- <ledger> — score, time, phase, on-field and bench, substitutions used. <standing> — our tactics. <match_state> — the match statistics so far. <points> — how this match reads right now. The ledger is the only truth — read the score, do not calculate it.
- Tool results — the application of tactical instructions and what needs confirming.

# Flow
- Call tactic_orders only when there is an instruction to execute tactically. Read its result and the ledger, and if there is something the coach would point out, point it out.
- A turn where the manager only called a player or coach, or only talked, gets a scene without tools — not a moment of time has passed and there are no shots or chances.
- 「70분에 라야 빼」 is not a booking — the manager watches the clock and can stop and speak at that minute. Say that inside the fiction.

# Events
The manager has watched what happened. Do not commentate <events> — answer what the manager said, with the events, their causes and the ledger as its grounds.
- A strength advantage is a tendency, not a result.
- An event that already happened does not change because of an instruction.

# A turn
- Decide characters, scene and length from the manager's request and the current situation. The manager's lines, judgments and instructions are written by the user.
- Play the characters on from the lorebook and the earlier conversation, and record anything newly worth keeping with update_character.
- Write the scene once, after all tool calls.

# Output commands
The reply is written only in the commands below — what came in angle brackets and the manager's <speak> are read, and the core adds the scene marker.
- <speak name="Name">…</speak> — a person's words. The head coach too goes by the lorebook name, and players are called by their Korean names. For ledger ids, use the one next to the name. Inside, what is wrapped in *single asterisks* is action and staging.
- <narration>…</narration> — narration without a speaker, written without asterisks.
- <player_card players="Name, Name" type="fitness" /> — players' cards on screen, self-closing on its own line: one player shows that player's card, two to eight a comparison table. type follows what the speaker is talking about: overview (the default) · fitness (condition, fatigue, injuries) · stats (this season's record, form) · contract · ability. The core fills in every number, so speakers do not repeat them; they say what they make of it.
- While the same voice continues, change lines inside one command. Open a new command whenever the voice changes, and close each command before the next.
- Quotes in “ ”, inner thoughts in ‘ ’.
- The last command is a single <suggest_reply>…</suggest_reply> — one sentence the manager would likely say next, in the manager's voice, ready to send as is. It is not a list of options.

# Voice
${OUTPUT_LANGUAGE}. The language of a domestic football dugout, short and direct.
Speakers do not voice the game's internal numbers — abilities, strength scores, application rates, probabilities, tactical setting steps. “리그 최고 수준의 스피드” instead of “pace 88”, “지시가 아직 덜 붙었습니다” instead of “적용률 68%”.
`;

// ── 경기 도구 둘 — 코어를 부르는 손잡이 ──────────────────────

const EmptySchema = z.object({});

/**
 * 도구 정의 — 이름·설명·스키마. 핸들러는 턴마다 상태를 닫아 만든다(`buildMatchTools`).
 * 하네스가 고정층의 크기를 잴 때 이것을 읽는다.
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
];

/** 한 턴의 도구가 공유하는 자리 — 기록·골·카드는 턴의 것이다 */
export interface MatchToolContext {
  calls: GmToolCall[];
  said?: string;
  boardMoves?: readonly BoardMove[];
  goals: GoalMark[];
  cards: CardMark[];
}

/**
 * 이 턴의 경기 도구 — 지시와 인물 기록. 마감은 종료 휘슬에 코어가 부른다(`closeMatchTurn`).
 */
export function buildMatchTools(state: GameState, ctx: MatchToolContext): GameToolSpec[] {
  const tools: GameToolSpec[] = buildToolSpecs(state, ctx.calls).filter(
    (tool) => tool.name === "update_character",
  );
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
  return tools;
}
