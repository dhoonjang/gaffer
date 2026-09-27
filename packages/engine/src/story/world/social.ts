import { type GameState, userPlayers, firstTeamPlayers } from "../../common/core/state";
import {
  type ReactionInput,
  type ReactionAxis,
  ReactionSchema,
  REACTION_SEASON_CAP,
} from "@story-fm/domain";
import { clampForm, moraleToForm } from "../../common/players/form";

/** 입력을 검증한 뒤 실제 평판 변화만 공통 시즌 장부에 기록한다. */
export function applySocialReaction(
  state: GameState,
  input: {
    reaction: ReactionInput;
    band: number;
    targetPlayerId?: string | null;
    targetPlayerIds?: readonly string[];
    rivalTeamId?: string;
    axes?: readonly ReactionAxis[];
  },
): SocialEffect {
  const reaction = ReactionSchema.parse(input.reaction);
  const live = new Set(input.axes ?? AXES);
  const on = (axis: ReactionAxis) => (live.has(axis) ? reaction[axis] : 0);
  if (state.manager.reactionSeason.season !== state.season) {
    state.manager.reactionSeason = { season: state.season, board: 0, media: 0, squad: 0 };
  }
  const season = state.manager.reactionSeason;
  const rep = state.manager.reputation;
  const stepOf = (axis: "board" | "media" | "squad") => {
    const raw = on(axis) * input.band;
    const sameDirection = raw * season[axis] > 0;
    const room = sameDirection ? Math.max(0, 1 - Math.abs(season[axis]) / REACTION_SEASON_CAP) : 1;
    const proposed = Math.round(raw * room);
    const bounded = Math.max(
      -REACTION_SEASON_CAP - season[axis],
      Math.min(REACTION_SEASON_CAP - season[axis], proposed),
    );
    const next = Math.max(0, Math.min(100, rep[axis] + bounded));
    const actual = next - rep[axis];
    rep[axis] = next;
    season[axis] += actual;
    return actual;
  };
  const board = stepOf("board"),
    media = stepOf("media"),
    squad = stepOf("squad");
  const players = userPlayers(state);
  const team = Math.round(on("team") * input.band);
  for (const player of players)
    player.state.form = clampForm(player.state.form + moraleToForm(team));
  const targets = new Set(
    input.targetPlayerIds ?? (input.targetPlayerId ? [input.targetPlayerId] : []),
  );
  const parties = players.filter((p) => targets.has(p.id));
  const target = parties.length ? Math.round(on("target") * input.band) : 0;
  for (const player of parties)
    player.state.form = clampForm(player.state.form + moraleToForm(target));
  const rival = input.rivalTeamId ? Math.round(on("rival") * RIVAL_BAND) : 0;
  if (input.rivalTeamId) {
    for (const p of firstTeamPlayers(state, input.rivalTeamId))
      p.state.form = clampForm(p.state.form + moraleToForm(rival));
  }
  return {
    board,
    media,
    squad,
    target,
    targetName: parties[0]?.name ?? null,
    team,
    ...(rival ? { rival } : {}),
  };
}

export { REACTION_SEASON_CAP } from "@story-fm/domain";

export const RIVAL_BAND = 6;

export const AXES: readonly ReactionAxis[] = ["board", "media", "squad", "target", "team", "rival"];

export interface SocialEffect {
  board: number;
  media: number;
  squad: number;
  target: number;
  targetName: string | null;
  team: number;
  rival?: number;
}

export const BOARD_REVIEW_BAND = 6;
