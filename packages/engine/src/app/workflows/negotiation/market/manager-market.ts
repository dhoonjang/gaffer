import { norm } from "../../../../common/core/team-ref";
import {
  type GameState,
  teamNameIn,
  pushNarrative,
  pendingApproach,
  teamShortNameIn,
  teamShortName,
  teamName,
  expirePendingApproach,
  managedTeamId,
  financeOf,
} from "../../../../common/core/state";
import {
  type TickSink,
  APPROACH_PATIENCE_DAYS,
  josa,
  josaOf,
  approachContextText,
  APPROACH_CHANNEL_LABEL,
  pressFactText,
  type Dismissal,
  formatMoney,
  RENEWAL_NOTICE_DAYS,
  type ManagerOffer,
} from "@story-fm/domain";
import {
  pendingInterview,
  openManagerOffers,
  pruneVacancies,
  spellStart,
  interviewedSince,
  OFFER_REPUTATION_GATE,
  openInterview,
  INTERVIEW_FACT_KO,
  standingsCache,
  expireStaleOffers,
  SACKINGS_PER_DAY,
  daysInCharge,
  GRACE_DAYS,
  seatStatus,
  MIN_MATCHES,
  managerSeatThresholds,
  SACK_CHANCE,
  installNewManager,
  offerVacancy,
  managerSeveranceOf,
  standRenewalOffer,
  offerMatches,
  acceptRenewal,
  poolSacked,
  offerExpectation,
} from "../../../../negotiation/market/manager-market";
import { diffDays, contractUntil } from "../../../../common/core/dates";
import { type CommandResult } from "../../../../common/commands/result";
import { tierOfTeamIn } from "../../../../common/core/club-tier";
import { item } from "../../../../common/commands/brief";
import { generateOwner, reseatClubPersonas } from "../../../../common/people/persona";
import { makeRng } from "../../../../common/core/rng";
import { leagueOfTeamIn } from "../../../../common/core/league-membership";
import { derbyOf } from "../../../../common/data/derbies";
import { reportSacking, reportAppointment } from "../../../../story/world/media";
import { boardExpectation } from "../../../../common/views/board-expectation";
import { payManagerSeverance, recordFinance } from "../../../../negotiation/finance/finance";
import { spendFromWallet, walletOf } from "../../../../negotiation/finance/manager-wallet";
import { expirePendingPress } from "../../../../story/world/press";
import { syncDefaultTraining } from "../../../../story/players/training-plan";
import { openAppointmentPress } from "../../story/world/press";

/**
 * 사흘이 지난 면접은 닫힌다 — **대가 없이** (career.md §5.1). 평판도 사이도 옮기지
 * 않는 자리라 남는 것은 그 구단의 문이 이번 무직 기간에 다시 열리지 않는다는 사실뿐이다.
 *
 * @returns 오늘 닫았으면 true — tick이 그 하루를 세워 감독에게 알린다
 */
export function expireInterview(state: GameState, digest: TickSink): boolean {
  const open = pendingInterview(state);
  if (!open || diffDays(open.date, state.date) < APPROACH_PATIENCE_DAYS) return false;
  open.status = "expired";
  const name = teamNameIn(state, open.teamId ?? "");
  digest.push(`${josa(name, "과/와")}의 면접이 답 없이 지나갔다 — 그 자리는 닫혔다`);
  pushNarrative(state, `${name} 감독직 면접 무응답`, 4);
  return true;
}

/**
 * **노크 — 감독이 공석에 먼저 지원한다** (career.md §5.1).
 *
 * 공석 명부(`state.managerVacancies`)에 있는 구단만 두드릴 수 있고, 평판 문턱은
 * 제안과 같은 표(`OFFER_REPUTATION_GATE`)다. 확률이 없다 — 문은 열리거나 안
 * 열리거나다.
 *
 * **재직 중에도 열려 있다** (career.md §5.1 「재직 중 접근·노크」). 갈리는 것은
 * 대가다 — 문이 열린 그날 보드 평판이 `KNOCK_BOARD_HIT`만큼 깎이고, 그 사실이
 * 다음 회견에 `job-link` 카드로 선다 (`club/press.ts`).
 *
 * ⚠️ **문턱을 넘어도 제안이 서지는 않는다.** 그 자리에 서는 것은 **면접**이고,
 * 조건은 감독이 구단주의 물음에 어떻게 답하느냐가 정한다 (`settleInterview`).
 * 공석이 먼저 부르는 길(`offerVacancy`)만 그대로 제안이다 — 부른 쪽이 아쉽다.
 *
 * @param teamRef 구단 id 또는 이름·약칭
 */
