import { LorebookEditSchema, type LorebookEntry, type LorebookEdit } from "@gaffer/domain";
import { agentConfig, createGameLLM, resolveLlmMode, type GameLLM } from "@gaffer/llm";
import { readOutput, retryOnce } from "../shared/retry";
import { toToolSchema } from "../shared/tool-schema";
import { OUTPUT_LANGUAGE } from "../shared/output-language";

export const LOREBOOK_EDITOR_SYSTEM = `You are the lorebook editor.
Combine the existing entry and the additional information and rewrite the keyword list, one-line description and free-form information, in ${OUTPUT_LANGUAGE}.
Keep the important context of the existing information and the person's consistency, and correct what has changed. Merge duplicates.
Do not invent events not in the additional information. Do not change names.
Keywords are the concrete names, nicknames and expressions that should bring up this entry. The one-line description holds only fixed basics — nationality, birth year, job title and the like. Changing facts such as club, position, age and form, and personality, motives and resolve go in the information.
The information has no fixed fields and no relationship or emotion grades. Write judgments and memories so the person's viewpoint and grounds show.`;

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
