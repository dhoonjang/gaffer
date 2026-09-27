import { z } from "zod";

/** 감독이 실제로 한 설득의 말. 의미와 설득력은 상대 GM이 맥락에서 판단한다. */
export const PitchClaimSchema = z.object({
  note: z.string().trim().min(1).max(500).describe("감독이 실제로 든 이유나 약속 — 자유로운 문장"),
});
export type PitchClaim = z.infer<typeof PitchClaimSchema>;
export const MAX_PITCH_CLAIMS = 4;
