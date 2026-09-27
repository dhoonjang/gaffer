import { z } from "zod";
import { DateString } from "./date-string";
import { SQUAD_NUMBER_MAX } from "./player";

// ── 약속 — 감독의 말이 장부에 서는 자리 ───────────────
/**
 * 감독이 한 약속의 **갈래** (→ docs/story/people.md §5-2).
 *
 * 무슨 말로 약속했는지는 장면의 것이다. 코어가 드는 것은 갈래·기한·상태뿐이고,
 * 이행 판정도 전부 장부에서 나온다 — 어느 자리에서도 문장을 읽지 않는다.
 */
export const PROMISE_KINDS = [
  "minutes",
  "transfer",
  "renewal",
  "captain",
  "number",
  "signing",
] as const;

export type PromiseKind = (typeof PROMISE_KINDS)[number];

export const PROMISE_KIND_KO: Record<PromiseKind, string> = {
  minutes: "출전",
  transfer: "이적 허용",
  renewal: "재계약",
  captain: "주장",
  number: "등번호",
  signing: "추가 영입",
};

/**
 * 갈래가 **무슨 약속인가** — 감독의 말을 갈래로 옮기는 모델이 읽는 표다
 * (→ docs/story/people.md §5-2의 「감독이 한 말」 칸).
 *
 * 낱말표(`PROMISE_KIND_KO`)는 장부 줄과 화면이 쓰는 이름이라 짧고, 그것만으로는
 * 갈래가 갈리지 않는다: 「출전」은 교체 출전까지 품지만 기한 날 장부가 재는 것은
 * **선발 비율**이고(`verdictOf` — engine/squad/promises.ts), 「재계약」이 이행으로
 * 서는 것은 협상이 **열렸을** 때다.
 *
 * 주석이 아니라 데이터인 이유는 설득 논거와 같다 — 도구 스키마는 JSDoc을 싣지
 * 않으므로(`toToolSchema`) 주석에 적힌 뜻은 모델에게 닿지 않는다.
 */
export const PROMISE_KIND_MEANING: Record<PromiseKind, string> = {
  minutes: "주전으로 세우겠다",
  transfer: "내보내 주겠다",
  renewal: "재계약 협상을 열겠다",
  captain: "주장을 맡기겠다",
  number: "그 등번호를 주겠다",
  signing: "그 포지션에 선수를 하나 더 데려오겠다",
};

/**
 * 약속 한 줄 — **`Promise`가 아니라 `ManagerPromise`다.** 전역 `Promise`를 가리는
 * 타입 이름은 이 패키지를 import 하는 모든 파일에서 비동기 코드의 뜻을 바꾼다.
 */
export const ManagerPromiseSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  kind: z.enum(PROMISE_KINDS),
  madeOn: DateString,
  /** 이 날 장부가 판정한다 — 하루뿐이다 */
  dueOn: DateString,
  /** `open` = 아직 기한 전. 판정이 끝나면 이력으로 남는다 */
  status: z.enum(["open", "kept", "broken"]),
  /**
   * **`number` 약속만 든다** — 어느 번호를 주기로 했는가 (people.md §5-2).
   *
   * 다른 넷은 갈래가 곧 약속이라 장부에 숫자가 설 자리가 없지만, "다음 시즌엔
   * 10번"은 **번호가 곧 약속의 내용**이라 이것 없이는 이행을 판정할 자가 없다.
   */
  number: z.number().int().min(1).max(SQUAD_NUMBER_MAX).optional(),
  /**
   * **`signing` 약속만 든다** — 어느 자리에 선수를 데려오기로 했는가 (포지션 코드).
   * 번호와 같은 이유로 갈래 이름만으로는 이행을 판정할 자가 없다.
   */
  position: z.string().min(1).optional(),
});

export type ManagerPromise = z.infer<typeof ManagerPromiseSchema>;

/**
 * 정착 이벤트 — **감독이 새 영입에게 한 일**의 원장 (settling.ts).
 *
 * 정착 진행도는 원래 전부 파생이다(출전 명단·훈련 일정). 그런데 면담·팀토크는
 * 어디에도 기록이 남지 않는 사실이라 파생할 원본이 없다 — 그래서 이것만 원장에
 * 남긴다. 감독이 무엇을 해서 이 선수가 녹아들었는지가 근거로 남는다.
 */
