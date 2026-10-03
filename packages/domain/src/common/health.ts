import { z } from "zod";
import { DateString } from "./date-string";

/**
 * 기록 테이블 — 선수·팀·일정에 딸린 이력.
 * 공통 패턴: "현재 상태 = 아직 닫히지 않은 row, 지난 일 = 그대로 이력".
 * 부상은 returnedOn=null, 정지·계약은 status=active가 현재를 뜻한다.
 */

// ── 부상 ──────────────────────────────────────────────
export const InjurySeveritySchema = z.enum(["minor", "moderate", "major"]);

export type InjurySeverity = z.infer<typeof InjurySeveritySchema>;

/**
 * 부상이 어디서 왔나 — **문장이 아니라 코드다** (player.md §5.3).
 *
 * `pre_appointment`는 감독이 오기 전의 이력이다. 시드가 심는 줄이라 경기도 훈련도
 * 아닌 제3의 출처이고, 코드가 없던 동안은 `note`에 그 뜻이 문장으로만 있었다.
 */
export const InjuryCauseSchema = z.enum(["match", "training", "other", "pre_appointment"]);

export const InjurySchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  /** 부위 — "햄스트링", "발목" 등 (서사 재료) */
  bodyPart: z.string().min(1),
  severity: InjurySeveritySchema,
  cause: InjuryCauseSchema,
  occurredOn: DateString,
  expectedReturn: DateString,
  /** null = 현재 부상 중. 기록되면 이력 (선수당 미복귀 최대 1건) */
  returnedOn: DateString.nullable(),
});

export type Injury = z.infer<typeof InjurySchema>;

/**
 * 심각도의 한글 라벨 — **원본은 이 표 하나다.**
 *
 * 화면·GM 조회·이력 한 줄이 같은 표를 읽는다. 두 벌을 두면 같은 부상이 스쿼드
 * 화면에서는 "경상", GM 대사에서는 "경미"가 되고, 감독은 그게 같은 부상인지 알 수
 * 없다 (player.md §5.3).
 */
export const INJURY_SEVERITY_KO: Record<InjurySeverity, string> = {
  minor: "경상",
  moderate: "중상",
  major: "장기",
};

/**
 * **부상 이력** — 감독이 관측할 수 있는 사실만 (player.md §5.3).
 *
 * ⚠️ **등급이 아니다.** 얼마나 위태로운지는 이력과 오늘의 몸을 함께 읽어야 나오는
 * 판단이고, 그 판단은 이야기를 쥔 쪽이 문장으로 한다 (overview.md §1 철칙 4).
 * 코어가 「높음」이라고 못 박으면 유리몸과 어제 복귀한 주전이 같은 말을 달고 선다.
 */
export interface InjuryHistory {
  /** 창(2시즌) 안의 부상 건수 */
  count: number;
  /** 창 안의 결장 일수 — 겹치는 구간은 한 번만 센다 */
  daysOut: number;
  /** 가장 최근 부상 — 없으면 `null` */
  last: { bodyPart: string; severity: InjurySeverity; daysAgo: number; open: boolean } | null;
}

/**
 * 이력 한 줄 — **화면·조회·GM이 같은 말을 쓰게 하는 자리.**
 *
 * 사실의 나열이지 문장이 아니다: 「위험하다」·「쉬게 하라」는 여기서 나오지 않는다.
 * 이력이 없으면 `null`이라 스물다섯 명의 명단이 「없음」으로 채워지지 않는다.
 */
export function injuryHistoryText(history: InjuryHistory): string | null {
  if (history.count === 0) return null;
  const parts = [`2시즌 ${history.count}건`, `결장 ${history.daysOut}일`];
  const last = history.last;
  if (last !== null) {
    parts.push(
      last.open
        ? `현재 ${last.bodyPart} ${INJURY_SEVERITY_KO[last.severity]}`
        : `최근 ${last.bodyPart} ${INJURY_SEVERITY_KO[last.severity]} · 복귀 ${last.daysAgo}일째`,
    );
  }
  return parts.join(" · ");
}

/**
 * 화면의 짧은 한 줄 — 건수와 결장 일수, 지금 다친 곳만. 최근 부상과 복귀 날수는
 * `injuryHistoryText`의 긴 줄이 툴팁으로 갖는다.
 */
export function injuryHistoryBrief(history: InjuryHistory): string | null {
  if (history.count === 0) return null;
  const parts = [`${history.count}회 · ${history.daysOut}일 결장`];
  const last = history.last;
  if (last?.open) parts.push(`현재 ${last.bodyPart} ${INJURY_SEVERITY_KO[last.severity]}`);
  return parts.join(" · ");
}

/**
 * **부상 위험 등급과 그 원인** — 세이브에 남지 않는 파생의 낱말 (player.md §5.3).
 *
 * 값을 만드는 것은 시뮬의 저울 하나뿐이다(`injuryRiskOf` — `packages/sim`이 경기의
 * `injuryWeight`에서 곧장 파생한다). 여기 있는 것은 **화면·조회·GM이 같은 말을
 * 쓰게 하는 표**다 — 등급의 라벨이 두 벌이면 같은 선수가 명단에서는 「높음」,
 * 대사에서는 「위험」이 된다 (`INJURY_SEVERITY_KO`와 같은 규칙).
 */
export type InjuryRiskGrade = "low" | "elevated" | "high";

/**
 * 저울을 들어 올린 항 — 네 코드가 곧 `injuryWeight`의 네 항이다.
 *
 * ⚠️ **`condition`은 오늘의 몸이고 `load`는 시즌의 몸이다** (player.md §5.3·§5.5).
 * 한 낱말로 접으면 감독이 "하루 쉬면 되는가"와 "몇 주를 빼야 하는가"를 가르지 못한다.
 */
export type InjuryRiskCause = "condition" | "load" | "proneness" | "strength";
