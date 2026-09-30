import {
  BOARD_REQUEST_LABEL,
  type BoardRequest,
  boardRequestAmountText,
  josa,
} from "@story-fm/domain";
import { item } from "../commands/brief";
import { type CommandResult } from "../commands/result";
import { addDays, diffDays } from "../core/dates";
import { type GameState, managedTeamId, pushNarrative } from "../core/state";
import {
  BOARD_REQUEST,
  type RequestBoardInput,
  buildingStadium,
  describeAsk,
  openBoardRequest,
} from "./board-request";

/**
 * `request_board` — 감독이 보드에 건다. **접수만 한다.**
 *
 * 물은 자리에서 답이 나오면 보드가 사람이 아니라 자판기가 된다. 판정은 답이
 * 도착하는 날의 tick이 그날의 장부로 한다 (`tickBoardRequests`).
 */
export function requestBoard(state: GameState, input: RequestBoardInput): CommandResult {
  if (managedTeamId(state) === null) {
    return { ok: false, message: "커리어가 끝났습니다 — 요청을 걸 보드가 없습니다" };
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

  const building = buildingStadium(state);
  if (building?.deliversOn) {
    return {
      ok: false,
      message: `공사가 진행 중입니다 — ${building.granted ?? 0}석이 ${building.deliversOn}에 섭니다`,
    };
  }

  const requests = state.boardRequests;
  const respondOn = addDays(state.date, BOARD_REQUEST.RESPOND_DAYS[input.kind]);
  const request: BoardRequest = {
    id: `board-request-${state.date}-${input.kind}`,
    kind: input.kind,
    askedOn: state.date,
    respondOn,
    amount,
    status: "pending",
  };
  requests.push(request);

  const line = `보드 요청 — ${describeAsk(request)} · 답 ${respondOn}`;
  pushNarrative(state, line, 3);
  // 보드에 요청을 건 것이 구단주에게 걸린 실마리를 닫는다 (career.md §1)
  return {
    ok: true,
    message: `${line}. 보드가 검토합니다 — 답은 ${respondOn}에 옵니다`,
    brief: {
      head: "보드 요청",
      items: [
        item({
          label: BOARD_REQUEST_LABEL[input.kind],
          text: boardRequestAmountText(request.kind, request.amount),
        }),
        item({ label: "답", text: respondOn }),
      ],
    },
  };
}
