import { z } from "zod";
import { DateString } from "../common/date-string";
import { SQUAD_STATUSES } from "../common/squad-rules";
import {
  NegotiationKindSchema,
  NegotiationRoundSchema,
  MedicalSchema,
  type NegotiationKind,
} from "./negotiation";
import { TabledTermSchema } from "./deal-terms";
import { formatMoney } from "../common/money";

/** 테이블의 한 줄에 쓸 수 있는 글자 — 감독의 말도 상대의 답도 이 안이다 */
export const TABLE_LINE_MAX = 600;

/**
 * 상대의 태도 — **서사의 눈금이지 장부가 아니다** (transfer.md §12-2). 일어나는 것은
 * 인내가 바닥났을 때 코어가 정하고, 모델의 `leaving`은 그때만 선다.
 */
export const TABLE_STANCES = ["warming", "steady", "cooling", "leaving"] as const;

export const TableStanceSchema = z.enum(TABLE_STANCES);

export type TableStance = z.infer<typeof TableStanceSchema>;

export const TABLE_STANCE_KO: Record<TableStance, string> = {
  warming: "누그러진다",
  steady: "그대로다",
  cooling: "굳는다",
  leaving: "일어서려 한다",
};

/**
 * **테이블 건너편의 화자** — 값을 받는 구단(`club`)과 선수 쪽(`agent`)
 * (transfer.md §12-1). 열린 축의 주인이 정하므로 갈래마다 손으로 적지 않는다:
 * 이적료·분할·기한은 `club`이, 주급·연수·지위·등번호는 언제나 `agent`가 답한다.
 * 명부에 에이전트가 없으면 `agent` 자리에 선수 본인이 선다 — 화자가 사라지지는 않는다.
 */
export const TABLE_SPEAKERS = ["club", "agent"] as const;

export const TableSpeakerSchema = z.enum(TABLE_SPEAKERS);

export type TableSpeaker = z.infer<typeof TableSpeakerSchema>;

/**
 * 테이블의 한 줄 — 감독의 말(`us`) · 코어가 적은 사실(`ledger`). 상대의 답은 줄로
 * 남지 않는다 — 그 매체는 장면의 것이고 장부에는 판정과 라운드가 선다.
 * 장부 줄이 대화 사이에 서는 이유: 논거가 사실이었는지, 판정이 무엇으로 굳었는지는
 * 다음 답을 쓰는 쪽이 알아야 한다 — 대사에 묻히면 상대가 자기 답을 모른다.
 */
export const TableLineSchema = z.object({
  date: DateString,
  by: z.enum(["us", "ledger"]),
  text: z.string().min(1).max(TABLE_LINE_MAX),
});

export type TableLine = z.infer<typeof TableLineSchema>;

/**
 * **테이블** — 협상 위에 서는 마주 앉은 대화 (transfer.md §12-2).
 *
 * 오퍼와 답(`rounds`)은 그대로 협상의 것이고, 테이블은 그 사이의 말과 **인내**를 든다.
 * 인내는 되돌아오지 않는다 — 협상이 사는 동안 한 자리에서 깎이고, 0이면 상대가
 * 일어나 협상은 이번 창에서 결렬이다.
 */
export const NegotiationTableSchema = z.object({
  openedOn: DateString,
  /** 남은 인내 — 0이면 상대가 일어난다 */
  patience: z.number().int().min(0),
  /** 앉을 때의 인내 — 대리인 원형이 정한다 (`tablePatienceOf`) */
  patienceMax: z.number().int().min(1),
  lines: z.array(TableLineSchema),
});

export type NegotiationTable = z.infer<typeof NegotiationTableSchema>;

/**
 * **개인 조건 선합의** — 영입·임대에서 이적료 없이 먼저 굳히는 개인 조건
 * (→ docs/negotiation/transfer.md §12-3). 에이전트와 마주 앉아 주급·연수·지위를 먼저
 * 맞추고, 구단 값은 그 뒤 오퍼로 간다. 라운드가 아니다 — 이적료 없는 라운드는 관문
 * 하나가 빈 오퍼라, 여기 따로 선다.
 */
