import { describe, expect, it } from "vitest";
import {
  CARD_WORDS,
  FIELD,
  IP_WORDS,
  cardWordsAt,
  placeOf,
  type CardWord,
  type IpWord,
  type MatchSide,
  type RoleCard,
} from "@gaffer/domain";
import { depthOf, lateralOf, type LiveMatch, type LiveTickObserver } from "@gaffer/sim";
import { tacticsOf, type GameState } from "@gaffer/engine";
import { createTestGame } from "../test/helpers";
import {
  CARD_WORDS_HARNESS,
  CARD_WORD_PROBES,
  cardWordMetric,
  type CardWordProbe,
} from "./catalog";
import { outOfBand, reportOf, type Readings } from "./harness";
import {
  FORMATION_ARMS,
  leagueFixtures,
  liveMatchWith,
  mean,
  playToEnd,
  sampleOf,
  withFormation,
} from "./live-runs";

/**
 * **카드의 낱말이 말의 움직임을 옮기는가** — 같은 대진에서 홈 팀 카드에 낱말 하나만 −3·+3으로
 * 걸어 굴리고, 그 낱말이 읽히는 자리를 잰다 (player.md §3 · live-match.md §4).
 *
 * 낱말은 그 자리에서 뜻이 있는 선발 전원(필드 열 명 — 「나오기」는 골키퍼)에게 건다. 한 명에만
 * 걸면 효과가 경기의 잡음에 묻힌다. 판정은 방향이고, 크기와 득실은 읽는 값이다.
 *
 *   pnpm balance card-words
 */

const SEEDS = [42, 7];
const MATCHES = 3;
/** 위치를 이만큼 틱마다 적는다 — 1초 */
const SAMPLE_TICKS = 20;
/** 퍼짐을 재는 선수의 최소 표본 — 교체로 몇 분만 뛴 선수의 퍼짐은 잡음이다 */
const SPREAD_MIN_SAMPLES = 300;

interface Arm {
  label: string;
  word: CardWord | null;
  step: number;
}

const ARMS: readonly Arm[] = [
  { label: "기준", word: null, step: 0 },
  ...CARD_WORDS.flatMap((word) => [
    { label: `${word} −3`, word, step: -3 },
    { label: `${word} +3`, word, step: 3 },
  ]),
];

interface MatchReading extends Record<CardWordProbe, number> {
  xgFor: number;
  xgAgainst: number;
}

const isIpWord = (word: CardWord): word is IpWord =>
  (IP_WORDS as readonly CardWord[]).includes(word);

/** 낱말 하나만 단계만큼 건 카드 */
function cardWith(word: CardWord, step: number): RoleCard {
  const card: RoleCard = { ip: {}, oop: {} };
  if (isIpWord(word)) card.ip[word] = step;
  else card.oop[word] = step;
  return card;
}

/** 그 팀 선발 중 그 낱말이 뜻이 있는 사람 전원에게 카드를 건다 */
function applyArm(state: GameState, teamId: string, arm: Arm): void {
  if (!arm.word) return;
  for (const a of tacticsOf(state, teamId).assignments) {
    if (a.role !== "starting") continue;
    if (!cardWordsAt(placeOf(a.position) === "GK").includes(arm.word)) continue;
    a.card = cardWith(arm.word, arm.step);
  }
}

/**
 * 홈 팀의 자리를 재는 관찰자 — 장부에 없는 값(위치·행동)만 여기서 잰다. 공 있을 때는 홈이
 * 공을 가진 틱, 공 없을 때는 아닌 틱이다. 재시작 중의 배치는 세지 않는다.
 */
