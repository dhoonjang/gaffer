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

export const HISTORY_COMPACTOR_SYSTEM = `당신은 구단의 기록 담당이다.
이력에서 접히는 원문과 이전 요약을 합쳐 다시 요약한다.
- past는 지난 결정과 이유, 사건의 흐름이다. ${HISTORY_DIGEST_CHARS}자 이내.
- open은 아직 끝나지 않은 대화·의도·갈등·이야기다. ${HISTORY_OPEN_CHARS}자 이내. 끝난 일은 past로 옮기거나 지운다.
- 장부에 있는 수치와 현재 상태는 복사하지 않는다. [장부] 사실과 원문에 없는 일을 만들지 않는다.
- candidates는 앞으로 장면에 활용할 만한 인물 최대 ${CHARACTER_CANDIDATES_MAX}명의 이름과 한 줄 설명이다. 제공된 후보 색인에서 고르고 같은 이름은 한 번만 쓴다.
- 후보 목록은 등장 의무가 아니다. 기존 이야기에 이어질 사람과 새로운 장면에 활용할 사람을 함께 고려한다.`;

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
