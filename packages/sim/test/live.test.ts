import { isOffsidePosition } from "../src/live/step";
import { emptyRecentFlow, recordFlowTick, recordFlowEvents } from "../src/live/recent-flow";
import { describe, expect, it } from "vitest";
import {
  SheetStepSchema,
  type SheetLine,
  DEFAULT_TACTICS,
  FIELD,
  LIVE_STEP,
  type WeightSlot,
} from "@gaffer/domain";
import {
  applySheet,
  emptyStatLine,
  createLiveStepper,
  stepLive,
  liveInputOf,
  SHEET_TARGET_CAP,
  SHEET_NET_CAP,
  type SheetContext,
  SLOT_TENDENCY,
  advanceLive,
  heatmapDensity,
  heatmapMean,
  heatmapOf,
  makeRng,
  roleTendencyOf,
  sampleHeatmap,
  shapePosition,
  teamParamsOf,
  liveDigest,
  liveFinished,
  matchFatigueOf,
  possessionOf,
  recentFlowOf,
  LIVE_TICKS_PER_SECOND,
} from "@gaffer/sim";
import { makeLiveMatch } from "./helpers";

describe("최근 흐름 — 실제 실행 구간만 집계한다", () => {
  it("시작 직후 통계는 장부의 실제 증가분이고 휴식은 시간을 늘리지 않는다", () => {
    const match = makeLiveMatch({ seed: 7 });
    expect(recentFlowOf(match).observedSeconds).toBe(0);
    advanceLive(match, LIVE_TICKS_PER_SECOND * 20);
    const flow = recentFlowOf(match);
    expect(flow.observedSeconds).toBe(20);
    for (const side of ["home", "away"] as const) {
      const ids = new Set(match.state.players.filter((p) => p.side === side).map((p) => p.id));
      const stats = Object.entries(match.ledger.stats)
        .filter(([id]) => ids.has(id))
        .map(([, value]) => value);
      for (const key of [
        "shots",
        "passes",
        "passesCompleted",
        "tackles",
        "tacklesWon",
        "fouls",
      ] as const)
        expect(flow[side][key]).toBe(stats.reduce((sum, row) => sum + row[key], 0));
      expect(flow[side].xg).toBeCloseTo(
        stats.reduce((sum, row) => sum + row.xg, 0),
        5,
      );
      expect(flow[side].possessionSeconds).toBeCloseTo(match.state.possessionTime[side], 8);
    }
    expect(flow.events.map((entry) => entry.event)).toEqual(match.ledger.events);
    match.state.interval = true;
    advanceLive(match, LIVE_TICKS_PER_SECOND * 100);
    expect(recentFlowOf(match)).toEqual(flow);
  });

  it("사건이 없어도 오래된 초를 버리며 남은 사건과 점유 시간만 합친다", () => {
    const match = makeLiveMatch();
    const flow = emptyRecentFlow();
    const ticks = LIVE_TICKS_PER_SECOND * 600;
    const shooter = match.state.players.find((p) => p.side === "home")!;
    for (let tick = 1; tick <= ticks + 1; tick++) {
      const before = {
        ...match.state,
        tick: tick - 1,
        possessionTime: { home: (tick - 1) * LIVE_STEP, away: 0 },
      };
      const after = { ...before, tick, possessionTime: { home: tick * LIVE_STEP, away: 0 } };
      recordFlowTick(
        flow,
        before,
        after,
        tick === 1 || tick === ticks
          ? {
              [shooter.id]: {
                ...emptyStatLine(),
                shots: 1,
                xg: 0.1234567,
                passes: 2,
                passesCompleted: 1,
                tackles: 1,
                fouls: 1,
              },
            }
          : {},
      );
      if (tick === 1 || tick === ticks)
        recordFlowEvents(flow, tick, [
          { minute: 0, type: "tactical_shift", team: "home", actors: [], causes: [] },
        ]);
      if (tick === ticks) expect(recentFlowOf({ flow }).observedSeconds).toBe(600);
    }
    const summary = recentFlowOf({ flow });
    expect(flow.buckets).toHaveLength(600);
    expect(summary.startTick).toBe(LIVE_TICKS_PER_SECOND);
    expect(summary.endTick).toBe(ticks + 1);
    expect(summary.observedSeconds).toBe(599 + LIVE_STEP);
    expect(summary.home.possessionSeconds).toBe(summary.observedSeconds);
    expect(summary.home).toMatchObject({
      shots: 1,
      xg: 0.123457,
      passes: 2,
      passesCompleted: 1,
      tackles: 1,
      fouls: 1,
    });
    expect(summary.events.map((entry) => entry.tick)).toEqual([ticks]);
  });

  it("추가시간 뒤 표시 시계가 되감겨도 실행 tick과 관측 길이는 이어진다", () => {
    const match = makeLiveMatch();
    match.state.seconds = 46 * 60 - LIVE_STEP;
    match.state.half.added = 60;
    advanceLive(match, 1);
    expect(match.state.phase).toBe("second_half");
    expect(match.state.seconds).toBe(45 * 60);
    expect(recentFlowOf(match).observedSeconds).toBe(LIVE_STEP);
    expect(
      recentFlowOf(match).events.some(
        ({ tick, event }) => tick === 1 && event.type === "half_time",
      ),
    ).toBe(true);
    match.state.interval = false;
    advanceLive(match, 1);
    expect(recentFlowOf(match).endTick).toBe(2);
    expect(recentFlowOf(match).observedSeconds).toBe(2 * LIVE_STEP);
  });
});

