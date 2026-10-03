import { lorebookText } from "@story-fm/domain";
import {
  type GameState,
  headCoachOf,
  selectLorebook,
  stampLorebook,
  humanizePlayerIds,
  formatClock,
  clockOf,
} from "@story-fm/engine";
import { parseSceneHeader, sanitizeSceneText } from "../../../common/context";
import {
  buildClubBlock,
  ONBOARDING_JUDGE_SYSTEM,
  REPORT_ONBOARDING_INPUT,
  ReportInputSchema,
} from "../../../story/onboarding-judge";
import { buildGmStateNote } from "../../gm-input";
import { type GameLLM, resolveLlmMode, createGameLLM, agentConfig } from "@story-fm/llm";
import { type GmTurnResult } from "../../../common/gm-types";
import { buildOnboardingTurn } from "../../mock-gm";
import { retryOnce, ModelOutputError, readOutput } from "../../../common/retry";

/**
 * 첫 장면 검사 — 문법과 화자(수석코치 등장·감독 미발화)까지만 본다. 내용은 보지 않는다.
 */
export function isValidOnboardingText(state: GameState, text: string): boolean {
  // 첫 줄의 시점 헤더는 문법의 일부다 — 본문만 떼어 검사한다
  const lines = parseSceneHeader(text)
    .body.split("\n")
    .filter((line) => line.trim().length > 0);
  return (
    lines.length >= 1 &&
    // 장면은 `@`로 연다 — 그 뒤의 태그 없는 줄은 이어쓰기다 (prompts.md §1)
    (lines[0] ?? "").startsWith("@") &&
    // 감독은 유저의 몫이다 — GM이 대신 말하면 첫 턴부터 규약이 깨진다
    !lines.some((line) => line.startsWith(`@${state.manager.name}:`))
  );
}

/**
 * 프롬프트 본문 — 구단 · 배경 · 수석코치 카드 · 스냅샷.
 *
 * ⚠️ **수석코치의 카드는 지목으로 세운다.** 이력도 지난 발화도 없어 키워드가 걸릴 문장
 * 자체가 없다 — 검증(`isValidOnboardingText`)이 요구하는 그 id가 프롬프트에 실리는
 * 자리가 여기뿐이다. 카드가 내려가면 모델은 직책으로 태그를 달고 첫 장면이 매번 반려된다.
 *
 * 스냅샷은 첫 장면이 짚을 사실(소집일·일정·몸 상태)을 갖는다. `<openings>`는 아직 비어
 * 있다 — 이 호출이 그것을 **정하는** 자리라, 장면의 재료는 스냅샷이 아니라 방금 부른
 * 도구의 인자다.
 */
export function buildOnboardingJudgePrompt(state: GameState, background: string): string {
  const coach = lorebookText(
    stampLorebook(state, selectLorebook(state.lorebook, headCoachOf(state).name, [])),
  );
  return [
    buildClubBlock(state),
    `<background>`,
    background,
    `</background>`,
    ...(coach ? [coach] : []),
    buildGmStateNote(state),
  ].join("\n");
}

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

  // 첫 장면은 시계를 옮기지 않는다 — 헤더가 없으면 세워 준다
  const stamped = parseSceneHeader(turn.text).point
    ? turn.text
    : `[${state.date} ${formatClock(clockOf(state))}]\n${turn.text}`;
  return { text: stamped, toolCalls: [], usage: turn.usage };
}
