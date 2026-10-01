import { z } from "zod";
import { DateString } from "./date-string";
import { CharacterBookContentSchema } from "./character-book";

/** 신원·직책·고용은 원장, 서사는 네 필드 캐릭터북에 둔다. */

/**
 * 인물이 세계에서 맡은 자리 — 채팅 @태그의 뿌리이자 **열린 집합**이다.
 *
 * 자리를 하나 늘리는 데 세 곳(라벨·아이콘·화자 사전)을 함께 고쳐야 하면 늘지 않는다.
 * 그래서 라벨과 아이콘은 **아는 자리에만** 붙고, 모르는 자리에는 사람 아이콘이 선다 —
 * 틀린 직책을 다느니 "누군가 말한다"까지만 말한다 (people.md §3).
 */
export const PersonaRoleSchema = z.enum([
  "head_coach",
  "owner",
  "reporter",
  "player",
  /**
   * 구단이 고용한 사람들 — **수석코치와 같은 자리가 아니다** (people.md §2-2).
   * 수석코치는 감독 옆에 서는 한 사람이고, 이쪽은 훈련장·의무실·보고서를 맡은
   * 사람들이다. 수석코치와 함께 `employment` 계약으로 고용·해고한다.
   */
  "coach",
  "medic",
  "scout",
  /** 감독의 사람 — 구단 밖에서 그를 아는 이 */
  "friend",
  /**
   * 서포터 — ⚠️ **이름 있는 개인만이다.** `characterId`가 그 사람의 이름이고 전역
   * 유일이므로 집단은 페르소나가 될 수 없다. "관중석이 술렁였다"는 화자 없는 내레이션의 몫.
   */
  "supporter",
  /**
   * 타 팀 감독 — 상대 벤치에 서는 사람이다. ⚠️ **`head_coach`가 아니다**: 그 자리는
   * 우리 구단의 수석코치, 감독(유저)이 매일 옆에 두는 사람이다 (people.md §2-1).
   */
  "manager",
  /** 에이전트 — 협상 테이블 건너편, 선수 쪽 */
  "agent",
  /**
   * 단장 — 협상 테이블 건너편, 구단 쪽 (people.md §2). 이적료·분할·기한을 답하는 사람이다.
   * 구단마다 한 사람이고 세이브에 넣지 않는다 — (시드, 구단)에서 파생한다.
   */
  "director",
  /** 해설 — 중계석과 스튜디오. 축구계에 남은 은퇴 인물이 대개 여기 선다 */
  "pundit",
]);
export type PersonaRole = z.infer<typeof PersonaRoleSchema>;

/**
 * **고용 정보** — 구단이 급여를 주는 사람만 든다 (people.md §2-2).
 *
 * 수석코치·코치·의료진·스카우트가 갖고 **구단주는 갖지 않는다** — 그는 고용된 사람이
 * 아니라 고용하는 쪽이다. 선수의 계약(`Contract`)과 다른 표인 이유는 자리가 다르기
 * 때문이다: 스태프는 등록 명단에도 이적 시장에도 서지 않고, 장부에서 `staff_wages`로
 * 선다 (→ ../../../docs/common/finance.md §6.4-1).
 */
export const EmploymentSchema = z.object({
  /** 어느 구단의 사람인가 — 감독이 이직해도 이 사람은 옛 구단에 남는다 */
  teamId: z.string().min(1),
  /** 그 사람의 직책 — 「피지컬 코치」. 역할 라벨(「코치」)보다 좁고, 화면 칩이 이것을 쓴다 */
  title: z.string().min(1),
  /** 부임일 — 카드의 「부임 2년째」가 여기서 나온다. 감독보다 앞설 수 있다 */
  since: DateString,
  /**
   * 연봉(£/년)과 만료일. **위약금의 근거이기도 하다** — 자르면 잔여 계약에 비례해
   * 문다(감독 경질과 같은 식 — career.md §5.4).
   */
  contract: z.object({ salary: z.number().int().min(0), until: DateString }),
  /** 데려온 곳 — 무직 풀에서 왔으면 그 사람의 옛 구단. 처음부터 있던 사람에겐 없다 */
  from: z.string().min(1).optional(),
});
export type Employment = z.infer<typeof EmploymentSchema>;

