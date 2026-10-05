import { type GameState, teamShortNameIn, teamNameIn, playersOf, groupOf } from "../../core/state";
import { type TickSink, josa, type PositionGroup, type Contract } from "@story-fm/domain";
import {
  leagueOfTeamIn,
  hasRelegation,
  secondTierOf,
  RELEGATION_SLOTS,
} from "../../core/league-membership";
import {
  played,
  promotedFrom,
  setLeague,
  PROMOTED_SQUAD_FLOOR,
  REINFORCEMENT_DROP,
  neediestGroup,
  REINFORCEMENT_YEARS,
} from "../../season/promotion";
import { startParachute, stopParachute } from "../../team/finance";
import { leagueName } from "../../core/catalog/league-catalog";
import { squadRating } from "../../players/squad-depth";
import { generatePromotionSigning } from "../../players/generate";
import { seasonYear, contractUntil } from "../../core/dates";
import { assignSquadNumber } from "../../players/numbers";
import { estimateWeeklyWage, wageSubjectOf } from "../../team/wages";

/**
 * 승강 처리 — **시즌 전환에서 새 일정을 짜기 전에** 한 번.
 *
 * @param finalTables 방금 끝난 시즌의 리그별 최종 순위 (팀 id 순서).
 *   대항전 티켓과 같은 표를 쓴다 — 순위가 두 곳에서 갈리면 안 된다.
 */
export function applyPromotionRelegation(
  state: GameState,
  finalTables: Record<string, string[]>,
  digest: TickSink,
): string[] {
  const ourLeague = leagueOfTeamIn(state, state.userTeamId);
  /** 올라간 팀 — 보강이 이 목록을 받는다 (`reinforcePromotedSquads`) */
  const promoted: string[] = [];
  for (const [leagueId, table] of Object.entries(finalTables)) {
    if (!hasRelegation(state, leagueId)) continue;
    if (!played(state, leagueId)) continue;
    if (table.length <= RELEGATION_SLOTS) continue;
    const second = secondTierOf(leagueId)!;
    // 두 목록을 **먼저** 정한다 — 방금 강등된 팀이 그 자리에서 다시 올라오지 않게
    const down = table.slice(-RELEGATION_SLOTS);
    const up = promotedFrom(state, second);
    for (const teamId of down) {
      setLeague(state, teamId, second);
      // 낙하산 — 강등의 완충이자 챔피언십 재정 기준선의 정체 (finance.md §9-1)
      startParachute(state, teamId, leagueId);
    }
    for (const teamId of up) {
      setLeague(state, teamId, leagueId);
      // 승격하면 1부 배분을 다시 받으므로 낙하산은 끝난다 (이중 수령 금지)
      stopParachute(state, teamId);
      promoted.push(teamId);
    }

    if (leagueId !== ourLeague && second !== ourLeague) continue;
    digest.push(
      `${leagueName(leagueId)} 강등: ${down.map((id) => teamShortNameIn(state, id)).join(" · ")}`,
      `${leagueName(leagueId)} 승격: ${up.map((id) => teamShortNameIn(state, id)).join(" · ")}`,
    );
    if (down.includes(state.userTeamId)) {
      digest.push(
        `${josa(teamNameIn(state, state.userTeamId), "이/가")} 강등됐다 — 다음 시즌은 ${leagueName(second)}다`,
      );
    } else if (up.includes(state.userTeamId)) {
      digest.push(
        `${teamNameIn(state, state.userTeamId)} 승격! 다음 시즌은 ${leagueName(leagueId)}다`,
      );
    }
  }
  return promoted;
}

/**
 * 승격 팀 명단 보강 — **승강과 체급 재산정 뒤, 새 일정을 짜기 전에** 한 번.
 *
 * 2부 클럽은 컵에만 나오므로 스무 명으로 만들어진다(team.md §4). 그대로 올라가면
 * 매치데이 정원(20)과 명단이 같아 부상 하나에 벤치가 빈다. 그래서 하한까지 채운다
 * — 40명대로 올라온 팀(강등됐다 돌아온 클럽)은 이미 하한 위라 한 명도 받지 않는다.
 *
 * 난수는 `(세이브 시드, promotion-signing:팀:시즌:번호)`에서만 나온다 — 같은
 * 세이브를 다시 굴리면 같은 사람이 온다.
 *
 * **감독의 구단은 받지 않는다** — 감독의 선수단은 처음 맡은 선수와 유스 첫 계약으로만
 * 채워진다 (season.md §6).
 */
export function reinforcePromotedSquads(state: GameState, promoted: readonly string[]): void {
  // id도 이름도 세계 전체에서 유일해야 한다 — 한 번 쥐고 팀을 돌며 등록한다
  // (이름의 기준이 팀이 아니라 세계인 이유는 people.md §2)
  const takenIds = new Set(state.players.map((p) => p.id));
  const takenNames = new Set(state.players.map((p) => p.name));
  for (const teamId of promoted) {
    if (teamId === state.userTeamId) continue;
    const squad = playersOf(state, teamId);
    /**
     * **하한이 재는 것은 1군이다.** 2군은 매치데이 명단에 설 수 없으므로(team.md §5)
     * 전체 인원으로 재면, 유스가 쌓인 2부 클럽이 1군 열다섯 명으로 올라가면서도
     * "이미 하한 위"로 읽힌다.
     */
    const firstTeam = squad.filter((p) => p.squadLevel !== "reserve");
    const short = PROMOTED_SQUAD_FLOOR - firstTeam.length;
    if (short <= 0) continue;
    const base = Math.round(squadRating(state, teamId)) - REINFORCEMENT_DROP;
    const have: Record<PositionGroup, number> = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const player of firstTeam) have[groupOf(player)] += 1;
    for (let i = 0; i < short; i++) {
      const group = neediestGroup(have);
      have[group] += 1;
      const signing = generatePromotionSigning(
        state.seed,
        teamId,
        state.season,
        i,
        base,
        group,
        takenIds,
        seasonYear(state.season),
        takenNames,
      );
      state.players.push(signing);
      assignSquadNumber(state.players, signing);
      state.moves.push({
        id: `mv-promo-${signing.id}`,
        gamePlayerId: signing.id,
        fromTeamId: null,
        toTeamId: teamId,
        date: state.date,
        kind: "reinforcement",
      });
      const signed: Contract = {
        id: `c-${signing.id}`,
        gamePlayerId: signing.id,
        teamId,
        weeklyWage: estimateWeeklyWage(
          teamId,
          wageSubjectOf(signing, state.date),
          playersOf(state, teamId).map((p) => wageSubjectOf(p, state.date)),
          state,
        ),
        since: state.date,
        until: contractUntil(state.date, REINFORCEMENT_YEARS),
        status: "active",
      };
      state.contracts.push(signed);
    }
  }
}
