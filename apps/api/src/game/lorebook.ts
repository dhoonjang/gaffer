import { z } from "zod";
import { editLorebook } from "@gaffer/agents";
import { completeCharacterUpdate, type GameState } from "@gaffer/engine";
import { llmErrorKind } from "@gaffer/llm";
export interface LoreTask {
  id: string;
  characterId: string;
}
export interface LorePatch {
  jobId: string;
  characterId: string;
  version: number;
  result: Awaited<ReturnType<typeof editLorebook>>;
}
export function loreTasks(state: GameState): LoreTask[] {
  const seen = new Set<string>();
  return state.lorebookJobs
    .filter((job) => {
      if (seen.has(job.characterId)) return false;
      seen.add(job.characterId);
      return job.attempts < 3;
    })
    .map((job) => ({ id: job.id, characterId: job.characterId }));
}
export async function edit(
  state: GameState,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const { id } = z.object({ id: z.string() }).parse(payload);
  const job = state.lorebookJobs.find((j) => j.id === id);
  const entry = job && state.lorebook.find((e) => e.id === job.characterId);
  if (!job || !entry) return { status: 200, body: { patch: null } };
  try {
    const result = await editLorebook(entry, job.additionalInformation);
    return {
      status: 200,
      body: {
        patch: {
          jobId: id,
          characterId: entry.id,
          version: entry.version,
          result,
        } satisfies LorePatch,
      },
    };
  } catch (error) {
    const kind = llmErrorKind(error);
    return {
      status:
        kind === "rate_limit"
          ? 429
          : ["timeout", "rate_limit", "overloaded", "network", "unknown"].includes(kind)
            ? 503
            : 422,
      body: { error: kind },
    };
  }
}
export function apply(state: GameState, value: unknown): boolean {
  // This payload is produced by our typed worker and stored in an immutable private object.
  const { patch } = value as { patch: LorePatch | null };
  if (!patch) return true;
  if (!state.lorebookJobs.some((j) => j.id === patch.jobId)) return true;
  return completeCharacterUpdate(state, patch.jobId, patch.version, patch.result);
}
