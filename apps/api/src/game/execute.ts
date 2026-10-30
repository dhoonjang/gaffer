import { edit, apply, loreTasks, type LoreTask } from "./lorebook";
import { saveGame } from "./persistence";
import { toPayload } from "../../../web/game/store";
import { SAVE_VERSION, validateSave, gameSummary, type GameState } from "@gaffer/engine";
import { execution, withExecution, type Execution } from "./persistence";
import { runTurnLocked, type TurnStreamEvent } from "../../../web/game/turn-runner";
import { parseTurn } from "../../../web/app/api/games/[id]/turn/stream/route";
import * as games from "../../../web/app/api/games/route";
import * as game from "../../../web/app/api/games/[id]/route";
import * as lineup from "../../../web/app/api/games/[id]/lineup/route";
import * as live from "../../../web/app/api/games/[id]/match/live/route";
import * as close from "../../../web/app/api/games/[id]/match/close/route";
import * as mail from "../../../web/app/api/games/[id]/mail/route";
import * as negotiation from "../../../web/app/api/games/[id]/negotiation/route";
import * as player from "../../../web/app/api/games/[id]/player/[playerId]/route";
import * as report from "../../../web/app/api/games/[id]/match-report/[matchId]/route";
import type { Result } from "../jobs";

export interface Command {
  id: string;
  path: string;
  method: string;
  payload: unknown;
  snapshot: unknown;
  diagnostics?: boolean;
}
export interface Executed {
  result: Result;
  snapshot: unknown;
  summary: Record<string, unknown>;
  view: unknown;
  loreTasks: LoreTask[];
}
export async function execute(
  command: Command,
  onStream: (event: TurnStreamEvent) => void,
): Promise<Executed> {
  let state: GameState | null = null;
  if (command.snapshot !== null) {
    const parsed = validateSave(command.snapshot);
    if (!parsed.ok) throw new Error(`Save rejected: ${parsed.reason}`);
    state = parsed.state;
    if (state.id !== command.id) throw new Error("Snapshot identity mismatch");
  }
  const ctx: Execution = { id: command.id, state, saved: null, deferred: [] };
  return withExecution(ctx, async () => {
    if (command.path === "/internal/lorebook")
      return {
        result: state
          ? await edit(state, command.payload)
          : { status: 404, body: { error: "Missing game" } },
        snapshot: null,
        view: null,
        summary: {},
        loreTasks: [],
      };
    if (command.path === "/internal/lorebook-apply") {
      if (!state || !apply(state, command.payload))
        return {
          result: { status: 409, body: { error: "Character version changed" } },
          snapshot: null,
          view: null,
          summary: {},
          loreTasks: [],
        };
      saveGame(state);
      return {
        result: { status: 200, body: { ok: true } },
        snapshot: { ...state, saveVersion: SAVE_VERSION },
        view: toPayload(state),
        summary: { ...gameSummary(state) },
        loreTasks: loreTasks(state),
      };
    }
    const url = new URL(command.path, "http://internal");
    const req = new Request(url, {
      method: command.method,
      ...(command.method === "GET"
        ? {}
        : {
            body: JSON.stringify(command.payload),
            headers: { "Content-Type": "application/json" },
          }),
    });
    const context = { params: Promise.resolve({ id: command.id }) };
    const suffix = url.pathname.replace(/^\/api\/games(?:\/[^/]+)?/, "");
    let response: Response;
    if (url.pathname === "/api/games")
      response = command.method === "GET" ? games.GET(req) : await games.POST(req, onStream);
    else if (suffix === "/turn/stream") {
      const parsed = parseTurn(command.payload);
      if (!parsed.ok) response = parsed.response;
      else {
        const b = parsed.turn;
        const out = await runTurnLocked(
          command.id,
          b.message,
          onStream,
          b.operation,
          b.orders,
          b.mailMessageIds,
          b.addresseeId,
        );
        response = out.ok
          ? Response.json(out.payload)
          : // `detail` is present only in development (turn-runner `errorDetail`)
            Response.json(
              { error: out.error, retry: out.retry, ...(out.detail ? { detail: out.detail } : {}) },
              { status: out.status },
            );
      }
    } else if (suffix === "") response = await game.GET(req, context);
    else if (suffix === "/lineup") response = await lineup.POST(req, context);
    else if (suffix === "/match/live")
      response =
        command.method === "GET" ? await live.GET(req, context) : await live.POST(req, context);
    else if (suffix === "/match/close") response = await close.POST(req, context);
    else if (suffix === "/mail")
      response =
        command.method === "GET" ? await mail.GET(req, context) : await mail.POST(req, context);
    else if (suffix === "/negotiation")
      response =
        command.method === "GET"
          ? await negotiation.GET(req, context)
          : await negotiation.POST(req, context);
    else if (suffix.startsWith("/player/"))
      response = await player.GET(req, {
        params: Promise.resolve({ id: command.id, playerId: suffix.split("/")[2]! }),
      });
    else if (suffix.startsWith("/match-report/"))
      response = await report.GET(req, {
        params: Promise.resolve({ id: command.id, matchId: suffix.split("/")[2]! }),
      });
    else response = Response.json({ error: "Not found" }, { status: 404 });
    // Background edits are enqueued by the same SQL transaction as the save pointer.
    const saved = execution()?.saved;
    return {
      result: { status: response.status, body: (await response.json()) as unknown },
      snapshot: saved ? { ...saved, saveVersion: SAVE_VERSION } : null,
      loreTasks: saved ? loreTasks(saved) : [],
      view: saved ? toPayload(saved) : null,
      summary: saved ? { ...gameSummary(saved) } : {},
    };
  });
}
