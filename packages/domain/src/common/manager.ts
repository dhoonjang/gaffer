import { REACTION_SEASON_CAP } from "./social-ledger";
import { z } from "zod";

import { BoardExpectationCodeSchema } from "./manager-career";
import { DateString } from "./date-string";

/** 평판 눈금의 아래끝 — 0에서 더 내려가지 않는다 (career.md §4) */
export const REPUTATION_MIN = 0;
/** 평판 눈금의 위끝 — 보드·미디어·선수단 모두 같은 0~100 축이다 (career.md §4) */
export const REPUTATION_MAX = 100;

/** 평판 — 세계가 감독을 어떻게 보는가 (능력치와 구분, career.md §4) */
export const ReputationSchema = z.number().int().min(REPUTATION_MIN).max(REPUTATION_MAX);

export const ManagerReputationSchema = z.object({
  board: ReputationSchema,
  media: ReputationSchema,
  squad: ReputationSchema,
});
export type ManagerReputation = z.infer<typeof ManagerReputationSchema>;

export const ReactionSeasonSchema = z.object({
  season: z.number().int(),
  board: z.number().int().min(-REACTION_SEASON_CAP).max(REACTION_SEASON_CAP),
  media: z.number().int().min(-REACTION_SEASON_CAP).max(REACTION_SEASON_CAP),
  squad: z.number().int().min(-REACTION_SEASON_CAP).max(REACTION_SEASON_CAP),
});
export type ReactionSeason = z.infer<typeof ReactionSeasonSchema>;

/** 평판 3축의 표시 순서 + 한글 이름 */
export const REPUTATION_AXIS_KO: Record<keyof ManagerReputation, string> = {
  board: "보드",
  media: "미디어",
  squad: "선수단",
};
export const REPUTATION_AXES = Object.keys(REPUTATION_AXIS_KO) as Array<keyof ManagerReputation>;

/**
 * **평판 구간 → 어휘.** 판정이 전부 코어 안에서 끝나는 눈금이라 LLM에는 숫자가 아니라
 * 이 말이 실린다 (prompts.md §5-2). 날수치를 실으면 프롬프트가 그것을 다시 말로
 * 되돌려야 하고, 같은 42가 턴마다 다른 말로 나온다.
 *
 * 경계는 코어가 이미 쓰는 자리다 — 80은 보드 신뢰 계수가 1.0에 닿는 눈금
 * (`board-request.ts`), 60은 설득 논거 `manager_reputation`이 통하는 문턱,
 * 30은 그 신뢰 계수가 0으로 바닥나는 자리, 45\~59는 시작값 50을 낀 중립 구간이다
 * (career.md §4 · §5.3).
 *
 * 축마다 말이 다른 것은 세계가 감독을 보는 눈이 셋이기 때문이다 — 보드는 신임,
 * 미디어는 논조, 선수단은 신뢰다.
 */
export const REPUTATION_TIERS = [
  { key: "absolute", min: 80, ko: { board: "절대적", media: "극찬", squad: "절대적" } },
  { key: "firm", min: 60, ko: { board: "두터움", media: "호평", squad: "두터움" } },
  { key: "watching", min: 45, ko: { board: "관망", media: "관망", squad: "관망" } },
  { key: "shaky", min: 30, ko: { board: "흔들림", media: "싸늘", squad: "동요" } },
  { key: "lost", min: 0, ko: { board: "등돌림", media: "뭇매", squad: "불신" } },
] as const;

const reputationTierOf = (value: number) =>
  REPUTATION_TIERS.find((t) => value >= t.min) ?? REPUTATION_TIERS[REPUTATION_TIERS.length - 1]!;

/** 그 축의 평판을 말로 — LLM 입력이 읽는 유일한 형태 */
export function reputationLabel(axis: keyof ManagerReputation, value: number): string {
  return reputationTierOf(value).ko[axis];
}

/**
 * 평판 3축 한 줄 — `보드 두터움 · 미디어 관망 · 선수단 동요`.
 *
 * 스냅샷과 `get_career`가 같은 줄을 낸다. 두 벌로 두면 한쪽만 어휘가 바뀌는 날
 * 같은 평판이 두 화면에서 다른 말을 한다.
 */
export function describeReputation(reputation: ManagerReputation): string {
  return REPUTATION_AXES.map(
    (axis) => `${REPUTATION_AXIS_KO[axis]} ${reputationLabel(axis, reputation[axis])}`,
  ).join(" · ");
}

/**
 * 감독이 말을 꺼낸 **자리**.
 *
 * 넷은 라커룸이다. 다섯째 `shout`은 진행 중 정지점에서 던지는 짧은 말이라 **경기가
 * 센다** — 장부는 `PendingMatch.shouts`(경기당 `SHOUT_PER_MATCH`)이고, 폭도 라커룸의
 * 한마디보다 좁다 (career.md §2). 대화는 하루에 몇 번이든 판정이 서고, 되풀이를
 * 자르는 것은 듣는 선수마다의 사기 합계 상한이다(`PlayerState.talkMorale`).
 */
export const TEAM_TALK_OCCASIONS = ["pre", "half", "post", "daily", "shout"] as const;
export type TeamTalkOccasion = (typeof TEAM_TALK_OCCASIONS)[number];

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
  /**
   * 보드가 재계약 여부를 판정한 날 — **만료 90일 전에 한 번뿐이다** (career.md §5.4).
   * 서 있으면 다시 판정하지 않는다: 매일 다시 보면 평판이 오르내릴 때마다 통보가
   * 번복된다. 없으면 아직 판정하지 않았다.
   */
  renewalDecidedOn: DateString.optional(),
  /** 그 판정이 재계약 제안으로 이어졌는가 — 아니면 비갱신 통보다 */
  renewalOffered: z.boolean().optional(),
});
export type ManagerContract = z.infer<typeof ManagerContractSchema>;