export function applyForManagerJob(state: GameState, teamRef: string): CommandResult {
  const inPost = state.dismissal === undefined;
  if (openManagerOffers(state).length > 0) {
    return {
      ok: false,
      message: "열린 제안이 있는 동안에는 지원할 수 없습니다 — 답할 자리는 한 번에 하나입니다",
    };
  }
  /**
   * **감독 앞에 두 자리가 서지 않는다** ([people.md] §8). 무직에게 열릴 수 있는 자리는
   * 면접 하나지만 재직 중에는 선수도 구단주도 감독실 앞에 선다 — 그 자리를 두고 문을
   * 하나 더 열면 뒤에 선 쪽이 `pendingApproach`에 잡히지 않아 답 한 번 못 받고 사흘 뒤
   * 사라진다.
   */
  const sitting = pendingApproach(state);
  if (sitting) {
    return {
      ok: false,
      message:
        sitting.topic === "interview"
          ? `${josa(teamNameIn(state, sitting.teamId ?? ""), "과/와")}의 면접이 아직 열려 있습니다 — 답할 자리는 한 번에 하나입니다`
          : `감독실 앞에 아직 답을 기다리는 사람이 있습니다 — 답할 자리는 한 번에 하나입니다`,
    };
  }
  pruneVacancies(state);
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
  const since = spellStart(state);
  if (
    state.managerOffers.some((o) => o.madeOn >= since && o.teamId === vacancy.teamId) ||
    interviewedSince(state, vacancy.teamId, since)
  ) {
    return {
      ok: false,
      message:
        `${josa(teamNameIn(state, vacancy.teamId), "과/와")}는 이번 ${inPost ? "임기" : "무직 기간"}에` +
        ` 이미 이야기가 오갔습니다`,
    };
  }

  const tier = tierOfTeamIn(state, vacancy.teamId);
  const gate = OFFER_REPUTATION_GATE[tier];
  const reputation = (state.manager.reputation.board + state.manager.reputation.media) / 2;
  if (gate !== undefined && reputation < gate) {
    // 거절도 게임의 사실이다 — 기록은 남기지 않는다: 평판을 회복하면 다시 두드릴 수 있다
    pushNarrative(state, `${teamNameIn(state, vacancy.teamId)} 감독직 지원 거절`, 3);
    return {
      ok: true,
      tone: "bad",
      message:
        `${josa(teamNameIn(state, vacancy.teamId), "이/가")} 정중히 거절했습니다 —` +
        ` 평판 ${josa(`${Math.round(reputation)}`, "이/가")} ${tier}티어의 문턱 ${gate}에 미치지 못합니다`,
      brief: {
        head: "감독직 지원",
        items: [
          item({ label: teamNameIn(state, vacancy.teamId), text: "거절" }),
          item({
            label: "평판",
            text: `${Math.round(reputation)}`,
            note: `${tier}티어 문턱 ${gate}`,
          }),
        ],
      },
    };
  }

  /**
   * 문이 열렸다 — **구단주가 마주 앉는다.** 제안이 아니라 자리다 (career.md §5.1).
   * 사실 카드를 결과에 실어 보내는 것은 이 턴에 GM이 그 장면을 쓸 수 있어야 하기
   * 때문이다: 스냅샷의 `<approach>`는 다음 턴에야 선다.
   */
  const approach = openInterview(state, vacancy);
  const owner = generateOwner(state.seed, vacancy.teamId);
  const line = approachContextText(approach.contextCard, {
    subject: teamNameIn(state, vacancy.teamId),
  });
  /**
   * **재직 중의 노크는 언론에 새는 사실이다** (career.md §5.1). 자리가 선 그날
   * 보드가 그것을 알고, 다음 회견의 `job-link` 카드가 같은 사실을 읽는다 —
   * 두드렸으나 문이 안 열린 자리는 기록이 남지 않으므로 대가도 없다.
   */
  if (inPost) {
    pushNarrative(state, `${teamNameIn(state, vacancy.teamId)} 감독직 지원 — 재직 중`, 5);
  }
  return {
    ok: true,
    tone: "good",
    message:
      `${josa(teamNameIn(state, vacancy.teamId), "이/가")} 면접 자리를 열었습니다 —` +
      ` ${josa(`${owner.name}(${APPROACH_CHANNEL_LABEL.owner})`, "이/가")} 마주 앉습니다 (${line}).` +
      ` 감독의 답이 제안 조건을 정하고, ${APPROACH_PATIENCE_DAYS}일 안에 답하지 않으면 자리는 닫힙니다` +
      (inPost ? `. 재직 중에 두드린 자리라 보드가 알게 됐습니다 — 기자도 곧 묻습니다` : ""),
    brief: {
      head: "감독직 면접",
      items: [
        item({ label: teamNameIn(state, vacancy.teamId), text: owner.name, note: line }),
        ...approach.facts.map((f) =>
          item({ label: INTERVIEW_FACT_KO[f.kind] ?? "보드", text: pressFactText(f) }),
        ),
      ],
    },
  };
}

