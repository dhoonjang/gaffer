import { completeCharacterUpdate, loadGame, saveGame } from "@gaffer/engine";
import { editLorebook } from "@gaffer/agents";
import { noteTurn, noteFact, traceBoard, withGameUsage } from "@gaffer/llm";
import { withGameLock } from "./turn-runner";

const running = new Map<string, Promise<void>>();
const EDIT_LOCK_WAIT_MS = 15_000;

/** Network work runs outside the save lock; completion reloads the latest save. */
export function processLorebookJobs(id: string): Promise<void> {
  const active = running.get(id);
  if (active) return active;
  const work = withGameUsage(id, () =>
    traceBoard(id, async () => {
      noteTurn({ input: { kind: "lorebook-editor" } });
      const attempted = new Set<string>();
      while (true) {
        const next = await withGameLock(id, EDIT_LOCK_WAIT_MS, async () => {
          const state = loadGame(id);
          if (!state) return null;
          const blocked = new Set<string>();
          for (const job of state.lorebookJobs) {
            if (blocked.has(job.characterId)) continue;
            blocked.add(job.characterId);
            if (attempted.has(job.id)) continue;
            const entry = state.lorebook.find((row) => row.id === job.characterId);
            if (entry)
              return { job: { ...job }, entry: { ...entry, keywords: [...entry.keywords] } };
          }
          return null;
        });
        if (!next) return;
        attempted.add(next.job.id);
        try {
          const result = await editLorebook(next.entry, next.job.additionalInformation);
          await withGameLock(id, EDIT_LOCK_WAIT_MS, async () => {
            const state = loadGame(id);
            if (!state) return;
            if (completeCharacterUpdate(state, next.job.id, next.entry.version, result)) {
              saveGame(state);
              noteFact("lorebook.updated", {
                jobId: next.job.id,
                characterId: next.entry.id,
                version: next.entry.version + 1,
              });
            }
          });
        } catch (error: unknown) {
          await withGameLock(id, EDIT_LOCK_WAIT_MS, async () => {
            const state = loadGame(id);
            const job = state?.lorebookJobs.find((row) => row.id === next.job.id);
            if (!state || !job) return;
            job.status = "failed";
            job.attempts += 1;
            job.error = error instanceof Error ? error.message : String(error);
            saveGame(state);
          });
        }
      }
    }),
  )
    .catch((error: unknown) => {
      console.warn(`[lorebook] 갱신 작업을 유지합니다 (${id}):`, error);
    })
    .finally(() => {
      running.delete(id);
    });
  running.set(id, work);
  return work;
}
