import {
  type GamePlayer,
  type InjuryHistory,
  type InjurySeverity,
  type TickSink,
  INJURY_SEVERITY_KO,
} from "@story-fm/domain";
import { INJURY_PER_MATCH, injuryRiskOf, type InjuryRisk } from "@story-fm/sim";
import { addDays, diffDays } from "../core/dates";
import { playerCatalog } from "./catalog/catalog";
import { INJURY_HISTORY } from "./catalog/injury-history";
import { pick, randInt } from "../core/rng";
import { playerById, type GameState, openInjury } from "../core/state";
import { recordFinance } from "../core/ledger";

/**
 * 부상 — 발생·복귀·성향.
 *
 * 장부의 공통 패턴을 따른다: `returnedOn === null`이 현재 부상이고, 날짜가 박히면
 * 그대로 이력이 된다. 부상은 **팀을 가리지 않는다** — 유저 경기의 상대도,
 * 간이 시뮬로 도는 타 팀 경기도 같은 표에 쌓인다 — 입구가 유저 팀에만 있으면
 * 상대는 시즌 내내 최정예로 나오고, `simSquadOf`의 "부상으로 빈 자리를 메운다"는
 * 분기가 한 번도 실행되지 않는다.
 */

const INJURY_PARTS = ["햄스트링", "발목", "무릎", "종아리", "허벅지", "어깨", "허리"];

/**
 * 심각도의 한글 라벨 — **원본은 domain의 표 하나다** (`records.ts`). 이력 한 줄
 * (`injuryHistoryText`)도 그 표를 읽으므로, 여기 한 벌 더 두면 같은 부상이 자리마다
 * 다른 낱말이 된다 (player.md §5.3). 코어 쪽 부르는 곳이 옮기지 않게 다시 내보낸다.
 */
export { INJURY_SEVERITY_KO, type InjuryHistory };

/** 부상 복귀 처리 — 예상 복귀일이 지나면 returnedOn을 기록해 이력으로 닫는다 */
export function resolveInjuries(state: GameState, digest: TickSink): void {
  for (const injury of state.injuries) {
    if (injury.returnedOn !== null) continue;
    if (state.date < injury.expectedReturn) continue;
    injury.returnedOn = state.date;
    const player = playerById(state, injury.gamePlayerId);
    if (player && player.teamId === state.userTeamId) {
      digest.push(`부상 복귀: ${player.name} (${injury.bodyPart})`);
    }
  }
}

// ── 이력에서 파생하는 부상 위험 ──────────────────────────

export const PRONENESS_BASE = 1;
const INJURY_PRONENESS_MAX = 2.2;
export const TRAINING_INJURY_PER_SESSION = 0.006;
/** 경기당 총 부상 빈도를 양 팀 선발 22명으로 나눈 기본 확률. */
export const INJURY_CHANCE_PER_APPEARANCE = INJURY_PER_MATCH / 22;
const HISTORY_WINDOW_DAYS = 730;

/** 심각도 판정과 회복 기간 굴림이 같은 구간을 읽는다. */
const DAYS_OUT: Record<InjurySeverity, readonly [number, number]> = {
  minor: [4, 12],
  moderate: [15, 40],
  major: [60, 140],
};
const P_MINOR = 0.66;
const P_MODERATE_GIVEN_WORSE = 0.82;

/** 최근 730일의 실제 결장 합집합을 확률 배수에 옮긴다. */
const PRONENESS_ANCHORS: ReadonlyArray<readonly [days: number, value: number]> = [
  [0, PRONENESS_BASE],
  [40, 1.15],
  [120, 1.45],
  [250, 1.9],
  [400, INJURY_PRONENESS_MAX],
];

export function pronenessFromDaysOut(days: number): number {
  if (days <= 0) return PRONENESS_BASE;
  for (let i = 1; i < PRONENESS_ANCHORS.length; i++) {
    const [hiDays, hiValue] = PRONENESS_ANCHORS[i]!;
    if (days > hiDays) continue;
    const [loDays, loValue] = PRONENESS_ANCHORS[i - 1]!;
    return loValue + ((hiValue - loValue) * (days - loDays)) / (hiDays - loDays);
  }
  return INJURY_PRONENESS_MAX;
}

type InjuryState = Pick<GameState, "date" | "injuries">;

