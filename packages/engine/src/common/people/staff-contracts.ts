import { contractUntil } from "../core/dates";
import type { GameState } from "../core/state";

/** 계약의 길이 — 스태프는 두 시즌씩 맺는다 (people.md §2-2) */
export const STAFF_CONTRACT_SEASONS = 2;

/**
 * 만료된 스태프 계약은 **같은 조건으로 갱신된다** (people.md §2-2).
 *
 * 자동으로 비우면 감독이 모르는 사이 의무실에 아무도 없는 세이브가 생긴다. 수석코치도
 * 같은 문을 지난다 — 그의 계약도 구단의 것이다.
 *
 * @param on 새로 시작하는 시즌의 첫날 — 시즌 전환이 넘긴다
 */
export function renewStaffContracts(state: GameState, on: string): string[] {
  const renewed: string[] = [];
  for (const persona of state.personas) {
    const employment = persona.employment;
    if (employment === undefined) continue;
    if (employment.contract.until > on) continue;
    employment.contract = {
      salary: employment.contract.salary,
      until: contractUntil(on, STAFF_CONTRACT_SEASONS),
    };
    renewed.push(persona.name);
  }
  return renewed;
}
