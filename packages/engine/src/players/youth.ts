import { type GameState, playersOf, managedTeamId, groupOf } from "../core/state";
import {
  playerOverall,
  isReserveStat,
  type TickSink,
  type GamePlayer,
  ageOf,
  type PositionGroup,
  MATCHDAY_SQUAD,
  GOALKEEPER_MIN,
  type YouthCandidate,
} from "@gaffer/domain";
import { squadReturnOf } from "../core/calendar";
import { assignSquadNumber } from "./numbers";
import { contractUntil } from "../core/dates";

/**
 * 유스 콜업 난수를 세이브 시드에서 갈라 내는 오프셋 — 같은 `state.seed`를 쓰는
 * 다른 생성기(세계를 세울 때의 2군 채우기 등)와 같은 선수를 뽑지 않게 한다.
 */
export const YOUTH_INTAKE_SEED_OFFSET = 101;
// ── 유스 인테이크 — 후보·결정·기본값 (season.md §6) ────────

/**
 * 포지션군 최소 인원 — **소프트락 방지선이다.** 감독이 후보를 전부 돌려보내도 코어가
 * 이 아래는 채운다: 골문은 대체할 자리가 없다.
 */
const MIN_GROUP: Record<PositionGroup, number> = { GK: 2, DF: 5, MF: 4, FW: 4 };

/**
 * 유스 후보는 필요한 충원 인원에 체급별 선택 여유를 더해 구성한다.
 * 상한은 추가 여유에만 적용하며 최소 충원 인원은 제한하지 않는다.
 */
const YOUTH_POOL_BY_TIER: Record<1 | 2 | 3 | 4, number> = { 1: 4, 2: 3, 3: 3, 4: 2 };

/** 아카데미 활용도(0~1)가 더하는 후보 수 */
const YOUTH_POOL_ACADEMY = 2;

/**
 * 아카데미 활용도가 **유스 천장의 평균**에 얹는 폭 (season.md §6).
 *
 * 여지의 위끝이 아니라 천장이다 — 위끝에 얹으면 활용도가 높은 구단의 유스만 여지가
 * 넓어져 지금 실력이 그만큼 낮게 서고, 아카데미에 자리를 준 대가가 "더 덜 자란 아이"가
 * 된다. 천장을 옮기면 실력은 그 천장에서 나이가 정한 만큼 내려온 자리에 그대로 선다.
 */
const YOUTH_ACADEMY_CEILING = 3;

/**
 * 아카데미가 자리를 내주는 나이 — 실제 U21 리그의 자격과 같은 자다. 밴드가 아니라
 * 문턱인 것은 "2군에 그 아이의 자리가 있었는가"만 묻기 때문이다.
 */
const ACADEMY_AGE_MAX = 21;

/**
 * 활용도를 잴 수 있는 최소 표본 — 우리 2군 리그 출전 총합. 이 아래면 잴 것이 없는
 * 해다(첫 시즌 · 2군 일정이 짧았던 해).
 */
const ACADEMY_USE_MIN_APPS = 20;

/** 잴 것이 없는 해의 활용도 — 0으로 굳히면 첫 인테이크가 이유 없이 마른다 */
const ACADEMY_USE_NEUTRAL = 0.5;

/**
 * **아카데미 활용도** — 지난 시즌 우리 2군 리그 출전 중 만 `ACADEMY_AGE_MAX`세 이하가
 * 차지한 몫 (season.md §6).
 *
 * 2군을 늙은 백업으로 채우면 아카데미에 자리가 없고, 그해 인테이크가 얇고 낮아진다 —
 * 감독이 1·2군 이동으로 내린 결정이 한 해 뒤 이 값으로 돌아온다.
 *
 * ⚠️ **지금 명단에 있는 사람의 출전만 센다.** 시즌 중에 떠난 선수는 나이를 되찾을
 * 자리가 없어 분모에도 분자에도 들지 않는다 — 한쪽에만 들면 몫이 거짓이 된다.
 */
export function academyUseOf(state: GameState, teamId: string, season: number): number {
  const apps = new Map<string, number>();
  for (const stat of state.seasonStats) {
    if (stat.season !== season || stat.teamId !== teamId || !isReserveStat(stat)) continue;
    apps.set(stat.gamePlayerId, (apps.get(stat.gamePlayerId) ?? 0) + stat.apps);
  }
  let total = 0;
  let young = 0;
  for (const player of playersOf(state, teamId)) {
    const played = apps.get(player.id) ?? 0;
    if (played === 0) continue;
    total += played;
    if (ageOf(player.birthdate, state.date) <= ACADEMY_AGE_MAX) young += played;
  }
  return total < ACADEMY_USE_MIN_APPS ? ACADEMY_USE_NEUTRAL : young / total;
}

