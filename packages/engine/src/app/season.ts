import {
  shelveFamiliarity,
  unshelveFamiliarity,
  settleRoleCost,
} from "../players/familiarity-memory";
import {
  type GameState,
  playersOf,
  teamName,
  managedTeamId,
  groupOf,
  tacticsOf,
  FAMILIARITY_BASELINE,
  inTransaction,
} from "../core/state";
import { hasPendingDraw } from "../season/draw-schedule";
import {
  leagueOfTeamIn,
  teamsOfLeagueIn,
  tierOfTeamIn,
  predictedPlaceOf,
} from "../core/league-membership";
import { hasCups, scopedLeagues } from "../core/catalog/scope";
import { domesticCupCatalog } from "../core/catalog/domestic-cup-catalog";
import { isEuroCup, cupCatalog, competitionShortName } from "../core/catalog/cup-catalog";
import {
  cupRunsThisSeason,
  domesticChampion,
  reviewDomesticCups,
  domesticCupWinners,
  payDomesticCupPrizes,
} from "../season/domestic-cup";
import { euroChampion, euroStageMatches } from "../season/euro-knockout";
import { computeStandings } from "../season/standings";
import {
  type GamePlayer,
  naturalPositionOf,
  type YouthCandidate,
  CONDITION_BASE,
  FATIGUE_BASE,
  anchorOf,
  openSeats,
  presetOf,
  DEFAULT_FORMATION,
  positionAtPoint,
} from "@gaffer/domain";
import { leagueName, isCupOnlyLeague } from "../core/catalog/league-catalog";
import { buildSeasonCalendar, squadReturnOf } from "../core/calendar";
import {
  recordBreaksOf,
  recordSeasonHistory,
  recordChampions,
  championsOf,
} from "../season/records";
import { payLeaguePrizes, paySeasonBonuses, closeSeasonBooks } from "../team/finance";
import { derbyMatchesOf, derbyRecordFrom } from "../core/derby";
import { buildScheduleEntries } from "../season/calendar";
import { seasonYear } from "../core/dates";
import { expireContracts } from "../team/free-agency";
import { leagueOfTeam } from "../core/catalog/team-catalog";
import { generateYouthPlayer } from "../players/generate";
import { estimateWeeklyWage, wageSubjectOf } from "../team/wages";
import { buildAssignments } from "../match/selection";
import { successorCaptainOf } from "../players/hierarchy";
import { type LeagueTables, buildEuroEntrants } from "../season/europe";
import { type SuperCupSource } from "../season/super-cup";
import { applyPromotionRelegation, reinforcePromotedSquads } from "./workflows/promotion";
import { recomputeClubTiers } from "../season/club-tier-recompute";
import { buildSeasonFixtures, isUserFixture } from "../season/fixtures";
import { applySummerTournament } from "../season/international";
import { installDefaultTraining } from "../players/training-plan";
import { expireStaffContracts, refreshStaffPool } from "../people/staff-employment";
import { retiresNow, retiredRowOf } from "../players/retirement";
import {
  YOUTH_INTAKE_SEED_OFFSET,
  academyUseOf,
  youthIntakeOf,
  forcedGroupsOf,
  admitYouth,
  promoteToMatchdaySquad,
  YOUTH_CONTRACT_YEARS,
} from "../players/youth";
import { payEuropeanWinnerPrizes } from "../season/euro-prize";
import { recordBreakLine, gradeAwards } from "../season/awards";
import { checkAchievements, achievementLine } from "../people/achievements";

/**
 * 시즌 종료 판정 — **유저 리그 + 모든 컵** 기준. 다른 *리그*는 며칠 차이로 끝날 수
 * 있으므로 전 리그를 기다리면 시즌 전환이 어중간하게 늦춰진다.
 *
 * 컵을 기다리는 이유: 결승은 리그 최종전 **다음 주말**이다. 리그만 보면 결승을
 * 치르지 않은 채 시즌이 넘어가 우승 팀이 없는 대회가 남는다.
 *
 * ⚠️ **국내 컵도 나라를 가리지 않는다.** 우리 나라 컵만 기다리면 쿠프 드
 * 프랑스·DFB-포칼 결승이 안 치러진 채 시즌이 넘어가 우승 팀도 상금도 없이
 * 사라진다. 그 나라 유럽 티켓 한 장이 순위만으로 나가고, 컵을 든 팀은 아무것도
 * 받지 못한다. 대항전을 전부 기다리는 것과 같은 이유다.
 *
 * ⚠️ **다만 그 시즌에 열린 컵만.** 기다릴 컵은 `advanceDomesticCups`가 돌리는 컵과
 * 같은 게이트(`cupRunsThisSeason`)로 골라야 한다 — 안 열린 컵은 결승이 없어 우승자가
 * 영영 나오지 않고, 날짜만 흐르며 시즌이 넘어가지 않는다.
 */