/**
 * **보드가 재계약 여부를 판정하는 시점** — 만료 며칠 전인가 (career.md §5.4).
 *
 * 판정을 내리는 자리(`market/manager-market.ts`)와 그 뒤 회견마다 감독의 거취를
 * 사실로 세우는 자리(`club/press.ts`)가 같은 값을 읽어야 한다 — 두 벌을 두면
 * 통보가 선 다음 날부터 기자가 묻지 않는 창이 생긴다.
 */
export const RENEWAL_NOTICE_DAYS = 90;

/**
 * **감독직 조건의 등급 표** — 제안의 기본 연봉·계약 연수·이적 예산 약속
 * (career.md §5.1). 흥정의 천장도 이 값에서 출발한다.
 */
export const MANAGER_TERMS_BY_TIER: Record<
  1 | 2 | 3 | 4,
  { salary: number; years: number; budgetPledge: number }
> = {
  1: { salary: 6_000_000, years: 3, budgetPledge: 30_000_000 },
  2: { salary: 3_000_000, years: 3, budgetPledge: 15_000_000 },
  3: { salary: 1_500_000, years: 2, budgetPledge: 6_000_000 },
  4: { salary: 800_000, years: 2, budgetPledge: 2_000_000 },
};

export const ManagerSchema = z.object({
  name: z.string().min(1),
  /** 온보딩에서 유저가 직접 입력한 배경 서술 (career.md §1) */
  background: z.string(),
  reputation: ManagerReputationSchema,
  /**
   * 이번 시즌 GM 반응이 옮긴 평판 누계 — 시즌 목줄이 읽는 자리 (career.md §4).
   * 적힌 시즌이 지금과 다르면 지난 시즌 장부라 읽는 쪽이 0에서 다시 센다.
   */
  reactionSeason: ReactionSeasonSchema,
  /** 감독 계약 — 없으면 무직이다 (경질·만료가 지운다, 연봉 지출도 없다) */
  contract: ManagerContractSchema.optional(),
});
export type Manager = z.infer<typeof ManagerSchema>;

/**
 * **경질 — 감독이 그 구단의 사람이 아니게 된 날** (career.md §5.1).
 *
 * 이 카드가 서 있는 동안 감독은 무직이다. 시계는 그대로 흐르고, 부임하면 지워진다.
 *
 * **사실만 적는다** — 등급·순위·기대가 있으면 "우승을 노리라는 구단에서 17위"와
 * "잔류가 기대인 구단에서 17위"가 갈리고, 그 문장은 화면과 GM이 쓴다
 * (overview.md §1 철칙 4).
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
  /** 그 구단의 등급 — 같은 순위가 어디서는 성공이고 어디서는 해고인 이유 */
  tier: z.number().int().min(1).max(4),
  /** 경질일의 리그 순위 — 아직 리그전을 치르지 않았으면 없다 */
  position: z.number().int().min(1).optional(),
  /** 보드가 걸었던 기대 순위 */
  target: z.number().int().min(1),
  /** 기대의 갈래 — 이름은 화면이 만든다 (career.md §6) */
  expectationCode: BoardExpectationCodeSchema,
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
 * 이적 협상(`Negotiation`)과 달리 라운드 표가 없다 — 흥정은 제안당 **한 차례**라
 * `counteredOn` 하나로 충분하다. 답하지 않으면 만료된다.
 *
 * 여기 적힌 등급·순위·기대·조건도 **부를 때의 사실**이다. 문장은 화면과 GM이 쓴다.
 */
export const ManagerOfferSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  madeOn: DateString,
  /** 이 날이 지나면 사라진다 */
  expiresOn: DateString,
  tier: z.number().int().min(1).max(4),
  /** 부를 때의 리그 순위 — 아직 리그전을 치르지 않았으면 없다 */
  position: z.number().int().min(1).optional(),
  /** 그 자리에 걸리는 기대 순위와 그 갈래 — 이름은 화면이 만든다 */
  target: z.number().int().min(1),
  expectationCode: BoardExpectationCodeSchema,
  /** 제시 조건 — 연봉·계약 연수·이적 예산 약속 (career.md §5.1) */
  salary: z.number().int().min(0),
  years: z.number().int().min(1),
  budgetPledge: z.number().int().min(0),
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
  /** 조정이 오간 날 — 서 있으면 흥정은 끝났다 (한 차례뿐이다) */
  counteredOn: DateString.optional(),
  status: z.enum(["open", "accepted", "expired"]),
});
export type ManagerOffer = z.infer<typeof ManagerOfferSchema>;

/**
 * **공석 명부의 한 줄** — AI 구단이 감독을 자른 자리 (career.md §5.1).
 *
 * 재직 중에도 쌓이고 14일 뒤 지워진다. 감독이 먼저 지원(`apply_manager_job`)할 수
 * 있는 문이고, 재직 중에 두드리면 보드 평판이 깎인다.
 */
export const ManagerVacancySchema = z.object({
  teamId: z.string().min(1),
  /** 공석이 난 날 — 경질일 */
  on: DateString,
  /** 그날의 리그 순위 */
  position: z.number().int().min(1).optional(),
});
export type ManagerVacancy = z.infer<typeof ManagerVacancySchema>;
