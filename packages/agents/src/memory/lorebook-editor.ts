import { LorebookEditSchema, type LorebookEntry, type LorebookEdit } from "@gaffer/domain";
import { agentConfig, createGameLLM, resolveLlmMode, type GameLLM } from "@gaffer/llm";
import { readOutput, retryOnce } from "../shared/retry";
import { toToolSchema } from "../shared/tool-schema";

export const LOREBOOK_EDITOR_SYSTEM = `당신은 로어북 편집자다.
기존 항목과 추가 정보를 합쳐 키워드 목록, 한 줄 설명, 자유 형식 정보를 다시 쓴다.
기존 정보의 중요한 맥락과 인물의 일관성을 보존하고 달라진 내용은 고친다. 중복은 합친다.
추가 정보에 없는 사건을 만들지 않는다. 이름을 바꾸지 않는다.
키워드는 이 항목을 불러올 구체적인 이름·별칭·표현이다. 한 줄 설명은 바뀌지 않는 기본 정보만 담는다 — 국적·출생연도·직책 같은 것. 소속·포지션·나이·성적처럼 바뀌는 사실과 성격·동기·각오는 정보에 쓴다.
정보에는 정해진 항목이나 관계·감정 등급이 없다. 판단과 기억은 그 인물의 관점과 근거가 드러나게 쓴다.`;

export const LOREBOOK_EDITOR_OUTPUT = toToolSchema(LorebookEditSchema);

export async function editLorebook(
  entry: LorebookEntry,
  additionalInformation: string,
  llm?: GameLLM,
): Promise<LorebookEdit> {
  if (!llm && resolveLlmMode() === "mock")
    return LorebookEditSchema.parse({
      keywords: entry.keywords,
      description: entry.description,
      information: `${entry.information}\n${additionalInformation}`,
    });
  let edited: LorebookEdit | undefined;
  await retryOnce(
    "lorebook-editor",
    async () => {
      const client = llm ?? createGameLLM(agentConfig("lorebook-editor"));
      const result = await client.runTurn({
        system: LOREBOOK_EDITOR_SYSTEM,
        history: [],
        user: JSON.stringify({ existing: entry, additionalInformation }),
        outputSchema: LOREBOOK_EDITOR_OUTPUT,
      });
      edited = readOutput("lorebook-editor", LorebookEditSchema, result);
    },
    () => edited !== undefined,
  );
  if (!edited) throw new Error("로어북 편집 결과가 없습니다");
  return edited;
}
