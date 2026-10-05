import {
  personaKeywords,
  PersonaSchema,
  ATTRIBUTE_AXES,
  LorebookContentSchema,
  HEAD_COACH_ROLE_LABEL,
  STAFF_ROLES,
  normalizeSpeaker,
  type GamePlayer,
} from "@story-fm/domain";
import { hireStaff, releaseStaff, staffPoolOf } from "../../src/people/staff-employment";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePersonaBooks } from "../../src/people/catalog/persona-override";
import { describe, expect, it, vi } from "vitest";
import {
  HEAD_COACH_NAMES,
  generateHeadCoach,
  headCoachOf,
  speakerRoles,
  ownerOf,
  generateOwner,
  reportersOf,
  generateReporters,
  teamCatalog,
  personaBookOf,
  selectLorebook,
  requestCharacterUpdate,
  completeCharacterUpdate,
  syncLorebook,
  staffViews,
  worldFigures,
} from "@story-fm/engine";
import {
  factSpeakerOf,
  generateStaff,
  generateVirtualManager,
  headCoachSalaryOf,
  staffSalaryOf,
  STAFF_OPENINGS,
} from "../../src/people/persona";
import { ensureSeededManagers } from "../../src/app/create-game";
import { worldFigureManagerOf } from "../../src/people/catalog/world-figures";
import { generatePlayerPersona } from "../../src/players/catalog/player-persona";
import { createTestGame } from "../helpers";

/**
 * 인물은 **순수 함수가 시드에서 만든다** (`generateHeadCoach` 등). 세계를 세워야
 * 하는 것은 `state.personas`를 읽는 자리(`headCoachOf`·`speakerRoles`)뿐이고, 그것도 픽스처 보관을 타는 `createTestGame`으로 충분하다 — 예전엔 이 파일이
 * `createGame`을 열다섯 번 직접 불러 매번 세계를 새로 세웠다.
 */

