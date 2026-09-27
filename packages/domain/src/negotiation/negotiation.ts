import { z } from "zod";
import { DateString } from "../common/date-string";
import { PitchClaimSchema } from "./persuasion";
import { MAX_PAYMENT_YEARS } from "../common/payments";
import { SQUAD_STATUSES } from "../common/squad-rules";
import { SQUAD_NUMBER_MAX } from "../common/player";
import { DealTermSchema } from "./deal-terms";

// ── 협상 (진행 중 흥정 — 완료된 이동은 TRANSFER) ────────
/**
 * 협상은 **원장이 아니다.** TRANSFER가 "일어난 이동"이라면 NEGOTIATION은 "합의되지
 * 않은 흥정"이고, 둘을 한 테이블에 섞으면 원장이 더러워진다. 합의(`agreed`) 뒤
 * 수락 명령이 TRANSFER·CONTRACT·재정을 쓰고 그때 `completed`가 된다.
 * (docs/negotiation/transfer.md)
 */
/**
 * 협상의 방향. `loan`은 **임대 영입**(남의 선수를 빌려 온다), `loan_out`은
 * **임대 내보내기**(우리 선수를 빌려준다). 둘 다 상대가 받아 줘야 성립하므로
 * 같은 테이블을 탄다 — 부르기(recall)만 흥정이 아니라 우리 결정이다.
 *
 * `release`는 **상호 계약 해지**다. 감독이 정산금을 제시하고 선수가 판정한다 —
 * 감독이 전액을 물고 그 자리에서 끊는 일방 해지는 흥정이 아니라 우리 결정이라
 * 이 테이블을 지나지 않는다 (docs/negotiation/transfer.md §2).
 */
export const NegotiationKindSchema = z.enum([
  "buy",
  "sell",
  "renew",
  "loan",
  "loan_out",
  "release",
]);

export type NegotiationKind = z.infer<typeof NegotiationKindSchema>;

/**
 * **상대가 선수 본인인 갈래** — 재계약과 해지.
 *
 * 구단이 상대인 갈래와 갈리는 자리가 여럿이다: 방향이 없고(카드 배지가 `영입`·`매각`을
 * 달 수 없다), 이적창과 무관하며, 메디컬을 지나지 않는다(옮겨 갈 구단이 없다).
 * 자리마다 `kind === "renew"`로 적어 두면 해지가 그 자리마다 구단 취급을 받는다.
 */
export function isPlayerDeal(kind: NegotiationKind): boolean {
  return kind === "renew" || kind === "release";
}

export const NegotiationVerdictSchema = z.enum(["accept", "counter", "reject"]);

export type NegotiationVerdict = z.infer<typeof NegotiationVerdictSchema>;

