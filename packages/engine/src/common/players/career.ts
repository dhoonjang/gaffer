import { type GameState } from "../core/state";
import {
  type SeasonAward,
  type PressFact,
  type GamePlayer,
  ageOf,
  RETIRE_AGE,
} from "@story-fm/domain";
import { competitionShortName } from "../data/cup-catalog";
import { buildSeasonCalendar } from "../core/calendar";

/**
 * **가장 최근에 매겨진 시즌**(`state.season - 1`)에 그 선수가 받은 상 — 장부 순서 그대로.
 *
 * 시상은 시즌 전환이 매기므로 진행 중인 시즌에는 아직 상이 없다. 창이 하나인 것이 규약이다
 * (season.md §6 「상이 사실로 서는 자리」) — 자리마다 다른 창을 쓰면 같은 상이 선수 카드엔
 * 서고 회견엔 서지 않는다.
 */
export function lastSeasonAwardsOf(state: GameState, playerId: string): readonly SeasonAward[] {
  return state.awards.filter((a) => a.season === state.season - 1 && a.gamePlayerId === playerId);
}

/**
 * 상 한 건의 **사실 카드** — 회견(`opening`·`season-end`)과 계약 다가옴이 같은 장을 쓴다
 * (people.md §4 `award`).
 *
 * 날 선 자리가 아니다: 기자가 캐물을 일이 아니라 물어봐 줄 일이고, 날을 세우면 그 자리의
 * 무게가 올라 상이 결국 눈금을 움직인다 (season.md §6).
 *
 * 이름은 **부르는 자리에서만** 싣는다 — 다가옴의 카드는 `about`이 이미 그 사람이다.
 */
export function awardFact(a: SeasonAward, opts: { named: boolean }): PressFact {
  return {
    kind: "award",
    data: {
      ...(opts.named ? { name: a.playerName } : {}),
      values: {
        season: a.season,
        apps: a.apps,
        goals: a.goals,
        assists: a.assists,
        ...(a.rating === undefined ? {} : { rating: a.rating }),
        ...(a.age === undefined ? {} : { age: a.age }),
      },
      tags: [a.code, competitionShortName(a.competitionId)],
    },
    about: a.gamePlayerId,
    sharp: false,
  };
}

/**
 * 은퇴 판정일 — **다음 시즌 개막일이다.**
 *
 * 1월의 예고와 7월의 집행이 같은 날로 나이를 재야 "예고한 명단과 은퇴한 명단이 같다"가
 * 성립한다 (season.md §6 불변식). 그 사이에 생일이 끼는 선수가 예고 뒤에 조용히 한 살을
 * 더 먹으면 감독이 들은 명단과 장부가 갈린다.
 */
export function retirementJudgeDate(season: number): string {
  return buildSeasonCalendar(season + 1).start;
}

/**
 * 예고를 거둔다 — **나이 상한 안에서만** (season.md §6). 판정일에 이미 `RETIRE_AGE`인
 * 선수는 거둘 수 없다: 서른다섯의 몸을 계약서가 되돌리지는 못한다.
 *
 * 거둬진 선수는 다음 1월에 다시 판정을 받으므로 되돌림은 한 시즌씩만 이어진다.
 */
export function withdrawRetirement(state: GameState, player: GamePlayer): boolean {
  if (player.state.retiringAfterSeason === undefined) return false;
  if (ageOf(player.birthdate, retirementJudgeDate(state.season)) >= RETIRE_AGE) return false;
  player.state.retiringAfterSeason = undefined;
  return true;
}
