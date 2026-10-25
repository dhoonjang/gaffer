import { loadGame, saveGame } from "../../../../../api/src/game/persistence";
import { NextResponse } from "../../../../../api/src/game/persistence";
import { isLabGame } from "@gaffer/domain";
import {
  applyLabFormation,
  applyLabTactics,
  labView,
  openLabMatch,
  pruneLabGames,
  replayLabGame,
} from "@gaffer/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";
import { invalidGameId } from "@/app/api/games/game-id";
import { LAB_KEPT, LabActionSchema } from "@/game/lab-protocol";
import { LOCK_WAIT_MS, busyResponse, withGameLock } from "@/game/turn-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 실험실 판만 연다 — 이 문으로 게임 세이브를 고치지 않는다 */
function badLab(id: string): Response | null {
  return (
    invalidGameId(id) ??
    (isLabGame(id) ? null : NextResponse.json({ error: "실험실 판이 아닙니다" }, { status: 404 }))
  );
}

const missing = () => NextResponse.json({ error: "실험실 판을 찾을 수 없습니다" }, { status: 404 });

/** 판 한 장 — 화면이 처음 서거나 새로 고칠 때 */
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const bad = badLab(id);
  if (bad) return bad;
  const state = loadGame(id);
  const lab = state ? labView(state) : null;
  return lab ? NextResponse.json({ lab }) : missing();
}

/** 상대 모양 · 상대 전술 · 경기 판 세우기 · 다시 치르기 — 게임과 같은 잠금 안에서 읽고 고치고 쓴다 */
export const POST = adminWrite(async (request: Request, context: Context) => {
  const { id } = await context.params;
  const bad = badLab(id);
  if (bad) return bad;
  const parsed = LabActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "실험실 요청이 올바르지 않습니다" }, { status: 400 });
  const action = parsed.data;
  return withGameLock(id, LOCK_WAIT_MS.lineup, () => {
    const state = loadGame(id);
    if (!state) return missing();
    if (action.kind === "replay") {
      const made = replayLabGame(state);
      if (!made.ok) return NextResponse.json({ error: made.message }, { status: 400 });
      saveGame(made.state);
      pruneLabGames(LAB_KEPT);
      return NextResponse.json({ id: made.state.id });
    }
    const result =
      action.kind === "formation"
        ? applyLabFormation(state, action.formation)
        : action.kind === "tactics"
          ? applyLabTactics(state, action.tactics)
          : openLabMatch(state, { familiarity: action.familiarity });
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
    saveGame(state);
    return NextResponse.json({ lab: labView(state) });
  }).catch(busyResponse);
});
