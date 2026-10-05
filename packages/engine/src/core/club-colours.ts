import { type ClubColours } from "@gaffer/domain";
import { teamCatalogById } from "./catalog/team-catalog";

/** 구단의 공식 색 — 카탈로그가 갖고 세이브는 갖지 않는다 (team.md §3.1) */
export function clubColoursOf(teamId: string): ClubColours | undefined {
  return teamCatalogById(teamId)?.colours;
}

/** 팀 id 목록 → 공식 색 사전. 색이 없는 클럽은 열쇠도 없다 */
export function clubColoursIn(teamIds: readonly string[]): Record<string, ClubColours> {
  const out: Record<string, ClubColours> = {};
  for (const id of new Set(teamIds)) {
    const colours = clubColoursOf(id);
    if (colours !== undefined) out[id] = colours;
  }
  return out;
}
