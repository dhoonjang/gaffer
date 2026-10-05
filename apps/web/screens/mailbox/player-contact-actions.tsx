"use client";
import { FREE_AGENT_TEAM } from "@gaffer/domain";
import type { PlayerCardView } from "@gaffer/engine";
import type { GamePayload } from "@/game/store";
import { IconChat, IconMail } from "@/shared/icons";
import type { MailDraft } from "./mailbox";

/**
 * 선수 카드의 연락 손잡이 — 말 걸기와 메일.
 *
 * 말 걸기는 만남인지 통화인지 정하지 않는다. 입력창에 상대만 세우고, 그 자리가
 * 면담이 될지 전화가 될지는 메인 GM이 소속·장소·관계를 보고 연다.
 */
export function PlayerContactActions({
  card,
  game,
  blocked,
  onTalk,
  onMail,
  onClose,
}: {
  card: PlayerCardView;
  game: GamePayload;
  blocked: boolean;
  onTalk: () => void;
  onMail: (draft: MailDraft) => void;
  onClose: () => void;
}) {
  const team = game.views.negotiation.teamId;
  if (!team) return null;
  const own = card.teamId === team;
  const viaAgent = own || card.teamId === FREE_AGENT_TEAM;
  return (
    <>
      <button
        type="button"
        className="pc-primary"
        disabled={blocked}
        data-testid="player-card-talk"
        onClick={() => {
          onTalk();
          onClose();
        }}
      >
        <IconChat size={15} />말 걸기
      </button>
      <button
        type="button"
        className="pc-secondary"
        disabled={blocked}
        data-testid="player-card-mail"
        onClick={() => {
          onMail({
            label: viaAgent ? `${card.name} 에이전트` : card.team,
            recipient: viaAgent
              ? { kind: "agent", playerId: card.id }
              : { kind: "club", teamId: card.teamId },
            subject: `${card.name} ${own ? "재계약" : "영입"} 문의`,
            body: `${card.name} ${own ? "재계약" : "영입"} 가능 여부와 조건을 논의하고 싶습니다.`,
          });
          onClose();
        }}
      >
        <IconMail size={15} />
        {viaAgent ? "에이전트에 메일" : "구단에 메일"}
      </button>
    </>
  );
}
