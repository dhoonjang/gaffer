"use client";
import type { ChatTurn } from "@gaffer/engine";
import { ChatTurnView } from "./chat";
import { IconClose } from "@/shared/icons";
import { Button } from "@/shared/button";

/** Transport owns pending state; both conversations present it in the same flow. */
export function ChatTurnFeedback({
  text,
  thinking,
  date,
  playerNames,
  userTurn,
  onLongPress,
}: {
  text?: string | null;
  thinking: boolean;
  date: string;
  playerNames?: Record<string, string>;
  userTurn?: ChatTurn;
  onLongPress?: (() => void) | undefined;
}) {
  return (
    <>
      {(userTurn || text) && (
        <ChatTurnView
          turn={userTurn ?? { role: "user", text: text ?? "", at: date, toolCalls: [] }}
          playerNames={playerNames}
          onLongPress={onLongPress}
        />
      )}
      {thinking && (
        <div className="thinking" role="status" aria-label="응답을 기다리는 중">
          <i />
          <i />
          <i />
        </div>
      )}
    </>
  );
}
export function ChatTurnError({
  error,
  detail,
  onRetry,
  onDismiss,
  disabled = false,
}: {
  error: string | null;
  detail?: string | null;
  onRetry?: (() => void) | undefined;
  onDismiss: () => void;
  disabled?: boolean;
}) {
  if (!error) return null;
  return (
    <div className="turn-error" data-testid="turn-error" title={detail ?? undefined}>
      <span>{error}</span>
      <div className="turn-error-actions">
        {onRetry && (
          <Button variant="bare" onClick={onRetry} disabled={disabled}>
            다시 시도
          </Button>
        )}
        <Button variant="bare" className="ghost" onClick={onDismiss} aria-label="알림 닫기">
          <IconClose size={14} />
        </Button>
      </div>
    </div>
  );
}
