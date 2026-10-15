import { makeRng } from "@gaffer/sim";
import {
  type GameState,
  assignRequestedNumber,
  ensureSquadNumbers,
  numberBlockText,
  numberLineageOf,
  agingDelta,
  deriveAxes,
  derivePositions,
  eaRatingOf,
  synthesizeAxes,
  playerCatalog,
  footOf,
  physiqueOf,
} from "@gaffer/engine";
import {
  type GamePlayer,
  type Place,
  freshPlayerState,
  ATTRIBUTE_AXES,
  AXIS_GROUPS,
  FLOOR_WEIGHT,
  INCLINATION_AXES,
  OVERALL_AXES,
  POSITION_WEIGHTS,
  CARD_STEP_MAX,
  CARD_WORDS,
  CARD_WORD_DEFS,
  SLOT_INCLINATION,
  SLOT_REFERENCE,
  axisFloorAt,
  bestOverall,
  cardFit,
  cardWeights,
  naturalPositionOf,
  standoutAxes,
  weightSlotOf,
  type AxisValues,
  type RoleCard,
  type WeightSlot,
} from "@gaffer/domain";
import { describe, expect, it } from "vitest";
import { eaStatsOf } from "../../src/players/catalog/ea-stats";
import { SQUAD_SEEDS } from "../../src/players/catalog/squad-seeds";
import {
  RETARGET_MAX_PASSES,
  depthDropAt,
  potentialGapBand,
  squadApexOf,
  synthesizeSeed,
  type SynthesizedPlayer,
} from "../../src/players/catalog/synthesis";

/**
 * 능력치 37축 · 포지션 가중치 · 노화 곡선 (player.md §1·§2·§6).
 */

describe("37축 구성", () => {
  it("축 묶음이 37축을 빠짐없이·중복 없이 덮는다", () => {
    const grouped = Object.values(AXIS_GROUPS).flat();
    expect(new Set(grouped).size).toBe(ATTRIBUTE_AXES.length);
    expect([...grouped].sort()).toEqual([...ATTRIBUTE_AXES].sort());
  });

  it("종합 축 · 성향 축 · 타고난 체력이 37축을 겹치지 않게 나눈다", () => {
    const parts = [...OVERALL_AXES, ...INCLINATION_AXES, "naturalFitness"];
    expect(new Set(parts).size).toBe(ATTRIBUTE_AXES.length);
    expect([...parts].sort()).toEqual([...ATTRIBUTE_AXES].sort());
  });

  it("전 선수가 37축 전부를 유효 범위로 갖는다 — 포지션 예외 분기 없음", () => {
    for (const e of playerCatalog()) {
      for (const axis of ATTRIBUTE_AXES) {
        expect(e[axis], `${e.nameEn}.${axis}`).toBeGreaterThanOrEqual(1);
        expect(e[axis]).toBeLessThanOrEqual(99);
      }
    }
  });
});

describe("축은 EA 세부 능력치에서 옮긴다", () => {
  const seeds = Object.values(SQUAD_SEEDS).flat();

  /**
   * **옮김은 한 열을 한 축으로 직접 잇는다** — 속력은 최고 속도, 마킹은 수비 인지.
   * 이 짝이 어긋나면 화면의 숫자가 EA의 그 선수와 다른 사람이 된다.
   */
  it("EA에 있는 선수는 EA의 그 열이 곧 그 축이다", () => {
    const joined = seeds.filter((s) => eaRatingOf(s) !== undefined).slice(0, 200);
    expect(joined.length).toBe(200);
    for (const seed of joined) {
      const ea = eaRatingOf(seed)!;
      const s = eaStatsOf(ea);
      const axes = deriveAxes(seed.nameEn, seed.position, seed, { ea, height: seed.height });
      expect(axes.pace, seed.nameEn).toBe(s.sprintSpeed);
      expect(axes.acceleration).toBe(s.acceleration);
      expect(axes.marking).toBe(s.defensiveAwareness);
      expect(axes.firstTouch).toBe(s.ballControl);
      expect(axes.offTheBall).toBe(s.positioning);
      expect(axes.reflexes).toBe(s.gkReflexes);
    }
  });

  it("골키퍼의 민첩성은 다이빙이고 위치 선정은 GK 위치선정이다", () => {
    const keeper = seeds.find((s) => s.position === "GK" && eaRatingOf(s) !== undefined)!;
    const ea = eaRatingOf(keeper)!;
    const axes = deriveAxes(keeper.nameEn, keeper.position, keeper, { ea });
    expect(axes.agility).toBe(eaStatsOf(ea).gkDiving);
    expect(axes.positioning).toBe(eaStatsOf(ea).gkPositioning);
  });

  /**
   * **합성 선수는 목표 종합에서 태어난다** — 자리마다 세부 능력치에서 종합으로 가는 낙차가
   * 달라(골키퍼 −5 · 윙어 0) 되맞춤이 없으면 어느 자리도 노린 자리에 서지 않는다.
   * 개인 편차가 목표를 흔드므로 한 명이 아니라 무리의 평균으로 본다.
   */
  it("합성 선수의 종합은 의도한 자리에 선다 — 자리마다 평균이 ±1 안이다", () => {
    for (const position of ["GK", "CB", "RB", "DM", "CM", "AM", "RW", "CF", "ST"]) {
      for (const intended of [52, 68, 80]) {
        const overalls = Array.from({ length: 30 }, (_, i) => {
          const key = `Synthetic ${position} ${intended} ${i}`;
          const positions = derivePositions(key, position);
          return bestOverall(synthesizeAxes(key, position, positions, intended), positions);
        });
        const mean = overalls.reduce((a, b) => a + b, 0) / overalls.length;
        expect(Math.abs(mean - intended), `${position} ${intended} → ${mean}`).toBeLessThan(1);
      }
    }
    const positions = derivePositions("Same Key", "CM");
    expect(synthesizeAxes("Same Key", "CM", positions, 70)).toEqual(
      synthesizeAxes("Same Key", "CM", positions, 70),
    );
  });

  it("EA에 없는 선수는 대표 수치에서 세운다 — 같은 이름이면 언제나 같은 사람이다", () => {
    const seed = {
      pace: 70,
      shooting: 60,
      passing: 72,
      dribbling: 74,
      defending: 55,
      physical: 66,
    };
    const a = deriveAxes("Nobody Special", "CM", seed);
    expect(deriveAxes("Nobody Special", "CM", seed)).toEqual(a);
    expect(deriveAxes("Somebody Else", "CM", seed)).not.toEqual(a);
    for (const axis of ATTRIBUTE_AXES) {
      expect(a[axis], axis).toBeGreaterThanOrEqual(1);
      expect(a[axis], axis).toBeLessThanOrEqual(99);
    }
  });
});

