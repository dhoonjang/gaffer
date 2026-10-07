import type { Formation, GamePlayer, TacticAssignment, BoardPoint } from "@gaffer/domain";
import {
  playerOverall,
  DEFAULT_FORMATION,
  FORMATIONS,
  MATCHDAY_BENCH,
  FORMATION_LAYOUTS,
  FORMATION_SLOTS,
  naturalPositionOf,
  positionGroupOf,
  weightSlotOf,
  roleFit,
  proficiencyAt,
  positionGroupOfPlayer as groupOf,
} from "@gaffer/domain";
import { profFactor } from "@gaffer/sim";

/** 슬롯 전체의 적합도 합이 최대가 되게 선수를 배치한다 (직사각형 Hungarian). */
function fillSlots(
  pool: GamePlayer[],
  slots: readonly string[],
  score: (p: GamePlayer, slot: string) => number,
): GamePlayer[] {
  const rowCount = Math.min(slots.length, pool.length);
  if (rowCount === 0) return [];
  const maxScore = Math.max(
    ...slots.slice(0, rowCount).flatMap((slot) => pool.map((player) => score(player, slot))),
  );
  const u = Array<number>(rowCount + 1).fill(0);
  const v = Array<number>(pool.length + 1).fill(0);
  const matchedRow = Array<number>(pool.length + 1).fill(0);
  const previousColumn = Array<number>(pool.length + 1).fill(0);

  for (let row = 1; row <= rowCount; row++) {
    matchedRow[0] = row;
    let column = 0;
    const minimum = Array<number>(pool.length + 1).fill(Infinity);
    const used = Array<boolean>(pool.length + 1).fill(false);
    do {
      used[column] = true;
      const currentRow = matchedRow[column]!;
      let delta = Infinity;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= pool.length; candidate++) {
        if (used[candidate]) continue;
        const cost =
          maxScore -
          score(pool[candidate - 1]!, slots[currentRow - 1]!) -
          u[currentRow]! -
          v[candidate]!;
        if (cost < minimum[candidate]!) {
          minimum[candidate] = cost;
          previousColumn[candidate] = column;
        }
        if (minimum[candidate]! < delta) {
          delta = minimum[candidate]!;
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= pool.length; candidate++) {
        if (used[candidate]) {
          const matched = matchedRow[candidate]!;
          u[matched] = u[matched]! + delta;
          v[candidate] = v[candidate]! - delta;
        } else {
          minimum[candidate] = minimum[candidate]! - delta;
        }
      }
      column = nextColumn;
    } while (matchedRow[column] !== 0);

    do {
      const previous = previousColumn[column]!;
      matchedRow[column] = matchedRow[previous]!;
      column = previous;
    } while (column !== 0);
  }

  const result = Array<GamePlayer>(rowCount);
  for (let column = 1; column <= pool.length; column++) {
    const row = matchedRow[column]!;
    if (row > 0) result[row - 1] = pool[column - 1]!;
  }
  return result;
}

/**
 * **주 포지션에 서는 값** — 감독은 자리를 존중한다.
 *
 * 포지션군 가산(`SAME_GROUP_BONUS`)만으로는 부족했다. 4-2-3-1의 볼란치와 10번은
 * 둘 다 미드필더군이라 그 가산이 상쇄돼, 남는 건 적응도와 OVR뿐이다. 그런데
 * 적응도는 **파생값이 보유값을 넘을 수 있어**(마이누의 CM 95에서 파생된 CAM 89가
 * 페르난데스가 실제 보유한 CAM 88보다 높다) 10번이 6번 자리로 밀려났다.
 *
 * "그 선수의 본업인가"는 그런 눈금 흔들림과 무관한 사실이라 따로 센다.
 * 좌우 분화는 같은 자리로 본다 — LCB의 본업은 CB다 (`weightSlotOf`).
 *
 * ⚠️ **그 자리를 볼 수는 있을 때만 준다** (`NATURAL_BONUS_FLOOR`). `weightSlotOf`는
 * 요구 역량이 같아서 좌우를 합치는데, "본업인가"에는 좌우가 중요하다 — 문턱이
 * 없으면 주 RB가 반대쪽 LWB에서도 가산을 받아(적응도 56) 진짜 왼쪽 자원을
 * 밀어낸다. 지정 선발 가산이 `XI_BONUS_FLOOR`를 두는 것과 같은 이유다.
 *
 * 40(포지션군)보다 작게 잡은 이유: 이 가산이 OVR 차이를 통째로 덮으면 주 포지션
 * 백업이 타 포지션 특급을 밀어낸다. 실제 감독은 충분히 좋은 선수라면 자리를
 * 옮겨서라도 쓴다.
 */
