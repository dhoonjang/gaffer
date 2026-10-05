import { norm } from "../../core/team-ref";
import {
  type GameState,
  teamNameIn,
  pendingManagerInterview,
  teamShortNameIn,
  expireManagerInterview,
  managedTeamId,
} from "../../core/state";
import {
  type TickSink,
  josa,
  josaOf,
  managerInterviewContextText,
  interviewFactText,
  type Dismissal,
  formatMoney,
  type ManagerOffer,
} from "@story-fm/domain";
import {
  openInterview,
  INTERVIEW_FACT_KO,
  seatStatus,
  managerSeveranceOf,
  offerMatches,
  acceptRenewal,
  vacateManagerPost,
  validateManagerTerms,
} from "../../people/manager-employment";
import { contractUntil } from "../../core/dates";
import { type CommandResult, item } from "../../core/command-result";
import { tierOfTeamIn, leagueOfTeamIn } from "../../core/league-membership";
import { generateOwner, reseatClubPersonas } from "../../people/persona";
import { reportSacking } from "../../people/media";
import { payManagerSeverance } from "../../team/finance";
import { recordFinance } from "../../core/ledger";
import { syncDefaultTraining } from "../../players/training-plan";

export function applyForManagerJob(state: GameState, teamRef: string): CommandResult {
  if (state.pendingMatch) return { ok: false, message: "진행 중인 경기를 먼저 마쳐야 합니다" };
  const key = norm(teamRef);
  const vacancy = state.managerVacancies.find(
    (v) =>
      norm(v.teamId) === key ||
      norm(teamShortNameIn(state, v.teamId)) === key ||
      norm(teamNameIn(state, v.teamId)) === key,
  );
  if (!vacancy) {
    const open = state.managerVacancies.map((v) => teamShortNameIn(state, v.teamId));
    return {
      ok: false,
      message:
        open.length > 0
          ? `"${teamRef}"${josaOf(teamRef, "은/는")} 최근 공석이 아닙니다 — 지금 공석: ${open.join(", ")}`
          : `"${teamRef}"${josaOf(teamRef, "은/는")} 최근 공석이 아닙니다 — 지금 지원할 수 있는 공석이 없습니다`,
    };
  }
  if (pendingManagerInterview(state, vacancy.teamId)) {
    return {
      ok: false,
      message: `${teamNameIn(state, vacancy.teamId)}의 면접이 이미 열려 있습니다`,
    };
  }
  const approach = openInterview(state, vacancy);
  const owner = generateOwner(state.seed, vacancy.teamId);
  const line = managerInterviewContextText(approach.contextCard, {
    subject: teamNameIn(state, vacancy.teamId),
  });
  return {
    ok: true,
    tone: "good",
    message:
      `${josa(teamNameIn(state, vacancy.teamId), "이/가")} 면접 자리를 열었습니다 —` +
      ` ${josa(`${owner.name}(구단주)`, "이/가")} 마주 앉습니다 (${line}).` +
      ` 감독의 답이 제안 조건을 정합니다`,
    brief: {
      head: "감독직 면접",
      items: [
        item({ label: teamNameIn(state, vacancy.teamId), text: owner.name, note: line }),
        ...approach.facts.map((f) =>
          item({ label: INTERVIEW_FACT_KO[f.kind] ?? "보드", text: interviewFactText(f) }),
        ),
      ],
    },
  };
}

function leaveClub(state: GameState, card: Dismissal): void {
  const teamId = card.teamId;
  const contract = state.manager.contract;
  if (contract && card.kind !== "resigned" && card.kind !== "moved") {
    const severance = managerSeveranceOf(contract, state.date);
    if (severance > 0) {
      payManagerSeverance(state, teamId, severance);
      card.severance = severance;
    }
  }
  state.dismissal = card;
  delete state.manager.contract;

  const team = state.teams.find((t) => t.id === teamId);
  reportSacking(state, {
    teamId,
    kind: card.kind,
    ...(card.position === undefined ? {} : { position: card.position }),

    ...(team?.managerSince === undefined ? {} : { since: team.managerSince }),
  });
  if (team) vacateManagerPost(state, team);

  // 답을 기다리던 재계약 제안도 닫힌다 — 다시 계약할 구단이 없어졌다 (career.md §5.4)
  for (const offer of state.managerOffers) {
    if (offer.status === "open") offer.status = "expired";
  }
  expireManagerInterview(state);
}

