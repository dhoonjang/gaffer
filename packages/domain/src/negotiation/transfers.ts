import { z } from "zod";
import { DateString, addYearsTo } from "../common/date-string";

// ── 이적 ──────────────────────────────────────────────
export const TransferWindowSchema = z.object({
  id: z.string().min(1),
  season: z.number().int(),
  kind: z.enum(["summer", "winter"]),
  opensOn: DateString,
  closesOn: DateString,
  /**
   * 이 창이 적용되는 리그 — 없으면 **5대 리그 공통**(우리 협회)이다.
   * 사우디·MLS는 창이 우리보다 늦게 닫히거나 아예 다른 시기에 열린다.
   * 등록은 사는 쪽 협회 규정을 따르므로, 우리 창이 닫힌 뒤에도 그들은
   * 우리 선수를 사 갈 수 있다 — 팔아도 대체 영입은 못 하는 상태가 된다.
   */
  leagueId: z.string().min(1).optional(),
});

export type TransferWindow = z.infer<typeof TransferWindowSchema>;

export const TransferTypeSchema = z.enum(["transfer", "loan", "free", "youth", "retire"]);

/**
 * 이 이동이 **왜** 일어났나 — `type`이 못 가르는 갈래를 가르는 코드.
 *
 * 계약 만료도 계약 해지도 은퇴도 `type: "free"`나 `"retire"`로 같은 줄에 서지만
 * 라커룸이 받는 사실은 다르다: 하나는 계약이 끝난 것이고 하나는 **감독이 내보낸
 * 것**이다(people.md §5). 그 갈래를 원장의 문장으로 가르면 문구를 고치는 순간
 * 심경이 계약 해지를 못 알아본다 — 그래서 코드로 적는다
 * (→ docs/negotiation/transfer.md §2).
 */
export const TransferReasonSchema = z.enum([
  /** 흥정을 거친 상호 합의 해지 */
  "release-agreed",
  /** 전액을 물고 그 자리에서 끊은 일방 해지 */
  "release-unilateral",
  /** 계약이 그냥 끝났다 */
  "contract-expiry",
  /**
   * 반년 전에 맺은 사전 계약이 발효했다 (→ docs/negotiation/transfer.md §1-4).
   * `contract-expiry`와 갈라 적는 이유는 라커룸이 받는 사실이 다르기 때문이다 —
   * 하나는 계약이 끝나 무소속으로 나간 것이고, 이것은 **가기로 정해 두고 간 것**이다.
   */
  "precontract",
  "retire",
  "youth-callup",
  /**
   * 아카데미가 계약을 주지 않아 무소속 명부로 나갔다 (→ docs/common/season.md §6).
   * `youth-callup`의 반대쪽 문이고 `contract-expiry`와도 다르다 — 끝난 계약이 없다.
   */
  "youth-unsigned",
]);

export type TransferReason = z.infer<typeof TransferReasonSchema>;

// ── 조건부 조항 ────────────────────────────────────────
/**
 * 조항이 붙는 나이의 위 끝 — 어릴수록 파는 쪽이 놓아준 미래가 크다는 것이 조항의
 * 존재 이유라, 자를 나이로 잡는다 (transfer.md §5-3).
 */
export const CLAUSE_MAX_AGE = 23;

/** 셀온 비율의 밴드 — 실제 이적의 셀온이 앉는 자리다. 그 위는 이적료의 다른 이름이 된다 */
export const SELL_ON_MIN_RATE = 0.1;

export const SELL_ON_MAX_RATE = 0.25;

/** 최대 비율이 서는 나이 — 이 아래로는 더 오르지 않는다 */
export const SELL_ON_PEAK_AGE = 17;

/** 되사기가 함께 붙는 나이의 위 끝 — 셀온보다 좁다 */
export const BUYBACK_MAX_AGE = 21;

/**
 * 되사기 값의 배수 — "확실히 컸을 때만 되산다"의 눈금이다.
 * `BUYBACK_EXERCISE_MARGIN`과 곱해져 실제 문턱(시장가 ÷ 이적료)이 되므로 둘은
 * 함께 움직인다. 2배로 두면 문턱이 2.5배가 되어 조항이 걸려도 거의 발동하지
 * 않는다 — 칸만 남는 손잡이다 (transfer.md §5-3).
 */
export const BUYBACK_MARKUP = 1.5;

/** 되사기 창 — 두 여름과 한 겨울. 짧으면 자라기 전에 닫히고, 길면 값이 떨어져 나간다 */
export const BUYBACK_WINDOW_YEARS = 2;

/**
 * AI가 되사기를 행사하는 문턱 — 시장가가 조항 값의 이 배수 이상일 때만 되산다.
 * 1.0으로 재면 에이전트 수수료(10%)와 주급 상승만큼 손해를 보면서 되사고, 문턱이
 * 없으면 창마다 무의미하게 스쿼드를 뒤집는다 (transfer.md §5-3).
 */
export const BUYBACK_EXERCISE_MARGIN = 1.25;

