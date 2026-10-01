import { describe, expect, it } from "vitest";
import { punditForRound, worldFigures } from "@story-fm/engine";
import { createTestGame } from "../helpers";

describe("언론 — 회견 밖의 기사 (people.md §4-1)", () => {
  it("화자는 명부의 해설이고, 같은 라운드는 같은 사람이다", () => {
    const state = createTestGame();
    const first = punditForRound(state, state.season, 3);
    expect(first, "명부에 해설이 있는데 아무도 서지 않았다").not.toBeNull();
    // 코어는 화자를 지어내지 않는다 — 그 이름이 명부에 있어야 인물지가 실린다
    expect(first!.role).toBe("pundit");
    expect(worldFigures(state).some((f) => f.characterId === first!.characterId)).toBe(true);
    expect(punditForRound(state, state.season, 3)?.characterId).toBe(first!.characterId);
  });
});