/** 이번 여름 이 구단의 인테이크가 몇이고 얼마나 여지가 있는가 (season.md §6) */
interface YouthIntake {
  /** 후보로 세울 수 — 감독 팀만 이만큼 서고, AI 구단은 `fills`만큼 곧바로 계약한다 */
  candidates: number;
  /** 감독이 응답하지 않았을 때 자동 계약할 인원 */
  fills: number;
  /** 유스 천장의 평균에 얹는 폭 */
  ceilingBonus: number;
}

/**
 * 이번 여름의 인테이크 — **체급과 아카데미 활용도의 결정적 함수** (season.md §6).
 * 뽑기가 없으므로 감독이 2군에 자리를 준 만큼 다음 여름을 예측할 수 있다.
 */
export function youthIntakeOf(fills: number, tier: 1 | 2 | 3 | 4, academyUse: number): YouthIntake {
  const extra = YOUTH_POOL_BY_TIER[tier] + Math.round(academyUse * YOUTH_POOL_ACADEMY);
  return {
    candidates: fills + extra,
    fills,
    // 후보 수와 달리 반올림하지 않는다 — 천장은 눈금이 없는 값이고, 접으면 활용도
    // 0.5와 0.83이 같은 인테이크를 낸다
    ceilingBonus: academyUse * YOUTH_ACADEMY_CEILING,
  };
}

/** 포지션군이 비어 코어가 반드시 채워야 하는 자리 — 후보 목록의 **앞**에 선다 */
export function forcedGroupsOf(squad: readonly GamePlayer[]): PositionGroup[] {
  const forced: PositionGroup[] = [];
  for (const group of Object.keys(MIN_GROUP) as PositionGroup[]) {
    const have = squad.filter((p) => groupOf(p) === group).length;
    for (let k = have; k < MIN_GROUP[group]; k++) forced.push(group);
  }
  return forced;
}

/** 유스가 명단에 서는 한 자리 — 계약·원장·등번호가 함께 선다 (한 곳에서만 일어난다) */
export function admitYouth(
  state: GameState,
  player: GamePlayer,
  teamId: string,
  on: string,
  weeklyWage: number,
  years: number,
): void {
  player.teamId = teamId;
  state.players.push(player);
  assignSquadNumber(state.players, player);
  // 유스 콜업도 원장에 (fromTeamId = null)
  state.moves.push({
    id: `mv-youth-${player.id}`,
    gamePlayerId: player.id,
    fromTeamId: null,
    toTeamId: teamId,
    date: on,
    kind: "youth",
  });
  state.contracts.push({
    id: `c-${player.id}`,
    gamePlayerId: player.id,
    teamId,
    weeklyWage,
    since: on,
    until: contractUntil(on, years),
    status: "active",
  });
}

/**
 * **1군이 매치데이 명단을 못 채우면 2군 상위 자원이 올라온다** (season.md §6).
 * 그 외의 승강은 감독의 결정으로 남긴다 — 문턱을 따로 적지 않고 도메인의 매치데이
 * 명단(`MATCHDAY_SQUAD`)을 그대로 읽는 것은 같은 규칙의 정의를 둘로 만들지 않기 위해서다.
 *
 * 전환과 인테이크 정리가 같은 함수를 부른다: 신인이 소집일에 들어와도 1군의 하한이
 * 그날 다시 서야, 그 사이에 명단이 얕은 채로 프리시즌이 열리지 않는다.
 */
/**
 * 1군이 매치데이 명단(`MATCHDAY_SQUAD`)을 못 채우면 2군 상위 자원을 올린다 (season.md §6).
 *
 * **골문은 AI 구단에서만 함께 센다** (`keeper`). 감독 팀은 골키퍼 없는 1군을 등록 현황이
 * 「골키퍼 부족」으로 세우고 킥오프의 자동 대체가 2군을 부르므로, 누구를 올릴지는 감독의
 * 결정으로 남긴다 (team.md §5). AI 구단에는 그 경고를 읽을 사람이 없고, 간이 시뮬은 1군을
 * 종합 순으로 채우므로(`simSquadOf`) 골키퍼가 전부 은퇴한 여름에 아무도 올리지 않으면
 * 골문 없는 열한 명이 한 시즌을 뛴다 — 인원 수로 올리는 문이 종합 순이라 젊은 골키퍼는
 * 그 문을 거의 지나지 못한다.
 */
