/** Generated deterministic-match smoke; no save, trace or journal is opened. */
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
import { ATTRIBUTE_AXES } from "@story-fm/domain";
import {
  advanceTime,
  advanceLiveMatch,
  advanceShootout,
  awaitingShootout,
  assignmentsOf,
  buildRatingBrief,
  createGame,
  finalizeMatch,
  markEntered,
  matchRated,
  resumeLiveInterval,
  settleMatchRating,
  startMatch,
  RATING_MIN,
  RATING_MAX,
  RATING_BAND,
} from "@story-fm/engine";
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
} from "@story-fm/llm";
import { liveFinished, LIVE_TICKS_PER_SECOND } from "@story-fm/sim";
import { buildSettlementRequest, evaluateSettlement } from "../src/match/finalize-match";
import { ModelOutputError } from "../src/common/retry";
import { stableJson } from "./match-reader-eval-metrics";

const ROOT = resolve(import.meta.dirname, "../../..");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function canonical(path: string): string {
  return existsSync(path)
    ? realpathSync(path)
    : join(canonical(dirname(path)), relative(dirname(path), path));
}
function freshOutput(raw: string) {
  const path = resolve(raw),
    actual = canonical(path);
  if (!actual.startsWith(`${realpathSync("/tmp")}${sep}`))
    throw new Error("--out must be below /tmp");
  if (
    [path, actual].some((item) =>
      item.split(sep).some((part) => [".log", ".data"].includes(part.toLowerCase())),
    )
  )
    throw new Error("Output in .log or .data is forbidden, including symlinks");
  if (existsSync(path)) throw new Error("--out must be a fresh directory");
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
    "packages/agents/harness/settlement-eval.ts",
  ].sort();
  const sha256ByPath = Object.fromEntries(
    paths.map((path) => [path, hash(readFileSync(join(ROOT, path)))]),
  );
  return { sha256: hash(stableJson(sha256ByPath)), sha256ByPath };
}
function fixture() {
  const state = createGame({
    seed: 42,
    userTeamId: "arsenal",
    managerName: "김감독",
    background: "주장 출신 감독",
  });
  for (let guard = 0; guard < 30; guard++) {
    const advanced = advanceTime(state, "next_match");
    if (!advanced.ok) throw new Error("Fixture could not advance to matchday");
    if (advanced.stopped !== "attention") break;
  }
  if (!startMatch(state).ok) throw new Error("Fixture match did not start");
  markEntered(state);
  let completed = false;
  for (let guard = 0; guard < 400; guard++) {
    const pending = state.pendingMatch;
    if (!pending) throw new Error("Fixture match disappeared");
    if (liveFinished(pending.live)) {
      if (!awaitingShootout(state)) {
        completed = true;
        break;
      }
      if (!advanceShootout(state).ok) throw new Error("Fixture shootout failed");
    } else {
      if (pending.live.state.interval) resumeLiveInterval(state);
      advanceLiveMatch(state, 5 * 60 * LIVE_TICKS_PER_SECOND);
    }
  }
  if (!completed) throw new Error("Fixture match did not finish");
  const brief = buildRatingBrief(state);
  if (!brief?.players.length) throw new Error("Fixture has no participants");
  finalizeMatch(state);
  const ratings = state.matches.find((match) => match.id === brief.matchId)?.result?.ratings;
  if (!ratings || brief.players.some((player) => ratings[player.playerId] !== player.anchor))
    throw new Error("Core anchors disagree with pre-finalize brief");
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
  durationMs: number;
  questions: number;
  attempts: number;
  usage: TurnUsage;
  usageComplete: boolean;
  failure?: ReturnType<typeof failure>;
}
async function main() {
  const { values } = parseArgs({
    options: { out: { type: "string" }, live: { type: "boolean", default: false } },
  });
  if (!values.out) throw new Error("Required: --out /tmp/<fresh-directory> [--live]");
  const out = freshOutput(values.out),
    source = fingerprint();
  const config = LLM_CONFIG.evaluators["finalize-match"];
  const blockers: string[] = [];
  if (values.live) {
    const env = join(ROOT, "apps/web/.env.local");
    if (existsSync(env)) process.loadEnvFile(env);
    if (!process.env.TYPESAFE_API_KEY?.trim()) blockers.push("Missing TYPESAFE_API_KEY");
    if (!config) blockers.push("Missing evaluators.finalize-match configuration");
  }
  console.log("Playing generated fixed-seed match to full time");
  const { state, brief } = fixture();
  // This fixture has real simulated events, but no generated commentator prose.
  const commentary = "";
  const request = buildSettlementRequest(brief, commentary);
  const inventory = {
    participants: brief.players.length,
    events: brief.timeline.length,
    scoreline: brief.scoreline,
    commentaryCharacters: commentary.length,
    stateCharacters: request.state.length,
    questions: Object.keys(request.questions).length,
    requestSha256: hash(stableJson(request)),
    questionTypes: Object.values(request.questions).reduce<Record<string, number>>(
      (counts, question) => {
        counts[question.type] = (counts[question.type] ?? 0) + 1;
        return counts;
      },
      {},
    ),
  };
  const stages: Stage[] = [];
  let measurement: Record<string, unknown> = { measured: false };
  if (values.live && !blockers.length && config) {
    const client = new TypesafeGameEvaluator(config);
    const evaluator: GameEvaluator = {
      async evaluate(input) {
        const began = performance.now(),
          base = {
            requestSha256: hash(stableJson(input)),
            questions: Object.keys(input.questions).length,
          };
        try {
          const result = await client.evaluate(input);
          stages.push({
            ...base,
            durationMs: performance.now() - began,
            attempts: result.attempts ?? 1,
            usage: result.usage,
            usageComplete: result.usageComplete !== false,
          });
          return result;
        } catch (error) {
          stages.push({
            ...base,
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
    const before = structuredClone(state);
    const began = performance.now();
    try {
      const entries = await evaluateSettlement(brief, commentary, evaluator);
      const applied = settleMatchRating(state, brief.matchId, entries);
      const durationMs = performance.now() - began;
      const ratings = state.matches.find((match) => match.id === brief.matchId)!.result!.ratings!;
      const participants = new Set(brief.players.map((player) => player.playerId));
      const changedAttributes = state.players.flatMap((player) => {
        const old = before.players.find((item) => item.id === player.id)!;
        return ATTRIBUTE_AXES.filter(
          (axis) => player.attributes[axis] !== old.attributes[axis],
        ).map((axis) => ({
          playerId: player.id,
          axis,
          delta: player.attributes[axis] - old.attributes[axis],
        }));
      });
      const oldAssignments = new Map(
        assignmentsOf(before, before.userTeamId).map((item) => [item.playerId, item.familiarity]),
      );
      const changedAdaptation = assignmentsOf(state, state.userTeamId).filter(
        (item) => item.familiarity !== oldAssignments.get(item.playerId),
      );
      const growth = state.growthLog.slice(before.growthLog.length);
      const settledSnapshot = stableJson(state),
        second = settleMatchRating(state, brief.matchId, entries);
      const checks = {
        allParticipantsAnswered:
          entries.length === brief.players.length &&
          new Set(entries.map((entry) => entry.playerId)).size === entries.length &&
          entries.every((entry) => participants.has(entry.playerId)),
        rated: matchRated(state, brief.matchId),
        allApplied: applied.applied === brief.players.length && applied.skipped === 0,
        anchorsBounded: brief.players.every(
          (player) =>
            ratings[player.playerId]! >= RATING_MIN &&
            ratings[player.playerId]! <= RATING_MAX &&
            Math.abs(ratings[player.playerId]! - player.anchor) <= RATING_BAND + 1e-9,
        ),
        onlyParticipantsChanged:
          changedAttributes.every((entry) => participants.has(entry.playerId)) &&
          changedAdaptation.every((entry) => participants.has(entry.playerId)) &&
          growth.every((entry) => participants.has(entry.gamePlayerId)),
        attributeLedgerMatches: changedAttributes.every((entry) =>
          growth.some(
            (line) =>
              line.gamePlayerId === entry.playerId &&
              line.target === entry.axis &&
              line.delta === entry.delta,
          ),
        ),
        idempotent: second.already && second.applied === 0 && stableJson(state) === settledSnapshot,
      };
      measurement = {
        measured: true,
        durationMs,
        entries: entries.length,
        changedRatings: brief.players.filter((player) => ratings[player.playerId] !== player.anchor)
          .length,
        changedAdaptation: changedAdaptation.length,
        changedAttributes: changedAttributes.length,
        growthLedgerRows: growth.length,
        checks,
        passed: Object.values(checks).every(Boolean),
      };
    } catch (error) {
      measurement = {
        measured: true,
        durationMs: performance.now() - began,
        passed: false,
        failure: failure(error),
      };
    }
  }
  let usage = emptyUsage();
  for (const stage of stages) usage = addUsage(usage, stage.usage);
  const usageComplete = stages.length > 0 && stages.every((stage) => stage.usageComplete);
  const sourceAtEndSha256 = fingerprint().sha256;
  if (source.sha256 !== sourceAtEndSha256)
    blockers.push("Runtime sources changed during evaluation; not one stable revision");
  const report = {
    generatedAt: new Date().toISOString(),
    gameVersion: gameVersion(),
    mode: values.live ? "live" : "offline",
    fixture:
      "Fixed-seed 42 Arsenal live simulation played to full time; generated data, no saved game or recorded user input.",
    config,
    source,
    sourceAtEndSha256,
    inventory,
    ...measurement,
    stages,
    requests: stages.length,
    attempts: stages.reduce((sum, stage) => sum + stage.attempts, 0),
    usage,
    usageComplete,
    costUsd:
      usageComplete && config ? (usage.inputTokens * config.inputUsdPerMillion) / 1_000_000 : null,
    blockers,
    limitations: [
      "One generated match; boundary smoke only, no correctness, quality, adoption or baseline improvement claim.",
      "No commentator prose, GM notes, save, trace or disk journal. Only real deterministic match events supply context.",
      "Total latency covers evaluateSettlement plus settleMatchRating; excludes match simulation, finalizeMatch anchors and post-run checks.",
      "Failures retain reported usage; incomplete usage means unknown dollar cost.",
    ],
  };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    join(out, "summary.md"),
    [
      `# Generated match settlement smoke`,
      ``,
      `Mode: ${report.mode}; ${report.generatedAt}; version ${report.gameVersion}`,
      `Source SHA-256: ${source.sha256}`,
      ``,
      `Participants: ${inventory.participants}; questions: ${inventory.questions}; requests/attempts: ${report.requests}/${report.attempts}`,
      `Total milliseconds: ${measurement.durationMs ?? "n/a"}; boundary checks: ${measurement.passed ?? "not measured"}; USD: ${report.costUsd ?? "unknown"}`,
      ``,
      ...blockers.map((line) => `Blocker: ${line}`),
      ``,
      ...report.limitations.map((line) => `- ${line}`),
      ``,
    ].join("\n"),
  );
  console.log(`Report: ${join(out, "report.json")}`);
  if (blockers.length || measurement.passed === false) process.exitCode = 1;
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Settlement evaluation failed");
  process.exitCode = 1;
});
