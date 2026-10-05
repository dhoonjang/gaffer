"use client";

import { GrowthOutlook } from "@/shared/growth-outlook";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MATCHDAY_BENCH,
  SET_PIECE_ROLES,
  TACTIC_AXES,
  adaptationOf,
  ageOf,
  anchorOf,
  defaultRoleOf,
  formatMoney,
  positionAtPoint,
  positionGroupOf,
  positionProficiency,
  rolesFor,
  separateBoardPoints,
  shapeOf,
  snapToBoard,
  type BoardPoint,
  type SetPieceRole,
  type SetPieceRoutineKey,
  type SetPieceRoutineLevel,
} from "@story-fm/domain";
import type { GamePayload, GameSlice } from "@/game/store";
import type { MatchBoardOrder } from "@/shared/match-orders";
import { slotOverallOf } from "@/screens/squad/slot-overall";
import {
  familiarityForRole,
  lineupBody,
  resetRolesForMovedPlayers,
  roleAtSlot,
  swappedLists,
  type BoardState,
} from "@/screens/squad/board-roles";
import { IconBoard, IconClose, IconPerson, SPEAKER_ICON } from "@/shared/icons";
import { usePlayerCardActions } from "@/shared/player-card";
import { contractUntil, humanDate } from "@/shared/dateline";
import { PitchChip, PitchGround } from "../../shared/pitch";
import { createLineupSaver, type LineupSaveOutcome, type LineupSaver } from "./lineup-saver";
import { useBoardDrag } from "./board-drag";
import { Margin } from "../../shared/player-marks";
import { PlayerDetail } from "./player-detail";
import { SquadTable, type SortKey } from "./squad-table";
import { SetPiecePanel, TacticsPanel } from "./tactics-panel";
import type {
  BoardSlot,
  OfficeStaff,
  Selection,
  SetPieceRoutineView,
  SetPieceTakersView,
  SquadRow,
  TacticsView,
  Tier,
} from "./types";

/**
 * 신원이 고정된 콜백 — 항상 **최신 클로저**를 부른다.
 *
 * 드래그 중에는 프레임마다 렌더가 도는데, 명단에 넘기는 콜백이 매번 새 함수면
 * `useMemo`가 무조건 깨져 43행을 다시 그린다. 그렇다고 의존성에서 빼면 옛 상태를
 * 붙든 콜백이 남는다. 참조로 최신 함수를 가리키면 둘 다 피할 수 있다.
 */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/** 골키퍼 자리 수 — 정확히 1이 아니면 서버가 반려하므로 저장을 보류한다 */
const gkCountOf = (b: BoardState) => b.points.filter((p) => positionAtPoint(p) === "GK").length;

