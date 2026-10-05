import { recallRole } from "../players/role-memory";
import { pickVacancy } from "./vacancy";
import {
  playerOverall,
  FATIGUE_BAND_FLOOR,
  type GamePlayer,
  naturalPositionOf,
  FAMILIARITY_BASELINE,
  fatigueOf,
  rolesFor,
} from "@gaffer/domain";
import {
  type GameState,
  assignmentFor,
  proficiencyAt,
  tacticsOf,
  groupOf,
  firstTeamPlayers,
  isAvailableFor,
  assignmentsOf,
  MATCHDAY_BENCH,
} from "../core/state";
import { type SimSquad } from "./quick-sim";
import { managerTacticsOf } from "./manager-tactics";
import { pronenessOf } from "../players/injury";

/**
 * 로테이션 기준 — 이 이상 지친 선발은 신선한 대체 자원에게 자리를 내준다.
 *
 * ⚠️ **소모 눈금(`FULL_MATCH_DRAIN`)을 만지면 이 값도 다시 재야 한다.** 이 문턱이
 * 보는 것은 라인업을 짜는 시점의 저장 체력이라, 소모가 줄면 아무도 닿지 못해 AI가
 * 로테이션을 통째로 멈춘다 — 그러면 컵·유럽을 병행하는 팀이 주말에 최정예를 그대로
 * 세우고 주중 경기의 대가가 사라진다.
 *
 * 지금 값의 근거(실측): 만 7일 뒤 체력은 100이라 **주 1경기 리듬에서는 걸리지
 * 않는다.** 사흘 간격에서 많이 뛰는 자리(풀백·중원·윙어)가 75~76(피로 24~25)로
 * 걸리고 덜 뛰는 자리(센터백·최전방)는 83~85(피로 15~17)로 통과한다 — 자리마다
 * 갈리는 것이 요점이다. 사흘 연전이 이어지면 피로가 37 근처에 눕는다.
 *
 * 공개하는 이유는 하나뿐이다 — **밸런스 하네스가 이 문턱을 재기 때문이다.**
 * 하네스가 제 숫자를 따로 적으면 로테이션을 재는 자리가 재려는 대상과 다른 눈금을
 * 쓴다 (실제로 그랬다: 하네스는 30, 여기는 20).
 */
export const ROTATION_FATIGUE = 20;

/**
 * **시즌의 몸도 자리를 내주게 한다** — 누적 피로가 「지침」 위인 선발 (player.md §5.5).
 *
 * 위 문턱은 **오늘의 몸**만 묻는다. 그래서 주 1경기 리듬의 팀은 아무도 닿지 않고
 * (만 7일이면 체력이 100이다), 대항전 없는 구단은 시즌 내내 같은 열한 명을 세우고도
 * 로테이션을 한 번도 하지 않았다 — 그 팀의 12월 스쿼드가 8월과 똑같았다는 뜻이다.
 * 잔고는 주 1경기에서도 차오르므로 둘째 이유가 그 자리를 잡는다.
 *
 * 값을 따로 적지 않고 **명단의 등급 경계**를 그대로 읽는다 — 감독의 화면이
 * 「지침」이라 적은 선수를 AI도 뺀다. 두 벌을 두면 화면과 상대 벤치가 다른 눈금을 산다.
 */
export const ROTATION_LOAD = FATIGUE_BAND_FLOOR.heavy;

/**
 * 대체가 허용되는 기량 손실 — 이보다 떨어지면 지쳐도 그냥 뛴다.
 * ⚠️ 종합의 눈금을 탄다 (player.md §4 — 축 가중 평균이 되며 분포가 좁아져 8 → 7).
 */
export const ROTATION_OVR_DROP = 7;

/** 대체 자원은 최소 이만큼 더 신선해야 한다 */
export const ROTATION_FRESHER = 15;

/**
 * **다리가 멎은 선수는 기량과 무관하게 뺀다.**
 *
 * 위 세 조건은 "더 나은 선택이 있는가"를 묻는다. 그래서 대체할 사람이 마땅치
 * 않은 핵심 선수는 지쳐도 계속 나갔고, 시즌 중반이면 체력 0까지 내려갔다 —
 * 실제 구단이라면 절대 세우지 않을 상태다. 구멍 문턱(`GAP_CONDITION` 22)보다
 * 조금 위에서, 뛸 수 있는 아무나로 바꾼다. 라인업은 약해지지만 그게 대가다.
 */
