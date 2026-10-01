/**
 * 토큰 계측과 예산 상한 (models.md §4).
 *
 * 계측은 **순수 함수의 누적**이다 — 장부를 손으로 굴려 검증할 수 있어야 정책이
 * 무엇을 세는지가 코드 밖에서도 분명해진다. 런타임 장부는 그 함수들을 모듈 하나에
 * 모아 둔 것뿐이고, 실제 호출은 `meterLlm`이 감싼 `GameLLM`을 지난다.
 *
 * ⚠️ **상한은 게임을 멈추지 않는다.** 상한을 넘겨도 GM·중계는 계속 돌고, 끊기는
 * 것은 **실패해도 대신 설 것이 있는 자리뿐**이다 — 결산 셋은 코어 앵커가 남고
 * (agents.md §4), 압축은 접지 않은 채 다음 기회를 기다린다(agents.md §5-1).
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  AGENT_NAMES,
  RECORDED_AGENT_NAMES,
  agentMinCacheableInput,
  type AgentName,
  type LlmEnv,
} from "./config";
import type { GameLLM, TurnRequest, TurnResult, TurnUsage } from "./game-llm";
import { LlmCallError } from "./llm-error";

/**
 * 상한을 넘겼을 때 건너뛰는 에이전트.
 *
 * **건너뛴 자리에 잃는 것이 없는 곳만 끊는다.** 훈련 결산은 실패를 삼키고 코어
 * 앵커가 그대로 남으며, 자주 도는 만큼 예산도 여기서 가장 빨리 샌다. 경기 마감은
 * 매치 GM의 도구 뒤에서 돌고 마무리는 GM이 대신 쓸 수 있어 끊는다(agents.md §3). 압축은
 * 실패하면 접지 않고 다음 기회에 다시 시도하는 계약이라(agents.md §5-1) 건너뛰어도
 * 이력이 사라지지 않는다.
 */
const SKIPPABLE_AGENTS: ReadonlySet<AgentName> = new Set<AgentName>([
  "training-rater",
  // 경기 마감도 같은 계약이다 — 건너뛰면 앵커가 평점이고 마무리는 매치 GM이 쓴다 (agents.md §3)
  "finalize-match",
  "history-compactor",
  "character-book-editor",
  // 온보딩 판정도 같은 계약이다 — 건너뛰면 앵커가 그대로 시작 지갑이 된다 (agents.md §4-2)
  "onboarding-judge",
]);

/** 히트율 0을 신호로 읽기 전에 필요한 호출 수 — 첫 호출은 원래 쓰기만 한다 */
const CACHE_ALERT_AFTER_CALLS = 3;

/** 예산 상한을 읽는 환경 변수 */
export const TOKEN_BUDGET_ENV = "LLM_TOKEN_BUDGET";

export function emptyUsage(): TurnUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** 두 사용량의 합 — 원본을 건드리지 않는다 */
export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * 예산이 세는 토큰 — **입력 + 출력**이다.
 *
 * `inputTokens`가 이미 캐시분을 품고 있으므로(TurnUsage) 이 값은 "모델이 실제로
 * 처리한 토큰"이다. 가격이 아니라 토큰으로 세는 이유는 상한의 목적이 절약이
 * 아니라 **폭주 차단**이기 때문이다 — 값은 제공자·에이전트마다 다르지만 무한 루프에
 * 빠진 도구 왕복은 어느 에이전트에서든 토큰으로 드러난다.
 */