/** 일반 스태프의 자리 — 수석코치는 별도로 한 자리를 둔다. */
export const STAFF_ROLES = ["coach", "medic", "scout"] as const;
export const StaffRoleSchema = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

export const HireStaffInputSchema = z.object({
  name: z.string().trim().min(1),
  salary: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  until: DateString,
  role: z.enum(["head_coach", ...STAFF_ROLES]).optional(),
  title: z.string().trim().min(1).optional(),
  characterBook: CharacterBookContentSchema.optional(),
});
export type HireStaffInput = z.infer<typeof HireStaffInputSchema>;

/** 이 역할이 고용·해고의 대상인가 — 표를 직접 인덱싱하는 자리를 한 곳으로 묶는다 */
export function isStaffRole(role: PersonaRole): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

export const PersonaSchema = z.object({
  /**
   * 채팅 @태그와 1:1 (people.md §3) — **그 사람의 이름**이다.
   *
   * 선수가 `@손흥민:`으로 말하는데 코치만 `@수석코치:`로 말하면, 이름을 지어 준
   * 의미가 없고 화면에서도 그 사람이 아니라 직책이 말하는 것처럼 읽힌다.
   * 직책은 인물 카드가 따로 알려 준다.
   */
  characterBook: CharacterBookContentSchema,
  characterId: z.string().min(1),
  name: z.string().min(1),
  role: PersonaRoleSchema,
  /**
   * 소속 매체 — **기자에게만 있다.** 같은 질문도 어디 소속이냐가 결을 정한다:
   * 지역지는 구단의 내일을, 전국지는 리그 판도를, 타블로이드는 라커룸을 묻는다.
   */
  outlet: z.string().min(1).optional(),
  /**
   * 실존 인물인가 — 이름만 실제이고 성격·대사는 게임이 지어낸 것이다.
   * 실명 부채의 장부(sources.md §7)가 이 표식으로 센다. **프롬프트에는 실리지 않는다**
   * (docs/common/llm/prompts.md §5-3) — 인물 서사는 캐릭터북, 실제 사실은 원장이 소유한다.
   * 가상 인물엔 없다(옵셔널).
   */
  real: z.boolean().optional(),
  /**
   * 구단이 이 사람에게 급여를 주는가 — 자리·부임일·계약 (people.md §2-2).
   * 수석코치·코치·의료진·스카우트에게만 있다 — 구단주·기자·감독 풀의 사람은 없다.
   */
  employment: EmploymentSchema.optional(),
  employmentHistory: z
    .array(
      EmploymentSchema.extend({
        endedOn: DateString,
        reason: z.enum(["renewed", "expired", "released"]),
      }),
    )
    .optional(),
  /** 생성 재현용 — 같은 세이브는 같은 사람을 만난다 */
  seed: z.number().int(),
});
export type Persona = z.infer<typeof PersonaSchema>;

/**
 * 역할 → **직책 이름**. 화자 태그가 아니다(태그는 사람 이름이다).
 *
 * 두 곳이 같은 값을 쓴다: 인물 카드가 "이 사람의 자리"를 LLM에 밝힐 때, 그리고
 * 화면이 `스티브 홀랜드 (수석코치)`처럼 이름 옆에 붙일 때.
 *
 * ⚠️ **전부 채워야 하는 표가 아니다.** 자리가 열린 집합이므로(→ `PersonaRoleSchema`)
 * 라벨을 모르는 자리도 있고, 그 자리는 이름만으로 선다. 읽을 때는 `personaRoleLabel`을
 * 거쳐라 — 표를 직접 인덱싱하면 새 역할이 `undefined`를 문자열 자리에 세운다.
 */
export const PERSONA_ROLE_LABEL: Partial<Record<PersonaRole, string>> = {
  head_coach: "수석코치",
  owner: "구단주",
  reporter: "기자",
  player: "선수",
  coach: "코치",
  medic: "의료진",
  scout: "스카우트",
  manager: "감독",
  agent: "에이전트",
  director: "단장",
  pundit: "해설위원",
};

