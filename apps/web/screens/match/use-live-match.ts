"use client";
import { apiFetch as fetch } from "@/shared/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { LIVE_STEP, type LiveMatchFrame } from "@gaffer/domain";
import { advanceLive, liveDigest, liveFinished, liveFrameOf, type LiveMatch } from "@gaffer/sim";
import type { MatchView } from "@gaffer/engine";
import type { MatchBoardOrder } from "../../shared/match-orders";
import type { LiveAction, LiveSnapshot } from "./live-match-protocol";
import type { GameSlice } from "../../game/store";
import { LIVE_PACES, easeSpeed, sceneSpeedOf, type LivePace } from "./live-speed";

/**
 * 실시간 경기의 **클라이언트 실행기** (live-match.md §8).
 *
 * 서버의 확정 상태를 받아 `packages/sim`의 같은 함수로 시계를 민다. 흐르는 동안에는 서버에
 * 묻지 않는다 — 골·카드가 나도 서지 않는다. **멈추면 확정한다**: 감독의 입력·턴·전술 편집·
 * 수동 정지·숨겨진 탭·휴식·종료 휘슬에서 그때까지 굴린 구간을 체크포인트로 내고, 다시 흐를
 * 때는 서버가 확정한 상태(그 사이 앉은 지시 포함)를 이어받는다. 두 쪽이 어긋나면 서버가
 * 이긴다. 종료 휘슬이 확정되면 마감을 부른다(`onClose`).
 */

const FRAME_MS = 100;
/**
 * 고정 배속 — e2e가 90분을 벽시계로 기다릴 수는 없어 그 자리에서만 환경으로 올린다(빌드에
 * 박히는 값이라 `NEXT_PUBLIC_`이다). 있으면 장면을 따르는 배속(`live-speed.ts`) 대신 선다.
 */
const FIXED_SPEED = Number(import.meta.env.VITE_LIVE_MATCH_SPEED) || null;
const TICKS_PER_SPEED = FRAME_MS / 1000 / LIVE_STEP;
const PACE_KEY = "gaffer.live-pace";

function storedPace(): LivePace {
  try {
    const stored = localStorage.getItem(PACE_KEY);
    return LIVE_PACES.find((p) => p.key === stored)?.key ?? "normal";
  } catch {
    return "normal";
  }
}

