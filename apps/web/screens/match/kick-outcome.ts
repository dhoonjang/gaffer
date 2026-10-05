export function kickOutcome(kick: { outcome: string; keeper?: string | null }): string {
  if (kick.outcome === "scored") return "성공";
  if (kick.outcome === "saved") return kick.keeper ? `${kick.keeper} 선방` : "선방";
  return "실축";
}