export const EXHAUSTED_CONDITION = 35;

/**
 * 전술판이 이 선수에게 준 자리 — 좌표·역할은 판의 것, 숙련도는 사람의 것.
 * 배치가 없으면 자연 포지션에 기준선 적응도로 선다.
 */
function boardSlotOf(state: GameState, player: GamePlayer) {
  const assignment = assignmentFor(state, player.id);
  const position = assignment?.position ?? naturalPositionOf(player).position;
  return {
    position,
    ...(assignment?.point ? { point: assignment.point } : {}),
    ...(assignment?.roleId ? { roleId: assignment.roleId } : {}),
    proficiency: proficiencyAt(player, position),
    familiarity: assignment?.familiarity ?? FAMILIARITY_BASELINE,
  };
}

/**
 * **이 선수들로 세우는 간이 시뮬 입력** — 명단이 이미 정해진 자리(연장)가 쓴다.
 *
 * 팀 id와 선수 목록만 넘기면 입력이 자연 포지션 · `DEFAULT_TACTICS` · 적응도 60 ·
 * 감독 65로 서서, 90분과 연장이 서로 다른 팀의 경기가 된다 (match.md §7).
 * 벤치는 두지 않는다 — 30분을 한 번에 굴리는 자리라 교체가 일어나지 않는다.
 */
export function simSquadFor(
  state: GameState,
  teamId: string,
  players: readonly GamePlayer[],
): SimSquad {
  return {
    teamId,
    starters: [...players],
    slots: players.map((player) => ({ player, ...boardSlotOf(state, player) })),
    familiarity: Object.fromEntries(
      players.map((p) => [p.id, assignmentFor(state, p.id)?.familiarity ?? FAMILIARITY_BASELINE]),
    ),
    tactics: tacticsOf(state, teamId).spec,
    managerTactics: managerTacticsOf(state, teamId),
    /**
     * 죽은 공 지정과 지시 — **90분(`simSquadOf`)과 같은 눈금이다.** 감독 팀이 이
     * 길로 오는 자리는 2군 리그(그 대진은 감독 팀만 편성된다 — season.md §2)라,
     * 빠뜨리면 감독이 정한 키커가 그 경기에서만 조용히 사라진다. 지정한 선수가 이
     * 열한 명에 없으면 간이 시뮬이 알아서 기본값을 세운다 (match.md §1.4).
     */
    ...(tacticsOf(state, teamId).setPieceTakers
      ? { setPieceTakers: tacticsOf(state, teamId).setPieceTakers }
      : {}),
    ...(tacticsOf(state, teamId).setPieceRoutine
      ? { setPieceRoutine: tacticsOf(state, teamId).setPieceRoutine }
      : {}),
    // 연장의 부상 추첨도 성향을 탄다 — 90분(simSquadOf)과 같은 눈금 (match.md §7)
    proneness: pronenessOf(
      state,
      players.map((p) => p.id),
    ),
  };
}

/** 전술판이 한 자리에 세운 값 — `boardSlotOf`가 내고 로테이션이 갈아 끼운다 */
type SlotSetup = ReturnType<typeof boardSlotOf>;

/**
 * 간이 시뮬 입력 조립 — 전술 배치에서 가용 선발을 뽑는다.
 *
 * 부상·정지로 빈 자리를 메우고, **지친 선발은 로테이션**한다. 대항전에 나가는 팀은
 * 주중 경기가 늘어 이 부담을 실제로 지고, 그 대가는 약해진 라인업이다 (유저 팀은
 * 감독이 직접 라인업을 짜므로 이 함수를 쓰지 않는다).
 */