export const SettlingEventSchema = z.object({
  gamePlayerId: z.string().min(1),
  date: DateString,
  kind: z.enum(["talk", "team_talk", "captain", "incident"]),
  /** 쌓인(또는 깎인) 크레딧 */
  credit: z.number(),
  note: z.string().optional(),
});

export type SettlingEvent = z.infer<typeof SettlingEventSchema>;

/**
 * 이적 리스트 등재 — **감독이 "이 선수는 팔겠다"고 시장에 알린 사실.**
 *
 * 등재는 **호가와 함께** 한다. 값을 부르는 것이 감독의 손잡이이기 때문이다 —
 * 싸게 내놓으면 금방 팔리고, 비싸게 부르면 아무도 안 온다.
 */
export const TransferListingSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 감독이 부르는 값 */
  askingPrice: z.number().min(0),
  listedOn: DateString,
  note: z.string().max(160).optional(),
});

export type TransferListing = z.infer<typeof TransferListingSchema>;

/**
 * **이적 요청의 사유** — 선수가 나가겠다고 말한 이유
 * (→ docs/negotiation/transfer.md §1-1).
 *
 * 셋이 두 곳에서 온다: `grievance`는 방치된 불만이 다가옴 사다리의 꼭대기까지 오른
 * 것이고(docs/story/people.md §8), 나머지 둘은 **시장**이 세운다 — 감독이 값이 붙은
 * 오퍼를 같은 창에서 두 번 막았거나(`blocked-move`), 갈 곳 많은 젊은 선수에게
 * 우리보다 큰 구단의 관심이 붙었거나(`bigger-club`).
 */
export const TRANSFER_REQUEST_REASONS = ["grievance", "blocked-move", "bigger-club"] as const;

export type TransferRequestReason = (typeof TRANSFER_REQUEST_REASONS)[number];

export const TRANSFER_REQUEST_REASON_KO: Record<TransferRequestReason, string> = {
  grievance: "쌓인 불만",
  "blocked-move": "막힌 이적",
  "bigger-club": "더 큰 무대",
};

/**
 * 이적 요청 한 줄 — **선수가 감독에게 하는 가장 큰 말이 서는 자리.**
 *
 * 코어가 드는 것은 사유·날짜·감독의 답뿐이다. 무슨 말로 요청했는지는 장면의
 * 것이고, 요청이 걷히는가는 전부 다른 장부에서 파생한다(불만 줄 · 이적창).
 *
 * **한 선수에게 서 있는 요청은 하나다** — 사유가 셋이라 두 줄이 설 수 있는데,
 * 그러면 감독의 답 하나가 다른 줄을 답하지 않은 채로 남긴다
 * (→ docs/negotiation/transfer.md §11).
 */
export const TransferRequestSchema = z.object({
  gamePlayerId: z.string().min(1),
  since: DateString,
  reason: z.enum(TRANSFER_REQUEST_REASONS),
  /** 감독이 답한 날 — 없으면 아직 책상 위에 있다 */
  answeredOn: DateString.optional(),
  answer: z.enum(["accept", "refuse"]).optional(),
  /**
   * 회견이 이 요청을 실어 간 날 — 같은 사실을 두 번 묻지 않게 하는 자다
   * (`pressLeaks`가 소비되는 것과 같은 결). **감독이 답하면 비워진다** — 요청이
   * 선 날과 답한 날은 다른 사실이라 회견이 둘 다 싣는다.
   */
  pressedOn: DateString.optional(),
});

export type TransferRequest = z.infer<typeof TransferRequestSchema>;

/**
 * **관심의 단계** — 오퍼 앞에 서는 사다리 세 칸
 * (→ docs/negotiation/transfer.md §1-2).
 *
 * 보는 것에는 창이 필요 없지만 묻는 것과 부르는 것에는 필요하다 — `watching`은
 * 아무 날에나 서고, 위 두 칸은 그 구단 협회의 창이 열린 동안에만 오른다.
 */
export const INTEREST_STAGES = ["watching", "enquired", "bidding"] as const;

export type InterestStage = (typeof INTEREST_STAGES)[number];

export const INTEREST_STAGE_KO: Record<InterestStage, string> = {
  watching: "주시",
  enquired: "문의",
  bidding: "입찰 임박",
};

/** 사다리에서 이 칸이 몇 번째인가 — 견주는 자리가 여럿이라 눈금을 한 벌로 둔다 */
export function interestStageRank(stage: InterestStage): number {
  return INTEREST_STAGES.indexOf(stage);
}

