"use client";
import { FREE_AGENT_TEAM } from "@story-fm/domain";
import type { PlayerCardView } from "@story-fm/engine";
import type { GamePayload } from "@/game/store";
import type { MailDraft } from "./mailbox";
export function PlayerNegotiationAction({
  card,
  game,
  blocked,
  onContext,
  onMail,
  onClose,
}: {
  card: PlayerCardView;
  game: GamePayload;
  blocked: boolean;
  onContext: (text: string) => void;
  onMail: (draft: MailDraft) => void;
  onClose: () => void;
}) {
  const team = game.views.negotiation.teamId;
  if (!team) return null;
  const own = card.teamId === team;
  return (
    <span className="pc-negotiation-action">
      <button
        disabled={blocked}
        data-testid="player-card-conversation"
        onClick={() => {
          onContext(`${card.name} ${own ? "재계약" : "영입"} 조건을 논의하고 싶습니다.`);
          onClose();
        }}
      >
        메인 대화에서 논의
      </button>
      <button
        disabled={blocked}
        data-testid="player-card-mail"
        onClick={() => {
          onMail({
            label: own || card.teamId === FREE_AGENT_TEAM ? `${card.name} 에이전트` : card.team,
            recipient:
              own || card.teamId === FREE_AGENT_TEAM
                ? { kind: "agent", playerId: card.id }
                : { kind: "club", teamId: card.teamId },
            subject: `${card.name} ${own ? "재계약" : "영입"} 문의`,
            body: `${card.name} ${own ? "재계약" : "영입"} 가능 여부와 조건을 논의하고 싶습니다.`,
          });
          onClose();
        }}
      >
        {own || card.teamId === FREE_AGENT_TEAM ? "에이전트에 메일" : "구단에 메일"}
      </button>
    </span>
  );
}
