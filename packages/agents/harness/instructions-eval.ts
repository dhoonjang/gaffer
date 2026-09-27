/** Opt-in synthetic evaluation with production catalogs; no save or trace scope is opened. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { createGame, tacticsOf } from "@story-fm/engine";
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
  type GameEvaluator,
  type TurnUsage,
  type UsageLedger,
} from "@story-fm/llm";
import { interpretInstructions } from "../src/common/instruction-compiler";
import { instructionCommands, instructionCandidates } from "../src/app/workflows/instructions";
import { buildToolSpecs } from "../src/app/gm-tools";
import { buildTrainingSchedule } from "../src/app/gm-input";
import { buildPeaceContext } from "../src/app/workflows/match/tactic-orders";
import { buildTrainingContext } from "../src/app/workflows/story/training-orders";
import { buildMarketContext } from "../src/app/workflows/negotiation/market-orders";
import { TACTIC_OPS } from "../src/match/tactic-orders";
import { TRAINING_OPS } from "../src/story/training-orders";
import { MARKET_OPS } from "../src/negotiation/market-orders";
import { runGmTurn } from "../src/app/gm";
import { costUsd, durationStats, stableJson, type Prices } from "./match-reader-eval-metrics";

function freshGame() {
  return createGame({
    seed: 42,
    userTeamId: "arsenal",
    managerName: "김감독",
    background: "주장 출신 감독",
    wallet: 1_000_000_000,
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
function failure(error: unknown) {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    kind: llmErrorKind(error),
    // The TypeSafe adapter owns these messages and never includes provider bodies.
    ...(error instanceof TypesafeEvaluationError ? { detail: error.message } : {}),
  };
}
interface Stage {
  durationMs: number;
  questions: number;
  attempts: number;
  usage: TurnUsage;
  usageComplete: boolean;
  model?: string;
  failure?: ReturnType<typeof failure>;
}
interface SyntheticResult {
  name: string;
  said: string;
  expected: unknown;
  output?: unknown;
  exactAgreement: boolean;
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
  expectedPressing: number;
  beforePressing: number;
  afterPressing: number;
  passed: boolean;
  durationMs: number;
  sceneCharacters: number;
  calls: string[];
  usage: UsageLedger;
  costUsd: number | null;
  failure?: ReturnType<typeof failure>;
}

function ledgerCost(ledger: UsageLedger, gmPrices: Prices, failed: boolean): number | null {
  if (failed) return null;
  let total = 0;
  for (const [agent, entry] of Object.entries(ledger.byAgent)) {
    if (entry.calls === 0) continue;
    if (agent === "instructions" && LLM_CONFIG.instructions) {
      total += (entry.usage.inputTokens * LLM_CONFIG.instructions.inputUsdPerMillion) / 1_000_000;
    } else if (agent === "gm") {
      const value = costUsd(entry.usage, gmPrices);
      if (value === null) return null;
      total += value;
    } else return null;
  }
  return total;
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      live: { type: "boolean", default: false },
      turn: { type: "boolean", default: false },
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
  const commands = instructionCommands(
    new Map(buildToolSpecs(state, []).map((spec) => [spec.name, spec])),
    [...TACTIC_OPS, ...TRAINING_OPS, ...MARKET_OPS],
  );
  const context = [
    ...buildPeaceContext(state),
    ...buildTrainingContext(state, buildTrainingSchedule(state)),
    ...buildMarketContext(state),
  ].join("\n");
  const initial = tacticsOf(state, state.userTeamId).spec.pressing;
  const cases = [
    {
      name: "explicit-axis",
      said: "압박을 4로 설정해",
      expected: { set_tactics: [{ pressing: 4 }] },
    },
    {
      name: "relative-axis",
      said: "압박을 한 칸 더 올려",
      expected: { set_tactics: [{ pressing: Math.min(5, initial + 1) }] },
    },
    {
      name: "hypothetical-negative",
      said: "압박을 5로 올리면 어떨까? 아직 바꾸지는 마.",
      expected: {},
    },
    {
      name: "exact-korean-money",
      said: "내 사재에서 2억 3천만원을 이적 예산에 보탤게",
      expected: { fund_transfer_budget: [{ amount: 230_000_000 }] },
    },
    {
      name: "seed-player",
      said: `${player.name}에게 등번호 9번을 줘`,
      expected: { set_squad_number: [{ playerId: player.id, number: 9 }] },
    },
  ];
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
    if (!LLM_CONFIG.instructions) blockers.push("Missing evaluators.instructions configuration");
    if (values.turn && !hasKey(agentConfig("gm").provider))
      blockers.push(`Missing GM credential: ${keyNamesFor(agentConfig("gm").provider)}`);
    if (blockers.length === 0 && LLM_CONFIG.instructions) {
      const config = LLM_CONFIG.instructions;
      const client = new TypesafeGameEvaluator(config);
      for (const testcase of cases) {
        console.log(`Evaluating synthetic ${testcase.name}`);
        const stages: Stage[] = [];
        const evaluator: GameEvaluator = {
          async evaluate(request) {
            const began = performance.now();
            try {
              const result = await client.evaluate(request);
              stages.push({
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
        let exactAgreement = false;
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
          exactAgreement =
            !answer.unresolved && stableJson(answer.ops) === stableJson(testcase.expected);
        } catch (error) {
          errorInfo = failure(error);
        }
        const usage = stages.reduce((total, stage) => addUsage(total, stage.usage), emptyUsage());
        const usageComplete = stages.every((stage) => stage.usageComplete);
        results.push({
          ...testcase,
          output,
          exactAgreement,
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
      if (values.turn) {
        for (const testcase of [cases[0]!, cases[2]!]) {
          console.log(`Evaluating full turn ${testcase.name}`);
          const game = freshGame();
          const beforePressing = tacticsOf(game, game.userTeamId).spec.pressing;
          const expectedPressing = testcase.name === "explicit-axis" ? 4 : beforePressing;
          await withGameUsage(`instruction-eval-${Date.now()}-${testcase.name}`, async () => {
            const began = performance.now();
            let calls: string[] = [];
            let sceneCharacters = 0;
            let errorInfo: ReturnType<typeof failure> | undefined;
            try {
              const result = await runGmTurn(game, testcase.said);
              calls = result.toolCalls.map((call) => call.name);
              sceneCharacters = result.text.length;
            } catch (error) {
              errorInfo = failure(error);
            }
            const afterPressing = tacticsOf(game, game.userTeamId).spec.pressing;
            const ledger = structuredClone(llmUsage());
            const commandCorrect =
              testcase.name === "explicit-axis"
                ? calls.includes("set_tactics")
                : !calls.includes("set_tactics");
            turns.push({
              name: testcase.name,
              said: testcase.said,
              expectedPressing,
              beforePressing,
              afterPressing,
              passed:
                !errorInfo &&
                commandCorrect &&
                afterPressing === expectedPressing &&
                sceneCharacters > 0,
              durationMs: performance.now() - began,
              sceneCharacters,
              calls,
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
    turnRequested: values.turn,
    scope:
      "Synthetic full peace catalog/context; interpretation-only cases plus optional isolated full GM turns. No recorded corpus or baseline comparison.",
    evaluator: LLM_CONFIG.instructions,
    gm: { provider: agentConfig("gm").provider, model: agentConfig("gm").model, prices: gmPrices },
    commandCount: commands.length,
    contextCharacters: context.length,
    contextSha256: createHash("sha256").update(context).digest("hex"),
    cases,
    blockers,
    results,
    turns,
    syntheticDuration: durationStats(results.map((item) => item.durationMs)),
    limitations: [
      "Five synthetic expectations do not establish production quality or improvement.",
      "Interpretation cases do not apply commands; full turns check only pressing behavior and scene presence, not narrative quality.",
      "All provider-reported failed attempt usage is retained. Unreported failure usage and hidden retries cannot be inferred.",
      "Full-turn ledger calls are logical calls, not HTTP attempts. Complete per-attempt accounting is available for direct synthetic evaluator stages only.",
      "Costs are supplied list-price estimates, not billed amounts; additional unpriced agents or failed turns have unknown total cost.",
    ],
  };
  const show = (value: number | null) => (value === null ? "n/a" : value.toFixed(6));
  const summary = [
    "# Direct instruction evaluation",
    "",
    `Mode: ${report.mode}; game version ${report.gameVersion}; ${commands.length} production peace commands; ${context.length} context characters.`,
    "",
    "| Synthetic case | Exact expected ops | Wall ms | Stages / attempts | Input / output tokens | USD estimate |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...results.map(
      (item) =>
        `| ${item.name} | ${item.exactAgreement} | ${item.durationMs.toFixed(2)} | ${item.stages.length} / ${item.stages.reduce((sum, stage) => sum + stage.attempts, 0)} | ${item.usage.inputTokens} / ${item.usage.outputTokens} | ${show(item.costUsd)} |`,
    ),
    "",
    "| Full-turn case | State + command + scene check | Wall ms | Logical calls | Input / output tokens | USD estimate |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...turns.map(
      (item) =>
        `| ${item.name} | ${item.passed} | ${item.durationMs.toFixed(2)} | ${item.usage.calls} | ${item.usage.usage.inputTokens} / ${item.usage.usage.outputTokens} | ${show(item.costUsd)} |`,
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
      results.some((item) => !item.exactAgreement) ||
      turns.some((item) => !item.passed))
  )
    process.exitCode = 1;
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Instruction evaluation failed");
  process.exitCode = 1;
});