export function resignPost(state: GameState): CommandResult {
  if (state.pendingMatch) return { ok: false, message: "진행 중인 경기를 먼저 마쳐야 합니다" };
  const teamId = managedTeamId(state);
  if (teamId === null) return { ok: false, message: "이미 무직입니다" };

  const contract = state.manager.contract;
  const buyout = contract ? managerSeveranceOf(contract, state.date) : 0;
  if (buyout > 0) {
    recordFinance(state, teamId, {
      kind: "income",
      category: "manager_buyout",
      label: "감독 사임 위약금",
      amount: buyout,
    });
  }

  const standing = seatStatus(state, teamId);
  leaveClub(state, {
    on: state.date,
    season: state.season,
    kind: "resigned",
    teamId,
    tier: tierOfTeamIn(state, teamId),
    ...(standing && standing.played > 0 ? { position: standing.position } : {}),

    ...(buyout > 0 ? { severance: buyout } : {}),
  });

  const line = `사임 — ${josa(teamNameIn(state, teamId), "을/를")} 떠났다${buyout > 0 ? ` · 위약금 ${formatMoney(buyout)}` : ""}`;
  return {
    ok: true,
    message: `${line}. 이제 무직입니다`,
    brief: {
      head: "사임",
      items: [
        item({ label: "구단", text: teamShortNameIn(state, teamId) }),
        ...(buyout > 0 ? [item({ label: "위약금", text: formatMoney(buyout) })] : []),
      ],
    },
  };
}

export function reviewManagerContract(state: GameState, digest: TickSink): "expired" | null {
  // 무직에겐 계약이 없다 — 경질이 이미 지웠다
  if (state.dismissal) return null;
  const contract = state.manager.contract;
  if (!contract) return null;

  if (state.date > contract.until) {
    const teamId = state.userTeamId;

    // 순위는 있으면 싣는다 — 만료는 성적이 부른 일이 아니지만 그날의 자리는 사실이다
    const standing = seatStatus(state, teamId);
    leaveClub(state, {
      on: state.date,
      season: state.season,
      kind: "expired",
      teamId,
      tier: tierOfTeamIn(state, teamId),
      ...(standing && standing.played > 0 ? { position: standing.position } : {}),
    });
    digest.push(
      `계약 만료 — ${josa(teamNameIn(state, teamId), "과/와")}의 계약이 ${josa(contract.until, "으로/로")} 끝났다`,
    );
    return "expired";
  }

  return null;
}

export function dismissUserManager(state: GameState, digest: TickSink): boolean {
  if (state.dismissal || !state.manager.contract) return false;
  const standing = seatStatus(state, state.userTeamId);

  const sackedTeamId = state.userTeamId;
  leaveClub(state, {
    on: state.date,
    season: state.season,
    kind: "sacked",
    teamId: sackedTeamId,
    tier: tierOfTeamIn(state, sackedTeamId),
    ...(standing && standing.played > 0 ? { position: standing.position } : {}),
  });

  digest.push(`경질 — ${josa(teamNameIn(state, sackedTeamId), "이/가")} 감독 계약을 해지했다`);
  return true;
}

function leaveForMove(state: GameState, offer: ManagerOffer): Dismissal {
  const fromTeamId = state.userTeamId;
  const compensation = offer.compensation ?? 0;
  if (compensation > 0) {
    // `userTeamId`가 아직 옛 구단이라 이 줄이 **옛 구단** 원장에 선다 (`recordFinance`)
    recordFinance(state, fromTeamId, {
      kind: "income",
      category: "manager_compensation",
      label: `감독 이적 보상금 — ${teamShortNameIn(state, offer.teamId)}`,
      amount: compensation,
    });
  }

  const standing = seatStatus(state, fromTeamId);
  const card: Dismissal = {
    on: state.date,
    season: state.season,
    kind: "moved",
    teamId: fromTeamId,
    tier: tierOfTeamIn(state, fromTeamId),
    ...(standing && standing.played > 0 ? { position: standing.position } : {}),

    ...(compensation > 0 ? { severance: compensation } : {}),
  };
  leaveClub(state, card);
  return card;
}

