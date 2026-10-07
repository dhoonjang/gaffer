import { describe, expect, it } from "vitest";
import type { LorebookEntry, LorebookJob, LorebookRevision } from "@gaffer/domain";
import {
  completeCharacterUpdate,
  requestCharacterUpdate,
  selectLorebook,
  LOREBOOK_CARDS_PER_TURN,
} from "../../src/people/lorebook";

const card = (id = "player:one", name = "김선수"): LorebookEntry => ({
  id,
  name,
  kind: "player",
  keywords: ["김 선수", "왼발 장인"],
  description: "왼발을 쓰는 선수",
  information: "주장 교체를 둘러싼 대화를 기억한다.",
  version: 1,
});
const stateOf = () => ({
  lorebook: [card()],
  lorebookRevisions: [] as LorebookRevision[],
  lorebookJobs: [] as LorebookJob[],
  lorebookJobSequence: 0,
});

describe("로어북 주입과 편집", () => {
  it("이름·키워드를 정규화해 찾고 눈에 보이는 동일 버전은 중복하지 않는다", () => {
    const entry = card();
    expect(selectLorebook([entry], "왼발 장인과 이야기하자", [])).toEqual([entry]);
    expect(selectLorebook([entry], "김선수", [{ ...entry, now: "" }])).toEqual([]);
    expect(selectLorebook([entry], "관련 없는 이야기", [])).toEqual([]);
    expect(selectLorebook([entry], "김선수", [])).toEqual([entry]);
    expect(
      selectLorebook([{ ...entry, version: 2 }], "김선수", [{ ...entry, now: "" }]),
    ).toHaveLength(1);
  });
  it("한 턴에 상한까지만 싣고, 감독의 말이 장면보다·이름이 키워드보다 앞선다", () => {
    const named = Array.from({ length: LOREBOOK_CARDS_PER_TURN + 2 }, (_, i) =>
      card(`player:${i}`, `선수${i}`),
    );
    const said = named.map((entry) => entry.name).join(" ");
    expect(selectLorebook(named, said, [])).toHaveLength(LOREBOOK_CARDS_PER_TURN);
    // 감독이 늦게 부른 이름도 장면에서만 불린 이름보다 앞선다
    const picked = selectLorebook(named, "선수6", [], "선수0 선수1 선수2 선수3 선수4 선수5");
    expect(picked.map((entry) => entry.id)).toEqual([
      "player:6",
      "player:0",
      "player:1",
      "player:2",
      "player:3",
    ]);
    // 장면에서 이름이 불린 쪽이 감독의 말에서 키워드만 맞은 쪽보다 앞선다 (3 > 1×2)
    const keywordOnly = { ...card("player:k", "박선수"), keywords: ["오른발"] };
    expect(
      selectLorebook([keywordOnly, named[0]!], "오른발", [], "선수0").map((entry) => entry.id),
    ).toEqual(["player:0", "player:k"]);
  });
  it("성만으로는 아는 사람만 걸리고, 낱말 머리에서만 맞는다", () => {
    const ours = { ...card("player:ours", "리산드로 마르티네스"), keywords: ["마르티네스"] };
    const theirs = { ...card("player:theirs", "에밀리아노 마르티네스"), keywords: ["마르티네스"] };
    const familiar = new Set([ours.id]);
    const ids = (said: string) =>
      selectLorebook([ours, theirs], said, [], "", familiar).map((entry) => entry.id);
    expect(ids("마르티네스는 어때?")).toEqual(["player:ours"]);
    // 전체 이름으로 부르면 남의 선수도 걸린다
    expect(ids("에밀리아노 마르티네스 소식")).toEqual(["player:theirs", "player:ours"]);
    // 낱말 한가운데는 부른 것이 아니다
    expect(selectLorebook([ours], "로드리게스마르티네스", [], "", familiar)).toEqual([]);
  });
  it("편집은 접수만으로 적용되지 않고 기존 이름을 보존한다", () => {
    const state = stateOf();
    const before = structuredClone(state.lorebook[0]!);
    expect(
      requestCharacterUpdate(state, {
        characterId: before.id,
        additionalInformation: "감독과 화해했다",
      }).ok,
    ).toBe(true);
    expect(state.lorebook[0]).toEqual(before);
    const id = state.lorebookJobs[0]!.id;
    expect(
      completeCharacterUpdate(state, id, 1, {
        name: "다른 이름",
        keywords: ["킴"],
        description: "새 주장",
        information: "감독과 화해했다",
      }),
    ).toBe(true);
    expect(state.lorebook[0]).toMatchObject({
      name: "김선수",
      version: 2,
      information: "감독과 화해했다",
    });
    expect(state.lorebookJobs).toEqual([]);
    expect(state.lorebookRevisions).toEqual([
      { jobId: id, previous: before, additionalInformation: "감독과 화해했다" },
    ]);
    state.lorebook[0]!.keywords.push("변경");
    expect(state.lorebookRevisions[0]!.previous.keywords).toEqual(before.keywords);
    expect(before.information).toBe("주장 교체를 둘러싼 대화를 기억한다.");
  });
  it("지연 결과와 검증 실패는 현재 항목과 작업을 훼손하지 않는다", () => {
    const state = stateOf();
    requestCharacterUpdate(state, { characterId: "김선수", additionalInformation: "추가 정보" });
    const id = state.lorebookJobs[0]!.id;
    const result = { keywords: [], description: "소개", information: "기록" };
    expect(completeCharacterUpdate(state, id, 0, result)).toBe(false);
    expect(completeCharacterUpdate(state, id, 1, { ...result, information: "" })).toBe(false);
    expect(state.lorebook[0]!.version).toBe(1);
    expect(state.lorebookJobs).toHaveLength(1);
    expect(state.lorebookRevisions).toEqual([]);
    expect(completeCharacterUpdate(state, id, 1, result)).toBe(true);
    expect(completeCharacterUpdate(state, id, 2, result)).toBe(false);
  });
  it("완료 뒤 같은 턴에서 접수해도 작업 id를 재사용하지 않는다", () => {
    const state = stateOf();
    requestCharacterUpdate(state, { characterId: "김선수", additionalInformation: "첫 기록" });
    const first = state.lorebookJobs[0]!.id;
    completeCharacterUpdate(state, first, 1, {
      keywords: [],
      description: "소개",
      information: "기록",
    });
    requestCharacterUpdate(state, { characterId: "김선수", additionalInformation: "두번째 기록" });
    expect(state.lorebookJobs[0]!.id).not.toBe(first);
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
    expect(state.lorebook.at(-1)).toMatchObject({
      name: "새 기자",
      kind: "person",
      version: 1,
    });
    state.lorebook.push(card("person:other", "김선수"));
    const queued = state.lorebookJobs.length;
    expect(
      requestCharacterUpdate(state, { characterId: "김선수", additionalInformation: "기록" }).ok,
    ).toBe(false);
    expect(state.lorebookJobs).toHaveLength(queued);
    expect(
      requestCharacterUpdate(state, { characterId: "player:one", additionalInformation: "기록" })
        .ok,
    ).toBe(true);
  });
});
