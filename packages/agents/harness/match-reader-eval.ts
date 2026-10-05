/**
 * Recorded-input comparison, offline unless --live is explicit.
 * pnpm exec tsx packages/agents/harness/match-reader-eval.ts --logs <dir> --out <dir>
 * Raw inputs are read in place; reports belong outside the source log tree.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  AGENT_NAMES,
  agentConfig,
  createGameLLM,
  gameVersion,
  hasKey,
  keyNamesFor,
  llmErrorKind,
  type LlmErrorKind,
  LLM_CONFIG,
  type GameEvaluator,
  type GameLLM,
  type JsonObjectSchema,
  type TurnUsage,
} from "@gaffer/llm";
import { ReaderReportSchema, type MatchReaderOutput } from "./reader-baseline";
import {
  addUsage,
  agreement,
  costUsd,
  durationStats,
  emptyUsage,
  type Prices,
} from "./match-reader-eval-metrics";

const UsageSchema = z.object({
  inputTokens: z.number().finite().nonnegative(),
  outputTokens: z.number().finite().nonnegative(),
  cacheReadTokens: z.number().finite().nonnegative(),
  cacheWriteTokens: z.number().finite().nonnegative(),
});
const CallSchema = z.object({
  id: z.string(),
  agent: z.string(),
  model: z.string().nullable().optional(),
  gameVersion: z.string().optional(),
  parentId: z.string().nullable().optional(),
  viaTool: z.string().nullable().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  request: z
    .object({
      user: z.string().optional(),
      outputSchema: z
        .object({ type: z.literal("object") })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
  response: z
    .object({
      output: z.unknown().optional(),
      usage: UsageSchema.optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  error: z.unknown().optional(),
});
type RecordedCall = z.infer<typeof CallSchema>;
interface ReplayCase {
  source: string;
  call: RecordedCall;
  user: string;
  schema: JsonObjectSchema;
  hasSaid: boolean;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve the existing ancestor too, so a nonexistent child of a symlink is protected. */
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(canonical(dirname(path)), relative(dirname(path), path));
}

function callFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    // Never follow symlinks out of the selected source tree.
    if (entry.isDirectory()) result.push(...callFiles(path));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      dirname(path).endsWith(`${sep}calls`)
    )
      result.push(path);
  }
  return result.sort();
}

const ReadingFactSchema = z.object({
  kind: z.literal("match.reading"),
  data: z.object({ occasion: z.string().optional() }),
});

function readingFacts(root: string) {
  let count = 0;
  let malformedLines = 0;
  const occasions: Record<string, number> = {};
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        ["turns", "board"].some((shelf) => dirname(path).endsWith(`${sep}${shelf}`))
      ) {
        for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            malformedLines++;
            continue;
          }
          const fact = ReadingFactSchema.safeParse(raw);
          if (!fact.success) continue;
          count++;
          const occasion = fact.data.data.occasion ?? "unknown";
          occasions[occasion] = (occasions[occasion] ?? 0) + 1;
        }
      }
    }
  }
  visit(root);
  return {
    count,
    occasions,
    malformedLines,
    note: "All retained match.reading facts, including possible mock runs. Call/fact counts are not a unique coverage rate: captures, failures and retries differ.",
  };
}

function inventory(root: string) {
  const agents: Record<string, number> = {};
  const calls: Array<{ source: string; call: RecordedCall }> = [];
  const skipped: Array<{ source: string; reason: string }> = [];
  const cases: ReplayCase[] = [];
  const inputHashes = new Set<string>();
  let repeatedInputs = 0;
  for (const file of callFiles(root)) {
    const source = relative(root, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      skipped.push({ source, reason: "Unreadable JSON" });
      continue;
    }
    const parsed = CallSchema.safeParse(raw);
    if (!parsed.success) {
      skipped.push({ source, reason: "Invalid trace metadata" });
      continue;
    }
    const call = parsed.data;
    agents[call.agent] = (agents[call.agent] ?? 0) + 1;
    if (call.agent !== "match-reader") continue;
    calls.push({ source, call });
    const { user, outputSchema } = call.request ?? {};
    const output = ReaderReportSchema.safeParse(call.response?.output);
    if (
      !user ||
      !outputSchema ||
      !output.success ||
      !output.data.points ||
      !output.data.sheet ||
      call.error
    ) {
      skipped.push({
        source,
        reason:
          "Not replayable: input/schema/validated points and sheet missing, or recorded error",
      });
      continue;
    }
    const hash = createHash("sha256")
      .update(JSON.stringify([user, outputSchema]))
      .digest("hex");
    if (inputHashes.has(hash)) {
      repeatedInputs++;
      continue;
    }
    inputHashes.add(hash);
    cases.push({
      source,
      call,
      user,
      schema: outputSchema,
      hasSaid: /(?:^|\n)@감독:\s*\S/u.test(user),
    });
  }
  return { agents, calls, skipped, cases, repeatedInputs };
}

