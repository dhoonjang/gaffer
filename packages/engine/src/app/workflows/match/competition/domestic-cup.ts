import { type GameState, teamName } from "../../../../common/core/state";
import {
  type DomesticCupEntry,
  domesticStageLabel,
  DOMESTIC_STAGES,
  domesticCupCatalog,
} from "../../../../common/data/domestic-cup-catalog";
import { type MatchStage, type TickSink, type MatchRecord } from "@story-fm/domain";
import { payPrize } from "./prize";
import {
  seededBracket,
  createDomesticTie,
  scheduleNextDraw,
  domesticTieLegs,
  cupRunsThisSeason,
  domesticCupField,
  reportDomesticTie,
  withSeedEntrants,
  userStillIn,
  syncCupRounds,
  domesticChampion,
  domesticRunnerUp,
} from "../../../../match/competition/domestic-cup";
import { shuffled } from "../../../../common/core/rng";
import { registerUserEntries, stageMatchesOf } from "../../../../match/competition/knockout";
import { resolveExtraTime } from "./extra-time";
import { needsShootout, settledTieWinner, pairOf } from "../../../../match/competition/extra-time";
import { resolveShootout } from "../../../../match/competition/shootout";
import { domesticCupEntrants } from "../../../../common/views/cup-entrants";
import {
  scheduleDraw,
  drawIsDue,
  drawEntryOf,
  completeDraw,
} from "../../../../match/competition/draw-schedule";
import { seasonDate } from "../../../../match/competition/calendar";
import { type PrizeKind } from "../../../../match/competition/prize";

/** 라운드 진출 상금 — 그 단계에 오른 모든 팀에게 (중복 지급은 원장 키가 막는다) */
export function payRoundPrize(
  state: GameState,
  cup: DomesticCupEntry,
  stage: MatchStage,
  teams: string[],
  digest: TickSink,
): void {
  const amount = cup.prize.round[stage] ?? 0;
  if (amount <= 0) return;
  const what = `${domesticStageLabel(cup, stage)} 진출`;
  for (const teamId of new Set(teams)) {
    payPrize(state, { cup, teamId, kind: `stage:${stage}`, what, amount }, digest);
  }
}

/**
 * 한 단계를 편성한다.
 *
 * 라운드별 추첨 대회는 매번 새로 뽑고(시드 없음), 대진표 확정형은 1라운드만
 * 시드 배치로 깔고 이후엔 **브래킷 자리 순서**를 그대로 쓴다 — 그래서 개막부터
 * "이기면 8강에서 누구"가 보인다.
 */
