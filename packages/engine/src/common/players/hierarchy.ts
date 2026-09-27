import type { GamePlayer, LeaderRole } from "@story-fm/domain";
import { ageOf, RATING_MAX, standingScore } from "@story-fm/domain";
import { playersOf, squadLevelOf, type GameState } from "../core/state";

/**
 * 라커룸 서열 — **저장하지 않고 파생한다** (→ docs/story/people.md §5-1).
 *
 * 감독이 정하는 것은 완장 둘(주장·부주장)뿐이고, 나머지 서열은 리더십·나이·그 셔츠의
 * 출전·재적 시즌에서 나온다. 저장하면 영입·출전·시즌 롤오버마다 갱신해 줄 자리가 늘고,
 * 그중 하나만 빠뜨려도 화면과 판정이 다른 서열을 읽는다 — 등록 현황과 같은 원칙이다.
 *
 * ⚠️ 코어가 내는 것은 **수치와 코드**다. "베테랑 리더"도 "라커룸의 기둥"도 여기서
 * 짓지 않는다 (AGENTS.md §4 · overview.md §1 철칙 4).
 */

/**
 * 서열 점수와 **첫 주장**의 규칙은 **도메인이 갖는다** — 세계를 보지 않는 순수 함수라
 * 새 게임을 세우는 자리(`createGame`)도 같은 자를 쓴다 (AGENTS.md §5 "한 규칙, 한 정의").
 * 코어 쪽에서 부르던 자리가 옮기지 않게 여기서 다시 내보낸다.
 */
export { standingScore } from "@story-fm/domain";

/** 리더 그룹의 크기 — 1군 상위 몇 명이 라커룸을 이끄는가 */
export const LEADER_GROUP_SIZE = 5;

/**
 * 리더 배수 — 선수가 떠날 때 남은 선수단에 미치는 사기 변화의 무게 (people.md §5-1).
 */
export const LEADER_WEIGHT: Record<LeaderRole, number> = {
  captain: 2,
  vice: 1.6,
  group: 1.3,
};

/** 리더가 아닌 선수의 배수 — 곱해도 아무것도 달라지지 않는다 */
export const PLAIN_WEIGHT = 1;

/** 리더가 선 라커룸이 새 영입의 필요 크레딧에서 덜어 주는 최대 폭 */
const LEADER_SETTLING_RELIEF = 0.2;

/** 서열 한 줄 — 저장되지 않는 파생값이다 */
export interface LeaderStanding {
  playerId: string;
  /** 네 항의 가중 합 — 0~99, 리더십과 같은 눈금 */
  standing: number;
  /** 라커룸에서 선 자리 — 완장은 서열을 이긴다 */
  role: LeaderRole;
  /** 근거 셋 — 결과 항목·조회 도구가 그대로 읽는다 */
  leadership: number;
  apps: number;
  seasons: number;
}

/** 그 셔츠의 통산 1군 출전과 기록이 남은 시즌 수 — 원장을 한 번만 훑는다 */
function shirtRecordOf(
  state: GameState,
  teamId: string,
): Map<string, { apps: number; seasons: number }> {
  const rows = new Map<string, { apps: number; seasons: Set<number> }>();
  for (const stat of state.seasonStats) {
    if (stat.teamId !== teamId) continue;
    const row = rows.get(stat.gamePlayerId) ?? { apps: 0, seasons: new Set<number>() };
    row.apps += stat.apps;
    row.seasons.add(stat.season);
    rows.set(stat.gamePlayerId, row);
  }
  return new Map([...rows].map(([id, r]) => [id, { apps: r.apps, seasons: r.seasons.size }]));
}

/**
 * 그 팀의 리더 그룹 — 서열 내림차순. **후보는 1군뿐이다**: 2군에 내려간 선수는
 * 감독의 일상에도 라커룸의 아침에도 없다(내리면 완장도 함께 빠진다).
 *
 * 완장은 서열을 이긴다 — 주장·부주장은 서열과 무관하게 그룹에 든다. 감독이 세운
 * 사람이 그룹 밖에 서면 완장이 뜻을 잃는다.
 */