describe("수석코치 페르소나 — 데이터로 다루는 인물 (people.md §1)", () => {
  it("새 게임에 수석코치가 함께 온다", () => {
    const state = createTestGame();
    const coach = headCoachOf(state);
    expect(() => PersonaSchema.parse(coach)).not.toThrow();
    expect(coach.role).toBe("head_coach");
    // 화자 태그는 직책이 아니라 그 사람의 이름이다
    expect(coach.characterId).toBe(coach.name);
    expect(coach.characterId).not.toBe(HEAD_COACH_ROLE_LABEL);
    // 말투는 지문만으로 붙지 않는다 — 예시 대사가 함께 있어야 한다 (§6)
    expect(coach.lorebook.information.length).toBeGreaterThan(0);
  });

  it("세이브가 담은 사람은 시드가 만든 그 사람이다 (결정적)", () => {
    // 세계가 담아 둔 인물과 순수 함수가 만드는 인물이 같아야 로드가 시드로 복원된다.
    // 고용 정보는 부임일이 있어야 서므로 세계의 시작일을 함께 넘긴다 (people.md §2-2)
    const state = createTestGame(42);
    expect(headCoachOf(state)).toEqual(
      generateHeadCoach(42, "arsenal", state.calendar.preseasonStart),
    );
    expect(generateHeadCoach(42, "arsenal")).toEqual(generateHeadCoach(42, "arsenal"));
  });

  it("실제 수석코치를 아는 구단은 그 사람이 나온다 — 시드가 달라도 이름은 그대로", () => {
    for (const teamId of Object.keys(HEAD_COACH_NAMES)) {
      const expected = HEAD_COACH_NAMES[teamId]!;
      // 이름은 구단이 정하고, 사람됨(원형)만 시드가 정한다
      for (const seed of [1, 42, 777]) {
        const coach = generateHeadCoach(seed, teamId);
        expect(coach.name, teamId).toBe(expected);
        expect(coach.real, teamId).toBe(true);
      }
      // 성격은 여전히 시드로 갈린다 (같은 이름이라도 세이브마다 다른 사람됨)
      const archetypes = new Set(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(
          (s) => generateHeadCoach(s, teamId).lorebook.information,
        ),
      );
      expect(archetypes.size, teamId).toBeGreaterThan(1);
    }
  });

  it("실명을 모르는 구단은 리그 국적에 맞는 가상 이름을 쓴다", () => {
    // 실명 표에 없는 팀 — 실존 인물 표식이 붙지 않는다
    const coach = generateHeadCoach(42, "dortmund");
    expect(HEAD_COACH_NAMES).not.toHaveProperty("dortmund");
    expect(coach.real).toBeUndefined();

    // 나라가 다르면 이름의 결도 다르다 (아스날에 "안드레 페레스"가 나오지 않는다)
    // 실명이 없는 팀만 — 실명 팀은 표의 이름을 그대로 쓰므로 국적 풀과 무관하다
    const byCountry = ["dortmund", "sevilla", "lecce", "nice"].map(
      (t) => generateHeadCoach(42, t).name,
    );
    expect(new Set(byCountry).size).toBe(byCountry.length);
  });

  it("다른 세이브·다른 구단이면 다른 사람을 만난다", () => {
    // 실명을 모르는 팀은 이름까지 세이브마다 갈린다
    const names = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seed) => generateHeadCoach(seed, "dortmund").name),
    );
    expect(names.size).toBeGreaterThan(1);
    // 부임한 곳이 다르면 만나는 사람도 다르다 (같은 시드라도)
    expect(generateHeadCoach(42, "arsenal")).not.toEqual(generateHeadCoach(42, "chelsea"));
  });

  it("화면이 붙일 직책 맵을 준다 — 모델 출력에 기대지 않는다", () => {
    const state = createTestGame(42, "manutd");
    const roles = speakerRoles(state);
    // 키는 정규화된 이름 — 사전을 만들 때와 찾을 때가 같은 함수를 쓴다
    expect(roles[normalizeSpeaker(headCoachOf(state).name)]).toEqual({
      kind: "head_coach",
      label: HEAD_COACH_ROLE_LABEL,
    });
    // 모델이 공백을 다르게 써도 같은 자리를 찾는다
    expect(roles[normalizeSpeaker(headCoachOf(state).name.replaceAll(" ", ""))]?.label).toBe(
      HEAD_COACH_ROLE_LABEL,
    );
  });

  it("자리를 아는 화자는 다 알려 준다 — 주장도", () => {
    const state = createTestGame(42, "manutd");
    const captain = state.players.find((p) => p.teamId === "manutd" && p.isCaptain)!;
    expect(speakerRoles(state)[normalizeSpeaker(captain.name)]).toEqual({
      kind: "captain",
      label: "주장",
    });
  });

  it("우리 선수는 직책 없이 자리만 갖는다 — 대화마다 (선수)는 시끄럽다", () => {
    const state = createTestGame(42, "manutd");
    const roles = speakerRoles(state);
    const squad = state.players.filter((p) => p.teamId === "manutd" && p.isCaptain !== true);
    const known = squad.filter((p) => roles[normalizeSpeaker(p.name)] !== undefined);
    // 동명이인으로 빠지는 몇을 빼면 선수단 대부분이 사전에 있다
    expect(known.length).toBeGreaterThan(squad.length - 3);
    for (const p of known) {
      expect(roles[normalizeSpeaker(p.name)]).toEqual({ kind: "player" });
    }
  });

  it("이름이 겹치면 아무것도 붙이지 않는다 — 틀린 직책보다 없는 게 낫다", () => {
    const state = createTestGame(42, "manutd");
    const coach = headCoachOf(state);
    // 코치와 같은 이름의 주장이 있는 상황을 만든다
    const captain = state.players.find((p) => p.teamId === "manutd" && p.isCaptain)!;
    captain.name = coach.name;
    expect(speakerRoles(state)[normalizeSpeaker(coach.name)]).toBeUndefined();
  });

  it("세계 인물 명부가 직책 라벨과 함께 선다 — 유저 팀의 명부 감독만 빠진다", () => {
    const roles = speakerRoles({ seed: 1, userTeamId: "manutd", personas: [] });
    expect(roles[normalizeSpeaker("펩 과르디올라")]).toEqual({ kind: "manager", label: "감독" });
    expect(roles[normalizeSpeaker("게리 네빌")]).toEqual({ kind: "pundit", label: "해설위원" });
    // 유저가 맡은 팀의 명부 감독은 이 세계에 부임한 적이 없다
    expect(
      speakerRoles({ seed: 1, userTeamId: "mancity", personas: [] })[
        normalizeSpeaker("펩 과르디올라")
      ],
    ).toBeUndefined();
  });

  it("이름난 현역이 사전에 든다 — 아이콘만, 이미 찬 자리는 넘보지 않는다", () => {
    const roles = speakerRoles({
      seed: 1,
      userTeamId: "manutd",
      personas: [],
      players: [
        { name: "우리 주장", teamId: "manutd", isCaptain: true },
        // 주장과 동명의 남의 팀 스타 — 뒤 겹은 완장을 밀어내지 못한다
        {
          name: "우리 주장",
          teamId: "chelsea",
          attributes: {
            ...Object.fromEntries(ATTRIBUTE_AXES.map((axis) => [axis, 90])),
            potential: 99,
          } as GamePlayer["attributes"],
          positions: [{ position: "ST", proficiency: 90, isNatural: true }],
        },
        {
          name: "남의 팀 스타",
          teamId: "chelsea",
          attributes: {
            ...Object.fromEntries(ATTRIBUTE_AXES.map((axis) => [axis, 82])),
            potential: 99,
          } as GamePlayer["attributes"],
          positions: [{ position: "ST", proficiency: 90, isNatural: true }],
        },
        {
          name: "무명 선수",
          teamId: "chelsea",
          attributes: {
            ...Object.fromEntries(ATTRIBUTE_AXES.map((axis) => [axis, 81])),
            potential: 99,
          } as GamePlayer["attributes"],
          positions: [{ position: "ST", proficiency: 90, isNatural: true }],
        },
        // 능력치가 답하지 못하는 레전드 — 시장 리그 시드 명단이 답한다
        {
          name: "리오넬 메시",
          teamId: "intermiami",
          attributes: {
            ...Object.fromEntries(ATTRIBUTE_AXES.map((axis) => [axis, 80])),
            potential: 99,
          } as GamePlayer["attributes"],
          positions: [{ position: "ST", proficiency: 90, isNatural: true }],
        },
      ],
    });
    expect(roles[normalizeSpeaker("남의 팀 스타")]).toEqual({ kind: "player" });
    expect(roles[normalizeSpeaker("리오넬 메시")]).toEqual({ kind: "player" });
    expect(roles[normalizeSpeaker("무명 선수")]).toBeUndefined();
    expect(roles[normalizeSpeaker("우리 주장")]).toEqual({ kind: "captain", label: "주장" });
  });

  it("구단주도 데이터다 — 만날 때마다 같은 사람, 코치와 다른 사람", () => {
    const state = createTestGame(7, "manutd");
    const owner = ownerOf(state);
    expect(owner.role).toBe("owner");
    // 실명을 아는 구단이면 그 사람이 나온다 (owner-seeds)
    expect(owner.name).toBe("짐 랫클리프");
    expect(owner.real).toBe(true);
    // 같은 세이브는 언제 열어도 같은 사람
    expect(generateOwner(7, "manutd")).toEqual(owner);
    // 코치와 원형이 같은 통에서 나오면 두 사람이 겹친다 — 시드 채널이 다르다
    expect(owner.lorebook.information).not.toBe(headCoachOf(state).lorebook.information);
  });

  it("구단주를 모르는 구단은 실명을 쓰지 않는다", () => {
    // 시드 표에 없는 팀 — 리그 국적에 맞는 가상 이름이 선다
    const owner = generateOwner(7, "brentford");
    expect(owner.real).toBeUndefined();
    expect(owner.name).not.toBe("");
  });

  it("화자 사전이 구단주의 자리를 안다 — 화면이 아이콘·직책을 붙일 재료", () => {
    const state = createTestGame(7, "manutd");
    const roles = speakerRoles(state);
    expect(roles[normalizeSpeaker("짐 랫클리프")]).toEqual({
      kind: "owner",
      label: "구단주",
    });
  });
});

