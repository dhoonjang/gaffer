import { z } from "zod";
import { DateString } from "../common/date-string";

// ── 스카우팅 ──────────────────────────────────────────
/**
 * 스카우트 파견 (SCOUT_REPORT) — **선수 단위**. 완료되면 안개가 좁혀진다: 관측형은
 * ±1, 분석형은 ±3이 남는다(정답 공개가 아니다). 잠재력은 끝까지 폭으로만 안다 —
 * 성장 여력은 스카우트도 단정하지 못한다는 규약. 지식 수준 파생은
 * engine/squad/scouting.ts 참고.
 */
export const ScoutReportSchema = z.object({
  id: z.string().min(1),
  gamePlayerId: z.string().min(1),
  requestedOn: DateString,
  /** 이 날짜에 도달하면 tick이 완료 처리한다 */
  dueOn: DateString,
  /** null = 파견 중 */
  completedOn: DateString.nullable(),
});

export type ScoutReport = z.infer<typeof ScoutReportSchema>;

/** 스카우트 파견 소요 일수 · 동시 파견 한도 (잠정 수치) */
export const SCOUT_DAYS = 7;

export const SCOUT_CONCURRENT_LIMIT = 3;

/**
 * **한도에 막혀 못 나간 파견 요청** — 감독이 지목했으나 동시 한도가 차서 나가지
 * 못한 이름. 반려는 호출 결과 문구로 그 턴에 한 번 나가고 끝이라, 남겨 두지
 * 않으면 다음 턴의 모델에는 읽을 자리가 없다 (player.md §9.4).
 *
 * 파견이 아니므로 `ScoutReport`가 아니다 — 여기 있는 이름은 아직 아무 데도 안
 * 갔고, `completedOn === null`을 세는 모든 곳이 그것을 파견 중으로 읽으면 안 된다.
 */
export const DeferredScoutSchema = z.object({
  gamePlayerId: z.string().min(1),
  requestedOn: DateString,
});

export type DeferredScout = z.infer<typeof DeferredScoutSchema>;

/**
 * 나이 조건이 설 수 있는 범위 — 검색·임무가 같은 자를 쓴다. 프로 등록이 열리는
 * 나이와 현역이 끝나는 나이의 바깥에서는 조건이 뜻을 잃는다.
 */
export const SEARCH_MIN_AGE = 15;

export const SEARCH_MAX_AGE = 45;

/**
 * **스카우트 임무** — 이름이 아니라 **조건 한 벌**을 주고 내보내는 파견
 * (→ docs/common/player.md §9.4).
 *
 * 지목(`ScoutReport`)과 같은 자리를 나눠 쓰지만 가져오는 것이 다르다: 지목은 그
 * 선수 하나의 안개를 `scouted`까지 걷고, 임무는 조건을 지나는 후보
 * `MISSION_CANDIDATES`명을 골라 와 그 다섯을 `seen`으로 올린다.
 *
 * **세 상태가 두 칸에 있다** — `dueOn === null`이면 한도에 막혀 아직 안 나간 대기,
 * `dueOn`이 서고 `completedOn === null`이면 파견 중, 둘 다 서면 완료다. 대기를
 * 따로 두지 않는 이유는 대기와 파견이 **같은 조건 한 벌**이기 때문이다: 표를
 * 가르면 나가는 순간 한쪽에서 지우고 다른 쪽에 그대로 다시 적어야 한다
 * (지목의 대기 `DeferredScout`는 이름 하나뿐이라 그럴 일이 없다).
 */
export const ScoutMissionSchema = z.object({
  id: z.string().min(1),
  /** 대회 id — 없으면 풀은 검색과 같은 5대 리그 1·2부 전체 */
  competitionId: z.string().min(1).optional(),
  /** 포지션 코드 (주 포지션 또는 소화 가능 포지션) */
  position: z.string().min(1).optional(),
  minAge: z.number().int().min(SEARCH_MIN_AGE).max(SEARCH_MAX_AGE).optional(),
  maxAge: z.number().int().min(SEARCH_MIN_AGE).max(SEARCH_MAX_AGE).optional(),
  /** 관측 시장가 상한 (£) — 참값이 아니라 흐린 값으로 거른다 (player.md §10) */
  maxValue: z.number().min(0).optional(),
  requestedOn: DateString,
  /** null = 한도에 막혀 아직 안 나갔다 (대기) */
  dueOn: DateString.nullable(),
  /** null = 파견 중 */
  completedOn: DateString.nullable(),
  /**
   * 코어가 `dueOn`에 적는 후보 — **한 번 적고 다시 세우지 않는다.** 후보가 되는
   * 순간 그들의 지식 수준이 `seen`으로 오르므로, 나중에 다시 줄을 세우면 그
   * 다섯의 관측값이 달라져 카드와 어긋난다.
   */
  candidates: z.array(z.string().min(1)).optional(),
});

export type ScoutMission = z.infer<typeof ScoutMissionSchema>;

/**
 * 임무 소요 일수 — **지목의 두 배.** 한 사람을 보러 가는 길과 리그를 훑어 다섯을
 * 골라내는 일이 같은 날짜일 수는 없다. 조건의 개수로 흔들지 않는다: 눈금이 하나여야
 * 감독이 언제 답이 오는지 셀 수 있다.
 */
export const MISSION_DAYS = SCOUT_DAYS * 2;

/** 임무 하나가 적어 오는 후보 수 — 견줄 수 있을 만큼, 카드가 화면을 덮지 않을 만큼 */
export const MISSION_CANDIDATES = 5;

/**
 * 못 나간 요청을 붙들고 있는 기간 — **자리를 가장 늦게 비우는 파견의 날짜**다.
 * 그 안에 자리는 반드시 나므로, 넘겨도 안 나갔으면 감독의 뜻이 지나간 것이다.
 * 임무가 생기기 전에는 `SCOUT_DAYS`였다: 임무 셋이 나가 있으면 이레로는 자리가
 * 나기 전에 대기가 먼저 사라진다.
 */
export const SCOUT_DEFER_DAYS = MISSION_DAYS;
