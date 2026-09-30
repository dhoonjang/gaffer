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
export const PROMISE_KINDS = ["minutes", "captain", "number"] as const;

export type PromiseKind = (typeof PROMISE_KINDS)[number];

export const PROMISE_KIND_KO: Record<PromiseKind, string> = {
  minutes: "출전",
  captain: "주장",
  number: "등번호",
};

/**
 * 갈래가 **무슨 약속인가** — 감독의 말을 갈래로 옮기는 모델이 읽는 표다
 * (→ docs/story/people.md §5-2의 「감독이 한 말」 칸).
 *
 * 낱말표(`PROMISE_KIND_KO`)는 장부 줄과 화면이 쓰는 이름이라 짧고, 그것만으로는
 * 갈래가 갈리지 않는다: 「출전」은 교체 출전까지 품지만 기한 날 장부가 재는 것은
 * **선발 비율**이다(`verdictOf` — engine/common/players/promises.ts).
 *
 * 주석이 아니라 데이터인 이유는 설득 논거와 같다 — 도구 스키마는 JSDoc을 싣지
 * 않으므로(`toToolSchema`) 주석에 적힌 뜻은 모델에게 닿지 않는다.
 */
export const PROMISE_KIND_MEANING: Record<PromiseKind, string> = {
  minutes: "주전으로 세우겠다",
  captain: "주장을 맡기겠다",
  number: "그 등번호를 주겠다",
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
   * 다른 갈래는 갈래가 곧 약속이라 장부에 숫자가 설 자리가 없지만, "다음 시즌엔
   * 10번"은 **번호가 곧 약속의 내용**이라 이것 없이는 이행을 판정할 자가 없다.
   */
  number: z.number().int().min(1).max(SQUAD_NUMBER_MAX).optional(),
});

export type ManagerPromise = z.infer<typeof ManagerPromiseSchema>;

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