/**
 * 스태프 — **구단이 고용한 사람들** (people.md §2-2). 여기서 재는 것은 생성이
 * 결정적인가와 고용 정보가 사실을 제대로 드는가다. 화면에 바로 드러나는 것(직책 칩·
 * 스태프 줄)은 깨지는 순간 보이므로 케이스를 두지 않는다 (AGENTS.md §5).
 */
describe("스태프 — 고용 정보를 든 인물 (people.md §2-2)", () => {
  const START = "2026-07-01";

  it("시작 인원은 코치 둘 · 의료진 하나 · 스카우트 하나다", () => {
    const staff = generateStaff(42, "arsenal", START);
    for (const role of STAFF_ROLES) {
      expect(
        staff.filter((p) => p.role === role),
        role,
      ).toHaveLength(STAFF_OPENINGS[role]);
    }
    // 스키마를 통과해야 세이브에 들어간다 — 고용 정보가 붙은 페르소나도 같은 문이다
    for (const persona of staff) expect(PersonaSchema.safeParse(persona).success).toBe(true);
  });

  it("같은 시드·같은 구단은 같은 사람이고, 구단이 다르면 다른 사람이다", () => {
    expect(generateStaff(42, "arsenal", START)).toEqual(generateStaff(42, "arsenal", START));
    expect(generateStaff(42, "arsenal", START).map((p) => p.name)).not.toEqual(
      generateStaff(42, "chelsea", START).map((p) => p.name),
    );
  });

  it("한 역할 안에서 원형이 겹치지 않는다 — 피지컬 코치 둘은 구분할 수 없다", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const coaches = generateStaff(seed, "arsenal", START).filter((p) => p.role === "coach");
      const titles = coaches.map((p) => p.employment!.title);
      expect(new Set(titles).size, `시드 ${seed}`).toBe(titles.length);
    }
  });

  it("이름은 수석코치·구단주·기자와 겹치지 않는다 — 태그는 전역 유일이다", () => {
    const state = createTestGame(42);
    const names = (state.personas ?? []).map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("부임일은 감독보다 앞서고 계약은 6월 30일에 끝난다", () => {
    for (const persona of generateStaff(42, "arsenal", START)) {
      const employment = persona.employment!;
      expect(employment.since < START).toBe(true);
      expect(employment.contract.until.slice(5)).toBe("06-30");
      expect(employment.contract.until > START).toBe(true);
      expect(employment.teamId).toBe("arsenal");
    }
  });

  it("연봉은 구단의 살림을 탄다 — 큰 구단의 코치가 작은 구단의 코치보다 받는다", () => {
    // 리그 축(2부)과 등급 축(같은 리그 안)이 둘 다 걸린다 (people.md §2-2)
    expect(staffSalaryOf("arsenal", "coach")).toBeGreaterThan(staffSalaryOf("leeds", "coach"));
    // 자리마다 값이 다르고, 수석코치는 코치의 두 배다
    expect(staffSalaryOf("arsenal", "coach")).toBeGreaterThan(staffSalaryOf("arsenal", "scout"));
    expect(headCoachSalaryOf("arsenal")).toBe(staffSalaryOf("arsenal", "coach") * 2);
  });

  it("수석코치도 고용 정보를 든다 — 새 게임의 계약은 구단 살림의 연봉이다", () => {
    const state = createTestGame(42);
    expect(headCoachOf(state).employment?.title).toBe(HEAD_COACH_ROLE_LABEL);
    expect(headCoachOf(state).employment?.contract.salary).toBe(
      headCoachSalaryOf(state.userTeamId),
    );
  });

  it("화자 표 — 갈래마다 그 역할의 사람이 서고, 자리가 비면 수석코치가 선다", () => {
    const state = createTestGame(42);
    expect(factSpeakerOf(state, "medical").role).toBe("medic");
    expect(factSpeakerOf(state, "training").role).toBe("coach");
    expect(factSpeakerOf(state, "coach_eye").role).toBe("head_coach");
    // 의료진을 자른 세이브 — 부상 줄은 여전히 서야 하므로 수석코치가 대신 선다
    state.personas = (state.personas ?? []).filter((p) => p.role !== "medic");
    expect(factSpeakerOf(state, "medical").role).toBe("head_coach");
  });
});

