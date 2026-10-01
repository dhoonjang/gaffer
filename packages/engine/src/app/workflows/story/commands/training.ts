import { type GameState } from "../../../../common/core/state";
import { type CommandResult } from "../../../../common/commands/result";
import { ourYouthCandidates, youthIntakeDeadline, signYouthCandidates } from "../../../season";
import { type GamePlayer, josa } from "@story-fm/domain";
import { pickPlayerAmong } from "../../../../common/core/player-ref";
import { briefNames, item } from "../../../../common/commands/brief";

/**
 * **첫 프로 계약** — 여름의 유스 후보 중 감독이 고른 이름이 계약을 받는다
 * (season.md §6 유스 인테이크).
 *
 * **한 번의 확정이다** — 고른 이름이 계약하고 **나머지 후보는 구단을 떠난다.** 목록을
 * 고쳐 가며 여러 번 부르는 자리가 아니고, 이름을 하나도 주지 않으면 전원 돌려보낸다:
 * 스쿼드 크기의 결정권이 감독에게 있다는 것이 이 손잡이의 값이다.
 *
 * **돌려보낸 아이는 사라지지 않는다** — 무소속 명부로 간다(season.md §6). 답이 그
 * 수를 적는 것은 감독이 나중에 다시 부를 수 있는지가 거기 달렸기 때문이다: 명부의
 * 자리는 상한이 있어 세계의 또래에게 밀리면 서지 못한다.
 *
 * ⚠️ **소프트락 방지는 감독의 결정 밖이다** — 고른 뒤에도 포지션군이 최소 인원
 * 아래면 코어가 남은 후보에서 그 자리를 채우고, 무엇을 채웠는지 답에 적는다.
 */
export function signYouth(state: GameState, input: { playerIds?: string[] }): CommandResult {
  const rows = ourYouthCandidates(state);
  if (rows.length === 0) {
    return {
      ok: false,
      message: `지금 서 있는 유스 후보가 없습니다 — 인테이크는 여름 프리시즌에 한 번뿐이고 소집일(${youthIntakeDeadline(state)})에 닫힙니다`,
    };
  }
  const pool = rows.map((row) => row.player);
  const chosen: GamePlayer[] = [];
  for (const ref of input.playerIds ?? []) {
    const pick = pickPlayerAmong(state, pool, ref, "유스 후보");
    if (!pick.ok) return pick;
    if (!chosen.some((p) => p.id === pick.player.id)) chosen.push(pick.player);
  }

  const {
    signed: joined,
    filled,
    released,
    turnedAway,
  } = signYouthCandidates(
    state,
    chosen.map((p) => p.id),
  );
  const names = (players: readonly GamePlayer[]) => briefNames(players.map((p) => p.name));
  /** 돌려보낸 아이가 어디에 섰나 — 명부의 자리는 상한이 있다 (transfer.md §6) */
  const freeAgentNote =
    turnedAway > 0 ? `무소속 ${released.length}명 · 하부 리그 ${turnedAway}명` : "무소속 명부";

  if (joined.length === 0 && filled.length === 0) {
    return {
      ok: true,
      message:
        `유스 후보 ${rows.length}명을 전원 돌려보냈습니다 — 이번 여름 아카데미에서 올라오는 선수는 없습니다` +
        (released.length > 0 ? ` (${released.length}명은 무소속 명부에 섰습니다)` : ""),
      brief: {
        head: "유스 인테이크",
        items: [item({ label: "방출", text: `${rows.length}명`, note: freeAgentNote })],
      },
    };
  }

  const items = [item({ label: "계약", text: names([...joined, ...filled]) })];
  if (filled.length > 0) {
    items.push(
      item({
        label: "구단 보충",
        text: names(filled),
        note: "포지션군 최소 인원이 무너져 구단이 채웠습니다",
      }),
    );
  }
  const letGo = released.length + turnedAway;
  if (letGo > 0) items.push(item({ label: "방출", text: `${letGo}명`, note: freeAgentNote }));
  return {
    ok: true,
    message:
      `${names([...joined, ...filled])} — 첫 프로 계약을 맺고 2군 개발 스쿼드에 들어왔습니다` +
      (filled.length > 0
        ? ` (${josa(names(filled), "은/는")} 포지션군 최소 인원이 무너져 구단이 함께 올렸습니다)`
        : "") +
      (letGo > 0
        ? ` · 나머지 ${letGo}명은 돌려보냈습니다` +
          (released.length > 0 ? ` (${released.length}명은 무소속 명부에 섰습니다)` : "")
        : ""),
    brief: { head: "유스 인테이크", items },
  };
}