/**
 * AI 구단의 경질·선임 + **무직 감독에게 오는 제안** — tick이 매일 부른다.
 *
 * 새 감독은 **전술 역량치를 새로 뽑고**(직전보다 조금 높게 나오는 쪽으로 기울인다 —
 * 구단은 더 나은 사람을 데려오려 한다) 선수단에 짧은 반등을 남긴다. 그렇게 빈
 * 자리가 무직 감독의 눈높이에 맞으면 그날 제안이 붙는다 (career.md §5.1).
 *
 * @returns 오늘 새 제안이 붙었으면 true — tick이 거기서 멈춰 세운다
 */
export function runManagerMarket(state: GameState, digest: TickSink): boolean {
  const rng = makeRng(state.seed, `manager-market:${state.date}`);
  let sacked = 0;
  let offered = false;
  const ourLeague = leagueOfTeamIn(state, state.userTeamId);
  const tableOf = standingsCache(state);

  expireStaleOffers(state, digest);
  pruneVacancies(state);
  /**
   * **면접도 사흘이면 닫힌다** (career.md §5.1). 무직인 동안에는 `tickApproaches`가
   * 돌지 않으므로 다가옴의 만료가 이 자리를 대신 본다 — 안 그러면 감독이 답하지 않은
   * 자리가 세이브에 영영 남아 다음 노크를 막는다.
   */
  const closed = expireInterview(state, digest);

  for (const team of state.teams) {
    if (sacked >= SACKINGS_PER_DAY) break;
    if (team.id === state.userTeamId) continue;
    if (daysInCharge(state, team) < GRACE_DAYS) continue;
    const standing = seatStatus(state, team.id, tableOf);
    if (!standing || standing.played < MIN_MATCHES) continue;
    if (standing.position < managerSeatThresholds(state, team.id).sack) continue;
    /**
     * 같은 처지라고 다 잘리지는 않는다 — 구단마다 인내가 다르고, 그래야 리그가
     * 한 라운드에 우르르 감독을 바꾸지 않는다.
     */
    if (rng() > SACK_CHANCE) continue;

    /**
     * 라이벌의 경질은 **다음 회견이 싣는다** (people.md §4). 후임이 앉으면 그 구단의
     * 자리가 달라지므로, 그날의 순위는 그날 적어 둔다 — `installNewManager` 앞이다.
     */
    if (derbyOf(state.userTeamId, team.id)) {
      state.pressSackings = [
        ...state.pressSackings,
        { teamId: team.id, date: state.date, position: standing.position },
      ];
    }
    /** 재임 일수는 후임이 앉는 순간 사라진다 — 그날의 사실은 그날 읽어 둔다 */
    const wasSince = team.managerSince;
    const hired = installNewManager(state, team, rng);
    sacked += 1;

    /**
     * 공석 명부 — 감독이 먼저 두드릴 수 있는 문이다 (career.md §5.1). **재직 중에도
     * 쌓인다**: 계약을 남기고 떠나는 길이 열려 있으므로 재직 중의 공석도 감독의
     * 것이다. 14일이 지나면 `pruneVacancies`가 내린다.
     */
    state.managerVacancies = [
      ...state.managerVacancies,
      { teamId: team.id, on: state.date, position: standing.position },
    ];

    // 우리 리그의 일만 브리핑한다 — 5대 리그 전체를 올리면 소음이다
    if (leagueOfTeamIn(state, team.id) === ourLeague) {
      digest.push(
        `${josa(teamShortName(team.id), "이/가")} 감독을 경질했다 — 후임은 ${team.managerName}` +
          // 풀에서 온 사람이면 어디서 왔는지가 곧 그 선임의 뜻이다 (transfer.md §7)
          (hired === null ? "" : ` (전 ${teamShortNameIn(state, hired.lastTeamId)} 감독)`),
      );
      pushNarrative(state, `${teamName(team.id)} 감독 경질`, 3);
      /**
       * **다이제스트 한 줄 옆에 기사 두 장이 선다** (people.md §4-1). 줄은 그 턴에
       * 흘러가고 마는 사실이지만, 기사는 화자를 지목해 GM이 그 사람의 말을 쓸 수 있게
       * 한다 — 부임한 감독이 무슨 말을 했는지가 라이벌 이야기의 시작이다.
       */
      reportSacking(state, {
        teamId: team.id,
        kind: "sacked",
        position: standing.position,
        target: boardExpectation(state, team.id).target,
        ...(wasSince === undefined ? {} : { since: wasSince }),
      });
      if (team.managerName !== undefined) {
        reportAppointment(state, {
          teamId: team.id,
          managerName: team.managerName,
          fromPool: hired !== null,
          position: standing.position,
        });
      }
    }

    // 그 자리가 무직 감독의 것이 될 수도 있다
    if (!offered) offered = offerVacancy(state, team.id, standing.position, digest);
  }
  /**
   * **마주 앉은 사람 앞에서는 시계가 선다** (people.md §8 · career.md §5.1) — 자리가
   * 사흘이면 사라지므로, 시간이 그 위를 지나가면 감독은 답할 기회 없이 문만 잃는다.
   * 닫힌 날도 하루 세운다: 그 사실을 감독이 모르는 채 지나가면 안 된다.
   */
  return offered || closed || pendingInterview(state) !== null;
}

