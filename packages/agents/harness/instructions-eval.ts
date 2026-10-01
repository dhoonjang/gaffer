/** Opt-in synthetic evaluation with production catalogs; no save or trace scope is opened. */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  advanceLiveMatch,
  advanceTime,
  bindJournal,
  createGame,
  markEntered,
  startMatch,
  tacticsOf,
  type JournalEntry,
} from "@story-fm/engine";
import {
  addUsage,
  agentConfig,
  emptyUsage,
  gameVersion,
  hasKey,
  keyNamesFor,
  llmErrorKind,
  llmUsage,
  LLM_CONFIG,
  TypesafeEvaluationError,
  TypesafeGameEvaluator,
  withGameUsage,
  type EvaluatorName,
  type GameEvaluator,
  type TurnUsage,
  type UsageLedger,
} from "@story-fm/llm";
import { LIVE_TICKS_PER_SECOND, recentFlowOf } from "@story-fm/sim";
import { interpretInstructions } from "../src/common/instruction-compiler";
import { instructionCommands, instructionCandidates } from "../src/app/workflows/instructions";
import { buildToolSpecs } from "../src/app/gm-tools";
import { buildTrainingSchedule } from "../src/app/gm-input";
import { buildPeaceContext } from "../src/app/workflows/match/tactic-orders";
import { buildTrainingContext } from "../src/app/workflows/story/training-orders";
import { buildFinanceContext } from "../src/app/workflows/common/finance-orders";
import { TACTIC_OPS } from "../src/match/tactic-orders";
import { TRAINING_OPS } from "../src/story/training-orders";
import { FINANCE_OPS } from "../src/common/finance-orders";
import { runGmTurn } from "../src/app/gm";
import { costUsd, durationStats, stableJson, type Prices } from "./match-reader-eval-metrics";

function freshGame() {
  return createGame({
    seed: 42,
    userTeamId: "arsenal",
    managerName: "김감독",
    background: "주장 출신 감독",
  });
}
function canonical(path: string): string {
  return existsSync(path)
    ? realpathSync(path)
    : join(canonical(dirname(path)), relative(dirname(path), path));
}
function safeOutput(raw: string): string {
  const path = resolve(raw);
  const actual = canonical(path);
  for (const candidate of [path, actual]) {
    if (candidate.split(sep).some((part) => [".log", ".data"].includes(part.toLowerCase()))) {
      throw new Error("Output inside .log or .data is forbidden, including symlink descendants");
    }
  }
  if (existsSync(path)) throw new Error("--out must be a fresh directory");
  mkdirSync(dirname(actual), { recursive: true });
  mkdirSync(actual);
  return actual;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function directionalTactics(
  name: string,
  changes: Record<string, unknown>,
  pressing: number,
  line: number,
): boolean {
  if (!Object.keys(changes).every((key) => ["pressing", "defensiveLine"].includes(key)))
    return false;
  const p = changes.pressing ?? pressing,
    d = changes.defensiveLine ?? line;
  if (typeof p !== "number" || typeof d !== "number" || !Number.isFinite(p) || !Number.isFinite(d))
    return false;
  return name === "high-press"
    ? p > pressing && d >= line
    : p <= pressing && d <= line && (p < pressing || d < line);
}
function failure(error: unknown) {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    kind: llmErrorKind(error),
    // The TypeSafe adapter owns these messages and never includes provider bodies.
    ...(error instanceof TypesafeEvaluationError ? { detail: error.message } : {}),
  };
}
interface Stage {
  requestSha256: string;
  durationMs: number;
  questions: number;
  attempts: number;
  usage: TurnUsage;
  usageComplete: boolean;
  model?: string;
  failure?: ReturnType<typeof failure>;
}
type InstructionRole = "tactic-orders" | "training-orders" | "finance-orders";
interface SyntheticResult {
  name: string;
  role: InstructionRole;
  said: string;
  criterion: string;
  output?: unknown;
  semanticCheck: boolean;
  durationMs: number;
  stages: Stage[];
  usage: TurnUsage;
  usageComplete: boolean;
  costUsd: number | null;
  failure?: ReturnType<typeof failure>;
}
interface TurnResult {
  name: string;
  said: string;
  criterion: string;
  semanticCheck: boolean;
  noUnrelatedOps: boolean;
  beforePressing: number;
  afterPressing: number;
  passed: boolean;
  durationMs: number;
  sceneCharacters: number;
  calls: string[];
  gmAgent: "gm" | "match-gm";
  flow?: ReturnType<typeof recentFlowOf>;
  matchEffect?: { markerId: string; targetId: string; matched: boolean };
  numericEffect?: { side: "home" | "away"; lane: "left"; matched: boolean; strengths: number[] };
  modelRequests: { host: string; bodySha256: string | null }[];
  diagnosticFacts: JournalEntry[];
  evaluatorDiagnostics: {
    status: number;
    stateSha256: string | null;
    questions: unknown;
    answers: unknown;
  }[];
  evaluatorCalls: Partial<Record<EvaluatorName, number>>;
  routingCorrect: boolean;
  usage: UsageLedger;
  costUsd: number | null;
  failure?: ReturnType<typeof failure>;
}

