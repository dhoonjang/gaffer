import { type GameState, teamNameIn, pushMedia } from "../../common/core/state";
import { diffDays } from "../../common/core/dates";
import type { Dismissal } from "@story-fm/domain";

/**
 * 벤치가 비었다 — **우리 감독의 것과 남의 벤치의 것이 같은 카드를 쓴다** (people.md §4-1).
 *
 * 원인 코드는 `Dismissal.kind` 그대로다 (career.md §5.4). 코드를 두 벌 두면 한쪽만
 * 늘어나고, 같은 이별이 회견에서와 기사에서 다른 이름으로 선다.
 *
 * `days`는 재임 일수다 — 없으면(부임일을 모르는 벤치) 적지 않는다. 없는 것을
 * 0으로 적으면 어제 온 감독이 잘린 것으로 읽힌다.
 */
export function reportSacking(
  state: GameState,
  input: {
    teamId: string;
    kind: NonNullable<Dismissal["kind"]>;
    position?: number;
    since?: string;
  },
): void {
  pushMedia(state, [
    {
      kind: "sacking",
      date: state.date,
      data: {
        refId: input.teamId,
        name: teamNameIn(state, input.teamId),
        values: {
          ...(input.position === undefined ? {} : { position: input.position }),
          ...(input.since === undefined ? {} : { days: diffDays(input.since, state.date) }),
        },
        tags: [input.kind],
      },
    },
  ]);
}

/**
 * 그 벤치에 후임이 앉았다 — **화자가 새 감독인 기사다** (people.md §4-1).
 *
 * 화자가 있으면 그 턴 인물 사전이 그 사람을 지목한다(§6) — 그 사람의 말을 GM이 쓰려면
 * 인물지가 함께 실려야 한다. `tags[0]`이 어디서 왔는가(`pool` 다른 벤치에 있던 사람 ·
 * `unknown` 지어낸 이름), `tags[1]`이 그 구단의 이름이다.
 */
export function reportAppointment(
  state: GameState,
  input: { teamId: string; managerName: string; fromPool: boolean; position?: number },
): void {
  pushMedia(state, [
    {
      kind: "appointment",
      date: state.date,
      speakerId: input.managerName,
      data: {
        refId: input.teamId,
        name: input.managerName,
        values: input.position === undefined ? {} : { position: input.position },
        tags: [input.fromPool ? "pool" : "unknown", teamNameIn(state, input.teamId)],
      },
    },
  ]);
}
