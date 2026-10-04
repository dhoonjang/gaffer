"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NegotiationAction, NegotiationChannel, NegotiationView } from "@story-fm/domain";
import type { GamePayload } from "@/application/lib/store";

type Case = NegotiationView["cases"][number];
type Request = {
  scope: string;
  body: { requestId: string; negotiationId: string; revision: number; action: NegotiationAction };
};
const unresolved = new Map<string, Request>();
export function useNegotiationRequest({
  gameId,
  item,
  channel,
  blocked,
  onGame,
  onBusy,
}: {
  gameId: string;
  item: Case | undefined;
  channel: NegotiationChannel;
  blocked: boolean;
  onGame: (game: GamePayload) => void;
  onBusy: (busy: boolean) => void;
}) {
  const scope = `${gameId}:${item?.id ?? ""}:${channel}`;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [active, setActive] = useState<Request | null>(null);
  const [failure, setFailure] = useState<{
    scope: string;
    error: string;
    request?: Request;
  } | null>(null);
  const mounted = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);
  const currentGame = useRef(gameId);
  currentGame.current = gameId;
  const attempt = useRef(0);
  const callbacks = useRef({ onGame, onBusy });
  callbacks.current = { onGame, onBusy };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (writing.current) callbacks.current.onBusy(false);
    };
  }, []);
  const execute = useCallback(
    async (request: Request) => {
      if (writing.current || !mounted.current) return false;
      const token = ++attempt.current;
      const current = () =>
        mounted.current && currentGame.current === gameId && attempt.current === token;
      writing.current = true;
      generation.current++;
      setActive(request);
      setFailure(null);
      callbacks.current.onBusy(true);
      let retryable = true;
      try {
        const response = await fetch(`/api/games/${gameId}/negotiation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request.body),
        });
        const data = (await response.json()) as {
          game?: GamePayload;
          warning?: string;
          error?: string;
        };
        if (!response.ok || !data.game) {
          retryable = response.status >= 500;
          if (response.status === 409) {
            const refresh = await fetch(`/api/games/${gameId}`);
            if (refresh.ok && current())
              callbacks.current.onGame((await refresh.json()) as GamePayload);
          }
          throw new Error(data.error ?? "요청을 처리하지 못했습니다");
        }
        unresolved.delete(request.scope);
        if (!current()) return true;
        callbacks.current.onGame(data.game);
        const action = request.body.action;
        if (action.kind === "message")
          setDrafts((previous) =>
            previous[request.scope] === action.text
              ? { ...previous, [request.scope]: "" }
              : previous,
          );
        if (data.warning) setFailure({ scope: request.scope, error: data.warning });
        return true;
      } catch (cause) {
        if (!retryable) unresolved.delete(request.scope);
        if (current())
          setFailure({
            scope: request.scope,
            error: cause instanceof Error ? cause.message : "응답을 확인하지 못했습니다.",
            ...(retryable ? { request } : {}),
          });
        return false;
      } finally {
        if (attempt.current === token) writing.current = false;
        if (current()) {
          setActive(null);
          callbacks.current.onBusy(false);
        }
      }
    },
    [gameId],
  );
  const act = useCallback(
    async (action: NegotiationAction, target = item) => {
      if (!target || blocked || writing.current) return false;
      if (action.kind === "read") return false;
      const requestScope = `${gameId}:${target.id}:${action.kind === "message" ? action.channel : channel}`;
      const prior = unresolved.get(requestScope);
      const request =
        prior && JSON.stringify(prior.body.action) === JSON.stringify(action)
          ? prior
          : {
              scope: requestScope,
              body: {
                requestId: crypto.randomUUID(),
                negotiationId: target.id,
                revision: target.revision,
                action,
              },
            };
      unresolved.set(requestScope, request);
      return execute(request);
    },
    [item, blocked, gameId, channel, execute],
  );
  useEffect(() => {
    if (!item || blocked || active || item.messages.length <= item.lastReadMessage) return;
    const controller = new AbortController();
    const before = generation.current;
    void (async () => {
      try {
        const response = await fetch(`/api/games/${gameId}/negotiation`, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            negotiationId: item.id,
            revision: item.revision,
            action: { kind: "read" },
          }),
        });
        const data = (await response.json()) as { game?: GamePayload };
        if (
          response.ok &&
          data.game &&
          !controller.signal.aborted &&
          mounted.current &&
          currentGame.current === gameId &&
          before === generation.current
        )
          callbacks.current.onGame(data.game);
      } catch {
        /* Read acknowledgements never replace a write failure or its busy state. */
      }
    })();
    return () => controller.abort();
  }, [gameId, item, blocked, active]);
  const visibleFailure = failure?.scope === scope ? failure : null;
  const retryRequest = visibleFailure?.request;
  const visibleActive = active?.scope === scope ? active : null;
  return {
    text: visibleActive?.body.action.kind === "message" ? "" : (drafts[scope] ?? ""),
    setText: (text: string) => setDrafts((previous) => ({ ...previous, [scope]: text })),
    pending: active !== null,
    optimisticText:
      visibleActive?.body.action.kind === "message" ? visibleActive.body.action.text : null,
    thinking: visibleActive !== null,
    error: visibleFailure?.error ?? null,
    dismiss: () => setFailure((previous) => (previous?.scope === scope ? null : previous)),
    retry: retryRequest
      ? () => {
          if (!blocked) void execute(retryRequest);
        }
      : undefined,
    act,
  };
}
