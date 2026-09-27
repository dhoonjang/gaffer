import type { TurnUsage } from "@story-fm/llm";
import type { MatchReaderOutput } from "../src/match/match-reader";

export const emptyUsage = (): TurnUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(total: TurnUsage, delta: TurnUsage): TurnUsage {
  return {
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    cacheReadTokens: total.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + delta.cacheWriteTokens,
  };
}

/** Nearest-rank percentiles; no observations is unknown, not zero. */
export function durationStats(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
  };
}

export interface Prices {
  input?: number;
  output?: number;
  cachedInput?: number;
}

/** Cache-write pricing is provider-specific and cannot be inferred from these rates. */
export function costUsd(usage: TurnUsage, prices: Prices): number | null {
  if (
    prices.input === undefined ||
    prices.output === undefined ||
    usage.cacheWriteTokens > 0 ||
    (usage.cacheReadTokens > 0 && prices.cachedInput === undefined)
  ) {
    return null;
  }
  return (
    ((usage.inputTokens - usage.cacheReadTokens) * prices.input +
      usage.cacheReadTokens * (prices.cachedInput ?? 0) +
      usage.outputTokens * prices.output) /
    1_000_000
  );
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Exact structural overlap only; lexical matching does not establish correctness. */
export function agreement(baseline: MatchReaderOutput, candidate: MatchReaderOutput) {
  function rows(reading: MatchReaderOutput) {
    const points = new Map(
      reading.points.map((point) => [point.id, point.text.trim().replace(/\s+/g, " ")]),
    );
    const result = new Map<string, number[]>();
    for (const { pointId, step, ...structure } of reading.sheet) {
      const key = stableJson({
        ...structure,
        point: points.get(pointId) ?? { missingPointId: pointId },
      });
      result.set(key, [...(result.get(key) ?? []), step]);
    }
    return result;
  }
  const left = rows(baseline);
  const right = rows(candidate);
  let matched = 0;
  let absoluteError = 0;
  for (const [key, steps] of left) {
    const other = right.get(key) ?? [];
    // Pair duplicate structural rows by sorted strength, never reuse a candidate row.
    steps.sort((a, b) => a - b);
    other.sort((a, b) => a - b);
    for (let i = 0; i < Math.min(steps.length, other.length); i++) {
      matched++;
      absoluteError += Math.abs(steps[i]! - other[i]!);
    }
  }
  const union = baseline.sheet.length + candidate.sheet.length - matched;
  return {
    matchedRows: matched,
    unmatchedBaselineRows: baseline.sheet.length - matched,
    unmatchedCandidateRows: candidate.sheet.length - matched,
    structuralJaccard: union > 0 ? matched / union : null,
    stepMeanAbsoluteError: matched > 0 ? absoluteError / matched : null,
    opsExact: stableJson(baseline.ops) === stableJson(candidate.ops),
  };
}