/**
 * **감독이 그 구단의 사람이 아니게 되는 하루** — 경질과 계약 만료가 함께 쓴다
 * (career.md §5.1 · §5.4).
 *
 * 갈리는 것은 카드의 `kind`와 위약금뿐이다. 무직은 **상태지 사유가 아니라서**,
 * 그 뒤로 도는 길(제안·노크·공석 명부·무직의 tick)은 어느 쪽이든 같아야 한다.
 *
 * @param channel 후임 감독을 뽑는 rng 채널 — 경질과 만료가 같은 날 같은 사람을
 *                세우지 않게 갈라 둔다
 */
function leaveClub(state: GameState, card: Dismissal, channel: string): void {
  const teamId = card.teamId;
  const contract = state.manager.contract;
  /**
   * **위약금은 구단이 무는 구단의 지출이다** (career.md §5.4) — 계약을 지우기 전에
   * 잰다. 만료는 끝까지 간 계약이라 잔여가 0이다.
   *
   * ⚠️ **사임과 이적은 여기 오지 않는다** — 사임은 감독이 지갑에서 무는 돈이고
   * (`resignPost`), 이적은 새 구단이 옛 구단에 무는 돈이라(`leaveForMove`) 둘 다
   * 방향이 반대다. 구단이 감독에게 무는 것은 경질뿐이고, 그 둘은 카드를 세우기
   * **전에** 각자의 두 장부를 적는다.
   */
  if (contract && card.kind !== "resigned" && card.kind !== "moved") {
    const severance = managerSeveranceOf(contract, state.date);
    if (severance > 0) {
      payManagerSeverance(state, teamId, severance);
      card.severance = severance;
    }
  }
  state.dismissal = card;
  delete state.manager.contract;

  // 감독이 없는 구단은 세계에 없다 — 옛 구단은 그날로 후임을 세운다
  const team = state.teams.find((t) => t.id === teamId);
  /**
   * **감독 자신의 이별도 기사가 된다** (people.md §4-1) — 원인 코드는 카드의 `kind`
   * 그대로다. 재임 일수는 후임이 앉기 전에 읽는다.
   */
  reportSacking(state, {
    teamId,
    kind: card.kind,
    ...(card.position === undefined ? {} : { position: card.position }),
    target: card.target,
    ...(team?.managerSince === undefined ? {} : { since: team.managerSince }),
  });
  if (team) {
    const hired = installNewManager(state, team, makeRng(state.seed, `${channel}:${state.date}`));
    if (team.managerName !== undefined) {
      reportAppointment(state, {
        teamId,
        managerName: team.managerName,
        fromPool: hired !== null,
        ...(card.position === undefined ? {} : { position: card.position }),
      });
    }
  }

  /**
   * **진행 중이던 협상은 전부 사라진다** — 감독이 없는 구단의 흥정이고, 무직인
   * 감독이 남의 구단 선수를 계속 흥정할 수는 없다 (career.md §5.1).
   */
  for (const negotiation of state.negotiations) {
    if (negotiation.status === "open" || negotiation.status === "agreed") {
      negotiation.status = "expired";
    }
  }
  // 답을 기다리던 재계약 제안도 닫힌다 — 다시 계약할 구단이 없어졌다 (career.md §5.4)
  for (const offer of state.managerOffers) {
    if (offer.status === "open") offer.status = "expired";
  }
  /**
   * **감독실 앞에 서 있던 사람도 돌아간다** (people.md §8 · career.md §5.1) — 감독이
   * 무시한 것이 아니라 물을 구단이 없어진 것이라 대가가 없다. 그대로 두면 무직인
   * 감독의 문 앞에 앞 구단 선수가 사흘째 서 있고, 그 자리가 면접이 설 문을 막는다.
   */
  expirePendingApproach(state);
}