export function allMatchesDone(state: GameState): boolean {
  // 아직 안 열린 추첨이 있으면 그 라운드의 경기는 **아직 존재하지도 않는다**.
  // "남은 경기 없음"으로 읽고 시즌을 넘기면 결승 없는 대회가 생긴다.
  if (hasPendingDraw(state)) return false;

  const league = leagueOfTeamIn(state, state.userTeamId);
  // 컵이 없는 세계(축소 세계)는 기다릴 대회 자체가 없다.
  const cups = hasCups(state.world);
  const domesticCups = cups ? domesticCupCatalog() : [];
  const played = state.matches.every(
    (m) =>
      m.season !== state.season ||
      m.result !== null ||
      !(
        m.competitionId === league ||
        isEuroCup(m.competitionId) ||
        domesticCups.some((c) => c.id === m.competitionId)
      ),
  );
  if (!played) return false;

  // 컵은 **우승 팀이 나와야** 끝이다 — 경기가 다 끝났어도 다음 단계가 편성 전일 수 있다
  if (!cups) return true;
  for (const cup of domesticCups) {
    if (!cupRunsThisSeason(state, cup)) continue;
    if (!domesticChampion(state, cup.id)) return false;
  }
  for (const cup of cupCatalog()) if (!euroChampion(state, cup.id)) return false;
  return true;
}

/**
 * 대항전 결산 — 우승/준우승을 다이제스트와 서사에 반영한다. 상금도
 * 트로피도 여기 없다 (`payEuropeanWinnerPrizes` · `recordChampions`).
 *
 * 결승은 리그 최종전 다음 토요일이라 `allMatchesDone`이 그것까지 기다린다.
 * 시즌 리뷰가 우승을 확정하는 단일 지점이다 (매일 tick에서 중복 보고하지 않는다).
 */
function reviewEuropeanCampaign(state: GameState): string[] {
  const digest: string[] = [];
  for (const cup of cupCatalog()) {
    const champion = euroChampion(state, cup.id);
    if (!champion) continue;
    const finalMatch = euroStageMatches(state, cup.id, "final")[0];
    const ours =
      finalMatch !== undefined &&
      (finalMatch.homeTeamId === state.userTeamId || finalMatch.awayTeamId === state.userTeamId);
    if (champion === state.userTeamId) {
      digest.push(`${cup.name} 우승`);
    } else if (ours) {
      digest.push(`${competitionShortName(cup.id)} 준우승 — 결승 상대 ${teamName(champion)}`);
    } else {
      digest.push(`${competitionShortName(cup.id)} 우승: ${teamName(champion)}`);
    }
  }
  return digest;
}

