import type { GamePlayer, Medical, MedicalConcern, Negotiation } from "@story-fm/domain";
import { isPlayerDeal } from "@story-fm/domain";

import { diffDays } from "../../common/core/dates";
import { openInjury, playerById, teamNameIn, type GameState } from "../../common/core/state";

export function needsMedical(negotiation: Negotiation): boolean {
  return !isPlayerDeal(negotiation.kind) && !negotiation.precontract;
}

export function receivingTeamOf(state: GameState, negotiation: Negotiation): string {
  return negotiation.kind === "sell" || negotiation.kind === "loan_out"
    ? (negotiation.counterpartTeamId ?? state.userTeamId)
    : state.userTeamId;
}

export function isIncomingDeal(negotiation: Negotiation): boolean {
  return negotiation.kind === "buy" || negotiation.kind === "loan";
}

export function scheduleMedical(state: GameState, negotiation: Negotiation): Medical {
  const medical: Medical = { onDate: state.date, status: "scheduled" };
  negotiation.medical = medical;
  return medical;
}

export function medicalConcernText(concern: MedicalConcern): string {
  switch (concern.code) {
    case "open-injury":
      return `${concern.bodyPart ?? "부상 부위"} 부상이 아직 낫지 않았습니다 — 복귀까지 약 ${concern.days ?? 0}일`;
    case "past-injury":
      return `${concern.bodyPart ?? "같은 자리"}에 예전 부상의 흔적이 남아 있습니다 — 같은 자리가 다시 갈 수 있습니다`;
    case "age-load":
      return "누적 피로가 나이에 비해 큽니다 — 연간 소화 경기 수를 관리해야 합니다";
    case "muscle-balance":
      return "근육 밸런스가 고르지 않습니다 — 초반 몇 주는 관리가 필요합니다";
  }
}

export function medicalNoteText(medical: Medical): string {
  return medical.concern ? medicalConcernText(medical.concern) : "이상 소견";
}

export interface MedicalOutcome {
  negotiation: Negotiation;
  player: GamePlayer;
  passed: boolean;
  concern: MedicalConcern | null;
}

export function resolveMedical(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
): MedicalOutcome {
  const medical = negotiation.medical ?? scheduleMedical(state, negotiation);
  const injury = openInjury(state, player.id);
  const concern: MedicalConcern | null = injury
    ? {
        code: "open-injury",
        bodyPart: injury.bodyPart,
        days: Math.max(0, diffDays(state.date, injury.expectedReturn)),
      }
    : null;
  medical.status = concern ? "flagged" : "passed";
  if (concern) medical.concern = concern;
  else delete medical.concern;
  return { negotiation, player, passed: concern === null, concern };
}

export function describeMedical(state: GameState, negotiation: Negotiation): string | null {
  const medical = negotiation.medical;
  if (!medical) return null;
  const player = playerById(state, negotiation.gamePlayerId);
  const who = player?.name ?? negotiation.gamePlayerId;
  const where = isIncomingDeal(negotiation)
    ? "우리 메디컬"
    : `${teamNameIn(state, receivingTeamOf(state, negotiation))} 메디컬`;
  if (medical.status === "scheduled") return `${who} ${where} ${medical.onDate} 예정`;
  if (medical.status === "passed") return `${who} ${where} 통과`;
  return `${who} ${where} 소견 — ${medicalNoteText(medical)}`;
}
