import {
  CharacterBookEditSchema,
  type CharacterBookEntry,
  type CharacterBookEdit,
} from "@story-fm/domain";
import { agentConfig, createGameLLM, resolveLlmMode, type GameLLM } from "@story-fm/llm";
import { readOutput, retryOnce } from "../common/retry";
import { toToolSchema } from "../common/tool-schema";

export const CHARACTER_BOOK_EDITOR_SYSTEM = `당신은 캐릭터북 편집자다.
기존 항목과 추가 정보를 합쳐 키워드 목록, 한 줄 설명, 자유 형식 정보를 다시 쓴다.
기존 정보의 중요한 맥락과 인물의 일관성을 보존하고 달라진 내용은 고친다. 중복은 합친다.
추가 정보에 없는 사건을 만들지 않는다. 이름을 바꾸지 않는다.
키워드는 이 항목을 불러올 구체적인 이름·별칭·표현이다. 한 줄 설명은 처음 이 사람을 쓰는 GM을 위한 소개다.
정보에는 정해진 항목이나 관계·감정 등급이 없다. 판단과 기억은 그 인물의 관점과 근거가 드러나게 쓴다.`;

export const CHARACTER_BOOK_EDITOR_OUTPUT = toToolSchema(CharacterBookEditSchema);

export async function editCharacterBook(
  entry: CharacterBookEntry,
  additionalInformation: string,
  llm?: GameLLM,
): Promise<CharacterBookEdit> {
  if (!llm && resolveLlmMode() === "mock")
    return CharacterBookEditSchema.parse({
      keywords: entry.keywords,
      description: entry.description,
      information: `${entry.information}\n${additionalInformation}`,
    });
  let edited: CharacterBookEdit | undefined;
  await retryOnce(
    "character-book-editor",
    async () => {
      const client = llm ?? createGameLLM(agentConfig("character-book-editor"));
      const result = await client.runTurn({
        system: CHARACTER_BOOK_EDITOR_SYSTEM,
        history: [],
        user: JSON.stringify({ existing: entry, additionalInformation }),
        outputSchema: CHARACTER_BOOK_EDITOR_OUTPUT,
      });
      edited = readOutput("character-book-editor", CharacterBookEditSchema, result);
    },
    () => edited !== undefined,
  );
  if (!edited) throw new Error("캐릭터북 편집 결과가 없습니다");
  return edited;
}
