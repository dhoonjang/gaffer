import {
  type ManagerInterview,
  type ManagerInterviewContext,
  type GamePlayer,
  type GameTeam,
  type InterviewOutcome,
  type ManagerContract,
  type ManagerOffer,
  type ManagerPoolEntry,
  type ManagerVacancy,
  type InterviewFact,
  type TickSink,
  type ManagerOfferTerms,
  AI_MANAGER_RATING_FALLBACK,
  ManagerJobOfferSchema,
  ManagerOfferTermsSchema,
  ageOf,
  formatMoney,
  naturalPositionOf,
} from "@story-fm/domain";
import { item } from "../../common/commands/brief";
import { type CommandBrief } from "../../common/core/state";
import { type CommandResult } from "../../common/commands/result";
import { tierOfTeamIn } from "../../common/core/club-tier";
import { contractUntil, diffDays } from "../../common/core/dates";
import { leagueOfTeamIn } from "../../common/core/league-membership";
import {
  type GameState,
  activeContract,
  firstTeamPlayers,
  pushManagerInterview,
  teamNameIn,
  teamShortNameIn,
  weeklyWagesOf,
  managedTeamId,
} from "../../common/core/state";
import { norm } from "../../common/core/team-ref";
import { topLeagues } from "../../common/data/league-catalog";
import { isWorldFigureName } from "../../common/data/world-figures";
import { generateOwner } from "../../common/people/persona";
import { type StandingRow, computeStandings } from "../../common/views/standings";
import { annualRevenueEstimate, wageRatioTone } from "../../common/finance/finance";

export const MANAGER_SEVERANCE_RATE = 0.5;
const DAYS_PER_YEAR = 365;

export function standingsCache(state: GameState): (leagueId: string) => StandingRow[] {
  const built = new Map<string, StandingRow[]>();
  return (leagueId) => {
    const table = built.get(leagueId) ?? computeStandings(state, leagueId);
    built.set(leagueId, table);
    return table;
  };
}

export function seatStatus(state: GameState, teamId: string, tableOf = standingsCache(state)) {
  const leagueId = leagueOfTeamIn(state, teamId);
  if (!topLeagues().some((league) => league.id === leagueId)) return null;
  const table = tableOf(leagueId);
  const index = table.findIndex((row) => row.teamId === teamId);
  return index < 0 ? null : { position: index + 1, played: table[index]!.played };
}

export function daysInCharge(
  state: GameState,
  team: { managerSince?: string } | undefined,
): number {
  return Math.max(0, diffDays(team?.managerSince ?? state.calendar.preseasonStart, state.date));
}

export function poolSacked(state: GameState, team: GameTeam): void {
  const name = team.managerName;
  if (
    !name ||
    name === state.manager.name ||
    state.managerPool.some((entry) => entry.name === name)
  )
    return;
  const entry: ManagerPoolEntry = {
    name,
    ...(isWorldFigureName(name) ? { real: true } : {}),
    rating: team.aiManagerTacticsRating ?? AI_MANAGER_RATING_FALLBACK,
    lastTeamId: team.id,
    sackedOn: state.date,
    spells: [
      ...team.managerSpells,
      { teamId: team.id, from: team.managerSince ?? state.calendar.preseasonStart, to: state.date },
    ],
  };
  state.managerPool.push(entry);
}

/** A vacancy is an unoccupied job, not an elapsed-time invitation. */
export function vacateManagerPost(state: GameState, team: GameTeam): void {
  poolSacked(state, team);
  delete team.managerName;
  delete team.managerSince;
  delete team.aiManagerTacticsRating;
  team.managerSpells = [];
  if (!state.managerVacancies.some((vacancy) => vacancy.teamId === team.id)) {
    const standing = seatStatus(state, team.id);
    state.managerVacancies.push({
      teamId: team.id,
      on: state.date,
      ...(standing ? { position: standing.position } : {}),
    });
  }
}

export function managerTeam(state: GameState, ref: string): GameTeam | undefined {
  const key = norm(ref);
  return state.teams.find((team) =>
    [team.id, teamNameIn(state, team.id), teamShortNameIn(state, team.id)].some(
      (name) => norm(name) === key,
    ),
  );
}

export function openManagerOffers(state: GameState): ManagerOffer[] {
  return state.managerOffers
    .filter((offer) => offer.status === "open" && offer.expiresOn >= state.date)
    .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.id.localeCompare(b.id));
}

