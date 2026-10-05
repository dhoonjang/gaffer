import { item, type CommandResult } from "../core/command-result";
import {
  RequestBoardInputSchema,
  boardRequestAmountText,
  BOARD_REQUEST_LABEL,
  BOARD_CONDITION_LABEL,
  boardConditionAmountText,
  type BoardRequest,
  type RequestBoardInput,
} from "@story-fm/domain";
import { type GameState, managedTeamId } from "../core/state";
import { boardExecutionError, describeAsk, tickBoardRequests } from "./board-request";

/** Record the manager's request or the GM's explicit board decision. */
export function requestBoard(state: GameState, input: RequestBoardInput): CommandResult {
  const parsed = RequestBoardInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "요청의 값과 날짜를 확인해야 합니다" };
  input = parsed.data;
  if (
    managedTeamId(state) === null ||
    !state.manager.contract ||
    state.manager.contract.until < state.date
  )
    return { ok: false, message: "요청할 구단의 감독이 아닙니다" };
  const existing = input.requestId
    ? state.boardRequests.find((r) => r.id === input.requestId)
    : undefined;
  if (input.requestId && !existing) return { ok: false, message: "요청을 찾을 수 없습니다" };
  if (existing && existing.teamId !== state.userTeamId)
    return { ok: false, message: "현재 맡은 구단의 요청만 결정할 수 있습니다" };
  if (existing && (existing.status === "approved" || existing.status === "rejected"))
    return { ok: false, message: "이미 끝난 요청입니다" };
  if (existing && (existing.kind !== input.kind || existing.amount !== input.amount))
    return { ok: false, message: "원래 요청의 종류와 금액을 유지해야 합니다" };
  const respondOn = input.respondOn ?? state.date;
  if (respondOn < state.date) return { ok: false, message: "응답 날짜를 소급할 수 없습니다" };
  if (
    input.decision &&
    !state.personas.some((p) => p.role === "owner" && p.characterId === input.authorizedBy)
  )
    return { ok: false, message: "현재 구단주의 승인이 필요합니다" };
  if (
    input.decision === "conditional" &&
    (!input.condition ||
      input.condition.since < state.date ||
      input.condition.until < input.condition.since ||
      input.condition.until < respondOn)
  )
    return { ok: false, message: "조건과 유효한 이행 기간이 필요합니다" };
  const request: BoardRequest = {
    teamId: state.userTeamId,
    id: existing?.id ?? `board-request-${state.date}-${state.boardRequests.length + 1}`,
    kind: input.kind,
    amount: input.amount,
    askedOn: existing?.askedOn ?? state.date,
    respondOn,
    status: "pending",
    ...(input.decision
      ? {
          decision: input.decision,
          authorizedBy: input.authorizedBy,
          granted: input.decision === "rejected" ? 0 : (input.granted ?? input.amount),
          condition: input.condition,
          deliversOn: input.deliversOn,
        }
      : {}),
  };
  if (input.decision && input.decision !== "rejected") {
    if ((request.granted ?? 0) > request.amount)
      return { ok: false, message: "승인량이 요청량보다 큽니다" };
    if (request.kind === "stadium" && (!request.deliversOn || request.deliversOn <= respondOn))
      return { ok: false, message: "착공 이후의 준공일이 필요합니다" };
    if (input.decision === "approved" && respondOn === state.date) {
      const error = boardExecutionError(state, request);
      if (error) return { ok: false, message: error };
    }
  }
  if (existing) state.boardRequests[state.boardRequests.indexOf(existing)] = request;
  else state.boardRequests.push(request);
  const digest: string[] = [];
  tickBoardRequests(state, digest);
  return {
    ok: true,
    brief: {
      head: "보드 재정 요청·결정",
      items: [
        item({
          label: BOARD_REQUEST_LABEL[request.kind],
          text: boardRequestAmountText(request.kind, request.amount),
          note: request.id,
        }),
        item({ label: "상태", text: request.status }),
        item({ label: "응답일", text: request.respondOn }),
        ...(request.granted === undefined
          ? []
          : [
              item({
                label: request.status === "approved" ? "승인량" : "결정량",
                text: boardRequestAmountText(request.kind, request.granted),
              }),
            ]),
        ...(request.condition
          ? [
              item({
                label: BOARD_CONDITION_LABEL[request.condition.kind],
                text: boardConditionAmountText(request.condition),
                note: `${request.condition.since} ~ ${request.condition.until}`,
              }),
            ]
          : []),
        ...(request.deliversOn ? [item({ label: "준공일", text: request.deliversOn })] : []),
      ],
    },
    message: `${request.id} · ${describeAsk(state, request)} · ${request.status} · 응답 ${respondOn}${digest.length ? `\n${digest.join("\n")}` : ""}`,
  };
}
