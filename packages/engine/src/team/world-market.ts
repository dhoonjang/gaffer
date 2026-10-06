import {
  FREE_AGENT_TEAM,
  ageOf,
  contractEndForYears,
  currentProposal,
  isTransferWindow,
  isReserveMatch,
  playerOverall,
  positionGroupOfPlayer,
  proposalAgreed,
  type Negotiation,
  type ProposalTerms,
  type PositionGroup,
} from "@gaffer/domain";
import { activeContract, openInjury, managedTeamId, type GameState } from "../core/state";
import { addDays, diffDays } from "../core/dates";
import { canRegisterFor } from "./registration";
import { negotiationBounds } from "./acceptance-bounds";
import { actNegotiation, openNegotiation, settleNegotiations } from "./negotiation";

const MARKET_REVIEW_INTERVAL_DAYS = 7;
const MARKET_REVIEW_OLDEST_CLUBS = 10;
const MARKET_REVIEW_URGENT_CLUBS = 2;
export const MARKET_DAILY_DEALS = 2;
const MARKET_ACTIVE_ACQUISITIONS = 2;
const DEPTH_TARGET: Record<PositionGroup, number> = { GK: 2, DF: 6, MF: 6, FW: 4 };
const SELLING_MINIMUM: Record<PositionGroup, number> = { GK: 1, DF: 4, MF: 3, FW: 2 };
const LONG_INJURY_DAYS = 14;
const RENEWAL_HORIZON_DAYS = 180;
const DEAL_COOLDOWN_DAYS = 14;
const CLEARANCE_PREMIUM = 1.25;
const MANAGER_MINIMUM_TENURE_DAYS = 90;
const MANAGER_REVIEW_MATCHES = 8;
const MANAGER_MAXIMUM_POINTS = 4;
const MANAGER_INJURY_EXCEPTION_PLAYERS = 4;
interface WorldMarketIntent {
  playerId: string;
  buyerId: string;
  kind: "transfer" | "free" | "renewal";
  interest: boolean;
  reason: string;
}
export function marketClubFingerprint(state: GameState, teamId: string): string {
  const players = state.players.filter((p) => p.teamId === teamId);
  const ids = new Set(players.map((p) => p.id));
  return JSON.stringify([
    players.map((p) => [
      p.id,
      p.squadLevel,
      positionGroupOfPlayer(p),
      Math.round(playerOverall(p)),
    ]),
    state.contracts
      .filter((c) => ids.has(c.gamePlayerId) && c.status === "active")
      .map((c) => [c.id, c.until, c.weeklyWage, c.registrationStatus]),
    state.injuries.filter((i) => ids.has(i.gamePlayerId) && i.returnedOn === null),
    state.transferListings.filter((l) => ids.has(l.gamePlayerId)),
    state.finances.find((f) => f.teamId === teamId)?.balance,
    state.teams.find((t) => t.id === teamId)?.managerName,
  ]);
}
export function marketReviewCohort(state: GameState): string[] {
  const managed = managedTeamId(state);
  const review = new Map(state.marketReview.clubs.map((r) => [r.teamId, r]));
  const teams = state.finances
    .map((f) => f.teamId)
    .filter((id) => id !== managed && state.teams.some((t) => t.id === id))
    .sort(
      (a, b) =>
        (review.get(a)?.reviewedOn ?? "").localeCompare(review.get(b)?.reviewedOn ?? "") ||
        a.localeCompare(b),
    );
  const oldest = teams
    .filter(
      (id) =>
        !review.has(id) ||
        diffDays(review.get(id)!.reviewedOn, state.date) >= MARKET_REVIEW_INTERVAL_DAYS,
    )
    .slice(0, MARKET_REVIEW_OLDEST_CLUBS);
  const urgent: string[] = [];
  for (const id of teams) {
    if (
      !oldest.includes(id) &&
      review.has(id) &&
      review.get(id)!.fingerprint !== marketClubFingerprint(state, id)
    )
      urgent.push(id);
    if (urgent.length === MARKET_REVIEW_URGENT_CLUBS) break;
  }
  return [...oldest, ...urgent];
}
function activeCase(n: Negotiation): boolean {
  return (
    n.status === "open" ||
    n.status === "signed" ||
    (n.status === "completed" && n.registration !== "registered")
  );
}
function marketQueries(state: GameState) {
  const levels = new Map<string, number>();
  const groups = new Map<string, PositionGroup>();
  const contracts = new Map<string, ReturnType<typeof activeContract>>();
  const injuries = new Map<string, ReturnType<typeof openInjury>>();
  return {
    overall: (p: GameState["players"][number]) => {
      if (!levels.has(p.id)) levels.set(p.id, playerOverall(p));
      return levels.get(p.id)!;
    },
    group: (p: GameState["players"][number]) => {
      if (!groups.has(p.id)) groups.set(p.id, positionGroupOfPlayer(p));
      return groups.get(p.id)!;
    },
    contract: (id: string) => {
      if (!contracts.has(id)) contracts.set(id, activeContract(state, id));
      return contracts.get(id) ?? null;
    },
    injury: (id: string) => {
      if (!injuries.has(id)) injuries.set(id, openInjury(state, id));
      return injuries.get(id) ?? null;
    },
  };
}
function viableSquad(state: GameState, teamId: string, queries = marketQueries(state)) {
  const squad = state.players.filter((p) => p.teamId === teamId && queries.contract(p.id));
  const level = squad.length
    ? squad.reduce((s, p) => s + queries.overall(p), 0) / squad.length
    : 60;
  return {
    level,
    players: squad.filter(
      (p) =>
        queries.overall(p) >= level - 15 &&
        queries.contract(p.id)?.registrationStatus !== "pending" &&
        (!queries.injury(p.id) ||
          diffDays(state.date, queries.injury(p.id)!.expectedReturn) < LONG_INJURY_DAYS),
    ),
  };
}
export function decideWorldMarket(state: GameState, buyerId: string): WorldMarketIntent | null {
  const managed = managedTeamId(state);
  if (buyerId === managed) return null;
  const queries = marketQueries(state);
  // canRegisterFor reads only the destination first-team squad from players.
  const registrationState = {
    ...state,
    players: state.players.filter((p) => p.teamId === buyerId),
  };
  const squad = viableSquad(state, buyerId, queries);
  const renewing = squad.players
    .filter((p) => {
      const c = queries.contract(p.id)!;
      return (
        c.until >= state.date &&
        c.until <= addDays(state.date, RENEWAL_HORIZON_DAYS) &&
        ageOf(p.birthdate, state.date) < (queries.group(p) === "GK" ? 38 : 35) &&
        !state.negotiations.some(
          (n) =>
            n.playerId === p.id &&
            n.buyerId === buyerId &&
            (activeCase(n) ||
              (n.status === "withdrawn" &&
                diffDays(n.closed?.on ?? n.openedOn, state.date) < DEAL_COOLDOWN_DAYS)),
        )
      );
    })
    .sort(
      (a, b) =>
        queries.contract(a.id)!.until.localeCompare(queries.contract(b.id)!.until) ||
        queries.overall(b) - queries.overall(a) ||
        a.id.localeCompare(b.id),
    )[0];
  if (renewing)
    return {
      playerId: renewing.id,
      buyerId,
      kind: "renewal",
      interest: false,
      reason: "기존 전력의 계약 만료가 6개월 안에 도래",
    };
  const acquisitions = state.negotiations.filter(
    (n) => n.buyerId === buyerId && n.kind !== "renewal" && activeCase(n),
  );
  if (acquisitions.length >= MARKET_ACTIVE_ACQUISITIONS) return null;
  const depth = { GK: 0, DF: 0, MF: 0, FW: 0 };
  squad.players.forEach((p) => depth[queries.group(p)]++);
  for (const n of acquisitions) {
    const p = state.players.find((p) => p.id === n.playerId);
    if (p && p.teamId !== buyerId) depth[queries.group(p)]++;
  }
  const needed = (Object.keys(DEPTH_TARGET) as PositionGroup[])
    .filter((group) => depth[group] < DEPTH_TARGET[group])
    .sort(
      (a, b) =>
        (DEPTH_TARGET[b] - depth[b]) / DEPTH_TARGET[b] -
          (DEPTH_TARGET[a] - depth[a]) / DEPTH_TARGET[a] || a.localeCompare(b),
    )[0];
  if (!needed) return null;
  const sellerSquads = new Map<string, ReturnType<typeof viableSquad>>();
  const candidates = state.players
    .filter((p) => {
      if (
        p.teamId === buyerId ||
        queries.group(p) !== needed ||
        queries.injury(p.id) ||
        ageOf(p.birthdate, state.date) > 34
      )
        return false;
      if (
        state.negotiations.some(
          (n) =>
            n.playerId === p.id &&
            (n.status === "signed" ||
              (n.buyerId === buyerId &&
                (activeCase(n) ||
                  (n.status === "withdrawn" &&
                    diffDays(n.closed?.on ?? n.openedOn, state.date) < DEAL_COOLDOWN_DAYS)))),
        )
      )
        return false;
      if (p.teamId === FREE_AGENT_TEAM) return !queries.contract(p.id);
      if (
        !isTransferWindow(state.date) ||
        !queries.contract(p.id) ||
        queries.contract(p.id)!.until < addDays(state.date, 2)
      )
        return false;
      if (p.teamId === managed) return state.transferListings.some((l) => l.gamePlayerId === p.id);
      let seller = sellerSquads.get(p.teamId);
      if (!seller) {
        seller = viableSquad(state, p.teamId, queries);
        sellerSquads.set(p.teamId, seller);
      }
      return (
        seller.players.filter(
          (s) =>
            queries.group(s) === needed &&
            !state.negotiations.some(
              (n) =>
                n.playerId === s.id &&
                n.sellerId === p.teamId &&
                n.buyerId !== p.teamId &&
                (n.status === "signed" ||
                  (n.status === "open" && proposalAgreed(n, currentProposal(n, "club")))),
            ),
        ).length > SELLING_MINIMUM[needed]
      );
    })
    .sort(
      (a, b) =>
        Number(b.teamId === FREE_AGENT_TEAM) - Number(a.teamId === FREE_AGENT_TEAM) ||
        Number(state.transferListings.some((l) => l.gamePlayerId === b.id)) -
          Number(state.transferListings.some((l) => l.gamePlayerId === a.id)) ||
        Math.abs(queries.overall(a) - squad.level) - Math.abs(queries.overall(b) - squad.level) ||
        a.id.localeCompare(b.id),
    );
  for (const p of candidates) {
    if (queries.overall(p) < squad.level - 15 || !canRegisterFor(registrationState, p, buyerId).ok)
      continue;
    const kind = p.teamId === FREE_AGENT_TEAM ? "free" : "transfer";
    const bounds = negotiationBounds(state, { playerId: p.id, buyerId, sellerId: p.teamId, kind });
    if (
      bounds.minWeeklyWage > bounds.maxWeeklyWage ||
      (kind === "transfer" && Math.ceil(bounds.minFee * CLEARANCE_PREMIUM) > bounds.maxFee)
    )
      continue;
    return {
      playerId: p.id,
      buyerId,
      kind,
      interest: p.teamId === managed,
      reason: `${needed} 주 포지션의 가용 전력 부족`,
    };
  }
  return null;
}
export function applyWorldMarketIntent(state: GameState, intent: WorldMarketIntent): string | null {
  if (!executeWorldMarketIntent(structuredClone(state), intent)) return null;
  // Identical deterministic commands preserve existing ledger object references.
  return executeWorldMarketIntent(state, intent);
}
function executeWorldMarketIntent(state: GameState, intent: WorldMarketIntent): string | null {
  if (intent.interest || intent.buyerId === managedTeamId(state)) return null;
  const draft = state,
    player = draft.players.find((p) => p.id === intent.playerId);
  if (!player || player.teamId === managedTeamId(draft)) return null;
  const result = openNegotiation(
    draft,
    { playerId: player.id, buyerId: intent.buyerId, kind: intent.kind, background: intent.reason },
    "world",
  );
  if (!result.ok || !result.negotiationId) return null;
  const n = draft.negotiations.find((n) => n.id === result.negotiationId)!;
  if (n.status !== "open" || (n.proposals.length && currentProposal(n, "player"))) return null;
  const act = (action: unknown, partyId: string) =>
    actNegotiation(draft, n.id, action, { kind: "model", partyId }).ok;
  const since = intent.kind === "renewal" ? draft.date : addDays(draft.date, 2),
    age = ageOf(player.birthdate, draft.date),
    years = age > 33 ? 1 : age > 29 ? 2 : 3;
  const terms: ProposalTerms = {
    scope: "player",
    fee: 0,
    installments: [],
    weeklyWage: Math.max(activeContract(draft, player.id)?.weeklyWage ?? 0, n.bounds.minWeeklyWage),
    signingBonus: 0,
    since,
    until: contractEndForYears(since, years),
    expiresOn: addDays(draft.date, 7),
    promises: [],
  };
  if (intent.kind === "transfer") {
    if (
      !act(
        {
          kind: "send",
          terms: {
            ...terms,
            scope: "club",
            weeklyWage: 0,
            fee: Math.ceil(n.bounds.minFee * CLEARANCE_PREMIUM),
          },
        },
        n.buyerId,
      )
    )
      return null;
    if (!act({ kind: "accept", proposalId: currentProposal(n, "club")!.id }, n.sellerId))
      return null;
  }
  if (
    !act({ kind: "send", terms }, n.buyerId) ||
    !act({ kind: "accept", proposalId: currentProposal(n, "player")!.id }, n.playerId)
  )
    return null;
  if (!act({ kind: intent.kind === "renewal" ? "sign" : "medical" }, n.buyerId)) return null;
  return n.id;
}
export function progressWorldMarketDeals(state: GameState): string[] {
  const changed = new Set<string>();
  if (state.phase === "match") return [];
  const managed = managedTeamId(state),
    before = state.moves.length;
  settleNegotiations(state);
  state.moves.slice(before).forEach((m) => {
    if (m.fromTeamId) changed.add(m.fromTeamId);
    if (m.toTeamId) changed.add(m.toTeamId);
  });
  for (const id of state.negotiations.filter((n) => n.buyerId !== managed).map((n) => n.id)) {
    const n = state.negotiations.find((n) => n.id === id)!;
    const actor = { kind: "model" as const, partyId: n.buyerId };
    const act = (kind: "medical" | "acknowledge_medical" | "sign" | "register") =>
      actNegotiation(state, id, { kind }, actor).ok;
    if (n.status === "completed") {
      if (n.registration !== "registered" && act("register")) changed.add(n.buyerId);
      continue;
    }
    if (n.status !== "open") continue;
    const player = currentProposal(n, "player"),
      club = currentProposal(n, "club");
    if (
      !player ||
      player.terms.expiresOn < state.date ||
      !proposalAgreed(n, player) ||
      (n.kind === "transfer" &&
        (!club || club.terms.expiresOn < state.date || !proposalAgreed(n, club)))
    )
      continue;
    if (n.kind !== "renewal") {
      if (!n.medical) {
        act("medical");
        continue;
      }
      if (!n.medical.examinedOn) continue;
      if (n.medical.injuries.length || openInjury(state, n.playerId)) {
        actNegotiation(
          state,
          id,
          { kind: "withdraw", reason: "검사 시점의 실제 부상으로 영입을 재검토" },
          actor,
        );
        continue;
      }
      if (!n.medical.acknowledgedBy.includes(n.buyerId) && !act("acknowledge_medical")) continue;
    }
    if (act("sign")) {
      changed.add(n.sellerId);
      changed.add(n.buyerId);
      if (state.negotiations.find((item) => item.id === id)?.status === "completed")
        act("register");
    }
  }
  return [...changed];
}
export function decideWorldManager(
  state: GameState,
  teamId: string,
):
  | { team: string; action: "dismiss"; reason: string }
  | { team: string; action: "appoint"; reason: string; managerName: string; rating: number }
  | null {
  const team = state.teams.find((t) => t.id === teamId);
  if (!team || teamId === managedTeamId(state)) return null;
  if (!team.managerName) {
    if (!state.managerVacancies.some((v) => v.teamId === teamId)) return null;
    const candidate = state.managerPool
      .filter(
        (c) =>
          c.name !== state.manager.name &&
          !(
            c.lastTeamId === teamId &&
            diffDays(c.sackedOn, state.date) < MANAGER_MINIMUM_TENURE_DAYS
          ) &&
          !state.teams.some((t) => t.managerName === c.name) &&
          !state.personas.some(
            (p) => p.name === c.name && p.employment && p.employment.contract.until >= state.date,
          ),
      )
      .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name))[0];
    return candidate
      ? {
          team: teamId,
          action: "appoint",
          managerName: candidate.name,
          rating: candidate.rating,
          reason: "실제 공석에 가용 감독 후보의 전술 역량을 비교해 선임",
        }
      : null;
  }
  if (
    diffDays(team.managerSince ?? `${state.date.slice(0, 4)}-07-01`, state.date) <
    MANAGER_MINIMUM_TENURE_DAYS
  )
    return null;
  const squad = state.players.filter((p) => p.teamId === teamId);
  if (
    squad.filter((p) => {
      const injury = openInjury(state, p.id);
      return injury && diffDays(state.date, injury.expectedReturn) >= LONG_INJURY_DAYS;
    }).length >= MANAGER_INJURY_EXCEPTION_PLAYERS
  )
    return null;
  const recent = state.matches
    .filter(
      (m) =>
        m.season === state.season &&
        m.competitionId !== null &&
        !isReserveMatch(m) &&
        m.result &&
        m.date <= state.date &&
        (m.homeTeamId === teamId || m.awayTeamId === teamId),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
    .slice(0, MANAGER_REVIEW_MATCHES);
  if (recent.length < MANAGER_REVIEW_MATCHES) return null;
  const points = recent.reduce((total, m) => {
    const home = m.homeTeamId === teamId,
      own = home ? m.result!.homeGoals : m.result!.awayGoals,
      against = home ? m.result!.awayGoals : m.result!.homeGoals;
    return total + (own > against ? 3 : own === against ? 1 : 0);
  }, 0);
  return points <= MANAGER_MAXIMUM_POINTS
    ? {
        team: teamId,
        action: "dismiss",
        reason: "90일 이상 재임 후 최근 공식 8경기 승점 4 이하, 장기 부상 대량 이탈 없음",
      }
    : null;
}
