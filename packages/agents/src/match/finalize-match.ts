import {
  RATING_MIN,
  RATING_MAX,
  RATING_BAND,
  MATCH_FAMILIARITY_MIN,
  MATCH_FAMILIARITY_MAX,
  MATCH_ATTR_CAP,
  ATTR_STEP_MAX,
  ATTR_STEP_MIN,
  MOOD_BATCH,
  MOOD_NOTE_MAX,
  type MatchRatingBrief,
  type GameState,
  settleMatchRating,
  applyMoodNotes,
  matchRated,
} from "@story-fm/engine";
import { josa, ATTRIBUTE_AXES } from "@story-fm/domain";
import { agingDeclineLine } from "../common/aging-line";
import { z } from "zod";
import { toToolSchema } from "../common/tool-schema";
import { TURN_EXCERPT_CHARS } from "../common/context";
import { ModelOutputError, retryOnce, readOutput, anchorStands } from "../common/retry";
import { type GameLLM, resolveLlmMode, createGameLLM, agentConfig } from "@story-fm/llm";

/**
 * 경기 마감 — **매치 GM의 `finalize_match` 도구 뒤에서 도는 에이전트** (agents.md §3
 * 「경기 마감」). 이 경기의 중계 전부(`<commentary>`)와 기준 평점 표(`<settlement>`)를
 * 읽고, 결산(평점·적응도·능력치·심경)을 **JSON 하나로** 낸다 — 도구 없이
 * 출력 스키마로 받는다 (models.md §3-2). 앵커는 코어가 `finalizeMatch`로 먼저 박아 두고
 * 한도로 자른다 — 실패하면 앵커가 남는다. 마무리 중계는 매치 GM이 쓴다.
 */
export const FINALIZE_MATCH_SYSTEM = `당신은 방금 끝난 축구 경기를 결산하는 분석가다.

# 입력
- <commentary> — 이 경기의 중계 전부. 흐름·라커룸·벤치의 말이 여기 있다.
- <settlement> — 출전 선수의 기준 평점 표. 결산의 입력이다.

# 산출
결산을 JSON 하나로 낸다 — ratings · moods.

# 결산
출전한 선수 전원의 경기 결산을 한 번에 낸다 — 평점과 한 줄 근거, 전술 적응도, 능력치, 심경.
- 기록(골·도움·슛·선방·카드)은 이미 기준 평점에 반영돼 있다. 더할 것은 기록에 안 남는 것이다 — 중계가 그린 지배력, 위기 관리, 실점 장면에서의 책임, 교체 투입 후의 영향, 짧게 뛰고도 흐름을 바꾼 순간.
- 출전 시간을 감안한다. 15분 뛴 교체 선수를 90분 뛴 선수와 같은 잣대로 재지 않는다. 자리를 감안한다. 수비수의 무실점과 공격수의 무득점은 같은 무게가 아니다. 팀 결과에 휩쓸리지 않는다.
- rating — ${RATING_MIN}~${RATING_MAX}, 기준 평점에서 ±${josa(String(RATING_BAND), "을/를")} 넘지 않는다. note는 한 문장 40자 안팎 — “무난했다” 같은 빈 말 대신 그 경기의 사실을 적는다.
- drill — 이 경기로 전술 적응도가 얼마나 올랐는가, ${MATCH_FAMILIARITY_MIN}~${MATCH_FAMILIARITY_MAX}. 빠뜨린 선수는 변화가 없는 것으로 본다.
- attribute · attributeStep — 이 경기로 한 축이 움직인 선수만, 0~${MATCH_ATTR_CAP}명, 각 한 축 +${ATTR_STEP_MAX} 또는 −${-ATTR_STEP_MIN}. ${agingDeclineLine()}
- moods — 그 경기가 남긴 심경 한 문장(60자 안팎), ${MOOD_BATCH}명까지. 불만이 걸린 선수는 그 사실을 문장에 담고 acknowledgesIssue를 true로 적는다. 수치(평점·체력·퍼센트)는 문장에 적지 않는다.
- 선수 id는 표의 것을 그대로 돌려준다.`;

/**
 * 스키마가 받아들이는 폭 — 코어 밴드(`RATING_MIN`~`RATING_MAX`,
 * `MATCH_FAMILIARITY_MIN`~`MATCH_FAMILIARITY_MAX`)보다 넓게 열어 둔다.
 * 벗어난 값은 파싱을 깨뜨리는 대신 코어가 자르므로(`settleMatchRating`),
 * 한 선수의 과한 숫자 하나로 경기 결산 전체가 버려지지 않는다.
 */