const NATURAL_SLOT_BONUS = 30;

/** 본업 가산이 붙는 최소 적응도 — 기본 배치 가드(70)와 같은 눈금 */
const NATURAL_BONUS_FLOOR = 70;

/** 포지션군이 맞을 때 — "그 라인의 선수인가" */
const SAME_GROUP_BONUS = 40;

/**
 * 슬롯 적합도 — **누구를 어디에 세울지**의 단일 기준.
 * 정확 포지션 적응도 + OVR, 포지션군·주 포지션이 맞으면 가산,
 * 골키퍼 자리는 서로 못 넘본다.
 */
function lineupFit(p: GamePlayer, slot: string, prof = proficiencyAt(p, slot)): number {
  const sameGroup = groupOf(p) === positionGroupOf(slot);
  const onNatural =
    prof >= NATURAL_BONUS_FLOOR &&
    weightSlotOf(naturalPositionOf(p).position) === weightSlotOf(slot);
  const gkPenalty = slot === "GK" && groupOf(p) !== "GK" ? -400 : 0;
  const nonGkPenalty = slot !== "GK" && groupOf(p) === "GK" ? -400 : 0;
  return (
    prof * 1.2 +
    playerOverall(p) +
    (sameGroup ? SAME_GROUP_BONUS : 0) +
    (onNatural ? NATURAL_SLOT_BONUS : 0) +
    gkPenalty +
    nonGkPenalty
  );
}

/**
 * 맡은 자리에서의 실제 기여 — 시뮬의 존 기여 점수와 **같은 잣대**.
 * ⚠️ 적응도 팩터는 sim에서 가져온다. 여기에 같은 식을 다시 쓰면 배치가 고른
 * 자리와 경기가 계산하는 자리가 조용히 갈린다.
 */
function slotStrength(p: GamePlayer, slot: string): number {
  return roleFit(p.attributes, slot) * profFactor(proficiencyAt(p, slot));
}

/**
 * 이 스쿼드로 그 모양을 세우면 나오는 **전력**.
 *
 * ⚠️ 채점 전에 **자리를 제대로 배치해야** 한다. `roleFit`만 보고 그리디로 채우면
 * 라이스가 라이트백에, 요케레스가 윙에 서는 라인업이 나오고, 그 배치의 합으로
 * 모양이 정해진다. 배치는 실제 라인업과 같은 기준(`lineupFit`: 포지션 적응도 +
 * OVR + 포지션군)으로 뽑고, **전력 합은** 그렇게 뽑힌 11명의 존 기여로 낸다.
 *
 * 모든 모양이 11자리라 자리별 기준선은 합에서 상쇄된다 — 따로 정규화하지 않는다.
 */
function shapeStrength(
  squad: GamePlayer[],
  formation: Formation,
  fit: (p: GamePlayer, slot: string) => number,
): number {
  const slots = FORMATION_SLOTS[formation];
  const chosen = fillSlots(squad, slots, fit);
  return chosen.reduce((sum, p, i) => sum + slotStrength(p, slots[i]!), 0);
}

/**
 * (선수 × 슬롯) 점수 캐시 — 프리셋 5개를 훑으면 같은 조합을 몇 번씩 다시 잰다.
 * `proficiencyAt`이 포지션 배열을 훑으므로 캐시가 없으면 새 게임 하나에 100만 번
 * 가까이 불린다.
 *
 * `preferred`를 주면 지정 선발 가산까지 얹은 **실제 라인업과 같은 잣대**가 된다 —
 * 모양을 고르는 쪽과 자리를 앉히는 쪽이 다른 점수를 쓰면, 세울 수 있는 모양인데도
 * 시험 배치에서만 미달자가 나온다.
 */