export function expireStaleOffers(state: GameState, digest: TickSink): void {
  for (const offer of state.managerOffers) {
    if (offer.status !== "open" || offer.expiresOn >= state.date) continue;
    offer.status = "expired";
    digest.push(`${teamShortNameIn(state, offer.teamId)}의 감독직 제안이 만료됐다`);
  }
}

export function managerSeveranceOf(
  contract: Pick<ManagerContract, "salary" | "until">,
  today: string,
): number {
  return Math.min(
    contract.salary,
    Math.round(
      (contract.salary * Math.max(0, diffDays(today, contract.until)) * MANAGER_SEVERANCE_RATE) /
        DAYS_PER_YEAR,
    ),
  );
}

export function offerMatches(state: GameState, offer: ManagerOffer, ref: string): boolean {
  return [
    offer.id,
    offer.teamId,
    teamShortNameIn(state, offer.teamId),
    teamNameIn(state, offer.teamId),
  ].some((value) => norm(value) === norm(ref));
}

/** Check the same cash commitment at proposal, revision, and acceptance. Salary is a recurring contract expense. */
export function validateManagerTerms(
  state: GameState,
  teamId: string,
  terms: ManagerOfferTerms,
  compensation = 0,
): string | null {
  if (!ManagerOfferTermsSchema.safeParse(terms).success)
    return "유효한 계약 금액·연수·기한이 필요합니다";
  const deadline = new Date(`${terms.expiresOn}T00:00:00Z`);
  if (
    !Number.isFinite(deadline.getTime()) ||
    deadline.toISOString().slice(0, 10) !== terms.expiresOn
  )
    return "유효한 응답 날짜가 필요합니다";
  if (terms.expiresOn < state.date) return "응답 기한이 지났습니다";
  const finance = state.finances.find((entry) => entry.teamId === teamId);
  if (!finance) return "구단 재정 원장이 없습니다";
  const available = Math.max(0, finance.balance);
  if (compensation > available) return "보상금을 지급할 구단의 가용 현금이 부족합니다";
  return null;
}

function managerTermsBrief(
  state: GameState,
  teamId: string,
  terms: ManagerOfferTerms & { compensation?: number },
  head: string,
): CommandBrief {
  return {
    head,
    items: [
      item({ label: "구단", text: teamNameIn(state, teamId) }),
      item({ label: "연봉", text: formatMoney(terms.salary), note: `${terms.years}년` }),
      ...(terms.compensation
        ? [item({ label: "이직 보상금", text: formatMoney(terms.compensation) })]
        : []),
      item({ label: "응답 기한", text: terms.expiresOn }),
    ],
  };
}

export function offerManagerJob(state: GameState, raw: unknown, via?: "knock"): CommandResult {
  const parsed = ManagerJobOfferSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "유효한 감독직 제안 조건이 필요합니다" };
  const input = parsed.data;
  const team = managerTeam(state, input.team);
  if (!team) return { ok: false, message: "구단을 찾지 못했습니다" };
  const current = managedTeamId(state);
  const renewal = team.id === current;
  if (renewal && (!state.manager.contract || state.manager.contract.until < state.date))
    return { ok: false, message: "유효한 재직 계약이 없습니다" };
  if (!renewal && (!state.managerVacancies.some((v) => v.teamId === team.id) || team.managerName))
    return { ok: false, message: "실제 공석에만 감독직을 제안할 수 있습니다" };
  const compensation =
    !renewal && current && state.manager.contract
      ? managerSeveranceOf(state.manager.contract, state.date)
      : 0;
  const invalid = validateManagerTerms(state, team.id, input, compensation);
  if (invalid) return { ok: false, message: invalid };
  if (openManagerOffers(state).some((offer) => offer.teamId === team.id))
    return { ok: false, message: "이 구단의 열린 제안은 조건 수정으로 갱신하세요" };
  const standing = seatStatus(state, team.id);
  state.managerOffers.push({
    id: `mgr-offer-${team.id}-${state.date}-${state.managerOffers.length}`,
    teamId: team.id,
    madeOn: state.date,
    expiresOn: input.expiresOn,
    tier: tierOfTeamIn(state, team.id),
    ...(standing && standing.played > 0 ? { position: standing.position } : {}),
    salary: input.salary,
    years: input.years,
    ...(compensation > 0 ? { compensation } : {}),
    via: renewal ? "renewal" : (via ?? (current ? "poach" : "vacancy")),
    status: "open",
  });
  return {
    ok: true,
    brief: managerTermsBrief(state, team.id, { ...input, compensation }, "감독직 제안"),
    message: `${teamNameIn(state, team.id)} 감독직 제안 — 연봉 ${formatMoney(input.salary)} · ${input.years}년 · ${input.expiresOn}까지. 수락은 감독의 선택입니다`,
  };
}