export function createStage(
  state: GameState,
  cup: DomesticCupEntry,
  stage: MatchStage,
  teams: string[],
  digest: TickSink,
): void {
  const firstStage = stage === DOMESTIC_STAGES[0];
  const order =
    cup.drawStyle === "fixed-bracket"
      ? firstStage
        ? seededBracket(state, cup, teams)
        : teams // 브래킷 자리가 대진을 정한다 (승자 목록이 이미 그 순서다)
      : shuffled(teams, state.seed, `cupdraw:${cup.id}:${state.season}:${stage}`);
  const created: MatchRecord[] = [];
  const pairCount = Math.floor(order.length / 2);
  for (let pair = 0; pair < pairCount; pair++) {
    const legs = createDomesticTie(
      state,
      cup,
      stage,
      pair,
      pairCount,
      order[pair * 2]!,
      order[pair * 2 + 1]!,
      digest,
    );
    // **바로 장부에 올린다.** 라운드를 다 짜고 한꺼번에 올리면, 뒤 대진이 리그를
    // 비켜세울 때(`clearForCup`) 앞 대진의 경기가 아직 장부에 없어 그 날짜로 리그가
    // 옮겨 앉는다 — 한 팀이 하루에 두 경기를 갖고 시즌이 멈춘다.
    // (쿠프 드 프랑스 1라운드가 릴·앙제의 리그 16R와 같은 날 잡혔던 원인이다.)
    state.matches.push(...legs);
    created.push(...legs);
  }
  if (created.length === 0) return;

  registerUserEntries(state, created);
  payRoundPrize(state, cup, stage, teams, digest);
  scheduleNextDraw(state, cup, stage, created, digest);

  const label = domesticStageLabel(cup, stage);
  const ours = created.find(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (ours) {
    const opponent = ours.homeTeamId === state.userTeamId ? ours.awayTeamId : ours.homeTeamId;
    const where = ours.neutral ? "중립" : ours.homeTeamId === state.userTeamId ? "홈" : "원정";
    digest.push(
      `${cup.short} ${label} 대진 확정 — ${where}에서 ${teamName(opponent)} (${ours.date})`,
    );
  }
}

/**
 * 대진을 **끝까지 치러** 승자를 낸다 — 경기가 모두 끝났을 때만.
 *
 * 단판은 90분, 2차전제는 합계가 같으면 **연장 30분**을 먼저 치르고(`extra-time.ts`)
 * 그래도 갈리지 않으면 승부차기다(`shootout.ts`). 둘 다 멱등이라 여러 번 불러도
 * 스코어가 자라지 않는다. 부르는 곳은 대회를 진행시키는 `advanceDomesticCups`뿐이다.
 */
export function resolveDomesticTie(
  state: GameState,
  cupId: string,
  stage: MatchStage,
  pair: number,
): string | null {
  const legs = domesticTieLegs(state, cupId, stage, pair);
  if (legs.length === 0 || legs.some((m) => !m.result)) return null;

  const decider = legs[legs.length - 1]!;
  resolveExtraTime(state, decider, `${cupId}:${stage}:${pair}`);
  if (needsShootout(state, decider)) resolveShootout(state, decider);
  return settledTieWinner(legs);
}

/**
 * 국내 컵 진행 — 매일 tick과 우리 경기 종료 직후에 호출된다.
 *
 * 대회마다 "다음에 만들어야 할 단계"를 하나만 본다. 라운드는 **추첨일에** 열리고,
 * 그 날짜는 실제 대회에서 왔다 — 1라운드는 카탈로그의 `firstDraw`(FA컵 12/8 등),
 * 이후는 직전 라운드 마지막 경기 + `drawDelayDays`.
 * 우승·트로피는 시즌 리뷰가 확정한다 (`reviewDomesticCups`).
 */
export function advanceDomesticCups(state: GameState, digest: TickSink): void {
  for (const cup of domesticCupCatalog()) {
    if (!cupRunsThisSeason(state, cup)) continue;
    let previousWinners: string[] | null = null;

    for (let i = 0; i < DOMESTIC_STAGES.length; i++) {
      const stage = DOMESTIC_STAGES[i]!;
      const existing = stageMatchesOf(state, cup.id, stage);
      if (existing.length === 0) {
        if (i === 0) {
          // 1라운드 — 실제 대회의 추첨일에 뽑는다. 명단은 전 클럽이지만 실제로
          // 뛰는 필드는 시드·앞 라운드 탈락을 가른 뒤의 것이다 (§3.2-1)
          const entrants = domesticCupEntrants(cup.id);
          scheduleDraw(
            state,
            cup.id,
            stage,
            seasonDate(state.season, cup.firstDraw),
            entrants.includes(state.userTeamId),
          );
          if (!drawIsDue(state, cup.id, stage)) break;
          createStage(state, cup, stage, domesticCupField(state, cup).opening, digest);
        } else {
          if (!previousWinners || previousWinners.length < 2) break;
          // 추첨일은 직전 라운드를 편성할 때 이미 잡혀 있다 (없으면 추첨 없는 단계)
          if (drawEntryOf(state, cup.id, stage) && !drawIsDue(state, cup.id, stage)) break;
          reportDomesticTie(state, cup, DOMESTIC_STAGES[i - 1]!, previousWinners, digest);
          createStage(
            state,
            cup,
            stage,
            withSeedEntrants(state, cup, stage, previousWinners),
            digest,
          );
        }
        completeDraw(state, cup.id, stage);
        break; // 한 번에 한 단계만 — 다음 단계는 이 단계가 끝난 뒤
      }
      const pairCount = new Set(existing.map((m) => pairOf(m))).size;
      const winners: string[] = [];
      for (let pair = 0; pair < pairCount; pair++) {
        const winner = resolveDomesticTie(state, cup.id, stage, pair);
        if (winner) winners.push(winner);
      }
      if (winners.length < pairCount) break; // 아직 진행 중
      previousWinners = winners;
    }

    // 탈락하면 남은 추첨은 감독의 달력에서 내린다 (우리 상대를 뽑는 자리가 아니다)
    if (!userStillIn(state, cup.id)) {
      for (const e of state.schedule) {
        if (e.type === "draw" && e.status === "scheduled" && e.refId.startsWith(`${cup.id}:`)) {
          e.teamId = null;
        }
      }
    }
  }
  syncCupRounds(state);
}

/**
 * 국내 컵 우승·준우승 **상금** — 구단이 받는 돈이라 감독의 커리어와 갈라져 있다.
 *
 * 트로피·평판을 적는 `reviewDomesticCups`와 따로 부르는 이유는 **무직으로 맞은 시즌
 * 끝**이다: 그 시즌은 감독에게 남지 않지만 옛 구단의 장부는 계속 돌아야 하고, 시즌 키가
 * 바뀌므로 여기서 안 주면 영영 못 준다 (career.md §5.1).
 */
export function payDomesticCupPrizes(state: GameState, digest: TickSink): void {
  for (const cup of domesticCupCatalog()) {
    const champion = domesticChampion(state, cup.id);
    if (!champion) continue;
    const runnerUp = domesticRunnerUp(state, cup.id);

    const payTo = (teamId: string, kind: PrizeKind, what: string, amount: number) =>
      payPrize(state, { cup, teamId, kind, what, amount }, digest);
    payTo(champion, "winner", "우승", cup.prize.winner);
    if (runnerUp) payTo(runnerUp, "runner-up", "준우승", cup.prize.runnerUp);
  }
}
