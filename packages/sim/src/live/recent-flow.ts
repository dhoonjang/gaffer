import {
  RECENT_FLOW_SECONDS,
  FLOW_TICKS_PER_SECOND,
  type FlowTotals,
  type FlowBucket,
  type RecentFlow,
  type LiveMatchState,
  type MatchEvent,
  type MatchStatLine,
} from "@story-fm/domain";
import type { LiveMatch } from "./runner";

export { RECENT_FLOW_SECONDS } from "@story-fm/domain";
export type { FlowTotals, FlowBucket, FlowEvent, RecentFlow } from "@story-fm/domain";
const TICKS_PER_SECOND = FLOW_TICKS_PER_SECOND;
const XG_SCALE = 1_000_000;

const emptyTotals = (): FlowTotals => ({
  possessionTicks: 0,
  shots: 0,
  xgMicros: 0,
  passes: 0,
  passesCompleted: 0,
  tackles: 0,
  tacklesWon: 0,
  fouls: 0,
});

export function emptyRecentFlow(tick = 0): RecentFlow {
  return { startTick: tick, endTick: tick, buckets: [] };
}

function bucketAt(flow: RecentFlow, tick: number): FlowBucket {
  const startTick = Math.floor(Math.max(0, tick - 1) / TICKS_PER_SECOND) * TICKS_PER_SECOND;
  let bucket = flow.buckets[flow.buckets.length - 1];
  if (!bucket || bucket.startTick !== startTick) {
    bucket = { startTick, endTick: tick, home: emptyTotals(), away: emptyTotals(), events: [] };
    flow.buckets.push(bucket);
  }
  bucket.endTick = tick;
  flow.endTick = tick;
  // Drop a partly expired second too: the reported interval never exceeds ten minutes.
  while (
    flow.buckets.length > 1 &&
    flow.buckets[0]!.startTick < tick - RECENT_FLOW_SECONDS * TICKS_PER_SECOND
  )
    flow.buckets.shift();
  flow.startTick = flow.buckets[0]!.startTick;
  return bucket;
}

/** Called once for each actually simulated tick, including ticks with no events. */
export function recordFlowTick(
  flow: RecentFlow,
  before: LiveMatchState,
  after: LiveMatchState,
  stats: Record<string, MatchStatLine>,
): void {
  const bucket = bucketAt(flow, after.tick);
  for (const side of ["home", "away"] as const) {
    bucket[side].possessionTicks += Math.round(
      (after.possessionTime[side] - before.possessionTime[side]) * TICKS_PER_SECOND,
    );
  }
  for (const [id, stat] of Object.entries(stats)) {
    const player =
      after.players.find((p) => p.id === id) ?? before.players.find((p) => p.id === id);
    if (!player) continue;
    const totals = bucket[player.side];
    totals.shots += stat.shots;
    totals.xgMicros += Math.round(stat.xg * XG_SCALE);
    totals.passes += stat.passes;
    totals.passesCompleted += stat.passesCompleted;
    totals.tackles += stat.tackles;
    totals.tacklesWon += stat.tacklesWon;
    totals.fouls += stat.fouls;
  }
}

/** Accepted ledger events only; their displayed minute may rewind across halftime. */
export function recordFlowEvents(
  flow: RecentFlow,
  tick: number,
  events: readonly MatchEvent[],
): void {
  if (events.length === 0) return;
  bucketAt(flow, tick).events.push(...events.map((event) => ({ tick, event })));
}

export function recentFlowOf(live: Pick<LiveMatch, "flow">) {
  const { flow } = live;
  const totals = { home: emptyTotals(), away: emptyTotals() };
  for (const bucket of flow.buckets) {
    for (const side of ["home", "away"] as const) {
      const sum = totals[side];
      for (const key of Object.keys(sum) as (keyof FlowTotals)[]) sum[key] += bucket[side][key];
    }
  }
  const sideSummary = (value: FlowTotals) => ({
    possessionSeconds: value.possessionTicks / TICKS_PER_SECOND,
    shots: value.shots,
    xg: value.xgMicros / XG_SCALE,
    passes: value.passes,
    passesCompleted: value.passesCompleted,
    tackles: value.tackles,
    tacklesWon: value.tacklesWon,
    fouls: value.fouls,
  });
  return {
    startTick: flow.startTick,
    endTick: flow.endTick,
    observedSeconds: (flow.endTick - flow.startTick) / TICKS_PER_SECOND,
    precisionSeconds: 1,
    home: sideSummary(totals.home),
    away: sideSummary(totals.away),
    events: flow.buckets.flatMap((bucket) => bucket.events),
  };
}
