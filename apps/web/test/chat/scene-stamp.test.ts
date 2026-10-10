import { describe, expect, it } from "vitest";
import type { ChatTurn } from "@gaffer/engine";
import { cutStamps, sceneLines, sceneStamp, turnStamp } from "../../screens/chat/scene-stamp";

/**
 * 장면 시각의 눈금 — **때(오전·오후·저녁…)**, 날짜는 사람 표기(`7월 2일 목`).
 * 정확한 시각은 상단 띠가 갖는다. 채팅이 알려야 하는 건 장면이 언제로
 * 넘어갔나뿐이라 눈금은 굵을수록 좋다.
 */

const modelTurn = (text: string): ChatTurn => ({
  role: "model",
  text,
  toolCalls: [],
  at: "2026-07-02",
});

describe("sceneStamp", () => {
  const at = (time: string) => sceneStamp({ date: "2026-07-02", time });

  it("하루를 때로 접는다 — 정확한 시각은 상단 띠가 갖는다", () => {
    expect(at("05:40")).toBe("7월 2일 목 새벽");
    expect(at("08:10")).toBe("7월 2일 목 아침");
    expect(at("10:10")).toBe("7월 2일 목 오전");
    expect(at("14:30")).toBe("7월 2일 목 오후");
    expect(at("19:05")).toBe("7월 2일 목 저녁");
    expect(at("22:40")).toBe("7월 2일 목 밤");
  });

  it("같은 때의 장면들은 한 눈금으로 묶인다 — 스탬프가 매번 서지 않는다", () => {
    const bucket = ["13:05", "14:12", "16:59"].map((t) => at(t));
    expect(new Set(bucket).size).toBe(1);
    // 때가 넘어가면 그때 선다
    expect(at("18:00")).not.toBe(bucket[0]);
  });

  it("시간대를 붙인 12시간 표기도 읽는다 — 정오·자정의 12시까지", () => {
    expect(at("PM 12:05")).toBe("7월 2일 목 오후");
    expect(at("AM 12:40")).toBe("7월 2일 목 새벽");
    expect(at("오후 2:30")).toBe("7월 2일 목 오후");
  });

  /**
   * **장소는 시각 뒤에 온다** (prompts.md §1) — 데이트라인이 그 자리를 세우므로
   * 장면의 첫 문장이 같은 장소를 다시 말하지 않는다. 없으면 날짜와 때까지만 선다.
   */
  it("표식의 장소를 데이트라인에 세운다", () => {
    expect(sceneStamp({ date: "2026-07-18", time: "09:30", place: "에미레이츠" })).toBe(
      "7월 18일 토 오전 — 에미레이츠",
    );
    expect(sceneStamp({ date: "2026-07-18", time: "09:30" })).toBe("7월 18일 토 오전");
  });

  it("장소가 다르면 같은 때라도 장면이 갈린다 — 스탬프가 다시 선다", () => {
    expect(sceneStamp({ date: "2026-07-18", time: "09:30", place: "훈련장" })).not.toBe(
      sceneStamp({ date: "2026-07-18", time: "11:00", place: "감독실" }),
    );
  });

  it("경기의 분 표식은 분 그대로다", () => {
    expect(sceneStamp({ minute: 43 })).toBe("43'");
  });
});

describe("sceneLines", () => {
  it("커맨드 하나의 줄마다 한 줄이다 — 저장된 본문의 줄 수와 같다", () => {
    const text = [
      '<scene date="2026-07-15" time="09:15" />',
      '<speak name="짐 랫클리프">합의됐습니다.',
      "*서류를 내민다* 서명만 남았습니다.</speak>",
      "<narration>문이 닫힌다</narration>",
    ].join("\n");
    expect(sceneLines(text)).toEqual([
      { kind: "stamp", stamp: "7월 15일 수 오전" },
      { kind: "say", speaker: "짐 랫클리프", block: 1, text: "합의됐습니다." },
      { kind: "say", speaker: "짐 랫클리프", block: 1, text: "*서류를 내민다* 서명만 남았습니다." },
      { kind: "say", speaker: "", block: 2, text: "문이 닫힌다" },
    ]);
  });

  it("중계는 중계 화자로 선다", () => {
    expect(sceneLines("<commentary>23′ 골입니다!</commentary>")).toEqual([
      { kind: "say", speaker: "중계", block: 0, text: "23′ 골입니다!" },
    ]);
  });

  it("스트리밍 중 닫히지 않은 발화는 온 만큼 서고, 끝에 걸린 미완성 태그는 보류된다", () => {
    expect(sceneLines('<speak name="코치">안녕하')).toEqual([
      { kind: "say", speaker: "코치", block: 0, text: "안녕하" },
    ]);
    expect(sceneLines('<speak name="코치">안녕하세요.</speak>\n<spe')).toEqual([
      { kind: "say", speaker: "코치", block: 0, text: "안녕하세요." },
    ]);
  });
});

