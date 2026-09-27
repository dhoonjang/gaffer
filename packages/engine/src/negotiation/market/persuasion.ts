import type { PitchClaim } from "@story-fm/domain";

/** 말은 기록이며 점수가 아니다. 반복해도 같은 문장을 장부에 중복 저장하지 않는다. */
export function pitchNotes(claims: readonly PitchClaim[]): string[] {
  return [...new Set(claims.map((claim) => claim.note.trim()).filter(Boolean))];
}
