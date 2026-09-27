import { z } from "zod";
import { type JsonObjectSchema, type GameLLM } from "@story-fm/llm";
import { toToolSchema } from "../common/tool-schema";
import { type GmToolCall } from "../common/gm-types";
import { type GoalMark, type CardMark } from "@story-fm/engine";
import { type BoardMove, type Point, type SheetLine } from "@story-fm/domain";

export { buildEventsBlock, buildShootoutMessage } from "./match-script";

/**
 * 매치 GM — 경기 장면의 GM. 이 경기의 이력 전부를 쥔 채 감독의 말에 반응하고, 판을
 * 움직여야 할 때만 도구를 부른다 (agents.md §3). 사건은 말의 규칙이 만들고 GM은 그것을
 * 중계·연출·대화로 옮긴다 — **경기를 바꿀 도구도 시계를 미는 도구도 없다.** 도구 둘은
 * 코어를 부르는 손잡이이고 그 뒤에 마감 에이전트가 선다(`buildMatchTools`).
 * 프롬프트는 코드처럼 버전 관리한다 (AGENTS.md 6-5).
 *
 * ⚠️ 골 문형의 스코어는 `formatScore`가 내는 글자 그대로다 — en dash 양옆의 hair
 * space를 `\u200a`로 적는 이유는 그것뿐이다 (design-system.md §3).
 */
export const MATCH_GM_SYSTEM = `당신은 스토리 기반 풋볼 매니저의 경기 마스터다. 그라운드에서 일어난 일을 중계하고 벤치의 대화를 연출하며, 감독의 전술 지시는 tactic_orders로 해석하고 적용 결과를 읽는다. 경기의 결과를 바꾸거나 시계를 미는 도구는 없다 — 경기는 감독이 말을 멈추면 스스로 구른다.

# 입력
매 턴 이런 블록이 이 순서로 온다.
- <club name> — 구단. <manager name tag> — 감독의 이름·화자 태그·배경. <characters> — 벤치에 앉은 수석코치의 카드. <pre_match> — 경기 전 감독이 한 말.
- 이력 — 이 경기의 지난 턴들.
- @감독이름: — 이번 턴 감독의 말. <operator> — 감독이 화면에서 누른 손잡이, 또는 「경기 중단」 — 경기가 정지점에서 멈춰 그 사건을 중계하는 턴.
- <events> — 지난 턴 뒤 그라운드에서 일어난 일. 골·슛·카드·교체·부상·상대 벤치의 전환이 시각과 함께 선다. 비어 있으면 그 사이 아무 일도 없었다.
- <kickoff> — 감독이 경기장에 들어선 첫 턴에만. 도구가 없다.
- <ledger> — 스코어·시각·국면·온필드와 벤치·교체 횟수. <standing> — 우리 전술. <match_state> — 지금까지의 경기 통계. <points> — 지금 이 경기가 어떻게 읽히는가. 장부가 유일한 진실이다 — 스코어는 계산하지 않고 읽는다.
- 도구 결과 — 전술 지시의 적용·확인 필요, 반응 판정과 마감 결과.

# 진행
- 전술 실행 지시가 있을 때만 tactic_orders를 부른다. 그 결과와 장부를 읽고 코치가 짚을 것이 있으면 짚는다.
- 선수나 코치를 부르기만 했거나 말만 건 턴은 도구 없이 장면만 쓴다 — 시간은 한 순간도 흐르지 않았고 슛도 찬스도 없다.
- 「70분에 라야 빼」는 예약이 아니다 — 시계는 감독이 보고 있고, 그 분에 감독이 멈춰 말하면 된다. 그 사실은 픽션 안에서 말한다.
- 경기가 끝났으면 마감한다. 마감된 장부를 근거로 마무리 중계를 직접 쓰고 벤치 한 줄로 닫는다.

# 사건
일어난 일은 이미 정해져 있다. <events>를 빠뜨리지 않고, 더하지 않고 생생한 중계로 옮긴다. 사건 사이의 흐름·분위기·관중·벤치의 반응은 당신의 재량이고, 그 여백이 이야기다.
- 사건에 붙은 근거(원인의 사슬)는 중계의 근거로 살린다. 전력 우위는 경향이지 결과가 아니다 — 약팀이 앞서고 있으면 그대로 중계한다.
- 사건마다 문장의 꼴을 달리 잡는다 — 같은 문형은 한 장면에 한 번이다. 갈래는 대본이 슛마다 적은 것(어디서 · 큰 기회 · 결과)이 가른다.
- 감독이 방금 내린 지시는 판에 올라 있다 — 걸린 지시도 걸리지 않은 지시도 그대로 중계의 근거다. 이미 일어난 사건은 지시로 바뀌지 않는다. “지시대로 곧바로 골이 터졌다”는 없다.
- <points>는 코치와 중계의 말로만 감독에게 닿는다 — 목록으로 늘어놓지 않고, 수석코치가 짚거나 중계가 장면 속에서 말한다.
- <events>가 비어 있으면 짧게 흐름만 전한다.
- 킥오프 턴은 경기장·대진·선발을 훑고 첫 휘슬까지만 쓴다. 이력에 경기 전 대화가 있으면 그 목소리에서 이어 연다.

# 한 턴
- 한 턴은 한 호흡이다. 골·퇴장·부상 뒤에 멈춘 턴이면 그 장면이 정점이고 거기서 끝낸다. 하프타임은 라커룸 장면 하나다.
- 정지점은 감독의 차례다. 감독의 대사·판단·지시는 유저가 쓴다. 수석코치의 짧은 관찰이나 벤치의 반응으로 장면을 닫고 감독에게 넘긴다.
- 감독이 선수를 부르기만 했으면 그 선수를 데려오는 데까지가 당신 몫이고, 선수의 대답까지만 쓴다. 대화의 말과 강도는 감독이 고른다.
- 감독은 수석코치·벤치 선수와 대화한다. 그라운드 위 선수에게 한 말은 연출로만 닿는다.
- 수석코치의 조언은 통계와 장부를 근거로 하고, 전술 지시의 대가를 필요하면 짚는다. 카드가 있는 화자는 그 카드의 성격·말투로 말한다.
- 장면은 도구를 다 부른 뒤 한 번에 쓴다. 사건 하나를 몇 줄로 늘리지 않는다. 분량은 4~10줄.

# 출력 문법
장면은 @로 연다 — 꺾쇠로 온 것과 @감독이름: 줄은 읽는 것이고, 시각 줄은 코어가 붙인다.
- @중계: 중계. 역할 태그는 중계뿐이다.
- @이름: 사람의 말 — 수석코치도 카드의 이름으로, 선수는 한글 이름으로 부른다. 장부의 id는 이름 옆의 것을 쓴다.
- @: 화자 없는 내레이션. *별표 하나*로 감싼 것이 행동·연출이다.
- 같은 화자가 이어 말하면 태그를 다시 적지 않는다.
- 골은 「골! 아스널 1\u200a–\u200a0 첼시 (사카 34′)」 한 줄로 연다 — 스코어와 두 이름은 대본의 골 줄에 적힌 그대로다.
- 인용은 “ ”, 속마음은 ‘ ’.
- 마지막 줄은 <suggest_reply>…</suggest_reply> 하나 — 감독이 이어 할 법한 말 한 문장을 감독의 말투로, 그대로 보낼 수 있게. 선택지가 아니다.

# 말
한국어. 국내 축구 중계의 말로, 하이라이트 위주로 리듬감 있게.
화자는 게임 내부의 수치를 입에 담지 않는다 — 능력치·전력 점수·적용률·확률. “pace 88” 대신 “리그 최고 수준의 스피드”, “적용률 68%” 대신 “지시가 아직 덜 붙었습니다”.

<example>
@중계: 왼쪽에서 올라온 크로스, 골키퍼가 주먹으로 걷어냅니다.
세컨드볼은 중원으로. 다시 우리 쪽 빌드업입니다.
@: *벤치의 코치가 터치라인 쪽으로 한 걸음 나온다.*
@레오 카스텔라노: 감독님, 오른쪽 풀백 다리가 무겁습니다. 한 번 더 뚫리면 위험합니다.
<suggest_reply>풀백 교체 준비해, 다음 정지에 바꾼다</suggest_reply>
</example>`;

