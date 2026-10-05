import {
  MailRecipientSearchSchema,
  type MailRecipientCandidate,
  type MailRecipientResolution,
  personaKeywords,
} from "@gaffer/domain";
import { managedTeamId, teamNameIn, type GameState } from "../core/state";
import { norm, pickTeam } from "../core/team-ref";
import { rankByName } from "../core/name-match";
import { staffOf, worldFigures, agentForPlayer } from "./persona";
import { resolveMailRecipient } from "./mail";
function recipientQuery(text: string) {
  return text
    .trim()
    .replace(/(?:의\s*)?(?:에이전트|대리인)\s*$/u, "")
    .trim();
}
function candidatesFor(
  state: GameState,
  text: string,
  limit: number,
  allowFuzzy: boolean,
): MailRecipientCandidate[] {
  const team = managedTeamId(state);
  if (!team) return [];
  const query = recipientQuery(text),
    key = norm(query);
  if (!key) return [];
  const result: MailRecipientCandidate[] = [];
  const add = (recipient: MailRecipientCandidate["recipient"], description: string) => {
    const contact = resolveMailRecipient(state, recipient);
    if (contact && !result.some((c) => c.contactId === contact.contactId))
      result.push({ ...contact, description });
  };
  const eligibleTeams = state.teams.filter(
    (t) => t.id !== team && state.finances.some((f) => f.teamId === t.id),
  );
  const picked = pickTeam(state, query);
  const exact = eligibleTeams.filter((t) =>
    [t.id, t.name, t.shortName].some((name) => norm(name) === key),
  );
  const matches = exact.length
    ? exact
    : eligibleTeams.filter(
        (t) =>
          norm(t.name).includes(key) || norm(t.id).includes(key) || norm(t.shortName).includes(key),
      );
  if (matches.length)
    for (const t of matches)
      add({ kind: "club", teamId: t.id }, `구단 · ${teamNameIn(state, t.id)}`);
  else if (picked.ok)
    add({ kind: "club", teamId: picked.teamId }, `구단 · ${teamNameIn(state, picked.teamId)}`);
  const retired = new Set(state.retired.map((p) => p.gamePlayerId));
  const players = state.players.filter((p) => !retired.has(p.id));
  const ranking = rankByName(query, players, { allowFuzzy });
  const playerMatches = ranking.best && !allowFuzzy ? [ranking.best] : ranking.matches;
  for (const p of playerMatches) {
    add(
      { kind: "agent", playerId: p.id },
      `${p.name} · ${teamNameIn(state, p.teamId)} · 선수 에이전트`,
    );
    if (result.length >= limit) break;
  }
  const staff = staffOf({ ...state, userTeamId: team });
  const names = staff.flatMap((p) =>
    personaKeywords(p).map((name) => ({ id: p.characterId, name, person: p })),
  );
  const staffRank = rankByName(query, names, { allowFuzzy });
  for (const p of !allowFuzzy && staffRank.best ? [staffRank.best] : staffRank.matches) {
    add({ kind: "staff", personId: p.person.characterId }, `${teamNameIn(state, team)} · 담당자`);
    if (result.length >= limit) break;
  }
  const agentNames = worldFigures(state)
    .filter((p) => p.role === "agent")
    .flatMap((p) => personaKeywords(p).map((name) => ({ id: p.characterId, name, person: p })));
  const agentRank = rankByName(query, agentNames, { allowFuzzy });
  for (const person of !allowFuzzy && agentRank.best ? [agentRank.best] : agentRank.matches) {
    const represented = players.find(
      (p) => agentForPlayer(state, p.id)?.characterId === person.person.characterId,
    );
    if (represented) add({ kind: "agent", playerId: represented.id }, "선수 에이전트");
    if (result.length >= limit) break;
  }
  return result.slice(0, limit);
}
export function searchMailRecipients(
  state: GameState,
  raw: unknown,
): { candidates: MailRecipientCandidate[] } {
  const parsed = MailRecipientSearchSchema.safeParse(raw);
  if (!parsed.success) throw new RangeError("Invalid mail recipient query");
  return { candidates: candidatesFor(state, parsed.data.query, parsed.data.limit, true) };
}
export function resolveMailRecipientText(state: GameState, text: string): MailRecipientResolution {
  const parsed = MailRecipientSearchSchema.safeParse({ query: text });
  if (!parsed.success) return { ok: false, message: "수신인을 입력해 주세요", candidates: [] };
  const candidates = candidatesFor(state, text, 20, false);
  if (candidates.length === 1) return { ok: true, contact: candidates[0]! };
  return {
    ok: false,
    message: candidates.length
      ? "여러 수신인이 일치합니다. 정확한 상대를 선택해 주세요"
      : "수신인을 찾지 못했습니다. 이름을 확인하거나 추천 상대를 선택해 주세요",
    candidates: candidates.length
      ? candidates
      : searchMailRecipients(state, { query: text }).candidates,
  };
}