export const PersonalTermsSchema = z.object({
  weeklyWage: z.number().min(0),
  contractYears: z.number().int().min(1).max(6),
  squadStatus: z.enum(SQUAD_STATUSES).optional(),
  proposedOn: DateString,
  /** 선수 쪽이 답할 날 — 마주 앉으면 오늘로 당겨진다 (§12-2) */
  respondsOn: DateString,
  /** 선수 쪽이 받아들인 날 — 그 뒤의 오퍼는 이 값을 그대로 싣고 선수 관문은 합의로 굳는다 */
  agreedOn: DateString.optional(),
  /** 선수 쪽이 되부른 개인 조건 — 감독이 그대로 받으면 그 값으로 다시 제안된다 */
  counter: z
    .object({
      weeklyWage: z.number().min(0),
      contractYears: z.number().int().min(1).max(6),
      squadStatus: z.enum(SQUAD_STATUSES).optional(),
      on: DateString,
      note: z.string().optional(),
    })
    .optional(),
});

export type PersonalTerms = z.infer<typeof PersonalTermsSchema>;

/**
 * **위임의 한도** — 감독이 부른 값만 선다 (→ docs/negotiation/transfer.md §12-4).
 *
 * 비운 축은 한도가 없는 축이고, 전부 비면 코어의 합법 범위가 그대로 한도다
 * (`counterBoundsOf`). 상한인가 하한인가는 갈래가 정한다 — 내보내는 딜의 값은 하한이고
 * 그 밖은 상한이다. 방침과 건별이 같은 꼴을 쓴다.
 */
export const MandateLimitSchema = z.object({
  /** 이적료·임대료·정산금 */
  fee: z.number().min(0).optional(),
  weeklyWage: z.number().min(0).optional(),
  contractYears: z.number().int().min(1).max(6).optional(),
});

export type MandateLimit = z.infer<typeof MandateLimitSchema>;

/**
 * **갈래 하나의 위임 방침** — 「재계약은 앞으로 단장이 알아서」 (transfer.md §12-4).
 *
 * 갈래마다 한 줄이고, 다시 말하면 덮어쓴다. 방침이 있으면 그 갈래의 열린 협상을 단장이
 * 맡고, 재계약은 만료가 다가온 선수의 자리를 **열기까지** 한다.
 */
export const DelegationSchema = z.object({
  kind: NegotiationKindSchema,
  limit: MandateLimitSchema.optional(),
  since: DateString,
});

export type Delegation = z.infer<typeof DelegationSchema>;