const ACCEPTED_RATING_MAX = 20;

const ACCEPTED_DRILL_BOUND = 20;

/** 한 번에 매기는 인원 상한 — 한 경기 명단(선발 + 벤치)보다 넉넉하다 */
const MAX_RATED_PLAYERS = 30;

/** 근거 한 줄의 길이 상한 — 설명은 40자 안팎을 요구하고, 여기는 그 여유다 */
const NOTE_MAX = 200;

const RatingEntrySchema = z.object({
  playerId: z.string().min(1).describe("<settlement> 표의 id 그대로"),
  rating: z
    .number()
    .min(0)
    .max(ACCEPTED_RATING_MAX)
    .describe(`${RATING_MIN}~${RATING_MAX}, 소수 첫째 자리. 기준 평점 ±${RATING_BAND} 안`),
  drill: z
    .number()
    .min(-ACCEPTED_DRILL_BOUND)
    .max(ACCEPTED_DRILL_BOUND)
    .optional()
    .describe(`전술 적응도 변화 — ${MATCH_FAMILIARITY_MIN}~${MATCH_FAMILIARITY_MAX}`),
  attribute: z
    .enum(ATTRIBUTE_AXES)
    .nullish()
    .describe(`움직일 능력치 축 (${MATCH_ATTR_CAP}명까지)`),
  attributeStep: z
    .number()
    .min(ATTR_STEP_MIN)
    .max(ATTR_STEP_MAX)
    .nullish()
    .describe(`그 축의 방향 — ${ATTR_STEP_MAX} 또는 ${ATTR_STEP_MIN}`),
  note: z.string().max(NOTE_MAX).optional().describe("한 문장 근거 (40자 안팎)"),
});

const MoodEntrySchema = z.object({
  playerId: z.string().min(1).describe("<settlement> 표의 id 그대로"),
  text: z.string().min(1).max(MOOD_NOTE_MAX).describe("그 선수의 심경 한 문장 (60자 안팎)"),
  /** 그 문장이 불만을 담았는가 — 코어는 낱말을 세지 않는다 (people.md §5) */
  acknowledgesIssue: z.boolean().optional().describe("그 문장이 이 선수의 불만을 담았는가"),
});

/** 이 호출의 산출 — 결산 없는 산출은 없다. */
export const SettleMatchSchema = z.object({
  ratings: z.array(RatingEntrySchema).min(1).max(MAX_RATED_PLAYERS),
  moods: z.array(MoodEntrySchema).max(MOOD_BATCH).optional(),
});

export type SettleMatchArgs = z.infer<typeof SettleMatchSchema>;

/** 모델이 보는 출력 스키마 — 위 Zod 한 벌에서 파생한다 (prompts.md §2) */
export const SETTLE_MATCH_INPUT = toToolSchema(SettleMatchSchema);

/**
 * 결산 표 — 기준 평점과 기록, 그리고 장부의 사건 줄. 중계는 `<commentary>`가 갖지만
 * 마지막 구간은 아직 중계되기 전에 마감이 불리므로(GM이 도구 뒤에 쓴다) 사건 줄이
 * 그 빈자리를 메운다.
 */
export function buildSettlementMessage(brief: MatchRatingBrief): string {
  const outcome = { win: "승", draw: "무", loss: "패" }[brief.outcome];
  const rows = brief.players.map((p) => {
    const line = [
      `${p.playerId} | ${p.name} | ${p.position}`,
      p.started ? "선발" : "교체",
      `${p.minutes}분`,
      `기준 평점 ${p.anchor.toFixed(1)}`,
      `${p.age ?? "?"}세 · 성장 여지 ${p.room ?? 0} · 전술적응 ${p.familiarity ?? 0}`,
    ];
    const did: string[] = [];
    if (p.goals > 0) did.push(`${p.goals}골`);
    if (p.assists > 0) did.push(`${p.assists}도움`);
    if (p.shots > 0) did.push(`슛${p.shots}`);
    if (p.saves > 0) did.push(`선방${p.saves}`);
    if (p.yellows > 0) did.push(`경고${p.yellows}`);
    if (p.reds > 0) did.push("퇴장");
    line.push(did.length > 0 ? did.join(" ") : "기록 없음");
    return `- ${line.join(" | ")}`;
  });
  return [
    "<settlement>",
    `최종 스코어: ${brief.scoreline} (우리 팀 ${outcome})`,
    "사건:",
    ...(brief.timeline.length > 0 ? brief.timeline : ["(기록된 사건 없음)"]),
    "채점 대상 (id | 이름 | 자리 | 선발/교체 | 출전시간 | 기준 평점 | 나이·성장 여지·전술적응 | 기록)",
    ...rows,
    "</settlement>",
  ].join("\n");
}

