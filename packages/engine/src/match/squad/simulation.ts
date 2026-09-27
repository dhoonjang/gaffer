import { recallRole } from "../../common/players/role-memory";
import { pickVacancy } from "./vacancy";
import {
  FATIGUE_BAND_FLOOR,
  type GamePlayer,
  naturalPositionOf,
  FAMILIARITY_BASELINE,
  fatigueOf,
  rolesFor,
} from "@story-fm/domain";
import {
  type GameState,
  assignmentFor,
  proficiencyAt,
  tacticsOf,
  isLoanedIn,
  benchRunOf,
  groupOf,
  firstTeamPlayers,
  isAvailableFor,
  assignmentsOf,
  MATCHDAY_BENCH,
} from "../../common/core/state";
import { type SimSquad } from "../flow/quick-sim";
import { managerTacticsOf } from "../flow/manager-tactics";
import { pronenessOf } from "../../common/players/injury";

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
 * **임대 자원이 자리를 얻는 기량 여유** — 로테이션 문턱(`ROTATION_OVR_DROP` 7)보다
 * 넓다 (→ docs/common/season.md §2 임대).
 *
 * 로테이션이 묻는 것은 "더 나은 선택이 있는가"이고 임대가 묻는 것은 "쓰겠다고 하고
 * 데려왔는가"다. 임대는 **출전을 사는 거래**라 빌린 구단이 주급을 나눠 내는 대가로
 * 그를 세운다 — 7이면 아카데미 유망주는 어떤 자리도 받지 못한다(1부 최약체의 선발
 * 커트가 71인데 유망주의 종합은 60대 중반이다).
 *
 * ⚠️ **넓히면 임대처를 고르는 일이 판단이 아니게 된다.** 창이 사라지면 어디로
 * 보내도 뛰므로 감독이 "뛸 수 있는 곳"을 찾을 이유가 없어진다. 10은 같은 1부
 * 안에서 약체와 강호를 가르는 폭이다(선발 커트 71 대 80).
 */
export const LOAN_ROTATION_OVR_DROP = 10;

/**
 * **빌린 구단이 임대 자원을 연속으로 앉혀 두는 상한** — 그 구단 1군 경기 기준.
 *
 * 상한에 닿으면 그는 같은 포지션군에서 가장 약한 선발과 자리를 바꾼다(`LOAN_ROTATION_OVR_DROP`
 * 창 안일 때만). 셋은 한 달치가 채 안 되는 일정이라, 리포트가 `no-minutes`를 켜는
 * 문턱(`LOAN_BENCH_RUN_ALERT` 4)보다 **한 칸 앞**이다 — 뛸 자리가 있는 임대는
 * 근거가 켜지기 전에 뛰고, 그래도 켜졌다면 그건 배경음이 아니라 사건이다(부상·
 * 정지이거나 그 구단에 그가 설 자리가 없다).
 *
 * 지금은 모든 임대가 같은 상한을 진다. 계약에 출전 보장 조항이 서면 상한이 계약마다
 * 갈리고, 집행하는 자리는 여기 하나다.
 */
export const LOAN_REST_LIMIT = 3;

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

/** 이 선수가 로테이션 자리를 받는 기량 여유 — 임대 자원은 창이 넓다 (season.md §2 임대) */
function rotationDropFor(player: GamePlayer): number {
  return isLoanedIn(player) ? LOAN_ROTATION_OVR_DROP : ROTATION_OVR_DROP;
}

/**
 * **임대 자원이 먼저 선다** — 자리가 열리면 그 자리는 빌린 구단이 그를 데려온
 * 자리다 (season.md §2 임대). 같은 조건의 스쿼드 자원과 나란히 서면 임대가 이기고,
 * 그다음은 원래의 잣대(기량·체력)가 가른다.
 */
function loanFirstThen(
  then: (a: GamePlayer, b: GamePlayer) => number,
): (a: GamePlayer, b: GamePlayer) => number {
  return (a, b) => (isLoanedIn(b) ? 1 : 0) - (isLoanedIn(a) ? 1 : 0) || then(a, b);
}

/**
 * **연속 미출전 상한** — 그 구단 1군 경기 `LOAN_REST_LIMIT`회 연속 못 뛴 임대
 * 자원을 선발에 세운다 (season.md §2 임대).
 *
 * 자리는 **같은 포지션군에서 가장 약한 선발**의 것이고, 그와의 기량 차가
 * `LOAN_ROTATION_OVR_DROP` 창 안일 때만 바꾼다 — 창 밖으로 보낸 유망주는 한 경기도
 * 못 뛰고, 그 사실이 `no-minutes`로 감독에게 온다(그래서 임대처 선택이 판단이 된다).
 *
 * 자리 자체는 판의 것이다: 좌표·역할은 그대로 두고 숙련도·적응도만 들어온 선수의
 * 것으로 다시 선다 — 로테이션과 같은 규약이다.
 */