export function simSquadOf(
  state: GameState,
  teamId: string,
  competitionId: string | null,
): SimSquad {
  const squad = firstTeamPlayers(state, teamId);
  const byId = new Map(squad.map((p) => [p.id, p]));
  /**
   * **못 나오는 선수는 한 문으로 거른다** (`isAvailable` — season.md §8 불변식).
   * 간이 시뮬도 리그 전체에 카드를 만들고 A매치 휴식기에 컵 결승이 걸리므로,
   * 부상만 거르면 AI 팀이 정지 선수나 소집된 선수를 그대로 내보낸다.
   */
  const available = (p: GamePlayer) => isAvailableFor(state, p, competitionId);
  const startingAssignments = assignmentsOf(state, teamId, "starting");
  const starters: GamePlayer[] = [];
  const slotSetups: SlotSetup[] = [];
  const reserved = new Set(
    startingAssignments
      .filter((a) => {
        const player = byId.get(a.playerId);
        return player && available(player);
      })
      .map((a) => a.playerId),
  );
  const usedIds = new Set<string>();
  for (const a of startingAssignments) {
    const current = byId.get(a.playerId);
    const player =
      current && available(current) && !usedIds.has(current.id)
        ? current
        : pickVacancy(
            squad,
            a.position,
            (p) => available(p) && !usedIds.has(p.id) && !reserved.has(p.id),
          );
    if (!player) continue;
    starters.push(player);
    usedIds.add(player.id);
    const personal = boardSlotOf(state, player);
    const roleId =
      personal.roleId && rolesFor(a.position).some((role) => role.id === personal.roleId)
        ? personal.roleId
        : recallRole(state, player.id, a.position);
    slotSetups.push({
      position: a.position,
      proficiency: proficiencyAt(player, a.position),
      familiarity: personal.familiarity,
      ...(a.point ? { point: a.point } : {}),
      ...(roleId ? { roleId } : {}),
    });
  }
  // 불완전한 배치에서도 골키퍼를 먼저 확보한다.
  for (const player of [...squad]
    .filter((p) => available(p) && !usedIds.has(p.id))
    .sort(
      (a, b) =>
        Number(groupOf(b) === "GK") - Number(groupOf(a) === "GK") ||
        playerOverall(b) - playerOverall(a) ||
        a.id.localeCompare(b.id),
    )) {
    if (starters.length >= 11) break;
    if (groupOf(player) === "GK" && starters.some((p) => groupOf(p) === "GK")) continue;
    starters.push(player);
    usedIds.add(player.id);
    slotSetups.push(boardSlotOf(state, player));
  }

  // 로테이션 — 지친 선발을 같은 포지션군의 신선한 자원으로 바꾼다
  const used = new Set(starters.map((p) => p.id));
  /**
   * **쉬게 한 선수는 그 경기에서 아예 빠진다** — 벤치에도 없고, 뒤 슬롯의 대체
   * 자원도 아니다. 벤치가 OVR 순이라 방금 지쳐서 뺀 에이스가 맨 위에 서면,
   * 투입 후보를 포지션군과 OVR로만 고르는 벤치 정책(`planBenchSubs`)이 그를 되돌린다 —
   * 로테이션이 선발 명단에서만 일어나고 출전 시간에서는 일어나지 않는 것이다.
   * 거르는 자리는 여기 하나다 (match.md §7).
   */
  const rested = new Set<string>();
  for (let i = 0; i < starters.length; i++) {
    const tired = starters[i]!;
    /**
     * **자리를 내주는 이유가 둘이다** — 오늘의 몸(체력 결손)과 시즌의 몸(누적 피로).
     * 둘 중 하나면 대체 자원을 찾는다 (match.md §7 · player.md §5.5).
     */
    if (100 - tired.state.condition < ROTATION_FATIGUE && fatigueOf(tired.state) < ROTATION_LOAD) {
      continue;
    }
    const replacement = squad
      .filter(
        (p) =>
          !used.has(p.id) &&
          // ⚠️ 로테이션도 같은 문을 지난다 — 여기만 부상만 보면 **정지 선수가
          // 대체 자원으로 그라운드에 선다** (실제로 그랬다: 정지 중인 선수가 선발)
          available(p) &&
          groupOf(p) === groupOf(tired) &&
          playerOverall(p) >= playerOverall(tired) - ROTATION_OVR_DROP &&
          p.state.condition >= tired.state.condition + ROTATION_FRESHER &&
          // 시즌의 몸도 함께 본다 — 더 지친 사람으로 바꾸면 로테이션이 뒤로 간다
          fatigueOf(p.state) <= fatigueOf(tired.state),
      )
      .sort((a, b) => playerOverall(b) - playerOverall(a))[0];
    /**
     * 조건에 맞는 자원이 없어도 **다리가 멎었으면 뺀다** — 같은 포지션군에서
     * 가장 신선한 사람으로. 이 갈래가 없으면 대체 불가한 스타는 0까지 간다.
     */
    const fallback =
      tired.state.condition <= EXHAUSTED_CONDITION
        ? squad
            .filter(
              (p) =>
                !used.has(p.id) &&
                available(p) &&
                groupOf(p) === groupOf(tired) &&
                p.state.condition > tired.state.condition + 10,
            )
            .sort((a, b) => b.state.condition - a.state.condition)[0]
        : undefined;
    const picked = replacement ?? fallback;
    if (!picked) continue;
    /**
     * **자리는 사람과 함께 움직인다.** 전술판의 자리(좌표·역할)는 그대로 두되
     * 숙련도·적응도는 들어온 선수의 것으로 다시 선다. 물려받으면 경기 입력이
     * 그라운드에 없는 사람의 숫자로 서서, 약해진 라인업이라는 로테이션의 대가가
     * 장부에 안 잡히거나 엉뚱하게 잡힌다.
     */
    const setup = slotSetups[i]!;
    slotSetups[i] = {
      ...setup,
      proficiency: proficiencyAt(picked, setup.position),
      familiarity: assignmentFor(state, picked.id)?.familiarity ?? FAMILIARITY_BASELINE,
    };
    starters[i] = picked;
    rested.add(tired.id);
    used.add(picked.id);
  }
  /**
   * 벤치 — 교체 자원. 선발과 같은 문(부상·정지)을 지난 다음 OVR 순 아홉 명이되,
   * **로테이션으로 쉬게 한 선수는 빠진다.**
   */
  const picked = new Set(starters.map((p) => p.id));
  const bench = squad
    .filter((p) => !picked.has(p.id) && !rested.has(p.id) && available(p))
    .sort((a, b) => playerOverall(b) - playerOverall(a))
    .slice(0, MATCHDAY_BENCH);
  return {
    teamId,
    starters,
    slots: starters.map((player, index) => ({ player, ...slotSetups[index]! })),
    /**
     * 교체로 들어오는 선수가 **자기 전술 적응도로** 서게 하는 값 — 벤치 선수는
     * `slots`에 없어 이 지도 없이는 나간 선수의 값을 물려받는다.
     */
    familiarity: Object.fromEntries(
      [...starters, ...bench].map((p) => [
        p.id,
        assignmentFor(state, p.id)?.familiarity ?? FAMILIARITY_BASELINE,
      ]),
    ),
    tactics: tacticsOf(state, teamId).spec,
    managerTactics: managerTacticsOf(state, teamId),
    /**
     * 죽은 공 지정과 지시 — **AI 팀도 지난다.** 여기가 리그의 나머지 2,000여 경기가
     * 죽은 공을 세우는 자리라, 빠뜨리면 가담·수비 축이 감독의 경기에만 서고
     * 리그의 세트피스 득점 비율(`pnpm balance world-season`)이 그 축을 못 읽는다.
     * 지정도 같은 자리에서 실린다 — 자리를 잃은 감독의 옛 구단이 이 길로 오고,
     * 두 함수 중 하나만 실으면 같은 팀이 대회마다 다른 사람을 세운다.
     */
    ...(tacticsOf(state, teamId).setPieceTakers
      ? { setPieceTakers: tacticsOf(state, teamId).setPieceTakers }
      : {}),
    ...(tacticsOf(state, teamId).setPieceRoutine
      ? { setPieceRoutine: tacticsOf(state, teamId).setPieceRoutine }
      : {}),
    bench,
    proneness: pronenessOf(
      state,
      [...starters, ...bench].map((p) => p.id),
    ),
  };
}