/**
 * 기자단 — 회견은 **세계가 먼저 부르는 자리**라, 부를 사람이 세이브에 있어야 한다.
 * 없으면 GM이 즉흥으로 지어내 매번 다른 기자가 묻는다.
 */
describe("기자 페르소나", () => {
  it("새 게임에 셋이 함께 만들어진다 — 결이 서로 다르다", () => {
    const state = createTestGame(5);
    const reporters = reportersOf(state);
    expect(reporters).toHaveLength(3);
    // 소속이 다르면 무엇을 먼저 묻는지가 갈린다
    expect(new Set(reporters.map((r) => r.outlet)).size).toBe(3);
    for (const r of reporters) {
      expect(r.characterId).toBe(r.name); // 태그는 직책이 아니라 이름이다
      expect(r.lorebook.information.length).toBeGreaterThan(0);
    }
  });

  it("같은 시드는 같은 기자를 만난다", () => {
    expect(reportersOf(createTestGame(9)).map((r) => r.name)).toEqual(
      reportersOf(createTestGame(9)).map((r) => r.name),
    );
    expect(reportersOf(createTestGame(9))[0]?.name).not.toBe(
      reportersOf(createTestGame(10))[0]?.name,
    );
  });

  it("리그가 다르면 그 리그 국가의 이름을 쓴다", () => {
    const epl = generateReporters(42, "arsenal").map((r) => r.name);
    const laliga = generateReporters(42, "realmadrid").map((r) => r.name);
    expect(laliga).not.toEqual(epl);
    // 같은 리그의 다른 구단은 같은 사람 — 기준이 팀이 아니라 리그다
    expect(generateReporters(42, "sevilla").map((r) => r.name)).toEqual(laliga);
    // 2부도 같은 협회 아래다 — 세리에 B 클럽이면 이탈리아 이름 풀
    expect(generateReporters(42, "sampdoria").map((r) => r.name)).toEqual(
      generateReporters(42, "milan").map((r) => r.name),
    );
    // 이름 풀이 없는 리그(사우디)는 기본 풀로 떨어진다
    expect(generateReporters(42, "alhilal").map((r) => r.name)).toEqual(epl);
  });

  it("화면에는 직책 대신 매체가 붙는다 — 아이콘이 '기자'를 이미 말한다", () => {
    const state = createTestGame(5);
    const roles = speakerRoles(state);
    for (const r of reportersOf(state)) {
      const seat = roles[normalizeSpeaker(r.name)];
      expect(seat?.kind).toBe("reporter");
      expect(seat?.label).toBe(r.outlet);
    }
  });
});