/**
 * 셀온 조항 — 재판매 **이익**의 일부가 판 구단(`Transfer.fromTeamId`)으로 돌아온다.
 * 무는 쪽은 `toTeamId`이고, 살아 있는지는 그 선수의 계약이 아직 거기 있는가로
 * 읽는다 — 죽음을 따로 적지 않는다 (transfer.md §5-3).
 */
export const SellOnClauseSchema = z.object({
  /** 이익에 곱하는 비율 — 0.15 = 15% */
  rate: z.number().min(0).max(1),
  /** 정산된 날 — null이면 아직 발동하지 않았다 */
  settledOn: DateString.nullable(),
  /** 정산된 금액 — 발동 전엔 없다 */
  settledAmount: z.number().min(0).optional(),
});

export type SellOnClause = z.infer<typeof SellOnClauseSchema>;

/**
 * 되사기 조항 — 판 구단이 정해진 값에 되살 수 있는 **권리**다. 흥정이 아니라
 * 파는 쪽에 거부권이 없다 (transfer.md §5-3).
 */
export const BuyBackClauseSchema = z.object({
  /** 되사는 값 — 원 이적료에 배수를 곱한 값이다 */
  fee: z.number().min(0),
  /** 행사 창의 마지막 날 — 이날까지 행사할 수 있다 */
  until: DateString,
  /** 행사한 날 — null이면 아직 */
  exercisedOn: DateString.nullable(),
});

export type BuyBackClause = z.infer<typeof BuyBackClauseSchema>;

/** 한 이적에 걸린 조항들 — 둘 다 없으면 조항 자체를 적지 않는다 */
export const TransferClausesSchema = z.object({
  sellOn: SellOnClauseSchema.optional(),
  buyBack: BuyBackClauseSchema.optional(),
});

export type TransferClauses = z.infer<typeof TransferClausesSchema>;

/**
 * 나이가 정하는 셀온 비율 — 23세 `SELL_ON_MIN_RATE`에서 17세 이하
 * `SELL_ON_MAX_RATE`까지 선형이고 1%로 반올림한다 (transfer.md §5-3).
 */
export function sellOnRateForAge(age: number): number {
  const span = CLAUSE_MAX_AGE - SELL_ON_PEAK_AGE;
  const t = Math.max(0, Math.min(1, (CLAUSE_MAX_AGE - age) / span));
  return Math.round((SELL_ON_MIN_RATE + (SELL_ON_MAX_RATE - SELL_ON_MIN_RATE) * t) * 100) / 100;
}

/**
 * 이 이적에 붙는 조항 — **딜의 모양이 정한다** (transfer.md §5-3). 유저가 팔든
 * AI끼리 팔든 같은 함수를 지나므로 우리 구단만 다른 규칙으로 살 수 없다.
 *
 * 되산 이적은 여기를 지나지 않는다 — 되사기를 당한 구단이 원 소속 구단에게 셀온을
 * 걸게 되는데, 그 구단은 이 선수를 키운 적이 없다.
 */
export function clausesForSale(input: {
  age: number;
  fee: number;
  date: string;
}): TransferClauses | undefined {
  if (input.fee <= 0 || input.age > CLAUSE_MAX_AGE) return undefined;
  const clauses: TransferClauses = {
    sellOn: { rate: sellOnRateForAge(input.age), settledOn: null },
  };
  if (input.age <= BUYBACK_MAX_AGE) {
    clauses.buyBack = {
      fee: Math.round(input.fee * BUYBACK_MARKUP),
      until: addYearsTo(input.date, BUYBACK_WINDOW_YEARS),
      exercisedOn: null,
    };
  }
  return clauses;
}

/**
 * 셀온 정산 금액 — **이익에만 붙는다.** 총액에 붙이면 손해 보고 판 구단이 돈을
 * 더 무는데, 그것은 조항이 막으려던 일의 반대다 (transfer.md §5-3).
 */
export function sellOnAmountOf(input: {
  originalFee: number;
  resaleFee: number;
  rate: number;
}): number {
  const profit = input.resaleFee - input.originalFee;
  if (profit <= 0) return 0;
  return Math.round(profit * input.rate);
}

/**
 * 팀 변경 원장 — 이적·임대·자유계약·유스 콜업·은퇴까지 모든 이동이 row로 남는다.
 * GamePlayer.teamId는 "현재값"일 뿐이고 이력의 원본은 여기다.
 */
export const TransferSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 창 밖 이동(자유계약·유스·은퇴)은 null */
  windowId: z.string().min(1).nullable(),
  /** 유스 콜업·신규 영입은 null */
  fromTeamId: z.string().min(1).nullable(),
  /** 은퇴·방출은 null */
  toTeamId: z.string().min(1).nullable(),
  date: DateString,
  type: TransferTypeSchema,
  /** 이적료 — 양 팀 원장(LEDGER_ENTRY)과 동시 기록 */
  fee: z.number().min(0),
  /** `type`이 못 가르는 갈래 — 없으면 그냥 이동이다 */
  reason: TransferReasonSchema.optional(),
  /** 이 이적에 걸린 조건부 조항 — 없으면 조항 없는 평범한 이적이다 (§5-3) */
  clauses: TransferClausesSchema.optional(),
});

export type Transfer = z.infer<typeof TransferSchema>;
