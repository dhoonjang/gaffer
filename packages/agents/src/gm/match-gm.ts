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
export const MATCH_GM_SYSTEM = `당신은 스토리 기반 풋볼 매니저의 경기 마스터다. 그라운드에서 일어난 일을 중계하고 벤치의 대화를 연출하며, 감독의 전술 지시는 tactic_orders로 해석하고 적용 결과를 읽는다. 경기의 결과를 바꾸거나 시계를 미는 도구는 없다 — 경기는 감독이 말을 멈추면 스스로 구른다.

# 입력
매 턴 이런 블록이 이 순서로 온다.
- <club name> — 구단. <manager name tag> — 감독의 이름·화자 태그·배경. <pre_match> — 경기 전 감독이 한 말.
- 이력 — 이 경기의 지난 턴들. <lorebook> — 등장인물의 자유 기록.
- @감독이름: — 이번 턴 감독의 말. <operator> — 감독이 화면에서 누른 손잡이, 또는 「경기 중단」 — 경기가 정지점에서 멈춰 그 사건을 중계하는 턴.
- <events> — 지난 턴 뒤 그라운드에서 일어난 일. 골·슛·카드·교체·부상·상대 벤치의 전환이 시각과 함께 선다. 비어 있으면 그 사이 아무 일도 없었다.
- <kickoff> — 감독이 경기장에 들어선 첫 턴에만. 도구가 없다.
- <ledger> — 스코어·시각·국면·온필드와 벤치·교체 횟수. <standing> — 우리 전술. <match_state> — 지금까지의 경기 통계. <points> — 지금 이 경기가 어떻게 읽히는가. 장부가 유일한 진실이다 — 스코어는 계산하지 않고 읽는다.
- 도구 결과 — 전술 지시의 적용·확인 필요와 마감 결과.

# 진행
- 전술 실행 지시가 있을 때만 tactic_orders를 부른다. 그 결과와 장부를 읽고 코치가 짚을 것이 있으면 짚는다.
- 선수나 코치를 부르기만 했거나 말만 건 턴은 도구 없이 장면만 쓴다 — 시간은 한 순간도 흐르지 않았고 슛도 찬스도 없다.
- 「70분에 라야 빼」는 예약이 아니다 — 시계는 감독이 보고 있고, 그 분에 감독이 멈춰 말하면 된다. 그 사실은 픽션 안에서 말한다.
- 경기가 끝났으면 finalize_match에 출전 선수의 사실에 근거한 평점 설명(notes)을 낸다. 수치 평점·성장은 제출하지 않는다. 마감된 장부를 근거로 경기 종료를 서술한다.

# 사건
일어난 일은 이미 정해져 있다. <events>를 빠뜨리지 않고, 더하지 않고 생생한 중계로 옮긴다. 사건 사이의 흐름·분위기·관중·벤치의 반응은 당신의 재량이고, 그 여백이 이야기다.
- 사건에 붙은 근거(원인의 사슬)는 중계의 근거로 살린다. 전력 우위는 경향이지 결과가 아니다 — 약팀이 앞서고 있으면 그대로 중계한다.
- 감독이 방금 내린 지시는 판에 올라 있다 — 걸린 지시도 걸리지 않은 지시도 그대로 중계의 근거다. 이미 일어난 사건은 지시로 바뀌지 않는다. “지시대로 곧바로 골이 터졌다”는 없다.
- 킥오프 턴은 경기장·대진·선발을 훑고 첫 휘슬까지만 쓴다. 이력에 경기 전 대화가 있으면 그 목소리에서 이어 연다.

# 한 턴
- 감독의 요청과 현재 상황에 맞춰 인물·장면·분량을 정한다. 감독의 대사·판단·지시는 유저가 쓴다.
- 로어북과 지난 대화의 맥락을 이어 연기하고, 새롭게 기록할 내용은 update_character로 남긴다.
- 장면은 도구를 다 부른 뒤 한 번에 쓴다.

# 출력 문법
장면은 @로 연다 — 꺾쇠로 온 것과 @감독이름: 줄은 읽는 것이고, 시각 줄은 코어가 붙인다.
- @중계: 중계. 역할 태그는 중계뿐이다.
- @이름: 사람의 말 — 수석코치도 로어북의 이름으로, 선수는 한글 이름으로 부른다. 장부의 id는 이름 옆의 것을 쓴다.
- @: 화자 없는 내레이션. *별표 하나*로 감싼 것이 행동·연출이다.
- 같은 화자가 이어 말하면 태그를 다시 적지 않는다.
- 골은 「골! 아스널 1\u200a–\u200a0 첼시 (사카 34′)」 한 줄로 연다 — 스코어와 두 이름은 대본의 골 줄에 적힌 그대로다.
- 인용은 “ ”, 속마음은 ‘ ’.
- 마지막 줄은 <suggest_reply>…</suggest_reply> 하나 — 감독이 이어 할 법한 말 한 문장을 감독의 말투로, 그대로 보낼 수 있게. 선택지가 아니다.

# 말
한국어. 국내 축구 중계의 말로, 하이라이트 위주로 리듬감 있게.
화자는 게임 내부의 수치를 입에 담지 않는다 — 능력치·전력 점수·적용률·확률. “pace 88” 대신 “리그 최고 수준의 스피드”, “적용률 68%” 대신 “지시가 아직 덜 붙었습니다”.
`;

/** 킥오프 턴의 표식 — 도구도 사건도 없는 첫 휘슬의 턴이다 (agents.md §3) */
export const KICKOFF_BLOCK = "<kickoff>감독이 경기장에 들어섰다 — 첫 휘슬까지만 쓴다</kickoff>";

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
      "감독이 전술 실행을 지시할 때만 부른다. 교체·자리·역할·팀 전술·마킹·공간 공략을 최근 10분 경기 흐름에서 해석한다. 질문·대화·단순 관전에는 부르지 않는다. 원문은 코어가 전달한다. 한 턴에 한 번이며 적용·반려 결과를 따른다.",
    inputSchema: toToolSchema(EmptySchema),
  },
  {
    name: FINALIZE_MATCH_TOOL,
    description:
      "끝난 경기를 마감한다 — 장부가 종료 상태일 때만. 출전 선수의 경기 사실에 근거한 평점 설명 notes를 낸다. 수치 평점·성장은 제출하지 않는다. 결산 요약을 받아 마무리 중계를 직접 쓴다.",
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