function wordProbe(side: MatchSide): {
  onTick: LiveTickObserver;
  read: (live: LiveMatch) => MatchReading;
} {
  const sum = { inN: 0, wide: 0, depthIn: 0, box: 0, outN: 0, depthOut: 0, press: 0, mark: 0 };
  const keeper = { n: 0, depth: 0 };
  const spread = new Map<string, { n: number; d: number; l: number; dd: number; ll: number }>();
  const running = new Set<string>();
  let runs = 0;
  const onTick: LiveTickObserver = (state, input) => {
    const slots = side === "home" ? input.home.slots : input.away.slots;
    const keeperId = slots.find((s) => placeOf(s.position) === "GK")?.player.id;
    const attacking = state.possession === side;
    for (const p of state.players) {
      if (p.side !== side || p.id === keeperId) continue;
      const run = attacking && p.action === "run";
      if (run && !running.has(p.id)) runs++;
      if (run) running.add(p.id);
      else running.delete(p.id);
    }
    if (state.tick % SAMPLE_TICKS !== 0 || state.restart) return;
    for (const p of state.players) {
      if (p.side !== side) continue;
      const depth = depthOf(p.x, side);
      if (p.id === keeperId) {
        if (!attacking) {
          keeper.n++;
          keeper.depth += depth;
        }
        continue;
      }
      const lateral = lateralOf(p.y, side);
      const offCentre = Math.abs(lateral - FIELD.width / 2);
      if (attacking) {
        sum.inN++;
        sum.wide += offCentre;
        sum.depthIn += depth;
        if (depth > FIELD.length - FIELD.boxDepth && offCentre < FIELD.boxHalfWidth) sum.box++;
        const s = spread.get(p.id) ?? { n: 0, d: 0, l: 0, dd: 0, ll: 0 };
        s.n++;
        s.d += depth;
        s.l += lateral;
        s.dd += depth * depth;
        s.ll += lateral * lateral;
        spread.set(p.id, s);
      } else {
        sum.outN++;
        sum.depthOut += depth;
        if (p.action === "press") sum.press++;
        let nearest = Infinity;
        for (const q of state.players) {
          if (q.side !== side) nearest = Math.min(nearest, Math.hypot(q.x - p.x, q.y - p.y));
        }
        sum.mark += nearest;
      }
    }
  };
  const read = (live: LiveMatch): MatchReading => {
    const sample = sampleOf(live);
    const us = sample.teams.find((t) => t.side === side)!;
    const them = sample.teams.find((t) => t.side !== side)!;
    const spreads = [...spread.values()]
      .filter((s) => s.n >= SPREAD_MIN_SAMPLES)
      .map((s) => Math.sqrt(s.dd / s.n - (s.d / s.n) ** 2 + (s.ll / s.n - (s.l / s.n) ** 2)));
    return {
      wideIn: sum.wide / Math.max(1, sum.inN),
      depthIn: sum.depthIn / Math.max(1, sum.inN),
      spreadIn: mean(spreads),
      runs,
      boxIn: sum.box / Math.max(1, sum.inN),
      dribbles: us.line.dribbles,
      progressiveShare: us.line.progressive / Math.max(1, us.line.passes),
      shots: us.line.shots,
      crosses: us.line.crosses,
      pressOut: sum.press / Math.max(1, sum.outN),
      depthOut: sum.depthOut / Math.max(1, sum.outN),
      markOut: sum.mark / Math.max(1, sum.outN),
      keeperOut: keeper.depth / Math.max(1, keeper.n),
      xgFor: us.line.xg,
      xgAgainst: them.line.xg,
    };
  };
  return { onTick, read };
}

describe("카드 낱말의 방향", () => {
  const pooled = new Map<string, MatchReading[]>(ARMS.map((arm) => [arm.label, []]));

  for (const [seedIndex, seed] of SEEDS.entries()) {
    it(`시드 ${seed} × 리그 ${MATCHES}경기 × 팔 ${ARMS.length}`, () => {
      const state = createTestGame(seed);
      for (const [i, fixture] of leagueFixtures(state, MATCHES).entries()) {
        const k = i * SEEDS.length + seedIndex;
        const home = FORMATION_ARMS[k % FORMATION_ARMS.length]!;
        const away = FORMATION_ARMS[(k + 3) % FORMATION_ARMS.length]!;
        for (const arm of ARMS) {
          withFormation(state, fixture.homeTeamId, home);
          withFormation(state, fixture.awayTeamId, away);
          applyArm(state, fixture.homeTeamId, arm);
          const live = liveMatchWith(state, fixture);
          const probe = wordProbe("home");
          playToEnd(live, probe.onTick);
          pooled.get(arm.label)!.push(probe.read(live));
        }
      }
      expect(pooled.get("기준")).toHaveLength((seedIndex + 1) * MATCHES);
    });
  }

  it("낱말마다 그 낱말이 읽히는 자리가 뜻한 쪽으로 움직인다", () => {
    const avg = (label: string, pick: (r: MatchReading) => number) =>
      mean(pooled.get(label)!.map(pick));
    const net = (r: MatchReading) => r.xgFor - r.xgAgainst;
    const readings: Readings<typeof CARD_WORDS_HARNESS> = {
      "기준 — 우리 xG": avg("기준", (r) => r.xgFor),
      "기준 — 상대 xG": avg("기준", (r) => r.xgAgainst),
    };
    for (const word of CARD_WORDS) {
      const probe = CARD_WORD_PROBES[word].probe;
      readings[cardWordMetric(word, "방향")] =
        avg(`${word} +3`, (r) => r[probe]) - avg(`${word} −3`, (r) => r[probe]);
      readings[cardWordMetric(word, "+3 득실 xG")] = avg(`${word} +3`, net) - avg("기준", net);
      readings[cardWordMetric(word, "−3 득실 xG")] = avg(`${word} −3`, net) - avg("기준", net);
    }
    console.log(
      reportOf(
        CARD_WORDS_HARNESS,
        readings,
        `시드 ${SEEDS.join("·")} × 리그 ${MATCHES}경기 × 팔 ${ARMS.length}`,
      ),
    );
    expect(outOfBand(CARD_WORDS_HARNESS, readings)).toEqual([]);
  });
});
