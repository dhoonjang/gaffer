import { type GameState, teamNameIn, pushNarrative } from "../../../../common/core/state";
import { type TickSink, pushEvent, josa } from "@story-fm/domain";
import { SUPER_CUP_CATALOG } from "../../../../common/data/super-cup-catalog";
import { superCupMatch } from "../../../../match/competition/super-cup";
import { settledTieWinner, needsShootout } from "../../../../match/competition/extra-time";
import { resolveExtraTime } from "./extra-time";
import { resolveShootout } from "../../../../match/competition/shootout";
import { payPrize } from "./prize";

/**
 * 슈퍼컵 정산 — 매일 tick에서, 국내 컵·대항전과 같은 자리에서 불린다.
 *
 * 무승부면 연장 30분 → 승부차기다 (모든 결승과 같은 문). 트로피·상금·보고는
 * **상금이 실제로 나간 그 한 번**에만 낸다 — `payPrize`의 멱등 키가 곧 "이 시즌
 * 이 대회를 이미 결산했다"는 사실이라, 매일 부르는 이 함수가 같은 우승을 되풀이해
 * 보고하지 않는다.
 */
export function advanceSuperCups(state: GameState, digest: TickSink): void {
  for (const cup of SUPER_CUP_CATALOG) {
    const match = superCupMatch(state, cup.id);
    if (!match?.result) continue;
    // 이미 갈린 경기는 다시 굴리지 않는다 — 이 함수는 남은 시즌 내내 매일 불린다
    if (settledTieWinner([match]) === null) {
      resolveExtraTime(state, match, `${cup.id}:${state.season}`);
      if (needsShootout(state, match)) resolveShootout(state, match);
    }
    const champion = settledTieWinner([match]);
    if (champion === null) continue;
    const runnerUp = match.homeTeamId === champion ? match.awayTeamId : match.homeTeamId;

    const settled = payPrize(
      state,
      { cup, teamId: champion, kind: "winner", what: "우승", amount: cup.prize.winner },
      digest,
    );
    payPrize(
      state,
      { cup, teamId: runnerUp, kind: "runner-up", what: "준우승", amount: cup.prize.runnerUp },
      digest,
    );
    if (!settled) continue;

    /**
     * **우승은 세계의 사실이라 전 구단의 것으로 적힌다** (career.md §6). 슈퍼컵만은
     * 시즌 리뷰가 아니라 tick이 정산하므로 원장도 여기서 적는다 — 위 `settled`가
     * `payPrize`의 멱등 키라, 매일 부르는 이 함수가 같은 줄을 두 번 적지 않는다.
     */
    state.trophies.push({
      season: state.season,
      competitionId: cup.id,
      teamId: champion,
      runnerUpTeamId: runnerUp,
    });

    if (champion === state.userTeamId) {
      pushEvent(
        digest,
        "news",
        `${cup.name} 우승 — ${josa(teamNameIn(state, runnerUp), "을/를")} 꺾었다`,
      );
      pushNarrative(state, `${cup.name} 우승`, 4);
    } else if (runnerUp === state.userTeamId) {
      pushEvent(digest, "news", `${cup.short} 준우승 — ${teamNameIn(state, champion)}에 졌다`);
      pushNarrative(state, `${cup.short} 준우승`, 3);
    } else {
      pushEvent(digest, "news", `${cup.short} 우승: ${teamNameIn(state, champion)}`);
    }
  }
}