/** 시즌 리뷰 — 보드 평가·트로피·업적을 감독 커리어에 적재 */
export function reviewSeason(state: GameState): string[] {
  const digest: string[] = [];
  /**
   * **우승과 시상은 리그가 주는 것이지 감독의 것이 아니다** — 커리어가 끝난 뒤 맞은 시즌에도
   * 선다(상금과 같은 결 — career.md §5.1). 그래서 아래 이른 return보다 앞이고,
   * 승강을 적용하기 전인 이 자리라야 옛 소속으로 매겨진다 (season.md §8).
   */
  recordChampions(state);
  digest.push(...gradeAwards(state));
  const standings = computeStandings(state);
  const position = standings.findIndex((r) => r.teamId === state.userTeamId) + 1;
  const row = standings[position - 1];
  if (!row) return digest;

  /**
   * **커리어가 끝난 뒤 맞은 시즌 끝은 커리어에 남지 않는다** (career.md §5.1).
   *
   * `SEASON_RECORD`·트로피·업적은 그 자리에 있던 감독의 것이라,
   * 잘린 뒤 옛 팀이 든 컵이 감독의 것이 되면 안 된다. **돈은 반대다** — 컵·대항전
   * 상금도 리그 상금·성과 보너스와 똑같이 구단이 받는 것이라 그대로 결산한다.
   * 시즌 키가 바뀌므로 여기서 건너뛰면 그 상금은 영영 장부에 앉지 않는다.
   */
  if (managedTeamId(state) === null) {
    payEuropeanWinnerPrizes(state, digest);
    payDomesticCupPrizes(state, digest);
    payLeaguePrizes(state, digest);
    paySeasonBonuses(state, position, digest);
    digest.push(
      `시즌 ${state.season} 종료 — 감독 자리 없이 맞았다. 이 시즌은 커리어에 남지 않는다`,
    );
    return digest;
  }

  /**
   * **더비 전적은 순위와 따로 남는다** (career.md §5.1). 한 경기라도 치렀으면 기록한다.
   */
  const derbies = derbyMatchesOf(state);
  if (derbies.length > 0) {
    const record = derbyRecordFrom(state, derbies);
    digest.push(
      `더비 전적: ${derbies.length}경기 ${record.won}승 ${record.drawn}무 ${record.lost}패`,
    );
  }

  // 트로피는 이미 원장에 있다 — 전 구단의 우승을 `recordChampions`가 먼저 적었다
  if (position === 1) {
    digest.push(`${leagueName(leagueOfTeamIn(state, state.userTeamId))} 우승`);
  }
  payEuropeanWinnerPrizes(state, digest);
  digest.push(...reviewEuropeanCampaign(state));
  payDomesticCupPrizes(state, digest);
  digest.push(...reviewDomesticCups(state));
  // 재정 — 리그 순위 상금(전 팀)과 선수단 성과 보너스
  payLeaguePrizes(state, digest);
  paySeasonBonuses(state, position, digest);
  checkAchievements(state, position, row);
  /**
   * **기록 경신은 지나간 시즌들과 견줘야 나온다** — 결산 스냅샷은 전환이 남기므로
   * (`recordSeasonHistory`) 이 시점의 `state.history`엔 이번 시즌이 아직 없다.
   * 그래서 이번 시즌의 성적만 인자로 건넨다.
   */
  for (const broken of recordBreaksOf(state, state.userTeamId, {
    season: state.season,
    leagueId: leagueOfTeamIn(state, state.userTeamId),
    points: row.points,
    goalsFor: row.goalsFor,
    position,
  })) {
    digest.push(recordBreakLine(broken));
  }

  state.seasonRecords.push({
    season: state.season,
    teamId: state.userTeamId,
    position,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
    goalsFor: row.goalsFor,
    goalsAgainst: row.goalsAgainst,
    tier: tierOfTeamIn(state, state.userTeamId),
    leagueId: leagueOfTeamIn(state, state.userTeamId),
  });

  digest.push(
    `시즌 ${state.season} 종료 — 최종 ${position}위 (${row.wins}승 ${row.draws}무 ${row.losses}패, 득실 ${row.goalDiff > 0 ? "+" : ""}${row.goalDiff})`,
  );
  const predicted = predictedPlaceOf(state, state.userTeamId);
  if (predicted !== null) {
    digest.push(`언론 예상 ${predicted}위 → 최종 ${position}위`);
  }
  for (const a of state.achievements.filter((x) => x.season === state.season)) {
    digest.push(`업적 달성: ${achievementLine(a)}`);
  }
  return digest;
}

