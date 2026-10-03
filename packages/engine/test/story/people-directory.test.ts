import { describe, expect, it } from "vitest";
import type { CharacterBookEntry } from "@story-fm/domain";
import {
  completeCharacterUpdate,
  requestCharacterUpdate,
  selectCharacterBook,
} from "../../src/common/people/character-book";

const card = (id = "player:one", name = "김선수"): CharacterBookEntry => ({
  id,
  name,
  kind: "player",
  keywords: ["김 선수", "왼발 장인"],
  description: "왼발을 쓰는 선수",
  information: "주장 교체를 둘러싼 대화를 기억한다.",
  version: 1,
});
const stateOf = () => ({
  characterBook: [card()],
  characterBookRevisions: [] as import("@story-fm/domain").CharacterBookRevision[],
  characterBookJobs: [] as import("@story-fm/domain").CharacterBookJob[],
  characterBookJobSequence: 0,
});

describe("캐릭터북 주입과 편집", () => {
  it("이름·키워드를 정규화해 찾고 눈에 보이는 동일 버전은 중복하지 않는다", () => {
    const entry = card();
    expect(selectCharacterBook([entry], "왼발 장인과 이야기하자", [])).toEqual([entry]);
    expect(selectCharacterBook([entry], "김선수", [entry])).toEqual([]);
    expect(selectCharacterBook([entry], "관련 없는 이야기", [])).toEqual([]);
    expect(selectCharacterBook([entry], "김선수", [])).toEqual([entry]);
    expect(selectCharacterBook([{ ...entry, version: 2 }], "김선수", [entry])).toHaveLength(1);
  });
  it("편집은 접수만으로 적용되지 않고 기존 이름을 보존한다", () => {
    const state = stateOf();
    const before = structuredClone(state.characterBook[0]!);
    expect(
      requestCharacterUpdate(state, {
        characterId: before.id,
        additionalInformation: "감독과 화해했다",
      }).ok,
    ).toBe(true);
    expect(state.characterBook[0]).toEqual(before);
    const id = state.characterBookJobs[0]!.id;
    expect(
      completeCharacterUpdate(state, id, 1, {
        name: "다른 이름",
        keywords: ["킴"],
        description: "새 주장",
        information: "감독과 화해했다",
      }),
    ).toBe(true);
    expect(state.characterBook[0]).toMatchObject({
      name: "김선수",
      version: 2,
      information: "감독과 화해했다",
    });
    expect(state.characterBookJobs).toEqual([]);
    expect(state.characterBookRevisions).toEqual([
      { jobId: id, previous: before, additionalInformation: "감독과 화해했다" },
    ]);
    state.characterBook[0]!.keywords.push("변경");
    expect(state.characterBookRevisions[0]!.previous.keywords).toEqual(before.keywords);
    expect(before.information).toBe("주장 교체를 둘러싼 대화를 기억한다.");
  });
  it("지연 결과와 검증 실패는 현재 항목과 작업을 훼손하지 않는다", () => {
    const state = stateOf();
    requestCharacterUpdate(state, { characterId: "김선수", additionalInformation: "추가 정보" });
    const id = state.characterBookJobs[0]!.id;
    const result = { keywords: [], description: "소개", information: "기록" };
    expect(completeCharacterUpdate(state, id, 0, result)).toBe(false);
    expect(completeCharacterUpdate(state, id, 1, { ...result, information: "" })).toBe(false);
    expect(state.characterBook[0]!.version).toBe(1);
    expect(state.characterBookJobs).toHaveLength(1);
    expect(state.characterBookRevisions).toEqual([]);
    expect(completeCharacterUpdate(state, id, 1, result)).toBe(true);
    expect(completeCharacterUpdate(state, id, 2, result)).toBe(false);
  });
  it("완료 뒤 같은 턴에서 접수해도 작업 id를 재사용하지 않는다", () => {
    const state = stateOf();
    requestCharacterUpdate(state, { characterId: "김선수", additionalInformation: "첫 기록" });
    const first = state.characterBookJobs[0]!.id;
    completeCharacterUpdate(state, first, 1, {
      keywords: [],
      description: "소개",
      information: "기록",
    });
    requestCharacterUpdate(state, { characterId: "김선수", additionalInformation: "두번째 기록" });
    expect(state.characterBookJobs[0]!.id).not.toBe(first);
  });
  it("새 인물의 자유 기록을 만들고 동명이인은 id를 요구한다", () => {
    const state = stateOf();
    expect(
      requestCharacterUpdate(state, {
        characterId: "새 기자",
        additionalInformation: "첫 취재",
        newCharacter: {
          name: "새 기자",
          keywords: [],
          description: "취재 기자",
          information: "클럽을 취재한다",
        },
      }).ok,
    ).toBe(true);
    expect(state.characterBook.at(-1)).toMatchObject({
      name: "새 기자",
      kind: "person",
      version: 1,
    });
    state.characterBook.push(card("person:other", "김선수"));
    const queued = state.characterBookJobs.length;
    expect(
      requestCharacterUpdate(state, { characterId: "김선수", additionalInformation: "기록" }).ok,
    ).toBe(false);
    expect(state.characterBookJobs).toHaveLength(queued);
    expect(
      requestCharacterUpdate(state, { characterId: "player:one", additionalInformation: "기록" })
        .ok,
    ).toBe(true);
  });
});
