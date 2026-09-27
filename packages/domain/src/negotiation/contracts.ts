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
   * **어떤 자리로 왔는가** — 계약에 적히는 약속이다 (→ docs/story/people.md §5-2).
   *
   * 출전 불만도 약속 이행도 이 칸을 읽는다: 백업으로 온 선수와 주전으로 온 선수를
   * 같은 자로 재면 스쿼드를 채우는 일 자체가 반란의 씨앗이 된다. 약속하지 않은 계약
   * (시드의 계약·AI 구단의 계약)엔 없고, 그때는 **지금 서열에서 파생한다**(`squadStatusOf`).
   */
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
  /**
   * **바이아웃 조항** — 이 금액 이상의 오퍼가 오면 구단이 막지 못한다
   * (→ docs/negotiation/transfer.md §12-3). 감독이 흥정한 계약은 조건서에서 오고, AI
   * 구단의 계약은 서는 날 코어가 시장가에서 정한다(`aiBuyoutClauseOf`) — 우리 구단만
   * 조항을 갖고 살면 세계에서 조항으로 살 수 있는 선수가 하나도 없다.
   * 없는 계약은 조항이 없는 계약이다.
   */
  buyoutClause: z.number().min(0).optional(),
  /**
   * **합의된 조건서의 사본** — 무엇을 약속했는가의 기록이다 (transfer.md §12-3). 이행은
   * 약속 장부와 조항 필드가 판정하고, 여기 줄은 감독과 건너편이 그 계약을 읽을 때 본다.
   * 표에 없는 조건(`other`)은 문장 그대로 여기서만 산다. 조건서 없이 선 계약엔 없다.
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