export function SquadView({
  game,
  onUpdate,
  onGoToChat,
  onOrder,
  boardOpen = true,
  onToggleBoard,
  saver: sharedSaver,
}: {
  game: GamePayload;
  /** 저장이 바꾼 뷰만 온다 — 화면이 쥔 payload에 얹는 일은 바깥이 한다 */
  onUpdate: (slice: GameSlice) => void;
  onGoToChat: () => void;
  /**
   * 전술판을 펼쳐 두었나 — **접으면 명단만 남는다.**
   *
   * 채팅 옆에 나란히 설 때 스쿼드가 통째로 들어오면 전술판이 200px로 눌려 아무
   * 쓸모가 없다. 감독이 채팅을 보며 곁눈질하는 것은 대개 **명단**이고(누가 부상인가,
   * 누가 폼이 좋은가), 판을 만지는 것은 그 자체로 하나의 일이다. 그래서 명단이 먼저
   * 오른쪽에 서고, 판을 펼치면 그때 화면을 통째로 쓴다.
   */
  boardOpen?: boolean;
  /** 펼침을 뒤집는다 — 주지 않으면 손잡이를 그리지 않는다(경기 중 전술판 탭) */
  onToggleBoard?: () => void;
  /**
   * 경기 중 판 조작을 오퍼레이터 지시로 GM에 전달한다.
   * 교체 횟수와 적응도 검증은 코어가 담당한다.
   */
  onOrder?: (order: MatchBoardOrder) => void;
  /**
   * 자동 저장 대기열 — **화면이 쥐고 있으면 턴이 나가기 전에 비워진다.**
   *
   * 판이 자기 안에서만 예약을 들고 있으면 채팅은 그것을 모른 채 턴을 보내고,
   * 서버는 옛 배치로 GM 입력을 만든다 (lineup-saver.ts).
   */
  saver?: LineupSaver;
}) {
  const squad = game.views.squad;
  const players = squad.players;
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const boardRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = viewRef.current;
    const scroll = view?.closest(".view-scroll");
    const summary = view?.querySelector<HTMLElement>(".squad-summary");
    const head = view?.querySelector<HTMLElement>(".squad-head");
    if (!view || !scroll || !summary || !head) return;
    // 요약이 줄바꿈할 때만 CSS sticky의 시작 높이를 갱신한다.
    const measure = () => {
      const height = head.getBoundingClientRect().height || summary.getBoundingClientRect().height;
      view.style.setProperty("--squad-sticky-top", `${height}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(summary);
    observer.observe(head);
    measure();
    return () => {
      observer.disconnect();
      view.style.removeProperty("--squad-sticky-top");
    };
  }, []);
  /** 직접 저장할 수 있는가 — 경기 중과 커리어가 끝난 뒤에는 아니다 (뷰의 `editable`이 판정한다) */
  const live = squad.editable;
  /** 커리어 종료 — 판은 옛 구단의 것이라 잠겨 있다 (career.md §5). 여기서는 문구만 가른다 */
  const dismissed = game.views.career.dismissal !== null;
  /** 경기 중이지만 **판으로 지시할 수는 있다** */
  const advisory = !live && onOrder !== undefined;
  /** 경기 중 우리 쪽 교체 사용량 — 한도는 국면이 정해 뷰가 싣는다 (match.md §8) */
  const liveMatch = game.views.match;
  /** 킥오프를 지났나 — 그 뒤로 심경 한 줄은 지난 경기의 것이라 서지 않는다 */
  const matchOn = liveMatch !== null && !liveMatch.beforeKickoff;
  const matchSubs =
    liveMatch && !liveMatch.beforeKickoff
      ? { ...liveMatch.subs[liveMatch.home.ours ? "home" : "away"], limit: liveMatch.subs.limit }
      : null;
  /** 판을 만질 수 있는가 — 저장이든 지시든 */
  const usable = live || advisory;

  // 서버가 준 배치 — 이 값이 바뀌면(저장 완료·채팅 지시) 작업 사본을 다시 맞춘다
  const serverBoard = useMemo<BoardState>(() => {
    const starters = players.filter((p) => p.role === "선발");
    return {
      points: starters.map((p) => p.assignedPoint ?? anchorOf(p.assignedPosition ?? "CM")),
      occupants: starters.map((p) => p.id),
      bench: players.filter((p) => p.role === "벤치").map((p) => p.id),
      reserve: players.filter((p) => p.squadLevel === "reserve").map((p) => p.id),
      roles: Object.fromEntries(
        players.filter((p) => p.roleId !== null).map((p) => [p.id, p.roleId!]),
      ),
      tactics: squad.tactics,
      // 지정만 씨로 받는다 — 지정이 없을 때 설 사람은 코어가 내는 값이라 판이 쥐지 않는다
      setPieces: Object.fromEntries(
        SET_PIECE_ROLES.map((role) => [role, squad.setPieces[role].designated]),
      ) as Record<SetPieceRole, string | null>,
      // 두 축은 뷰가 이미 중립까지 펴서 준다 — 그대로 씨로 받는다
      setPieceRoutine: squad.setPieceRoutine,
    };
  }, [players, squad.tactics, squad.setPieces, squad.setPieceRoutine]);

  const [board, setBoard] = useState<BoardState>(serverBoard);
  const [selection, setSelection] = useState<Selection>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 경기 중 판에서 만들었지만 아직 다음 진행 턴으로 보내지 않은 작업 사본 */
  const [advisoryPending, setAdvisoryPending] = useState(false);
  const [roster, setRoster] = useState<"first" | "reserve">("first");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "role", desc: false });

  // 자동 저장 — rev는 로컬 변경 번호. 저장된 번호보다 앞서 있으면 아직 서버에 안 갔다
  const revRef = useRef(0);
  const savedRevRef = useRef(0);
  const dirty = revRef.current !== savedRevRef.current;
  // 예약·진행 중인 저장은 판 바깥이 쥔다 — 턴이 나가기 전에 화면이 비운다.
  // 혼자 서는 자리(테스트·판만 그리는 화면)에서는 제 것을 만들어 쓴다.
  const ownSaverRef = useRef<LineupSaver | null>(null);
  ownSaverRef.current ??= createLineupSaver();
  const saver = sharedSaver ?? ownSaverRef.current;
  /** 서버가 아는 2군 명단 — 저장할 때 "무엇이 달라졌는지"의 기준점 */
  const serverReserveRef = useRef<Set<string>>(new Set(serverBoard.reserve));
  serverReserveRef.current = new Set(serverBoard.reserve);
  /** 서버가 아는 키커 지정 — 같은 기준점. 같은 값을 다시 보내면 편집 노트가 남는다 */
  const serverTakersRef = useRef<SetPieceTakersView>(squad.setPieces);
  serverTakersRef.current = squad.setPieces;
  /** 서버가 아는 죽은 공 지시 — 키커와 같은 기준점 */
  const serverRoutineRef = useRef<SetPieceRoutineView>(squad.setPieceRoutine);
  serverRoutineRef.current = squad.setPieceRoutine;
  /**
   * 서버가 준 행 — 저장 본문이 "이 역할을 코어가 스스로 낼 수 있는가"를 재는 기준점.
   * 기억이 들어 있어 되찾기 3단을 여기서 다시 밟을 수 있다 (player.md §3.2).
   */
  const rowsRef = useRef<Map<string, SquadRow>>(byId);
  rowsRef.current = byId;

  const post = useCallback(
    (snapshot: BoardState) =>
      fetch(`/api/games/${game.id}/lineup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          lineupBody(
            snapshot,
            serverReserveRef.current,
            rowsRef.current,
            serverTakersRef.current,
            serverRoutineRef.current,
          ),
        ),
      }),
    [game.id],
  );

  const save = useCallback(
    async (snapshot: BoardState, rev: number): Promise<LineupSaveOutcome> => {
      // 골키퍼가 어긋난 배치는 서버가 반려한다 — 보내지 않고 대기열에 남긴다.
      // 화면은 이미 이유를 말하고 있고(`gkIssue`), 고칠 때까지 턴도 나가지 않는다.
      if (gkCountOf(snapshot) !== 1)
        return { ok: false, error: "GK 자리가 한 곳이 될 때까지 저장이 보류됩니다", keep: true };
      setSaving(true);
      setSaveError(null);
      try {
        const res = await post(snapshot);
        const data = await res.json();
        if (!res.ok) {
          /**
           * 턴이 잠금을 쥐고 있다(`retry`) — 이 편집은 **대기열에 남는다.** 판은
           * 그대로 두고 다음 자동 저장이 같은 배치를 다시 보낸다 (models.md §1-1).
           */
          if (data.retry === true) {
            const busy = (data.error as string | undefined) ?? "저장 실패";
            setSaveError(busy);
            return { ok: false, error: busy, keep: true };
          }
          throw new Error(data.error ?? "저장 실패");
        }
        savedRevRef.current = rev;
        onUpdate(data);
        return { ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        setSaveError(error);
        return { ok: false, error };
      } finally {
        setSaving(false);
      }
    },
    [onUpdate, post],
  );

  /** 로컬 변경을 반영하고 저장을 예약한다 — 모든 전술판 조작이 이 문을 지난다 */
  /**
   * 편집 하나를 확정하고 자동 저장을 예약한다.
   *
   * 기본은 **선택 해제**다 — 배치를 바꾸면 고른 선수가 방금 다른 자리로 갔으므로
   * 그 선택을 들고 있을 이유가 없다. 다만 `keepSelection`을 주면 유지한다:
   * **세부 역할처럼 그 선수를 계속 보면서 고르는 조작**이 있다. 이걸 구분하지
   * 않던 때는 역할 알약을 누르는 순간 상세가 접혀서, 저장은 되는데 아무 일도
   * 일어나지 않은 것처럼 보였다.
   */
  const commit = useCallback(
    (next: BoardState, opts?: { keepSelection?: boolean }) => {
      revRef.current += 1;
      const rev = revRef.current;
      setBoard(next);
      if (opts?.keepSelection !== true) setSelection(null);
      saver.schedule(() => save(next, rev));
    },
    [save, saver],
  );

  // 서버 값이 바뀌면 작업 사본을 맞춘다. 저장 안 된 로컬 변경이 있으면 덮지 않는다
  // (드래그 중에 이전 저장의 응답이 도착하는 경우)
  useEffect(() => {
    if (revRef.current !== savedRevRef.current) return;
    setBoard(serverBoard);
    setAdvisoryPending(false);
  }, [serverBoard]);

  // 탭을 떠나 언마운트될 때 예약된 저장을 흘려보낸다 (마지막 조작을 잃지 않게).
  // 기다리지는 않지만 대기열이 그 요청을 쥐고 있어, 곧바로 나가는 턴은 이것부터 기다린다.
  useEffect(() => () => void saver.flush(), [saver]);

  const boardSlots: BoardSlot[] = board.points.map((point, i) => {
    const playerId = board.occupants[i];
    return playerId ? { playerId, point } : null;
  });
  // 실제 배치에서 읽어낸 포메이션 숫자 (드래그 중에도 즉시 갱신된다)
  const shape = shapeOf(board.points);
  const onPitch = new Set(board.occupants);
  // 로컬 편집 기준 — 방금 올린 2군 선수가 저장 전까지 2군 탭에 남아 있으면 안 된다
  const localReserve = new Set(board.reserve);
  const benchPlayers = players.filter((p) => !localReserve.has(p.id) && !onPitch.has(p.id));
  const benchSet = new Set(board.bench.filter((id) => !onPitch.has(id)));
  const benchDesignated = benchPlayers.filter((p) => benchSet.has(p.id));
  /**
   * 벤치 정원이 찼는가 — **계기판과 손잡이를 함께 움직이는 한 값이다.**
   *
   * 계기판이 `9/9`라고 말하는 순간 「매치데이 벤치로」가 잠기고, 그 반대도 없다. 세는
   * 몫이 갈리면 8/9인데 잠긴 손잡이가 생기고, 화면이 무엇을 세고 있는지 알 수 없다
   * (team.md §6 매치데이 명단).
   */
  const benchFull = benchDesignated.length >= MATCHDAY_BENCH;
  /**
   * 화면의 죽은 공 키커 — **지정은 아직 저장되지 않은 선택까지, 서는 사람은 서버 값.**
   *
   * 기본값 규칙(그라운드 위 킥력 최고)은 코어 한 자리에만 산다(match.md §2 키커 지정) —
   * 화면이 그것을 다시 재면 명단이 예고한 키커와 90분이 세우는 키커가 갈린다. 다만
   * **지정한 사람이 판 위에 있으면 그가 찬다**는 것은 규칙이 아니라 지정의 뜻이라,
   * 그 한 줄만 여기서 즉시 답한다 — 방금 고른 이름이 3초 뒤에야 서는 것처럼 보이지
   * 않게. 지정을 **푼** 직후의 한 박자만 서버가 옛 지정자를 들고 있고, 다음 자동 저장
   * 응답이 제 값으로 맞춘다.
   */
  const takers = Object.fromEntries(
    SET_PIECE_ROLES.map((role) => {
      const designated = board.setPieces[role];
      return [
        role,
        {
          designated,
          taker:
            designated !== null && onPitch.has(designated)
              ? designated
              : squad.setPieces[role].taker,
        },
      ];
    }),
  ) as SetPieceTakersView;
  /**
   * 키커 후보 — **선발이 먼저**다. 지금 찰 수 있는 사람이 그들이고, 벤치·예비는 다음
   * 경기의 선발일 수 있어 지정만 받는다(그 경기엔 기본값이 선다). 2군은 부를 수
   * 있는 인원이 아니라 목록에 세우지 않는다 — 이미 걸린 지정은 셀렉트가 따로 세운다.
   */
  const takerStarting = board.occupants.flatMap((id) => {
    const p = byId.get(id);
    return p ? [{ id, name: p.name }] : [];
  });
  const takerOthers = benchPlayers.map((p) => ({ id: p.id, name: p.name }));
  const nameOf = (id: string) => byId.get(id)?.name ?? "—";
  /**
   * 화면의 죽은 공 지시 — **아직 저장되지 않은 선택까지.** 작업 사본이 그 칸을 갖지
   * 않는 것은 「지시 없음」이고, 그 값은 뷰가 이미 중립으로 펴 둔 서버 값과 같다 —
   * 화면이 「보통」을 스스로 세우지 않는다.
   */
  const routine = board.setPieceRoutine ?? squad.setPieceRoutine;
  const setPieceKey = SET_PIECE_ROLES.map(
    (role) => `${takers[role].designated ?? ""}>${takers[role].taker ?? ""}`,
  ).join(",");
  // Set·배열은 매 렌더 새 객체라 메모 의존성으로 못 쓴다 — 내용으로 만든 키를 쓴다
  const localReserveKey = board.reserve.join(",");
  const benchKey = [...benchSet].join(",");
  /**
   * 지금 화면의 역할 — **아직 저장되지 않은 선택까지 포함한다.**
   *
   * 칩·명단·상세가 저마다 `p.roleId`(서버 값)를 보던 때는 알약을 눌러도 숫자가
   * 자동 저장 왕복(3초)이 끝난 뒤에야 따라왔다. 감독이 "이 역할로 바꾸면 얼마가
   * 되나"를 손으로 더듬어 볼 수가 없다.
   */
  const roleOf = (p: SquadRow): string | undefined => {
    const i = board.occupants.indexOf(p.id);
    // 자리가 없으면 역할도 없다 (player.md §3.1)
    if (i < 0) return undefined;
    return board.roles[p.id] ?? roleAtSlot(p, positionAtPoint(board.points[i]!));
  };

  /**
   * 화면의 현재 배치·역할에 맞춰 명단 행을 계산한다.
   * 자동 저장을 기다리지 않고 전술판 칩과 같은 slotOverallOf를 사용한다.
   */
  const localRows = useMemo(
    () =>
      players.map((p) => {
        const idx = board.occupants.indexOf(p.id);
        const code = idx >= 0 ? positionAtPoint(board.points[idx]!) : null;
        const role = board.roles[p.id] ?? (code ? roleAtSlot(p, code) : undefined);
        if (code === p.assignedPosition && role === (p.roleId ?? undefined)) return p;
        const fit = code ? positionProficiency(p.positions, code, p.foot) : p.positionFit;
        /**
         * 전술 적응도도 여기서 맞춘다 — 서버 값 그대로 두면 역할을 바꾼 직후
         * OVR만 움직이고 적응도는 옛 값에 머물러, **같은 화면의 두 숫자가 다른
         * 시점을 가리킨다** (player.md §7.2).
         *
         * ⚠️ **배치가 없던 선수는 아침 값부터 다르다.** 코어는 배치되는 순간
         * 선반(2군·예비를 다녀온 값)을 먼저 보고 없을 때만 `min(기준선, 팀 적응도)`를
         * 준다 — 그 규칙은 뷰가 `familiarityIfSlotted`로 이미 매겨 준다. 화면이 다시
         * 계산하면 돌아온 주전을 60으로 예고했다가 저장 응답에서 혼자 튄다.
         */
        const morning = p.role === "스쿼드" ? p.familiarityIfSlotted : p.familiarity;
        const familiarity =
          code && role ? familiarityForRole({ ...p, familiarity: morning }, code, role) : morning;
        return {
          ...p,
          assignedPosition: code,
          slotOverall: slotOverallOf(p, code, role),
          positionFit: fit,
          familiarity,
          adaptation: adaptationOf(fit, familiarity, code ?? p.assignedPosition ?? p.position),
        };
      }),
    [players, board.occupants, board.points, board.roles],
  );

  /** 감독이 고른 세부 역할의 지문 — 명단 표를 다시 그릴지 가리는 값 */
  const rolesKey = Object.entries(board.roles)
    .map(([id, role]) => `${id}:${role}`)
    .sort()
    .join(",");
  const onPitchKey = board.occupants.join(",");

  /** 비선발 선수를 매치데이 벤치(최대 9)로 지정/해제 — 나머지는 예비 스쿼드 */
  function toggleBench(id: string) {
    if (!live) return;
    const leaving = benchSet.has(id);
    /** 벤치 정원이 찼으면 추가를 저장하지 않는다. 해제는 허용한다. */
    if (!leaving && benchFull) return;
    const next = leaving ? board.bench.filter((x) => x !== id) : [...board.bench, id];
    commit({ ...board, bench: next });
  }

  function changeTactics(patch: Partial<TacticsView>) {
    if (advisory) {
      // 경기 중 — 축 하나를 바꾸면 그 한 줄이 곧 지시다
      const [key, value] = Object.entries(patch)[0] ?? [];
      const axis = TACTIC_AXES.find((a) => a.key === key);
      if (!axis || typeof value !== "number") return;
      setBoard({ ...board, tactics: { ...board.tactics, [axis.key]: value } });
      setAdvisoryPending(true);
      return onOrder?.({ kind: "tactic", axis: axis.key, value });
    }
    if (!live) return;
    commit({ ...board, tactics: { ...board.tactics, ...patch } });
  }

  /**
   * 선택-스왑: 자리↔자리는 선수 교환(좌표는 그대로), 자리↔명단은 선수 교체.
   *
   * 이미 선발인 선수를 명단에서 골라 다른 자리에 넣으면 같은 선수가 두 자리에 앉는다.
   * 그 경로는 자리 교환으로 돌린다.
   */
  function applySwap(a: Selection, b: Selection) {
    if (!a || !b || !live) return;
    if (a.kind === "bench" && b.kind === "bench") return;
    if (a.kind === "bench") {
      const already = board.occupants.indexOf(a.id);
      if (already >= 0) return applySwap({ kind: "slot", index: already }, b);
    }
    if (b.kind === "bench") {
      const already = board.occupants.indexOf(b.id);
      if (already >= 0) return applySwap(a, { kind: "slot", index: already });
    }

    const occupants = [...board.occupants];
    let bench = [...board.bench];
    if (a.kind === "slot" && b.kind === "slot") {
      const tmp = occupants[a.index]!;
      occupants[a.index] = occupants[b.index]!;
      occupants[b.index] = tmp;
    } else {
      const slot = (a.kind === "slot" ? a : b) as { kind: "slot"; index: number };
      const incoming = (a.kind === "bench" ? a : b) as { kind: "bench"; id: string };
      // 2군 선수는 승격 전에는 라인업에 넣을 수 없다 (서버도 반려한다)
      const incomingRow = byId.get(incoming.id);
      if (incomingRow && incomingRow.squadLevel === "reserve") {
        return setSelection(null);
      }
      const outgoing = occupants[slot.index]!;
      occupants[slot.index] = incoming.id;
      // 올라간 선수는 벤치 지정에서 빼고, 내려온 선수를 벤치에 넣는다
      bench = bench.filter((x) => x !== incoming.id);
      if (bench.length < MATCHDAY_BENCH) bench.push(outgoing);
    }
    commit(resetRolesForMovedPlayers({ ...board, occupants, bench }, byId));
  }

  /**
   * 자유 배치 — 한 자리의 좌표만 옮기고, 옮긴 자리를 고정한 채 나머지를 비켜세운다.
   * 격자에 맞춰(snapToBoard) 손으로 놓은 자리도 줄이 맞는다.
   */
  function repositionSlot(index: number, point: BoardPoint) {
    const points = [...board.points];
    points[index] = snapToBoard(point);
    const next = resetRolesForMovedPlayers(
      { ...board, points: separateBoardPoints(points, index) },
      byId,
    );
    if (advisory) {
      const playerId = board.occupants[index];
      const target = next.points[index];
      if (!playerId || !target) return;
      setBoard(next);
      setAdvisoryPending(true);
      return onOrder?.({
        kind: "position",
        playerId,
        position: positionAtPoint(target),
        point: target,
      });
    }
    if (live) commit(next);
  }

  /**
   * 전술판 칩을 누른다 — **고르기만 한다.** 누른다고 자리가 바뀌지 않는다.
   * 자리끼리 맞바꾸는 건 드래그뿐이고(칩을 끌어 다른 칩 위에), 명단에서 데려오는 건
   * 그 행의 화살표 버튼뿐이다. 같은 칩을 다시 누르면 선택이 풀린다.
   */
  function clickSlot(index: number) {
    const here: Selection = { kind: "slot", index };
    if (!usable) return setSelection(board.occupants[index] ? here : null);
    const same = selection?.kind === "slot" && selection.index === index;
    setSelection(same ? null : here);
  }

  /**
   * 명단에서 선수를 누른다 — **상세 보기뿐이다. 라인업은 절대 건드리지 않는다.**
   * 목록을 훑다가 선수 정보를 열었을 뿐인데 배치가 바뀌면 안 된다 —
   * 교체는 자리를 고른 뒤 그 행의 화살표 버튼으로만 일어난다.
   */
  function clickRoster(id: string) {
    const onBoardIndex = board.occupants.indexOf(id);
    const here: Selection =
      onBoardIndex >= 0 ? { kind: "slot", index: onBoardIndex } : { kind: "bench", id };
    const same =
      (selection?.kind === "slot" && selection.index === onBoardIndex) ||
      (selection?.kind === "bench" && selection.id === id);
    setSelection(same ? null : here);
  }

  /** 이 선수가 지금 속한 칸 */
  function tierOf(id: string): Tier {
    if (board.occupants.includes(id)) return "선발";
    if (board.reserve.includes(id)) return "2군";
    return board.bench.includes(id) ? "벤치" : "예비";
  }

  /**
   * 고른 선수와 이 행의 선수가 **칸을 맞바꾼다** — 명단 화살표가 부르는 유일한 경로.
   *
   * 선발·벤치·예비·2군 어떤 조합이든 성립한다: 둘이 서로의 자리를 그대로 넘겨받는다.
   * 2군이 끼면 승격·강등이 함께 일어나므로 1군 인원수는 변하지 않는다(한 명 올라오고
   * 한 명 내려간다) — 라우트가 승격→배치→강등 순으로 한 요청에 처리한다.
   */
  function swapWithRow(rowId: string) {
    if (advisory) {
      const aId = selection?.kind === "slot" ? board.occupants[selection.index] : selection?.id;
      if (!aId || aId === rowId) return;
      // 경기 중에 뜻이 있는 맞바꿈은 **그라운드 ↔ 벤치** 하나뿐이다
      const [outId, inId] = board.occupants.includes(aId) ? [aId, rowId] : [rowId, aId];
      if (!board.occupants.includes(outId) || board.occupants.includes(inId)) return;
      const occupants = [...board.occupants];
      const slot = occupants.indexOf(outId);
      if (slot < 0) return;
      occupants[slot] = inId;
      const bench = board.bench.filter((id) => id !== inId);
      if (bench.length < MATCHDAY_BENCH) bench.push(outId);
      // 장부를 직접 저장하지 않는다. 다음 진행 턴의 substitute 검증 전까지는 작업 사본이다.
      setBoard(resetRolesForMovedPlayers({ ...board, occupants, bench }, byId));
      setAdvisoryPending(true);
      setSelection(null);
      return onOrder?.({ kind: "substitution", out: outId, in: inId });
    }
    if (!live || !selection) return;
    const aId = selection.kind === "slot" ? board.occupants[selection.index] : selection.id;
    if (!aId) return;
    const swapped = swappedLists(board, aId, rowId);
    if (!swapped) return; // 같은 칸끼리는 바꿀 게 없다 (선발 자리 교환은 드래그)
    commit(resetRolesForMovedPlayers({ ...board, ...swapped }, byId));
  }

  /**
   * 칩 끌기 — 끌린 결과만 받는다. 다른 칩 위면 자리 교환(저장 가능할 때만),
   * 빈 곳이면 그 자리로 이동이다 (`board-drag.ts`).
   */
  const drag = useBoardDrag({
    boardRef,
    points: board.points,
    occupants: board.occupants,
    enabled: usable,
    onTap: clickSlot,
    onDrop: (index, point, onto) => {
      if (onto !== null && live) applySwap({ kind: "slot", index }, { kind: "slot", index: onto });
      else repositionSlot(index, point);
    },
  });

  const gkCount = gkCountOf(board);
  const gkIssue = live && gkCount !== 1;
  const xi = board.occupants
    .map((id) => byId.get(id))
    .filter((p): p is SquadRow => p !== undefined);
  /**
   * 선발 평균 — **각자 그 자리에서 내는 값**의 평균이다 (칩에 쓰인 숫자 그대로).
   * `overall`로 재면 센터백을 윙에 세워도 평균이 꿈쩍하지 않아, 판을 잘못 짠 것이
   * 머리 요약에서만 멀쩡해 보인다.
   *
   * ⚠️ **화면이 값을 직접 내는 그 자리다** (overview §5). 전술판은 칩을 옮기는 3초
   * 동안 저장 전 배치를 그리므로 물어볼 뷰가 없다 — 대신 값을 내는 것은 서버와 같은
   * 함수(`slotOverallOf` → `observedFit`) 하나다. 경기 화면의 선발 평균은 저장된
   * 배치라 뷰가 낸다(`match.xiRating`).
   */
  const xiRating =
    xi.length > 0
      ? Math.round(
          xi.reduce((s, p, i) => {
            const point = board.points[board.occupants.indexOf(p.id)] ?? board.points[i];
            const code = point ? positionAtPoint(point) : null;
            return s + (slotOverallOf(p, code, roleOf(p)) ?? p.overall);
          }, 0) / xi.length,
        )
      : 0;

  const selectedPlayer =
    selection?.kind === "slot"
      ? byId.get(board.occupants[selection.index] ?? "")
      : selection?.kind === "bench"
        ? byId.get(selection.id)
        : undefined;
  const selectedSlotCode =
    selection?.kind === "slot" && board.points[selection.index]
      ? positionAtPoint(board.points[selection.index]!)
      : null;
  // 자리를 고르면 명단이 "이 자리에 넣을 선수 고르기" 모드가 된다
  /**
   * 교체 짝 — 고른 선수 하나가 정해지면 **칸이 다른** 모든 행에 화살표가 뜬다.
   * 선발·벤치·예비·2군 어느 조합이든 열린다 (같은 칸끼리만 닫힌다 — 선발 자리
   * 맞바꾸기는 드래그의 몫이라서다).
   */
  const swapPair = (() => {
    if (!usable || !selection) return null;
    const id = selection.kind === "slot" ? (board.occupants[selection.index] ?? "") : selection.id;
    if (!id) return null;
    return { id, name: byId.get(id)?.name ?? "", tier: tierOf(id), slotCode: selectedSlotCode };
  })();
  /** 행마다의 칸 — 로컬 편집 반영 (뷰의 role·squadLevel은 저장 전까지 옛 값이다) */
  const tierById = useStable((id: string): Tier => tierOf(id));
  // 명단에 넘기는 콜백은 전부 신원을 고정한다 (위 useStable 주석 참고)
  const onSelectRow = useStable(clickRoster);
  const onToggleBenchRow = useStable(toggleBench);
  const onSwapInRow = useStable(swapWithRow);
  const onRoleRow = useStable(chooseRole);
  const onMoveSquadRow = useStable(moveSquad);
  // 새 기준은 큰 값부터 보는 게 자연스럽다 — 칸 순(기본)만 위에서 아래로 읽는다
  const onSortRow = useStable((key: SortKey) =>
    setSort((prev) => ({ key, desc: prev.key === key ? !prev.desc : key !== "role" })),
  );

  /**
   * 1·2군 이동은 **선수 카드에서만** 선다 — 명단 상세에 늘 서 있기엔 눈에 너무 띄는
   * 조작이다. 우리 선수의 카드가 열렸을 때만 카드 아래 조작 줄에 세운다.
   */
  const ourIds = useMemo(() => new Set(localRows.map((row) => row.id)), [localRows]);
  const cardActions = useCallback(
    (playerId: string) => {
      // 지금 옮길 수 없으면(경기 중·커리어 종료·선발 배치 중) 버튼 자체를 세우지 않는다
      if (!ourIds.has(playerId) || !live || onPitch.has(playerId)) return null;
      const reserve = localReserve.has(playerId);
      return (
        <button
          type="button"
          data-testid={`squadmove-${playerId}`}
          onClick={() => onMoveSquadRow(playerId, reserve ? "first" : "reserve")}
        >
          {reserve ? "1군 승격" : "2군 강등"}
        </button>
      );
    },
    // 집합은 문자열 열쇠로 싣는다 — 아래 명단 메모와 같은 이유다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ourIds, localReserveKey, onPitchKey, live, onMoveSquadRow],
  );
  usePlayerCardActions(cardActions);

  /**
   * 1·2군 이동 — **다른 조작과 같은 문을 지난다.**
   *
   * 단독 왕복이던 때는 이 버튼만 스피너가 돌았고, 판을 짜는 동안 그 한 요청이
   * 자동 저장과 순서를 다퉜다. `lineupBody`가 서버와 달라진 `reserve`를
   * `squadLevels` 차이로 실어 보내고, 라우트가 승격 → 배치 → 강등 순으로 처리한다.
   */
  function moveSquad(playerId: string, level: "first" | "reserve") {
    if (!live) return;
    const reserve = board.reserve.filter((x) => x !== playerId);
    // 강등은 매치데이 벤치 지정도 함께 거둔다 — 코어가 배치에서 빼기 때문이다(`setSquadLevel`)
    commit({
      ...board,
      reserve: level === "reserve" ? [...reserve, playerId] : reserve,
      bench: level === "reserve" ? board.bench.filter((x) => x !== playerId) : board.bench,
    });
  }

  /**
   * 역할 선택 — **다른 조작과 같은 문을 지난다.**
   * 알약을 누를 때마다 요청을 보내면 결정 하나가 요청 여럿이 되고, 감독이
   * 고르는 동안 서버가 계속 값을 매긴다. 정해진 값 하나만 자동 저장에 실린다.
   */
  function chooseRole(playerId: string, role: string) {
    if (advisory) {
      setBoard({ ...board, roles: { ...board.roles, [playerId]: role } });
      setAdvisoryPending(true);
      return onOrder?.({ kind: "role", playerId, role });
    }
    if (!live) return;
    // 상세를 열어 둔 채 고른다 — 역할은 비교하며 바꾸는 값이다
    commit({ ...board, roles: { ...board.roles, [playerId]: role } }, { keepSelection: true });
  }

  /**
   * 죽은 공 키커 지정 — **역할과 같은 문을 지난다.** 평시엔 자동 저장에 실리고,
   * 경기 중엔 오퍼레이터 지시가 되어 다음 진행 턴에 실린다 (match.md §8). 평시와
   * 경기 중이 같은 명령 하나에 닿는다는 규약을 화면도 그대로 따른다.
   */
  function chooseTaker(role: SetPieceRole, playerId: string | null) {
    const next = { ...board, setPieces: { ...board.setPieces, [role]: playerId } };
    if (advisory) {
      setBoard(next);
      setAdvisoryPending(true);
      return onOrder?.({ kind: "setPiece", role, playerId });
    }
    if (!live) return;
    // 상세를 열어 둔 채 고른다 — 판 아래 줄에서 고르는 값이라 명단이 접힐 이유가 없다
    commit(next, { keepSelection: true });
  }

  /**
   * 죽은 공 지시 — 가담·수비 두 축 (match.md §1.4). **키커와 같은 자동 저장, 같은
   * 요청**이라 여기서도 요청을 따로 보내지 않는다.
   *
   * 경기 중에는 서지 않는다 — 이 축을 다음 진행 턴으로 나르는 지시가 아직 없어
   * (`MatchBoardOrder`) 줄은 읽는 낱말로 선다.
   */
  function chooseRoutine(key: SetPieceRoutineKey, level: SetPieceRoutineLevel) {
    if (!live) return;
    commit({ ...board, setPieceRoutine: { ...routine, [key]: level } }, { keepSelection: true });
  }

  /**
   * 칩의 클래스 — **자리의 색과 상태의 테두리는 다른 채널이다.**
   *
   * 색(배경)은 "이 자리가 무슨 자리인가"를 말한다: 최전방 붉게 · 중원 초록 ·
   * 수비 파랑 · 골키퍼 노랑. 판을 훑을 때 라인이 색 띠로 먼저 읽힌다.
   * 테두리는 **상태**가 이미 쓰고 있다(선택=초록, 못 뛰는 선수=빨강) — 여기에
   * 자리 색까지 얹으면 초록 테두리가 "고른 것"인지 "미드필더"인지 알 수 없다.
   *
   * 색의 근거는 선수의 주 포지션군이 아니라 **지금 서 있는 자리**다. 센터백을
   * 윙에 세우면 그 칩은 최전방 색이어야 판이 실제 배치대로 읽힌다.
   */
  const chipClass = (p: SquadRow | undefined, selected: boolean, code: string | null) => {
    const group = code ? (positionGroupOf(code) ?? null) : null;
    return (
      `${group ? `g-${group.toLowerCase()}` : ""}` +
      `${selected ? " selected" : ""}${p && !p.available ? " unavailable" : ""}`
    );
  };

  /**
   * 명단은 **드래그 프레임마다 다시 그리지 않는다.** 43행 × (게이지·상태바·화살표
   * SVG)를 초당 60번 새로 만들면 정작 손에 붙어야 할 칩이 늦어진다. 드래그가 바꾸는
   * 건 칩 좌표뿐이고 명단은 그와 무관하므로, 드래그 상태를 뺀 값들로만 메모한다.
   */
  const rosterTable = useMemo(
    () => (
      <SquadTable
        players={localRows.filter((p) =>
          roster === "reserve" ? localReserve.has(p.id) : !localReserve.has(p.id),
        )}
        sort={sort}
        onSort={onSortRow}
        selectedId={selectedPlayer?.id ?? null}
        onSelect={onSelectRow}
        swapPair={swapPair}
        tierOf={tierById}
        tierKey={`${onPitchKey}|${benchKey}|${localReserveKey}`}
        onSwapIn={onSwapInRow}
        inMatch={matchOn}
        renderDetail={(p) => (
          <PlayerDetail
            p={p}
            inMatch={matchOn}
            setPieces={takers}
            slotCode={p.id === selectedPlayer?.id ? selectedSlotCode : null}
            onRole={usable ? (role) => onRoleRow(p.id, role) : undefined}
            roleId={board.roles[p.id] ?? p.roleId}
            action={
              /* 벤치 지정 — 비선발 1군에게만 뜻이 있다 (선발은 이미 나가고, 2군은 승격이
                 먼저). 그 밖의 선수에게는 조작 칸 자체가 서지 않는다 */
              live && !onPitch.has(p.id) && !localReserve.has(p.id) ? (
                <button
                  className="ghost-btn"
                  /* 정원이 차면 넣는 길만 잠긴다 — **빼는 길은 늘 열려 있다** */
                  disabled={saving || (benchFull && !benchSet.has(p.id))}
                  /* 잠긴 이유는 **사실로만** — 선수 카드의 1·2군 이동과 같은 결이다 */
                  title={
                    benchFull && !benchSet.has(p.id)
                      ? `매치데이 벤치 ${MATCHDAY_BENCH}자리가 찼다`
                      : undefined
                  }
                  data-testid={`benchtoggle-${p.id}`}
                  onClick={() => onToggleBenchRow(p.id)}
                >
                  {benchSet.has(p.id) ? "벤치에서 빼기" : "매치데이 벤치로"}
                </button>
              ) : undefined
            }
          />
        )}
      />
    ),
    /**
     * ⚠️ 집합·표는 **문자열 열쇠로** 싣는다 (`localReserveKey`·`benchKey`·
     * `onPitchKey`·`rolesKey`). `Set`과 객체는 내용이 같아도 렌더마다 새 객체라,
     * 그것을 그대로 실으면 메모가 매번 깨져 아무것도 아끼지 못한다. 규칙은 열쇠가
     * 무엇을 대신하는지 볼 수 없어 원본이 빠졌다고 읽는다.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      localRows,
      roster,
      localReserveKey,
      sort,
      // 감독이 고른 세부 역할 — 이게 없으면 알약을 눌러도 표가 다시 그려지지 않아
      // 선택이 화면에 안 나타난다(저장은 되는데 아무 일도 안 일어난 것처럼 보인다)
      rolesKey,
      selectedPlayer?.id,
      selectedSlotCode,
      benchKey,
      benchFull,
      onPitchKey,
      setPieceKey,
      live,
      dismissed,
      saving,
      swapPair?.id,
      swapPair?.tier,
      swapPair?.slotCode,
      onSelectRow,
      onToggleBenchRow,
      onSwapInRow,
      onRoleRow,
      onMoveSquadRow,
      onSortRow,
      tierById,
    ],
  );

  return (
    /*
     * 저장 상태는 **글자가 아니라 속성**으로만 남긴다. 화면에 "저장됨"을 띄우면
     * 자동 저장이라 늘 켜져 있는 등이 되지만, 테스트는 저장이 끝났는지를
     * 결정적으로 기다릴 수 있어야 한다.
     */
    <div
      className={`squad-view${boardOpen ? "" : " folded"}`}
      ref={viewRef}
      data-testid="view-squad"
      data-save={
        advisory
          ? advisoryPending
            ? "pending"
            : "ready"
          : !live
            ? "locked"
            : saving
              ? "saving"
              : dirty
                ? "dirty"
                : "saved"
      }
    >
      <div className="squad-head">
        <div className="squad-summary">
          <span>
            {/* 이름은 실제 배치에서 읽는다 — 칩을 옮기면 숫자가 바로 따라 바뀐다 */}
            <b data-testid="shape">{shape}</b> · 선발 평균 <b>{xiRating}</b>
          </span>
          {/* 1군·2군 인원은 오른쪽 명단 탭이 이미 세어 준다 — 여기선 매치데이 인원만 */}
          <span className="muted">매치데이 {xi.length + benchDesignated.length}인</span>
          {matchSubs && (
            <span className="muted">
              교체 {matchSubs.used}/{matchSubs.limit.subs} · 기회 {matchSubs.windows}/
              {matchSubs.limit.windows}
            </span>
          )}
          {advisoryPending && (
            <span className="reg-chip" data-testid="match-orders-pending">
              다음 진행에 반영
            </span>
          )}
          {/* 등록 명단 — 승격의 진짜 벽이라 늘 보여야 한다 (U21은 명단 밖) */}
          <span
            className={`reg-chip${squad.registration.issues.length > 0 ? " over" : ""}`}
            data-testid="registration"
            title={
              squad.registration.issues.length > 0
                ? squad.registration.issues.join(" / ")
                : `21세 초과 ${squad.registration.limit}명까지 · 그중 홈그로운 ${squad.registration.homegrownMin}명 이상 · U21 ${squad.registration.under21}명은 명단 밖`
            }
          >
            등록 <b>{squad.registration.listed}</b>/{squad.registration.limit} · HG{" "}
            <b>{squad.registration.homegrown}</b>/{squad.registration.homegrownMin}
          </span>
          {onToggleBoard && (
            <button
              className={`board-toggle${boardOpen ? " on" : ""}`}
              onClick={onToggleBoard}
              aria-pressed={boardOpen}
              data-testid="board-toggle"
            >
              <IconBoard />
              전술판
            </button>
          )}
        </div>
        {/* 커리어 종료 잠금은 버튼이 아니다 — 돌아갈 경기가 없고, 판의 잠긴 모양이 이미 말한다 */}
        {!live && !advisory && !dismissed && (
          <button className="ghost-btn" onClick={onGoToChat}>
            경기 중 — 채팅으로
          </button>
        )}
      </div>

      {/**
       * 저장이 멈춘 까닭만 여기 선다 — 선수의 결장·낯선 자리는 명단 행과 전술판 칩이 갖는다.
       * GK 자리가 하나가 아니면 서버가 반려하므로 고칠 때까지 저장을 보류한다.
       */}
      {(gkIssue || saveError) && (
        <div className="lineup-status warn" data-testid="lineup-status">
          {gkIssue && <div>GK 자리 {gkCount}곳 — 한 명이 될 때까지 저장이 보류됩니다</div>}
          {saveError && <div data-testid="lineup-error">{saveError}</div>}
        </div>
      )}

      {/**
       * **여름의 유스 후보** — 아직 계약하지 않은 사람들이라 명단 탭이 아니라 제 구획에
       * 선다 (season.md §6). 소집일이 지나면 뷰가 null이라 이 판 자체가 사라진다.
       *
       * 읽는 값만 있다 — 고르는 일은 감독의 말로 일어나고, 여기 선 것은 그 결정의
       * 근거다. 종합은 관측값, 성장 가능성은 추정 단계다: 아직 우리
       * 선수가 아니라 참값을 볼 수 없다 (player.md §9).
       */}
      {squad.youthIntake && (
        <div className="youth-intake" data-testid="youth-intake">
          <div className="youth-intake-head">
            <b>유스 후보 {squad.youthIntake.candidates.length}명</b>
            <span className="muted">소집일 {humanDate(squad.youthIntake.deadline)}</span>
          </div>
          <ul className="youth-intake-list">
            {squad.youthIntake.candidates.map((c) => (
              <li key={c.id} className={c.autoSign ? "auto" : undefined}>
                <span className="yc-pos">{c.position}</span>
                <span className="yc-name">{c.name}</span>
                <span className="muted">{c.age}세</span>
                {/* 안개 속 값 — 물결표 대신 툴팁이 "추정"임을 말한다 (허용 글리프 밖이다) */}
                <span className="yc-ovr" title="추정 종합">
                  {c.overall}
                </span>
                <span className="yc-pot">
                  성장 가능성 <GrowthOutlook growth={c.growth} />
                </span>
                <span className="muted">
                  {formatMoney(c.weeklyWage)}/주 · {c.years}년
                </span>
                {c.autoSign && <span className="reg-chip">구단 계약 예정</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 왼쪽 전술판 · 오른쪽 명단 — 한 화면에서 보고 바로 조작한다.
          접으면 명단만 남아 채팅 옆에 설 수 있다 */}
      <div className="squad-layout">
        {/* 접힘은 **CSS가 정한다** — 채팅이 옆에 설 만큼 넓을 때만 뜻이 있고,
            좁은 화면에서는 접어도 남는 자리를 명단이 늘어나 채울 뿐이다 */}
        <div className="squad-board-col">
          {/**
           * 판과 전술 줄은 **한 덩어리다** — 채팅 위에 얹힐 때 둘이 한 장으로 붙는다.
           * 평소 레이아웃에서는 `display: contents`라 이 래퍼가 없는 것과 같다.
           */}
          <div className="board-stack">
            {/* 그라운드와 칩은 상대 판과 **같은 컴포넌트**다 (pitch.tsx) — 상태만 얹는다 */}
            <PitchGround
              boardRef={boardRef}
              variant={usable ? "editing" : "locked"}
              testId="pitch-board"
              tactics={board.tactics}
            >
              {boardSlots.map((slot, i) => {
                const p = slot ? byId.get(slot.playerId) : undefined;
                // 끌고 있는 칩은 미리보기 좌표로 그린다 (놓기 전엔 실제 배치를 안 바꾼다)
                const dragging = drag.index === i;
                const point = dragging && drag.point ? drag.point : slot?.point;
                const code = point ? positionAtPoint(point) : null;
                /**
                 * 칩의 전력은 **좌표에서 즉시** 나온다 — 서버가 준 값은 저장된 배치
                 * 기준이라 자동 저장(`AUTOSAVE_MS`)과 왕복이 끝나야 바뀌는데, 끌어
                 * 놓고 한 박자 뒤에 숫자가 따라오면 "이 자리로 옮기면 얼마가 되나"를
                 * 손으로 더듬어 볼 수가 없다.
                 *
                 * ⚠️ 계산은 **명단과 같은 함수**(`slotOverallOf`)다. 여기서만 `roleFit`을
                 * 다시 굴리던 때는 같은 선수의 OVR이 칩과 명단에서 달랐다.
                 */
                const liveOverall = p ? slotOverallOf(p, code, roleOf(p)) : null;
                const selected = selection?.kind === "slot" && selection.index === i;
                /**
                 * 맡은 역할 — **기본 역할이 아닐 때만** 칩에 뜬다.
                 * 전원에게 붙이면 열한 칩이 다 같은 말(센터백·풀백·윙어)을 달고 있어
                 * 읽히지 않는다. 감독이 실제로 **고른** 것만 보이면 판을 훑을 때
                 * 그 선택이 눈에 남는다. 표기는 FM 약칭(BPD·IWB·RGA)이다 —
                 * 칩에 들어갈 만큼 짧으면서 감독이 이미 아는 말이다.
                 */
                const liveRole = p ? roleOf(p) : undefined;
                const roleTag =
                  p && code && liveRole && liveRole !== defaultRoleOf(code)
                    ? (rolesFor(code).find((r) => r.id === liveRole) ?? null)
                    : null;
                if (!point) return null;
                return (
                  <PitchChip
                    key={i}
                    as="button"
                    variant={`${chipClass(p, selected, code)}${dragging ? " dragging" : ""}`}
                    style={{ left: `${point.x}%`, top: `${point.y}%` }}
                    onPointerDown={(e) => drag.onPointerDown(i, e)}
                    onClick={() => {
                      // 완전히 잠긴 판만 포인터 핸들러가 없으므로 여기서 상세를 연다
                      if (!usable) clickSlot(i);
                    }}
                    testId={`slot-${i}`}
                    title={
                      p
                        ? // 명단 OVR 칸의 툴팁과 **같은 두 줄**이다 — 같은 숫자를
                          // 두 화면에서 다른 말로 설명하면 규칙이 없어 보인다
                          [
                            `${p.name}`,
                            `${code} 자리 기준 ${liveOverall ?? p.overall} — 경기에서 쓰이는 값입니다`,
                            liveOverall !== null && liveOverall !== p.overall
                              ? `주 포지션(${p.position}) 기준 ${p.overall}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join("\n")
                        : (code ?? "")
                    }
                    code={code}
                    squadNumber={p?.squadNumber}
                    roleTag={roleTag}
                    captain={p?.isCaptain ? "captain" : p?.isViceCaptain ? "vice" : null}
                    name={p?.name ?? null}
                    /* 칩은 "그 자리에 선 선수"라 주 포지션 값이 아니라 자리 값이 맞다.
                         자리가 안 맞으면 이 숫자가 이미 낮다 — 옆에 "포지션 적응도"를
                         따로 세우면 감독이 두 축을 머리로 합쳐야 한다 (적응도는 하나다).
                         툴팁이 주 포지션 값을 갖는다 */
                    ovr={p ? (liveOverall ?? p.overall) : ""}
                    metaExtra={
                      p && (
                        <>
                          <Margin observation={p.observation} />
                          {!p.available && (
                            <span className="slot-flag" role="img" aria-label="출전 불가">
                              <IconClose size={10} />
                            </span>
                          )}
                        </>
                      )
                    }
                  />
                );
              })}
            </PitchGround>

            <TacticsPanel tactics={board.tactics} editing={usable} onChange={changeTactics} />
            {/* 죽은 공은 접히지 않는다 — 절반이 읽는 값이고, 접어 두면 지정한 적 없는
                자리를 감독이 영영 보지 않는다 (match.md §1.4) */}
            <SetPiecePanel
              takers={takers}
              nameOf={nameOf}
              starting={takerStarting}
              others={takerOthers}
              editing={usable}
              onPick={chooseTaker}
              routine={routine}
              routineEditing={live}
              onRoutine={chooseRoutine}
            />
          </div>
        </div>

        <div className="squad-side-col">
          <div className="roster-head">
            {/* 책갈피 — 고른 쪽이 아래 명단과 한 장으로 이어진다 */}
            <div className="roster-tabs" role="tablist">
              {(
                [
                  ["first", "1군", players.length - localReserve.size],
                  ["reserve", "2군", localReserve.size],
                ] as const
              ).map(([key, label, count]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={roster === key}
                  className={`roster-tab${roster === key ? " on" : ""}`}
                  onClick={() => setRoster(key)}
                >
                  {label}
                  <span className="roster-tab-n">{count}</span>
                </button>
              ))}
            </div>
            {/* 조작법 대신 숫자만 — 벤치 정원이 몇 자리 남았는지가 유일하게 필요한 정보다.
              찬 자리는 글자 한 층 올라선다 — 그 순간 명단의 「매치데이 벤치로」가
              잠기므로, 이 숫자가 잠긴 이유다 (design-system.md §1 조작) */}
            <span className="roster-counts" data-testid="bench-count">
              <span className={`roster-count-bench${benchFull ? " full" : ""}`}>
                벤치 {benchDesignated.length}/{MATCHDAY_BENCH}
              </span>{" "}
              · 예비 {benchPlayers.length - benchDesignated.length}
            </span>
          </div>
          <div className="roster-scroll">{rosterTable}</div>
          <StaffPanel staff={squad.staff} today={game.views.calendar.today} />
        </div>
      </div>
    </div>
  );
}

/**
 * **스태프** — 구단이 고용한 사람들 (docs/people/people.md §2-2). 수석코치가 맨 앞이고
 * 그다음이 코치·의료진·스카우트다 — 코어가 그 순서로 실어 보낸다.
 *
 * **읽는 값이다.** 고용·해고가 없어 여기엔 손잡이가 없고, 그래서 유스 후보 줄처럼
 * 테두리 없는 칸으로만 선다 — 버튼처럼 생긴 것이 하나라도 있으면 감독은 여기서
 * 사람을 자를 수 있다고 읽는다.
 *
 * 아이콘은 채팅의 화자 머리와 **같은 표**(`SPEAKER_ICON`)를 본다: 훈련장에서 본 얼굴이
 * 대화에서 말을 걸 때 같은 그림이어야 그 사람인 줄 안다.
 */
function StaffPanel({ staff, today }: { staff: OfficeStaff[]; today: string }) {
  if (staff.length === 0) return null;
  return (
    <div className="club-staff" data-testid="club-staff">
      <div className="club-staff-head">
        <h2 className="section-title">스태프</h2>
        <span className="muted">{staff.length}명</span>
      </div>
      <ul className="club-staff-list">
        {staff.map((person) => {
          const Icon = SPEAKER_ICON[person.role] ?? IconPerson;
          return (
            <li key={person.name}>
              <span className="cs-icon" aria-hidden>
                <Icon size={13} />
              </span>
              <div className="cs-person">
                <div className="cs-heading">
                  <span className="cs-name">{person.name}</span>
                  <span className="cs-title">{person.title}</span>
                </div>
                <div className="cs-meta">
                  <span>{person.description}</span>
                  {person.since && (
                    <span title={`부임 ${humanDate(person.since, { year: true })}`}>
                      부임 {ageOf(person.since, today) + 1}년째
                    </span>
                  )}
                </div>
              </div>
              {person.until && (
                <span className="cs-contract">계약 {contractUntil(person.until)}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