/**
 * 이 경기의 중계 전부 — 저장된 경기 턴의 본문이다. 마감 에이전트가 읽는 흐름의 원본이고,
 * 한 턴이 `TURN_EXCERPT_CHARS`를 넘으면 앞머리만 싣는다 (결산에 필요한 것은 장면의 요지다).
 */

export function buildCommentaryBlock(state: GameState, matchId: string): string {
  const lines = state.chat
    .filter(
      (t) =>
        t.inMatch === true &&
        t.role === "model" &&
        (t.matchId === undefined || t.matchId === matchId),
    )
    .map((t) => t.text.slice(0, TURN_EXCERPT_CHARS));
  return ["<commentary>", ...(lines.length > 0 ? lines : ["(중계가 없다)"]), "</commentary>"].join(
    "\n",
  );
}

/**
 * 결산을 장부에 옮긴다 — 평점·적응도·능력치는 `settleMatchRating`이 한 표식 아래 한 번만
 * 받고, 심경은 출전 선수로 좁혀 `applyMoodNotes`가 검사한다 (agents.md §4-3). 반영한 평점
 * 수를 돌려준다.
 *
 * 표의 id를 하나도 맞추지 못한 산출은 **쓸 수 없는 산출**이다 — 다시 부르면 달라질 수
 * 있으므로 `ModelOutputError`로 세워 한 번의 재시도를 탄다 (agents.md §8).
 */
export function applySettlement(
  state: GameState,
  brief: MatchRatingBrief,
  data: SettleMatchArgs,
): number {
  const allowed = new Set(brief.players.map((p) => p.playerId));
  const { applied, already } = settleMatchRating(state, brief.matchId, data.ratings);
  // 이미 반영된 경기 — 코어가 두 번째를 막았고, 다시 쌓을 것도 없다
  if (already) return 0;
  if (applied === 0) {
    throw new ModelOutputError("반영된 평점이 없습니다 — 표의 id를 그대로 쓰세요");
  }
  applyMoodNotes(state, data.moods ?? [], allowed);
  return applied;
}

/** 마감 에이전트가 돌려주는 것 — 반영한 인원 */
export interface FinalizeOutcome {
  settled: number;
}

/**
 * 결산 — `finalizeMatch` **뒤에** 부른다(앵커가 이미 박혀 있어야 한다).
 * 한 번 다시 시도하되 **실패는 삼킨다** — 결산 하나 때문에 경기 결과가 막히면 안 된다.
 */
export async function runFinalizeMatch(
  state: GameState,
  brief: MatchRatingBrief,
  llm?: GameLLM,
): Promise<FinalizeOutcome> {
  if (brief.players.length === 0) return { settled: 0 };
  // mock 모드에는 부를 모델이 없다 — 앵커가 그대로 남는다 (agents.md §8)
  if (llm === undefined && resolveLlmMode() === "mock") return { settled: 0 };
  let settled = 0;
  let client = llm;
  await retryOnce(
    "finalize:match",
    async () => {
      client ??= createGameLLM(agentConfig("finalize-match"));
      const result = await client.runTurn({
        system: FINALIZE_MATCH_SYSTEM,
        history: [],
        user: [buildCommentaryBlock(state, brief.matchId), ``, buildSettlementMessage(brief)].join(
          "\n",
        ),
        // 산출은 결산이 든 JSON 하나다 — 도구 왕복이 없다 (models.md §3-2)
        outputSchema: SETTLE_MATCH_INPUT,
      });
      const data = readOutput("finalize:match", SettleMatchSchema, result);
      settled = applySettlement(state, brief, data);
    },
    // 장부에 표식이 섰으면 다시 부르지 않는다 — 두 번째 호출은 결산을 두 번 쌓는다
    () => matchRated(state, brief.matchId),
  ).catch(anchorStands("finalize:match"));
  return { settled };
}
