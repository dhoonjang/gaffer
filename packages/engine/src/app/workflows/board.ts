import { type GameState, managedTeamId, teamNameIn } from "../../core/state";
import { BoardReviewSchema, formatMoney } from "@story-fm/domain";
import { type CommandResult, item } from "../../core/command-result";
import { dismissUserManager } from "./manager-employment";
import { managerTeam, vacateManagerPost } from "../../people/manager-employment";
import { reportAppointment, reportSacking } from "../../people/media";
import { archiveEmployment } from "../../people/staff-employment";
import { addDays } from "../../core/dates";

/** Execute employment decisions; expectations and warnings belong in the lorebook. */
export function reviewBoard(state: GameState, raw: unknown): CommandResult {
  const parsed = BoardReviewSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "유효한 고용 결정이 필요합니다" };
  if (state.pendingMatch) return { ok: false, message: "진행 중인 경기를 먼저 마쳐야 합니다" };
  const input = parsed.data;
  const team = managerTeam(state, input.team);
  if (!team || !state.finances.some((finance) => finance.teamId === team.id))
    return { ok: false, message: "구단을 찾지 못했습니다" };
  if (input.action === "dismiss") {
    if (team.id === managedTeamId(state)) {
      const digest: string[] = [];
      if (!dismissUserManager(state, digest))
        return { ok: false, message: "재직 중인 감독 계약이 없습니다" };
      return {
        ok: true,
        message: digest.join(" · "),
        brief: {
          head: "감독 경질",
          items: [
            item({ label: "구단", text: teamNameIn(state, team.id) }),
            item({ label: "감독", text: state.manager.name, note: input.reason }),
            item({ label: "위약금", text: formatMoney(state.dismissal?.severance ?? 0) }),
          ],
        },
      };
    }
    if (!team.managerName) return { ok: false, message: "이미 공석입니다" };
    const outgoingName = team.managerName;
    reportSacking(state, {
      teamId: team.id,
      kind: "sacked",
      ...(team.managerSince ? { since: team.managerSince } : {}),
    });
    vacateManagerPost(state, team);
    return {
      ok: true,
      message: `${team.id} 감독 경질 — ${input.reason}`,
      brief: {
        head: "감독 경질",
        items: [
          item({ label: "구단", text: teamNameIn(state, team.id) }),
          item({ label: "감독", text: outgoingName, note: input.reason }),
        ],
      },
    };
  }
  if (
    team.id === managedTeamId(state) ||
    team.managerName ||
    !state.managerVacancies.some((v) => v.teamId === team.id)
  )
    return { ok: false, message: "실제 공석에만 선임할 수 있습니다" };
  const name = input.managerName;
  if (name === state.manager.name || state.teams.some((other) => other.managerName === name))
    return { ok: false, message: "이미 재직 중인 감독 또는 유저 감독입니다" };
  if (
    state.personas.some(
      (person) =>
        person.name === name && person.employment && person.employment.contract.until >= state.date,
    )
  )
    return { ok: false, message: "현재 스태프로 재직 중인 인물입니다" };
  if (state.players.some((player) => player.name === name))
    return { ok: false, message: "현역 선수는 감독으로 선임할 수 없습니다" };
  const candidate = state.managerPool.find((entry) => entry.name === name);
  const persona = state.personas.find((person) => person.name === name);
  const rating = candidate?.rating ?? input.rating;
  if (rating === undefined) return { ok: false, message: "새 감독의 전술 역량이 필요합니다" };
  if (persona) {
    if (persona.employment)
      archiveEmployment(persona, addDays(persona.employment.contract.until, 1), "expired");
    persona.role = "manager";
  }
  if (state.staffPool) state.staffPool = state.staffPool.filter((entry) => entry.name !== name);
  team.managerName = name;
  team.managerSince = state.date;
  team.aiManagerTacticsRating = rating;
  team.managerSpells = candidate?.spells ?? [];
  state.managerPool = state.managerPool.filter((entry) => entry.name !== name);
  state.managerVacancies = state.managerVacancies.filter((vacancy) => vacancy.teamId !== team.id);
  for (const offer of state.managerOffers)
    if (offer.teamId === team.id && offer.status === "open") offer.status = "expired";
  for (const interview of state.managerInterviews)
    if (interview.teamId === team.id && interview.status === "pending")
      interview.status = "expired";
  reportAppointment(state, {
    teamId: team.id,
    managerName: name,
    fromPool: candidate !== undefined,
  });
  return {
    ok: true,
    message: `${team.id} 감독 선임 — ${name}`,
    brief: {
      head: "감독 선임",
      items: [
        item({ label: "구단", text: teamNameIn(state, team.id) }),
        item({ label: "감독", text: name, note: input.reason }),
        item({ label: "전술 역량", text: String(rating) }),
      ],
    },
  };
}
