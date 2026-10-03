import {
  personaBookOf,
  storePersona,
  storeStaffCandidate,
  readStaffCandidate,
} from "../../common/people/character-book";
import {
  formatMoney,
  type CharacterBookContent,
  HireStaffInputSchema,
  type HireStaffInput,
  isStaffRole,
  PERSONA_ROLE_LABEL,
  STAFF_ROLES,
  type Persona,
  type StoredPersona,
  type StaffPoolEntry,
  type StaffRole,
} from "@story-fm/domain";
import { addDays } from "../../common/core/dates";
import { makeRng, randInt, shuffled } from "../../common/core/rng";
import { teamNameIn, managedTeamId, financeOf, type GameState } from "../../common/core/state";
import { clubWageBudget } from "../../common/finance/wages";
import { weeklyWagesOf } from "../../common/core/state";
import { recordFinance } from "../../common/finance/finance";
import { item } from "../../common/commands/brief";
import type { CommandResult } from "../../app/commands";
import {
  inventPersonName,
  occupiedPersonNames,
  staffArchetypesOf,
  staffPersona,
  staffSalaryOf,
  staffSeedBook,
  STAFF_LIMIT,
} from "../../common/people/persona";
import { managerSeveranceOf } from "../world/manager-employment";

/** 풀에 앉는 사람 수 — 역할별 자리를 다 채우고도 고를 여지가 남는 크기다 */
const STAFF_POOL_SIZE: Record<StaffRole, number> = { coach: 4, medic: 2, scout: 2 };

/** 요구 연봉의 폭 — 기준 연봉의 몇 배를 부르는가 (결정적) */
const ASK_MIN = 0.7;
const ASK_MAX = 1.4;
/** 배수를 끊는 눈금 — 정수 굴림 하나로 결정적으로 뽑기 위한 자리다 */
const ASK_STEPS = 8;

/** 천 파운드 단위 — 연봉은 사람이 읽는 값이다 (`staffSalaryOf`와 같은 눈금) */
const SALARY_ROUNDING = 1_000;

/**
 * 그해 여름의 풀 — **(시드, 시즌) 채널로 결정적이다.**
 *
 * 요구 연봉이 **감독 구단의 눈금**을 타는 이유: 이 풀을 부르는 사람은 감독뿐이고,
 * 그가 2부 구단에 있는데 EPL 연봉을 부르는 코치만 앉아 있으면 풀이 장식이 된다.
 * 감독이 옮기면 다음 여름의 풀이 새 구단의 눈금으로 다시 선다.
 */
function drawPool(state: GameState, season: number): StaffPoolEntry[] {
  const taken = occupiedPersonNames(state);
  for (const entry of state.characterBook) if (entry.kind !== "team") taken.add(entry.name);
  const rows: StaffPoolEntry[] = [];
  for (const role of STAFF_ROLES) {
    const table = shuffled(staffArchetypesOf(role), state.seed, `staff-pool:${role}:${season}`);
    const base = staffSalaryOf(state.userTeamId, role);
    for (let index = 0; index < STAFF_POOL_SIZE[role]; index += 1) {
      const rng = makeRng(state.seed, `staff-pool:${role}:${season}:${index}`);
      const archetype = table[index % table.length]!;
      const name = inventPersonName(rng, state.userTeamId, taken);
      taken.add(name);
      const step = randInt(rng, 0, ASK_STEPS);
      const factor = ASK_MIN + ((ASK_MAX - ASK_MIN) * step) / ASK_STEPS;
      rows.push({
        name,
        role,
        title: archetype.title,
        characterBook: staffSeedBook(state.seed, name, role, archetype),
        ask: Math.max(
          SALARY_ROUNDING,
          Math.round((base * factor) / SALARY_ROUNDING) * SALARY_ROUNDING,
        ),
        listedOn: season,
      });
    }
  }
  return rows;
}

/** 현재 후보 조건과 같은 인물의 최신 캐릭터북을 조립한다. 조회는 상태를 바꾸지 않는다. */
export function staffPoolOf(state: GameState): readonly StaffPoolEntry[] {
  return state.staffPool.map((entry) => readStaffCandidate(state, entry));
}

/**
 * 여름 갱신 — **그해 자른 사람만 남기고 다시 세운다** (people.md §2-2).
 *
 * 자른 그해 안에는 마음을 되돌릴 수 있고, 다음 여름이면 그는 다른 구단으로 갔다.
 * 그래서 남는 조건이 「이번 시즌에 올라온 줄」 하나다 — 추첨으로 선 줄은 시즌이
 * 바뀌면 어차피 새로 뽑히므로 같은 조건이 두 갈래를 함께 정리한다.
 *
 * @param season 새로 시작하는 시즌 — 전환은 `season++` 뒤에 이 함수를 부른다
 */