export function leaderGroupOf(state: GameState, teamId: string): LeaderStanding[] {
  const record = shirtRecordOf(state, teamId);
  const ranked = playersOf(state, teamId)
    .filter((p) => squadLevelOf(p) === "first")
    .map((p) => {
      const shirt = record.get(p.id) ?? { apps: 0, seasons: 0 };
      return {
        playerId: p.id,
        standing: standingScore({
          leadership: p.attributes.leadership,
          age: ageOf(p.birthdate, state.date),
          apps: shirt.apps,
          seasons: shirt.seasons,
        }),
        role: (p.isCaptain ? "captain" : p.isViceCaptain === true ? "vice" : "group") as LeaderRole,
        leadership: p.attributes.leadership,
        apps: shirt.apps,
        seasons: shirt.seasons,
      } satisfies LeaderStanding;
    })
    // 동점은 id 순 — 같은 세이브는 언제나 같은 서열이다
    .sort((a, b) => b.standing - a.standing || (a.playerId < b.playerId ? -1 : 1));

  const group = ranked.slice(0, LEADER_GROUP_SIZE);
  for (const row of ranked.slice(LEADER_GROUP_SIZE)) {
    if (row.role !== "group") group.push(row);
  }
  return group.sort((a, b) => b.standing - a.standing || (a.playerId < b.playerId ? -1 : 1));
}

/** 이 선수가 라커룸에서 선 자리 — 리더 그룹 밖이면 `null` */
export function leaderRoleOf(state: GameState, player: GamePlayer): LeaderRole | null {
  if (player.isCaptain) return "captain";
  if (player.isViceCaptain === true) return "vice";
  return leaderGroupOf(state, player.teamId).some((row) => row.playerId === player.id)
    ? "group"
    : null;
}

/** 리더 배수 — 완장을 벗기기 전의 이탈 사기 정산이 읽는다 */
export function leaderWeightOf(state: GameState, player: GamePlayer): number {
  const role = leaderRoleOf(state, player);
  return role === null ? PLAIN_WEIGHT : LEADER_WEIGHT[role];
}

/**
 * 새 영입의 필요 크레딧에 곱해지는 리더 항 (0.80~1.00) — **본인은 빼고 센다.**
 * "라커룸에 리더가 서 있다"는 다른 사람들에 대한 말이다.
 */
export function leaderSettlingRelief(
  state: GameState,
  teamId: string,
  playerId: string,
): { multiplier: number; leadership: number } | null {
  const others = leaderGroupOf(state, teamId).filter((row) => row.playerId !== playerId);
  if (others.length === 0) return null;
  const average = others.reduce((sum, row) => sum + row.leadership, 0) / others.length;
  const multiplier = Math.round((1 - LEADER_SETTLING_RELIEF * (average / RATING_MAX)) * 100) / 100;
  return multiplier === 1 ? null : { multiplier, leadership: Math.round(average) };
}

/**
 * 주장이 비었을 때 완장을 받을 사람 — **부주장이 먼저, 없으면 서열 최상위.**
 *
 * ⚠️ 골키퍼를 거르지 않는다 — 누가 라커룸을 이끄는가는 포지션이 아니라 리더십이 답한다.
 */
export function successorCaptainOf(state: GameState, teamId: string): string | null {
  const group = leaderGroupOf(state, teamId);
  return (group.find((row) => row.role === "vice") ?? group[0])?.playerId ?? null;
}

/**
 * **그 경기의 완장** — 명단 안에서 다시 정해진다. 주장이 명단에 없으면 부주장이,
 * 둘 다 없으면 명단 안 서열 최상위가 완장을 찬다.
 */
export function matchCaptainOf(
  state: GameState,
  teamId: string,
  present: ReadonlySet<string>,
): string | null {
  const inSquad = leaderGroupOf(state, teamId).filter((row) => present.has(row.playerId));
  const worn =
    inSquad.find((row) => row.role === "captain") ??
    inSquad.find((row) => row.role === "vice") ??
    inSquad[0];
  return worn?.playerId ?? null;
}
