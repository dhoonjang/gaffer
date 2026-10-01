import { z } from "zod";
import { DateString } from "../common/date-string";

/**
 * 일정 축 — 경기·훈련·이적창·컵 추첨이 날짜+시간의 단일 축에 등록된다.
 * 언제(when)는 SCHEDULE_ENTRY, 무엇(what)은 type별 대상(MATCH / TRAINING_SESSION /
 * TRANSFER_WINDOW)이 갖는다. 훈련 반복 규칙 테이블은 없다 — 명령이 엔트리를 직접 생성한다.
 */

export const ScheduleTypeSchema = z.enum([
  "match",
  "training",
  "window-open",
  "window-close",
  /**
   * 컵 대진 추첨 — 다음 라운드의 상대가 정해지는 날. 별도 엔티티를 두지 않고
   * `refId`가 `"<competitionId>:<stage>"`를 가리킨다 (예: `facup:r16`).
   * 추첨 자체가 곧 편성이므로 이 엔트리가 **아직 안 열린 라운드**의 표식이기도 하다.
   */
  "draw",
  /**
   * 컵 라운드 예정일 — **상대는 미정이지만 날짜는 이미 공표된** 자리.
   * 실제 협회도 시즌 전에 전 라운드 날짜를 발표한다("3라운드는 1월 10일 주말").
   * 추첨으로 대진이 확정되면 이 엔트리는 사라지고 진짜 경기가 그 자리를 잇는다.
   * `refId`는 추첨과 같은 `"<competitionId>:<stage>"`.
   */
  "cup-round",
]);

export type ScheduleType = z.infer<typeof ScheduleTypeSchema>;

export const ScheduleEntrySchema = z.object({
  id: z.string().min(1),
  date: DateString,
  /** HH:mm — 표시·정렬 기준. 같은 날은 시간 순으로 처리된다 */
  time: z.string().regex(/^\d{2}:\d{2}$/),
  type: ScheduleTypeSchema,
  /** type별 대상 id (match→Match, training→TrainingSession, window-*→TransferWindow, draw→"컵id:단계") */
  refId: z.string().min(1),
  /** 유저 팀 일정인가 — 훈련은 항상 유저 팀, 경기·추첨은 유저 팀 관련 여부 */
  teamId: z.string().min(1).nullable(),
  status: z.enum(["scheduled", "done"]),
  /**
   * **훈련 결산이 이 세션을 이미 반영했다** — `status: "done"`은 코어가 하루를 소화한
   * 표식이고, 이것은 그 위에 LLM 판정이 얹혔다는 표식이다. 둘은 다른 시점에 선다:
   * 결산은 tick보다 뒤에 오고 실패하면 아예 오지 않는다.
   *
   * 결산 도구는 한 턴에 여러 번 불릴 수 있어(agents.md §4) 이 표식이 없으면
   * 적응도·능력치가 호출 횟수만큼 쌓인다. 훈련 엔트리에만, 결산이 지난 뒤에만 선다.
   */
  settled: z.boolean().optional(),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;