describe("포지션 가중치", () => {
  it("가중치는 0~3, 0.05 눈금이다", () => {
    for (const [slot, w] of Object.entries(POSITION_WEIGHTS)) {
      for (const axis of OVERALL_AXES) {
        const v = w[axis];
        expect(v, `${slot}.${axis}`).toBeGreaterThanOrEqual(0);
        expect(v, `${slot}.${axis}`).toBeLessThanOrEqual(3);
        expect(Math.round(v * 20) / 20, `${slot}.${axis}: ${v}는 0.05 눈금이 아니다`).toBe(v);
      }
    }
  });

  it("0인 칸은 그 자리에 없는 축뿐이다 — 필드 자리의 GK 축, GK 자리의 필드 기술 축", () => {
    // 스트라이커의 태클도 전방 압박·역습 지연으로 쓰인다. 0으로 두면 태클 30인
    // 9번과 60인 9번이 완전히 같은 선수가 된다.
    for (const [slot, w] of Object.entries(POSITION_WEIGHTS) as [
      WeightSlot,
      typeof POSITION_WEIGHTS.GK,
    ][]) {
      for (const axis of OVERALL_AXES) {
        if (axisFloorAt(slot, axis) === 0) expect(w[axis], `${slot}.${axis}`).toBe(0);
        else expect(w[axis], `${slot}.${axis}`).toBeGreaterThanOrEqual(FLOOR_WEIGHT);
      }
    }
    expect(POSITION_WEIGHTS.ST.reflexes).toBe(0);
    expect(POSITION_WEIGHTS.GK.finishing).toBe(0);
    expect(POSITION_WEIGHTS.GK.reflexes).toBeGreaterThan(POSITION_WEIGHTS.GK.passing);
  });

  it("자리를 가르는 축이 위로 온다 — 태클은 센터백, 결정력은 최전방의 서명이다", () => {
    expect(POSITION_WEIGHTS.CB.tackling).toBeGreaterThan(POSITION_WEIGHTS.CB.positioning);
    expect(POSITION_WEIGHTS.ST.finishing).toBeGreaterThan(POSITION_WEIGHTS.ST.positioning);
    expect(POSITION_WEIGHTS.CB.tackling).toBeGreaterThan(POSITION_WEIGHTS.ST.tackling * 5);
  });

  it("자리마다 가중치 지문이 서로 다르다 — 같으면 세분화의 의미가 없다", () => {
    const fingerprints = Object.values(POSITION_WEIGHTS).map((w) =>
      OVERALL_AXES.map((a) => w[a]).join(","),
    );
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it("같은 선수가 자리에 따라 다른 전력을 낸다", () => {
    const cb = playerCatalog().find((e) => naturalPositionOf(e).position === "CB")!;
    const asCb = cardFit(cb, "CB");
    const asSt = cardFit(cb, "ST");
    expect(asCb).not.toBe(asSt);
    // 센터백을 최전방에 세우면 전력이 깎인다
    expect(asSt).toBeLessThan(asCb);
  });

  it("좌우 분화는 같은 가중치를 쓴다 (CB=RCB=LCB · CM=RCM=LCM)", () => {
    const p = playerCatalog()[0]!;
    expect(cardFit(p, "RCB")).toBe(cardFit(p, "CB"));
    expect(cardFit(p, "LCB")).toBe(cardFit(p, "CB"));
    expect(cardFit(p, "RCM")).toBe(cardFit(p, "CM"));
    expect(weightSlotOf("LWB")).toBe(weightSlotOf("RB"));
  });

  it("CF는 ST와 다른 자리다 — 정통 9번과 요구 역량이 갈린다", () => {
    expect(weightSlotOf("CF")).not.toBe(weightSlotOf("ST"));
    // 처진 스트라이커는 정통 9번보다 CF 쪽이다
    expect(weightSlotOf("SS")).toBe(weightSlotOf("CF"));
    // 점프력·몸싸움은 ST가 더 보고, 드리블·시야는 CF가 더 본다
    const st = POSITION_WEIGHTS.ST;
    const cf = POSITION_WEIGHTS.CF;
    expect(st.jumpingReach).toBeGreaterThan(cf.jumpingReach);
    expect(cf.dribbling).toBeGreaterThan(st.dribbling);
    expect(cf.vision).toBeGreaterThan(st.vision);
    // 마무리는 둘 다 가장 무겁다
    const heaviest = (w: typeof st) => OVERALL_AXES.reduce((a, b) => (w[b] > w[a] ? b : a));
    expect(heaviest(cf)).toBe("finishing");
    expect(heaviest(st)).toBe("finishing");
  });

  it("최전방 자원은 예외 없이 ST 자리를 갖는다", () => {
    const frontline = playerCatalog().filter((e) =>
      ["ST", "RW", "LW", "AM"].includes(naturalPositionOf(e).position),
    );
    expect(frontline.length).toBeGreaterThan(400);
    for (const e of frontline) {
      const st = e.positions.find((p) => p.position === "ST");
      expect(st, `${e.nameEn} (${naturalPositionOf(e).position})에 ST 없음`).toBeDefined();
      expect(st!.proficiency).toBeGreaterThan(0);
    }
  });
});

/** 자리(WeightSlot)별 대표 포지션 코드 — 슬롯 이름은 포지션 코드가 아니다 */
const SLOT_SAMPLE: Record<WeightSlot, string> = {
  GK: "GK",
  CB: "CB",
  FB: "LB",
  DM: "CDM",
  CM: "CM",
  AM: "CAM",
  W: "RW",
  CF: "CF",
  ST: "ST",
};

/** 낱말 하나를 끝까지 민 카드 — 카드의 모든 방향을 도는 표본 */
const EDGE_CARDS: RoleCard[] = CARD_WORDS.flatMap((word) =>
  [-CARD_STEP_MAX, CARD_STEP_MAX].map((step) => ({
    ip: { [word]: step },
    oop: { [word]: step },
  })),
);

describe("역할 카드의 가중치와 적합도 (player.md §3)", () => {
  const cat = playerCatalog();
  it("빈 카드는 그 자리의 기본 가중치다", () => {
    for (const [slot, code] of Object.entries(SLOT_SAMPLE)) {
      expect(cardWeights(code)).toEqual(POSITION_WEIGHTS[slot as WeightSlot]);
      expect(cardWeights(code, { ip: {}, oop: {} })).toEqual(POSITION_WEIGHTS[slot as WeightSlot]);
    }
  });

  it("카드 가중치도 눈금 안에 있고, 성공 축이 있는 방향은 표를 바꾼다", () => {
    for (const [slot, code] of Object.entries(SLOT_SAMPLE)) {
      for (const word of CARD_WORDS) {
        for (const step of [-CARD_STEP_MAX, CARD_STEP_MAX]) {
          const card = { ip: { [word]: step }, oop: { [word]: step } };
          const w = cardWeights(code, card);
          for (const a of OVERALL_AXES) {
            expect(w[a], `${slot}:${word}${step}.${a}`).toBeGreaterThanOrEqual(
              axisFloorAt(slot as WeightSlot, a),
            );
            expect(w[a], `${slot}:${word}${step}.${a}`).toBeLessThanOrEqual(3);
          }
          const def = CARD_WORD_DEFS[word];
          const axes = step > 0 ? def.plusAxes : def.minusAxes;
          // 그 자리에 있는 축이 하나라도 있으면 표가 달라진다 (GK 자리의 필드 축은 0이라 그대로다)
          const present = axes.some((a) => axisFloorAt(slot as WeightSlot, a) > 0);
          if (present) {
            expect(w, `${slot}:${word}${step}`).not.toEqual(POSITION_WEIGHTS[slot as WeightSlot]);
          }
        }
      }
    }
  });

  it("카드가 맞는 선수에게 오른다 — 빠른 센터백은 뒷공간을 노리는 카드에서 더 얻는다", () => {
    const cbs = cat.filter((e) => weightSlotOf(naturalPositionOf(e).position) === "CB");
    const strong = [...cbs].sort((a, b) => cardFit(b, "CB") - cardFit(a, "CB")).slice(0, 40);
    const fast = [...strong].sort((a, b) => b.pace - a.pace)[0]!;
    const slow = [...strong].sort((a, b) => a.pace - b.pace)[0]!;
    expect(fast.pace - slow.pace).toBeGreaterThan(20);
    const RUNNING: RoleCard = { ip: { runBehind: 3 }, oop: {} };
    const gain = (e: typeof fast) => cardFit(e, "CB", RUNNING) - cardFit(e, "CB");
    expect(gain(fast), fast.nameEn).toBeGreaterThan(gain(slow));
  });

  it("평균적인 선수는 어느 카드에서도 기본 카드와 같은 값이다 — 카드는 공짜 능력치가 아니다", () => {
    for (const [slot, code] of Object.entries(SLOT_SAMPLE)) {
      const reference = SLOT_REFERENCE[slot as WeightSlot] as unknown as AxisValues;
      const base = cardFit(reference, code);
      for (const card of EDGE_CARDS) {
        // 반올림 한 칸까지 — 기준점은 평균에서 정확히 0이고 접는 자리만 남는다
        expect(Math.abs(cardFit(reference, code, card) - base), slot).toBeLessThanOrEqual(1);
      }
    }
  });

  it("공 있을 때의 자리를 둔 카드는 두 자리의 바탕을 반씩 쓰고, 그 위의 낱말도 공짜가 아니다", () => {
    const inverted: RoleCard = { ip: { place: "DM" }, oop: {} };
    const w = cardWeights("RB", inverted);
    for (const a of OVERALL_AXES) {
      expect(w[a], a).toBeCloseTo((POSITION_WEIGHTS.FB[a] + POSITION_WEIGHTS.DM[a]) / 2, 1);
    }
    const blend = Object.fromEntries(
      OVERALL_AXES.map((a) => [a, (SLOT_REFERENCE.FB[a] + SLOT_REFERENCE.DM[a]) / 2]),
    ) as unknown as AxisValues;
    const base = cardFit(blend, "RB", inverted);
    for (const card of EDGE_CARDS) {
      const withPlace: RoleCard = { ...card, ip: { ...card.ip, place: "DM" } };
      expect(Math.abs(cardFit(blend, "RB", withPlace) - base)).toBeLessThanOrEqual(1);
    }
  });

  it("두드러진 축은 그 자리의 평균에서 잰다 — 스트라이커의 약점이 태클이 되지 않는다", () => {
    const ref = SLOT_REFERENCE.ST;
    const axes = {
      ...Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, 50])),
      ...ref,
      pace: ref.pace + 20,
      heading: ref.heading - 20,
    } as AxisValues;
    const { strengths, weaknesses } = standoutAxes(axes, "LST", 3);
    expect(strengths[0]).toBe("pace");
    expect(weaknesses[0]).toBe("heading");
    expect([...strengths, ...weaknesses]).not.toContain("tackling");
  });

  it("기준 선수와 버릇의 기준은 카탈로그의 그 자리 평균이다 — 어긋나면 pnpm slot-reference --write", () => {
    const sums = new Map<WeightSlot, { n: number; axes: Record<string, number> }>();
    for (const e of cat) {
      const slot = weightSlotOf(naturalPositionOf(e).position);
      const row = sums.get(slot) ?? { n: 0, axes: {} };
      row.n += 1;
      for (const a of [...OVERALL_AXES, ...INCLINATION_AXES])
        row.axes[a] = (row.axes[a] ?? 0) + e[a];
      sums.set(slot, row);
    }
    for (const slot of Object.keys(SLOT_REFERENCE) as WeightSlot[]) {
      // CF 묶음에는 주 자리 선수가 없다 — 같은 자리(ST)의 선수가 채운다
      const row = sums.get(slot === "CF" ? "ST" : slot)!;
      for (const a of OVERALL_AXES) {
        expect(
          Math.abs(SLOT_REFERENCE[slot][a] - row.axes[a]! / row.n),
          `${slot}.${a}`,
        ).toBeLessThanOrEqual(1);
      }
      for (const a of INCLINATION_AXES) {
        expect(
          Math.abs(SLOT_INCLINATION[slot][a] - row.axes[a]! / row.n),
          `${slot}.${a}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("종합(overall) — 가장 잘 맞는 자리 · 빈 카드", () => {
  it("종합은 그 선수 축의 범위 안에 있다 — 어느 자리·어느 역할에서도", () => {
    /**
     * **이 불변식이 종합의 정의다** (player.md §4). 16축을 함께 펼쳐 놓은 화면에서
     * 종합이 어느 축보다 높으면 감독은 계산이 틀렸다고 읽는다 — 실제로 그랬다:
     * 축 최대 92인 선수의 종합이 93으로 나왔고, 카탈로그 5,780명 중 52명이 그랬다.
     *
     * 자리·카드를 전부 도는 이유는 카드 기준점이 평행 이동이라
     * **범위 밖으로 밀어낼 수 있는 유일한 항**이기 때문이다.
     */
    const violations: string[] = [];
    for (const entry of playerCatalog()) {
      const values = ATTRIBUTE_AXES.map((a) => entry[a]);
      const low = Math.min(...values);
      const high = Math.max(...values);
      for (const { position } of entry.positions) {
        for (const [i, card] of EDGE_CARDS.entries()) {
          const fit = cardFit(entry, position, card);
          if (fit >= low && fit <= high) continue;
          violations.push(`${entry.nameEn} ${position}:card${i} ${fit} ∉ [${low}, ${high}]`);
        }
      }
      const shown = bestOverall(entry, entry.positions);
      if (shown < low || shown > high) {
        violations.push(`${entry.nameEn} 표시용 종합 ${shown} ∉ [${low}, ${high}]`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });

  it("종합은 역할 카드를 타지 않는다 — 숫자 하나가 여러 등급이 되면 안 된다", () => {
    const p = playerCatalog().find((e) => naturalPositionOf(e).position === "ST")!;
    const shown = bestOverall(p, p.positions);
    // 어떤 카드로 세워도 표시용 종합은 그대로고, 그 자리 값만 달라진다
    const values = EDGE_CARDS.map((card) => cardFit(p, "ST", card));
    expect(new Set(values).size).toBeGreaterThan(1);
    expect(bestOverall(p, p.positions)).toBe(shown);
  });
});

describe("축별 노화 곡선", () => {
  it("다리는 먼저 죽고 머리는 늦게까지 자란다", () => {
    // 32세 — 스피드는 꺾이고 시야·침착성은 아직 오른다
    expect(agingDelta("pace", 32)).toBeLessThan(0);
    expect(agingDelta("stamina", 32)).toBeLessThan(0);
    expect(agingDelta("vision", 32)).toBeGreaterThan(0);
    expect(agingDelta("composure", 32)).toBeGreaterThan(0);
    // 24세 — 아직 아무것도 잃지 않는다
    for (const axis of ATTRIBUTE_AXES) expect(agingDelta(axis, 24)).toBeGreaterThanOrEqual(0);
  });

  it("성향(aggression)은 나이로 변하지 않는다", () => {
    for (const age of [18, 24, 30, 36]) expect(agingDelta("aggression", age)).toBe(0);
  });
});

// ─── 주발·신체 파생 (physique.test.ts에서 옮겨 왔다) ───
/** 주발 분포와 신체 파생 (catalog.ts · player.md §1 · §4) */

describe("약발 — 실측이 원본, 모르는 실존 선수만 4", () => {
  const cat = playerCatalog();

  it("주발은 언제나 5 — 약발만 갈린다", () => {
    for (const e of cat) {
      if (!e.foot) continue;
      expect(Math.max(e.foot.left, e.foot.right), e.nameEn).toBe(5);
    }
  });

  it("조사가 닿지 않은 실존 선수는 4 — 지어내지 않는다", () => {
    /**
     * 실존 인물의 약발을 해시로 뽑으면 실제로는 멀쩡한 선수가 우연히 나빠진다.
     * 틀린 값을 지어내느니 무난한 쪽으로 둔다.
     */
    const unknown = footOf("Nobody Special", "LCB");
    expect(Math.max(unknown.left, unknown.right)).toBe(5);
    expect(Math.min(unknown.left, unknown.right)).toBe(4);
    expect(footOf("Nobody Special", "LCB", { foot: "L", weakFoot: 1 })).toEqual({
      left: 5,
      right: 1,
    });
  });

  it("결정적이다 — 같은 이름·자리면 같은 발", () => {
    expect(footOf("Test Player", "LCB")).toEqual(footOf("Test Player", "LCB"));
  });
});

describe("신체 — 능력치와 앞뒤가 맞는다", () => {
  it("점프력이 높으면 키가 따라간다 — 화면이 거짓말하지 않게", () => {
    const tall = physiqueOf("A", "CB", { jumpingReach: 92, strength: 80, pace: 60 });
    const short = physiqueOf("A", "CB", { jumpingReach: 50, strength: 80, pace: 60 });
    expect(tall.height).toBeGreaterThan(short.height + 5);
  });

  it("몸싸움은 무겁게, 스피드는 가볍게 — 같은 키라도 몸이 다르다", () => {
    const power = physiqueOf("B", "ST", { jumpingReach: 70, strength: 92, pace: 60 });
    const speed = physiqueOf("B", "ST", { jumpingReach: 70, strength: 60, pace: 92 });
    expect(power.height).toBe(speed.height); // 점프력이 같으니 키도 같다
    expect(power.weight).toBeGreaterThan(speed.weight);
  });

  it("사람의 범위를 벗어나지 않는다", () => {
    for (const e of playerCatalog()) {
      if (!e.height || !e.weight) continue;
      expect(e.height, e.nameEn).toBeGreaterThanOrEqual(160);
      expect(e.height, e.nameEn).toBeLessThanOrEqual(206);
      // 실측값은 파생 범위보다 넓다 — 리스 제임스(180/91)와 메슬리에(196/74)가 양 끝이다.
      // 시드가 EA 등재값을 받을 때 이 범위를 문턱으로 쓴다(`plausible_physique`) —
      // EA에도 191cm/60kg 같은 오류가 있어 그런 값은 파생으로 되돌린다.
      const bmi = e.weight / (e.height / 100) ** 2;
      expect(bmi, `${e.nameEn} BMI`).toBeGreaterThan(18.5);
      expect(bmi, `${e.nameEn} BMI`).toBeLessThan(28.5);
    }
  });
});

/**
 * 자체 산정 모델 (player.md §13) — **분포가 사람 사는 범위인가는 여기서 안 본다.**
 * 그것은 `harness/attribute-model.harness.ts`가 두 분포의 간격으로 잰다. 못 박히는
 * 것은 조용히 틀어지는 것들이다: 되맞춤이 멎는가 · 같은 입력이 같은 사람을 내는가 ·
 * 값이 눈금 안에 있는가 · 낙차 표가 단조인가.
 */
describe("자체 산정 모델 — 체급·깊이·자리·나이만으로 세운다", () => {
  /** 자리마다 하나씩 — `WeightSlot` 아홉을 다 덮는 포지션 코드 */
  const POSITIONS = ["GK", "CB", "RB", "DM", "CM", "AM", "RW", "CF", "ST"];
  const TIERS = [1, 2, 3, 4] as const;
  const RANKS = [0, 1, 5, 11, 18, 25, 33, 42];

  /**
   * 되맞춤이 상한에서 멎어도 목표에서 이만큼 밖으로는 안 나간다.
   * (실측 최악 1.5 — 종합이 정수라 인접한 두 값 사이에서 진동하는 자리다)
   */
  const RETARGET_WORST = 2;

  function everyone(): { key: string; player: SynthesizedPlayer }[] {
    const out: { key: string; player: SynthesizedPlayer }[] = [];
    for (const tier of TIERS) {
      for (const position of POSITIONS) {
        for (const rank of RANKS) {
          for (const secondDivision of [false, true]) {
            const key = `${tier}:${position}:${rank}:${secondDivision}`;
            const positions = derivePositions(key, position);
            out.push({
              key,
              player: synthesizeSeed({ key, tier, rank, positions, secondDivision }),
            });
          }
        }
      }
    }
    return out;
  }

  it("되맞춤은 유한 회 안에 멎고 목표 종합에 붙는다", () => {
    for (const { key, player } of everyone()) {
      expect(player.passes, key).toBeLessThanOrEqual(RETARGET_MAX_PASSES);
      expect(Math.abs(player.target - player.overall), key).toBeLessThanOrEqual(RETARGET_WORST);
    }
  });

  it("같은 입력은 언제나 같은 사람을 낸다", () => {
    const positions = derivePositions("Deterministic Sample", "CM");
    const once = synthesizeSeed({ key: "Deterministic Sample", tier: 2, rank: 7, positions });
    const twice = synthesizeSeed({ key: "Deterministic Sample", tier: 2, rank: 7, positions });
    expect(twice).toEqual(once);
  });

  it("축은 1~99, 잠재력은 종합 이상이고 나이 대역 안이다", () => {
    for (const { key, player } of everyone()) {
      for (const [axis, value] of Object.entries(player.seed)) {
        // 필드 플레이어의 goalkeeping은 시드가 비우는 자리다 — `deriveAxes`가 만든다
        if (axis === "goalkeeping" && (value === 0 || value === undefined)) continue;
        if (value === undefined) throw new Error(`${key} ${axis} 없음`);
        expect(value, `${key} ${axis}`).toBeGreaterThanOrEqual(1);
        expect(value, `${key} ${axis}`).toBeLessThanOrEqual(99);
      }
      const room = player.potential - player.overall;
      const band = potentialGapBand(player.age);
      expect(player.potential, key).toBeLessThanOrEqual(99);
      expect(room, key).toBeGreaterThanOrEqual(0);
      // 99 천장에 잘린 선수는 하한 아래로 접힌다 — 그때만 대역 밑이 정상이다
      if (player.potential < 99) expect(room, key).toBeGreaterThanOrEqual(band.min);
      expect(room, key).toBeLessThanOrEqual(band.max);
    }
  });

  it("낙차는 순번이 깊어질수록 단조로 떨어진다", () => {
    expect(depthDropAt(0)).toBe(0);
    for (let rank = 1; rank <= 50; rank++) {
      expect(depthDropAt(rank), `순번 ${rank}`).toBeLessThan(depthDropAt(rank - 1));
    }
  });

  it("꼭대기는 체급 순이고 2부는 그 아래에서 시작한다", () => {
    for (const tier of [2, 3, 4] as const) {
      expect(squadApexOf(tier)).toBeLessThan(squadApexOf((tier - 1) as 1 | 2 | 3));
      expect(squadApexOf(tier, true)).toBeLessThan(squadApexOf(tier));
    }
  });
});

describe("shirt numbers", () => {
  // ─── 등번호 배정 (squad-numbers.test.ts에서 옮겨 왔다) ───
  /**
   * 등번호만 보는 최소 선수 — 자리·팀·번호가 전부다.
   *
   * 배정은 `positions`·`teamId`·`squadNumber`만 읽으므로 세계를 만들 이유가 없다
   * (`createTestGame`은 수천 명을 인스턴스화해 수 초를 쓴다).
   */
  function player(id: string, teamId: string, position: Place, squadNumber?: number): GamePlayer {
    const axes = Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, 70])) as Record<string, number>;
    return {
      id,
      catalogId: null,
      teamId,
      name: id,
      birthdate: "2000-01-01",
      positions: [{ position, proficiency: 90, isNatural: true }],
      attributes: { ...axes, potential: 75 } as GamePlayer["attributes"],
      state: freshPlayerState({ form: 0, condition: 75 }),
      isCaptain: false,
      isViceCaptain: false,
      squadLevel: "first",
      growthCarry: {},
      squadNumber,
    };
  }

  const POSITIONS = ["GK", "RB", "LB", "CB", "DM", "CM", "AM", "RW", "LW", "ST"] as const;

  /**
   * 뒤엉킨 명단 하나 — 배정이 밟는 갈래를 전부 담는다.
   *
   * 빈 번호, 같은 팀 안의 중복, **아직 차례가 오지 않은 뒤쪽 동료가 쥔 번호**,
   * 번호를 들고 있는 무소속. 마지막 둘이 프리패스가 틀리기 쉬운 자리다.
   */
  function tangledSquad(seed: number): GamePlayer[] {
    const next = makeRng(seed);
    const teams = ["alpha", "beta", "gamma", "freeagents"];
    const players: GamePlayer[] = [];
    for (let i = 0; i < 120; i++) {
      const teamId = teams[Math.floor(next() * teams.length)]!;
      const position = POSITIONS[Math.floor(next() * POSITIONS.length)]!;
      const roll = next();
      const squadNumber =
        roll < 0.3
          ? undefined // 미배정 — 새로 받아야 한다
          : roll < 0.6
            ? 1 + Math.floor(next() * 12) // 좁은 구간 — 중복이 흔하게 난다
            : 1 + Math.floor(next() * 99);
      players.push(player(`p${i}`, teamId, position, squadNumber));
    }
    return players;
  }

  function numbersOf(players: readonly GamePlayer[]): Array<number | undefined> {
    return players.map((one) => one.squadNumber);
  }

  describe("등번호 배정 (squad/numbers.ts)", () => {
    it("한 번 채운 명단을 다시 채워도 번호가 그대로다 (멱등)", () => {
      const squad = tangledSquad(7);
      ensureSquadNumbers(squad);
      const settled = numbersOf(squad);
      ensureSquadNumbers(squad);
      expect(numbersOf(squad)).toEqual(settled);
    });

    it("클럽 소속은 팀 안에서 겹치지 않는 1~99를 갖고, 무소속은 번호를 잃는다", () => {
      const squad = tangledSquad(3);
      ensureSquadNumbers(squad);

      const byTeam = new Map<string, number[]>();
      for (const one of squad) {
        if (one.teamId === "freeagents") {
          expect(one.squadNumber).toBeUndefined();
          continue;
        }
        expect(one.squadNumber).toBeGreaterThanOrEqual(1);
        expect(one.squadNumber).toBeLessThanOrEqual(99);
        byTeam.set(one.teamId, [...(byTeam.get(one.teamId) ?? []), one.squadNumber!]);
      }
      for (const [teamId, numbers] of byTeam) {
        expect(new Set(numbers).size, teamId).toBe(numbers.length);
      }
    });

    it("자리 관례를 먼저 준다 — 골키퍼는 1번, 그다음 골키퍼는 13번", () => {
      const squad = [player("gk1", "alpha", "GK"), player("gk2", "alpha", "GK")];
      ensureSquadNumbers(squad);
      expect(numbersOf(squad)).toEqual([1, 13]);
      expect(naturalPositionOf(squad[0]!).position).toBe("GK");
    });
  });

  // ─── 감독이 지목하는 번호 · 번호의 뜻 (player.md §1.1 · people.md §5·§6) ───

  const NUMBER_TEAM = "alpha";
  const NUMBER_SEASON = 3;

  /** 그 팀 그 번호를 달고 뛴 한 시즌 — 계보의 유일한 원본이다 */
  const numberStat = (playerId: string, season: number, squadNumber: number) =>
    ({
      gamePlayerId: playerId,
      season,
      teamId: NUMBER_TEAM,
      squadNumber,
      apps: 20,
      goals: 0,
    }) as unknown as GameState["seasonStats"][number];

  /**
   * 등번호만 보는 최소 세계 — 배정은 명단과 시즌 기록만 읽는다.
   * (`createTestGame`은 한 번에 수 초라 순수 규칙을 재는 자리에서는 부르지 않는다)
   */
  function numberState(
    players: GamePlayer[],
    seasonStats: GameState["seasonStats"] = [],
  ): GameState {
    return {
      date: `${2020 + NUMBER_SEASON}-03-01`,
      season: NUMBER_SEASON,
      userTeamId: NUMBER_TEAM,
      players,
      seasonStats,
      retired: [],
      issues: [],
    } as unknown as GameState;
  }

  describe("감독이 지목하는 등번호 (assignRequestedNumber)", () => {
    it("1~99 밖은 배정되지 않고 지금 번호도 흔들리지 않는다", () => {
      const one = player("mine", NUMBER_TEAM, "ST", 20);
      const state = numberState([one]);
      for (const asked of [0, 100]) {
        const result = assignRequestedNumber(state, one, asked);
        expect(result.ok, `${asked}번`).toBe(false);
        if (!result.ok) expect(result.block.code).toBe("out-of-range");
      }
      expect(one.squadNumber).toBe(20);
    });

    it("동료가 달고 있으면 반려하고, 반려 카드가 그 동료를 들고 나간다", () => {
      const mine = player("mine", NUMBER_TEAM, "ST", 20);
      const holder = player("holder", NUMBER_TEAM, "AM", 10);
      const state = numberState([mine, holder]);

      const result = assignRequestedNumber(state, mine, 10);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.block.code).toBe("number-taken");
      // 감독이 넘길지를 고르려면 지금 그 번호를 단 사람의 이름이 반려 줄에 있어야 한다
      expect(numberBlockText(result.block)).toContain("holder");
      expect(mine.squadNumber).toBe(20);
      expect(holder.squadNumber).toBe(10);
    });

    it("take는 번호를 넘기고 — 뺏긴 선수는 **빈 번호를 새로 받는다**", () => {
      const mine = player("mine", NUMBER_TEAM, "ST", 20);
      const holder = player("holder", NUMBER_TEAM, "AM", 10);
      const mate = player("mate", NUMBER_TEAM, "CM", 8);
      const state = numberState([mine, holder, mate]);

      const result = assignRequestedNumber(state, mine, 10, { take: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const displaced = result.assignment.displaced;
      expect(mine.squadNumber).toBe(10);
      expect(displaced?.player.id).toBe("holder");
      expect(displaced?.lost).toBe(10);
      // 번호 없이 남겨 두면 다음 로드가 아무 번호나 채운다
      expect(holder.squadNumber).toBe(displaced?.gained);
      const numbers = [mine, holder, mate].map((one) => one.squadNumber);
      expect(numbers.every((n) => n !== undefined)).toBe(true);
      expect(new Set(numbers).size).toBe(numbers.length);
    });
  });

  describe("번호의 계보 (numberLineageOf)", () => {
    it("시즌 기록에서 앞사람과 시즌 수를 세운다 — 두 번 물어도 같은 답", () => {
      const now = player("now", NUMBER_TEAM, "ST", 9);
      const before = player("before", NUMBER_TEAM, "AM", 21);
      const state = numberState(
        [now, before],
        [
          numberStat("before", NUMBER_SEASON - 2, 9),
          numberStat("before", NUMBER_SEASON - 1, 9),
          numberStat("now", NUMBER_SEASON, 9),
        ],
      );

      const lineage = numberLineageOf(state, NUMBER_TEAM, 9);
      expect(lineage.holder?.playerId).toBe("now");
      expect(lineage.holder?.seasons).toBe(1);
      // 지금 그 번호를 단 사람은 계보에 서지 않는다 — 그는 홀더다
      expect(lineage.past.map((entry) => entry.playerId)).toEqual(["before"]);
      expect(lineage.past[0]?.seasons).toBe(2);
      expect(lineage.past[0]?.lastSeason).toBe(NUMBER_SEASON - 1);
      // 저장하지 않고 매번 파생하므로 결정적이어야 한다
      expect(numberLineageOf(state, NUMBER_TEAM, 9)).toEqual(lineage);
    });
  });
});