interface RunMeasurement {
  success: boolean;
  durationMs: number;
  proseCalls: number;
  proseCallDurationsMs: number[];
  proseRequestHashes: Array<{ system: string; schema: string }>;
  proseUsage: TurnUsage;
  evaluatorUsage: TurnUsage;
  evaluatorAttempts: number;
  usageComplete: boolean;
  costUsd: number | null;
  reading?: MatchReaderOutput;
  evaluations?: unknown[];
  failure?: string;
  failureKind?: LlmErrorKind;
  evaluatorFailure?: string;
}

async function replay(
  input: ReplayCase,
  client: GameLLM,
  evaluator: GameEvaluator | undefined,
  prices: Prices,
): Promise<RunMeasurement> {
  const { runReaderPipeline } = await import("./reader-pipeline");
  let proseUsage = emptyUsage();
  let evaluatorUsage = emptyUsage();
  let usageComplete = true;
  let evaluatorAttempts = 0;
  let evaluatorFailure: string | undefined;
  const proseCallDurationsMs: number[] = [];
  const proseRequestHashes: Array<{ system: string; schema: string }> = [];
  const llm: GameLLM = {
    async runTurn(request) {
      proseRequestHashes.push({
        system: createHash("sha256").update(JSON.stringify(request.system)).digest("hex"),
        schema: createHash("sha256").update(JSON.stringify(request.outputSchema)).digest("hex"),
      });
      let observed = false;
      const began = performance.now();
      try {
        const result = await client.runTurn({
          ...request,
          onUsage(delta) {
            observed = true;
            proseUsage = addUsage(proseUsage, delta);
            request.onUsage?.(delta);
          },
        });
        if (!observed) proseUsage = addUsage(proseUsage, result.usage);
        return result;
      } catch (error) {
        // Providers may have consumed tokens without reporting usage on failed requests.
        usageComplete = false;
        throw error;
      } finally {
        proseCallDurationsMs.push(performance.now() - began);
      }
    },
  };
  const measuredEvaluator: GameEvaluator | undefined = evaluator && {
    async evaluate(request) {
      try {
        const result = await evaluator.evaluate(request);
        evaluatorUsage = addUsage(evaluatorUsage, result.usage);
        evaluatorAttempts += result.attempts ?? 1;
        usageComplete &&= result.usageComplete !== false;
        return result;
      } catch (error) {
        const { TypesafeEvaluationError } = await import("../../llm/src/typesafe-adapter");
        if (error instanceof TypesafeEvaluationError) {
          // This adapter builds its messages locally and never includes response/request bodies.
          evaluatorFailure = error.message;
          evaluatorUsage = addUsage(evaluatorUsage, error.usage);
          evaluatorAttempts += error.attempts;
          usageComplete &&= error.usageComplete;
        } else {
          evaluatorAttempts++;
          usageComplete = false;
        }
        throw error;
      }
    },
  };
  const began = performance.now();
  let reading: MatchReaderOutput | undefined;
  let evaluations: unknown[] | undefined;
  let failure: string | undefined;
  let failureKind: LlmErrorKind | undefined;
  try {
    const result = await runReaderPipeline({
      llm,
      user: input.user,
      schema: input.schema,
      evaluator: measuredEvaluator,
    });
    reading = result.reading;
    evaluations = result.evaluations;
  } catch (error) {
    // Generic provider messages can contain request fragments; retain only class and kind.
    failure = error instanceof Error ? error.name : "UnknownError";
    failureKind = llmErrorKind(error);
  }
  const proseCost = usageComplete ? costUsd(proseUsage, prices) : null;
  const evaluatorCost =
    (evaluatorUsage.inputTokens *
      (LLM_CONFIG.evaluators["match-reader"]?.inputUsdPerMillion ?? 0)) /
    1_000_000;
  return {
    success: reading !== undefined,
    durationMs: performance.now() - began,
    proseCalls: proseCallDurationsMs.length,
    proseCallDurationsMs,
    proseRequestHashes,
    proseUsage,
    evaluatorUsage,
    evaluatorAttempts,
    usageComplete,
    costUsd: proseCost === null ? null : proseCost + evaluatorCost,
    reading,
    evaluations,
    failure,
    failureKind,
    evaluatorFailure,
  };
}