export function acceptRenewal(state: GameState, offer: ManagerOffer): CommandResult {
  if (
    managedTeamId(state) !== offer.teamId ||
    !state.manager.contract ||
    state.manager.contract.until < state.date ||
    offer.via !== "renewal" ||
    offer.status !== "open"
  )
    return { ok: false, message: "유효한 재계약 제안이 아닙니다" };
  const invalid = validateManagerTerms(state, offer.teamId, offer);
  if (invalid) return { ok: false, message: invalid };
  offer.status = "accepted";
  state.manager.contract = {
    salary: offer.salary,
    signedOn: state.date,
    until: contractUntil(state.date, offer.years),
  };
  return {
    ok: true,
    brief: {
      head: "감독 재계약",
      items: [
        item({ label: "구단", text: teamNameIn(state, offer.teamId) }),
        item({
          label: "연봉",
          text: formatMoney(offer.salary),
          note: `${state.manager.contract.until}까지`,
        }),
      ],
    },
    message: `${teamNameIn(state, offer.teamId)} 재계약 — ${state.manager.contract.until}까지 · 연봉 ${formatMoney(offer.salary)}`,
  };
}

const CounterTermsSchema = ManagerOfferTermsSchema.partial().refine((input) =>
  Object.values(input).some((value) => value !== undefined),
);

/** Records the club's agreed revised offer; it does not accept it on the user's behalf. */
export function counterManagerOffer(state: GameState, ref: string, raw: unknown): CommandResult {
  const parsed = CounterTermsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "합의한 수정 조건이 필요합니다" };
  const offer =
    state.managerOffers.find((entry) => entry.id === ref) ??
    openManagerOffers(state).find((entry) => offerMatches(state, entry, ref));
  if (!offer || offer.status !== "open" || offer.expiresOn < state.date)
    return { ok: false, message: "열린 감독직 제안이 없습니다" };
  if (
    offer.via === "renewal"
      ? managedTeamId(state) !== offer.teamId
      : !state.managerVacancies.some((v) => v.teamId === offer.teamId)
  )
    return { ok: false, message: "이 제안의 고용 조건이 바뀌었습니다" };
  const revised = parsed.data;
  const terms = {
    ...offer,
    ...revised,
  };
  const invalid = validateManagerTerms(state, offer.teamId, terms, offer.compensation);
  if (invalid) return { ok: false, message: invalid };
  const unchanged =
    offer.salary === terms.salary &&
    offer.years === terms.years &&
    offer.expiresOn === terms.expiresOn;
  if (unchanged)
    return {
      ok: true,
      unchanged: true,
      message: "제안 조건이 같습니다",
      brief: managerTermsBrief(state, offer.teamId, offer, "감독직 조건 유지"),
    };
  offer.salary = terms.salary;
  offer.years = terms.years;
  offer.expiresOn = terms.expiresOn;
  return {
    ok: true,
    brief: managerTermsBrief(state, offer.teamId, offer, "감독직 조건 수정"),
    message: `${teamNameIn(state, offer.teamId)} 조건 수정 — 연봉 ${formatMoney(offer.salary)} · ${offer.years}년 · ${offer.expiresOn}까지`,
  };
}

/** 주급을 연 수입과 견주는 자 — 비전의 재정 항목과 같은 결이다 (career.md §5) */
const WEEKS_PER_YEAR = 52;

/** 면접 카드가 화면에서 서는 이름 — 다섯 줄이 전부 「보드」이면 무엇을 읽는지가 사라진다 */
export const INTERVIEW_FACT_KO: Partial<Record<InterviewFact["kind"], string>> = {
  standing: "자리",
  vacancy: "전임",
  "key-player": "선수단",
  "finance-grade": "재정",
};

