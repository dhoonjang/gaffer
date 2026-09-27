import { type GameState, managedTeamId, pushNarrative } from "../../../../common/core/state";
import { type BoardReview, BoardReviewSchema } from "@story-fm/domain";
import { diffDays } from "../../../../common/core/dates";
import { RENEWAL_NOTICE_DAYS } from "../../../../negotiation/market/manager-market";
import { type CommandResult } from "../../../../common/commands/result";
import { applySocialReaction } from "../../../../story/world/social";
import { BOARD_REVIEW_BAND } from "../../../../story/world/social";
import { decideManagerRenewal, dismissUserManager } from "../../negotiation/market/manager-market";

/** 보드의 판단을 기록한다. 고용 해지는 기존 계약 정산 경로만 사용한다. */
export function reviewBoard(state: GameState, input: BoardReview): CommandResult {
  const parsed = BoardReviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "유효한 보드 평가가 필요합니다" };
  const teamId = managedTeamId(state);
  if (!teamId || !state.manager.contract || state.boardAgenda.teamId !== teamId) {
    return { ok: false, message: "현재 맡은 구단의 보드만 평가할 수 있습니다" };
  }
  const review = parsed.data;
  const agenda = state.boardAgenda;
  const record =
    review.season === undefined
      ? undefined
      : state.seasonRecords.find((r) => r.season === review.season && r.teamId === teamId);
  if (review.season !== undefined && !record)
    return { ok: false, message: "이 구단에서 완료한 시즌만 평가할 수 있습니다" };
  if (review.decision === "dismiss" && (!agenda.warningOn || agenda.warningOn >= state.date))
    return { ok: false, message: "경질에는 이전 날짜의 경고가 필요합니다" };

  if (
    review.renewal !== undefined &&
    (review.decision === "dismiss" ||
      state.manager.contract.renewalDecidedOn ||
      state.date > state.manager.contract.until ||
      diffDays(state.date, state.manager.contract.until) > RENEWAL_NOTICE_DAYS)
  )
    return { ok: false, message: "재계약 판단은 만료 전 90일 안에 한 번만 가능합니다" };

  if (review.expectations) agenda.expectations = [...new Set(review.expectations)];
  agenda.assessment = review.assessment;
  agenda.reviewedOn = state.date;
  if (record) {
    record.board.assessment = review.assessment;
    record.board.reviewedOn = state.date;
  }
  if (review.decision === "warning") agenda.warningOn ??= state.date;
  else if (review.decision === "continue") delete agenda.warningOn;
  const effect = applySocialReaction(state, {
    reaction: { reason: review.assessment.slice(0, 280), board: review.confidence },
    band: BOARD_REVIEW_BAND,
    axes: ["board"],
  });
  if (review.decision === "dismiss") {
    const digest: string[] = [];
    dismissUserManager(state, digest);
    return { ok: true, message: `${digest.join(" · ")} — ${review.assessment}` };
  }
  if (review.renewal !== undefined) decideManagerRenewal(state, review.renewal, []);
  pushNarrative(
    state,
    `보드 ${review.decision === "warning" ? "경고" : "평가"} — ${review.assessment}`,
    review.decision === "warning" ? 4 : 3,
  );
  return {
    ok: true,
    message: `보드 평가 — ${review.assessment} (신뢰 ${effect.board > 0 ? "+" : ""}${effect.board})`,
  };
}
