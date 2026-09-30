import {
  type Dismissal,
  type TickSink,
  formatMoney,
  josa,
  MANAGER_TERMS_BY_TIER,
  RENEWAL_NOTICE_DAYS,
} from "@story-fm/domain";
import { tierOfTeamIn } from "../../common/core/club-tier";
import { contractUntil, diffDays } from "../../common/core/dates";
import { leagueOfTeamIn } from "../../common/core/league-membership";
import {
  type GameState,
  expirePendingApproach,
  pushNarrative,
  teamNameIn,
} from "../../common/core/state";
import { topLeagues } from "../../common/data/league-catalog";
import { boardExpectation } from "../../common/views/board-expectation";
import { computeStandings } from "../../common/views/standings";
import { expirePendingPress } from "./press";

/**
 * **감독 계약과 커리어의 끝** (career.md §5.4).
 *
 * 감독은 처음 고른 구단에서만 일한다. 보드가 경질하거나 계약이 끝나면 그날로 커리어가
 * 끝나고(`state.dismissal`), 게임은 더 이상 턴을 받지 않는다.
 */

/** 그 팀이 리그에서 몇 위인가 (1부만 — 2부는 리그전이 없다) */
function positionOf(state: GameState, teamId: string): number | null {
  const leagueId = leagueOfTeamIn(state, teamId);
  if (!topLeagues().some((l) => l.id === leagueId)) return null;
  const index = computeStandings(state, leagueId).findIndex((r) => r.teamId === teamId);
  return index < 0 ? null : index + 1;
}

/** 커리어를 끝낸다 — 경질과 만료가 같은 길을 지난다. 카드에는 그날의 사실만 적힌다 */
function endCareer(state: GameState, kind: Dismissal["kind"]): void {
  const teamId = state.userTeamId;
  const expectation = boardExpectation(state, teamId);
  const position = positionOf(state, teamId);
  state.dismissal = {
    on: state.date,
    season: state.season,
    kind,
    teamId,
    tier: tierOfTeamIn(state, teamId),
    ...(position === null ? {} : { position }),
    target: expectation.target,
    expectationCode: expectation.code,
  };
  delete state.manager.contract;
  // 감독실 앞에 서 있던 사람도, 열려 있던 회견도 물을 감독이 없어졌다 — 대가가 없다
  expirePendingApproach(state);
  expirePendingPress(state);
}

/**
 * **감독 계약의 하루** — 만료 판정 (career.md §5.4). tick이 매일 부른다.
 *
 * 만료는 `오늘 > 만료일` 하나로 잰다. ⚠️ **"만료일 당일"로 재면 영영 오지 않는다** —
 * 리그 최종전과 07-01 사이를 시즌 전환이 통째로 건너뛰므로 계약이 끝나는 06-30은
 * tick이 밟는 날이 아니다. 날짜는 단조 증가하므로 건너뛴 날은 다음 tick에 걸리고,
 * 판정이 계약을 지우므로 두 번 걸리지 않는다.
 *
 * @returns 오늘 커리어가 끝났으면 `"expired"` — tick이 거기서 시계를 세운다
 */
export function reviewManagerContract(state: GameState, digest: TickSink): "expired" | null {
  if (state.dismissal) return null;
  const contract = state.manager.contract;
  if (!contract || state.date <= contract.until) return null;
  const teamId = state.userTeamId;
  endCareer(state, "expired");
  digest.push(
    `계약 만료 — ${josa(teamNameIn(state, teamId), "과/와")}의 계약이 ${josa(contract.until, "으로/로")} 끝났다. 커리어가 끝났다`,
  );
  pushNarrative(state, `${teamNameIn(state, teamId)} 계약 만료 — 커리어 종료`, 5);
  return "expired";
}

/**
 * **보드의 재계약 판정** — GM의 보드 평가가 정하고, 코어가 그 자리에서 계약을 다시 세운다.
 *
 * 조건은 지금 등급의 기본 표이되 현 연봉이 그보다 높으면 현 연봉을 유지한다 — 구단이
 * 스스로 깎아 부르지는 않는다. 흥정도 수락도 없다. 비갱신이면 그 사실만 남고 계약은
 * 만료일에 끝난다.
 */
export function decideManagerRenewal(state: GameState, renew: boolean, digest: TickSink): boolean {
  const contract = state.manager.contract;
  if (
    !contract ||
    contract.renewalDecidedOn ||
    diffDays(state.date, contract.until) > RENEWAL_NOTICE_DAYS ||
    state.date > contract.until
  )
    return false;
  const name = teamNameIn(state, state.userTeamId);
  if (!renew) {
    contract.renewalDecidedOn = state.date;
    contract.renewalOffered = false;
    digest.push(
      `보드가 재계약하지 않기로 했다 — 계약은 ${contract.until}에 끝나고 커리어도 끝난다`,
    );
    pushNarrative(state, `재계약 불가 통보 — ${contract.until} 만료`, 5);
    return true;
  }
  const terms = MANAGER_TERMS_BY_TIER[tierOfTeamIn(state, state.userTeamId)];
  const salary = Math.max(contract.salary, terms.salary);
  // 새 임기의 계약이라 재계약 판정 자국은 지고 가지 않는다 — 다음 만료 90일 전에 다시 선다
  state.manager.contract = {
    salary,
    signedOn: state.date,
    until: contractUntil(state.date, terms.years),
  };
  digest.push(
    `보드가 재계약했다 — 연봉 ${formatMoney(salary)} · ${state.manager.contract.until}까지`,
  );
  pushNarrative(state, `${name} 재계약`, 5);
  return true;
}

/** 승인된 경질을 커리어의 끝으로 정산한다. 경고 검증은 `reviewBoard`가 소유한다 */
export function dismissUserManager(state: GameState, digest: TickSink): boolean {
  if (state.dismissal || !state.manager.contract) return false;
  const teamId = state.userTeamId;
  endCareer(state, "sacked");
  digest.push(
    `경질 — ${josa(teamNameIn(state, teamId), "이/가")} 감독 계약을 해지했다. 커리어가 끝났다`,
  );
  pushNarrative(state, `${teamNameIn(state, teamId)} 경질 — 커리어 종료`, 5);
  return true;
}
