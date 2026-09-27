import { MATCH_READER_SPEC } from "../match/match-reader";
import type { GenerativeAgentName, JsonObjectSchema } from "@story-fm/llm";
import { FINALIZE_MATCH_SYSTEM, SETTLE_MATCH_INPUT } from "../match/finalize-match";
import { HISTORY_COMPACTOR_SYSTEM, REPORT_DIGEST_INPUT } from "../story/history-compactor";
import { ONBOARDING_JUDGE_SYSTEM, REPORT_ONBOARDING_INPUT } from "../story/onboarding-judge";
import { REPORT_SCOUT_INPUT, SCOUT_RATER_SYSTEM } from "../negotiation/scout-rater";
import { REPORT_TRAINING_INPUT, TRAINING_RATER_SYSTEM } from "../story/training-rater";

/** 생성형 판정 호출의 실제 프롬프트·출력 스키마. 오프라인 검증과 실호출 하네스가 공유한다. */
export interface OutputAgent {
  /** `config/llm.yml`의 키 — **어느 제공자로 나가는지가 여기서 정해진다** */
  readonly agent: GenerativeAgentName;
  /** 그 호출의 시스템 프롬프트 — 실호출 스모크가 같은 요청을 세운다 */
  readonly system: string;
  /** 그 호출이 요청에 싣는 출력 스키마 — 그 산출의 Zod에서 파생한 그대로 */
  readonly schema: JsonObjectSchema;
}

export function outputAgents(): readonly OutputAgent[] {
  return [
    { agent: MATCH_READER_SPEC.agent, system: MATCH_READER_SPEC.system, schema: MATCH_READER_SPEC.schema() },
    { agent: "finalize-match", system: FINALIZE_MATCH_SYSTEM, schema: SETTLE_MATCH_INPUT },
    { agent: "training-rater", system: TRAINING_RATER_SYSTEM, schema: REPORT_TRAINING_INPUT },
    { agent: "scout-rater", system: SCOUT_RATER_SYSTEM, schema: REPORT_SCOUT_INPUT },
    { agent: "onboarding-judge", system: ONBOARDING_JUDGE_SYSTEM, schema: REPORT_ONBOARDING_INPUT },
    { agent: "history-compactor", system: HISTORY_COMPACTOR_SYSTEM, schema: REPORT_DIGEST_INPUT },
  ];
}
