import { describe, expect, it } from "vitest";
import {
  GROWTH_OUTLOOKS,
  growthOutlookOf,
  FAMILIARITY_BASELINE,
  FAMILIARITY_MAX,
  FAMILIARITY_TIERS,
  POSITION_CODES,
  familiarityLabel,
  findRole,
  roleChoiceText,
  roleVocabularyText,
  rolesFor,
} from "@story-fm/domain";

/**
 * 판정이 코어에만 있는 눈금은 LLM에 **어휘로** 실린다 (prompts.md §5-2).
 *
 * 여기서 지키는 건 어휘 자체가 아니라 자의 성질이다 — 구간이 눈금 전체를 빈틈없이
 * 덮고, 경계가 표에 적힌 그 값에서 넘어가고, 같은 구간이면 언제나 같은 말이 나온다.
 * 경계가 조용히 한 칸 밀리면 "보드 두터움"이 나올 자리에서 "관망"이 나온다.
 */

/** 사다리가 눈금을 덮는가 — 내림차순이고, 바닥이 0이고, 구멍이 없다 */
const laddersCover = (tiers: readonly { min: number }[]) => {
  const mins = tiers.map((t) => t.min);
  expect([...mins].sort((a, b) => b - a)).toEqual(mins);
  expect(mins[mins.length - 1]).toBe(0);
  expect(new Set(mins).size).toBe(mins.length);
};

describe("팀 전술 적응 구간 → 어휘", () => {
  it("구간이 0~100을 빈틈없이 덮는다", () => {
    laddersCover(FAMILIARITY_TIERS);
  });

  it("경계에서 넘어간다", () => {
    FAMILIARITY_TIERS.forEach((tier, i) => {
      const below = FAMILIARITY_TIERS[i + 1];
      expect(familiarityLabel(tier.min)).toBe(tier.ko);
      if (below) expect(familiarityLabel(tier.min - 1)).toBe(below.ko);
    });
  });

  /**
   * 훈련이 전액으로 실리는 상한(65)과 훈련의 몫이 0에 닿는 자리(90 언저리)가 경계다.
   * 신입 기준선 60은 아직 익히는 중이라야 한다 — 처음 판에 오른 선수가 「익숙」으로
   * 서면 감독이 손댈 자리가 없어 보인다.
   */
  it("신입 기준선은 익히는 중이고, 훈련장 위는 경기의 몫이다", () => {
    expect(familiarityLabel(FAMILIARITY_BASELINE)).toBe("익히는 중");
    expect(familiarityLabel(65)).toBe("익숙");
    expect(familiarityLabel(89)).toBe("익숙");
    expect(familiarityLabel(90)).toBe("완숙");
    expect(familiarityLabel(FAMILIARITY_MAX)).toBe("완숙");
    expect(familiarityLabel(0)).toBe("생소");
  });
});

/**
 * **역할의 표기는 셋이고 그 셋이 한 역할로 모인다** (player.md §3.1).
 *
 * 전술판은 id를 보내고 **감독의 말을 옮기는 해석기는 이름을 적는다** — 한 표기만 받으면
 * 그쪽 경로의 역할 지시만 조용히 반려되고, 한 번 부르는 해석기에는 그 반려를 보고 다시
 * 시도할 자리가 없다. 표기가 서로 부딪혀도 같은 실패라, 50종 전부를 견준다.
 */
describe("자리별 역할 → 어휘", () => {
  it("이름·id·약어가 저마다 그 역할 하나로 걸린다", () => {
    for (const position of POSITION_CODES) {
      for (const def of rolesFor(position)) {
        for (const spelling of [def.ko, def.id, def.abbr]) {
          expect(findRole(position, spelling)?.id, `${position}: ${spelling}`).toBe(def.id);
        }
      }
    }
  });

  it("대소문자·공백·붙임표는 견줄 때 지운다", () => {
    for (const spelling of ["인사이드 포워드", "인사이드포워드", "Inside Forward", "if"]) {
      expect(findRole("LW", spelling)?.id, spelling).toBe("inside-forward");
    }
  });

  it("그 자리에 없는 역할과 빈 말은 걸리지 않는다", () => {
    expect(findRole("CB", "포처")).toBeUndefined();
    expect(findRole("CB", "  ")).toBeUndefined();
  });

  /**
   * 표의 왼쪽은 **모델이 명단·스냅샷에서 읽는 포지션 코드**다. 코드가 하나라도 빠지면
   * 그 자리의 역할은 모델에게 없는 것과 같고, `weightSlotOf`의 폴백이 조용히 CM의
   * 역할을 걸어 준다.
   */
  it("역할 표가 포지션 코드 전부를 세우고 그 자리의 역할을 싣는다", () => {
    const table = roleVocabularyText();
    const codes = table.split("\n").flatMap((line) => line.split(" — ")[0]!.split("/"));
    expect([...codes].sort()).toEqual([...POSITION_CODES].sort());
    for (const position of POSITION_CODES) {
      for (const def of rolesFor(position)) {
        expect(table, `${position}: ${def.id}`).toContain(roleChoiceText(def));
      }
    }
  });
});

/** 성장 가능성 — 문턱은 코어에만 있고 화면은 단계를 그리기만 한다 (player.md §9.1) */
describe("성장 가능성 단계", () => {
  it.each([
    [-5, 0],
    [0, 0],
    [2, 0],
    [3, 1],
    [5, 1],
    [6, 2],
    [9, 2],
    [10, 3],
    [14, 3],
    [15, 4],
    [19, 4],
    [20, 4],
    [24, 4],
    [25, 5],
  ])("종합 60에 여지 %s면 단계 %s다", (gap, tier) => {
    expect(growthOutlookOf(60, 60 + gap).tier).toBe(tier);
  });
  it.each([
    [40, 60, 4],
    [64, 84, 4],
    [65, 85, 5],
    [66, 85, 4],
    [70, 90, 5],
    [71, 90, 4],
    [90, 95, 1],
  ])(
    "탁월함은 여지 20과 리그 최정상 천장을 함께 요구한다 — 종합 %s · 천장 %s",
    (overall, ceiling, tier) => {
      expect(growthOutlookOf(overall, ceiling).tier).toBe(tier);
    },
  );
  it("단계와 키와 낱말이 한 줄로 맞는다", () => {
    for (let gap = 0; gap <= 30; gap++) {
      const outlook = growthOutlookOf(65, 65 + gap);
      expect(outlook.key).toBe(GROWTH_OUTLOOKS[outlook.tier]);
    }
  });
});
