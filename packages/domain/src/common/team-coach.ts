import { z } from "zod";
import { DateString } from "./date-string";

/**
 * **한 번의 재임** — 어느 벤치에, 언제부터 언제까지 (transfer.md §7 「감독 풀」).
 *
 * 끝난 재임만 이 꼴로 적힌다 — 지금 서 있는 자리는 `GameTeam.managerSince`가
 * 이미 답하므로 두 번 적지 않는다.
 */
export const ManagerSpellSchema = z.object({
  teamId: z.string().min(1),
  from: DateString,
  to: DateString,
});

export type ManagerSpell = z.infer<typeof ManagerSpellSchema>;

/**
 * **무직 감독 풀의 한 줄** — 자리를 잃은 사람 (transfer.md §7 「감독 풀」).
 *
 * 감독은 자리가 아니라 사람이다. 잘린 사람은 여기 앉아 다른 벤치가 부를 때까지
 * 기다리고, 다시 서면 **이름·사람됨·역량치·이력을 그대로 들고 간다**. 명부의
 * 실명 감독도 같은 줄에 앉는다 (people.md §2-1).
 */
export const ManagerPoolEntrySchema = z.object({
  /** 이름이 곧 `characterId`다 (people.md §1) */
  name: z.string().min(1),
  /** 명부의 실명 인물인가 — 실명 부채 장부가 세는 표식 (sources.md §7) */
  real: z.boolean().optional(),
  /** 전술 역량치 — 사람이 들고 다니는 값이라 다음 벤치가 이 값을 받는다 */
  rating: z.number().int().min(0).max(99),
  /** 마지막으로 서 있던 벤치 */
  lastTeamId: z.string().min(1),
  /** 자리를 잃은 날 — 상한이 넘칠 때 오래된 순으로 밀리는 기준이자 식은 기간의 기준 */
  sackedOn: DateString,
  /** 지난 재임들 — 오래된 것이 앞이다 */
  spells: z.array(ManagerSpellSchema),
});

export type ManagerPoolEntry = z.infer<typeof ManagerPoolEntrySchema>;
