import { describe, expect, it } from "vitest";
import type { EvaluationRequest, GameEvaluator } from "@story-fm/llm";
import {
  requestScouting,
  processScoutingReports,
} from "../../src/app/workflows/negotiation/scouting";
import { createTestGame } from "../../../engine/test/helpers";
import { captureScoutingEvidence, addDays } from "@story-fm/engine";

function evaluator(): GameEvaluator & { requests: EvaluationRequest[] } {
  const requests: EvaluationRequest[] = [];
  return {
    requests,
    async evaluate(request) {
      requests.push(request);
      return {
        model: "mock",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([key, q]) => {
            if (q.type !== "choice") throw new Error("Unexpected question");
            let choice = Object.keys(q.criteria)[0]!;
            if (key === "status") choice = "ready";
            if (key === "depth") choice = "match_review";
            if (key.startsWith("precision_")) choice = "broad";
            if (key.startsWith("focus_")) choice = "yes";
            if (
              key.startsWith("limit_") ||
              key.startsWith("strength_") ||
              key.startsWith("concern_")
            )
              choice = "no";
            if (key.startsWith("fit_")) choice = "unknown";
            if (key.startsWith("source_")) choice = "none";
            if (key === "value")
              choice = Object.entries(q.criteria).find(([, value]) => {
                const [low, high] = String(value).split(" to ").map(Number);
                return 3 >= low! && 3 <= (high ?? low!);
              })![0];
            return [
              key,
              {
                type: "choice",
                choice,
                confidence: 1,
                probabilities: Object.fromEntries(
                  Object.keys(q.criteria).map((v) => [v, v === choice ? 1 : 0]),
                ),
              },
            ];
          }),
        ),
      };
    },
  };
}

describe("Jev scouting orchestration", () => {
  it("uses evaluated duration, preserves uncertainty, and reuses the stored report", async () => {
    const state = createTestGame(11);
    const player = state.players.find((p) => p.teamId !== state.userTeamId)!;
    const client = evaluator();
    const created = await requestScouting(
      state,
      { action: "request", question: "이 선수의 성장 가능성을 조사해줘", playerIds: [player.id] },
      "이 선수의 성장 가능성을 조사해줘",
      client,
    );
    expect(created.ok).toBe(true);
    expect(state.scoutingRequests[0]!.dueOn).toBe(addDays(state.date, 3));
    expect(state.scoutReports).toHaveLength(0);
    state.date = addDays(state.date, 3);
    captureScoutingEvidence(state);
    const reports = await processScoutingReports(state, client);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.candidates[0]!.assessment.potential).toBeNull();
    expect(reports[0]!.plan.expectations).toContainEqual({
      topic: "development",
      precision: "broad",
    });
    const count = client.requests.length;
    expect(await processScoutingReports(state, client)).toEqual([]);
    expect(client.requests).toHaveLength(count);
    const input = client.requests.map((r) => r.state).join("\n");
    expect(input).not.toContain('"attributes"');
    expect(input).not.toContain('"injuryProneness"');
  });
  it("holds a plan outside the manager's deadline instead of silently changing the scope", async () => {
    const state = createTestGame(11);
    const player = state.players.find((p) => p.teamId !== state.userTeamId)!;
    await requestScouting(
      state,
      {
        action: "request",
        question: "오늘 확인해줘",
        playerIds: [player.id],
        deadline: state.date,
      },
      "오늘 확인해줘",
      evaluator(),
    );
    expect(state.scoutingRequests[0]!.status).toBe("held");
    expect(state.scoutingRequests[0]!.dueOn).toBeNull();
    expect(state.scoutReports).toHaveLength(0);
  });
  it("does not retry a failed duplicate request without an explicit retry action", async () => {
    const state = createTestGame(11);
    const player = state.players.find((p) => p.teamId !== state.userTeamId)!;
    const input = { action: "request" as const, question: "조사 계획", playerIds: [player.id] };
    await requestScouting(state, input, "알아봐", {
      evaluate: async () => {
        throw new Error("offline");
      },
    });
    const client = evaluator();
    const duplicate = await requestScouting(state, input, "알아봐", client);
    expect(duplicate.ok).toBe(false);
    expect(client.requests).toHaveLength(0);
    expect(state.scoutingRequests).toHaveLength(1);
  });
  it("retains failed evidence for explicit retry without manufacturing a completed report", async () => {
    const state = createTestGame(11);
    const player = state.players.find((p) => p.teamId !== state.userTeamId)!;
    const client = evaluator();
    await requestScouting(
      state,
      { action: "request", question: "출전 기록", playerIds: [player.id] },
      "알아봐",
      client,
    );
    state.date = addDays(state.date, 3);
    captureScoutingEvidence(state);
    const before = structuredClone(state.scoutingRequests[0]!.evidence);
    expect(
      await processScoutingReports(state, {
        evaluate: async () => {
          throw new Error("offline");
        },
      }),
    ).toEqual([]);
    expect(state.scoutingRequests[0]!.status).toBe("failed");
    expect(state.scoutReports).toHaveLength(0);
    player.name = "이름 변경";
    state.date = addDays(state.date, 5);
    const result = await requestScouting(
      state,
      { action: "retry", requestId: state.scoutingRequests[0]!.id },
      "다시 시도해줘",
      client,
    );
    expect(result.ok).toBe(true);
    expect(state.scoutReports[0]!.candidates[0]!.evidence).toEqual(before[0]);
  });
});