/** 한 경기를 끝까지 — 휴식은 바로 재개한다 */
function playOut(match: ReturnType<typeof makeLiveMatch>) {
  const rejected: string[] = [];
  const done = () => liveFinished(match);
  for (let guard = 0; guard < 400 && !done(); guard++) {
    const result = advanceLive(match, LIVE_TICKS_PER_SECOND * 60);
    rejected.push(...result.rejected);
    if (match.state.interval && !done()) match.state.interval = false;
  }
  return rejected;
}

describe("실시간 경기 — 결정성과 장부 계약 (live-match.md §8.2 · match.md §5)", () => {
  it("같은 시드·같은 입력이면 digest까지 같다", () => {
    const a = makeLiveMatch({ seed: 7 });
    const b = makeLiveMatch({ seed: 7 });
    advanceLive(a, LIVE_TICKS_PER_SECOND * 600);
    advanceLive(b, LIVE_TICKS_PER_SECOND * 600);
    expect(liveDigest(a)).toBe(liveDigest(b));
    expect(a).toEqual(b);
  });

  it("digest includes all numerical simulation fields and ignores object insertion order", () => {
    const match = makeLiveMatch({ seed: 7 });
    const baseline = liveDigest(match);
    const mutateNumbers = (value: unknown, path: (string | number)[] = []): void => {
      if (Array.isArray(value)) {
        value.forEach((child, i) => mutateNumbers(child, [...path, i]));
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (key === "committedTick") continue;
          if (typeof child === "number") {
            const copy = structuredClone(match);
            let parent: unknown = copy;
            for (const part of path) parent = (parent as Record<string, unknown>)[part];
            (parent as Record<string, unknown>)[key] = child + 0.125;
            expect(liveDigest(copy), [...path, key].join(".")).not.toBe(baseline);
          } else mutateNumbers(child, [...path, key]);
        }
      }
    };
    mutateNumbers(match);
    const reordered = Object.fromEntries(Object.entries(match).reverse()) as typeof match;
    expect(liveDigest(reordered)).toBe(baseline);
  });
  it("offside uses the second-last opponent including the keeper and the ball", () => {
    expect(isOffsidePosition(88, 70, [103, 90, 80], "home")).toBe(false);
    expect(isOffsidePosition(92, 70, [103, 90, 80], "home")).toBe(true);
    expect(isOffsidePosition(88, 70, [75, 90, 80], "home")).toBe(true);
    expect(isOffsidePosition(99, 70, [103], "home")).toBe(false);
    expect(isOffsidePosition(92, 94, [103, 90, 80], "home")).toBe(false);
  });

  it("입력 인덱스 재사용은 매 틱 새로 읽는 것과 같고 전술 변경을 반영한다", () => {
    const match = makeLiveMatch({ seed: 13 });
    let cached = match.state;
    let fresh = structuredClone(cached);
    for (const pressing of [1, 5]) {
      match.tactics.home.pressing = pressing;
      const input = liveInputOf(match);
      const step = createLiveStepper(input);
      for (let tick = 0; tick < 240; tick++) {
        const a = step(cached);
        const b = stepLive(fresh, input);
        expect(a).toEqual(b);
        cached = a.state;
        fresh = b.state;
      }
    }
  });

  it("나눠 굴려도 한 번에 굴린 것과 같다", () => {
    const a = makeLiveMatch({ seed: 11 });
    const b = makeLiveMatch({ seed: 11 });
    advanceLive(a, LIVE_TICKS_PER_SECOND * 300);
    for (let i = 0; i < 300; i++) advanceLive(b, LIVE_TICKS_PER_SECOND);
    expect(liveDigest(a)).toBe(liveDigest(b));
    expect(recentFlowOf(a)).toEqual(recentFlowOf(b));
  });

  it("90분을 끝까지 굴리면 장부가 닫히고 반려는 없다", () => {
    const match = makeLiveMatch({ seed: 3 });
    const rejected = playOut(match);
    expect(rejected).toEqual([]);
    expect(match.ledger.phase).toBe("finished");
    const types = match.ledger.events.map((e) => e.type);
    expect(types).toContain("half_time");
    expect(types[types.length - 1]).toBe("full_time");
    // 스코어는 골 사건 수와 같다
    const goals = match.ledger.events.filter((e) => e.type === "goal");
    expect(goals.length).toBe(match.ledger.score.home + match.ledger.score.away);
    // 추가시간이 시계에 있다 — 하프의 끝 사건은 추가분을 싣는다
    const half = match.ledger.events.find((e) => e.type === "half_time");
    expect(half?.minute).toBe(45);
    expect(half?.added).toBeGreaterThanOrEqual(1);
  });

  it("말이 실제로 뛴 거리가 쌓이고 체력이 그만큼 준다", () => {
    const match = makeLiveMatch({ seed: 5 });
    playOut(match);
    const fatigue = matchFatigueOf(match);
    const homeStarters = match.setup.players;
    const ran = Object.values(match.ledger.stats).map((s) => s.distance);
    expect(Math.max(...ran)).toBeGreaterThan(5000);
    expect(Object.values(fatigue).some((f) => f > 20)).toBe(true);
    void homeStarters;
    const share = possessionOf(match);
    expect(share.home + share.away).toBeCloseTo(1, 6);
  });
});

