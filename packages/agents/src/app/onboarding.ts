import { type GameState, humanizePlayerIds, clockOf } from "@gaffer/engine";
import { sceneMarker } from "@gaffer/domain";
import { normalizeSuggestion } from "../shared/suggest-reply";
import { parseSceneHeader, sanitizeSceneText } from "../shared/context";
import { type GameLLM, resolveLlmMode, createGameLLM, agentConfig } from "@gaffer/llm";
import { type GmTurnResult } from "../shared/gm-types";
import { buildOnboardingTurn } from "./mock-gm";
import { retryOnce, ModelOutputError, readOutput } from "../shared/retry";
import {
  ONBOARDING_JUDGE_SYSTEM,
  ReportInputSchema,
  REPORT_ONBOARDING_INPUT,
  isValidOnboardingText,
  buildOnboardingJudgePrompt,
} from "../gm/onboarding-judge";

export async function runOnboarding(
  state: GameState,
  background: string,
  llm?: GameLLM,
): Promise<GmTurnResult> {
  // mock은 정해진 첫 장면으로 시작한다 (agents.md §4-2).
  if (resolveLlmMode() === "mock") {
    return buildOnboardingTurn(state);
  }

  let client = llm;
  const turn = await retryOnce("onboarding", async () => {
    client ??= createGameLLM(agentConfig("onboarding-judge"));
    const result = await client.runTurn({
      system: ONBOARDING_JUDGE_SYSTEM,
      history: [],
      user: buildOnboardingJudgePrompt(state, background),
      // 판정과 첫 장면이 JSON 하나다 — 도구 왕복이 없다 (models.md §3-2)
      outputSchema: REPORT_ONBOARDING_INPUT,
      // ⚠️ maxTokens를 좁히지 않는다 — 상한은 사고(thinking)+본문 합산이라
      // 장면 길이만 보고 잡으면 본문이 문장 한복판에서 잘린다
    });
    // 상한에 걸린 응답은 JSON이 끊겨 있다 — 산출이 없는 것과 같은 실패지만 이유를 남긴다
    if (result.stopReason === "truncated") {
      throw new ModelOutputError("첫 장면이 출력 상한에 걸려 문장이 잘렸습니다");
    }
    const report = readOutput("onboarding", ReportInputSchema, result);
    const text = humanizePlayerIds(state, sanitizeSceneText(report.scene).trim());
    if (!isValidOnboardingText(state, text)) {
      throw new ModelOutputError(`첫 장면이 출력 문법을 어겼습니다:\n${text}`);
    }
    return { report, text, usage: result.usage };
  });

  // 첫 장면은 시계를 옮기지 않는다 — 표식이 없으면 세워 준다
  const stamped = parseSceneHeader(turn.text).point
    ? turn.text
    : `${sceneMarker({ date: state.date, time: clockOf(state) })}\n${turn.text}`;
  const suggestion = normalizeSuggestion(turn.report.suggestion);
  return {
    text: stamped,
    toolCalls: [],
    usage: turn.usage,
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}
