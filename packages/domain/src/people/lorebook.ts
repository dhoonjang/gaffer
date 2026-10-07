import { z } from "zod";

export const CHARACTER_INFORMATION_MAX = 12_000;
export const CHARACTER_CANDIDATES_MAX = 30;

export const LorebookContentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  keywords: z.array(z.string().trim().min(1).max(120)).max(40),
  description: z.string().trim().min(1).max(240),
  information: z.string().trim().min(1).max(CHARACTER_INFORMATION_MAX),
});
export type LorebookContent = z.infer<typeof LorebookContentSchema>;
export const LorebookEditSchema = LorebookContentSchema.omit({ name: true });
export type LorebookEdit = z.infer<typeof LorebookEditSchema>;
export const LorebookEntrySchema = LorebookContentSchema.extend({
  id: z.string().min(1),
  version: z.number().int().min(1),
  kind: z.enum(["team", "player", "person"]),
});
export type LorebookEntry = z.infer<typeof LorebookEntrySchema>;
/** Previous versions and their source input remain recoverable after a rewrite. */
export const LorebookRevisionSchema = z.object({
  jobId: z.string().min(1),
  previous: LorebookEntrySchema,
  additionalInformation: z.string().min(1).max(CHARACTER_INFORMATION_MAX),
});
export type LorebookRevision = z.infer<typeof LorebookRevisionSchema>;

/**
 * 주입된 항목 — 그 순간의 원장 사실 한 줄(`now`)을 함께 든다. 주입한 순간에 만들어 턴
 * 기록에 남으므로 이력을 다시 그려도 같은 글자다. 붙일 사실이 없으면 빈 문자열이다.
 */
export const LorebookInjectionSchema = LorebookEntrySchema.extend({ now: z.string() });
export type LorebookInjection = z.infer<typeof LorebookInjectionSchema>;
export const CharacterCandidateSchema = LorebookContentSchema.pick({
  name: true,
  description: true,
});
export type CharacterCandidate = z.infer<typeof CharacterCandidateSchema>;
export const LorebookJobSchema = z.object({
  id: z.string().min(1),
  characterId: z.string().min(1),
  additionalInformation: z.string().trim().min(1).max(CHARACTER_INFORMATION_MAX),
  status: z.enum(["pending", "failed"]),
  attempts: z.number().int().min(0),
  error: z.string().optional(),
});
export type LorebookJob = z.infer<typeof LorebookJobSchema>;
export const CharacterUpdateSchema = z.object({
  characterId: z.string().min(1).describe("Lorebook entry id or name"),
  additionalInformation: LorebookJobSchema.shape.additionalInformation,
  newCharacter: LorebookContentSchema.optional().describe(
    "Entry for a person appearing for the first time. Omit for existing people",
  ),
});

/** Stable rendering is also used to measure the history budget. */
export function lorebookText(entries: readonly LorebookInjection[]): string {
  if (entries.length === 0) return "";
  return `<lorebook>\n${entries
    .map((entry) =>
      JSON.stringify({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        ...(entry.now ? { now: entry.now } : {}),
        information: entry.information,
      }),
    )
    .join("\n")}\n</lorebook>`;
}
