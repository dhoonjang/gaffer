import { existsSync } from "node:fs";
import {
  CatalogTeamEditSchema,
  CatalogTeamInputSchema,
  type LorebookContent,
  type Formation,
} from "@gaffer/domain";
import { catalogPath } from "../../core/catalog/paths";
import {
  CLUB_PROFILES_SEED,
  clubProfile,
  clubProfiles,
  type ClubProfile,
} from "../../core/catalog/club-profile";
import { cupCatalog } from "../../core/catalog/cup-catalog";
import { domesticCupCatalog } from "../../core/catalog/domestic-cup-catalog";
import { leagueCatalog, leagueName } from "../../core/catalog/league-catalog";
import {
  TACTICAL_STYLE_SEED,
  TEAM_CATALOG_SEED,
  tacticalStyleOf,
  tacticalStyles,
  teamCatalog,
  teamCatalogById,
  withTeamBook,
  type ClubHonour,
  type TacticalStyle,
  type TeamCatalogEntry,
} from "../../core/catalog/team-catalog";
import {
  clearTeamOverride,
  readTeamOverride,
  writeTeamOverride,
} from "../../core/catalog/team-override";
import { buildTeamSquad, playerCatalog, saveCatalog } from "../../players/catalog/catalog";
import {
  catalogWarnings,
  checkCatalogInvariants,
  type CatalogCandidate,
} from "../catalog-invariants";
import type { AdminResult } from "./admin";

/**
 * 팀 카탈로그 어드민 — 클럽의 **정체성**(이름·리그·체급·포메이션)과 그에 딸린
 * 운용 정체성(전술 성향)·살림(구장·브랜드)을 함께 편집한다.
 *
 * 선수 어드민(`admin.ts`)과 같은 규칙이다: 편집은 `.data/team-catalog.json`에
 * 저장되고 **이후 새로 시작하는 게임**의 초기치가 된다. 진행 중인 세이브는
 * 영향을 받지 않는다.
 *
 * 구조 필드(`leagueId`·팀 추가/삭제)는 세계의 성립 조건을 건드리므로 저장 전에
 * 불변식을 확인한다 (`catalog-invariants.ts`) — 홀수 팀 리그, 32팀을 못 채우는
 * 국내 컵은 새 게임을 시작할 때가 아니라 **여기서** 막힌다.
 */

/** 어드민 목록 행 — 편집 대상 세 표를 한 줄로 합치고 파생값을 얹는다 */
export interface AdminTeamRow extends TeamCatalogEntry {
  tacticalStyle: TacticalStyle;
  stadium: string;
  capacity: number;
  commercialTier: 1 | 2 | 3 | 4;
  /** 카탈로그에 있는 이 팀의 선수 수 (파생) */
  squadSize: number;
  /** 소속 리그 표시명 (파생) */
  leagueName: string;
}

interface AdminTeamInput {
  lorebook?: LorebookContent;
  id: string;
  name: string;
  shortName: string;
  leagueId: string;
  tier: 1 | 2 | 3 | 4;
  formation?: Formation;
  tacticalStyle?: TacticalStyle;
  stadium?: string;
  capacity?: number;
  commercialTier?: 1 | 2 | 3 | 4;
  /** 게임 시작 전의 우승 — 대회 id별 횟수 (team.md §1). 빈 배열이면 표를 지운다 */
  honours?: readonly ClubHonour[];
}

type AdminTeamPatch = Partial<Omit<AdminTeamInput, "id" | "formation">> & {
  formation?: Formation | null;
};

function rowOf(team: TeamCatalogEntry, squadSize: number): AdminTeamRow {
  const profile = clubProfile(team.id, team.tier);
  return {
    ...team,
    tacticalStyle: tacticalStyleOf(team.id),
    stadium: profile.stadium,
    capacity: profile.capacity,
    commercialTier: profile.commercialTier,
    squadSize,
    leagueName: leagueName(team.leagueId),
  };
}

