import { z } from "zod";
import { DateString } from "./date-string";
import { addYearsTo } from "./date-string";
import { type TransferReason } from "../negotiation/transfers";

// ── 지급 일정 ─────────────────────────────────────────
/**
 * 분할 지급의 연수 상한 — 실제 이적의 분할이 2~4년이고, 그 위는 흥정의 폭이
 * 아니라 관문(예산·잔고) 회피의 폭이다 (transfer.md §5-2).
 */
export const MAX_PAYMENT_YEARS = 4;

/** 지급 일정의 한 회분 — `paidOn=null`이 미지급 (기록 테이블 공통 패턴) */
export const PaymentInstallmentSchema = z.object({
  dueOn: DateString,
  amount: z.number().min(0),
  /** null = 아직 안 냈다 — 지급되면 낸 날이 적힌다 */
  paidOn: DateString.nullable(),
});

export type PaymentInstallment = z.infer<typeof PaymentInstallmentSchema>;

/**
 * 지급 일정 표 (PAYMENT_SCHEDULE) — **미래의 지급을 담는 자리** (transfer.md §5-2).
 *
 * 받는 쪽을 표가 직접 갖는 것은 해지 때문이다: 해지의 원장 row는 무소속행이라
 * `toTeamId`로는 받는 쪽을 되짚을 수 없다. 회분의 합은 합의 총액과 같아야 한다 —
 * 이적은 `TRANSFER.fee`, 해지는 합의 정산금.
 */
export const PaymentScheduleSchema = z.object({
  id: z.string().min(1),
  /** 근거 원장 — TRANSFER row */
  transferId: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 내는 구단 */
  payerTeamId: z.string().min(1),
  /** 받는 구단 — 해지 정산은 받는 쪽이 선수 본인이라 null */
  payeeTeamId: z.string().min(1).nullable(),
  /**
   * 무엇의 분할인가 — 원장 카테고리·라벨이 여기서 갈린다.
   * `sell_on`은 조항 정산(§5-3)이라 회분이 언제나 하나지만, 대칭으로 서기 위해
   * 이적료와 같은 문을 지난다.
   */
  kind: z.enum(["transfer", "severance", "sell_on"]),
  installments: z.array(PaymentInstallmentSchema),
});

export type PaymentSchedule = z.infer<typeof PaymentScheduleSchema>;

/**
 * 지급 일정의 회분 목록 — 총액을 등분해 첫 회분은 `firstDueOn`, 이후 해마다.
 * 각 회분은 `floor(총액/n)`이고 **마지막 회분이 잔차를 진다** — 합은 언제나
 * 총액과 같다 (transfer.md §11).
 */
export function buildPaymentInstallments(
  total: number,
  years: number,
  firstDueOn: string,
): PaymentInstallment[] {
  const n = Math.max(1, Math.min(MAX_PAYMENT_YEARS, Math.floor(years)));
  const per = Math.floor(total / n);
  return Array.from({ length: n }, (_, k) => ({
    dueOn: addYearsTo(firstDueOn, k),
    amount: k === n - 1 ? total - per * (n - 1) : per,
    paidOn: null,
  }));
}

/**
 * 이 원장 줄이 계약 해지인가 — 두 갈래를 한 자리에서 가른다.
 *
 * 계약 만료도 해지도 `type: "free"`로 같은 줄에 서지만 라커룸이 받는 사실은
 * 다르다: 하나는 계약이 끝난 것이고 하나는 **감독이 내보낸 것**이다. 심경이
 * 그 둘을 가르는 표식이 `reason`이다 (people.md §5). 흥정을 거친 상호 합의와 전액을
 * 물고 끊는 일방을 나눠 적는다 — 원장은 어느 길로 나갔는지를 알아야 하고, 라커룸에는
 * **사람이 사라졌다**는 같은 사실이 남는다.
 */
export function isRelease(transfer: { reason?: TransferReason }): boolean {
  return transfer.reason === "release-agreed" || transfer.reason === "release-unilateral";
}
