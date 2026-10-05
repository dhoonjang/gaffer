import { z } from "zod";
import { MATCH_MINUTE_MAX } from "./match-events";
import { DateString } from "../core/date-string";
import { type MatchStage, stageDepth } from "./match-records";

// ── 징계 ──────────────────────────────────────────────
export const BookingSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 발생 경기 */
  matchId: z.string().min(1),
  season: z.number().int(),
  /**
   * **어느 대회의 카드인가** — 누적은 대회 안에서만 쌓인다 (match.md §6).
   *
   * `season`이 이미 여기 있는 것과 같은 이유로 경기에서 파생하지 않고 적는다:
   * 누적을 세는 자리가 경기 원장을 되짚으면 카드 한 장마다 그 시즌의 수천 경기를
   * 훑는다.
   */
  competitionId: z.string().min(1),
  card: z.enum(["yellow", "red"]),
  minute: z.number().int().min(0).max(MATCH_MINUTE_MAX),
});

/**
 * 정지가 **어디까지 미치는가** (match.md §6).
 *
 * - `competition` — 그 대회뿐이다. 경고 누적 정지는 어느 나라에서도 여기다.
 * - `jurisdiction` — 그 대회가 속한 협회의 모든 대회. 잉글랜드의 퇴장 정지가
 *   리그·FA컵·카라바오컵에 다 걸리고, 대항전의 퇴장 정지가 UCL·UEL·UECL에 걸린다.
 */
const SuspensionScopeSchema = z.enum(["competition", "jurisdiction"]);

type SuspensionScope = z.infer<typeof SuspensionScopeSchema>;

export const SuspensionSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** yellows = 그 대회의 누적 경고, red = 즉시 퇴장 */
  cause: z.enum(["yellows", "red", "other"]),
  /** 어느 대회에서 왔는가 — `scope`와 함께 이 정지가 걸리는 경기를 정한다 */
  competitionId: z.string().min(1),
  scope: SuspensionScopeSchema,
  issuedOn: DateString,
  lengthMatches: z.number().int().min(1),
  /** 소화 경기 수 — 잔여는 lengthMatches - served로 파생 */
  served: z.number().int().min(0),
  status: z.enum(["active", "done"]),
});

export type Suspension = z.infer<typeof SuspensionSchema>;

/**
 * **유럽 대부분의 눈금** — 5장마다 1경기 (match.md §6).
 *
 * 대회마다의 표는 `discipline-catalog.ts`가 갖고, 그중 5장짜리 규정들(라리가·
 * 분데스리가·리그 1과 네 나라 국내 컵)이 이 한 값을 나눠 쓴다. 표에 없는 대회는
 * 기본값을 갖지 않는다 — 규정이 없으면 카드가 정지를 부르지 않는다(`disciplineOf`).
 */
export const YELLOWS_PER_SUSPENSION = 5;

/**
 * 누적 경고의 한 눈금 — **몇 장째에 몇 경기인가**, 그리고 언제까지인가.
 *
 * `by`는 잉글랜드에만 있는 매치위크 문턱이다: FA 규정의 5장은 "첫 19경기 안"이라
 * 20라운드에 닿은 5장은 정지가 아니다. 리그의 `round`가 곧 매치위크라 그 수로 잰다.
 */
interface YellowBanStep {
  /** 이 장수에 닿으면 */
  at: number;
  /** 몇 경기 정지인가 */
  matches: number;
  /** 그 대회의 몇 번째 라운드까지 닿아야 하는가 — 없으면 시즌 내내 */
  by?: number;
}

/**
 * 한 대회의 징계 규정 (match.md §6 · season/competition.md §1).
 *
 * **값은 실제 규정이다.** 눈금은 대회의 것이고 퇴장 범위는 협회의 것이라, 표를
 * 여는 열쇠는 대회 id지만 `jurisdiction`은 한 나라의 대회들이 나눠 갖는다.
 */
export interface DisciplineRule {
  /** 관할 — 퇴장 정지가 `jurisdiction`이면 이 키를 나눠 갖는 대회 전부에 걸린다 */
  jurisdiction: string;
  /** 눈금 — `at` 오름차순 */
  steps: readonly YellowBanStep[];
  /**
   * 마지막 눈금 뒤로 되풀이되는 주기(장). 없으면 그 뒤로는 누적 정지가 없다
   * (프리미어리그는 20장이 끝이고, 세리에 A는 19장부터 매 장이라 1이다).
   */
  cycle: number | null;
  /**
   * 이 단계가 끝나면 그 대회의 누적이 지워진다 — UEFA와 잉글랜드 두 컵의 8강.
   * **이미 발부된 정지는 지우지 않는다**: 8강에서 걸린 정지는 4강에서 소화된다.
   */
  amnestyAfter?: MatchStage;
  /** 퇴장 정지가 그 대회뿐인가, 관할 전체인가 */
  redScope: SuspensionScope;
}

/**
 * 방금 받은 장까지 세고 나서 **이 카드가 정지를 부르는가** — 부르면 정지 경기 수.
 *
 * 사면 단계보다 깊은 경기에서는 아무것도 부르지 않는다: 그 경기까지의 카드는 전부
 * 사면 앞의 것이므로 카운터를 지운 것과 셈이 같다 (match.md §6).
 */
export function yellowBanMatches(
  rule: DisciplineRule,
  total: number,
  at: { round: number; stage: MatchStage },
): number | null {
  if (total <= 0) return null;
  if (rule.amnestyAfter && stageDepth(at.stage) > stageDepth(rule.amnestyAfter)) return null;
  const step = rule.steps.find((s) => s.at === total);
  if (step) return step.by !== undefined && at.round > step.by ? null : step.matches;
  const last = rule.steps[rule.steps.length - 1];
  if (!last || rule.cycle === null || total < last.at) return null;
  return (total - last.at) % rule.cycle === 0 ? last.matches : null;
}