/** 전 팀 카탈로그 (어드민 목록) */
export function adminTeamCatalog(): AdminTeamRow[] {
  const sizes = new Map<string, number>();
  for (const entry of playerCatalog()) {
    sizes.set(entry.teamId, (sizes.get(entry.teamId) ?? 0) + 1);
  }
  return teamCatalog().map((t) => rowOf(t, sizes.get(t.id) ?? 0));
}

export function isTeamCatalogEdited(): boolean {
  const override = readTeamOverride();
  if (override === null) return false;
  return (
    JSON.stringify(override.teams) !== JSON.stringify(TEAM_CATALOG_SEED) ||
    JSON.stringify(override.tacticalStyle) !== JSON.stringify(TACTICAL_STYLE_SEED) ||
    JSON.stringify(override.clubProfiles) !== JSON.stringify(CLUB_PROFILES_SEED)
  );
}

/** 저장 후보 — 지금 값에서 출발해 편집분을 얹는다 (부분 저장이 없게) */
function snapshot(): {
  teams: TeamCatalogEntry[];
  tacticalStyle: Record<string, TacticalStyle>;
  clubProfiles: Record<string, ClubProfile>;
} {
  return {
    teams: teamCatalog().map((t) => ({ ...t })),
    tacticalStyle: { ...tacticalStyles() },
    clubProfiles: Object.fromEntries(
      Object.entries(clubProfiles()).map(([id, p]) => [id, { ...p }]),
    ),
  };
}

/** 후보 팀 목록으로 세계가 성립하는가 — 리그·컵 불변식을 함께 본다 */
function candidate(teams: readonly TeamCatalogEntry[]): CatalogCandidate {
  return {
    leagues: leagueCatalog(),
    teams,
    euroCups: cupCatalog(),
    domesticCups: domesticCupCatalog(),
  };
}

function violations(teams: readonly TeamCatalogEntry[]): string[] {
  return checkCatalogInvariants(candidate(teams));
}

/** 성공 메시지에 붙는 경고 — 대회가 조용히 사라지는 편집을 알린다 */
function withWarnings(message: string, teams: readonly TeamCatalogEntry[]): string {
  const warnings = catalogWarnings(candidate(teams));
  return warnings.length === 0 ? message : `${message} — ${warnings.join(" · ")}`;
}

export function adminUpdateTeam(teamId: string, patch: AdminTeamPatch): AdminResult {
  const parsed = CatalogTeamEditSchema.safeParse(patch);
  if (!parsed.success)
    return { ok: false, message: parsed.error.issues[0]?.message ?? "입력 오류" };
  patch = parsed.data;
  const next = snapshot();
  const team = next.teams.find((t) => t.id === teamId);
  if (!team) return { ok: false, message: `카탈로그에 없는 팀입니다: ${teamId}` };

  if (patch.lorebook !== undefined) team.lorebook = patch.lorebook;

  if (patch.name !== undefined) {
    team.name = patch.name.trim();
  }
  if (patch.shortName !== undefined) {
    team.shortName = patch.shortName.trim();
  }
  if (patch.tier !== undefined) {
    team.tier = patch.tier;
  }
  if (patch.leagueId !== undefined) team.leagueId = patch.leagueId;
  if (patch.honours !== undefined) {
    // 빈 배열은 "모른다"로 되돌리는 것이다 — 0회를 적는 자리가 아니다 (team.md §1)
    if (patch.honours.length === 0) delete team.honours;
    else team.honours = patch.honours.map((h) => ({ ...h }));
  }
  if (patch.formation === null) {
    delete team.formation;
  } else if (patch.formation !== undefined) {
    team.formation = patch.formation;
  }
  if (patch.tacticalStyle !== undefined) {
    next.tacticalStyle[teamId] = patch.tacticalStyle;
  }
  if (
    patch.stadium !== undefined ||
    patch.capacity !== undefined ||
    patch.commercialTier !== undefined
  ) {
    const current = clubProfile(teamId, team.tier);
    next.clubProfiles[teamId] = {
      stadium: patch.stadium?.trim() ?? current.stadium,
      capacity: Math.round(patch.capacity ?? current.capacity),
      commercialTier: patch.commercialTier ?? current.commercialTier,
    };
  }

  const problems = violations(next.teams);
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  next.teams = next.teams.map(withTeamBook);
  writeTeamOverride(next);
  return { ok: true, message: withWarnings(`${team.name} 갱신`, next.teams) };
}