function memoFit(preferred?: ReadonlySet<string>): (p: GamePlayer, slot: string) => number {
  const cache = new Map<string, number>();
  return (p, slot) => {
    const key = `${p.id}|${slot}`;
    let v = cache.get(key);
    if (v === undefined) {
      // 적응도는 한 번만 — `fillSlots`의 헝가리안이 이 함수를 수만 번 부른다
      const prof = proficiencyAt(p, slot);
      v =
        lineupFit(p, slot, prof) + (preferred?.has(p.id) && prof >= XI_BONUS_FLOOR ? XI_BONUS : 0);
      cache.set(key, v);
    }
    return v;
  };
}

/**
 * 구단이 **어떤 모양으로 서야 가장 센가** — 프리셋 전부를 채워 보고 고른다.
 *
 * 채점 풀은 **지정 선발 11인**이다(있으면). 모양은 결국 "이 열한 명을 어떻게
 * 세울까"의 답이라, 스쿼드 전체로 재면 4백 명단을 가진 팀이 5백으로 서는 답이
 * 나온다(본머스가 그랬다) — 백업 수비수까지 세어 버리기 때문이다. 지정 선발이
 * 없는 팀만 스쿼드 전체로 잰다.
 *
 * 카탈로그의 리서치 값(`TeamCatalogEntry.formation`)은 **선입견**으로 얹는다:
 * 실제 감독이 쓰는 시스템이라는 근거가 있으니 다른 모양이 **뚜렷하게** 셀 때만
 * 뒤집힌다. 그래서 스쿼드가 리서치 값을 감당하는 팀은 그대로 가고, 감당 못 하는
 * 팀(백3인데 센터백이 둘, 윙어가 없는데 4-3-3)만 제 모양을 찾아간다.
 */
export function pickFormation(
  squad: GamePlayer[],
  prior?: Formation,
  preferred?: readonly string[],
): Formation {
  const wanted = new Set(preferred ?? []);
  const xi = squad.filter((p) => wanted.has(p.id));
  const pool = xi.length >= 10 ? xi : squad;
  const fit = memoFit(wanted);
  if (prior) {
    const placed = fillSlots(pool, FORMATION_SLOTS[prior], fit);
    const feasible = placed.every(
      (player, index) => proficiencyAt(player, FORMATION_SLOTS[prior][index]!) >= XI_BONUS_FLOOR,
    );
    if (feasible) return prior;
  }
  let best: Formation = prior ?? DEFAULT_FORMATION;
  let bestScore = -Infinity;
  for (const formation of FORMATIONS) {
    const score = shapeStrength(pool, formation, fit);
    if (score > bestScore) {
      bestScore = score;
      best = formation;
    }
  }
  return best;
}

/** 지정 선발 가산이 붙는 최소 적응도 — "그 자리를 볼 수는 있다"의 문턱.
 *  기본 배치 가드(적응도 70 미만 금지)와 같은 눈금이다 — 가산이 그 가드를 뚫으면
 *  안 된다 (사우스햄프턴의 마테우스 페르난데스가 적응도 64로 레프트백에 섰다). */
const XI_BONUS_FLOOR = 70;

/** 지정 선발 가산 — 적합도·OVR 차이(최대 ~110)를 확실히 덮는다. */
const XI_BONUS = 200;

/**
 * 포메이션 슬롯에 맞춰 선발 11 + 벤치 9 배치를 만든다 (적합도 우선).
 *
 * `preferred`를 주면 그 선수들이 선발에 **크게 가산**된다 — 팀 카탈로그의
 * 기본 선발(`DEFAULT_XI`)이 이 경로로 들어온다. 배제가 아니라 가산인 이유는
 * 포지션군 감점(-400)이 여전히 이겨야 하기 때문이다: 지정 명단에 GK가 없거나
 * 그 GK가 2군이면, 강제로 채우는 순간 필드 플레이어가 골문에 선다.
 * 11명이 안 되거나 부상·징계로 빠진 자리는 평소대로 적합도 상위가 메운다.
 *
 * ⚠️ **골문에는 골키퍼만 앉는다** (team.md §6). 감점은 "누가 덜 나쁜가"이지 "서도
 * 되는가"가 아니라, 풀에 골키퍼가 하나도 없으면 감점을 안은 채 수비형 미드필더가
 * 골문에 섰다. 그때는 GK 슬롯을 배정에서 빼고 **골문을 비운 채 열 명**을 세운다 —
 * 등록 현황이 사유를 세우고, 킥오프의 자동 대체가 채운다 (match.md §2).
 */
