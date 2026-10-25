import type { Config } from "./config";
type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Response | Promise<Response>;
import * as route0 from "../../web/app/api/admin/catalog/cup/[cupId]/route";
import * as route1 from "../../web/app/api/admin/catalog/cup/route";
import * as route2 from "../../web/app/api/admin/catalog/league/[leagueId]/route";
import * as route3 from "../../web/app/api/admin/catalog/league/route";
import * as route4 from "../../web/app/api/admin/catalog/person/route";
import * as route5 from "../../web/app/api/admin/catalog/player/[playerId]/route";
import * as route6 from "../../web/app/api/admin/catalog/route";
import * as route7 from "../../web/app/api/admin/catalog/team/[teamId]/route";
import * as route8 from "../../web/app/api/admin/catalog/team/route";
import * as route9 from "../../web/app/api/admin/usage/route";
import * as route10 from "../../web/app/api/games/[id]/lineup/route";
import * as route11 from "../../web/app/api/games/[id]/mail/route";
import * as route12 from "../../web/app/api/games/[id]/match/close/route";
import * as route13 from "../../web/app/api/games/[id]/match/live/route";
import * as route14 from "../../web/app/api/games/[id]/match-report/[matchId]/route";
import * as route15 from "../../web/app/api/games/[id]/negotiation/route";
import * as route16 from "../../web/app/api/games/[id]/player/[playerId]/route";
import * as route17 from "../../web/app/api/games/[id]/route";
import * as route18 from "../../web/app/api/games/[id]/trace/[index]/route";
import * as route19 from "../../web/app/api/games/[id]/turn/stream/route";
import * as route20 from "../../web/app/api/games/route";
import * as route21 from "../../web/app/api/lab/[id]/route";
import * as route22 from "../../web/app/api/lab/route";
const routes = [
  { pattern: new RegExp("^/api/admin/catalog/cup/([^/]+)$"), names: ["cupId"], handlers: route0 },
  { pattern: new RegExp("^/api/admin/catalog/cup$"), names: [], handlers: route1 },
  {
    pattern: new RegExp("^/api/admin/catalog/league/([^/]+)$"),
    names: ["leagueId"],
    handlers: route2,
  },
  { pattern: new RegExp("^/api/admin/catalog/league$"), names: [], handlers: route3 },
  { pattern: new RegExp("^/api/admin/catalog/person$"), names: [], handlers: route4 },
  {
    pattern: new RegExp("^/api/admin/catalog/player/([^/]+)$"),
    names: ["playerId"],
    handlers: route5,
  },
  { pattern: new RegExp("^/api/admin/catalog$"), names: [], handlers: route6 },
  { pattern: new RegExp("^/api/admin/catalog/team/([^/]+)$"), names: ["teamId"], handlers: route7 },
  { pattern: new RegExp("^/api/admin/catalog/team$"), names: [], handlers: route8 },
  { pattern: new RegExp("^/api/admin/usage$"), names: [], handlers: route9 },
  { pattern: new RegExp("^/api/games/([^/]+)/lineup$"), names: ["id"], handlers: route10 },
  { pattern: new RegExp("^/api/games/([^/]+)/mail$"), names: ["id"], handlers: route11 },
  { pattern: new RegExp("^/api/games/([^/]+)/match/close$"), names: ["id"], handlers: route12 },
  { pattern: new RegExp("^/api/games/([^/]+)/match/live$"), names: ["id"], handlers: route13 },
  {
    pattern: new RegExp("^/api/games/([^/]+)/match-report/([^/]+)$"),
    names: ["id", "matchId"],
    handlers: route14,
  },
  { pattern: new RegExp("^/api/games/([^/]+)/negotiation$"), names: ["id"], handlers: route15 },
  {
    pattern: new RegExp("^/api/games/([^/]+)/player/([^/]+)$"),
    names: ["id", "playerId"],
    handlers: route16,
  },
  { pattern: new RegExp("^/api/games/([^/]+)$"), names: ["id"], handlers: route17 },
  {
    pattern: new RegExp("^/api/games/([^/]+)/trace/([^/]+)$"),
    names: ["id", "index"],
    handlers: route18,
  },
  { pattern: new RegExp("^/api/games/([^/]+)/turn/stream$"), names: ["id"], handlers: route19 },
  { pattern: new RegExp("^/api/games$"), names: [], handlers: route20 },
  { pattern: new RegExp("^/api/lab/([^/]+)$"), names: ["id"], handlers: route21 },
  { pattern: new RegExp("^/api/lab$"), names: [], handlers: route22 },
];
export async function localTools(c: Config, request: Request): Promise<Response | null> {
  if (c.GAFFER_MODE !== "local" || c.GAFFER_AUTH_MODE !== "development") return null;
  const path = new URL(request.url).pathname;
  if (
    !path.startsWith("/api/admin") &&
    !path.startsWith("/api/lab") &&
    !path.match(/^\/api\/games\/lab-/) &&
    !path.includes("/trace/")
  )
    return null;
  for (const route of routes) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    const fn = (route.handlers as Record<string, unknown>)[request.method];
    if (typeof fn !== "function")
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    const params = Object.fromEntries(route.names.map((name, i) => [name, match[i + 1]!]));
    return (fn as Handler)(request, { params: Promise.resolve(params) });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}