export function acceptManagerOffer(state: GameState, ref: string): CommandResult {
  if (state.pendingMatch) return { ok: false, message: "진행 중인 경기를 먼저 마쳐야 합니다" };
  const offer =
    state.managerOffers.find((o) => o.id === ref) ??
    state.managerOffers.find(
      (o) => o.status === "open" && o.expiresOn >= state.date && offerMatches(state, o, ref),
    ) ??
    state.managerOffers.find((o) => offerMatches(state, o, ref));
  if (!state.dismissal) {
    if (offer?.via === "renewal") return acceptRenewal(state, offer);
    const moving =
      offer !== undefined &&
      (offer.via === "poach" || offer.via === "knock") &&
      offer.teamId !== state.userTeamId;
    if (!moving) {
      return {
        ok: false,
        message: `${teamNameIn(state, state.userTeamId)} 감독으로 재직 중입니다`,
      };
    }
  }
  if (!offer) return { ok: false, message: `"${ref}"에 해당하는 감독직 제안이 없습니다` };
  if (offer.status !== "open" || offer.expiresOn < state.date) {
    return {
      ok: false,
      message: `${teamNameIn(state, offer.teamId)}의 제안은 ${offer.expiresOn}에 만료됐습니다`,
    };
  }

  const target = state.teams.find((team) => team.id === offer.teamId);
  if (
    !target ||
    target.managerName ||
    !state.managerVacancies.some((v) => v.teamId === offer.teamId)
  ) {
    return { ok: false, message: "이 감독직은 더 이상 공석이 아닙니다" };
  }
  const invalid = validateManagerTerms(state, offer.teamId, offer, offer.compensation);
  if (invalid) return { ok: false, message: invalid };
  offer.status = "accepted";
  const fromTeamId = state.userTeamId;
  const leaving = state.dismissal ?? leaveForMove(state, offer);
  const compensation = leaving.kind === "moved" ? (leaving.severance ?? 0) : 0;
  const team = state.teams.find((t) => t.id === offer.teamId);
  // 경질 뒤에도 `userTeamId`는 옛 구단이다 (§5.1) — 떠나기 전에 리그를 읽어 둔다
  const fromLeague = leagueOfTeamIn(state, state.userTeamId);
  state.userTeamId = offer.teamId;
  if (team) {
    team.managerName = state.manager.name;
    team.managerSince = state.date;
    // 전임의 이력은 그를 따라 풀로 갔다 — 감독의 커리어는 `dismissals`가 든다
    team.managerSpells = [];
  }
  const contract = {
    salary: offer.salary,
    signedOn: state.date,
    until: contractUntil(state.date, offer.years),
  };
  state.manager.contract = contract;
  if (compensation > 0) {
    recordFinance(state, offer.teamId, {
      kind: "expense",
      category: "severance",
      label: `감독 이적 보상금 — ${teamShortNameIn(state, fromTeamId)}`,
      amount: compensation,
    });
  }
  // 부임한 감독에게 공석은 더 이상 문이 아니다
  state.managerVacancies = state.managerVacancies.filter(
    (vacancy) => vacancy.teamId !== offer.teamId,
  );
  state.dismissals = [...state.dismissals, leaving];
  delete state.dismissal;
  for (const other of state.managerOffers) {
    if (other.status === "open") other.status = "expired";
  }
  state.managerInterviews = [];
  // 기본 훈련은 새 선수단으로 다시 깔린다
  syncDefaultTraining(state);
  // 수석코치·구단주는 구단의 사람이라 새 구단 기준으로 다시 서고,
  // 기자단은 리그를 따라다니므로 리그를 건널 때만 갈린다 (career.md §5.1)
  reseatClubPersonas(state, offer.teamId, {
    crossedLeague: fromLeague !== leagueOfTeamIn(state, offer.teamId),
  });
  const name = teamNameIn(state, offer.teamId);
  return {
    ok: true,
    message:
      `${name} 감독으로 부임했습니다 (${state.date}).` +
      (offer.position === undefined ? "" : ` 제안 당시 리그 ${offer.position}위입니다.`) +
      ` 계약은 연봉 ${formatMoney(contract.salary)}에 ${contract.until}까지` +
      (compensation > 0
        ? `. 보상금 ${josa(formatMoney(compensation), "은/는")} ${teamNameIn(state, fromTeamId)}의 장부로 갔습니다`
        : ""),
    tone: "good",
    brief: {
      head: compensation > 0 ? "이적 부임" : "부임",
      items: [
        item({ label: "구단", text: name }),
        item({ label: "연봉", text: formatMoney(contract.salary), note: `${contract.until}까지` }),
        ...(compensation > 0
          ? [
              item({
                label: "보상금",
                text: formatMoney(compensation),
                note: josa(teamShortNameIn(state, fromTeamId), "으로/로"),
              }),
            ]
          : []),
      ],
    },
  };
}