export const NegotiationSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  kind: NegotiationKindSchema,
  /** renew·release는 null — 상대가 선수 본인이다 (`isPlayerDeal`) */
  counterpartTeamId: z.string().min(1).nullable(),
  windowId: z.string().min(1).nullable(),
  openedOn: DateString,
  expiresOn: DateString,
  status: z.enum(["open", "agreed", "rejected", "expired", "completed"]),
  rounds: z.array(NegotiationRoundSchema),
  /**
   * 이 협상에서 **사실로 확인된** 설득 논거. 같은 이야기를 반복해도 다시
   * 쳐주지 않기 위해 누적한다 (persuasion.ts).
   */
  pitched: z.array(z.string().min(1).max(500)),
  /**
   * 합의 뒤 잡힌 메디컬. 재계약·해지는 갖지 않는다 — 팀을 옮기지 않으므로 검진할
   * 일이 없다.
   */
  medical: MedicalSchema.optional(),
  /**
   * **사전 계약인가** — 이적료 없이 다음 7월 1일 합류를 약속하는 영입
   * (→ docs/negotiation/transfer.md §1-4). 갈래는 여전히 `buy`다: 사전 계약은
   * `NegotiationKind`의 새 갈래가 아니라 **영입 갈래의 조건**이라, 관문이 하나로
   * 줄고 확정이 `pending` 계약을 쓴다는 것만 다르다.
   *
   * 오퍼를 넣는 날 조건(잔여 ≤ `PRECONTRACT_DAYS` · 이적료 0)으로 정해져 협상에
   * 굳는다 — 라운드마다 다시 파생하면 흥정 중에 창이 닫히는 날 같은 테이블이
   * 중간부터 다른 갈래가 된다.
   */
  precontract: z.boolean(),
  /**
   * **테이블 둘** — 구단 쪽(단장)과 선수 쪽(에이전트)이 따로 앉는다 (transfer.md §12-2).
   * 인내도 줄도 자리마다 따로다. 앉은 자리만 선다.
   */
  tables: z
    .object({
      club: NegotiationTableSchema.optional(),
      agent: NegotiationTableSchema.optional(),
    })
    .optional(),
  /**
   * **구단이 이적료에 합의한 자리** — 개인 조건이 아직 굳지 않은 채 구단 테이블에서
   * 수락이 났을 때 선다 (transfer.md §12-2). 개인 조건이 굳는 날 협상이 `agreed`가 된다.
   * 개인 조건이 먼저 굳은 협상에는 서지 않는다 — 수락이 곧 합의다.
   */
  feeAgreed: z
    .object({
      fee: z.number().min(0),
      paymentYears: z.number().int().min(1).optional(),
      on: DateString,
    })
    .optional(),
  /**
   * **조건서** — 이 협상에서 오간 조건 전부 (transfer.md §12-3). 감독이 올린 것, 상대가
   * 부른 것, 그 답이 한 장부에 선다. 확인된 논거(`pitched`)와 같은 결이라 협상이 끝나면
   * 함께 사라지고, 합의되는 순간 계약과 약속 장부로 흩어진다.
   */
  terms: z.array(TabledTermSchema),
  /**
   * **바이아웃 조항이 발동한 협상인가** — 조항 금액 이상의 오퍼가 들어와 구단이 답할 자리가
   * 없는 매각이다 (transfer.md §12-3). 감독이 거절도 철회도 못 하고, 남은 것은 선수의
   * 결정과 메디컬뿐이다.
   */
  buyout: z.boolean(),
  /** 개인 조건 선합의 — 영입·임대에서만 선다 (transfer.md §12-3) */
  personal: PersonalTermsSchema.optional(),
  /**
   * **단장이 대신 앉는 협상인가** — 세 상태다 (transfer.md §12-4).
   *
   * | 값     | 뜻                                                        |
   * | ------ | --------------------------------------------------------- |
   * | 없음   | 방침을 따른다 — 그 갈래에 방침이 있으면 단장이 맡는다      |
   * | 값     | 이 건은 단장이 쥔다. 객체가 곧 한도이고, 비면 한도가 없다 |
   * | `null` | 감독이 직접 한다 — 방침이 있어도 이 건만 빠진다            |
   *
   * `null`이 따로 있는 이유는 방침 때문이다. 단장이 손을 뗀 자리를 비워 두면 다음 날
   * 방침이 같은 협상을 다시 맡아 영원히 같은 자리를 돈다.
   */
  mandate: MandateLimitSchema.nullable().optional(),
});

export type Negotiation = z.infer<typeof NegotiationSchema>;

/**
 * **지금 단장이 쥐고 있는 협상인가** — 편지도 주의 줄도 기한 당일의 멈춤도 이 하나를 읽는다
 * (transfer.md §12-4). 셋이 각자 재면 편지는 서고 주의 줄은 비는 협상이 생긴다.
 *
 * 방침은 여기 없다 — tick이 방침으로 맡을 때 협상의 칸에 적어 두므로(`runMandates`),
 * 읽는 자리는 언제나 칸 하나만 본다.
 */
export function isMandated(negotiation: Pick<Negotiation, "status" | "mandate">): boolean {
  return (
    negotiation.mandate !== undefined &&
    negotiation.mandate !== null &&
    (negotiation.status === "open" || negotiation.status === "agreed")
  );
}

/**
 * 한도 한 줄 — 카드와 요약 줄이 같은 말을 쓴다 (transfer.md §12-4).
 * 「이적료 £40.0M · 주급 £150k까지」 · 「이적료 £20.0M 이상」. 한도가 없으면 「한도 없이」다.
 */
export function mandateLimitText(limit: MandateLimit, kind: NegotiationKind): string {
  const outgoing = kind === "sell" || kind === "loan_out";
  const money =
    kind === "release" ? "정산금" : kind === "loan" || kind === "loan_out" ? "임대료" : "이적료";
  const parts = [
    ...(limit.fee === undefined ? [] : [`${money} ${formatMoney(limit.fee)}`]),
    ...(limit.weeklyWage === undefined ? [] : [`주급 ${formatMoney(limit.weeklyWage)}`]),
    ...(limit.contractYears === undefined ? [] : [`${limit.contractYears}년`]),
  ];
  if (parts.length === 0) return "한도 없이";
  return `${parts.join(" · ")}${outgoing ? " 이상" : "까지"}`;
}
