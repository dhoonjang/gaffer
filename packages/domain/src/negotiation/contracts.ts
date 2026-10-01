import { z } from "zod";
import { DateString } from "../common/date-string";
import { SQUAD_STATUSES } from "../common/squad-rules";
import { ContractTermSchema } from "./deal-terms";

// ── 계약 (주급의 원본) ────────────────────────────────
export const ContractSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 활성 계약의 teamId는 선수의 현 소속과 일치해야 한다 */
  teamId: z.string().min(1),
  /** 주급 — 매주 tick이 팀 재정 원장에 지출로 기록 */
  weeklyWage: z.number().min(0),
  since: DateString,
  until: DateString,
  /**
   * `active` = 선수당 정확히 1건 · `ended` = 지난 계약 · **`pending` = 아직 발효하지
   * 않은 계약**.
   *
   * `pending`은 사전 계약(보스만)이 남기는 줄이다 (→ docs/negotiation/transfer.md §1-4).
   * `since`가 미래(다음 7월 1일)이고, 시즌 전환이 그날 `active`로 바꾸며 선수를 옮긴다.
   * ⚠️ **활성이 아니다** — 주급 총액·등록 명단·계약 사슬 어디에도 세어지지 않고
   * `activeContract`가 고르지 않는다. 세면 아직 오지도 않은 선수의 주급이 이번 주
   * 원장에 실린다 (§11).
   */
  status: z.enum(["active", "ended", "pending"]),
  /**
   * 계약에서 합의한 선수의 역할 (→ docs/story/people.md §5-2).
   * 없으면 `squadStatusOf`가 현재 선수단의 능력·자리 깊이·나이로 참고 역할을 파생한다.
   * 역할의 의미와 선수 반응은 GM이 해석하며, 고정 출전 비율로 이행을 판정하지 않는다.
   */
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
  /**
   * 합의한 바이아웃 금액. 이 금액 이상의 오퍼는 조항에 따라 구단의 가격 관문을 통과한다.
   * 선수의 개인 조건 동의는 별도로 필요하며, 값이 없으면 바이아웃 조항이 없는 계약이다.
   */
  buyoutClause: z.number().min(0).optional(),
  /**
   * 합의한 계약 조건의 기록. 코어는 금전 조항을 집행하고 일회성 지급·인상의 집행일을 남긴다.
   * 서사 조건은 별도 약속 상태로 복제하지 않으며, GM이 조건과 실제 사실을 읽어 해석한다.
   * `other`는 합의한 문장을 보존한다. 조건서 없이 맺은 계약에는 없다.
   */
  terms: z.array(ContractTermSchema).optional(),
  /**
   * 이 계약에 대해 이미 낸 만료 경고 중 **가장 낮은 문턱**(일). 없으면 아직 안 냈다.
   * 문턱을 하루로 재면 tick이 지나지 않은 날의 경고는 영영 오지 않으므로,
   * "이하로 내려왔고 아직 안 냈다"로 판단한다 (simulation/season.md §5).
   */
  expiryWarnedStage: z.number().int().positive().optional(),
});

export type Contract = z.infer<typeof ContractSchema>;

/**
 * **사전 계약이 열리는 잔여 계약 기간(개월)** — 반년이다
 * (→ docs/negotiation/transfer.md §1-4).
 *
 * 계약은 어느 문으로 들어왔든 6월 30일에 끝나므로(§5-1) 이 창은 실제로 **12월 말에
 * 열려 만료일에 닫힌다** — 1월 1일이면 언제나 열려 있다.
 */
export const PRECONTRACT_MONTHS = 6;

/**
 * 그 개월을 **일수로** — 경계를 하루로 딱 떨어지게 재기 위해서다. 잔여를 연 단위
 * 소수(`contractYearsLeft`)로 재면 같은 날이 부동소수 나눗셈의 어느 쪽에 앉느냐로
 * 갈린다: 창의 문턱은 감독이 달력에서 셀 수 있는 값이어야 한다.
 */
export const PRECONTRACT_DAYS = Math.round((365 * PRECONTRACT_MONTHS) / 12);