/** 오퍼 한 번 = 한 row. 서사의 원천이자 확률 검증(분포 모니터링)의 근거다 */
export const NegotiationRoundSchema = z.object({
  date: DateString,
  by: z.enum(["us", "them"]),
  fee: z.number().min(0),
  weeklyWage: z.number().min(0),
  /** 해지는 0 — 쓸 계약이 없는 협상이다 (`isPlayerDeal`) */
  contractYears: z.number().int().min(0).max(6),
  /** 상대 응답 예정일 — 우리 오퍼만 가진다 (상황에서 나온 지연) */
  respondsOn: DateString.nullable(),
  /**
   * **이 오퍼의 답을 감독에게 알린 날** — 만료 경고의 `Contract.expiryWarnedStage`와
   * 같은 결이다 (season.md §5). 도착한 답은 감독이 답할 때까지 그 자리에 서 있으므로
   * (`arrivedResponses`), 표식이 없으면 tick이 지나는 날마다 같은 카드를 한 장씩 민다.
   * 되받은 뒤 우리가 넣는 새 오퍼는 새 라운드라 표식 없이 시작한다.
   */
  announcedOn: DateString.optional(),
  /** 이 오퍼 시점에 코어가 계산한 확률 — 사후에 LLM 판정의 분포를 볼 수 있다 */
  probability: z.number().min(0).max(100),
  /** 상대의 판정 (them 라운드) */
  verdict: NegotiationVerdictSchema.nullable(),
  /**
   * 이 오퍼가 **어디서 나왔나** — 지금은 메디컬 소견을 보고 깎아 다시 부른 재호가
   * 하나뿐이다. 보통의 오퍼엔 없다.
   */
  origin: z.enum(["medical"]).optional(),
  note: z.string().optional(),
  /**
   * 이 오퍼에 실린 설득 논거 — **감독이 실제로 한 말**이 note에 남는다.
   * 판정하는 LLM이 읽어야 하므로 라운드에 붙인다. 논거 없는 오퍼엔 없다.
   */
  pitch: z.array(PitchClaimSchema).optional(),
  /**
   * 분할 지급 연수 — 없거나 1이면 일시금. 확정되면 지급 일정 표가 된다
   * (transfer.md §5-2).
   */
  paymentYears: z.number().int().min(1).max(MAX_PAYMENT_YEARS).optional(),
  /**
   * 이 오퍼가 제시하는 **스쿼드 지위** — 합의되는 순간 새 계약에 적힌다
   * (transfer.md §1 · people.md §5-2). 라운드는 그것을 **나를 뿐이다**: 성사되지
   * 않은 협상이 남긴 지위가 계약에 적히면 어기지도 않은 약속이 라커룸에 선다.
   * 지위를 제시하지 않은 오퍼엔 없다.
   */
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
  /**
   * 이 오퍼에서 **선수가 요구하는 등번호** — 합의되면 도착하는 날 그 번호가 배정된다
   * (transfer.md §3 · people.md §6). 원형이 번호에 뜻을 두는 선수만 채운다:
   * 아무나 번호를 부르면 요구가 값을 잃는다.
   */
  squadNumber: z.number().int().min(1).max(SQUAD_NUMBER_MAX).optional(),
  /**
   * 이 오퍼에 실린 **조건서** — 그 시점에 감독이 건 조건과 들어준 요구의 사본이다
   * (transfer.md §12-3). 조건서 자체는 협상이 들고(`Negotiation.terms`), 라운드는 그
   * 오퍼가 무엇을 싣고 나갔는지를 남긴다 — 합의 라운드의 조건이 서명 때 계약으로 간다.
   * 조건서 없이 나간 오퍼엔 없다.
   */
  terms: z.array(DealTermSchema).optional(),
  /**
   * **상대가 이 라운드에 건 기한** — 최후통첩 (transfer.md §12-1).
   *
   * 협상의 `expiresOn`을 이 날로 **당긴다**(뒤로는 못 민다). 협상이 쥔 기한과 따로
   * 남기는 이유는 그 기한이 지났을 때 무산이 아니라 **결렬**이어야 하기 때문이다 —
   * 문을 닫은 것이 달력인지 사람인지는 이 칸에만 적혀 있다. 통첩이 없으면 없다.
   */
  deadlineOn: DateString.optional(),
});

/**
 * 메디컬 — **합의와 계약 사이에 놓인 하루.**
 *
 * 실제 이적은 구단끼리 합의한 날 끝나지 않는다. 선수가 병원에 가고, 결과가
 * 나오고, 그다음에 발표한다. 이 표가 없으면 "오늘 합의 → 오늘 도장 → 오늘
 * 기자회견"이 한 장면에 담겨 이적이 서류 한 장으로 읽힌다.
 *
 * `flagged`는 불합격이 아니라 **소견**이다 — 데려가는 쪽이 알고도 갈지 정한다.
 * 판정은 `injuryProneness`·현재 부상·나이에서 결정적으로 나온다 (medical.ts).
 */
/**
 * 메디컬 소견 — **원인 코드 + 부위 + 기간.** 문장은 브리핑과 화면이 만든다
 * (→ docs/negotiation/transfer.md §5).
 */
export const MedicalConcernSchema = z.object({
  code: z.enum([
    /** 아직 낫지 않은 부상 — `days`가 복귀까지 남은 날 */
    "open-injury",
    /** 같은 자리에 남은 예전 부상의 흔적 */
    "past-injury",
    /** 나이에 비해 누적 피로가 크다 — `value`가 나이 */
    "age-load",
    /** 근육 밸런스 — 짚을 다른 사실이 없을 때 */
    "muscle-balance",
  ]),
  bodyPart: z.string().min(1).optional(),
  days: z.number().int().min(0).optional(),
  value: z.number().optional(),
});

export type MedicalConcern = z.infer<typeof MedicalConcernSchema>;

export const MedicalSchema = z.object({
  /** 검진일 — 합의 다음 날 이후 */
  onDate: DateString,
  status: z.enum(["scheduled", "passed", "flagged"]),
  /** 소견 카드 — `flagged`일 때만 */
  concern: MedicalConcernSchema.optional(),
  /** 감독이 소견을 알고도 밀어붙였는가 — 원장에 남는다 */
  overridden: z.boolean().optional(),
});

export type Medical = z.infer<typeof MedicalSchema>;
