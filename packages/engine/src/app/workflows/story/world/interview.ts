import { InterviewOutcomeSchema } from "@story-fm/domain";
import {
  pendingManagerInterviews,
  teamNameIn,
  type GameState,
} from "../../../../common/core/state";
import { managerTeam, settleInterview } from "../../../../negotiation/market/manager-market";
import type { CommandResult } from "../../../../common/commands/result";

export function respondToInterview(state: GameState, raw: unknown): CommandResult {
  const parsed = InterviewOutcomeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "유효한 면접 판단이 필요합니다" };
  const input = parsed.data;
  const pending = pendingManagerInterviews(state);
  if (!pending.length) return { ok: false, message: "답할 감독직 면접이 없습니다" };
  const team = input.team === undefined ? undefined : managerTeam(state, input.team);
  if (input.team !== undefined && !team)
    return { ok: false, message: "응답할 구단을 찾지 못했습니다" };
  const matches = pending.filter(
    (interview) =>
      (input.interviewId === undefined || interview.id === input.interviewId) &&
      (team === undefined || interview.teamId === team.id),
  );
  if (!matches.length)
    return { ok: false, message: "지정한 구단과 면접 id에 맞는 열린 면접이 없습니다" };
  if (matches.length > 1)
    return {
      ok: false,
      message: `응답할 interviewId 또는 team을 지정하세요 — ${matches.map((interview) => `${interview.id} (${teamNameIn(state, interview.teamId)})`).join(" · ")}`,
    };
  const interview = matches[0]!;
  const result = settleInterview(state, interview, input);
  if (result.ok) interview.status = "answered";
  return result;
}