/**
 * 그 선수단의 중심 — **1군 최고 종합 자원.** 부임 회견이 짚는 것과 같은 카드다
 * (people.md §4). 감독이 그 이름을 부를 수 있어야 면접이 「이 선수단을 어떻게
 * 쓰겠는가」의 자리가 된다.
 *
 * ⚠️ `about`을 걸지 않는다 — 아직 남의 구단 선수라 감독의 답이 그의 사기에 닿지
 * 않는다. 이름은 카드의 `name`이 든다.
 */
function keyPlayerOf(state: GameState, teamId: string): InterviewFact | null {
  const best = firstTeamPlayers(state, teamId).reduce<GamePlayer | null>(
    (top, p) => (top === null || p.attributes.overall > top.attributes.overall ? p : top),
    null,
  );
  if (!best) return null;
  const contract = activeContract(state, best.id);
  return {
    kind: "key-player",
    data: {
      name: best.name,
      tags: [naturalPositionOf(best).position],
      values: {
        age: ageOf(best.birthdate, state.date),
        ...(contract ? { contractDays: Math.max(0, diffDays(state.date, contract.until)) } : {}),
      },
    },
  };
}

/**
 * 재정 두 줄 — **등급이지 숫자가 아니다** (career.md §5.1). 아직 그 구단의 사람이
 * 아니라 장부를 열어 보여 주지 않는다.
 *
 * 급여 비중은 재정 보고서와 **같은 구간표**(`wageRatioTone`)를 읽고, 이적 예산은 그
 * 리그 안에서 선 자리를 삼분위로 가른다 — 절대액은 리그마다 자릿수가 달라 등급이
 * 되지 못한다.
 */
function financeGradeFacts(state: GameState, teamId: string): InterviewFact[] {
  const facts: InterviewFact[] = [];
  const revenue = annualRevenueEstimate(state, teamId);
  if (revenue > 0) {
    const ratio = (weeklyWagesOf(state, teamId) * WEEKS_PER_YEAR) / revenue;
    facts.push({
      kind: "finance-grade",
      data: { tags: ["wage-share", wageRatioTone(ratio)] },
      // 급여가 수입을 잡아먹는 구단은 감독이 첫날 알아야 하는 사실이다
    });
  }
  return facts;
}

/** Record an application interview with the target club's factual context. */
export function openInterview(state: GameState, vacancy: ManagerVacancy): ManagerInterview {
  const teamId = vacancy.teamId;
  const facts: InterviewFact[] = [
    {
      kind: "vacancy",
      data: {
        values: {
          days: Math.max(0, diffDays(vacancy.on, state.date)),
          ...(vacancy.position === undefined ? {} : { position: vacancy.position }),
        },
      },
    },
  ];
  const standing = seatStatus(state, teamId);
  if (standing && standing.played > 0)
    facts.unshift({ kind: "standing", data: { values: { rank: standing.position } } });
  const key = keyPlayerOf(state, teamId);
  if (key) facts.push(key);
  facts.push(...financeGradeFacts(state, teamId));

  const contextCard: ManagerInterviewContext = {
    code: "interview",
    ...(standing && standing.played > 0 ? { value: standing.position } : {}),
  };
  const idPrefix = `approach-interview-${teamId}-${state.date}`;
  let sequence = state.managerInterviews.length;
  while (state.managerInterviews.some((interview) => interview.id === `${idPrefix}-${sequence}`))
    sequence += 1;
  const approach: ManagerInterview = {
    id: `${idPrefix}-${sequence}`,
    date: state.date,
    // 우리 구단주가 아니라 **마주 앉은 쪽**의 사람이다 (people.md §8)
    speakerId: generateOwner(state.seed, teamId).characterId,
    teamId,
    contextCard,
    facts,
    status: "pending",
  };
  pushManagerInterview(state, approach);
  return approach;
}

export function settleInterview(
  state: GameState,
  interview: ManagerInterview,
  outcome: InterviewOutcome,
): CommandResult {
  if (!outcome.offer)
    return {
      ok: true,
      message: `면접 종료 — ${outcome.reason}`,
      brief: {
        head: "감독직 면접",
        items: [
          item({ label: "구단", text: teamNameIn(state, interview.teamId) }),
          item({ label: "결과", text: "제안 없이 종료", note: outcome.reason }),
        ],
      },
    };
  return offerManagerJob(
    state,
    { team: interview.teamId, ...outcome.terms, reason: outcome.reason },
    "knock",
  );
}
