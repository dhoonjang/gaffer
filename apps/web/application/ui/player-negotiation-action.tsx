"use client";

import { useEffect, useRef, useState } from "react";
import { FREE_AGENT_TEAM } from "@story-fm/domain";
import type { PlayerCardView } from "@story-fm/engine";
import type { GamePayload } from "@/application/lib/store";

/** Every player link shares this one inquiry transport and the core's open-case validation. */
export function PlayerNegotiationAction({
  card,
  game,
  blocked,
  onBusy,
  onChoose,
  onClose,
}: {
  card: PlayerCardView;
  game: GamePayload;
  blocked: boolean;
  onBusy: (busy: boolean) => void;
  onChoose: (id: string, game?: GamePayload) => void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (request.current) {
        request.current.abort();
        onBusy(false);
      }
    };
  }, [onBusy]);
  const managedTeamId = game.views.negotiation.teamId;
  const own = card.teamId === managedTeamId;
  const kind = own ? "renewal" : card.teamId === FREE_AGENT_TEAM ? "free" : "transfer";
  const matching = game.views.negotiation.cases.filter(
    (n) =>
      n.playerId === card.id &&
      n.buyerId === managedTeamId &&
      n.sellerId === card.teamId &&
      n.kind === kind,
  );
  const active = matching.find((n) => n.status === "open" || n.status === "signed");
  const previous = [...matching]
    .reverse()
    .find((n) => n.status === "withdrawn" || n.status === "completed");
  if (!managedTeamId) return null;
  if (!active && own && (!card.contractUntil || card.contractUntil < game.date)) return null;
  const label = active
    ? "대화 이어가기"
    : previous
      ? "협상 다시 시작"
      : own
        ? "재계약 협상 시작"
        : kind === "free"
          ? "계약 문의"
          : "이적 문의";
  const choose = async () => {
    if (blocked || request.current) return;
    if (active) {
      onChoose(active.id);
      onClose();
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    onBusy(true);
    try {
      const response = await fetch(`/api/games/${game.id}/negotiation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          negotiationId: null,
          revision: 0,
          action: {
            kind: "open",
            playerId: card.id,
            buyerId: managedTeamId,
            negotiationKind: kind,
            background: `${card.name} ${own ? "재계약 협상" : "계약 문의"}`,
          },
        }),
      });
      const result = (await response.json()) as {
        game?: GamePayload;
        negotiationId?: string;
        error?: string;
      };
      if (!mounted.current || controller.signal.aborted) return;
      if (!response.ok || !result.game || !result.negotiationId)
        throw new Error(result.error ?? "협상을 열지 못했습니다");
      if (!result.game.views.negotiation.cases.some((n) => n.id === result.negotiationId))
        throw new Error("열린 협상을 확인하지 못했습니다");
      onChoose(result.negotiationId, result.game);
      onClose();
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "협상을 열지 못했습니다");
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (mounted.current) {
          onBusy(false);
          setPending(false);
        }
      }
    }
  };
  return (
    <span className="pc-negotiation-action">
      {error && (
        <span role="alert" className="error-text">
          {error}
        </span>
      )}
      <button
        type="button"
        data-testid="player-card-negotiation"
        disabled={blocked || pending}
        onClick={() => void choose()}
      >
        {pending ? "협상 여는 중…" : label}
      </button>
    </span>
  );
}