export function applyTransition(state: GameState): string[] {
  const digest: string[] = [];
  const managed = managedTeamId(state);
  const nextSeason = state.season + 1;
  const nextCalendar = buildSeasonCalendar(nextSeason);

  /**
   * **끝난 계약은 지운다** — 계약은 시즌마다 2,000줄씩 쌓여 세이브와 모든 순회를
   * 무겁게 한다. 떠난 선수·은퇴 선수의 끝난 계약은 아무도 읽지 않는다.
   */
  state.contracts = state.contracts.filter((c) => c.status === "active");

  /**
   * 선수 색인 — **팀 루프 안에서 선형 탐색을 하지 않기 위해서다.**
   * 계약이 시즌마다 2,000줄씩 쌓이는데 팀마다 전체를 훑고 계약마다 선수를
   * 찾으면 시즌 하나가 2,700만 번 비교가 된다(15시즌 회귀 테스트가 잡았다).
   * 은퇴로 빠지고 유스로 들어오는 것만 그때그때 반영한다.
   */
  const playerIndex = new Map(state.players.map((p) => [p.id, p]));
  /**
   * 새 유스가 쓸 수 없는 id — **떠난 사람 것까지 포함한다.** 은퇴하면 명단에서
   * 빠지지만 원장에는 남으므로, 그 id를 신인에게 다시 주면 두 사람의 기록이
   * 한 사람 것으로 합쳐진다.
   */
  const takenIds = new Set<string>([
    ...state.players.map((p) => p.id),
    ...state.moves.map((m) => m.gamePlayerId),
  ]);
  /**
   * 새 유스가 쓸 수 없는 이름 — **세계 전체**다 (people.md §2). 팀 안에서만 피하면
   * 인테이크 293명 중 97명이 남의 팀 선수와 동명이인으로 서고, 감독이 그 이름을
   * 부르는 순간 명령은 후보 둘로 갈려 실행되지 않는다. id와 달리 **떠난 사람 것은
   * 포함하지 않는다** — 이름이 갈라야 하는 것은 지금 세계에 선 사람들이고, 은퇴한
   * 선수의 이름까지 영원히 묶어 두면 풀이 시즌마다 줄어든다.
   */
  const takenNames = new Set(state.players.map((p) => p.name));

  /**
   * 후보 줄은 **전환마다 새로 선다** — 지난 여름의 미결이 남아 있을 자리는 없다
   * (소집일이 이미 정리했다).
   */
  state.youthCandidates = [];

  /** 팀별 활성 계약 — 팀마다 전체 계약을 훑지 않는다 */
  const contractsByTeam = new Map<string, typeof state.contracts>();
  for (const c of state.contracts) {
    if (c.status !== "active") continue;
    const list = contractsByTeam.get(c.teamId);
    if (list) list.push(c);
    else contractsByTeam.set(c.teamId, [c]);
  }

  for (const team of state.teams) {
    /**
     * **무소속은 클럽이 아니다** — 은퇴만 태우고 유스 유입·배치는 건너뛴다. 안 그러면
     * "무소속 아카데미"가 매년 신인을 찍어낸다.
     */
    const isFreePool = leagueOfTeam(team.id) === "free";
    const tier = tierOfTeamIn(state, team.id);
    const retirees: string[] = [];
    let squad = playersOf(state, team.id);

    for (const player of squad) {
      /**
       * ⚠️ **노화 곡선은 여기서 굴리지 않는다.** 시즌 경계에 한 번 몰아서 적용하면
       * 5월 마지막 날과 7월 첫날 사이에 스물아홉 살 윙어의 스피드가 두세 칸 꺼져 있다 —
       * 감독이 겪은 것 없이 숫자만 달라진다. 이제 **매달 조금씩** 움직인다
       * (`development.ts`). 시즌 전환이 하는 건 은퇴 집행과 명단 정리뿐이다.
       *
       * **집행이지 판정이 아니다** — GM이 기록하고 철회하지 않은 선언만 집행한다.
       */
      if (retiresNow(state, player)) retirees.push(player.id);
      // 새 시즌 리셋
      player.state.form = 0;
      // 새 시즌 — 쉬고 돌아왔다
      player.state.condition = CONDITION_BASE;
      /**
       * **적응도는 여기서 손대지 않는다** — 여름의 하루하루가 이미 끌고 간다
       * (player.md §7.4). 훈련장을 떠난 날마다 55 쪽으로 내려가므로 6주의 휴가를
       * 보낸 선수는 프리시즌을 77 언저리에서 열고, 소집일부터의 훈련 판정이 그것을
       * 다시 채운다. 리셋 한 줄과 매일의 감쇠를 함께 두면 같은 사실을 두 번 물린다.
       */
      /**
       * **여름이 통을 비운다** (player.md §5.5) — 6주의 휴가는 잔고를 사실상 0까지
       * 빼므로 명시적으로 0에서 다시 시작한다. 시계도 함께 지운다: 6월에 과부하였던
       * 선수가 8월에 「12주째 과부하」로 서면 그건 지난 시즌의 사실이다.
       */
      player.state.fatigue = FATIGUE_BASE;
    }

    if (retirees.length > 0) {
      const retSet = new Set(retirees);
      if (team.id === managed) {
        const ours = squad.filter((p) => retSet.has(p.id));
        digest.push(`은퇴: ${ours.map((p) => p.name).join(", ")}`);
        /**
         * **명부로 옮긴다** (season.md §6). 명단에서 빠지면 id로는 이름도 나이도
         * 되찾지 못해 오프시즌 블록·인물 사전·시상 기록이 그 사람을 부를 수 없다.
         * 감독 팀에서 은퇴한 선수만 담는 것은 `milestones`와 같은 규약이다.
         */
        state.retired = [
          ...state.retired,
          ...ours.map((p) => retiredRowOf(state, p, team.id, nextCalendar.preseasonStart)),
        ];
      }
      // 은퇴도 이동 원장에 남는다 (toTeamId = null)
      for (const id of retirees) {
        state.moves.push({
          id: `mv-retire-${id}-${nextSeason}`,
          gamePlayerId: id,
          fromTeamId: team.id,
          toTeamId: null,
          date: nextCalendar.preseasonStart,
          kind: "retire",
        });
        const contract = state.contracts.find(
          (c) => c.gamePlayerId === id && c.status === "active",
        );
        if (contract) contract.status = "ended";
      }
      state.players = state.players.filter((p) => !retSet.has(p.id));
      state.transferListings = state.transferListings.filter(
        (listing) => !retSet.has(listing.gamePlayerId),
      );
      for (const id of retirees) playerIndex.delete(id);
      squad = squad.filter((p) => !retSet.has(p.id));
    }

    /**
     * 계약 만료 — **모든 구단이 같은 규칙이다**: 끝난 계약의 선수는 무소속이 된다
     * (`free-agency.ts`).
     *
     * 은퇴 **바로 뒤**에 두는 이유는 아래 유망주 유입이 이 빈자리까지 세야 하기
     * 때문이다 — 안 그러면 스쿼드가 마르고 열 시즌 뒤 골키퍼가 사라진다(소프트락).
     */
    const leavers = expireContracts(
      state,
      contractsByTeam.get(team.id) ?? [],
      nextCalendar.preseasonStart,
      (id) => playerIndex.get(id),
    );
    if (leavers.length > 0) {
      const gone = new Set(leavers.map((p) => p.id));
      squad = squad.filter((p) => !gone.has(p.id));
      if (team.id === managed) {
        for (const player of leavers) digest.push(`계약 만료로 떠남: ${player.name} (무소속)`);
      }
    }

    if (isFreePool) continue;

    /**
     * **유스 인테이크** — 은퇴·계약 만료 수 보충 + 포지션군 최소 인원 확보(소프트락
     * 방지) 위에 감독이 고를 여지가 얹힌다 (season.md §6).
     *
     * ⚠️ **우리 팀은 여기서 계약이 서지 않는다** — 후보로 세우고 소집일까지 감독의
     * 답을 기다린다. AI 구단은 그 자리에서 결정한다: 남의 아카데미의 고민을 읽는
     * 자리가 없고, 세계 전체가 후보 줄을 들면 세이브가 여름마다 수천 줄 불어난다.
     */
    const forced = forcedGroupsOf(squad);
    const fills = Math.max(Math.max(1, retirees.length + leavers.length), forced.length);
    const ours = team.id === managed;
    const intake = youthIntakeOf(
      fills,
      tier,
      ours ? academyUseOf(state, team.id, state.season) : 0,
    );
    const born = ours ? intake.candidates : intake.fills;
    const candidates: YouthCandidate[] = [];
    for (let i = 0; i < born; i++) {
      const youth = generateYouthPlayer(
        state.seed + YOUTH_INTAKE_SEED_OFFSET,
        team.id,
        nextSeason,
        i,
        tier,
        takenIds,
        forced[i],
        seasonYear(nextSeason),
        takenNames,
        intake.ceilingBonus,
      );
      if (ours) {
        candidates.push({
          player: youth,
          teamId: team.id,
          on: nextCalendar.preseasonStart,
          deadline: squadReturnOf(nextCalendar),
          weeklyWage: estimateWeeklyWage(
            team.id,
            wageSubjectOf(youth, nextCalendar.preseasonStart),
            squad.map((p) => wageSubjectOf(p, nextCalendar.preseasonStart)),
            state,
          ),
          years: YOUTH_CONTRACT_YEARS,
          // 앞에서부터 코어가 채운다 — 포지션군이 비는 자리가 앞에 서 있다
          autoSign: i < intake.fills,
        });
        continue;
      }
      admitYouth(
        state,
        youth,
        team.id,
        nextCalendar.preseasonStart,
        estimateWeeklyWage(
          team.id,
          wageSubjectOf(youth, nextCalendar.preseasonStart),
          playersOf(state, team.id).map((p) => wageSubjectOf(p, nextCalendar.preseasonStart)),
          state,
        ),
        YOUTH_CONTRACT_YEARS,
      );
      playerIndex.set(youth.id, youth);
      squad.push(youth);
    }
    if (ours) {
      state.youthCandidates = candidates;
      const line =
        `유스 후보 ${candidates.length}명 — ${squadReturnOf(nextCalendar)}까지 첫 프로 계약을 정한다` +
        ` (답이 없으면 앞의 ${intake.fills}명이 계약한다)`;
      digest.push(line);
    }

    promoteToMatchdaySquad(squad, !ours);

    // 새 스쿼드의 배치만 재구성한다 — 남은 선수의 기억은 이어진다.
    const tactics = tacticsOf(state, team.id);
    const retained = new Set(squad.map((player) => player.id));
    for (const old of tactics.assignments) {
      if (retained.has(old.playerId)) shelveFamiliarity(tactics, old, nextCalendar.preseasonStart);
    }
    if (tactics.shelved)
      tactics.shelved = tactics.shelved.filter((entry) => retained.has(entry.playerId));
    const currentLayout = tactics.assignments.filter((a) => a.role === "starting");
    const layoutSlots = currentLayout.map((a) => a.position);
    const layoutPoints = currentLayout.map((a) => a.point ?? anchorOf(a.position));
    /**
     * 배치가 11칸 미만이면(얇은 컵 팀) **포메이션의 빈 자리**로 채운다.
     *
     * 선수의 주 포지션으로 채우던 때는 왼쪽 윙어가 떠난 여름에 남은 오른쪽 자원 둘이
     * 나란히 `RW`의 기본 좌표에 서고 왼쪽 측면이 빈 채로 새 시즌이 시작됐다 — 자리를
     * 사람에게서 거꾸로 만들면 모양이 축구가 아니게 된다. 지금 선 자리를 걷어내고 남은
     * 자리를 세우므로(`openSeats`) 같은 자리 코드가 둘이 되지도 않는다.
     */
    for (const seat of openSeats(
      layoutPoints,
      presetOf(tactics.spec.formation) ?? DEFAULT_FORMATION,
    )) {
      if (layoutSlots.length >= 11) break;
      layoutSlots.push(positionAtPoint(seat));
      layoutPoints.push(seat);
    }
    if (!layoutSlots.some((position) => position === "GK")) {
      const goalkeeper = squad.find((player) => groupOf(player) === "GK");
      if (goalkeeper) {
        const index = Math.min(10, Math.max(0, layoutSlots.length - 1));
        layoutSlots[index] = "GK";
        layoutPoints[index] = anchorOf("GK");
      }
    }
    tactics.assignments = buildAssignments(
      squad.filter((p) => p.squadLevel !== "reserve"),
      // 아래 `slots`·`points`가 실제 배치를 정한다 — 자유 배치라 모양 이름이 프리셋이
      // 아닐 수 있고(4-1-3-2), 이 인자는 쓰이지 않는 폴백이다
      presetOf(tactics.spec.formation) ?? DEFAULT_FORMATION,
      FAMILIARITY_BASELINE,
      undefined,
      undefined,
      {
        slots: layoutSlots.slice(0, 11),
        points: layoutPoints.slice(0, 11),
      },
    );
    for (const assignment of tactics.assignments) {
      const memory = unshelveFamiliarity(tactics, assignment.playerId);
      if (!memory) continue;
      Object.assign(assignment, memory);
      settleRoleCost(
        assignment,
        nextCalendar.preseasonStart,
        assignment.role === "starting" ? assignment : null,
      );
    }
  }

  /**
   * 주장이 비면 부주장이 우선 승계한다 (people.md §5-1).
   * 부주장도 없으면 포지션과 무관하게 1군에서 리더십·생일·id 순으로 배정한다.
   */
  const userSquad = playersOf(state, state.userTeamId);
  if (!userSquad.some((p) => p.isCaptain)) {
    const successorId = successorCaptainOf(state, state.userTeamId);
    const next = userSquad.find((p) => p.id === successorId);
    if (next) {
      const wasVice = next.isViceCaptain;
      next.isCaptain = true;
      next.isViceCaptain = false;
      digest.push(
        `새 주장: ${next.name} (${naturalPositionOf(next).position})` +
          (wasVice ? " — 부주장이 완장을 이었다" : ""),
      );
    }
  }

  // 대항전 티켓 — **지금 끝난 시즌**의 리그 최종 순위와 국내 컵 우승팀으로 배정한다.
  // 순위표·컵 결과는 모두 `state.season`으로 걸러 읽으므로 **시즌을 올리기 전에**
  // 읽어야 한다. (state.matches도 곧 새 시즌으로 교체된다.)
  const finalTables: LeagueTables = {};
  for (const league of scopedLeagues(state.world)) {
    finalTables[league.id] = computeStandings(state, league.id).map((r) => r.teamId);
  }
  const cupWinners = domesticCupWinners(state);
  /**
   * 슈퍼컵 대진의 원본 — 티켓과 **같은 시점**에 읽어야 한다. 리그 최종 순위도 컵·
   * 대항전 우승도 `state.season`으로 걸러 읽고, 그 뒤 `state.matches`가 새 시즌
   * 것으로 통째로 교체된다 (competition.md §4-1).
   */
  const superCups: SuperCupSource | null = hasCups(state.world)
    ? {
        leagueTables: finalTables,
        domesticChampions: championsOf(domesticCupCatalog(), (id) => domesticChampion(state, id)),
        euroChampions: championsOf(cupCatalog(), (id) => euroChampion(state, id)),
      }
    : null;
  // 지나간 시즌이 남는 유일한 자리 — 승강이 소속을 옮기고 새 일정이 경기를 밀어내기
  // **전에** 그해 순위표와 우리 경기를 옮겨 적는다 (season.md §6)
  recordSeasonHistory(state);
  /**
   * 승강 — 티켓과 **같은 최종 순위표**를 쓰고, 새 일정을 짜기 **전에** 자리를 바꾼다.
   * 순서가 뒤집히면 강등된 팀이 그 리그의 다음 시즌 일정에 그대로 남는다.
   */
  const promoted = applyPromotionRelegation(state, finalTables, digest);
  /**
   * 체급 재산정 — 승강 **뒤**여야 한다. 승격·강등한 팀은 리그가 바뀌면서 다른 풀에
   * 들어가고, 그게 곧 완전 재산정이다 (team.md §2.1).
   */
  digest.push(...recomputeClubTiers(state));

  state.season = nextSeason;
  state.calendar = nextCalendar;
  // 새 시즌은 7월 1일(프리시즌)에서 시작한다
  state.date = nextCalendar.preseasonStart;
  /**
   * **승격 팀 명단 채우기** — 승강·체급 재산정 뒤이고 새 일정을 짜기 전이다
   * ([../../../../docs/team/team.md](../../../../docs/team/team.md) §5). 시즌·날짜를 넘긴 뒤에 서는 이유는
   * 계약 시작일과 난수 채널이 **새 시즌**의 것이어야 하기 때문이다.
   */
  reinforcePromotedSquads(state, promoted);
  state.euroEntrants = hasCups(state.world)
    ? buildEuroEntrants(
        nextSeason,
        state.seed,
        finalTables,
        cupWinners,
        (id) => tierOfTeamIn(state, id),
        // 2부 몫을 뽑는 자리라 소속은 승강 뒤의 것이어야 한다 (europe.ts `LeagueMembers`)
        (leagueId) => teamsOfLeagueIn(state, leagueId),
      )
    : [];
  /**
   * 감독이 2부로 내려갔으면 **그 리그도 리그전을 돈다** — 2부는 원래 컵 참가
   * 인원이라 일정이 없어서, 그대로 두면 강등이 곧 경기 없는 시즌이 된다.
   */
  const ourLeague = leagueOfTeamIn(state, state.userTeamId);
  const matches = buildSeasonFixtures(
    nextSeason,
    state.seed,
    state.euroEntrants,
    state.world,
    {
      leagueOf: state.leagueOf,
      ...(isCupOnlyLeague(ourLeague) ? { extraLeagues: [ourLeague] } : {}),
    },
    state.userTeamId,
    superCups,
  );
  state.matches = matches;
  state.schedule = buildScheduleEntries(
    matches.filter((m) => isUserFixture(m, state.userTeamId, ourLeague)),
    state.userTeamId,
  );
  /**
   * **여름 메이저 대회** — 짝수 해마다 하나 (→ [../../../../docs/season/competition.md](../../../../docs/season/competition.md) §5-1).
   *
   * 경기는 굴리지 않으므로 대회가 남기는 것은 「누가 늦게 오나」 하나다. 기본 훈련
   * 배치보다 **먼저** 서야 한다: 늦게 오는 선수는 소집일부터 그 날짜까지 훈련장에
   * 없고, 그 사실을 훈련·친선이 함께 읽는다.
   * 소집 명단은 **전환이 끝난 스쿼드**로 세운다 — 은퇴·만료·승강이 다 지나간 뒤라야
   * 그 선수가 실제로 새 시즌에 서는 사람이다.
   */
  applySummerTournament(state, nextSeason, squadReturnOf(nextCalendar), digest);
  state.trainingSessions = [];
  // 새 시즌 프리시즌도 기본 훈련으로 시작한다 — 감독의 지시는 시즌과 함께 지워진다
  installDefaultTraining(state);
  /**
   * **압력도 계단도 시즌과 함께 새로 센다** (people.md §8) — 지난 시즌의 방치를
   * 새 시즌 첫 주에 들고 오면 감독이 무엇을 해도 이미 3계단에서 시작한다.
   * 불만(`state.issues`)을 지우는 것과 같은 규약이다.
   */
  state.managerInterviews = [];
  // 시즌 단위 징계는 리셋 (경고 이력은 BOOKING에 시즌 키로 남는다)
  for (const s of state.suspensions) if (s.status === "active") s.status = "done";
  state.phase = "idle";
  state.pendingMatch = null;
  for (const name of expireStaffContracts(state, nextCalendar.preseasonStart))
    digest.push(`스태프 계약 만료 — ${name}`);
  refreshStaffPool(state, nextSeason);

  digest.push(
    `시즌 ${nextSeason} 프리시즌 시작 — ${nextCalendar.preseasonStart}. 개막전은 ${nextCalendar.start}이다`,
  );
  return digest;
}