function ledgerCost(ledger: UsageLedger, gmPrices: Prices, failed: boolean): number | null {
  if (failed) return null;
  let total = 0;
  for (const [agent, entry] of Object.entries(ledger.byAgent)) {
    if (entry.calls === 0) continue;
    const evaluator = LLM_CONFIG.evaluators[agent as EvaluatorName];
    if (evaluator) {
      total += (entry.usage.inputTokens * evaluator.inputUsdPerMillion) / 1_000_000;
    } else if (
      agent === "gm" ||
      (agent === "match-gm" &&
        agentConfig("match-gm").provider === agentConfig("gm").provider &&
        agentConfig("match-gm").model === agentConfig("gm").model)
    ) {
      const value = costUsd(entry.usage, gmPrices);
      if (value === null) return null;
      total += value;
    } else return null;
  }
  return total;
}

/** Hash the checked-out runtime sources, including uncommitted changes; never inspect env/data. */
function sourceFingerprint() {
  const root = resolve(import.meta.dirname, "../../..");
  function files(folder: string): string[] {
    return readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) => {
      const path = join(folder, entry.name);
      return entry.isDirectory()
        ? files(path)
        : entry.isFile() && path.endsWith(".ts")
          ? [path]
          : [];
    });
  }
  const paths = [
    ...["agents", "llm", "engine", "domain", "sim"].flatMap((name) =>
      files(`packages/${name}/src`),
    ),
    "config/llm.yml",
    "config/game-version.yml",
    "packages/agents/harness/instructions-eval.ts",
  ].sort();
  const sha256ByPath = Object.fromEntries(
    paths.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex"),
    ]),
  );
  return {
    sha256: createHash("sha256").update(stableJson(sha256ByPath)).digest("hex"),
    sha256ByPath,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      case: { type: "string" },
      live: { type: "boolean", default: false },
      turn: { type: "boolean", default: false },
      "match-turn": { type: "boolean", default: false },
      "gm-input-usd-per-million": { type: "string" },
      "gm-output-usd-per-million": { type: "string" },
      "gm-cached-input-usd-per-million": { type: "string" },
    },
  });
  if (!values.out) throw new Error("Required: --out <fresh directory> [--live] [--turn]");
  function price(
    key:
      "gm-input-usd-per-million" | "gm-output-usd-per-million" | "gm-cached-input-usd-per-million",
  ) {
    const raw = values[key];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${key}`);
    return value;
  }
  const gmPrices = {
    input: price("gm-input-usd-per-million"),
    output: price("gm-output-usd-per-million"),
    cachedInput: price("gm-cached-input-usd-per-million"),
  };
  const out = safeOutput(values.out);
  const state = freshGame();
  const player = state.players.find((item) => item.teamId === state.userTeamId);
  if (!player) throw new Error("Synthetic fixture has no own-team player");
  const playerId = player.id;
  const specs = new Map(buildToolSpecs(state, []).map((spec) => [spec.name, spec]));
  const scopes = {
    "tactic-orders": {
      commands: instructionCommands(specs, TACTIC_OPS),
      context: buildPeaceContext(state).join("\n"),
    },
    "training-orders": {
      commands: instructionCommands(specs, TRAINING_OPS),
      context: buildTrainingContext(state, buildTrainingSchedule(state)).join("\n"),
    },
    "finance-orders": {
      commands: instructionCommands(specs, FINANCE_OPS),
      context: buildFinanceContext(state).join("\n"),
    },
  };
  const source = sourceFingerprint();
  const initial = tacticsOf(state, state.userTeamId).spec.pressing;
  const cases = [
    {
      name: "high-press",
      role: "tactic-orders" as const,
      said: "상대가 편하게 공을 돌리지 못하게 앞에서부터 강하게 압박해.",
      criterion: "Increase pressing; optional defensive-line increase; no other tactical changes.",
    },
    {
      name: "protect-space",
      role: "tactic-orders" as const,
      said: "무리하게 쫓아가지 말고 내려서서 공간부터 지켜.",
      criterion:
        "Reduce pressing and/or defensive line, without increasing either; no other tactical changes.",
    },
    {
      name: "discuss-pressing",
      role: "tactic-orders" as const,
      said: "앞에서부터 압박하면 어떨까? 아직 바꾸지는 말고 의견만 들려줘.",
      criterion: "Discussion only; no commands.",
    },
    {
      name: "ticket-price",
      role: "finance-orders" as const,
      said: "홈 경기 티켓 가격을 50파운드로 정해 줘.",
      criterion: "Set ticket price to 50 pounds; no unrelated commands.",
    },
  ];
  function semanticOps(name: string, ops: Record<string, unknown[]>): boolean {
    const keys = Object.keys(ops).filter((key) => ops[key]!.length > 0);
    if (name === "discuss-pressing") return keys.length === 0;
    const command = name === "ticket-price" ? "set_ticket_price" : "set_tactics";
    if (keys.length !== 1 || keys[0] !== command || ops[command]?.length !== 1) return false;
    const row = object(ops[command][0]);
    if (!row) return false;
    if (name === "ticket-price")
      return Object.keys(row).every((key) => key === "price") && row.price === 50;
    return directionalTactics(
      name,
      row,
      initial,
      tacticsOf(state, state.userTeamId).spec.defensiveLine,
    );
  }
  const availableCases = [
    ...cases.map((testcase) => testcase.name),
    ...(values.turn ? ["dialogue"] : []),
    ...(values["match-turn"] ? ["match-high-press", "match-mark", "match-left-focus"] : []),
  ];
  if (values.case && !availableCases.includes(values.case))
    throw new Error("Unknown --case or missing --turn/--match-turn flag");
  const blockers: string[] = [];
  const results: SyntheticResult[] = [];
  const turns: TurnResult[] = [];
  if (values.live) {
    try {
      process.loadEnvFile(join(import.meta.dirname, "../../../apps/web/.env.local"));
    } catch {
      /* Environment-only credentials are supported. */
    }
    process.env.LLM_MODE = "real";
    if (!process.env.TYPESAFE_API_KEY?.trim()) blockers.push("Missing TYPESAFE_API_KEY");
    for (const role of Object.keys(scopes) as InstructionRole[]) {
      if (!LLM_CONFIG.evaluators[role]) blockers.push(`Missing evaluators.${role} configuration`);
    }
    if ((values.turn || values["match-turn"]) && !hasKey(agentConfig("gm").provider))
      blockers.push(`Missing GM credential: ${keyNamesFor(agentConfig("gm").provider)}`);
    if (blockers.length === 0) {
      for (const testcase of cases.filter((item) => !values.case || item.name === values.case)) {
        const config = LLM_CONFIG.evaluators[testcase.role]!;
        const client = new TypesafeGameEvaluator(config);
        const { commands, context } = scopes[testcase.role];
        console.log(`Evaluating synthetic ${testcase.name}`);
        const stages: Stage[] = [];
        const evaluator: GameEvaluator = {
          async evaluate(request) {
            const began = performance.now();
            try {
              const result = await client.evaluate(request);
              stages.push({
                requestSha256: createHash("sha256").update(stableJson(request)).digest("hex"),
                durationMs: performance.now() - began,
                questions: Object.keys(request.questions).length,
                attempts: result.attempts ?? 1,
                usage: result.usage,
                usageComplete: result.usageComplete !== false,
                model: result.model,
              });
              return result;
            } catch (error) {
              stages.push({
                requestSha256: createHash("sha256").update(stableJson(request)).digest("hex"),
                durationMs: performance.now() - began,
                questions: Object.keys(request.questions).length,
                attempts: error instanceof TypesafeEvaluationError ? error.attempts : 1,
                usage: error instanceof TypesafeEvaluationError ? error.usage : emptyUsage(),
                usageComplete: error instanceof TypesafeEvaluationError && error.usageComplete,
                failure: failure(error),
              });
              throw error;
            }
          },
        };
        const began = performance.now();
        let output: unknown;
        let semanticCheck = false;
        let errorInfo: ReturnType<typeof failure> | undefined;
        try {
          const answer = await interpretInstructions({
            said: testcase.said,
            context,
            commands,
            candidates: instructionCandidates(state, testcase.said),
            evaluator,
          });
          output = answer;
          semanticCheck = !answer.unresolved && semanticOps(testcase.name, answer.ops);
        } catch (error) {
          errorInfo = failure(error);
        }
        const usage = stages.reduce((total, stage) => addUsage(total, stage.usage), emptyUsage());
        const usageComplete = stages.every((stage) => stage.usageComplete);
        results.push({
          ...testcase,
          output,
          semanticCheck,
          durationMs: performance.now() - began,
          stages,
          usage,
          usageComplete,
          costUsd: usageComplete
            ? (usage.inputTokens * config.inputUsdPerMillion) / 1_000_000
            : null,
          ...(errorInfo ? { failure: errorInfo } : {}),
        });
      }
      if (values.turn || values["match-turn"]) {
        const turnCases = [
          ...(values.turn
            ? [
                cases[0]!,
                cases[2]!,
                { name: "dialogue", said: "선수들 표정이 좋아 보이네. 오늘 분위기는 어때?" },
                { name: "squad-number", said: `${player.name}에게 등번호 9번을 줘` },
              ]
            : []),
          ...(values["match-turn"]
            ? [
                { name: "match-high-press", said: cases[0]!.said },
                { name: "match-mark", said: "" },
                {
                  name: "match-left-focus",
                  said: "이번 경기는 왼쪽 측면으로 공격을 집중해. 반대편에는 공격이 덜 가더라도 괜찮아.",
                },
              ]
            : []),
        ];
        for (const testcase of turnCases.filter(
          (item) => !values.case || item.name === values.case,
        )) {
          console.log(`Evaluating full turn ${testcase.name}`);
          const game = freshGame();
          const inMatch = testcase.name.startsWith("match-");
          let said = testcase.said;
          let mark: { markerId: string; targetId: string } | undefined;
          let focusSide: "home" | "away" | undefined;
          let flow: ReturnType<typeof recentFlowOf> | undefined;
          if (inMatch) {
            for (let guard = 0; guard < 40 && game.phase !== "matchday"; guard++)
              advanceTime(game, "next_match");
            const started = startMatch(game);
            if (!started.ok || !game.pendingMatch) throw new Error("Synthetic match setup failed");
            markEntered(game);
            advanceLiveMatch(game, 600 * LIVE_TICKS_PER_SECOND);
            const live = game.pendingMatch.live;
            flow = recentFlowOf(live);
            if (testcase.name === "match-left-focus")
              focusSide = live.setup.sides.home.teamId === game.userTeamId ? "home" : "away";
            if (testcase.name === "match-mark") {
              const side = live.setup.sides.home.teamId === game.userTeamId ? "home" : "away";
              const rival = side === "home" ? "away" : "home";
              const marker = live.slots[side].find((slot) => slot.position !== "GK");
              const target = live.slots[rival].find((slot) => slot.position !== "GK");
              if (!marker || !target) throw new Error("Synthetic match has no outfield pair");
              mark = { markerId: marker.playerId, targetId: target.playerId };
              const name = (id: string) => game.players.find((player) => player.id === id)!.name;
              said = `${name(marker.playerId)}에게 수비할 때 ${name(target.playerId)}를 붙어서 따라다니게 해. 쉽게 돌아서지 못하게 막아.`;
            }
          }
          // The web turn runner stores the user turn before runGmTurn builds its GM message.
          game.chat.push({ role: "user", text: said, toolCalls: [], at: game.date });
          const beforePressing = tacticsOf(game, game.userTeamId).spec.pressing;
          const beforeSpec = structuredClone(tacticsOf(game, game.userTeamId).spec);
          const pressureInstruction =
            testcase.name === "high-press" || testcase.name === "match-high-press";
          // 등번호는 GM이 직접 부르는 스킬이다 — 해석기 없이 지정 선수에게 9번이 서야 한다
          const numberInstruction = testcase.name === "squad-number";
          await withGameUsage(`instruction-eval-${Date.now()}-${testcase.name}`, async () => {
            const began = performance.now();
            let calls: string[] = [];
            let sceneCharacters = 0;
            let errorInfo: ReturnType<typeof failure> | undefined;
            const modelRequests: { host: string; bodySha256: string | null }[] = [];
            const diagnosticFacts: JournalEntry[] = [];
            bindJournal((entry) => {
              if (["orders.intent", "command", "match.reading"].includes(entry.kind))
                diagnosticFacts.push(entry);
            });
            const evaluatorDiagnostics: TurnResult["evaluatorDiagnostics"] = [];
            const originalFetch = globalThis.fetch;
            globalThis.fetch = async (input, init) => {
              const url = input instanceof Request ? input.url : String(input);
              const body =
                typeof init?.body === "string"
                  ? init.body
                  : input instanceof Request
                    ? await input.clone().text()
                    : undefined;
              modelRequests.push({
                host: new URL(url).hostname,
                bodySha256:
                  body === undefined ? null : createHash("sha256").update(body).digest("hex"),
              });
              const response = await originalFetch(input, init);
              if (new URL(url).hostname === "api.typesafe.ai" && body !== undefined) {
                const request: unknown = JSON.parse(body);
                const result: unknown = await response
                  .clone()
                  .json()
                  .catch(() => null);
                const row =
                  request !== null && typeof request === "object"
                    ? (request as Record<string, unknown>)
                    : {};
                const answer =
                  result !== null && typeof result === "object"
                    ? (result as Record<string, unknown>)
                    : {};
                evaluatorDiagnostics.push({
                  status: response.status,
                  stateSha256:
                    typeof row.state === "string"
                      ? createHash("sha256").update(row.state).digest("hex")
                      : null,
                  questions: row.questions ?? null,
                  answers: answer.answers ?? null,
                });
              }
              return response;
            };
            try {
              const result = await runGmTurn(game, said);
              calls = result.toolCalls.map((call) => call.name);
              sceneCharacters = result.text.length;
            } catch (error) {
              errorInfo = failure(error);
            } finally {
              globalThis.fetch = originalFetch;
              bindJournal(null);
            }
            const afterPressing = tacticsOf(game, game.userTeamId).spec.pressing;
            const ledger = structuredClone(llmUsage());
            const matched =
              mark === undefined
                ? undefined
                : (game.pendingMatch?.live.sheet ?? []).some(
                    (line) =>
                      line.shape === "behavior" &&
                      line.action === "mark" &&
                      line.target.player === mark.markerId &&
                      line.targetPlayer === mark.targetId &&
                      line.step > 0,
                  );
            const strengths =
              focusSide === undefined
                ? []
                : (game.pendingMatch?.live.sheet ?? [])
                    .filter(
                      (line) =>
                        line.shape === "focus" &&
                        line.target.side === focusSide &&
                        line.target.lane === "left",
                    )
                    .map((line) => line.sign * line.step);
            const focusMatched = strengths.some(
              (strength) => Number.isFinite(strength) && strength > 0,
            );
            const numbered = game.players.find((item) => item.id === playerId)?.squadNumber === 9;
            const commandCorrect = focusSide
              ? focusMatched && calls.includes("tactic_orders")
              : mark
                ? matched === true && calls.includes("tactic_orders")
                : pressureInstruction || inMatch
                  ? calls.includes("set_tactics")
                  : numberInstruction
                    ? calls.includes("set_squad_number") && !calls.includes("set_tactics")
                    : !calls.includes("set_tactics");
            const evaluatorCalls = Object.fromEntries(
              Object.keys(LLM_CONFIG.evaluators).map((role) => [
                role,
                ledger.byAgent[role as EvaluatorName]?.calls ?? 0,
              ]),
            );
            const totalEvaluatorCalls = Object.values(evaluatorCalls).reduce(
              (sum, calls) => sum + calls,
              0,
            );
            const expectedEvaluator = inMatch ? "match-reader" : "tactic-orders";
            const routingCorrect =
              pressureInstruction || inMatch
                ? (evaluatorCalls[expectedEvaluator] ?? 0) > 0 &&
                  totalEvaluatorCalls === evaluatorCalls[expectedEvaluator]
                : totalEvaluatorCalls === 0;
            const afterSpec = tacticsOf(game, game.userTeamId).spec;
            const changedSpec = Object.fromEntries(
              Object.entries(afterSpec).filter(
                ([key, value]) =>
                  stableJson(value) !== stableJson(beforeSpec[key as keyof typeof beforeSpec]),
              ),
            );
            const allowedOps = pressureInstruction
              ? ["set_tactics"]
              : inMatch
                ? ["set_match_plan"]
                : [];
            const noUnrelatedOps = diagnosticFacts.every(
              (fact) =>
                (fact.kind !== "orders.intent" ||
                  Object.entries(fact.ops ?? {}).every(
                    ([name, rows]) => rows.length === 0 || allowedOps.includes(name),
                  )) &&
                (fact.kind !== "command" ||
                  !TACTIC_OPS.includes(fact.name) ||
                  allowedOps.includes(fact.name)),
            );
            const semanticCheck = pressureInstruction
              ? directionalTactics(
                  "high-press",
                  changedSpec,
                  beforePressing,
                  beforeSpec.defensiveLine,
                )
              : stableJson(beforeSpec) === stableJson(afterSpec) &&
                (focusSide
                  ? focusMatched
                  : mark
                    ? matched === true
                    : numberInstruction
                      ? numbered
                      : true);
            turns.push({
              name: testcase.name,
              said,
              criterion: pressureInstruction
                ? cases[0]!.criterion
                : focusSide
                  ? "Positive own-team left attacking focus, unchanged base tactics."
                  : mark
                    ? "Named player marks the named opponent, unchanged base tactics."
                    : numberInstruction
                      ? "GM calls set_squad_number directly; the named player wears 9; no evaluator call."
                      : "Conversation only; no tactical change or evaluator call.",
              semanticCheck,
              noUnrelatedOps,
              beforePressing,
              afterPressing,
              passed:
                !errorInfo &&
                commandCorrect &&
                routingCorrect &&
                semanticCheck &&
                noUnrelatedOps &&
                sceneCharacters > 0,
              durationMs: performance.now() - began,
              sceneCharacters,
              calls,
              gmAgent: inMatch ? "match-gm" : "gm",
              ...(flow ? { flow } : {}),
              ...(mark ? { matchEffect: { ...mark, matched: matched === true } } : {}),
              ...(focusSide
                ? {
                    numericEffect: {
                      side: focusSide,
                      lane: "left" as const,
                      matched: focusMatched,
                      strengths,
                    },
                  }
                : {}),
              modelRequests,
              diagnosticFacts,
              evaluatorDiagnostics,
              evaluatorCalls,
              routingCorrect,
              usage: ledger,
              costUsd: ledgerCost(ledger, gmPrices, errorInfo !== undefined),
              ...(errorInfo ? { failure: errorInfo } : {}),
            });
          });
        }
      }
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    gameVersion: gameVersion(),
    mode: values.live ? "live" : "offline",
    selectedCase: values.case ?? null,
    availableCases,
    turnRequested: values.turn,
    matchTurnRequested: values["match-turn"],
    scope:
      "Role-scoped synthetic compiler cases plus optional GM skill-routing turns. No all-turn prepass, recorded corpus or baseline comparison.",
    source,
    sourceAtEndSha256: sourceFingerprint().sha256,
    evaluators: LLM_CONFIG.evaluators,
    gm: { provider: agentConfig("gm").provider, model: agentConfig("gm").model, prices: gmPrices },
    scopes: Object.fromEntries(
      Object.entries(scopes).map(([role, scope]) => [
        role,
        {
          commandCount: scope.commands.length,
          contextCharacters: scope.context.length,
          contextSha256: createHash("sha256").update(scope.context).digest("hex"),
        },
      ]),
    ),
    cases,
    blockers,
    results,
    turns,
    syntheticDuration: durationStats(results.map((item) => item.durationMs)),
    limitations: [
      "Five synthetic semantic checks do not establish production quality or improvement. Directional checks permit model-selected intensity, not an exact numerical target.",
      "A failed or partial directional check is reported as failure, not accepted merely because a tool was called. Manual review remains necessary for legitimate alternative tactics.",
      "Interpretation cases do not apply commands; full turns check skill routing, pressing behavior and scene presence, not narrative quality.",
      "All provider-reported failed attempt usage is retained. Unreported failure usage and hidden retries cannot be inferred.",
      "Full-turn ledger calls are logical calls, not HTTP attempts. Complete per-attempt accounting is available for direct synthetic evaluator stages only.",
      "Costs are supplied list-price estimates, not billed amounts; additional unpriced agents or failed turns have unknown total cost.",
    ],
  };
  const show = (value: number | null) => (value === null ? "n/a" : value.toFixed(6));
  const summary = [
    "# Direct instruction evaluation",
    "",
    `Mode: ${report.mode}; game version ${report.gameVersion}; role-scoped production catalogs.`,
    `Source SHA-256: ${source.sha256}`,
    ...Object.entries(report.scopes).map(
      ([role, scope]) =>
        `${role}: ${scope.commandCount} commands; ${scope.contextCharacters} context characters.`,
    ),
    "",
    "| Synthetic case / role | Semantic criterion | Wall ms | Stages / attempts | Input / output tokens | USD estimate |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...results.map(
      (item) =>
        `| ${item.name} / ${item.role} | ${item.semanticCheck} | ${item.durationMs.toFixed(2)} | ${item.stages.length} / ${item.stages.reduce((sum, stage) => sum + stage.attempts, 0)} | ${item.usage.inputTokens} / ${item.usage.outputTokens} | ${show(item.costUsd)} |`,
    ),
    "",
    "| Full-turn case | State + routing + scene check | Wall ms | Evaluator calls / all logical calls | Input / output tokens | USD estimate |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...turns.map(
      (item) =>
        `| ${item.name} | ${item.passed} | ${item.durationMs.toFixed(2)} | ${Object.values(item.evaluatorCalls).reduce((sum, calls) => sum + (calls ?? 0), 0)} / ${item.usage.calls} | ${item.usage.usage.inputTokens} / ${item.usage.usage.outputTokens} | ${show(item.costUsd)} |`,
    ),
    "",
    ...(blockers.length ? ["Blockers:", "", ...blockers.map((item) => `- ${item}`), ""] : []),
    ...report.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n");
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  writeFileSync(join(out, "summary.md"), summary, { flag: "wx" });
  console.log(summary);
  if (
    values.live &&
    (blockers.length > 0 ||
      results.some((item) => !item.semanticCheck) ||
      turns.some((item) => !item.passed))
  )
    process.exitCode = 1;
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Instruction evaluation failed");
  process.exitCode = 1;
});
