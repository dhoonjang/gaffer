import { z } from "zod";
import { DateString } from "./date-string";

/**
 * 라커룸 불만의 **사유 코드** — 문장이 아니다 (people.md §5).
 *
 * 문장으로 적으면 그것을 읽는 자리마다 `"${note}에 불만이 쌓여 있다"` 같은 짜깁기가
 * 생긴다. 코드로 두면 화면 문구를 고치는 것만으로 지난 불만까지 함께 고쳐진다.
 */
export const PLAYER_ISSUE_REASONS = [
  "minutes",
  "losing-run",
  "early-return",
  /** 2군에 내려간 채 방치된 기간 — 기간은 `PlayerState.demotedOn`이 갖는다 */
  "demotion",
  /** 주 포지션 묶음 밖 선발이 이어진다 — 연속 경기는 `PlayerState.outOfPositionRun` */
  "out-of-position",
  /** 감독이 한 약속의 기한이 지났는데 장부가 이행을 못 찾았다 — 약속은 `state.promises` */
  "promise",
  /**
   * 감독이 그의 등번호를 동료에게 넘겼다 — 날이 아니라 **한 번의 결정**이 세운다
   * . `count`가 그가 잃은 번호다 (people.md §5).
   */
  "number",
  /**
   * 누적 피로가 「과부하」에 머문 날이 그 사람의 문턱을 넘었다 — 기간은
   * `PlayerState.overloadedOn`이 갖는다 (people.md §5 · player.md §5.5).
   */
  "overload",
] as const;

export type PlayerIssueReason = (typeof PLAYER_ISSUE_REASONS)[number];

export const PlayerIssueSchema = z.object({
  gamePlayerId: z.string().min(1),
  kind: z.enum(["unhappy"]),
  reason: z.enum(PLAYER_ISSUE_REASONS),
  /**
   * 사유에 딸린 수치 — `losing-run`이면 연패 수, `out-of-position`이면 연속 경기 수,
   * `minutes`면 그 지위에 **모자란 선발 수**, `number`면 **그가 잃은 번호**,
   * `overload`면 **과부하 며칠째**다 (people.md §5). 수치가 없는 사유엔 없다.
   */
  count: z.number().int().min(1).optional(),
  since: DateString,
});

export type PlayerIssue = z.infer<typeof PlayerIssueSchema>;