describe("히트맵 — 역할의 연속 분포 (live-match.md §3.3)", () => {
  const SLOTS: WeightSlot[] = ["GK", "CB", "FB", "DM", "CM", "AM", "W", "CF", "ST"];
  const at = (ballDepth: number, attacking: boolean) => ({ attacking, ballDepth, commit: 1 });
  const normal = (rng: () => number) => () => (rng() + rng() + rng() + rng() - 2) * 1.73;

  it("밀도는 경기장 어디서나 0보다 크다 — 안과 밖을 가르는 경계가 없다", () => {
    for (const slot of SLOTS) {
      for (const attacking of [true, false]) {
        const h = heatmapOf(
          slot,
          SLOT_TENDENCY[slot],
          { depth: 40, lateral: 12 },
          at(50, attacking),
        );
        for (let depth = 0; depth <= FIELD.length; depth += 7.5) {
          for (let lateral = 0; lateral <= FIELD.width; lateral += 8.5) {
            expect(heatmapDensity(h, depth, lateral)).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("성분 하나의 분포는 중심에서 멀어질수록 매끄럽게 준다", () => {
    const h = heatmapOf("ST", SLOT_TENDENCY.ST, { depth: 60, lateral: 34 }, at(40, false));
    let previous = Infinity;
    for (let d = 0; d <= 40; d += 1) {
      const rho = heatmapDensity(h, 60 + d, 34);
      expect(rho).toBeLessThan(previous);
      previous = rho;
    }
  });

  it("중심을 옮기면 분포의 평균이 같은 만큼 옮는다 — 전술판이 히트맵을 끈다", () => {
    for (const slot of SLOTS) {
      const a = heatmapMean(
        heatmapOf(slot, SLOT_TENDENCY[slot], { depth: 30, lateral: 10 }, at(60, true)),
      );
      const b = heatmapMean(
        heatmapOf(slot, SLOT_TENDENCY[slot], { depth: 42, lateral: 16 }, at(60, true)),
      );
      expect(b.depth - a.depth).toBeCloseTo(12, 6);
      expect(b.lateral - a.lateral).toBeCloseTo(6, 6);
    }
  });

  it("뽑은 점의 평균이 분포의 평균에 선다 — 표본과 밀도가 같은 분포다", () => {
    const h = heatmapOf("FB", SLOT_TENDENCY.FB, { depth: 40, lateral: 8 }, at(70, true));
    const rng = makeRng(1, "heatmap-sample");
    let depth = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) depth += sampleHeatmap(h, rng, normal(rng)).depth;
    expect(depth / n).toBeCloseTo(heatmapMean(h).depth, 0);
  });

  it("풀백의 무게는 공이 전진할수록 연속으로 앞으로 옮고, 범위는 자기 박스부터 상대 마무리 지역까지다", () => {
    const params = teamParamsOf(DEFAULT_TACTICS, 1, 1);
    const slot = { position: "LB", point: { x: 12, y: 78 } };
    const zoneAt = (ballDepth: number, attacking: boolean, roleId?: string) => {
      const tendency = roleTendencyOf("LB", roleId);
      const center = shapePosition(slot, tendency, {
        side: "home",
        params,
        attacking,
        phase: attacking ? "progression" : "organised_defence",
        ballDepth,
        ballLateral: 20,
        backLine: 20,
        frontLimit: attacking ? 95 : ballDepth - 8,
      });
      return heatmapOf(
        "FB",
        tendency,
        { depth: center.x, lateral: center.y },
        at(ballDepth, attacking),
      );
    };
    const quantile = (h: ReturnType<typeof zoneAt>, q: number) => {
      const rng = makeRng(3, "fb-range");
      const xs = Array.from({ length: 4000 }, () => sampleHeatmap(h, rng, normal(rng)).depth).sort(
        (a, b) => a - b,
      );
      return xs[Math.floor(q * xs.length)]!;
    };
    // 공이 오를수록 평균이 앞으로 — 끊기지 않고
    let previous = -Infinity;
    for (let ball = 40; ball <= 95; ball += 5) {
      const mean = heatmapMean(zoneAt(ball, true)).depth;
      expect(mean).toBeGreaterThan(previous);
      previous = mean;
    }
    expect(quantile(zoneAt(12, false), 0.1)).toBeLessThan(FIELD.boxDepth);
    expect(quantile(zoneAt(85, true), 0.9)).toBeGreaterThan(FIELD.length * (2 / 3));
    // 윙백은 같은 공에서 풀백보다 앞에, 노-넌센스 풀백은 뒤에 무게를 둔다
    const mid = (roleId: string) => heatmapMean(zoneAt(70, true, roleId)).depth;
    expect(mid("wing-back")).toBeGreaterThan(mid("full-back"));
    expect(mid("full-back")).toBeGreaterThan(mid("no-nonsense-fb"));
  });
});

describe("연속 강도 시트", () => {
  const context: SheetContext = {
    points: [{ id: "point", text: "측면의 공간", about: [], importance: 2 }],
    onPitch: { home: ["player"], away: ["opponent"] },
    uptake: { home: 1, away: 1 },
  };
  const line = (shape: SheetLine["shape"], step: number, sign: 1 | -1 = -1): SheetLine => ({
    pointId: "point",
    target: { player: "player", side: "home", lane: "left" },
    shape,
    sign,
    step,
  });

  it("소수 강도는 양옆의 효과 사이에 있고 0으로 연속해서 작아진다", () => {
    for (const shape of ["edge", "temper", "legs", "focus", "cohesion"] as const) {
      for (const sign of [1, -1] as const) {
        const value = (step: number) =>
          applySheet([line(shape, step, sign)], context).applied[0]?.value;
        const a = value(1)!;
        const b = value(2)!;
        expect(value(1.5)).toBeCloseTo((a + b) / 2, shape === "temper" || shape === "legs" ? 1 : 4);
        expect(value(0.01)).toBeDefined();
        expect(applySheet([line(shape, 0, sign)], context).applied).toEqual([]);
      }
    }
  });

  it("분수 강도로 쪼개도 선수·팀의 효과 한도를 넘지 못한다", () => {
    const lines = Array.from({ length: 20 }, () => line("edge", 0.5, 1));
    const result = applySheet(lines, context);
    expect(result.edge.player).toBeLessThanOrEqual(SHEET_TARGET_CAP);
    expect(result.edge.player).toBeLessThanOrEqual(SHEET_NET_CAP);
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(applySheet(lines, context)).toEqual(result);
  });

  it("없는 상대를 지목한 행동은 대상으로 바뀌지 않고 전부 반려된다", () => {
    const result = applySheet(
      [{ ...line("behavior", 1), action: "mark", targetPlayer: "missing" }],
      context,
    );
    expect(result.behaviors).toEqual([]);
    expect(result.dropped.map((entry) => entry.code)).toEqual(["no-player"]);
  });

  it("스키마가 비유한 수와 범위 밖 강도를 막는다", () => {
    for (const value of [-1, 3.01, Number.NaN, Infinity]) {
      expect(SheetStepSchema.safeParse(value).success).toBe(false);
      const result = applySheet([line("edge", value)], context);
      expect(result.applied).toEqual([]);
      expect(result.dropped.map((entry) => entry.code)).toEqual(["invalid-step"]);
    }
    expect(SheetStepSchema.parse(1.25)).toBe(1.25);
  });
});
