import { z } from "zod";
import { MatchEventSchema } from "./match-events";
import { LIVE_STEP } from "./live-match";

export const RECENT_FLOW_SECONDS = 600;
export const FLOW_TICKS_PER_SECOND = Math.round(1 / LIVE_STEP);
const count = z.number().int().nonnegative();
const FlowTotalsSchema = z.object({
  possessionTicks: count,
  shots: count,
  xgMicros: count,
  passes: count,
  passesCompleted: count,
  tackles: count,
  tacklesWon: count,
  fouls: count,
});
export type FlowTotals = z.infer<typeof FlowTotalsSchema>;
const FlowEventSchema = z.object({ tick: count, event: MatchEventSchema });
export type FlowEvent = z.infer<typeof FlowEventSchema>;
const FlowBucketSchema = z.object({
  startTick: count,
  endTick: count,
  home: FlowTotalsSchema,
  away: FlowTotalsSchema,
  events: z.array(FlowEventSchema),
});
export type FlowBucket = z.infer<typeof FlowBucketSchema>;
export const RecentFlowSchema = z
  .object({
    startTick: count,
    endTick: count,
    buckets: z.array(FlowBucketSchema).max(RECENT_FLOW_SECONDS),
  })
  .superRefine((flow, ctx) => {
    const invalid = () =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid recent match flow interval" });
    if (
      flow.endTick < flow.startTick ||
      flow.endTick - flow.startTick > RECENT_FLOW_SECONDS * FLOW_TICKS_PER_SECOND
    )
      invalid();
    if (flow.buckets.length === 0) {
      if (flow.startTick !== flow.endTick) invalid();
      return;
    }
    if (
      flow.startTick !== flow.buckets[0]!.startTick ||
      flow.endTick !== flow.buckets.at(-1)!.endTick
    )
      invalid();
    for (const [index, bucket] of flow.buckets.entries()) {
      if (
        bucket.endTick < bucket.startTick ||
        bucket.endTick - bucket.startTick > FLOW_TICKS_PER_SECOND ||
        bucket.startTick % FLOW_TICKS_PER_SECOND !== 0 ||
        (index > 0 && flow.buckets[index - 1]!.endTick !== bucket.startTick) ||
        bucket.home.possessionTicks + bucket.away.possessionTicks >
          bucket.endTick - bucket.startTick ||
        bucket.events.some((entry) => entry.tick < bucket.startTick || entry.tick > bucket.endTick)
      )
        invalid();
    }
  });
export type RecentFlow = z.infer<typeof RecentFlowSchema>;