/**
 * 다섯이 같은 풀에서 독립 추첨하던 자리다 — 겹치면 `speakerRoles`가 둘 다
 * 포기해 **직책과 아이콘이 함께 사라진다** (people.md §1 · §2).
 */
describe("인물 이름의 유일성", () => {
  it("한 세이브의 다섯(수석코치·구단주·기자 3인)은 이름이 서로 겹치지 않는다", () => {
    const clashing: string[] = [];
    for (const seed of [1, 7, 42, 99, 2026]) {
      for (const team of teamCatalog()) {
        const names = [
          generateHeadCoach(seed, team.id).characterId,
          generateOwner(seed, team.id).characterId,
          ...generateReporters(seed, team.id).map((r) => r.characterId),
        ].map(normalizeSpeaker);
        if (new Set(names).size !== names.length) clashing.push(`${seed}:${team.id}`);
      }
    }
    expect(clashing).toEqual([]);
  });

  it("화자 사전이 인물 전원의 자리를 안다 — 이름이 겹쳐 생략되는 자리가 없다", () => {
    for (const seed of [3, 11]) {
      const state = createTestGame(seed);
      const roles = speakerRoles(state);
      for (const persona of state.personas ?? []) {
        expect(roles[normalizeSpeaker(persona.characterId)]?.kind, persona.name).toBe(persona.role);
      }
    }
  });
});

/**
 * 선수 페르소나 — **저장하지 않고 (시드, 선수 id)에서 파생한다** (people.md §6).
 *
 * 값어치가 있는 것은 **결정성**이다: 같은 세이브는 언제 열어도 같은 사람을 만나고,
 * 시즌이 흘러 나이가 바뀌어도 사람됨은 그대로다. 원형 라벨의 문구는 테스트하지 않는다.
 */