export function refreshStaffPool(state: GameState, season: number): void {
  const kept = state.staffPool.filter((e) => e.from !== undefined && e.listedOn >= season - 1);
  const keptNames = new Set(kept.map((e) => e.name));
  state.staffPool = [
    ...kept,
    ...drawPool(state, season)
      .filter((e) => !keptNames.has(e.name))
      .map((entry) => storeStaffCandidate(state, entry)),
  ];
}

/** 확인된 스태프 풀의 한 줄에 실제 고용 계약을 붙인다. */
export function staffPersonaOf(
  state: GameState,
  entry: StaffPoolEntry,
  contract: { salary: number; until: string; since: string },
): Persona {
  return staffPersona({
    seed: state.seed,
    teamId: state.userTeamId,
    name: entry.name,
    role: entry.role,
    title: entry.title,
    characterBook: entry.characterBook,
    since: contract.since,
    until: contract.until,
    salary: contract.salary,
    ...(entry.from === undefined ? {} : { from: entry.from }),
  });
}

/** The GM supplies agreed terms; the core validates identity, authority and payroll. */
export function hireStaff(state: GameState, input: HireStaffInput): CommandResult {
  const parsed = HireStaffInputSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, message: "이름·양수 연봉·계약 만료일을 확인해야 합니다" };
  input = parsed.data;
  if (
    managedTeamId(state) === null ||
    !state.manager.contract ||
    state.manager.contract.until < state.date
  )
    return { ok: false, message: "스태프를 고용할 구단의 감독이 아닙니다" };
  if (input.until <= state.date)
    return { ok: false, message: "계약 만료일은 오늘 이후여야 합니다" };
  const existing = state.personas.find(
    (p) => p.name === input.name || p.characterId === input.name,
  );
  if (state.players.some((p) => p.name === input.name))
    return { ok: false, message: "현역 선수의 고용 상태를 먼저 정리해야 합니다" };
  if (state.teams.some((t) => t.managerName === input.name) || state.manager.name === input.name)
    return { ok: false, message: "재직 감독은 스태프로 고용할 수 없습니다" };
  if (existing?.employment && existing.employment.teamId !== state.userTeamId)
    return { ok: false, message: "다른 구단의 계약 중인 인물입니다" };
  if (existing && existing.role === "owner")
    return { ok: false, message: "현재 인물의 직무를 스태프 계약으로 바꿀 수 없습니다" };
  const pool = staffPoolOf(state);
  const entry = pool.find((e) => e.name === input.name);
  const role =
    input.role ??
    entry?.role ??
    (existing && (isStaffRole(existing.role) || existing.role === "head_coach")
      ? existing.role
      : undefined);
  const title =
    input.title ??
    existing?.employment?.title ??
    entry?.title ??
    existing?.employmentHistory?.at(-1)?.title;
  const characterBook: CharacterBookContent | undefined =
    (existing
      ? personaBookOf(state, existing)
      : state.characterBook.find((b) => b.kind === "person" && b.name === input.name)) ??
    entry?.characterBook ??
    input.characterBook;
  if (!role || !title || !characterBook)
    return { ok: false, message: "새 스태프의 역할·직책·캐릭터북이 필요합니다" };
  if (characterBook.name !== (existing?.name ?? input.name))
    return { ok: false, message: "캐릭터북의 이름과 계약 당사자가 다릅니다" };
  const limit = role === "head_coach" ? HEAD_COACH_LIMIT : STAFF_LIMIT[role];
  const occupied = state.personas.filter(
    (p) =>
      p !== existing &&
      p.role === role &&
      p.employment?.teamId === state.userTeamId &&
      p.employment.contract.until >= state.date,
  ).length;
  if (occupied >= limit)
    return { ok: false, message: `${PERSONA_ROLE_LABEL[role]} 자리가 다 찼습니다` };
  const staffAnnual = state.personas
    .filter(
      (p) =>
        p !== existing &&
        p.employment?.teamId === state.userTeamId &&
        p.employment.contract.until >= state.date,
    )
    .reduce((sum, p) => sum + p.employment!.contract.salary, 0);
  if (
    (staffAnnual + input.salary) / WEEKS_PER_YEAR >
    clubWageBudget(state.userTeamId, undefined, state) - weeklyWagesOf(state, state.userTeamId)
  )
    return { ok: false, message: "기존 선수·스태프 계약을 포함한 주급 여력을 넘습니다" };
  const persona =
    existing ??
    storePersona(
      state,
      staffPersonaOf(
        state,
        { name: input.name, role, title, characterBook, ask: input.salary, listedOn: state.season },
        { salary: input.salary, since: state.date, until: input.until },
      ),
    );
  const renewing = existing?.employment !== undefined;
  const since = existing?.employment?.since ?? state.date;
  if (existing?.employment) archiveEmployment(existing, state.date, "renewed");
  persona.role = role;
  persona.employment = {
    teamId: state.userTeamId,
    title,
    since,
    contract: { salary: input.salary, until: input.until },
  };
  if (!existing) state.personas.push(persona);
  state.staffPool = state.staffPool.filter((e) => e.name !== persona.name);
  return {
    ok: true,
    brief: {
      head: renewing ? "스태프 재계약" : "스태프 고용",
      items: [
        item({ label: persona.name, text: title }),
        item({ label: "연봉", text: `${formatMoney(input.salary)}/년` }),
        item({ label: "계약 만료일", text: input.until }),
      ],
    },
    message: `${persona.name} (${title}) 계약 — 연봉 ${formatMoney(input.salary)}, ${input.until}까지`,
  };
}

