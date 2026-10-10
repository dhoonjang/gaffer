import { describe, expect, it } from "vitest";
import {
  CARD_STEP_MAX,
  CARD_WORDS,
  DEFAULT_TACTICS,
  type RoleCard,
  type WeightSlot,
} from "@gaffer/domain";
import {
  SLOT_TENDENCY,
  TENDENCY_AXES,
  WORD_TENDENCY_STEP,
  cardTendencyOf,
} from "../src/live/roles";
import { shapePosition } from "../src/live/shape";
import { teamParamsOf } from "../src/live/params";

/** 자리 묶음마다 대표 포지션 코드 하나 */
const POSITION_OF_SLOT: Record<WeightSlot, string> = {
  GK: "GK",
  CB: "CB",
  FB: "RB",
  DM: "DM",
  CM: "CM",
  AM: "AM",
  W: "RW",
  CF: "CF",
  ST: "ST",
};
const SLOTS = Object.keys(POSITION_OF_SLOT) as WeightSlot[];

const inUnit = (v: number) => v >= 0 && v <= 1;

describe("역할 카드의 성향 — 자리 기본값 + 낱말의 단계 (live-match.md §4)", () => {
  it("모든 자리의 기본값이 0..1 안이다", () => {
    for (const slot of SLOTS)
      for (const axis of TENDENCY_AXES) expect(inUnit(SLOT_TENDENCY[slot][axis])).toBe(true);
  });

  it("어느 자리에서 어느 낱말을 끝까지 밀어도 0..1 안이다", () => {
    for (const slot of SLOTS) {
      const position = POSITION_OF_SLOT[slot];
      for (const word of CARD_WORDS) {
        for (const step of [-CARD_STEP_MAX, CARD_STEP_MAX]) {
          const card = { ip: { [word]: step }, oop: { [word]: step } };
          const t = cardTendencyOf(position, card);
          for (const axis of TENDENCY_AXES)
            expect(inUnit(t[axis]), `${slot}.${word}.${axis}`).toBe(true);
        }
      }
    }
  });

  it("낱말마다 옮기는 성향이 있다 — 엔진에 닿지 않는 낱말은 없다", () => {
    for (const word of CARD_WORDS) {
      expect(Object.keys(WORD_TENDENCY_STEP[word]).length, word).toBeGreaterThan(0);
    }
  });

  it("카드가 없으면 자리 기본값이고, 0인 낱말은 아무것도 옮기지 않는다", () => {
    expect(cardTendencyOf("ST")).toEqual(SLOT_TENDENCY.ST);
    expect(cardTendencyOf("LCB", { ip: {}, oop: {} })).toEqual(SLOT_TENDENCY.CB);
    expect(cardTendencyOf("RB", { ip: { attack: 0 }, oop: {} })).toEqual(SLOT_TENDENCY.FB);
  });

  it("낱말의 뜻이 성향에 남는다 — 방향과 단계가 그대로 간다", () => {
    const fb = (card: Parameters<typeof cardTendencyOf>[1]) => cardTendencyOf("RB", card);
    expect(fb({ ip: { attack: 2 }, oop: {} }).advance).toBeGreaterThan(fb(undefined).advance);
    expect(fb({ ip: { attack: -2 }, oop: {} }).advance).toBeLessThan(fb(undefined).advance);
    expect(fb({ ip: { attack: 3 }, oop: {} }).advance).toBeGreaterThan(
      fb({ ip: { attack: 1 }, oop: {} }).advance,
    );
    expect(cardTendencyOf("RW", { ip: { width: -2 }, oop: {} }).inside).toBeGreaterThan(
      SLOT_TENDENCY.W.inside,
    );
    expect(cardTendencyOf("ST", { ip: {}, oop: { press: 3 } }).press).toBeGreaterThan(
      SLOT_TENDENCY.ST.press,
    );
    expect(cardTendencyOf("CB", { ip: {}, oop: { recover: 2 } }).cover).toBeGreaterThan(
      SLOT_TENDENCY.CB.cover,
    );
    expect(cardTendencyOf("GK", { ip: {}, oop: { sweep: 2 } }).sweep).toBeGreaterThan(
      SLOT_TENDENCY.GK.sweep,
    );
  });
});

describe("공 있을 때의 자리 (player.md §3.3)", () => {
  const INVERTED: RoleCard = { ip: { place: "DM" }, oop: {} };

  it("공 있을 때 성향의 기본값은 그 자리의 것이고, 공 없을 때의 넷은 전술판 자리에 남는다", () => {
    const t = cardTendencyOf("RB", INVERTED);
    const outOfPossession: readonly string[] = ["press", "cover", "mark", "sweep"];
    for (const axis of TENDENCY_AXES) {
      const from = outOfPossession.includes(axis) ? SLOT_TENDENCY.FB : SLOT_TENDENCY.DM;
      expect(t[axis], axis).toBe(from[axis]);
    }
  });

  it("공을 가지면 앵커가 그 자리로 옮는다 — 측면에서 그 쪽 반공간으로. 공이 없으면 전술판 그대로", () => {
    const params = teamParamsOf(DEFAULT_TACTICS, 1, 1);
    const at = (card: RoleCard | undefined, attacking: boolean) =>
      shapePosition(
        { position: "RB", point: { x: 89, y: 72 }, ...(card ? { card } : {}) },
        cardTendencyOf("RB", card),
        {
          side: "home",
          params,
          attacking,
          phase: attacking ? "progression" : "organised_defence",
          ballDepth: 50,
          ballLateral: 34,
          backLine: 20,
          frontLimit: attacking ? 95 : 42,
        },
      );
    const centre = 34;
    expect(Math.abs(at(INVERTED, true).y - centre)).toBeLessThan(
      Math.abs(at(undefined, true).y - centre),
    );
    // 오른쪽에서 들어왔으니 오른쪽 반공간 — 가운데를 넘어가지 않는다
    expect(Math.sign(at(INVERTED, true).y - centre)).toBe(
      Math.sign(at(undefined, true).y - centre),
    );
    expect(at(INVERTED, false)).toEqual(at(undefined, false));
  });
});