describe("선수 페르소나 — 파생되는 카드", () => {
  // 세계는 세우지 않는다 — 원본 하나를 복제해 나이·포지션만 바꾼 순수 입력을 만든다
  const basePlayer = createTestGame().players[0]!;
  const playerLike = (id: string, position: string, birthdate: string): GamePlayer => ({
    ...basePlayer,
    id,
    name: `가상 ${id}`,
    birthdate,
    positions: [{ position, proficiency: 85, isNatural: true }],
  });
  const youngStriker = playerLike("p-young-st", "ST", "2007-04-11");
  const veteranCentreBack = playerLike("p-vet-cb", "CB", "1993-02-20");
  const samples = [
    youngStriker,
    veteranCentreBack,
    playerLike("p-prime-st", "ST", "1999-09-01"),
    playerLike("p-prime-gk", "GK", "1997-05-30"),
    playerLike("p-young-cm", "CM", "2006-01-15"),
    playerLike("p-vet-cf", "CF", "1992-11-03"),
  ];

  it("같은 (시드, 선수)는 언제나 같은 사람이다 — 세이브가 담지 않아도 복원된다", () => {
    expect(generatePlayerPersona(7, youngStriker)).toEqual(generatePlayerPersona(7, youngStriker));
    // 화자 태그는 직책이 아니라 이름이다 (코치와 같은 규약)
    expect(generatePlayerPersona(7, youngStriker).characterId).toBe(youngStriker.name);
    const persona = generatePlayerPersona(7, youngStriker);
    expect(PersonaSchema.parse(persona)).toEqual(persona);
    expect(Object.keys(persona.lorebook).sort()).toEqual([
      "description",
      "information",
      "keywords",
      "name",
    ]);
    for (const field of ["archetype", "traits", "motivation", "speechStyle", "keywords"])
      expect(persona).not.toHaveProperty(field);
    // 세이브가 다르면 다른 사람을 만난다
    const archetypes = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map(
        (seed) => generatePlayerPersona(seed, youngStriker).lorebook.information,
      ),
    );
    expect(archetypes.size).toBeGreaterThan(1);
    // 시드 채널은 이름이 아니라 **id**다 — 동명이인도, 이적한 선수도 같은 사람이다
    expect(
      generatePlayerPersona(7, { ...youngStriker, name: "다른 이름", teamId: "chelsea" }).lorebook
        .information,
    ).toBe(generatePlayerPersona(7, youngStriker).lorebook.information);
    // 선수가 다르면 각자의 추첨을 탄다
    const byPlayer = new Set(
      Array.from(
        { length: 12 },
        (_, i) => generatePlayerPersona(7, { ...youngStriker, id: `p-${i}` }).lorebook.information,
      ),
    );
    expect(byPlayer.size).toBeGreaterThan(1);
  });

  it("나이가 흘러도 같은 사람이다 — 기준일이 고정이라 시즌이 바뀌어도 흔들리지 않는다", () => {
    const before = samples.map((p) => generatePlayerPersona(7, p).lorebook.information);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2032-03-01T00:00:00Z"));
      expect(samples.map((p) => generatePlayerPersona(7, p).lorebook.information)).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * **경기 시뮬과 xG는 원형을 읽지 않는다** (people.md 요구사항 3).
   *
   * 런타임으로는 증명할 수 없는 부재다 — 원형이 선수 id의 파생이라 원형만 바꿔 같은
   * 경기를 두 번 돌릴 수 없다. 그래서 경계를 **읽는 자리가 없다**로 잰다: 이 폴더들이
   * 원형을 이름으로도 부르지 않으면 경기 결과는 사람됨을 모른다.
   */
  it("경기 코어는 원형을 이름으로도 부르지 않는다", () => {
    const roots = ["../../../sim/src", "../../src/match"];
    const banned = /archetype|ARCHETYPE|player-persona/u;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && banned.test(readFileSync(path, "utf8"))) {
          offenders.push(path);
        }
      }
    };
    for (const root of roots) walk(join(__dirname, root));
    expect(offenders).toEqual([]);
  });
});