describe("cutStamps", () => {
  it("본문 한복판의 표식도 걷어낸다 — 대사 사이에 날것으로 남지 않는다", () => {
    const cut = cutStamps(
      sceneLines(
        '<narration>판정을 먼저 하겠습니다.</narration>\n<scene date="2026-07-15" time="09:15" />\n<speak name="짐 랫클리프">합의됐습니다.</speak>',
      ),
    );
    expect(cut.lines.map((l) => l.text)).toEqual(["판정을 먼저 하겠습니다.", "합의됐습니다."]);
    expect(cut.stamps).toEqual([{ after: 1, stamp: "7월 15일 수 오전" }]);
    expect(cut.cuts).toEqual([1]);
  });

  it("한 턴이 장면을 여럿 열면 시각도 여럿 선다", () => {
    const cut = cutStamps(
      sceneLines(
        '<scene date="2026-07-15" time="09:05" />\n<speak name="코치">네.</speak>\n<scene date="2026-07-15" time="15:00" />\n<speak name="코치">끝났습니다.</speak>',
      ),
    );
    expect(cut.stamps.map((s) => s.stamp)).toEqual(["7월 15일 수 오전", "7월 15일 수 오후"]);
    expect(cut.stamps.map((s) => s.after)).toEqual([0, 1]);
  });
});

describe("자료 카드 줄", () => {
  it("카드는 말 줄이 아니라 걷혀 자리와 순번으로 선다 — 순번이 저장된 값의 자리다", () => {
    const cut = cutStamps(
      sceneLines(
        [
          '<scene date="2026-07-15" time="09:05" />',
          '<speak name="코치">후보 셋입니다.</speak>',
          '<player_card players="애덤 워튼, 카를로스 발레바" />',
          '<speak name="코치">협상은 이렇습니다.</speak>',
          '<negotiation_card player="애덤 워튼" />',
        ].join("\n"),
      ),
    );
    expect(cut.lines.map((l) => l.text)).toEqual(["후보 셋입니다.", "협상은 이렇습니다."]);
    expect(cut.exhibits).toEqual([
      { after: 1, tag: "player_card", index: 0 },
      { after: 2, tag: "negotiation_card", index: 1 },
    ]);
    expect(cut.cuts).toEqual([0, 2, 4]);
  });
});

describe("turnStamp", () => {
  it("여는 표식을 때로 읽는다", () => {
    expect(
      turnStamp(
        modelTurn(
          '<scene date="2026-07-02" time="10:10" />\n<speak name="코치">안녕하세요.</speak>',
        ),
      ),
    ).toBe("7월 2일 목 오전");
  });

  it("장면이 여럿이면 마지막 시각이 다음 턴의 기준이다", () => {
    expect(
      turnStamp(
        modelTurn(
          '<scene date="2026-07-02" time="10:10" />\n<speak name="코치">네.</speak>\n<scene date="2026-07-02" time="20:00" />\n<speak name="코치">끝.</speak>',
        ),
      ),
    ).toBe("7월 2일 목 저녁");
  });

  it("표식이 없으면 null", () => {
    expect(turnStamp(modelTurn('<speak name="코치">안녕하세요.</speak>'))).toBeNull();
  });

  it("감독의 말에는 시각이 없다", () => {
    expect(
      turnStamp({
        role: "user",
        text: '<scene date="2026-07-02" time="10:10" />',
        toolCalls: [],
        at: "x",
      }),
    ).toBeNull();
  });
});