export function adminAddTeam(input: AdminTeamInput): AdminResult {
  const parsed = CatalogTeamInputSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, message: parsed.error.issues[0]?.message ?? "입력 오류" };
  input = parsed.data;
  const id = input.id.trim();
  if (teamCatalogById(id)) return { ok: false, message: `이미 있는 팀 id입니다: ${id}` };
  const next = snapshot();
  const team: TeamCatalogEntry = withTeamBook({
    id,
    name: input.name.trim(),
    ...(input.lorebook === undefined ? {} : { lorebook: input.lorebook }),
    shortName: input.shortName.trim(),
    leagueId: input.leagueId,
    tier: input.tier,
    ...(input.formation === undefined ? {} : { formation: input.formation }),
    ...(input.honours?.length ? { honours: input.honours.map((h) => ({ ...h })) } : {}),
  });
  next.teams.push(team);
  if (input.tacticalStyle !== undefined) next.tacticalStyle[id] = input.tacticalStyle;
  if (
    input.stadium !== undefined ||
    input.capacity !== undefined ||
    input.commercialTier !== undefined
  ) {
    const fallback = clubProfile(id, input.tier);
    next.clubProfiles[id] = {
      stadium: input.stadium?.trim() ?? fallback.stadium,
      capacity: Math.round(input.capacity ?? fallback.capacity),
      commercialTier: input.commercialTier ?? fallback.commercialTier,
    };
  }

  const problems = violations(next.teams);
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  writeTeamOverride(next);
  syncPlayerCatalog(team, "add");
  return {
    ok: true,
    message: withWarnings(`${team.name} 추가 (${leagueName(team.leagueId)})`, next.teams),
  };
}

export function adminRemoveTeam(teamId: string): AdminResult {
  const next = snapshot();
  const team = next.teams.find((t) => t.id === teamId);
  if (!team) return { ok: false, message: `카탈로그에 없는 팀입니다: ${teamId}` };

  next.teams = next.teams.filter((t) => t.id !== teamId);
  delete next.tacticalStyle[teamId];
  delete next.clubProfiles[teamId];

  const problems = violations(next.teams);
  if (problems.length > 0) return { ok: false, message: problems.join(" · ") };
  writeTeamOverride(next);
  syncPlayerCatalog(team, "remove");
  return { ok: true, message: withWarnings(`${team.name} 삭제`, next.teams) };
}

/**
 * 선수 카탈로그를 팀 편집에 맞춘다 — **편집본이 있을 때만**.
 *
 * 편집본이 없으면 선수 카탈로그는 팀 카탈로그에서 매번 새로 파생되므로
 * (`buildFromSeed`) 손댈 것이 없다. 편집본이 있으면 그 파일이 진실이라, 팀을
 * 지우면 갈 곳 없는 선수가 남고 팀을 더하면 스쿼드가 빈 채로 남는다 — 둘 다
 * 새 게임을 깨뜨리므로 여기서 맞춰 준다.
 */
function syncPlayerCatalog(team: TeamCatalogEntry, action: "add" | "remove"): void {
  if (!existsSync(catalogPath())) return;
  const current = playerCatalog();
  if (action === "remove") {
    saveCatalog(current.filter((e) => e.teamId !== team.id));
    return;
  }
  const taken = new Set(current.map((e) => e.id));
  // 이름도 카탈로그 전체에서 유일해야 한다 — 새 클럽 명단이 남의 동명이인을 만들면
  // 감독이 부른 이름 하나가 후보 둘로 갈린다 (people.md §2)
  const takenNames = new Set(current.map((e) => e.nameKo));
  saveCatalog([...current, ...buildTeamSquad(team, taken, takenNames)]);
}

/** 팀 편집 전체를 시드로 되돌린다 (전술 성향·구단 프로필 포함) */
export function adminResetTeamCatalog(): AdminResult {
  clearTeamOverride();
  return {
    ok: true,
    message: `팀 카탈로그를 시드 기본값으로 되돌렸습니다 (${teamCatalog().length}팀)`,
  };
}