describe("가상 감독 — 명부 밖 벤치의 사람 (people.md §2)", () => {
  it("같은 (시드, 이름)이면 같은 사람이다 — 저장하지 않아도 복원된다", () => {
    const manager = generateVirtualManager(42, "옌스 바그너");
    expect(manager).toEqual(generateVirtualManager(42, "옌스 바그너"));
    expect(() => PersonaSchema.parse(manager)).not.toThrow();
    expect(manager.role).toBe("manager");
    expect(manager.characterId).toBe("옌스 바그너");
    // 지어낸 이름이라 실존 표식이 없다 — 실명 부채 장부가 셀 것도 없다
    expect(manager.real).toBeUndefined();
    // 키워드는 명부 규칙 그대로 — 전체 이름과 성, 이름 조각은 담지 않는다
    expect(manager.lorebook.keywords).toEqual(["옌스 바그너", "바그너"]);
  });

  it("이름이 시드 채널의 전부다 — 경질로 이름이 갈리면 새 추첨이다", () => {
    const names = ["가브리엘 로시", "마르코 벨리", "루카 페라리", "엔조 콘티", "다비드 리치"];
    const labels = new Set(names.map((n) => generateVirtualManager(42, n).lorebook.information));
    // 이름이 다르면 독립 추첨 — 후임이 전임의 사람됨을 물려받지 않는다
    expect(labels.size).toBeGreaterThan(1);
  });

  it("사람됨은 벤치를 따라가지 않는다 — 팀을 옮겨도 같은 사람이다", () => {
    // 감독은 자리가 아니라 사람이다 (transfer.md §7 「감독 풀」) — 채널에 팀이 없다
    expect(generateVirtualManager(42, "옌스 바그너")).toEqual(
      generateVirtualManager(42, "옌스 바그너"),
    );
    expect(generateVirtualManager(42, "옌스 바그너").characterId).toBe("옌스 바그너");
  });

  it("모든 클럽 벤치에 감독이 선다 — 명부가 먼저, 이름은 겹치지 않고, 유저 팀만 빈다", () => {
    const state = createTestGame();
    // 유저 팀 벤치는 유저의 것
    expect(state.teams.find((t) => t.id === state.userTeamId)?.managerName).toBeUndefined();
    // 클럽(AI 감독 역량치를 받은 팀)인데 이름 없는 벤치가 없다
    const clubs = state.teams.filter(
      (t) => t.aiManagerTacticsRating !== undefined && t.id !== state.userTeamId,
    );
    expect(clubs.length).toBeGreaterThan(0);
    for (const team of clubs) expect(team.managerName, team.id).toBeDefined();
    // 명부의 벤치는 명부의 그 사람
    expect(state.teams.find((t) => t.id === "mancity")?.managerName).toBe("펩 과르디올라");
    // 이름이 곧 characterId(전역 유일) — 벤치끼리도, 우리 구단 인물·유저와도 겹치지 않는다
    const names = clubs.map((t) => t.managerName!);
    const occupied = new Set([...state.personas!.map((p) => p.name), state.manager.name]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(occupied.has(name), name).toBe(false);
  });

  it("벤치 채우기는 (시드, 팀) 채널로 결정적이다 — 다시 채워도 같은 사람이다", () => {
    const state = createTestGame();
    const before = state.teams.map((t) => t.managerName);
    for (const team of state.teams) if (team.id !== state.userTeamId) delete team.managerName;
    ensureSeededManagers(state);
    // 같은 세계를 다시 세워도 그 벤치의 사람은 같다
    expect(state.teams.map((t) => t.managerName)).toEqual(before);
  });

  it("화자 사전이 상대 벤치를 감독으로 표시한다", () => {
    const state = createTestGame();
    const bench = state.teams.find(
      (t) =>
        t.id !== state.userTeamId &&
        t.managerName !== undefined &&
        worldFigureManagerOf(t.id) === null,
    )!;
    const name = bench.managerName!;
    // 화면이 붙일 직책 — 명부 감독과 같은 자리다
    expect(speakerRoles(state)[normalizeSpeaker(name)]).toEqual({ kind: "manager", label: "감독" });
  });
});

/**
 * 인물 사전 키워드 — **나열한 것만 본다** (people.md §6). 만드는 자리가 한 곳이라
 * 자리마다 다른 규칙이 생기지 않는다.
 */
describe("페르소나 키워드", () => {
  it("전체 이름과 성이 키워드가 된다 — 이름 조각은 담지 않는다", () => {
    const keywords = personaKeywords({ name: "스티브 홀랜드", role: "player" });
    expect(keywords).toContain("스티브 홀랜드");
    expect(keywords).toContain("홀랜드");
    /**
     * **given은 담지 않는다** — 인물 풀은 given 열여섯 × family 열여섯이라, 한 세이브의
     * 열일곱 명(구단 아홉 + 무직 풀 여덟)이 그 열여섯을 나눠 갖는다. given을 담으면
     * 감독이 「스티브」 한 사람을 부른 턴에 같은 given의 셋이 함께 서서 한 턴 상한
     * 3장을 조각이 통째로 먹는다 (people.md §6 · 가상 감독이 이미 지키던 규칙).
     */
    expect(keywords).not.toContain("스티브");
    // 중복도 한 글자도 남지 않는다
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(personaKeywords({ name: "박 지", role: "player" })).toEqual(["박 지"]);
  });

  it("시드 키워드는 인물을 식별하고 직책과 매체로 다른 사람까지 부르지 않는다", () => {
    const people = [
      generateHeadCoach(42, "manutd"),
      generateOwner(42, "manutd"),
      ...generateReporters(42, "arsenal"),
    ];
    for (const person of people) {
      expect(person.lorebook.keywords).toContain(person.name);
      for (const generic of [
        "수석코치",
        "코치",
        "구단주",
        "회장",
        "보드",
        "기자",
        "회견",
        "인터뷰",
        "이적",
        person.outlet,
      ]) {
        if (generic) expect(person.lorebook.keywords).not.toContain(generic);
      }
    }
  });
});

describe("로어북이 인물 서사의 유일한 원본이다", () => {
  it("카탈로그 편집은 시드 서술 전체를 대체하고 고용 사실을 보존한다", () => {
    const previous = process.env.STORY_FM_DATA_DIR;
    const directory = mkdtempSync(join(tmpdir(), "story-persona-override-"));
    process.env.STORY_FM_DATA_DIR = directory;
    try {
      const original = generateHeadCoach(42, "arsenal", "2026-07-01");
      const book = {
        name: "바꿀 수 없는 신원",
        keywords: ["별칭"],
        description: "직접 쓴 설명",
        information: "직접 쓴 정보",
      };
      writePersonaBooks({ [original.characterId]: book });
      const edited = generateHeadCoach(42, "arsenal", "2026-07-01");
      expect(edited.lorebook).toEqual({ ...book, name: original.name });
      expect(edited.employment).toEqual(original.employment);
      expect(edited.real).toBe(original.real);
      for (const field of ["archetype", "traits", "motivation", "speechStyle", "keywords"])
        expect(edited).not.toHaveProperty(field);
      edited.lorebook.keywords.push("세이브 안에서만 변경");
      expect(generateHeadCoach(42, "arsenal", "2026-07-01").lorebook.keywords).toEqual(["별칭"]);
    } finally {
      if (previous === undefined) delete process.env.STORY_FM_DATA_DIR;
      else process.env.STORY_FM_DATA_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("생성된 인물에는 초기 책과 신원·고용 사실만 남는다", () => {
    const people = [
      generateHeadCoach(42, "arsenal", "2026-07-01"),
      generateOwner(42, "arsenal"),
      ...generateReporters(42, "arsenal"),
      ...generateStaff(42, "arsenal", "2026-07-01"),
      generateVirtualManager(42, "검증 감독"),
      ...worldFigures({ userTeamId: "arsenal" }),
    ];
    for (const person of people) {
      expect(PersonaSchema.parse(person)).toEqual(person);
      expect(LorebookContentSchema.parse(person.lorebook)).toEqual(person.lorebook);
      expect(person.lorebook.name).toBe(person.name);
      for (const field of ["archetype", "traits", "motivation", "speechStyle", "keywords"])
        expect(person).not.toHaveProperty(field);
    }
    expect(people[0]!.employment?.teamId).toBe("arsenal");
    expect(people[0]!.real).toBe(true);
  });

  it("편집된 설명과 키워드는 시드 동기화 뒤에도 조회와 검색의 원본이다", () => {
    const state = createTestGame();
    const coach = headCoachOf(state);
    const original = structuredClone(coach);
    const entry = state.lorebook.find((row) => row.id === `person:${coach.characterId}`)!;
    expect(
      requestCharacterUpdate(state, { characterId: entry.id, additionalInformation: "새로운 경험" })
        .ok,
    ).toBe(true);
    const job = state.lorebookJobs.at(-1)!;
    expect(
      completeCharacterUpdate(state, job.id, entry.version, {
        keywords: ["바뀐별칭"],
        description: "이제 선수를 먼저 듣는 코치",
        information: "새로운 경험으로 예전 생각을 바꿨다.",
      }),
    ).toBe(true);
    syncLorebook(state);
    expect(personaBookOf(state, coach)).toBe(entry);
    expect(staffViews(state).find((row) => row.name === coach.name)?.description).toBe(
      entry.description,
    );
    expect(selectLorebook([entry], "바뀐별칭", [])).toHaveLength(1);
    expect(selectLorebook([entry], coach.lorebook.keywords.at(-1)!, [])).toHaveLength(0);
    expect(coach).toEqual(original);
  });
});

describe("고용과 로어북 원본", () => {
  it("해고·재고용은 갱신된 같은 책을 참조하고 계약 이력을 보존한다", () => {
    const state = createTestGame();
    const person = state.personas.find((row) => row.role === "coach" && row.employment)!;
    const bookId = person.lorebookId;
    const book = state.lorebook.find((row) => row.id === bookId)!;
    requestCharacterUpdate(state, {
      characterId: bookId,
      additionalInformation: "감독과 육성 방침에 합의했다",
    });
    completeCharacterUpdate(state, state.lorebookJobs.at(-1)!.id, book.version, {
      keywords: book.keywords,
      description: book.description,
      information: "육성 방침을 합의한 코치",
    });
    expect(releaseStaff(state, { name: person.name }).ok).toBe(true);
    expect(state.staffPool.find((row) => row.name === person.name)?.lorebookId).toBe(bookId);
    const beforeRead = JSON.stringify(state);
    expect(staffPoolOf(state).find((row) => row.name === person.name)?.lorebook.information).toBe(
      book.information,
    );
    expect(JSON.stringify(state)).toBe(beforeRead);
    expect(hireStaff(state, { name: person.name, salary: 1, until: "2030-06-30" }).ok).toBe(true);
    expect(person.lorebookId).toBe(bookId);
    expect(person).not.toHaveProperty("lorebook");
    expect(person.employmentHistory).toHaveLength(1);
    expect(personaBookOf(state, person).information).toBe("육성 방침을 합의한 코치");
    expect(state.lorebook.filter((row) => row.id === bookId)).toHaveLength(1);
  });
});
