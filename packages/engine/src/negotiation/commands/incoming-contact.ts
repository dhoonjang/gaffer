import type { Negotiation } from "@story-fm/domain";
import { type GameState, activeContract, managedTeamId, teamNameIn } from "../../common/core/state";
import { pickOurPlayer } from "../../common/core/player-ref";
import { pickTeam } from "../../common/core/team-ref";

/** A world contact opens an inquiry only; prices and approvals belong to the evaluated exchange. */
export function openIncomingTalks(
  state: GameState,
  input: {
    playerId: string;
    counterpartTeamId: string;
    kind: "sell" | "loan_out";
    trigger: "listing" | "contract";
  },
):
  | { ok: true; message: string; negotiation: Negotiation; opened: boolean }
  | { ok: false; message: string } {
  const ours = managedTeamId(state);
  if (!ours || !["idle", "matchday"].includes(state.phase))
    return { ok: false, message: "담당 구단의 평시 연락만 열 수 있습니다" };
  const picked = pickOurPlayer(state, input.playerId);
  if (!picked.ok) return picked;
  const counterpart = pickTeam(state, input.counterpartTeamId);
  if (!counterpart.ok) return counterpart;
  if (counterpart.teamId === ours) return { ok: false, message: "다른 구단의 연락이어야 합니다" };
  const player = picked.player;
  const contract = activeContract(state, player.id);
  if (!contract || contract.teamId !== ours || player.loan)
    return { ok: false, message: "우리 구단이 보유한 계약의 선수만 연락할 수 있습니다" };
  const listing = state.transferList.find((row) => row.gamePlayerId === player.id);
  if (input.trigger === "listing" && !listing)
    return { ok: false, message: "기록된 이적 명단 등재가 없습니다" };
  const source =
    input.trigger === "listing" && listing
      ? `listing:${listing.listedOn}:${listing.askingPrice ?? "unpriced"}`
      : `contract:${contract.id}:${contract.until}`;
  const id = `neg-world:${player.id}:${counterpart.teamId}:${input.kind}:${source}`;
  const existing = state.negotiations.find((row) => row.id === id);
  if (existing)
    return {
      ok: true,
      message: "같은 근거의 연락 기록이 이미 있습니다",
      negotiation: existing,
      opened: false,
    };
  const ongoing = state.negotiations.find(
    (row) =>
      row.gamePlayerId === player.id &&
      row.counterpartTeamId === counterpart.teamId &&
      row.kind === input.kind &&
      ["open", "agreed"].includes(row.status),
  );
  if (ongoing)
    return {
      ok: true,
      message: "같은 상대와의 진행 중인 문의를 이어갑니다",
      negotiation: ongoing,
      opened: false,
    };
  const negotiation: Negotiation = {
    id,
    gamePlayerId: player.id,
    kind: input.kind,
    counterpartTeamId: counterpart.teamId,
    windowId: null,
    openedOn: state.date,
    status: "open",
    rounds: [],
    pitched: [],
    terms: [],
    precontract: false,
    buyout: false,
  };
  state.negotiations.push(negotiation);
  return {
    ok: true,
    message: `${teamNameIn(state, counterpart.teamId)}의 ${player.name} 문의`,
    negotiation,
    opened: true,
  };
}