/** 같은 시점의 이력은 조회·훈련·두 시뮬에 같은 위험 배수를 준다. */
export function injuryProneness(state: InjuryState, playerId: string): number {
  return pronenessFromDaysOut(injuryHistoryOf(state, playerId).daysOut);
}

/** 요청 선수의 이력을 한 번 모아 시뮬레이터에 넘긴다. 저장 캐시는 두지 않는다. */
export function pronenessOf(
  state: InjuryState,
  playerIds: Iterable<string>,
): Record<string, number> {
  const rows = new Map([...playerIds].map((id) => [id, [] as GameState["injuries"]]));
  for (const injury of state.injuries) rows.get(injury.gamePlayerId)?.push(injury);
  return Object.fromEntries(
    [...rows].map(([id, injuries]) => [id, injuryProneness({ date: state.date, injuries }, id)]),
  );
}

export function injuryRiskFor(state: InjuryState, player: GamePlayer): InjuryRisk {
  return injuryRiskOf(player, injuryProneness(state, player.id));
}

/** 심각도 — 코어의 굴림과 같은 구간으로 읽는다 (`DAYS_OUT`) */
function severityOfDays(days: number): InjurySeverity {
  if (days < DAYS_OUT.moderate[0]) return "minor";
  if (days < DAYS_OUT.major[0]) return "moderate";
  return "major";
}

/**
 * 겹치는 결장 구간의 합집합 일수 — **한 사람이 두 부상을 동시에 안고 있으면
 * 결장은 한 번이다.** 단순히 더하면 루크 쇼의 2024년 8월이 두 배로 잡힌다.
 */
function unionDays(spans: ReadonlyArray<readonly [string, string]>): number {
  const sorted = [...spans].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let total = 0;
  let openFrom: string | null = null;
  let openTo: string | null = null;
  for (const [from, to] of sorted) {
    if (openTo !== null && from <= openTo) {
      if (to > openTo) openTo = to;
      continue;
    }
    if (openFrom !== null && openTo !== null) total += diffDays(openFrom, openTo);
    openFrom = from;
    openTo = to;
  }
  if (openFrom !== null && openTo !== null) total += diffDays(openFrom, openTo);
  return total;
}

/**
 * 조사된 부상 이력을 새 게임에 펼친다 — `INJURY` 행.
 *
 * **복귀일이 부임일보다 뒤면 아직 안 나은 것**이라 열린 행(`returnedOn: null`)으로
 * 들어간다. 감독은 그 선수를 다친 채로 넘겨받고, tick이 복귀일에 닫는다.
 * 표에 없는 선수는 손대지 않는다 — 성향은 1.0(평균)에 남는다.
 *
 * 조인 키는 **위키데이터 QID**다. 이름은 시드에 동명이인이 있어 한 사람의 이력을
 * 남의 몸에 붙인다. QID가 없는 카탈로그 엔트리(합성·아카데미)는 이력이 없는 것으로
 * 지나간다.
 */
export function seedInjuryHistory(state: GameState): void {
  const qidById = new Map(
    playerCatalog().flatMap((e) =>
      e.wikidataId === undefined ? [] : [[e.id, e.wikidataId] as const],
    ),
  );
  for (const player of state.players) {
    const wikidataId = player.catalogId === null ? undefined : qidById.get(player.catalogId);
    const history = wikidataId === undefined ? undefined : INJURY_HISTORY[wikidataId];
    if (!history) continue;
    for (const row of history) {
      // 아직 발생하지 않은 미래 기록을 현재 사실로 심지 않는다.
      if (row.from > state.date) continue;
      const days = Math.max(1, diffDays(row.from, row.until));
      const stillOut = row.until > state.date;
      state.injuries.push({
        id: `inj-seed-${player.id}-${row.from}`,
        gamePlayerId: player.id,
        bodyPart: row.part,
        severity: severityOfDays(days),
        // 경기도 훈련도 아닌 제3의 출처 — 감독이 오기 전의 몸이다 (player.md §5.3).
        // 어디서 다쳤는지까지는 출처가 말하지 않으므로 지어내지 않는다
        cause: "pre_appointment",
        occurredOn: row.from,
        expectedReturn: row.until,
        returnedOn: stillOut ? null : row.until,
      });
    }
  }
}

// ── 부상 이력 — 등급 대신 사실 ─────────────────────────────