/** 아는 자리면 직책 이름, 모르면 없다 — 없는 것이 곧 "이름까지만 말한다"는 뜻이다 */
export function personaRoleLabel(role: PersonaRole): string | undefined {
  return PERSONA_ROLE_LABEL[role];
}

/**
 * **무직 스태프 풀의 한 줄** — 자리를 찾는 코치·의료진·스카우트 (people.md §2-2).
 *
 * 감독 풀(`ManagerPoolEntry`)과 같은 패턴이되 셋이 다르다: 채우는 것이 경질이 아니라
 * **여름의 결정적 추첨**이고, 부르는 쪽이 AI 구단이 아니라 **감독뿐**이며, 요구 연봉을
 * 넘기면 흥정 없이 그 자리에서 계약된다.
 *
 * 초기 캐릭터북은 생성 때 완성한다. 채용·해고는 서사를 다시 추첨하지 않는다.
 */
export const StaffPoolEntrySchema = z.object({
  /** 이름이 곧 `characterId`다 (people.md §1) */
  name: z.string().min(1),
  role: z.enum(["head_coach", ...STAFF_ROLES]),
  /** 그 사람이 맡을 자리 — 「피지컬 코치」 */
  title: z.string().min(1),
  /** 채용 전 초기 책. 지속적 기록은 세이브의 캐릭터북에서 읽는다. */
  characterBook: CharacterBookContentSchema,
  /** 요구 연봉 (£/년) — 이 이상을 부르면 그 자리에서 계약된다 */
  ask: z.number().int().min(0),
  /** 이 줄이 선 시즌 — 여름 갱신이 「그해 자른 사람만 남긴다」를 판단하는 기준 */
  listedOn: z.number().int(),
  /** 직전 구단 — 감독이 자른 사람에게만 있다 */
  from: z.string().min(1).optional(),
});
export type StaffPoolEntry = z.infer<typeof StaffPoolEntrySchema>;

/** 수석코치의 직책 라벨 — 고용 정보의 `title`이 이 값이다 (people.md §2-2) */
export const HEAD_COACH_ROLE_LABEL = PERSONA_ROLE_LABEL.head_coach!;

/**
 * 주장 — 페르소나가 아니지만 대화에서 자리가 뜻을 갖는 유일한 선수다.
 * 사전을 만드는 코어와 아이콘을 고르는 화면이 **같은 문자열**을 봐야 한다.
 */
export const CAPTAIN_ROLE_LABEL = "주장";

/**
 * 감독이 지정하는 주장·부주장 직책
 * (→ docs/story/people.md §5-1). 사실 카드·화면·조회 도구가 **같은 문자열**을 읽는다.
 */
export const LEADER_ROLES = ["captain", "vice"] as const;
export type LeaderRole = (typeof LEADER_ROLES)[number];
export const LeaderRoleSchema = z.enum(LEADER_ROLES);

export const LEADER_ROLE_LABEL: Record<LeaderRole, string> = {
  captain: CAPTAIN_ROLE_LABEL,
  vice: "부주장",
};

/** 중계 — 무대 밖의 목소리. 이름이 곧 자리다 */
export const BROADCAST_SPEAKER = "중계";

/**
 * 화자 이름 정규화 — 사전을 만들 때와 찾을 때가 **같은 함수**를 써야 한다.
 *
 * 모델은 같은 사람을 "스티브 홀랜드"로도 "스티브홀랜드"로도 쓴다. 그 정도 흔들림은
 * 흡수하되 **추측은 하지 않는다** — 성만 쓴 "홀랜드"를 같은 사람으로 보는 부분 일치는
 * 오탐(동명이인·유사 이름)이 잘못된 직책을 붙이게 만든다. 확실할 때만 붙인다.
 */
export function normalizeSpeaker(name: string): string {
  return name.replace(/\s+/gu, "");
}

/** 지난 시즌 현금 잉여를 다음 시즌 이적 예산으로 돌리는 공통 몫 */
export const REINVEST_SHARE_DEFAULT = 0.5;
