import type { Persona } from "@story-fm/domain";
import { AGENT_ARCHETYPE_LABEL, agentArchetypeOf, type AgentArchetype } from "@story-fm/domain";
import { agentForPlayer } from "../../common/people/persona";

/** 이 선수를 대리하는 사람과 그 원형 — 명부에 없거나 원형을 모르면 `null` */
export function agentOfPlayer(
  state: { userTeamId: string; seed: number },
  playerId: string,
): { persona: Persona; archetype: AgentArchetype } | null {
  const persona = agentForPlayer(state, playerId);
  if (!persona) return null;
  const archetype = agentArchetypeOf(persona.archetype);
  return archetype === null ? null : { persona, archetype };
}

/**
 * 근거 목록에 서는 한 줄의 주어 — `조르제 멘데스(제국형)`.
 *
 * 이름과 라벨을 함께 부르는 이유: 감독은 협상 서류에서 그 사람을 이름으로 만나므로,
 * 확률 근거가 원형만 적으면 두 화면이 같은 사람을 다르게 부른다.
 */
export function agentLabelOf(agent: { persona: Persona; archetype: AgentArchetype }): string {
  return `${agent.persona.name}(${AGENT_ARCHETYPE_LABEL[agent.archetype]})`;
}