/**
 * 시즌 종료 — 리뷰 → **마지막 달 마감** → 전환 (season.md §6).
 *
 * 마감이 가운데 서는 이유는 하나다: 리뷰가 상금·보너스를 그달 원장에 앉힌다. 마감이
 * 전환 뒤로 밀리면 상금이 앉은 달은 두 달 뒤(다음 시즌 8월 1일)에야 보고서가 된다
 * (finance.md §7.1).
 */
export function endSeason(state: GameState): string[] {
  return inTransaction(state, (draft) => {
    const digest = reviewSeason(draft);
    closeSeasonBooks(draft, digest);
    digest.push(...applyTransition(draft));
    return digest;
  });
}

/**
 * 시즌 전환 하나만 — 세이브에 옮겨 붙이는 경계는 `endSeason`과 같다.
 *
 * ⚠️ 마지막 걸음인 편성(`buildEuroEntrants`·`buildSeasonFixtures`)은 던질 수 있는데,
 * 그 자리는 계약 만료·은퇴·승강·`season++`가 전부 끝난 **뒤**다. 그래서 전이 전체가
 * 복제본 위에서 돌고, 끝까지 성공했을 때만 세이브가 된다 (season.md §6).
 */
export function transitionSeason(state: GameState): string[] {
  return inTransaction(state, applyTransition);
}

export type { GamePlayer };
