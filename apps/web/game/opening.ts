import type { GamePayload } from "@/game/store";
import { streamOpening, type TurnStreamFailure, type TurnStreamHandlers } from "@/game/turn-stream";

/**
 * ── 부임 — **첫 장면의 첫 글자가 닿으면 화면이 게임으로 넘어간다** ─────────────
 *
 * 새 게임의 흐름은 부임 화면이 열고 게임 화면이 이어 받는다. 그 사이에 화면이 바뀌므로
 * 흐름을 읽는 쪽은 어느 화면에도 매이지 않고 여기 산다 — 게임 화면이 붙기 전에 온 글자는
 * 쌓아 두었다가 붙는 순간 한꺼번에 넘긴다.
 */

/** 부임 화면이 고른 것 — 첫 장면이 실패해 돌아오면 그대로 다시 선다 */
export interface OpeningForm {
  leagueId: string;
  teamId: string;
  managerName: string;
  background: string;
}

interface Opening {
  /** 첫 장면이 앉을 세계 — 작업이 처음부터 다시 돌면 새로 온다 */
  payload: GamePayload;
  text: string;
  done: GamePayload | null;
  ended: { failure: TurnStreamFailure | null } | null;
  follower: { handlers: TurnStreamHandlers; settle: (f: TurnStreamFailure | null) => void } | null;
}

const openings = new Map<string, Opening>();
let failed: { form: OpeningForm; reason: string } | null = null;

/**
 * 새 게임을 연다 — 첫 글자(또는 글자 없이 끝난 장면)가 닿으면 `onEnter`, 그 전에 실패하면
 * `onFail`. 넘어간 뒤의 실패는 게임 화면이 받고, 서버가 게임을 만들지 않았다고 확정했으면
 * 고른 것을 남겨 부임 화면이 되살린다 (`failedOpening`).
 */
export function startOpening(
  form: OpeningForm,
  onEnter: (gameId: string) => void,
  onFail: (reason: string) => void,
): void {
  failed = null;
  let opening: Opening | null = null;
  let entered = false;
  const enter = (current: Opening) => {
    if (entered) return;
    entered = true;
    openings.set(current.payload.id, current);
    onEnter(current.payload.id);
  };
  const handlers: TurnStreamHandlers = {
    onOpening: (payload) => {
      if (!opening) {
        opening = { payload, text: "", done: null, ended: null, follower: null };
        return;
      }
      opening.payload = payload;
      opening.follower?.handlers.onOpening?.(payload);
    },
    onReset: () => {
      if (!opening) return;
      opening.text = "";
      opening.follower?.handlers.onReset?.();
    },
    onDelta: (text) => {
      if (!opening) return;
      opening.text += text;
      opening.follower?.handlers.onDelta(text);
      enter(opening);
    },
    onDone: (payload) => {
      opening ??= { payload, text: "", done: null, ended: null, follower: null };
      opening.done = payload;
      opening.follower?.handlers.onDone(payload);
      enter(opening);
    },
  };
  const { teamId, managerName, background } = form;
  void streamOpening({ teamId, managerName, background }, handlers).then((failure) => {
    const current = opening;
    if (!entered || !current) {
      if (failure) onFail(failure.reason);
      return;
    }
    if (failure?.settled) failed = { form, reason: failure.reason };
    current.ended = { failure };
    current.follower?.settle(failure);
  });
}

/**
 * 게임 화면이 흐름을 이어 받는다 — 이미 온 글자를 먼저 넘기고, 흐름이 끝나면 실패(없으면
 * null)로 풀린다. 떼었다 다시 붙으면(화면이 다시 마운트되면) 처음부터 다시 넘긴다.
 * 다 받은 화면이 `release`로 지운다 — 그 게임을 다시 열면 저장된 세이브를 읽는다.
 */
export function openingOf(gameId: string): {
  payload: GamePayload;
  follow: (handlers: TurnStreamHandlers) => Promise<TurnStreamFailure | null>;
  detach: () => void;
  release: () => void;
} | null {
  const opening = openings.get(gameId);
  if (!opening) return null;
  return {
    payload: opening.payload,
    follow: (handlers) =>
      new Promise((resolve) => {
        if (opening.text) handlers.onDelta(opening.text);
        if (opening.done) handlers.onDone(opening.done);
        if (opening.ended) resolve(opening.ended.failure);
        else opening.follower = { handlers, settle: resolve };
      }),
    detach: () => {
      opening.follower = null;
    },
    release: () => {
      if (openings.get(gameId) === opening) openings.delete(gameId);
    },
  };
}

/**
 * 첫 장면이 실패해 게임이 서지 않은 부임 — 부임 화면이 처음 그릴 때 읽고, 그린 뒤
 * 지운다(`clearFailedOpening`). 읽기와 지우기가 갈린 것은 처음 그리기가 두 번 돌 수
 * 있어서다(StrictMode).
 */
export function failedOpening(): { form: OpeningForm; reason: string } | null {
  return failed;
}

export function clearFailedOpening(): void {
  failed = null;
}