export function useLiveMatch(options: {
  gameId: string;
  matchId: string | null;
  /** 전술 편집·오류 — 멈춤 사유다 */
  blocked: boolean;
  /** 감독이 입력하는 중 — 선다 */
  typing: boolean;
  /** 감독의 턴이 도는 중(응답 스트리밍 포함) — 선다 */
  turning: boolean;
  onView: (view: MatchView | null) => void;
  /** 재개 앞에 보낼 전술판 조작 — 미저장 편집을 먼저 서버에 밀어 넣는다 */
  prepare: () => Promise<MatchBoardOrder[]>;
  applied: (orders: MatchBoardOrder[]) => void;
  onSlice: (slice: GameSlice) => void;
  /**
   * 종료 휘슬이 확정됐다 — 마감을 부른다. 끝난 경기를 이어받았거나(새로고침) 승부차기가
   * 갈린 자리도 여기로 온다.
   */
  onClose: () => Promise<unknown>;
}) {
  const [frame, setFrame] = useState<LiveMatchFrame | null>(null);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(true);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pace, setPaceState] = useState<LivePace>("normal");
  const factor = useRef(1);
  factor.current = LIVE_PACES.find((p) => p.key === pace)?.factor ?? 1;
  /** 지금 배속과 아직 굴리지 않은 틱의 끝수 — 배속이 정수 틱으로 떨어지지 않는다 */
  const speed = useRef<number | null>(null);
  const carry = useRef(0);
  const callbacks = useRef(options);
  callbacks.current = options;
  const live = useRef<LiveMatch | null>(null);
  const generation = useRef(0);
  /** 서버 왕복이 도는 동안 — 굴리지 않는다. 겹친 요청은 줄을 선다 */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inflight = useRef(0);
  const failed = useRef(false);
  const pendingOrders = useRef<Extract<LiveAction, { kind: "orders" }> | null>(null);
  /** 시계를 세우는 사유 — 렌더마다 옵션에서 다시 읽는다 */
  const halted = useRef(true);
  halted.current = options.blocked || options.typing || options.turning || manual;
  const hidden = useRef(false);
  /** 멈췄다가 다시 흐르기 전 — 확정 상태를 이어받고 전술판 조작을 보낸다 */
  const resuming = useRef(true);
  const synchronizing = useRef(false);
  /** 마감을 부르는 중 — 한 경기에 한 번 */
  const closing = useRef(false);
  /** 서버가 승부차기가 남았다고 알렸다 — 종료 휘슬의 확정이 오기 전에는 한 발을 차지 않는다 */
  const awaitingShootout = useRef(false);

  const close = useCallback(async (): Promise<void> => {
    if (closing.current) return;
    closing.current = true;
    try {
      await callbacks.current.onClose();
    } catch {
      closing.current = false;
    }
  }, []);

  const adopt = useCallback((snapshot: LiveSnapshot, expected: number) => {
    if (generation.current !== expected) return;
    live.current = snapshot.live;
    setFrame(liveFrameOf(snapshot.live));
    callbacks.current.onView(snapshot.view);
    if (snapshot.slice) callbacks.current.onSlice(snapshot.slice);
  }, []);

  /** 서버 왕복 하나 — 줄을 세워 순서를 지킨다. 창을 닫는 순간에도 닿도록 `keepalive`다 */
  const request = useCallback(
    (action: LiveAction | null): Promise<LiveSnapshot | null> => {
      const expected = generation.current;
      const task = queue.current
        .catch(() => undefined)
        .then(async () => {
          if (generation.current !== expected) return null;
          inflight.current += 1;
          try {
            const response = await fetch(`/api/games/${options.gameId}/match/live`, {
              method: action ? "POST" : "GET",
              ...(action
                ? {
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(action),
                    keepalive: true,
                  }
                : {}),
            });
            const result = (await response.json()) as LiveSnapshot & { error?: string };
            if (generation.current !== expected) return null;
            if (!response.ok) throw new Error(result.error ?? "경기 요청을 처리하지 못했습니다");
            adopt(result, expected);
            if (generation.current === expected) {
              failed.current = false;
              awaitingShootout.current = result.awaitingShootout;
              setError(null);
            }
            if (result.needsClose) void close();
            return result;
          } finally {
            inflight.current -= 1;
          }
        })
        .catch((e: unknown) => {
          if (generation.current === expected) {
            failed.current = true;
            setError(e instanceof Error ? e.message : "경기 연결 오류");
            setPaused(true);
          }
          throw e;
        });
      queue.current = task;
      return task;
    },
    [options.gameId, adopt, close],
  );

  /**
   * 굴린 구간을 확정한다 — **앞선 왕복이 끝난 뒤의 상태로** 판단한다. 굴린 것이 없으면
   * 아무 일도 없다(이미 확정 중인 구간을 두 번 내지 않는다).
   */
  const flush = useCallback((): Promise<LiveSnapshot | null> => {
    const expected = generation.current;
    return queue.current
      .catch(() => undefined)
      .then(() => {
        const match = live.current;
        if (generation.current !== expected || !match || match.state.tick === match.committedTick)
          return null;
        return request({
          kind: "checkpoint",
          checkpoint: {
            fromTick: match.committedTick,
            toTick: match.state.tick,
            digest: liveDigest(match),
          },
        });
      });
  }, [request]);

  // 고른 속도는 그 브라우저에 남는다 — 렌더가 서버와 어긋나지 않게 붙은 뒤에 읽는다
  useEffect(() => setPaceState(storedPace()), []);

  // 경기가 바뀌면 확정 상태를 새로 받는다
  useEffect(() => {
    setFrame(null);
    setReady(false);
    setPaused(true);
    setError(null);
    setManual(false);
    live.current = null;
    failed.current = false;
    pendingOrders.current = null;
    resuming.current = true;
    synchronizing.current = false;
    closing.current = false;
    awaitingShootout.current = false;
    const expected = ++generation.current;
    if (!options.matchId) return;
    void request(null)
      .then((snapshot) => {
        if (snapshot && generation.current === expected) setReady(true);
      })
      .catch(() => undefined);
    return () => {
      generation.current += 1;
    };
  }, [options.gameId, options.matchId, request]);

  // 탭이 숨겨지면 멈추고 확정한다 — 창을 닫는 순간도 여기를 지난다
  useEffect(() => {
    const onVisibility = () => {
      hidden.current = document.visibilityState === "hidden";
      if (hidden.current) void flush().catch(() => undefined);
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [flush]);

  /** 다시 흐르기 앞 — 확정 상태를 이어받고 쌓인 전술판 조작을 보낸다 */
  const synchronize = useCallback(async () => {
    if (synchronizing.current) return;
    synchronizing.current = true;
    const expected = generation.current;
    const sendOrders = async (action: Extract<LiveAction, { kind: "orders" }>) => {
      pendingOrders.current = action;
      await request(action);
      if (generation.current !== expected) return;
      pendingOrders.current = null;
      callbacks.current.applied(action.orders);
    };
    try {
      const snapshot = await request(null);
      if (!snapshot || generation.current !== expected) return;
      if (pendingOrders.current) await sendOrders(pendingOrders.current);
      if (generation.current !== expected) return;
      const orders = await callbacks.current.prepare();
      if (generation.current !== expected) return;
      if (orders.length)
        await sendOrders({ kind: "orders", orders, commandId: crypto.randomUUID() });
      if (generation.current === expected) resuming.current = false;
    } catch (error) {
      if (generation.current === expected) {
        failed.current = true;
        setPaused(true);
        setError(error instanceof Error ? error.message : "경기 준비 오류");
      }
    } finally {
      if (generation.current === expected) synchronizing.current = false;
    }
  }, [request]);

  // 시계 — 벽시계 100ms마다 경기 시간 배속만큼 굴린다
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => {
      const match = live.current;
      if (!match || failed.current || inflight.current > 0 || synchronizing.current) {
        setPaused(true);
        return;
      }
      // 멈춘 자리 — 굴린 구간을 확정해 두고, 다시 흐를 때 이어받는다
      if (halted.current || hidden.current || match.state.interval || liveFinished(match)) {
        setPaused(true);
        resuming.current = true;
        speed.current = null;
        if (match.state.tick !== match.committedTick) void flush().catch(() => undefined);
        return;
      }
      if (resuming.current) {
        setPaused(true);
        void synchronize();
        return;
      }
      setPaused(false);
      const target = FIXED_SPEED ?? sceneSpeedOf(match.state) * factor.current;
      speed.current = speed.current === null ? target : easeSpeed(speed.current, target);
      carry.current += speed.current * TICKS_PER_SPEED;
      const ticks = Math.floor(carry.current);
      carry.current -= ticks;
      if (ticks === 0) return;
      advanceLive(match, ticks);
      setFrame(liveFrameOf(match));
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [ready, flush, synchronize]);

  /** 턴·전술판 저장 앞 — 지금까지의 구간을 확정하고 멈춘다 */
  const pause = useCallback(async (): Promise<void> => {
    setManual(false);
    await flush();
  }, [flush]);

  return {
    frame,
    ready,
    paused,
    error,
    pause,
    pace,
    /** 감독이 고르는 속도 — 장면을 따르는 배속 세 갈래에 모두 곱한다 */
    setPace: (next: LivePace) => {
      setPaceState(next);
      try {
        localStorage.setItem(PACE_KEY, next);
      } catch {
        // 저장이 막힌 브라우저 — 이 창에서만 선다
      }
    },
    /** 손잡이 — 휴식이면 재개, 승부차기면 한 발, 오류면 다시 받기, 아니면 일시정지 토글 */
    toggle: () => {
      const match = live.current;
      if (error) {
        failed.current = false;
        resuming.current = true;
        setError(null);
        return;
      }
      if (match && liveFinished(match)) {
        // 승부차기 한 발 — 승부가 갈리면 응답의 `needsClose`가 마감을 부른다
        if (awaitingShootout.current) void request({ kind: "shootout" }).catch(() => undefined);
        return;
      }
      if (match?.state.interval) {
        void flush()
          .then(() => request({ kind: "resume" }))
          .catch(() => undefined);
        return;
      }
      setManual((v) => !v);
    },
  };
}
