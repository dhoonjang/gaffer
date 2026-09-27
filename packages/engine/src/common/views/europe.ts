/** 이번 시즌 대항전 참가 팀 — 추첨은 이미 일어난 사실이라 세이브에 남는다 */
export interface EuroEntry {
  cupId: string;
  teams: string[];
}

/** 세이브에 남은 이번 시즌 참가 팀 */
export function entrantsOf(entrants: EuroEntry[], cupId: string): string[] {
  return entrants.find((e) => e.cupId === cupId)?.teams ?? [];
}

/** 이 팀이 이번 시즌 나가는 대항전 (없으면 null) — 브리핑·서사용 */
export function euroCompetitionOf(entrants: EuroEntry[], teamId: string): string | null {
  return entrants.find((e) => e.teams.includes(teamId))?.cupId ?? null;
}