/**
 * `resign` — **감독이 계약을 물고 스스로 떠난다** (career.md §5.4 · finance.md §9.7).
 *
 * 경질의 거울상이다: 금액은 같은 식(`managerSeveranceOf`)이고, 나가는 곳만 반대라
 * 지갑에서 빠져 옛 구단의 원장에 수입으로 선다. 그다음은 경질·만료와 **한 길**이다 —
 * `leaveClub`이 후임을 세우고 협상을 닫고 무직의 길을 연다.
 *
 * **지갑이 모자라면 못 나간다** — 물지 못하는 계약은 깨지지 않는다.
 */
export function resignPost(state: GameState): CommandResult {
  const teamId = managedTeamId(state);
  if (teamId === null) return { ok: false, message: "이미 무직입니다" };

  const contract = state.manager.contract;
  const buyout = contract ? managerSeveranceOf(contract, state.date) : 0;
  if (buyout > 0) {
    const spend = spendFromWallet(state, { kind: "buyout", amount: buyout, ref: teamId });
    if (!spend.ok) {
      return {
        ok: false,
        message: `${josa(teamNameIn(state, teamId), "과/와")}의 계약을 물려면 ${josa(formatMoney(buyout), "이/가")} 필요합니다 — 지갑엔 ${formatMoney(walletOf(state))}뿐입니다`,
      };
    }
    recordFinance(state, teamId, {
      kind: "income",
      category: "manager_buyout",
      label: "감독 사임 위약금",
      amount: buyout,
    });
  }

  const expectation = boardExpectation(state, teamId);
  const standing = seatStatus(state, teamId);
  leaveClub(
    state,
    {
      on: state.date,
      season: state.season,
      kind: "resigned",
      teamId,
      tier: tierOfTeamIn(state, teamId),
      ...(standing ? { position: standing.position } : {}),
      target: expectation.target,
      expectationCode: expectation.code,
      ...(buyout > 0 ? { severance: buyout } : {}),
    },
    "user-resigned",
  );

  const line = `사임 — ${josa(teamNameIn(state, teamId), "을/를")} 떠났다${buyout > 0 ? ` · 위약금 ${formatMoney(buyout)}` : ""}`;
  pushNarrative(state, line, 5);
  return {
    ok: true,
    message: `${line}. 지갑 ${formatMoney(walletOf(state))} — 이제 무직입니다`,
    brief: {
      head: "사임",
      items: [
        item({ label: "구단", text: teamShortNameIn(state, teamId) }),
        ...(buyout > 0 ? [item({ label: "위약금", text: formatMoney(buyout) })] : []),
        item({ label: "지갑", text: formatMoney(walletOf(state)) }),
      ],
    },
  };
}

/**
 * **감독 계약의 하루** — 만료 판정과 재계약 통보 (career.md §5.4). tick이 매일 부른다.
 *
 * 만료는 `오늘 > 만료일` 하나로 잰다. ⚠️ **"만료일 당일"로 재면 영영 오지 않는다** —
 * 리그 최종전과 07-01 사이를 시즌 전환이 통째로 건너뛰므로 계약이 끝나는 06-30은
 * tick이 밟는 날이 아니다(선수 계약의 만료 예고가 이미 밟은 함정이다 —
 * `dueExpiryStage`). 날짜는 단조 증가하므로 건너뛴 날은 다음 tick에 걸리고, 판정이
 * 계약을 지우므로 두 번 걸리지 않는다.
 *
 * @returns 오늘 감독이 알아야 할 일 — 자리를 잃었으면 `"expired"`, 보드의 통보가
 *          섰으면 `"notice"`. tick이 거기서 시계를 세운다.
 */
export function reviewManagerContract(
  state: GameState,
  digest: TickSink,
): "expired" | "notice" | null {
  // 무직에겐 계약이 없다 — 경질이 이미 지웠다
  if (state.dismissal) return null;
  const contract = state.manager.contract;
  if (!contract) return null;

  if (state.date > contract.until) {
    const teamId = state.userTeamId;
    const expectation = boardExpectation(state, teamId);
    // 순위는 있으면 싣는다 — 만료는 성적이 부른 일이 아니지만 그날의 자리는 사실이다
    const standing = seatStatus(state, teamId);
    leaveClub(
      state,
      {
        on: state.date,
        season: state.season,
        kind: "expired",
        teamId,
        tier: tierOfTeamIn(state, teamId),
        ...(standing ? { position: standing.position } : {}),
        target: expectation.target,
        expectationCode: expectation.code,
      },
      "contract-expired",
    );
    digest.push(
      `계약 만료 — ${josa(teamNameIn(state, teamId), "과/와")}의 계약이 ${josa(contract.until, "으로/로")} 끝났다`,
    );
    pushNarrative(state, `${teamNameIn(state, teamId)} 계약 만료`, 5);
    return "expired";
  }

  return null;
}

