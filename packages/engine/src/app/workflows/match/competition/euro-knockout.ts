import {
  type GameState,
  teamNameIn,
  pushNarrative,
  teamShortNameIn,
} from "../../../../common/core/state";
import { type MatchStage, type TickSink, type MatchRecord } from "@story-fm/domain";
import {
  euroTieLegs,
  leaguePhaseSeeds,
  seedIndex,
  createTie,
  euroLeaguePhaseDone,
  playoffPairs,
  pairUp,
  mainDrawPairs,
  reportEuroTie,
  scheduleEuroDraw,
} from "../../../../match/competition/euro-knockout";
import { resolveExtraTime } from "./extra-time";
import { needsShootout, settledTieWinner, pairOf } from "../../../../match/competition/extra-time";
import { resolveShootout } from "../../../../match/competition/shootout";
import {
  type CupCatalogEntry,
  competitionShortName,
  stageLabel,
  cupCatalog,
  knockoutStages,
} from "../../../../common/data/cup-catalog";
import { registerUserEntries, stageMatchesOf } from "../../../../match/competition/knockout";
import { payStagePrizes, payLeaguePhasePrizes } from "./euro-prize";
import { drawIsDue, completeDraw } from "../../../../match/competition/draw-schedule";

/**
 * 대진을 **끝까지 치러** 승자를 낸다 — 두 경기(또는 결승 한 경기)가 모두 끝났을 때만.
 *
 * 합계가 같으면 **연장 30분**을 치르고(`extra-time.ts`), 그래도 같으면 승부차기를
 * 굴려 2차전 장부에 킥 목록과 합계를 남긴다(`shootout.ts`). 둘 다 멱등이다.
 * 부르는 곳은 대회를 진행시키는 `advanceEuroKnockouts`뿐이다.
 */
export function resolveEuroTie(
  state: GameState,
  cupId: string,
  stage: MatchStage,
  pair: number,
): string | null {
  const legs = euroTieLegs(state, cupId, stage, pair);
  if (legs.length === 0 || legs.some((m) => !m.result)) return null;

  const decider = legs[legs.length - 1]!;
  resolveExtraTime(state, decider, `${cupId}:${stage}:${pair}`);
  if (needsShootout(state, decider)) resolveShootout(state, decider);
  return settledTieWinner(legs);
}

/** 한 단계를 편성한다 — 참가 팀을 대진으로 묶어 경기를 만든다 */
function createStage(
  state: GameState,
  cup: CupCatalogEntry,
  stage: MatchStage,
  pairs: Array<[string, string]>,
  digest: TickSink,
): void {
  const seeds = leaguePhaseSeeds(state, cup.id);
  const created: MatchRecord[] = [];
  pairs.forEach(([a, b], pair) => {
    const better = seedIndex(seeds, a) <= seedIndex(seeds, b) ? a : b;
    const worse = better === a ? b : a;
    created.push(...createTie(state, cup, stage, pair, better, worse));
  });
  state.matches.push(...created);
  registerUserEntries(state, created);
  payStagePrizes(state, cup.id, stage, pairs.flat(), digest);

  const short = competitionShortName(cup.id);
  const label = stageLabel(stage, 1, false);
  const ours = created.find(
    (m) => m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId,
  );
  if (ours) {
    const opponent = ours.homeTeamId === state.userTeamId ? ours.awayTeamId : ours.homeTeamId;
    digest.push(
      `${short} ${label} 대진 확정 — 상대는 ${teamNameIn(state, opponent)} (${ours.date})`,
    );
    pushNarrative(state, `${short} ${label} 진출 — vs ${teamNameIn(state, opponent)}`, 4);
  } else {
    digest.push(
      `${short} ${label} 대진: ${pairs
        .slice(0, 4)
        .map(([a, b]) => `${teamShortNameIn(state, a)}–${teamShortNameIn(state, b)}`)
        .join(", ")}${pairs.length > 4 ? " 등" : ""}`,
    );
  }
}

/**
 * 대항전 녹아웃 진행 — 매일 tick에서 호출된다.
 *
 * 대회마다 "다음에 만들어야 할 단계"를 찾아 하나만 편성한다. 편성은 직전 단계가
 * 완결된 직후(= 예약된 날짜보다 몇 주 앞)에 일어나므로 감독의 달력에 미리 오른다.
 * 편성이 곧 **한 번만 일어나는 사건**이므로 진출·탈락 보고도 이때 함께 낸다
 * (매일 호출되는 함수에서 중복 보고를 피하는 가장 단순한 방법이다).
 * 우승·트로피는 시즌 리뷰가 맡는다 (`reviewSeason` — 결승은 리그 종료 뒤에 열린다).
 */
export function advanceEuroKnockouts(state: GameState, digest: TickSink): void {
  for (const cup of cupCatalog()) {
    if (!euroLeaguePhaseDone(state, cup.id)) continue;
    const stages = knockoutStages(cup);
    const seeds = leaguePhaseSeeds(state, cup.id);
    let previousWinners: string[] | null = null;

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      const existing = stageMatchesOf(state, cup.id, stage);
      if (existing.length === 0) {
        const previous = i > 0 ? stages[i - 1]! : null;
        const pairs =
          stage === "playoff"
            ? playoffPairs(cup, seeds)
            : previousWinners === null
              ? // 플레이오프 없는 대회 — 리그 페이즈 상위가 곧 본선 대진
                pairUp(seeds.slice(0, cup.directSlots))
              : previous === "playoff"
                ? mainDrawPairs(state, cup, seeds, previousWinners)
                : pairUp(previousWinners);
        if (pairs.length === 0) break;
        // 추첨은 며칠 뒤 — 그 사이 감독은 달력에서 "누가 걸릴까"를 기다린다.
        // 결승만 예외다: 준결승 승자 둘이 곧 대진이라 뽑을 게 없다.
        if (stage === "final") {
          if (previous && previousWinners) {
            reportEuroTie(state, cup, previous, previousWinners, digest);
          }
        } else {
          // 예약이 새로 잡히는 순간에만 직전 라운드 결과를 보고한다 (중복 방지)
          if (scheduleEuroDraw(state, cup, stage, pairs.flat(), digest)) {
            if (previous && previousWinners) {
              reportEuroTie(state, cup, previous, previousWinners, digest);
            }
          }
          if (!drawIsDue(state, cup.id, stage)) break;
        }
        /**
         * 참가비·승무 수당은 **첫 녹아웃을 편성하는 이 순간 한 번**이다. 지급 자체는
         * `prizesPaid` 키가 막지만, 이 함수는 매일 tick에서 불리므로 위에 두면 시즌이
         * 끝날 때까지 세 대회의 리그 페이즈 전 경기를 매일 다시 훑는다.
         */
        if (i === 0) payLeaguePhasePrizes(state, cup.id, digest);
        createStage(state, cup, stage, pairs, digest);
        completeDraw(state, cup.id, stage);
        break; // 한 번에 한 단계만 — 다음 단계는 이 단계가 끝난 뒤
      }
      const pairCount = new Set(existing.map((m) => pairOf(m))).size;
      const winners: string[] = [];
      for (let pair = 0; pair < pairCount; pair++) {
        const winner = resolveEuroTie(state, cup.id, stage, pair);
        if (winner) winners.push(winner);
      }
      if (winners.length < pairCount) break; // 아직 진행 중
      previousWinners = winners;
    }
  }
}