/**
 * 이 선수의 부상 이력 — **창 안의 사실만.** 창 밖은 이 몸의 이야기가 아니다.
 *
 * 결장 일수는 성향을 만든 그 셈과 같은 문을 지난다(`unionDays`) — 두 부상을 동시에
 * 안고 있던 날을 두 번 세면 화면의 숫자가 코어의 성향과 어긋난다.
 */
export function injuryHistoryOf(
  state: Pick<GameState, "date" | "injuries">,
  playerId: string,
  windowDays: number | null = HISTORY_WINDOW_DAYS,
): InjuryHistory {
  const from = windowDays === null ? null : addDays(state.date, -windowDays);
  const rows = state.injuries
    .filter(
      (i) =>
        i.gamePlayerId === playerId &&
        i.occurredOn <= state.date &&
        (from === null || (i.returnedOn ?? state.date) > from),
    )
    .sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0));
  const daysOut = unionDays(
    rows.map(
      (i) =>
        [
          from !== null && i.occurredOn < from ? from : i.occurredOn,
          i.returnedOn !== null && i.returnedOn < state.date ? i.returnedOn : state.date,
        ] as const,
    ),
  );
  const last = rows[rows.length - 1];
  return {
    count: rows.length,
    daysOut,
    last:
      last === undefined
        ? null
        : {
            bodyPart: last.bodyPart,
            severity: last.severity,
            // 복귀했으면 복귀일로부터, 아직이면 발생일로부터 — 감독이 세는 날이 다르다
            daysAgo: diffDays(last.returnedOn ?? last.occurredOn, state.date),
            open: last.returnedOn === null,
          },
  };
}

export function rollInjury(rng: () => number): {
  severity: InjurySeverity;
  days: number;
  part: string;
} {
  const severity: InjurySeverity =
    rng() < P_MINOR ? "minor" : rng() < P_MODERATE_GIVEN_WORSE ? "moderate" : "major";
  const [minDays, maxDays] = DAYS_OUT[severity];
  const days = randInt(rng, minDays, maxDays);
  const part = pick(rng, INJURY_PARTS);
  return { severity, days, part };
}

/** 부상 발생 — INJURY row 생성 (현재 부상 = returnedOn null) */
export function openInjuryFor(
  state: GameState,
  player: GamePlayer,
  cause: "match" | "training",
  rng: () => number,
): { days: number; part: string } {
  /**
   * **선수당 미복귀는 최대 1건**(`domain/records.ts`)이고, 그 계약은 행을 쓰는 여기가
   * 지킨다. 이미 열린 부상이 있으면 새 행도 치료비도 없고 — 안고 있는 그
   * 부상을 그대로 돌려준다. 지금 호출부는 모두 `isInjured`로 먼저 거르지만, 거르지
   * 않는 호출부가 하나 생기면 미복귀 두 건이 남아 복귀일도 부위도 둘이 되고,
   * 화면·조회·간이 시뮬이 각자 다른 하나를 집는다.
   */
  const current = openInjury(state, player.id);
  if (current) {
    const left = Math.max(0, diffDays(state.date, current.expectedReturn));
    return { days: left, part: current.bodyPart };
  }
  const { severity, days, part } = rollInjury(rng);
  state.injuries.push({
    id: `inj-${player.id}-${state.date}`,
    gamePlayerId: player.id,
    bodyPart: part,
    severity,
    cause,
    occurredOn: state.date,
    expectedReturn: addDays(state.date, days),
    returnedOn: null,
  });
  // 치료비 — 부상은 재정에도 흔적을 남긴다 (finance.md §6). 남의 팀 장부는 우리 것이 아니다
  if (player.teamId === state.userTeamId) {
    recordMedicalCost(state, player.id, player.name, severity);
  }
  return { days, part };
}

/** 부상 치료비 — 심각도별 */
const MEDICAL_COST: Record<"minor" | "moderate" | "major", number> = {
  minor: 30_000,
  moderate: 120_000,
  major: 400_000,
};

/** 부상 치료비 — 부상 발생 시점에 (원인 무관) */
function recordMedicalCost(
  state: GameState,
  playerId: string,
  playerName: string,
  severity: "minor" | "moderate" | "major",
): void {
  recordFinance(state, state.userTeamId, {
    kind: "expense",
    category: "travel_medical",
    label: `치료비 — ${playerName}`,
    amount: MEDICAL_COST[severity],
    ref: { type: "player", id: playerId },
  });
}
