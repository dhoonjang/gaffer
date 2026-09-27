import { BOARD_REQUEST_LABEL, type BoardRequest, josa } from "@story-fm/domain";
import { item } from "../../../../common/commands/brief";
import { type CommandResult } from "../../../../common/commands/result";
import { addDays, diffDays } from "../../../../common/core/dates";
import { pickRivalPlayer } from "../../../../common/core/player-ref";
import { type GameState, managedTeamId, pushNarrative } from "../../../../common/core/state";
import {
  BOARD_REQUEST,
  type RequestBoardInput,
  askText,
  buildingStadium,
  describeAsk,
  openBoardRequest,
} from "../../../../negotiation/finance/board-request";

/**
 * `request_board` — 감독이 보드에 건다. **접수만 한다.**
 *
 * 물은 자리에서 답이 나오면 보드가 사람이 아니라 자판기가 된다. 판정은 답이
 * 도착하는 날의 tick이 그날의 장부로 한다 (`tickBoardRequests`).
 */
export function requestBoard(state: GameState, input: RequestBoardInput): CommandResult {
  if (managedTeamId(state) === null) {
    return { ok: false, message: "무직입니다 — 요청을 걸 보드가 없습니다" };
  }
  const amount = Math.floor(input.amount);
  if (amount <= 0) return { ok: false, message: "요청할 값이 0입니다" };

  const open = openBoardRequest(state);
  if (open) {
    return {
      ok: false,
      message: `이미 보드의 답을 기다리는 요청이 있습니다 — ${BOARD_REQUEST_LABEL[open.kind]} (${open.respondOn}에 답이 옵니다)`,
    };
  }

  const last = [...state.boardRequests]
    .reverse()
    .find((r) => r.kind === input.kind && r.resolvedOn !== undefined);
  if (last?.resolvedOn) {
    const left = BOARD_REQUEST.COOLDOWN_DAYS - diffDays(last.resolvedOn, state.date);
    if (left > 0) {
      return {
        ok: false,
        message: `${josa(BOARD_REQUEST_LABEL[input.kind], "은/는")} ${last.resolvedOn}에 답을 받았습니다 — 같은 안건은 ${left}일 뒤에 다시 걸 수 있습니다`,
      };
    }
  }

  if (input.kind === "stadium") {
    const building = buildingStadium(state);
    if (building?.deliversOn) {
      return {
        ok: false,
        message: `공사가 진행 중입니다 — ${building.granted ?? 0}석이 ${building.deliversOn}에 섭니다`,
      };
    }
  }

  /**
   * **`signing`은 이름 하나를 지목한다.** 감독이 부른 이름을 여기서 id로 옮긴다 —
   * 갈리면 후보를 돌려 GM이 되묻는다 (`core/player-ref.ts`). 우리 선수를 두고
   * 영입 승인을 물을 자리는 없다.
   */
  let playerId: string | undefined;
  if (input.kind === "signing") {
    if (!input.playerId) {
      return { ok: false, message: "영입 승인은 어느 선수인지 함께 말해야 합니다" };
    }
    const picked = pickRivalPlayer(state, input.playerId);
    if (!picked.ok) return { ok: false, message: picked.message };
    playerId = picked.player.id;
  }

  const requests = state.boardRequests;
  const respondOn = addDays(state.date, BOARD_REQUEST.RESPOND_DAYS[input.kind]);
  const request: BoardRequest = {
    id: `board-request-${state.date}-${input.kind}`,
    kind: input.kind,
    askedOn: state.date,
    respondOn,
    amount,
    ...(playerId !== undefined ? { playerId } : {}),
    status: "pending",
  };
  requests.push(request);

  const line = `보드 요청 — ${describeAsk(state, request)} · 답 ${respondOn}`;
  pushNarrative(state, line, 3);
  // 보드에 요청을 건 것이 구단주에게 걸린 실마리를 닫는다 (career.md §1)
  return {
    ok: true,
    message: `${line}. 보드가 검토합니다 — 답은 ${respondOn}에 옵니다`,
    brief: {
      head: "보드 요청",
      items: [
        item({ label: BOARD_REQUEST_LABEL[input.kind], text: askText(state, request) }),
        item({ label: "답", text: respondOn }),
      ],
    },
  };
}
