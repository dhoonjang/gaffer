import { z } from "zod";

import { DateString } from "./date-string";
import { ClubTierSchema } from "./team";

/**
 * **감독 계약** — 연봉·체결일·만료일 (career.md §5.1 · §5.4).
 *
 * 새 게임은 부임 구단 등급의 기본 조건(`MANAGER_TERMS_BY_TIER`)으로 시작하고,
 * 부임은 제안의 조건으로 계약을 다시 세운다. 만료일이 지나면 감독은 무직이 되고,
 * 경질은 계약을 지우며 위약금을 남긴다 (career.md §5.4).
 */
export const ManagerContractSchema = z.object({
  /** 연봉 (£/년) — 매월 1일 구단 지출에 1/12로 선다 (finance.md §6) */
  salary: z.number().int().min(0),
  signedOn: DateString,
  until: DateString,
});
export type ManagerContract = z.infer<typeof ManagerContractSchema>;

/**
 * **감독직 조건의 등급 표** — 제안의 기본 연봉·계약 연수
 * (career.md §5.1). 새 게임의 초기 계약에 사용한다.
 */
export const MANAGER_TERMS_BY_TIER: Record<1 | 2 | 3 | 4, { salary: number; years: number }> = {
  1: { salary: 6_000_000, years: 3 },
  2: { salary: 3_000_000, years: 3 },
  3: { salary: 1_500_000, years: 2 },
  4: { salary: 800_000, years: 2 },
};

export const ManagerSchema = z.object({
  name: z.string().min(1),
  /** 온보딩에서 유저가 직접 입력한 배경 서술 (career.md §1) */
  background: z.string(),
  /** 감독 계약 — 없으면 무직이다 (경질·만료가 지운다, 연봉 지출도 없다) */
  contract: ManagerContractSchema.optional(),
});
export type Manager = z.infer<typeof ManagerSchema>;

/**
 * **경질 — 감독이 그 구단의 사람이 아니게 된 날** (career.md §5.1).
 *
 * 이 카드가 서 있는 동안 감독은 무직이다. 시계는 그대로 흐르고, 부임하면 지워진다.
 *
 * 구단·날짜·당시 체급과 순위·계약 정산을 기록한다. 구단주의 해석은 캐릭터북에 남는다.
 */
export const DismissalSchema = z.object({
  on: DateString,
  season: z.number().int(),
  /**
   * 자리를 잃은 갈래 — 경질(`sacked`) · 계약 만료(`expired`) · 감독이 스스로 물고
   * 나간 사임(`resigned`) · **다른 구단이 보상금을 물고 데려간 이적**(`moved` —
   * career.md §5.1) (career.md §5.4). 무직은 **상태지 사유가 아니라서** 카드 하나가
   * 넷을 다 든다. ⚠️ `moved`만 그 뒤가 무직이 아니다 — 같은 날 새 벤치에 서므로
   * 이 카드는 `dismissal`에 서지 않고 곧장 이력에 적힌다.
   */
  kind: z.enum(["sacked", "expired", "resigned", "moved"]),
  /** 어느 구단에서 잘렸나 */
  teamId: z.string().min(1),
  /** 그 구단의 등급 — 당시 구단 체급 */
  tier: ClubTierSchema,
  /** 경질일의 리그 순위 — 아직 리그전을 치르지 않았으면 없다 */
  position: z.number().int().min(1).optional(),
  /**
   * 위약금 (£) — **누가 물었는지는 `kind`가 안다** (career.md §5.4). 경질이면 구단이
   * 물어 구단 원장에 나간 돈이고, 사임이면 옛 구단의 수입이며,
   * 이적이면 **새 구단이 옛 구단에 문 보상금**으로 구단 간에 정산한다 (§5.1).
   * 만료는 끝까지 간 계약이라 물 것이 없어 적지 않는다.
   */
  severance: z.number().int().min(0).optional(),
});
export type Dismissal = z.infer<typeof DismissalSchema>;

/**
 * **감독직 제안** — 공석이 된 구단이 무직 감독을 부른 기록 (career.md §5.1).
 *
 * 제안 조건은 합의한 수정으로 갱신하며 응답 기한이 지나면 만료된다.
 *
 * 여기 적힌 등급·순위·조건도 **부를 때의 사실**이다. 문장은 화면과 GM이 쓴다.
 */
export const ManagerOfferSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  madeOn: DateString,
  /** 이 날이 지나면 사라진다 */
  expiresOn: DateString,
  tier: ClubTierSchema,
  /** 부를 때의 리그 순위 — 아직 리그전을 치르지 않았으면 없다 */
  position: z.number().int().min(1).optional(),
  /** 제시 조건 — 연봉·계약 연수 (career.md §5.1) */
  salary: z.number().int().min(0),
  years: z.number().int().min(1),
  /**
   * 어떻게 섰나 — 공석이 불렀나(`vacancy`), 감독이 두드렸나(`knock`), 지금 구단이
   * 재계약을 걸었나(`renewal` — career.md §5.4), 아니면 다른 구단이 **재직 중인**
   * 감독에게 손을 뻗었나(`poach` — career.md §5.1 「재직 중 접근·노크」).
   *
   * 재직 중에 설 수 있는 것은 셋이다 — `renewal`·`poach`, 그리고 재직 중에 두드려
   * 얻은 `knock`. `vacancy`는 무직에게만 붙는다.
   */
  via: z.enum(["vacancy", "knock", "renewal", "poach"]),
  /**
   * **이 자리가 옛 구단에 물 보상금** (£) — 재직 중인 감독을 부르는 제안에만 실린다
   * (career.md §5.1). 금액은 경질 위약금과 같은 식(`managerSeveranceOf`)으로 **부를
   * 때** 재고, 수락일에 다시 재지 않는다 — 그 구단이 물기로 한 값이 곧 이 값이다.
   */
  compensation: z.number().int().min(0).optional(),

  status: z.enum(["open", "accepted", "expired"]),
});
export type ManagerOffer = z.infer<typeof ManagerOfferSchema>;

/**
 * **공석 명부의 한 줄** — AI 구단이 감독을 자른 자리 (career.md §5.1).
 *
 * 후임이 선임될 때까지 유지한다. 감독이 먼저 지원(`apply_manager_job`)할 수
 * 있는 문이며, 제안 여부와 조건은 GM이 면접에서 판단한다.
 */
export const ManagerVacancySchema = z.object({
  teamId: z.string().min(1),
  /** 공석이 난 날 — 경질일 */
  on: DateString,
  /** 그날의 리그 순위 */
  position: z.number().int().min(1).optional(),
});
export type ManagerVacancy = z.infer<typeof ManagerVacancySchema>;