export function buildAssignments(
  squad: GamePlayer[],
  formation: keyof typeof FORMATION_SLOTS,
  familiarity: number,
  available: (id: string) => boolean = () => true,
  preferred?: readonly string[],
  customLayout?: {
    slots: readonly string[];
    points: readonly BoardPoint[];
  },
): TacticAssignment[] {
  // 프리셋은 새 게임 초기화 전용이다. 시즌 중 재구성은 저장된 실제 좌표를 넘긴다.
  const slots = customLayout?.slots ?? FORMATION_SLOTS[formation];
  const layout = customLayout?.points ?? FORMATION_LAYOUTS[formation];
  const used = new Set<string>();
  const assignments: TacticAssignment[] = [];
  const pool = squad.filter((p) => available(p.id));
  const wanted = new Set(preferred ?? []);

  // 지정 선발 가산(`XI_BONUS`)은 **그 자리를 실제로 볼 수 있을 때만** 준다:
  // 카탈로그의 기본 선발은 그 구단의 실제 포메이션에서 뽑힌 11명이라, 프리셋으로
  // 접힌 다른 모양(4백 명단 → 3-5-2)에 그대로 밀어 넣으면 스트라이커가 윙백에
  // 선다. 못 서는 자리는 스쿼드에서 제대로 된 자원이 채우고 밀린 선수는 벤치로
  // 간다 — 감독이 백3로 바꿀 때 실제로 하는 일이다.
  //
  // 포지션군 일치로 재면 안 된다. 4-2-3-1의 넓은 공격 3인은 좌표상 RM/AM/LM이라
  // **미드필더군**인데 그 자리에 서는 건 윙어(FW군)다 — 군으로 막으면 풀럼의
  // 보브·케빈 같은 지정 선발이 통째로 밀려난다. 적응도로 재면 같은 질문에
  // 정확히 답하면서(스트라이커의 윙백 적응도는 40대라 여전히 막힌다) 이 오탐이
  // 사라진다.
  const fit = memoFit(wanted);

  // 골키퍼 없는 풀에서는 골문 자리를 배정에서 뺀다 — 비운 자리는 저장되지 않는다
  const keeperInPool = pool.some((p) => groupOf(p) === "GK");
  const seats = slots
    .map((_, index) => index)
    .filter((index) => keeperInPool || positionGroupOf(slots[index]!) !== "GK");
  const chosen = fillSlots(
    pool,
    seats.map((index) => slots[index]!),
    fit,
  );
  for (const p of chosen) used.add(p.id);

  chosen.forEach((p, i) => {
    const index = seats[i]!;
    assignments.push({
      playerId: p.id,
      role: "starting",
      position: slots[index]!,
      familiarity,
      point: layout[index],
    });
  });

  // 벤치 9 — GK 1명 포함 우선, 나머지는 OVR 상위
  const rest = pool
    .filter((p) => !used.has(p.id))
    .sort((a, b) => playerOverall(b) - playerOverall(a));
  const benchGk = rest.find((p) => groupOf(p) === "GK");
  const bench: GamePlayer[] = [];
  if (benchGk) bench.push(benchGk);
  for (const p of rest) {
    if (bench.length >= MATCHDAY_BENCH) break;
    if (bench.some((b) => b.id === p.id)) continue;
    bench.push(p);
  }
  for (const p of bench) {
    assignments.push({
      playerId: p.id,
      role: "bench",
      position: naturalPositionOf(p).position,
      familiarity,
    });
  }
  return assignments;
}