/**
 * **타 구단의 관심 한 줄** — 오퍼가 오기 전에 세계가 내는 소리
 * (→ docs/negotiation/transfer.md §1-2).
 *
 * 코어가 드는 것은 구단·선수·날짜·단계뿐이다. "레알이 그를 보고 있다"는 문장은
 * GM과 기자의 것이고, 이 줄은 그 문장이 딛는 사실이다.
 *
 * **한 구단 × 한 선수에 한 줄이다** — 두 줄이 서면 회견도 근황도 같은 사실을 두 번
 * 말하고, 딜 확률의 「다른 구단의 관심」 항이 한 구단을 둘로 센다
 * (→ docs/negotiation/transfer.md §11).
 */
export const InterestSchema = z.object({
  /** 보고 있는 구단 (`TEAM.id`) */
  teamId: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 이 관심이 처음 선 날 */
  since: DateString,
  stage: z.enum(INTEREST_STAGES),
  /** 마지막으로 칸이 움직인 날 — 여기서 다음 칸까지의 최소 체류와 노화를 센다 */
  lastMovedOn: DateString,
  /**
   * 회견이 이 관심을 실어 간 날 — 같은 사실을 두 번 묻지 않게 하는 자다
   * (`transferRequests`와 같은 규약). **칸이 오르면 비워진다** — 「보고 있다」와
   * 「값을 부를 참이다」는 다른 사실이라 회견이 둘 다 싣는다.
   */
  pressedOn: DateString.optional(),
});

export type Interest = z.infer<typeof InterestSchema>;

/**
 * **경쟁 입찰 한 줄** — 관심이 값을 부른 사실
 * (→ docs/negotiation/transfer.md §1-2).
 *
 * 관심(`Interest`)은 「그 구단이 보고 있다」이고 이 줄은 「그 구단이 값을 불렀다」다.
 * 둘을 한 표에 접을 수 없는 이유는 사다리의 칸이 협상 밖의 사실인 데 비해 이 줄은
 * **우리 협상 테이블 위에서만 서고 협상이 끝나면 걷히기** 때문이다.
 *
 * 이 줄이 없으면 "다른 구단이 있다"는 상대의 말은 지어낸 것이다 — 코어가 사실로
 * 세워야 모델이 그것을 말할 수 있다 (overview.md §1 철칙 4).
 */
export const CompetingBidSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 값을 부른 구단 — **그 선수에게 이미 관심이 서 있는 구단**이다 (`TEAM.id`) */
  teamId: z.string().min(1),
  /** 그 사실이 선 날 */
  date: DateString,
  /** 이 한 줄이 호가를 올리는 비율 — 누적 상한은 `COUNTER_CEILING`이다 */
  lift: z.number().min(1),
});

export type CompetingBid = z.infer<typeof CompetingBidSchema>;

/**
 * 개인 훈련 프로그램 — **팀 훈련 위에 한 선수만 겨냥해 얹는 것.**
 *
 * `set_training`은 팀 전체 메뉴라 "이 선수의 결정력을 손보자", "풀백을 센터백으로
 * 전향시키자" 같은 판단이 표현되지 않았다. 축(`axis`)도 자리(`position`)도 훈련
 * 결산의 입력이고, 자리는 결산 한 번에 `POSITION_TRAIN_MAX`까지만 오른다 —
 * 실전보다 느리게.
 *
 * **2군에는 축만 걸린다** — 결산이 없는 층이라 축은 월간 성장의 겨냥으로 넘어가고
 * 자리는 갈 문이 없다 (→ docs/common/season.md §2).
 */
export const PlayerTrainingSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 겨냥한 능력치 축 — 훈련 결산에 실린다 */
  axis: z.string().min(1).optional(),
  /** 배우는 자리 — 훈련 결산이 적응도를 조금씩 올린다 */
  position: z.string().min(1).optional(),
  /**
   * **감독이 이 선수를 훈련에서 뺀 기간** — 누적 피로의 유일한 손잡이
   * (→ docs/common/season.md §4 · docs/common/player.md §5.5).
   *
   * `until`은 **그날까지 포함**이다. 축·자리와 한 행에 사는 이유는 대상이 같아서고,
   * 서로를 지우지 않는다 — 쉬는 것과 무엇을 배우는지는 다른 지시다. 기간이 지나면
   * 저절로 지나가므로 거둘 일이 대개 없다. 없으면 쉬는 기간이 아니다.
   */
  rest: z.object({ until: DateString }).optional(),
  since: DateString,
});

export type PlayerTraining = z.infer<typeof PlayerTrainingSchema>;