/** GM의 현재 보드 평가가 재계약 여부를 정한다. 만료와 제안 조건은 코어가 지킨다. */
export function decideManagerRenewal(state: GameState, offer: boolean, digest: TickSink): boolean {
  const contract = state.manager.contract;
  if (
    !contract ||
    contract.renewalDecidedOn ||
    diffDays(state.date, contract.until) > RENEWAL_NOTICE_DAYS ||
    state.date > contract.until
  )
    return false;
  contract.renewalDecidedOn = state.date;
  contract.renewalOffered = offer;
  if (offer) standRenewalOffer(state, contract, digest);
  else {
    digest.push(`보드가 재계약하지 않기로 했다 — 계약은 ${contract.until}에 끝난다`);
    pushNarrative(state, `재계약 불가 통보 — ${contract.until} 만료`, 5);
  }
  return true;
}

/** 승인된 경질을 계약 해지·위약금·구직 상태로 정산한다. 경고 검증은 reviewBoard가 소유한다. */
export function dismissUserManager(state: GameState, digest: TickSink): boolean {
  if (state.dismissal || !state.manager.contract) return false;
  const standing = seatStatus(state, state.userTeamId);
  const expectation = boardExpectation(state, state.userTeamId);
  const sackedTeamId = state.userTeamId;
  leaveClub(
    state,
    {
      on: state.date,
      season: state.season,
      kind: "sacked",
      teamId: sackedTeamId,
      tier: tierOfTeamIn(state, sackedTeamId),
      ...(standing ? { position: standing.position } : {}),
      target: expectation.target,
      expectationCode: expectation.code,
    },
    "user-sacked",
  );

  digest.push(`경질 — ${josa(teamNameIn(state, sackedTeamId), "이/가")} 감독 계약을 해지했다`);
  pushNarrative(state, `${teamNameIn(state, sackedTeamId)} 경질`, 5);
  return true;
}

/**
 * **재직 중인 감독을 데려간다** — 새 구단이 옛 구단에 보상금을 물고, 감독은 그날로
 * 자리를 옮긴다 (career.md §5.1 「재직 중 접근·노크」).
 *
 * 그다음은 경질·만료·사임과 **한 길**이다(`leaveClub`) — 옛 구단은 후임을 세우고
 * 진행 중이던 협상은 사라진다. 여기서 갈리는 것은 돈의 방향과 카드의 갈래뿐이라,
 * 이 함수가 세운 `moved` 카드를 부임의 일곱 단계가 그대로 받는다.
 *
 * @returns 이력으로 갈 `moved` 카드 — 보상금은 그 `severance`에 적혀 있다
 */
function leaveForMove(state: GameState, offer: ManagerOffer): Dismissal {
  const fromTeamId = state.userTeamId;
  /**
   * 금액은 **제안이 들고 온 값**이다 — 부를 때 잰 것이 그 구단이 물기로 한 값이라
   * 열흘 뒤 수락한다고 달라지지 않는다. 보상금이 없는 제안은 0이다.
   */
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
  const expectation = boardExpectation(state, fromTeamId);
  const standing = seatStatus(state, fromTeamId);
  const card: Dismissal = {
    on: state.date,
    season: state.season,
    kind: "moved",
    teamId: fromTeamId,
    tier: tierOfTeamIn(state, fromTeamId),
    ...(standing ? { position: standing.position } : {}),
    target: expectation.target,
    expectationCode: expectation.code,
    ...(compensation > 0 ? { severance: compensation } : {}),
  };
  leaveClub(state, card, "manager-moved");
  return card;
}

/**
 * **제안을 받아들인다 — 그날부로 부임한다** (career.md §5.1).
 *
 * 시즌 중이어도 막지 않는다. 순위표는 감독이 아니라 구단 단위라 부임 전 경기까지
 * 포함한 성적이 그 시즌의 기록이 된다 — 그것이 감독이 물려받는 것이다.
 *
 * @param ref 제안 id 또는 구단 이름·약칭
 */
