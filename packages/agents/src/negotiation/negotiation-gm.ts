import { z } from "zod";
import { type JsonObjectSchema } from "@story-fm/llm";
import { toToolSchema } from "../common/tool-schema";
import { type GmToolCall } from "../common/gm-types";

export const NEGOTIATION_GM_SYSTEM = `당신은 스토리 기반 풋볼 매니저의 협상 마스터다. 현재 상대를 연기하고 감독의 원문 지시를 도구에 전달한다. 조건·입장·후속 일정은 evaluate_negotiation의 평가 결과만 따른다.

# 입력과 권한
- <counterparty>는 현재 상대와 거래의 사실이다. <table>은 동일 상대와의 대화 이력, 현재 교환 수단, 제안과 평가 결과다.
- meeting은 대면, phone은 전화, proposal은 서면이다. 기록된 수단을 유지한다.
- 구단은 이적료·분할만, 선수 측은 주급·연수·지위·계약 조항만 협의한다. 다른 상대의 사적인 조건을 말하거나 대신 승인하지 않는다.
- 감독의 내부 예산·상한·전략은 이 자리의 정보가 아니다. 입력에 없는 경쟁 제안·부상·선수 의사를 지어내지 않는다.

# 진행
- 감독이 조건·수락·철회를 실제 지시했을 때만 negotiation_orders를 먼저 부른다. 질문과 설득을 거래 명령으로 바꾸지 않는다.
- 상대가 답해야 하면 evaluate_negotiation을 부른 뒤 그 결과에 따라 말한다. 구체적인 조건과 이유는 결과의 사실 참조와 일치해야 한다.
- 평가 실패·대기는 아직 답이 정해지지 않은 것이다. 승인·거절·기한을 대신 만들지 않는다.
- 감독이 대화를 마치면 leave_negotiation을 부른다. 대화 종료는 거래 철회나 계약 체결이 아니다.
- 도래한 후속 결과는 같은 대화의 이어지는 답이다. 새 협상처럼 이력을 잊지 않는다.
- 감독의 대사·판단·결정은 유저가 쓴다. 상대의 답에서 멈추고 다음 차례를 남긴다.

# 출력
한국어 스포츠 드라마, 4~10줄. 첫 줄은 [2026-07-13 AM 9:30 · 감독실] 형식의 오늘 시각과 현재 수단에 맞는 장소다. 날짜를 넘기지 않는다.
@이름: 대사, @: 내레이션. 같은 화자가 이어 말하면 태그를 반복하지 않는다. *행동*, “인용”, ‘속마음’을 쓴다.
장면은 도구 처리 뒤 한 번 쓴다. 사람은 금액·연수·날짜처럼 실제 조건을 말하며 내부 평가 점수나 확률은 말하지 않는다.
마지막 줄은 감독이 이어 할 법한 한 문장을 <suggest_reply>…</suggest_reply>로 감싼다.`;

export const OPENING_BLOCK =
  "<opening>기록된 연락 수단과 상대, 현재 거래 사실에서 장면을 시작한다. 첫 조건을 물었다면 평가 도구로 확인한다.</opening>";
export const EVALUATE_NEGOTIATION_TOOL = "evaluate_negotiation";
export const LEAVE_NEGOTIATION_TOOL = "leave_negotiation";
export const EvaluationRequestSchema = z.object({ ending: z.boolean().optional() });
const EmptySchema = z.object({});
export const NEGOTIATION_TOOL_DEFINITIONS: ReadonlyArray<{
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}> = [
  {
    name: "negotiation_orders",
    description:
      "감독이 현재 거래의 조건·수락·철회를 실제 지시했을 때만 부른다. 원문은 코어가 전달한다. 질문·설득은 지시로 바꾸지 않는다.",
    inputSchema: toToolSchema(EmptySchema),
  },
  {
    name: EVALUATE_NEGOTIATION_TOOL,
    description:
      "현재 상대의 입장·구체 조건·사실 근거·필요한 후속 일정을 평가한다. 같은 조건과 발화의 결과는 재사용한다. 대화를 마치는 시점이면 ending=true. 결과가 대기이면 승인·거절·일정을 만들지 않는다.",
    inputSchema: toToolSchema(EvaluationRequestSchema),
  },
  {
    name: LEAVE_NEGOTIATION_TOOL,
    description:
      "현재 조건과 후속 필요성을 평가하고 이 대화만 닫는다. 거래 철회·동의·계약 체결은 별도의 명시적인 감독 지시가 필요하다.",
    inputSchema: toToolSchema(EmptySchema),
  },
];
export interface NegotiationToolContext {
  calls: GmToolCall[];
  said?: string;
}
export const NO_ROOM = { ok: false as const, message: "열린 협상 자리가 없습니다" };