export function billedTokens(usage: TurnUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * 캐시 히트율 — 입력 중 캐시에서 온 비율(0~1).
 *
 * **0은 프리픽스가 조용히 무효화됐다는 신호다** (models.md §4) — 고정층에 날짜나
 * id가 섞여 들어가면 매 턴 앞이 바뀌어 뒤가 전부 정가로 읽힌다. 화면에 아무
 * 증상이 없고 요금만 오르는 부류의 사고라 계측이 유일한 눈이다.
 */
export function cacheHitRate(usage: TurnUsage): number {
  if (usage.inputTokens <= 0) return 0;
  return usage.cacheReadTokens / usage.inputTokens;
}

export interface AgentLedger {
  calls: number;
  /** 상한에 걸려 부르지 않은 횟수 */
  skipped: number;
  usage: TurnUsage;
}

export interface UsageLedger {
  calls: number;
  skipped: number;
  usage: TurnUsage;
  byAgent: Record<AgentName, AgentLedger>;
}

function emptyAgent(): AgentLedger {
  return { calls: 0, skipped: 0, usage: emptyUsage() };
}

export function emptyLedger(): UsageLedger {
  return {
    calls: 0,
    skipped: 0,
    usage: emptyUsage(),
    byAgent: Object.fromEntries(
      RECORDED_AGENT_NAMES.map((agent) => [agent, emptyAgent()]),
    ) as Record<AgentName, AgentLedger>,
  };
}

/** 호출 하나를 장부에 적는다 — 순수 함수라 새 장부를 돌려준다 */
export function recordUsage(ledger: UsageLedger, agent: AgentName, usage: TurnUsage): UsageLedger {
  const before = ledger.byAgent[agent];
  return {
    calls: ledger.calls + 1,
    skipped: ledger.skipped,
    usage: addUsage(ledger.usage, usage),
    byAgent: {
      ...ledger.byAgent,
      [agent]: {
        calls: before.calls + 1,
        skipped: before.skipped,
        usage: addUsage(before.usage, usage),
      },
    },
  };
}

/** 상한에 걸려 건너뛴 호출 — 안 적으면 "왜 결산이 비었나"를 알 수 없다 */
export function recordSkip(ledger: UsageLedger, agent: AgentName): UsageLedger {
  const before = ledger.byAgent[agent];
  return {
    ...ledger,
    skipped: ledger.skipped + 1,
    byAgent: { ...ledger.byAgent, [agent]: { ...before, skipped: before.skipped + 1 } },
  };
}

/**
 * 상한 읽기 — 없거나 숫자가 아니면 `null`(무제한)이다.
 *
 * 0 이하도 무제한으로 읽는다: 오타 하나로 결산이 통째로 멎는 것보다 상한이 안
 * 걸린 채 로그에 남는 편이 낫다.
 */
export function parseTokenBudget(env: LlmEnv = process.env): number | null {
  const raw = env[TOKEN_BUDGET_ENV];
  if (raw === undefined || raw.trim().length === 0) return null;
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return limit;
}

export interface BudgetVerdict {
  limit: number | null;
  used: number;
  /** 상한을 넘겼는가 — 무제한이면 언제나 false */
  over: boolean;
  /** 상한 대비 비율. 무제한이면 0 */
  ratio: number;
}

export function budgetVerdict(ledger: UsageLedger, limit: number | null): BudgetVerdict {
  const used = billedTokens(ledger.usage);
  if (limit === null) return { limit: null, used, over: false, ratio: 0 };
  return { limit, used, over: used >= limit, ratio: used / limit };
}

/**
 * 지금 이 에이전트를 불러도 되는가.
 *
 * 상한을 넘겨도 **서사와 중계는 계속 돈다** — 그 자리에는 대신 세울 값이 없다.
 */
export function agentAllowed(agent: AgentName, verdict: BudgetVerdict): boolean {
  return !verdict.over || !SKIPPABLE_AGENTS.has(agent);
}

/**
 * 프리픽스가 조용히 깨진 것으로 보이는 에이전트 — 캐시가 걸릴 만한 크기를 여러 번
 * 보냈는데 히트율이 0인 곳이다.
 *
 * **문턱은 그 에이전트가 부르는 제공자의 최소 캐시 프리픽스다** (models.md §4).
 * 셋 중 큰 값 하나로 재면 작은 쪽이 통째로 문턱 아래에 들어앉아, 프리픽스가 매 턴
 * 깨져도 경고가 영영 올라오지 않는다 — Anthropic 결산 호출(1k~4k)이 그 자리다.
 * `minInput`은 설정을 읽지 않는 테스트가 문턱을 직접 주기 위한 자리다.
 */
export function cacheAlerts(
  ledger: UsageLedger,
  minInput: (agent: AgentName) => number = agentMinCacheableInput,
): AgentName[] {
  return AGENT_NAMES.filter((agent) => {
    const entry = ledger.byAgent[agent];
    if (entry.calls < CACHE_ALERT_AFTER_CALLS) return false;
    if (entry.usage.inputTokens / entry.calls < minInput(agent)) return false;
    return entry.usage.cacheReadTokens === 0;
  });
}

/**
 * 상한에 걸려 부르지 않았다 — 종류 `budget` (models.md §1-1).
 * 결산의 "실패하면 앵커" 경로로 떨어지고, 장면을 쓰는 호출이면 화면의 배너가 된다.
 *
 * 이 문장에 조사를 세우지 않는 이유는 `josa()`가 `@story-fm/domain`에 있고 이 패키지는
 * **공급자 중립**이어서 도메인을 참조하지 않기 때문이다 (AGENTS.md §3). 상한 숫자의
 * 받침은 매번 갈리므로, 조사를 박는 대신 조사가 서지 않는 말로 적는다.
 */
export class TokenBudgetExceededError extends LlmCallError {
  constructor(
    readonly agent: AgentName,
    readonly verdict: BudgetVerdict,
  ) {
    super(
      "budget",
      `토큰 예산 상한(${verdict.limit}) 초과로 ${agent} 호출을 건너뜁니다 — 누적 ${verdict.used}`,
    );
    this.name = "TokenBudgetExceededError";
  }
}

interface UsageSession {
  gameId: string | null;
  ledger: UsageLedger;
  warned: Set<string>;
}
const sessions = new Map<string, UsageSession>();
const scope = new AsyncLocalStorage<UsageSession>();
const emptySession = (gameId: string | null): UsageSession => ({
  gameId,
  ledger: emptyLedger(),
  warned: new Set(),
});
let latest = emptySession(null);
const currentSession = (): UsageSession => scope.getStore() ?? latest;

/** 현재 비동기 범위의 게임 사용량; 범위 밖의 관리 화면은 최근 연 게임을 읽는다. */
export function llmUsage(): UsageLedger {
  return currentSession().ledger;
}
export function llmUsageGameId(): string | null {
  return currentSession().gameId;
}

export function resetLlmUsage(): void {
  sessions.clear();
  scope.disable();
  latest = emptySession(null);
}

function sessionFor(gameId: string): UsageSession {
  let session = sessions.get(gameId);
  if (!session) {
    session = emptySession(gameId);
    sessions.set(gameId, session);
  }
  latest = session;
  return session;
}

/** 이 비동기 실행과 이어지는 호출을 게임별 장부에 연결한다. */
export function beginGameUsage(gameId: string): void {
  scope.enterWith(sessionFor(gameId));
}

/** 호출자 범위를 바꾸지 않고 이 처리와 비동기 후속 호출만 게임에 연결한다. */
export function withGameUsage<T>(gameId: string, run: () => T): T {
  return scope.run(sessionFor(gameId), run);
}

function warnOnce(session: UsageSession, key: string, message: string): void {
  if (session.warned.has(key)) return;
  session.warned.add(key);
  console.warn(message);
}

/** Enforce the same call budget for generative and typed evaluation roles. */
export function assertAgentBudget(agent: AgentName, env: LlmEnv = process.env): void {
  const session = currentSession();
  const verdict = budgetVerdict(session.ledger, parseTokenBudget(env));
  if (!agentAllowed(agent, verdict)) {
    session.ledger = recordSkip(session.ledger, agent);
    warnOnce(
      session,
      `budget:${agent}`,
      `[llm] 토큰 예산 상한(${verdict.limit}) 초과 — ${agent} 호출을 건너뜁니다. 코어 앵커가 남습니다.`,
    );
    throw new TokenBudgetExceededError(agent, verdict);
  }
  if (verdict.over) {
    warnOnce(
      session,
      `budget-pass:${agent}`,
      `[llm] 토큰 예산 상한(${verdict.limit}) 초과 — 계속 실행합니다: ${agent} (누적 ${verdict.used}).`,
    );
  }
}

/**
 * 계측·상한을 씌운 `GameLLM` — 계약이 같으므로 부르는 쪽은 감싼 줄 모른다.
 *
 * 상한을 넘기면 결산은 여기서 끊기고(`TokenBudgetExceededError`), 나머지 에이전트는
 * 경고 한 번만 남기고 그대로 돈다.
 */
export function meterLlm(llm: GameLLM, agent: AgentName, env: LlmEnv = process.env): GameLLM {
  return {
    async runTurn(req: TurnRequest): Promise<TurnResult> {
      const session = currentSession();
      assertAgentBudget(agent, env);

      // 왕복마다 보고된 몫을 모아 둔다 — 호출이 실패로 끝나면 이것이 장부에
      // 남는 전부다. 결과를 받은 뒤에만 적으면 여덟 번을 왕복하다 시한에 걸린
      // 턴, 곧 **가장 많이 쓴 호출**이 0으로 적힌다 (models.md §4).
      let reported = emptyUsage();
      const result = await llm
        .runTurn({
          ...req,
          onUsage: (delta) => {
            reported = addUsage(reported, delta);
            req.onUsage?.(delta);
          },
        })
        .catch((error: unknown) => {
          // 보고된 것이 없으면 적지 않는다 — 예산에 걸려 부르지도 않은 호출과
          // 즉시 끊긴 연결 오류가 `calls`를 부풀리면 `cacheAlerts`의 평균 입력이
          // 흐려진다.
          if (billedTokens(reported) > 0) {
            session.ledger = recordUsage(session.ledger, agent, reported);
          }
          throw error;
        });
      // 성공 경로는 어댑터가 돌려준 합계만 적는다 — 왕복 몫과 두 번 세지 않는다
      session.ledger = recordUsage(session.ledger, agent, result.usage);
      for (const broken of cacheAlerts(session.ledger)) {
        warnOnce(
          session,
          `cache:${broken}`,
          `[llm] ${broken} 에이전트의 캐시 히트율이 0입니다 — 프리픽스가 매 턴 무효화되는지 확인하세요.`,
        );
      }
      return result;
    },
  };
}

/** Evaluations share the turn budget ledger, including reported failed-attempt usage. */
export function recordEvaluationUsage(agent: AgentName, usage: TurnUsage): void {
  const session = currentSession();
  session.ledger = recordUsage(session.ledger, agent, usage);
}