export function acceptManagerOffer(state: GameState, ref: string): CommandResult {
  const offer =
    state.managerOffers.find((o) => o.id === ref) ??
    state.managerOffers.find(
      (o) => o.status === "open" && o.expiresOn >= state.date && offerMatches(state, o, ref),
    ) ??
    state.managerOffers.find((o) => offerMatches(state, o, ref));
  /**
   * **재계약은 부임이 아니다** (career.md §5.4) — 구단도 자리도 그대로라 아래의
   * 전이는 하나도 일어나지 않는다.
   *
   * 재직 중에 답할 수 있는 나머지는 **이직 제안**이다 (career.md §5.1) — 다른 구단이
   * 손을 뻗었거나(`poach`) 감독이 재직 중에 두드려 얻은 자리(`knock`)이고, 어느
   * 쪽이든 새 구단이 보상금을 물고 데려가는 한 길이다.
   */
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

  /**
   * ⚠️ **자리를 떠나기 전에 이 제안부터 닫는다** — `leaveClub`이 열린 제안을 전부
   * 만료시키므로, 순서가 뒤집히면 방금 수락한 자리가 사라진다.
   */
  offer.status = "accepted";
  const fromTeamId = state.userTeamId;
  /**
   * **이 부임이 이력에 남길 카드** — 무직이면 서 있던 경질장이고, 재직 중이면
   * 여기서 자리를 떠나며 선 이적장이다 (career.md §5.1). 보상금·후임·협상 정리는
   * `leaveForMove`가 그 자리에서 끝낸다.
   */
  const leaving = state.dismissal ?? leaveForMove(state, offer);
  const compensation = leaving.kind === "moved" ? (leaving.severance ?? 0) : 0;
  const team = state.teams.find((t) => t.id === offer.teamId);
  // 경질 뒤에도 `userTeamId`는 옛 구단이다 (§5.1) — 떠나기 전에 리그를 읽어 둔다
  const fromLeague = leagueOfTeamIn(state, state.userTeamId);
  state.userTeamId = offer.teamId;
  if (team) {
    /**
     * **그 벤치에 서 있던 사람도 자리를 잃는다** (transfer.md §7 「감독 풀」) —
     * 경질과 다르지 않다. 이름을 덮기 전에 풀에 앉혀야 그가 세계에 남는다.
     */
    poolSacked(state, team);
    team.managerName = state.manager.name;
    team.managerSince = state.date;
    // 전임의 이력은 그를 따라 풀로 갔다 — 감독의 커리어는 `dismissals`가 든다
    team.managerSpells = [];
  }
  /**
   * **감독 계약이 선다** — 제안의 조건으로 (career.md §5.1). 이적 예산 약속은 그
   * 자리에서 새 구단의 예산에 더해진다 — 약속은 부임과 함께 이행되는 사실이다.
   */
  const contract = {
    salary: offer.salary,
    signedOn: state.date,
    until: contractUntil(state.date, offer.years),
  };
  state.manager.contract = contract;
  const pledge = offer.budgetPledge;
  if (pledge > 0) financeOf(state, offer.teamId).transferBudget += pledge;
  /**
   * **새 구단이 문 보상금** (career.md §5.1 · finance.md §9.7) — `userTeamId`가 이미
   * 새 구단이라 이 줄은 새 구단 원장에 선다. 갈래가 `severance`인 것은 경질 위약금과
   * 같은 성질이기 때문이다: 감독 계약이 부르는 일회성 지출이라 급여 비중을 흔들지
   * 않는다. 이적 예산 약속과 다른 지갑이라 부임 첫날의 예산은 그대로다.
   */
  if (compensation > 0) {
    recordFinance(state, offer.teamId, {
      kind: "expense",
      category: "severance",
      label: `감독 이적 보상금 — ${teamShortNameIn(state, fromTeamId)}`,
      amount: compensation,
    });
  }
  // 부임한 감독에게 공석은 더 이상 문이 아니다
  state.managerVacancies = [];
  /**
   * 경질장은 지워지지 않고 **이력으로 옮겨진다** (career.md §6) — 잘린 시즌은
   * `SEASON_RECORD`가 없으므로, 이 줄이 없으면 그 해가 커리어 표에서 통째로 빈다.
   */
  state.dismissals = [...state.dismissals, leaving];
  delete state.dismissal;
  // 답할 자리는 하나였으니 남은 것은 이제 답할 필요가 없다
  for (const other of state.managerOffers) {
    if (other.status === "open") other.status = "expired";
  }
  // 앞 구단의 경고를 지고 가지 않는다
  /**
   * 다가옴의 압력도 마찬가지다 (people.md §8) — 앞 구단 선수의 불만이 쌓아 둔 눈금을
   * 지고 오면, 새 구단 첫 주에 이미 사다리 중턱에서 시작한다.
   */
  state.approaches = [];
  // 보드 요청도 앞 구단주의 것이다 (career.md §5.2) — 새 구단주의 조건은 새 창이 건다
  // 감독이 앞 구단 보드에 건 요청도 같다 (career.md §5.3) — 답할 보드가 없어졌다
  state.boardRequests = [];
  /**
   * 앞 구단 보드가 내준 건별 영입 승인분도 지운다 (finance.md §9.6) — 그 허가는 그
   * 감독의 그 자리에 대한 것이라, 남겨 두면 60일 안에 돌아온 감독이 남의 임기에
   * 받은 승인으로 선수를 산다.
   */
  for (const finance of state.finances) finance.earmarked = [];
  // 라커룸 불만도 앞 구단의 것이다 (people.md §5) — 지고 오면 주의 줄이 옛 이름을 나열한다
  state.issues = [];
  // 앞 구단 선수에게 한 약속도 같다 (people.md §5-2) — 지킬 수 없는 약속이 기한마다 판정된다
  state.promises = [];
  /**
   * 답을 기다리던 회견도 앞 구단의 자리다 (people.md §4) — 그대로 두면 새 구단의
   * 첫 회견이 그것을 방치로 읽어 이유 없이 언론 평판을 깎는다. 감독이 무시한 것이
   * 아니라 물을 구단이 없어진 것이므로 대가 없이 만료다.
   */
  expirePendingPress(state);
  // 기본 훈련은 새 선수단으로 다시 깔린다
  syncDefaultTraining(state);
  // 수석코치·구단주는 구단의 사람이라 새 구단 기준으로 다시 서고,
  // 기자단은 리그를 따라다니므로 리그를 건널 때만 갈린다 (career.md §5.1)
  reseatClubPersonas(state, offer.teamId, {
    crossedLeague: fromLeague !== leagueOfTeamIn(state, offer.teamId),
  });
  /**
   * 앞 구단의 다년 계획은 지고 가지 않고, 새 구단의 계획이 **부임하는 그 자리에서**
   * 선다 (career.md §5.1). 다음 전환까지 미루면 그 시즌 내내 화면과 GM이 순수
   * 폴백을 읽는데, 그 `since`는 읽는 시점의 시즌이라 계획이 한 번 다시 시작한 것처럼
   * 보인다 — 「1년차」가 두 시즌 연속 뜬다.
   *
   * ⚠️ **`reseatClubPersonas` 뒤여야 한다.** `standClubVision`은 `ownerOf(state)`로
   * 원형 표를 고르는데, 그 앞에서는 구단주 페르소나가 아직 **앞 구단 사람**이다.
   */
  state.boardAgenda = {
    teamId: state.userTeamId,
    expectations: [],
    assessment: "",
    reviewedOn: null,
  };
  /**
   * **부임 회견이 열린다** (career.md §5.1 · people.md §4). 앞 구단의 회견은 위에서
   * 이미 `expired`로 닫혔으므로 이 자리가 그것을 거절로 읽지 않는다 — 순서가
   * 뒤집히면 이직 하나로 언론 평판이 깎인다.
   *
   * ⚠️ **구단에 묶인 것이 다 선 뒤여야 한다** — `reporterFor`가 `reportersOf(state)`를
   * 읽는데, 리그를 건너는 이직이면 그 앞에서는 아직 앞 리그의 기자단이다.
   * 전임의 사실은 제안이 들고 온 것이다: 그 벤치가 비어 있었던 이유가 그것이다.
   */
  openAppointmentPress(state, {
    ...(offer.position === undefined ? {} : { position: offer.position }),
    target: offer.target,
    expectationCode: offer.expectationCode,
  });

  const name = teamNameIn(state, offer.teamId);
  pushNarrative(state, compensation > 0 ? `${name} 이적 부임` : `${name} 부임`, 5);
  return {
    ok: true,
    message:
      `${name} 감독으로 부임했습니다 (${state.date}) — 보드의 기대는 ${offerExpectation(offer)},` +
      ` 지금 순위는 ${offer.position ?? "-"}위입니다.` +
      ` 계약은 연봉 ${formatMoney(contract.salary)}에 ${contract.until}까지` +
      (pledge > 0
        ? `, 이적 예산 ${josa(formatMoney(pledge), "이/가")} 약속대로 더해졌습니다`
        : `입니다`) +
      (compensation > 0
        ? `. 보상금 ${josa(formatMoney(compensation), "은/는")} ${teamNameIn(state, fromTeamId)}의 장부로 갔습니다 — 감독의 지갑은 그대로입니다`
        : ""),
    tone: "good",
    brief: {
      head: compensation > 0 ? "이적 부임" : "부임",
      items: [
        item({ label: "구단", text: name, note: `기대 ${offerExpectation(offer)}` }),
        item({ label: "연봉", text: formatMoney(contract.salary), note: `${contract.until}까지` }),
        ...(pledge > 0
          ? [item({ label: "이적 예산", text: formatMoney(pledge), delta: pledge })]
          : []),
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
