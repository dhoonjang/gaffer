import { z } from "zod";
import {
  CharacterCandidateSchema,
  CHARACTER_CANDIDATES_MAX,
  type CharacterCandidate,
} from "@gaffer/domain";
import {
  HISTORY_DIGEST_CHARS,
  HISTORY_OPEN_CHARS,
  applyHistoryDigest,
  planHistoryFold,
  characterCandidates,
  type GameState,
  type HistoryFoldBrief,
} from "@gaffer/engine";
import { agentConfig, createGameLLM, resolveLlmMode, type GameLLM } from "@gaffer/llm";
import { ModelOutputError, readOutput, retryOnce } from "../shared/retry";
import { toToolSchema } from "../shared/tool-schema";
import { OUTPUT_LANGUAGE } from "../shared/output-language";

export const HISTORY_COMPACTOR_SYSTEM = `You keep the club's records.
Combine the raw text folding out of the history with the previous summary and summarize again, in ${OUTPUT_LANGUAGE}.
- past is past decisions and their reasons, and the flow of events. Within ${HISTORY_DIGEST_CHARS} characters.
- open is conversations, intentions, conflicts and stories not yet finished. Within ${HISTORY_OPEN_CHARS} characters. Move finished matters to past or drop them.
- Do not copy numbers and current state that are in the ledger. Do not invent [장부] facts or anything not in the raw text.
- candidates are the names and one-line descriptions of up to ${CHARACTER_CANDIDATES_MAX} people worth using in coming scenes. Pick from the provided candidate index and use each name once.
- The candidate list is not an obligation to appear. Consider both people who continue existing stories and people to use in new scenes.`;

const ReportInputSchema = z.object({
  past: z.string().trim().min(1).max(HISTORY_DIGEST_CHARS),
  open: z.string().trim().max(HISTORY_OPEN_CHARS).optional(),
  candidates: z.array(CharacterCandidateSchema).max(CHARACTER_CANDIDATES_MAX),
});
export const REPORT_DIGEST_INPUT = toToolSchema(ReportInputSchema);

function buildCompactionPrompt(
  state: {
    historyDigest?:
      { open?: string | undefined; candidates?: CharacterCandidate[] | undefined } | undefined;
  },
  brief: HistoryFoldBrief,
  candidates: readonly CharacterCandidate[] = [],
): string {
  const blocks: string[] = [];
  if (brief.previous !== null) {
    blocks.push("## 이전 요약", brief.previous, state.historyDigest?.open ?? "");
  }
  blocks.push("## 활용 가능한 인물 — 이름과 한 줄 설명", JSON.stringify(candidates));
  blocks.push("## 접히는 대화");
  for (const turn of brief.turns)
    blocks.push(`### ${turn.at} · ${turn.role}`, turn.text, ...turn.facts);
  return blocks.join("\n");
}

export async function compactHistory(
  state: GameState,
  llm?: GameLLM,
): Promise<{ folded: boolean }> {
  if (!llm && resolveLlmMode() === "mock") return { folded: false };
  const brief = planHistoryFold(state);
  if (!brief) return { folded: false };
  const candidates = characterCandidates(state);
  let folded = false;
  await retryOnce(
    "compactor:history",
    async () => {
      const client = llm ?? createGameLLM(agentConfig("history-compactor"));
      const answer = await client.runTurn({
        system: HISTORY_COMPACTOR_SYSTEM,
        history: [],
        user: buildCompactionPrompt(state, brief, candidates),
        outputSchema: REPORT_DIGEST_INPUT,
      });
      const data = readOutput("compactor:history", ReportInputSchema, answer);
      const known = new Map(candidates.map((candidate) => [candidate.name, candidate]));
      const seen = new Set<string>();
      const selected = data.candidates.flatMap(({ name }) => {
        const candidate = known.get(name);
        if (!candidate || seen.has(name)) return [];
        seen.add(name);
        return [candidate];
      });
      for (const candidate of candidates) {
        if (selected.length >= CHARACTER_CANDIDATES_MAX) break;
        if (!seen.has(candidate.name)) {
          selected.push(candidate);
          seen.add(candidate.name);
        }
      }
      folded = applyHistoryDigest(state, brief, {
        past: data.past,
        open: data.open,
        candidates: selected,
      });
      if (!folded) throw new ModelOutputError("요약을 반영하지 못했습니다");
    },
    () => folded,
  ).catch((error: unknown) => {
    console.warn("[compactor:history] 요약되지 않은 원문을 유지합니다:", error);
  });
  return { folded };
}