function seatOverdueLoanees(
  state: GameState,
  squad: readonly GamePlayer[],
  starters: GamePlayer[],
  slotSetups: SlotSetup[],
  available: (player: GamePlayer) => boolean,
): void {
  // 대부분의 구단에 임대 자원이 없다 — 장부를 훑기 전에 여기서 끝난다
  const loanees = squad.filter((p) => isLoanedIn(p) && available(p));
  if (loanees.length === 0) return;
  const seated = new Set(starters.map((p) => p.id));
  for (const loanee of loanees) {
    if (seated.has(loanee.id)) continue;
    if (benchRunOf(state, loanee) < LOAN_REST_LIMIT) continue;
    let index = -1;
    for (let i = 0; i < starters.length; i++) {
      const seat = starters[i]!;
      // 임대 자원끼리는 자리를 뺏지 않는다 — 그쪽에도 같은 빚이 있다 (`admitOnLoan`과 같은 규약)
      if (isLoanedIn(seat)) continue;
      if (groupOf(seat) !== groupOf(loanee)) continue;
      if (loanee.attributes.overall < seat.attributes.overall - LOAN_ROTATION_OVR_DROP) continue;
      if (index < 0 || seat.attributes.overall < starters[index]!.attributes.overall) index = i;
    }
    if (index < 0) continue;
    const setup = slotSetups[index]!;
    slotSetups[index] = {
      ...setup,
      proficiency: proficiencyAt(loanee, setup.position),
      familiarity: assignmentFor(state, loanee.id)?.familiarity ?? FAMILIARITY_BASELINE,
    };
    seated.delete(starters[index]!.id);
    starters[index] = loanee;
    seated.add(loanee.id);
  }
}

/**
 * 간이 시뮬 입력 조립 — 전술 배치에서 가용 선발을 뽑는다.
 *
 * 부상·정지로 빈 자리를 메우고, **임대 자원에게 진 빚을 갚고**(season.md §2 임대),
 * **지친 선발은 로테이션**한다. 대항전에 나가는 팀은 주중 경기가 늘어 이 부담을
 * 실제로 지고, 그 대가는 약해진 라인업이다 (유저 팀은 감독이 직접 라인업을 짜므로
 * 이 함수를 쓰지 않는다 — 우리가 빌려 온 선수를 세울지는 라인업 화면의 결정이다).
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
        b.attributes.overall - a.attributes.overall ||
        a.id.localeCompare(b.id),
    )) {
    if (starters.length >= 11) break;
    if (groupOf(player) === "GK" && starters.some((p) => groupOf(p) === "GK")) continue;
    starters.push(player);
    usedIds.add(player.id);
    slotSetups.push(boardSlotOf(state, player));
  }

  /**
   * **앉혀만 두지는 못한다** — 임대는 출전을 사는 거래다 (season.md §2 임대).
   *
   * 그 구단 1군 경기 `LOAN_REST_LIMIT`회 연속 명단 밖이던 임대 자원은 같은
   * 포지션군에서 **가장 약한 선발**과 자리를 바꾼다. 로테이션보다 먼저 서는 이유는
   * 이 문이 피로를 묻지 않기 때문이다: 주 1경기 리듬의 팀은 로테이션 문턱에 아무도
   * 닿지 않아, 로테이션에만 얹으면 대항전 없는 구단으로 나간 유망주가 한 시즌을
   * 통째로 앉아 있게 된다.
   */
  seatOverdueLoanees(state, squad, starters, slotSetups, available);

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
          p.attributes.overall >= tired.attributes.overall - rotationDropFor(p) &&
          p.state.condition >= tired.state.condition + ROTATION_FRESHER &&
          // 시즌의 몸도 함께 본다 — 더 지친 사람으로 바꾸면 로테이션이 뒤로 간다
          fatigueOf(p.state) <= fatigueOf(tired.state),
      )
      .sort(loanFirstThen((a, b) => b.attributes.overall - a.attributes.overall))[0];
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
            .sort(loanFirstThen((a, b) => b.state.condition - a.state.condition))[0]
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
    .sort((a, b) => b.attributes.overall - a.attributes.overall)
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