export function promoteToMatchdaySquad(squad: GamePlayer[], keeper: boolean): void {
  const first = () => squad.filter((p) => p.squadLevel !== "reserve");
  const byOverall = (a: GamePlayer, b: GamePlayer) => playerOverall(b) - playerOverall(a);
  for (const player of [...squad].filter((p) => p.squadLevel === "reserve").sort(byOverall)) {
    if (first().length >= MATCHDAY_SQUAD) break;
    player.squadLevel = "first";
  }
  if (!keeper) return;
  const keepers = (players: GamePlayer[]) => players.filter((p) => groupOf(p) === "GK");
  for (const player of keepers([...squad].filter((p) => p.squadLevel === "reserve")).sort(
    byOverall,
  )) {
    if (keepers(first()).length >= GOALKEEPER_MIN) break;
    player.squadLevel = "first";
  }
}

/** 첫 프로 계약의 길이 — 유스는 3년으로 들어온다 */
export const YOUTH_CONTRACT_YEARS = 3;

/**
 * 감독의 답을 기다리는 마지막 날 — **선수단 소집일이다** (season.md §6).
 * 조기 소집하면 기한도 함께 당겨진다: 훈련장이 열리는 날이 신인이 명단에 서는 날이다.
 */
export function youthIntakeDeadline(state: GameState): string {
  return squadReturnOf(state.calendar);
}

/**
 * **지금 우리 구단의 후보만** — 커리어가 끝났으면 없다. 화면·조회·스냅샷이 모두 이
 * 문을 지난다.
 */
export function ourYouthCandidates(state: GameState): YouthCandidate[] {
  const managed = managedTeamId(state);
  if (managed === null) return [];
  return state.youthCandidates.filter((row) => row.teamId === managed);
}

/**
 * 후보를 계약시킨다 — **한 번의 확정** (season.md §6).
 *
 * 고른 이름이 계약을 받고 **나머지 후보는 세계에 남지 않는다.** 다만 고른 뒤에도
 * 포지션군이 최소 인원 아래면 코어가 남은 후보에서 그 자리를 채운다 — 소프트락
 * 방지는 감독의 결정 밖이다.
 *
 * ⚠️ 후보에 없는 id는 조용히 무시하지 않는다 — 부르는 쪽(`signYouth`)이 먼저 거른다.
 */
export function signYouthCandidates(
  state: GameState,
  chosenIds: readonly string[],
): { signed: GamePlayer[]; filled: GamePlayer[]; letGo: number } {
  const rows = state.youthCandidates;
  if (rows.length === 0) return { signed: [], filled: [], letGo: 0 };
  const teamId = rows[0]!.teamId;
  const chosen = new Set(chosenIds);
  const signed: GamePlayer[] = [];
  const filled: GamePlayer[] = [];
  const rest = rows.filter((row) => !chosen.has(row.player.id));

  const take = (row: YouthCandidate, into: GamePlayer[]) => {
    admitYouth(state, row.player, teamId, state.date, row.weeklyWage, row.years);
    into.push(row.player);
  };
  for (const row of rows) if (chosen.has(row.player.id)) take(row, signed);

  /**
   * 남은 자리를 메운다 — 감독이 고른 **뒤**의 명단으로 다시 센다. 앞서 세면 감독이
   * 방금 계약한 골키퍼가 세어지지 않아 코어가 한 명을 더 데려온다.
   */
  const pool = [...rest];
  for (const group of forcedGroupsOf(playersOf(state, teamId))) {
    const at = pool.findIndex((row) => groupOf(row.player) === group);
    if (at < 0) continue;
    take(pool[at]!, filled);
    pool.splice(at, 1);
  }

  state.youthCandidates = [];
  // 감독 팀의 소집일 — 골문은 감독의 결정이라 인원 수만 채운다 (team.md §5)
  if (signed.length > 0 || filled.length > 0) {
    promoteToMatchdaySquad(playersOf(state, teamId), false);
  }
  return { signed, filled, letGo: pool.length };
}

/**
 * **소집일 — 미결 후보를 코어가 정리한다** (season.md §6). 방치는 시간의 결과다:
 * 답이 없으면 `autoSign` 수만큼 앞에서부터 계약하고 나머지는 돌려보낸다.
 */
export function settleYouthIntake(state: GameState, digest: TickSink): void {
  const rows = state.youthCandidates;
  if (rows.length === 0) return;
  const auto = rows.filter((row) => row.autoSign).map((row) => row.player.id);
  const { signed, filled } = signYouthCandidates(state, auto);
  const all = [...signed, ...filled];
  if (all.length === 0) return;
  const line = `유스 계약: ${all.map((p) => p.name).join(", ")} — 감독이 답하지 않아 구단이 채웠다`;
  digest.push(line);
}
