/** Opt-in generated-fixture evaluation; no save, journal or trace scope is opened. */
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
  TrainingReportSchema,
  ATTRIBUTE_AXES,
  RATING_MAX,
  PROFICIENCY_MAX,
  PROFICIENCY_MIN,
  FAMILIARITY_MAX,
} from "@gaffer/domain";
import {
  addDays,
  advanceTime,
  applyTrainingOutcomes,
  trainingSlots,
  assignmentsOf,
  buildTrainingBrief,
  createGame,
  setPlayerTraining,
  setTraining,
  squadReturnOf,
  trainingSettled,
  type GameState,
  type TrainingBrief,
} from "@gaffer/engine";
import {
  addUsage,
  emptyUsage,
  gameVersion,
  llmErrorKind,
  LLM_CONFIG,
  TypesafeEvaluationError,
  TypesafeGameEvaluator,
  type GameEvaluator,
  type TurnUsage,
} from "@gaffer/llm";
import { buildTrainingRequest, evaluateTraining } from "../src/evaluators/training-rater";
import { ModelOutputError } from "../src/shared/retry";
import { stableJson } from "./match-reader-eval-metrics";

const ROOT = resolve(import.meta.dirname, "../../..");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function canonical(path: string): string {
  return existsSync(path)
    ? realpathSync(path)
    : join(canonical(dirname(path)), relative(dirname(path), path));
}
function freshOutput(raw: string): string {
  const path = resolve(raw);
  const actual = canonical(path);
  const temp = realpathSync("/tmp");
  if (!actual.startsWith(`${temp}${sep}`))
    throw new Error("--out must be a fresh directory below /tmp");
  for (const candidate of [path, actual]) {
    if (candidate.split(sep).some((part) => [".log", ".data"].includes(part.toLowerCase())))
      throw new Error("Output in .log or .data is forbidden, including symlink descendants");
  }
  if (existsSync(path)) throw new Error("--out already exists; use a fresh directory");
  mkdirSync(dirname(actual), { recursive: true });
  mkdirSync(actual);
  return actual;
}
function fingerprint() {
  function files(folder: string): string[] {
    return readdirSync(join(ROOT, folder), { withFileTypes: true }).flatMap((entry) => {
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
    "packages/agents/harness/training-eval.ts",
  ].sort();
  const sha256ByPath = Object.fromEntries(
    paths.map((path) => [path, hash(readFileSync(join(ROOT, path)))]),
  );
  return { sha256: hash(stableJson(sha256ByPath)), sha256ByPath };
}
/** 픽스처가 까는 훈련 날짜 수 — 판정 하나에 날짜가 여럿 실린다 */
const TRAINING_DAYS = 3;

function fixture(): { state: GameState; brief: TrainingBrief } {
  const state = createGame({
    seed: 42,
    userTeamId: "arsenal",
    managerName: "김감독",
    background: "주장 출신 감독",
  });
  state.date = squadReturnOf(state.calendar);
  const matchDates = new Set(
    state.matches
      .filter(
        (match) => match.homeTeamId === state.userTeamId || match.awayTeamId === state.userTeamId,
      )
      .map((match) => match.date),
  );
  // 여러 훈련 날짜가 한 판정에 실려야 날짜별 능력치 질문이 잰다
  const busy = (from: string) =>
    Array.from({ length: TRAINING_DAYS }, (_, i) => addDays(from, i + 1)).some((day) =>
      matchDates.has(day),
    );
  for (let attempts = 0; busy(state.date) && attempts < 60; attempts++)
    state.date = addDays(state.date, 1);
  const player = state.players.find(
    (item) => item.teamId === state.userTeamId && item.squadLevel !== "reserve",
  );
  if (!player) throw new Error("Fixture has no first-team player");
  const personal = setPlayerTraining(state, {
    playerId: player.id,
    axis: "stamina",
    position: "CM",
  });
  if (!personal.ok) throw new Error("Fixture personal training was rejected");
  const from = state.date;
  const training = setTraining(state, {
    sessions: Array.from({ length: TRAINING_DAYS }, (_, i) => ({
      date: addDays(from, i + 1),
      slot: "am" as const,
      label: "전술 조직과 체력 훈련",
      focus: ["tactical" as const, "stamina" as const],
    })),
  });
  if (!training.ok) throw new Error("Fixture training was rejected");
  const progressed = advanceTime(state, { days: TRAINING_DAYS });
  const sessions = progressed.trained?.sessions ?? [];
  const brief = buildTrainingBrief(state, sessions, { from, to: state.date });
  if (
    !brief ||
    !sessions.length ||
    !sessions.every((session) =>
      state.schedule.some((entry) => entry.id === session.entryId && entry.status === "done"),
    )
  )
    throw new Error("Fixture did not execute real training sessions");
  return { state, brief };
}
function failure(error: unknown) {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    kind: llmErrorKind(error),
    ...(error instanceof TypesafeEvaluationError || error instanceof ModelOutputError
      ? { detail: error.message }
      : {}),
  };
}
interface Stage {
  requestSha256: string;
  questions: number;
  durationMs: number;
  attempts: number;
  usage: TurnUsage;
  usageComplete: boolean;
  failure?: ReturnType<typeof failure>;
}
async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      live: { type: "boolean", default: false },
      case: { type: "string" },
    },
  });
  if (!values.out)
    throw new Error("Required: --out /tmp/<fresh-directory> [--live] [--case small|full-squad]");
  if (values.case && !["small", "full-squad"].includes(values.case))
    throw new Error("Unknown --case");
  const out = freshOutput(values.out);
  const source = fingerprint();
  const config = LLM_CONFIG.evaluators["training-rater"];
  const blockers: string[] = [];
  if (values.live) {
    const env = join(ROOT, "apps/web/.env.local");
    if (existsSync(env)) process.loadEnvFile(env);
    if (!process.env.TYPESAFE_API_KEY?.trim()) blockers.push("Missing TYPESAFE_API_KEY");
    if (!config) blockers.push("Missing evaluators.training-rater config");
  }
  const original = fixture();
  const results = [];
  for (const name of ["small", "full-squad"] as const) {
    if (values.case && values.case !== name) continue;
    const state = structuredClone(original.state);
    const brief = structuredClone(original.brief);
    if (name === "small") brief.subjects = brief.subjects.slice(0, 3);
    const request = buildTrainingRequest(brief);
    const inventory = {
      name,
      subjects: brief.subjects.length,
      originalSubjects: original.brief.subjects.length,
      sessions: brief.sessions.length,
      trainedAxes: brief.trainedAxes,
      personalPositionSubjects: brief.subjects.filter((subject) => subject.program?.position)
        .length,
      stateCharacters: request.state.length,
      requestSha256: hash(stableJson(request)),
      questions: Object.keys(request.questions).length,
      questionTypes: Object.values(request.questions).reduce<Record<string, number>>(
        (counts, question) => {
          counts[question.type] = (counts[question.type] ?? 0) + 1;
          return counts;
        },
        {},
      ),
    };
    if (!values.live || blockers.length || !config) {
      results.push({ ...inventory, measured: false });
      continue;
    }
    console.log(`Evaluating generated training fixture: ${name}`);
    const stages: Stage[] = [];
    const client = new TypesafeGameEvaluator(config);
    const evaluator: GameEvaluator = {
      async evaluate(input) {
        const began = performance.now();
        const stage = {
          requestSha256: hash(stableJson(input)),
          questions: Object.keys(input.questions).length,
        };
        try {
          const result = await client.evaluate(input);
          stages.push({
            ...stage,
            durationMs: performance.now() - began,
            attempts: result.attempts,
            usage: result.usage,
            usageComplete: result.usageComplete,
          });
          return result;
        } catch (error) {
          stages.push({
            ...stage,
            durationMs: performance.now() - began,
            attempts: error instanceof TypesafeEvaluationError ? error.attempts : 1,
            usage: error instanceof TypesafeEvaluationError ? error.usage : emptyUsage(),
            usageComplete: error instanceof TypesafeEvaluationError && error.usageComplete,
            failure: failure(error),
          });
          throw error;
        }
      },
    };
    const beforeLog = state.growthLog.length;
    const began = performance.now();
    let measurement: Record<string, unknown>;
    try {
      const outcomes = await evaluateTraining(brief, evaluator);
      const card = applyTrainingOutcomes(state, brief, outcomes);
      const durationMs = performance.now() - began;
      const moved =
        card?.moved.map((entry) => `${entry.gamePlayerId}:${entry.target}:${entry.delta}`).sort() ??
        [];
      const logged = state.growthLog
        .slice(beforeLog)
        .map((entry) => `${entry.gamePlayerId}:${entry.target}:${entry.delta}`)
        .sort();
      const allInBounds =
        state.players
          .filter((player) => player.teamId === state.userTeamId)
          .every(
            (player) =>
              ATTRIBUTE_AXES.every(
                (axis) =>
                  Number.isFinite(player.attributes[axis]) &&
                  player.attributes[axis] >= 1 &&
                  player.attributes[axis] <= RATING_MAX,
              ) &&
              player.positions.every(
                (position) =>
                  position.proficiency >= PROFICIENCY_MIN &&
                  position.proficiency <= PROFICIENCY_MAX,
              ),
          ) &&
        assignmentsOf(state, state.userTeamId).every(
          (assignment) => assignment.familiarity >= 0 && assignment.familiarity <= FAMILIARITY_MAX,
        );
      const after = stableJson(state);
      const repeated = applyTrainingOutcomes(state, brief, outcomes);
      const checks = {
        cardSchema: TrainingReportSchema.safeParse(card).success,
        allSubjectsAnswered: outcomes.length === brief.subjects.length,
        subjectsOnly: outcomes.every((outcome) =>
          brief.subjects.some((subject) => subject.playerId === outcome.playerId),
        ),
        noDuplicateSubjects:
          new Set(outcomes.map((outcome) => outcome.playerId)).size === outcomes.length,
        attributeDatesInSlots: outcomes.every((outcome) =>
          (outcome.attributes ?? []).every((change) =>
            trainingSlots(brief).some((slot) => slot.date === change.date),
          ),
        ),
        cardMatchesGrowthLedger: stableJson(moved) === stableJson(logged),
        playerValuesInBounds: allInBounds,
        settled: trainingSettled(state, brief),
        idempotent: repeated === null && stableJson(state) === after,
      };
      measurement = {
        durationMs,
        outcomes: outcomes.length,
        moved: card?.moved.length ?? 0,
        marks: card?.marks.length ?? 0,
        checks,
        passed: Object.values(checks).every(Boolean),
      };
    } catch (error) {
      measurement = {
        durationMs: performance.now() - began,
        passed: false,
        failure: failure(error),
      };
    }
    let usage = emptyUsage();
    for (const stage of stages) usage = addUsage(usage, stage.usage);
    const usageComplete = stages.length > 0 && stages.every((stage) => stage.usageComplete);
    results.push({
      ...inventory,
      measured: true,
      ...measurement,
      stages,
      requests: stages.length,
      attempts: stages.reduce((total, stage) => total + stage.attempts, 0),
      usage,
      usageComplete,
      costUsd: usageComplete ? (usage.inputTokens * config.inputUsdPerMillion) / 1_000_000 : null,
    });
  }
  const sourceAtEndSha256 = fingerprint().sha256;
  if (sourceAtEndSha256 !== source.sha256)
    blockers.push(
      "Runtime sources changed during evaluation; measurements do not represent one stable revision",
    );
  const report = {
    generatedAt: new Date().toISOString(),
    mode: values.live ? "live" : "offline",
    gameVersion: gameVersion(),
    fixture:
      "Generated fixed-seed 42 Arsenal game, actual one-day engine training; small case evaluates a three-subject subset on an independent clone. Not recorded user data.",
    config,
    source,
    sourceAtEndSha256,
    blockers,
    results,
    limitations: [
      "One observation per generated case; no quality, correctness, adoption, speedup or baseline cost claim.",
      "Core boundary checks validate safe application, not whether the model judged training correctly.",
      "Total latency includes evaluateTraining and applyTrainingOutcomes; excludes fixture creation and post-run invariant checks.",
      "No GM narration, save, trace or disk journal is exercised. Failed calls retain reported usage; incomplete provider usage makes dollar cost unknown.",
    ],
  };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  const rows = results.map((row) => {
    const measured = row as typeof row & {
      durationMs?: number;
      passed?: boolean;
      requests?: number;
      attempts?: number;
      costUsd?: number | null;
    };
    return `| ${row.name} | ${row.subjects} | ${row.questions} | ${measured.durationMs?.toFixed(1) ?? "n/a"} | ${measured.requests ?? "n/a"}/${measured.attempts ?? "n/a"} | ${measured.costUsd?.toFixed(8) ?? "unknown"} | ${measured.passed === undefined ? "not measured" : measured.passed ? "pass" : "fail"} |`;
  });
  writeFileSync(
    join(out, "summary.md"),
    [
      `# Generated training evaluation`,
      ``,
      `Mode: ${report.mode}; game version: ${report.gameVersion}; generated: ${report.generatedAt}`,
      ``,
      `Source SHA-256: ${source.sha256}`,
      ``,
      `| Case | Subjects | Questions | Total ms | Requests/attempts | USD | Boundary checks |`,
      `| --- | ---: | ---: | ---: | --- | ---: | --- |`,
      ...rows,
      ``,
      ...blockers.map((blocker) => `Blocker: ${blocker}`),
      ``,
      ...report.limitations.map((line) => `- ${line}`),
      ``,
    ].join("\n"),
  );
  console.log(`Report: ${join(out, "report.json")}`);
  if (blockers.length || results.some((row) => "passed" in row && row.passed === false))
    process.exitCode = 1;
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Training evaluation failed");
  process.exitCode = 1;
});