function aggregate(runs: RunMeasurement[]) {
  return {
    attempted: runs.length,
    succeeded: runs.filter((run) => run.success).length,
    duration: durationStats(runs.map((run) => run.durationMs)),
    successfulDuration: durationStats(
      runs.filter((run) => run.success).map((run) => run.durationMs),
    ),
    proseCalls: runs.reduce((sum, run) => sum + run.proseCalls, 0),
    evaluatorAttempts: runs.reduce((sum, run) => sum + run.evaluatorAttempts, 0),
    proseUsage: runs.reduce((sum, run) => addUsage(sum, run.proseUsage), emptyUsage()),
    evaluatorUsage: runs.reduce((sum, run) => addUsage(sum, run.evaluatorUsage), emptyUsage()),
    usageComplete: runs.every((run) => run.usageComplete),
    costUsd:
      runs.length && runs.every((run) => run.costUsd !== null)
        ? runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0)
        : null,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      logs: { type: "string" },
      out: { type: "string" },
      live: { type: "boolean", default: false },
      "baseline-agent": { type: "string" },
      limit: { type: "string" },
      "input-usd-per-million": { type: "string" },
      "output-usd-per-million": { type: "string" },
      "cached-input-usd-per-million": { type: "string" },
    },
  });
  if (!values.logs || !values.out)
    throw new Error(
      "Required: --logs <directory> --out <directory> [--live --baseline-agent <configured agent>] [--limit N]",
    );
  const root = realpathSync(resolve(values.logs));
  const out = canonical(resolve(values.out));
  if (inside(root, out))
    throw new Error("Output cannot be inside source logs (including symlink descendants)");
  for (const name of ["report.json", "summary.md"]) {
    const target = join(out, name);
    if (existsSync(target))
      throw new Error("Output files already exist; choose a fresh output directory");
  }
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    throw new Error("--limit must be a positive integer");
  function price(
    key: "input-usd-per-million" | "output-usd-per-million" | "cached-input-usd-per-million",
  ) {
    const raw = values[key];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${key}`);
    return value;
  }
  const prices = {
    input: price("input-usd-per-million"),
    output: price("output-usd-per-million"),
    cachedInput: price("cached-input-usd-per-million"),
  };
  const baselineAgent = AGENT_NAMES.find((name) => name === values["baseline-agent"]);
  if (values["baseline-agent"] && !baselineAgent)
    throw new Error(`--baseline-agent must be one of: ${AGENT_NAMES.join(", ")}`);
  const baselineConfig = baselineAgent ? agentConfig(baselineAgent) : undefined;
  const currentGameVersion = gameVersion();
  const data = inventory(root);
  const facts = readingFacts(root);
  const historicalUsage = data.calls.reduce(
    (sum, { call }) => addUsage(sum, call.response?.usage ?? emptyUsage()),
    emptyUsage(),
  );
  const historical = {
    recordedCalls: data.calls.length,
    duration: durationStats(
      data.calls.flatMap(({ call }) => (call.durationMs === undefined ? [] : [call.durationMs])),
    ),
    usage: historicalUsage,
    usageMissingCalls: data.calls.filter(({ call }) => !call.response?.usage).length,
    failures: data.calls.filter(({ call }) => Boolean(call.error)).length,
    versions: [...new Set(data.calls.map(({ call }) => call.gameVersion ?? "unknown"))],
    models: [...new Set(data.calls.map(({ call }) => call.model ?? "unknown"))],
    recordedInstructionCalls: data.calls.filter(({ call }) =>
      /(?:^|\n)@감독:\s*\S/u.test(call.request?.user ?? ""),
    ).length,
    replayInstructionInputs: data.cases.filter((input) => input.hasSaid).length,
    replayNoUtteranceInputs: data.cases.filter((input) => !input.hasSaid).length,
    uniqueReplayInputs: data.cases.length,
    repeatedReplayInputs: data.repeatedInputs,
    costUsd: null,
    costNote:
      "Historical provider/date rates are unavailable; current CLI rates apply only to current replay.",
    retryNote:
      "All recorded calls are counted, including failures/repeated inputs. SDK-internal retries are not observable in historical traces; repeated input does not prove retry.",
    calls: data.calls.map(({ source, call }) => ({
      source,
      id: call.id,
      parentId: call.parentId,
      viaTool: call.viaTool,
      model: call.model,
      gameVersion: call.gameVersion,
      durationMs: call.durationMs,
      usage: call.response?.usage,
      failed: Boolean(call.error),
    })),
  };
  const blockers: string[] = [];
  const pairs: Array<{
    source: string;
    hasSaid: boolean;
    baseline: RunMeasurement;
    candidate: RunMeasurement;
    agreement: ReturnType<typeof agreement> | null;
  }> = [];
  if (values.live) {
    try {
      process.loadEnvFile(join(import.meta.dirname, "../../../apps/web/.env.local"));
    } catch {
      /* Environment-only invocation is supported. */
    }
    if (!baselineConfig) blockers.push("--baseline-agent is required for --live");
    if (!process.env.TYPESAFE_API_KEY?.trim()) blockers.push("Missing TYPESAFE_API_KEY");
    if (baselineConfig && !hasKey(baselineConfig.provider))
      blockers.push(`Missing baseline credential: ${keyNamesFor(baselineConfig.provider)}`);
    if (!LLM_CONFIG.evaluators["match-reader"])
      blockers.push("Missing evaluators.match-reader configuration");
    if (!data.cases.length) blockers.push("No replayable recorded inputs");
    if (!blockers.length && baselineConfig && LLM_CONFIG.evaluators["match-reader"]) {
      const { TypesafeGameEvaluator } = await import("../../llm/src/typesafe-adapter");
      const client = createGameLLM(baselineConfig);
      const evaluator = new TypesafeGameEvaluator(LLM_CONFIG.evaluators["match-reader"]);
      for (const [index, input] of data.cases.slice(0, limit).entries()) {
        console.log(
          `Replaying pair ${index + 1}/${Math.min(limit ?? data.cases.length, data.cases.length)}`,
        );
        // Counterbalance ordering to reduce systematic warm-cache/order bias.
        const first = await replay(input, client, index % 2 === 0 ? undefined : evaluator, prices);
        const second = await replay(input, client, index % 2 === 0 ? evaluator : undefined, prices);
        const [baseline, candidate] = index % 2 === 0 ? [first, second] : [second, first];
        pairs.push({
          source: input.source,
          hasSaid: input.hasSaid,
          baseline: baseline!,
          candidate: candidate!,
          agreement:
            baseline!.reading && candidate!.reading
              ? agreement(baseline!.reading, candidate!.reading)
              : null,
        });
      }
    }
  }
  const baseline = aggregate(pairs.map((pair) => pair.baseline));
  const candidate = aggregate(pairs.map((pair) => pair.candidate));
  const pairedSuccess = pairs.filter((pair) => pair.baseline.success && pair.candidate.success);
  const savings = pairedSuccess.map((pair) => pair.baseline.durationMs - pair.candidate.durationMs);
  const comparisons = pairs.flatMap((pair) => (pair.agreement ? [pair.agreement] : []));
  const matchedRows = comparisons.reduce((sum, item) => sum + item.matchedRows, 0);
  const unmatchedBaselineRows = comparisons.reduce(
    (sum, item) => sum + item.unmatchedBaselineRows,
    0,
  );
  const unmatchedCandidateRows = comparisons.reduce(
    (sum, item) => sum + item.unmatchedCandidateRows,
    0,
  );
  const unionRows = matchedRows + unmatchedBaselineRows + unmatchedCandidateRows;
  const agreementSummary = {
    comparedPairs: comparisons.length,
    structuralJaccard: unionRows ? matchedRows / unionRows : null,
    matchedRows,
    unmatchedBaselineRows,
    unmatchedCandidateRows,
    stepMeanAbsoluteError: matchedRows
      ? comparisons.reduce(
          (sum, item) => sum + (item.stepMeanAbsoluteError ?? 0) * item.matchedRows,
          0,
        ) / matchedRows
      : null,
  };
  const failureCounts: Record<string, number> = {};
  for (const pair of pairs) {
    for (const side of ["baseline", "candidate"] as const) {
      const run = pair[side];
      if (run.success) continue;
      const label = `${side}: ${run.evaluatorFailure ?? run.failure ?? "UnknownError"} (${run.failureKind ?? "unknown"})`;
      failureCounts[label] = (failureCounts[label] ?? 0) + 1;
    }
  }
  const live = {
    requested: values.live,
    gameVersion: currentGameVersion,
    failures: failureCounts,
    blockers,
    baselineAgent: baselineAgent ?? null,
    baselineConfig: baselineConfig ?? null,
    baselineModel: baselineConfig?.model ?? null,
    evaluatorModel: LLM_CONFIG.evaluators["match-reader"]?.model,
    prices,
    agreement: agreementSummary,
    baseline,
    candidate,
    pairedSuccessful: pairedSuccess.length,
    instructionPairs: pairs.filter((pair) => pair.hasSaid).length,
    noUtterancePairs: pairs.filter((pair) => !pair.hasSaid).length,
    meanPairedLatencySavedMs: savings.length
      ? savings.reduce((a, b) => a + b, 0) / savings.length
      : null,
    pairs,
  };
  const limitations = [
    "Harness-only historical experiment: prose chooses points and sheet structure; Jev evaluates sheet strength only. Neither replay path emits or compares commands. This is not the production Jev-only match reader. Candidate latency includes both stages and observable retries.",
    "Historical traces use their original prompts/models. Paired replay uses the harness baseline prompt and the explicitly selected configured agent, including its current output limit and timeout; it does not reproduce historical provider settings or production prompts.",
    "Replay retains recorded input and point/sheet descriptions, replaces item schemas with current domain schemas, and discards all other output fields. Historical input versions may not represent the current game.",
    "Agreement is not correctness. Sheet match requires exact structure and normalized point text; unmatched paraphrases require manual review. Empty-sheet overlap is undefined. Command quality is not measured.",
    "Blind Korean quality review (football grounding, tradeoffs, instruction fidelity, player facts) and sufficient representative samples are required before adoption. No automated adoption decision is made.",
    "Repeated inputs are replayed once; all original calls remain in historical counts. Samples are deterministic by source path, not randomly selected.",
    "Provider SDK retries may be hidden inside a prose call; wall time includes them, while failed unreported usage makes cost unknown. Prices are operator-supplied for current prose replay only.",
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    mode: values.live ? "live" : "offline",
    agents: data.agents,
    readingFacts: facts,
    historical,
    skipped: data.skipped,
    live,
    limitations,
  };
  function show(value: number | null) {
    return value === null ? "n/a" : value.toFixed(2);
  }
  const markdown = [
    "# Match-reader recorded-input evaluation",
    "",
    `Mode: ${report.mode}. ${Object.values(data.agents).reduce((a, b) => a + b, 0)} validated call records across agents; ${historical.recordedCalls} match-reader records; ${data.cases.length} unique replayable inputs.`,
    "",
    `Baseline agent: ${live.baselineAgent ?? "not selected (offline)"}; model: ${live.baselineModel ?? "n/a"}; max output tokens: ${baselineConfig?.maxTokens ?? "n/a"}; timeout ms: ${baselineConfig?.timeoutMs ?? "n/a"}.`,
    "",
    "| Measurement | Historical recorded calls | Harness baseline | Harness prose + Jev |",
    "| --- | ---: | ---: | ---: |",
    `| Observations (attempted) | ${historical.duration.n} | ${baseline.attempted} | ${candidate.attempted} |`,
    `| Succeeded / failed | ${historical.recordedCalls - historical.failures} / ${historical.failures} | ${baseline.succeeded} / ${baseline.attempted - baseline.succeeded} | ${candidate.succeeded} / ${candidate.attempted - candidate.succeeded} |`,
    `| Prose calls / evaluator attempts | n/a | ${baseline.proseCalls} / ${baseline.evaluatorAttempts} | ${candidate.proseCalls} / ${candidate.evaluatorAttempts} |`,
    `| Wall latency p50 ms | ${show(historical.duration.p50Ms)} | ${show(baseline.duration.p50Ms)} | ${show(candidate.duration.p50Ms)} |`,
    `| Wall latency p95 ms | ${show(historical.duration.p95Ms)} | ${show(baseline.duration.p95Ms)} | ${show(candidate.duration.p95Ms)} |`,
    `| Total cost USD | n/a | ${baseline.costUsd ?? "n/a"} | ${candidate.costUsd ?? "n/a"} |`,
    `| Paired structural Jaccard | n/a | reference | ${show(agreementSummary.structuralJaccard)} |`,
    `| Matched-row strength MAE | n/a | reference | ${show(agreementSummary.stepMeanAbsoluteError)} |`,
    "",
    `Paired successful comparisons: ${pairedSuccess.length}. Mean paired latency saved: ${show(live.meanPairedLatencySavedMs)} ms.`,
    "",
    `Historical input/output/cache-read tokens: ${historicalUsage.inputTokens}/${historicalUsage.outputTokens}/${historicalUsage.cacheReadTokens}; missing usage: ${historical.usageMissingCalls}; recorded failures: ${historical.failures}.`,
    "",
    `Historical versions: ${historical.versions.join(", ")}. Models: ${historical.models.join(", ")}.`,
    "",
    `Skipped records: ${data.skipped.length}. Repeated replay inputs: ${data.repeatedInputs}. Detailed reasons and per-call metadata are in report.json.`,
    "",
    `Replayable sample: ${historical.replayInstructionInputs} instruction inputs, ${historical.replayNoUtteranceInputs} without utterance. Live attempted pairs: ${live.instructionPairs} instruction, ${live.noUtterancePairs} without utterance.`,
    "",
    ...(blockers.length
      ? ["Live blockers:", "", ...blockers.map((blocker) => `- ${blocker}`), ""]
      : []),
    ...(Object.keys(failureCounts).length
      ? [
          "Observed failures:",
          "",
          ...Object.entries(failureCounts).map(([reason, count]) => `- ${count}: ${reason}`),
          "",
        ]
      : []),
    `Retained match.reading facts: ${facts.count}; occasions: ${Object.entries(facts.occasions)
      .map(([name, count]) => `${name}=${count}`)
      .join(
        ", ",
      )}. These may include mock runs; ${historical.recordedCalls} calls / ${facts.count} facts is not a unique capture-coverage rate.`,
    "",
    `Structural agreement: ${agreementSummary.matchedRows} matched rows, ${agreementSummary.unmatchedBaselineRows}/${agreementSummary.unmatchedCandidateRows} unmatched baseline/candidate rows; matched strength MAE ${show(agreementSummary.stepMeanAbsoluteError)}. Commands are not emitted or compared. Agreement is not correctness.`,
    "",
    "Limitations:",
    "",
    ...limitations.map((limitation) => `- ${limitation}`),
    "",
  ].join("\n");
  mkdirSync(out, { recursive: true });
  // Exclusive creation prevents overwriting a concurrently-created file or following its symlink.
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  writeFileSync(join(out, "summary.md"), markdown, { flag: "wx" });
  console.log(markdown);
  if (
    values.live &&
    (blockers.length > 0 || pairs.some((pair) => !pair.baseline.success || !pair.candidate.success))
  )
    process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed");
  process.exitCode = 1;
});
