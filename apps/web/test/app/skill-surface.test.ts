import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, SKILL_CATALOG } from "@story-fm/agents";
import { hasRailHint } from "../../domains/common/lib/panel-hints";
import { CALL_LABEL } from "../../domains/common/lib/call-label";

/**
 * **호출 결과가 화면에 서는 길은 칩 + 말풍선 하나다** (overview.md §3) — 갈 장부가 있는
 * 호출은 그 턴에 바뀐 장부들이 탭 순서대로 한 장씩 알림으로 서고, 채팅에 남은 칩을
 * 누르면 그 말풍선이 다시 선다.
 *
 * 그 밖의 호출은 **아예 노출하지 않는다** — 조회 도구는 호출을 기록조차 하지 않고
 * (`read`), 코어가 한 일은 `silent`로 걸러진다. 이 테스트는 그 밖으로 새는 호출
 * (= 칩 속 줄글로만 남는 스킬)을 잡는다.
 */
describe("호출이 화면에 서는 길", () => {
  it("조작형 호출은 모두 말풍선을 갖는다", () => {
    const orphans = SKILL_CATALOG.filter((s) => !s.readOnly && !hasRailHint(s.name)).map(
      (s) => s.name,
    );
    expect(orphans, "말풍선(PANEL_OF)으로 보내야 한다").toEqual([]);
  });

  it("조회 도구는 말풍선이 없다 — 조회 로그는 화면에 서지 않는다", () => {
    for (const skill of SKILL_CATALOG.filter((s) => s.readOnly)) {
      expect(hasRailHint(skill.name), skill.name).toBe(false);
    }
  });
});

/**
 * 표시 이름은 웹이 갖는다(카탈로그를 직접 import하면 `node:path`가 딸려 와
 * 클라이언트 번들이 깨진다). 대신 **어긋나지 않는지는 여기서 지킨다.**
 */
describe("호출 표시 이름", () => {
  it("카탈로그와 같은 이름을 쓴다", () => {
    for (const skill of SKILL_CATALOG) {
      expect(CALL_LABEL[skill.name], skill.name).toBe(skill.label);
    }
  });

  /**
   * **칩으로 서는 이름은 카탈로그의 것만이 아니다.** 코어 명령은 GM에게 보이지 않지만
   * 해석기가 부르면 기록이 남아 칩이 된다. 칩은
   * `CALL_LABEL[이름] ?? 이름`으로 읽으므로 표에서 빠진 이름은 **감독의 채팅에 영문
   * 식별자로 뜬다** — 화면도 테스트도 아무 말을 하지 않던 자리라 여기서 막는다.
   */
  it("코어 명령도 빠짐없이 이름을 갖는다", () => {
    expect([...CORE_COMMANDS].filter((name) => CALL_LABEL[name] === undefined)).toEqual([]);
  });
});
