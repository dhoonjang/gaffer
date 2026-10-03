import { type GameState, isInjured } from "../../../../common/core/state";
import { type InternationalBreak } from "../../../../common/players/international";
import {
  type TickSink,
  capsOf,
  internationalGoalsOf,
  clampFatigue,
  fatigueOf,
  clampCondition,
} from "@story-fm/domain";
import { fatigueFromMinutes } from "@story-fm/sim";
import {
  MINUTES_PER_APP,
  CALL_UP_TRAVEL_FATIGUE,
  CALL_UP_FATIGUE_PER_APP,
  INTERNATIONAL_INJURY_PER_APP,
  returnStateOf,
  trimCallUps,
} from "../../../../match/competition/international";
import { makeRng } from "../../../../common/core/rng";
import { injuryProneness } from "../../../../common/players/injury";
import { openInjuryFor } from "../health/injury";

// ── 복귀 ──────────────────────────────────────────────

/**
 * **휴식기 마지막 날 — 돌아온 몸을 장부에 적는다.**
 *
 * 그날의 회복이 이미 얹힌 **뒤에** 부른다(tick의 계약). 체력은 열흘의 회복을
 * 되돌리지 않고 이동과 출전의 대가만 한 번에 낸다 — 소집된 선수도 매일 회복하되
 * 훈련장이 아니라 쉬는 날의 눈금을 받았기 때문이다.
 */
export function settleCallUps(
  state: GameState,
  window: InternationalBreak,
  digest: TickSink,
): void {
  for (const row of state.callUps) {
    if (row.breakKey !== window.key || row.returnedOn !== null) continue;
    const player = state.players.find((p) => p.id === row.gamePlayerId);
    row.returnedOn = state.date;
    if (!player) continue;

    player.state.caps = capsOf(player.state) + row.apps;
    if (row.goals > 0) {
      player.state.internationalGoals = internationalGoalsOf(player.state) + row.goals;
    }
    /**
     * **시즌의 잔고는 킥오프 체력으로 잰다** (player.md §5.5) — 클럽 경기 마감과
     * 같은 순서다(`finalizeMatch`): 체력을 깎기 **전**의 값으로 재야 「덜 회복된
     * 몸으로 뛴 90분이 더 남는다」는 연전 간격 항이 성립한다. 대표팀 출전만 이
     * 장부를 비켜 가면 9·10·11·3월의 A매치 여덟 경기가 시즌에 아무것도 쌓지 않는다.
     */
    player.state.fatigue = clampFatigue(
      fatigueOf(player.state) +
        fatigueFromMinutes(row.apps * MINUTES_PER_APP, player.state.condition),
    );
    player.state.condition = clampCondition(
      player.state.condition - CALL_UP_TRAVEL_FATIGUE - CALL_UP_FATIGUE_PER_APP * row.apps,
    );

    const rng = makeRng(state.seed, `call-up-return:${window.key}:${player.id}`);
    let hurt = false;
    for (let i = 0; i < row.apps; i++) {
      if (isInjured(state, player.id)) break;
      if (rng() >= INTERNATIONAL_INJURY_PER_APP * injuryProneness(state, player.id)) continue;
      const { days, part } = openInjuryFor(state, player, "match", rng);
      hurt = true;
      if (player.teamId === state.userTeamId) {
        digest.push(
          `대표팀에서 부상: ${player.name} — ${part}, 약 ${days}일 결장 예상 (${row.country})`,
        );
      }
    }
    row.returnState = returnStateOf(row.apps, hurt);
  }
  trimCallUps(state);

  const ours = state.callUps.filter(
    (r) =>
      r.breakKey === window.key &&
      state.players.find((p) => p.id === r.gamePlayerId)?.teamId === state.userTeamId,
  );
  if (ours.length > 0) {
    const played = ours.filter((r) => r.apps > 0);
    const goals = ours.reduce((s, r) => s + r.goals, 0);
    digest.push(
      `${window.label} 복귀 — ${ours.length}명 중 ${played.length}명 출전` +
        (goals > 0 ? ` · ${goals}골` : "") +
        ` · 지쳐 돌아온 선수 ${ours.filter((r) => r.returnState !== "fit").length}명`,
    );
  }
}
