import { type GameState, humanizePlayerIds, clockOf } from "@gaffer/engine";
import { sceneMarker } from "@gaffer/domain";
import { normalizeSuggestion } from "../shared/suggest-reply";
import { parseSceneHeader, sanitizeSceneText } from "../shared/context";
import {
  type GameLLM,
  resolveLlmMode,
  createGameLLM,
  agentConfig,
  streamOutputField,
} from "@gaffer/llm";
import { type GmTurnResult } from "../shared/gm-types";
import { buildOnboardingTurn } from "./mock-gm";
import { retryOnce, ModelOutputError, readOutput } from "../shared/retry";
import { filterSceneStream } from "../gm/gm-input";
import {
  ONBOARDING_JUDGE_SYSTEM,
  ReportInputSchema,
  REPORT_ONBOARDING_INPUT,
  isValidOnboardingText,
  buildOnboardingJudgePrompt,
} from "../gm/onboarding-judge";

/** 첫 장면이 흐르는 길 */
export interface OnboardingStream {
  onText: (delta: string) => void;
  /** 흘린 장면을 버린다 — 산출이 어긋나 한 번 더 부르기 전에 온다 */
  onReset: () => void;
}

/** 첫 장면은 시계를 옮기지 않는다 — 모델은 표식을 쓰지 않고 코어가 지금을 세운다 */
const openingMarker = (state: GameState): string =>
  sceneMarker({ date: state.date, time: clockOf(state) });

/**
 * 첫 장면을 흐르는 대로 넘긴다 — JSON의 `scene` 칸만 풀어 저장과 같은 체를 지나고, 코어의
 * 표식이 맨 앞에 선다. 선수 id를 이름으로 펴는 것은 저장된 본문이 끝에 화면을 바꾸며 한다.
 */
export function onboardingSceneStream(
  state: GameState,
  emit: (delta: string) => void,
): (delta: string) => void {
  let opened = false;
  return streamOutputField(
    "scene",
    filterSceneStream((delta) => {
      if (!opened) {
        emit(`${openingMarker(state)}\n`);
        opened = true;
      }
      emit(delta);
    }),
  );
}

export async function runOnboarding(
  state: GameState,
  background: string,
  llm?: GameLLM,
  stream?: OnboardingStream,
): Promise<GmTurnResult> {
  // mock은 정해진 첫 장면으로 시작한다 (agents.md §4-2).
  if (resolveLlmMode() === "mock") {
    const turn = buildOnboardingTurn(state);
    stream?.onText(turn.text);
    return turn;
  }

  let client = llm;
  let streamed = false;
  const turn = await retryOnce("onboarding", async () => {
    if (streamed) {
      stream?.onReset();
      streamed = false;
    }
    client ??= createGameLLM(agentConfig("onboarding-judge"));
    const result = await client.runTurn({
      system: ONBOARDING_JUDGE_SYSTEM,
      history: [],
      user: buildOnboardingJudgePrompt(state, background),
      // 판정과 첫 장면이 JSON 하나다 — 도구 왕복이 없다 (models.md §3-2)
      outputSchema: REPORT_ONBOARDING_INPUT,
      // ⚠️ maxTokens를 좁히지 않는다 — 상한은 사고(thinking)+본문 합산이라
      // 장면 길이만 보고 잡으면 본문이 문장 한복판에서 잘린다
      ...(stream
        ? {
            onText: onboardingSceneStream(state, (delta) => {
              streamed = true;
              stream.onText(delta);
            }),
          }
        : {}),
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

  const stamped = parseSceneHeader(turn.text).point
    ? turn.text
    : `${openingMarker(state)}\n${turn.text}`;
  const suggestion = normalizeSuggestion(turn.report.suggestion);
  return {
    text: stamped,
    toolCalls: [],
    usage: turn.usage,
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}