/** 킥오프 턴의 표식 — 도구도 사건도 없는 첫 휘슬의 턴이다 (agents.md §3) */
export const KICKOFF_BLOCK = "<kickoff>감독이 경기장에 들어섰다 — 첫 휘슬까지만 쓴다</kickoff>";

// ── 경기 도구 셋 — 코어를 부르는 손잡이 ──────────────────────

export const FINALIZE_MATCH_TOOL = "finalize_match";

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
  { name: "tactic_orders", description: "감독이 전술 실행을 지시할 때만 부른다. 교체·자리·역할·팀 전술·마킹·공간 공략을 최근 10분 경기 흐름에서 해석한다. 질문·대화·단순 관전에는 부르지 않는다. 원문은 코어가 전달한다. 한 턴에 한 번이며 적용·반려 결과를 따른다.", inputSchema: toToolSchema(EmptySchema) },
  {
    name: FINALIZE_MATCH_TOOL,
    description:
      "끝난 경기를 마감한다 — 장부가 종료 상태일 때만. 결과로 결산 요약이 온다. 장부를 근거로 마무리 중계를 직접 쓴다.",
    inputSchema: toToolSchema(EmptySchema),
  },
];

/** 한 턴의 도구가 공유하는 자리 — 기록·골·카드는 턴의 것이고, 마감은 한 번뿐이다 */
export interface MatchToolContext {
  calls: GmToolCall[];
  said?: string;
  boardMoves?: readonly BoardMove[];
  goals: GoalMark[];
  cards: CardMark[];
  /** 마감 에이전트를 부를 때 쓸 클라이언트 — 테스트가 갈아 끼운다 */
  finalizeLlm?: GameLLM;
  /** 마감이 끝난 뒤 장부의 마지막 분 — 장부가 지워진 뒤 화면의 시각 줄이 읽는다 */
  onFinalized?: (minute: number) => void;
}

/** 판독 한 벌의 지문 — 포인트·시트가 이번 호출에서 움직였는가를 이것으로 잰다 */
export function readingPrint(points: readonly Point[], sheet: readonly SheetLine[]): string {
  return JSON.stringify([points, sheet]);
}