export function archiveEmployment(
  persona: Pick<StoredPersona, "employment" | "employmentHistory">,
  endedOn: string,
  reason: "renewed" | "expired" | "released",
): void {
  if (!persona.employment) return;
  persona.employmentHistory = [
    ...(persona.employmentHistory ?? []),
    { ...persona.employment, endedOn, reason },
  ];
  delete persona.employment;
}

/** 주급을 연봉으로 펴는 눈금 — `world/wages.ts`와 같은 자다 */
const WEEKS_PER_YEAR = 52;
const HEAD_COACH_LIMIT = 1;

/**
 * **해고** — 잔여 계약의 위약금을 구단이 문다 (people.md §2-2).
 *
 * 금액은 감독 경질과 **같은 식**(`managerSeveranceOf`)이고 연봉 1년치에서 멈춘다.
 * 자른 사람은 그해의 풀에 앉아, 같은 시즌 안에는 감독이 마음을 되돌릴 수 있다.
 */
export function releaseStaff(state: GameState, input: { name: string }): CommandResult {
  if (
    managedTeamId(state) === null ||
    !state.manager.contract ||
    state.manager.contract.until < state.date
  )
    return { ok: false, message: "현재 감독의 권한이 없습니다" };
  const persona = state.personas.find(
    (p) => (isStaffRole(p.role) || p.role === "head_coach") && p.name === input.name,
  );
  if (
    persona === undefined ||
    persona.employment?.teamId !== state.userTeamId ||
    !(isStaffRole(persona.role) || persona.role === "head_coach")
  ) {
    return { ok: false, message: `${input.name} — 우리 구단의 스태프가 아닙니다` };
  }
  const { employment } = persona;
  const severance = managerSeveranceOf(employment.contract, state.date);
  if (severance > financeOf(state, state.userTeamId).balance)
    return { ok: false, message: "계약 해지 위약금을 지급할 현금이 부족합니다" };
  if (severance > 0) {
    recordFinance(state, state.userTeamId, {
      kind: "expense",
      category: "severance",
      label: `${persona.name} 계약 해지 위약금`,
      amount: severance,
    });
  }
  archiveEmployment(persona, state.date, "released");
  state.staffPool = [
    {
      name: persona.name,
      role: persona.role,
      title: employment.title,
      characterBookId: persona.characterBookId,
      ask: employment.contract.salary,
      listedOn: state.season,
      from: state.userTeamId,
    },
    ...(state.staffPool ?? []).filter((e) => e.name !== persona.name),
  ];
  const paid = severance > 0 ? ` · 위약금 ${formatMoney(severance)}` : "";
  return {
    ok: true,
    message: `${persona.name} (${employment.title}) 계약 해지${paid}`,
    brief: {
      head: "스태프 계약 해지",
      items: [
        item({
          label: persona.name,
          text: "계약 해지",
          note: severance > 0 ? `위약금 ${formatMoney(severance)}` : "잔여 계약 없음",
        }),
      ],
    },
  };
}

/** Contracts end on their agreed date; vacancies are not automatically filled. */
export function expireStaffContracts(state: GameState, on: string): string[] {
  const expired: string[] = [];
  for (const persona of state.personas) {
    const job = persona.employment;
    if (
      !job ||
      job.contract.until >= on ||
      !(isStaffRole(persona.role) || persona.role === "head_coach")
    )
      continue;
    archiveEmployment(persona, addDays(job.contract.until, 1), "expired");
    state.staffPool = [
      {
        name: persona.name,
        role: persona.role,
        title: job.title,
        characterBookId: persona.characterBookId,
        ask: job.contract.salary,
        listedOn: state.season,
        from: job.teamId,
      },
      ...state.staffPool!.filter((e) => e.name !== persona.name),
    ];
    expired.push(persona.name);
  }
  return expired;
}

/**
 * 자리를 찾는 사람들 한 줄씩 — 감독이 부른 이름을 그 사람으로 옮기는 자리
 * (`get_squad`·시장 해석기). **읽기만 한다** (`staffPoolOf`).
 */
export function describeStaffPool(state: GameState): string[] {
  return staffPoolOf(state).map(
    (e) =>
      `${e.name} · ${e.title} · ${state.characterBook.find((b) => b.kind === "person" && b.name === e.name)?.description ?? e.characterBook.description} · 요구 연봉 ${formatMoney(e.ask)}${
        e.from === undefined ? "" : ` · ${teamNameIn(state, e.from)} 출신`
      }`,
  );
}
