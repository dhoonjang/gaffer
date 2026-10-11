import { NextResponse } from "next/server";
import {
  applyLabFormation,
  applyLabTactics,
  isLabGame,
  kickoffLab,
  labView,
  loadGame,
  markEventsSeen,
  rewindLab,
  saveGame,
  type GameState,
} from "@gaffer/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";
import { invalidGameId } from "@/app/api/games/game-id";
import { LabActionSchema, type LabSnapshot } from "@/game/lab-protocol";
import { toPayload } from "@/game/store";
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

function snapshotOf(state: GameState): LabSnapshot | null {
  const lab = labView(state);
  return lab ? { game: toPayload(state), lab } : null;
}

/** 판 한 장 — 화면이 처음 서거나 새로 고칠 때 */
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const bad = badLab(id);
  if (bad) return bad;
  const state = loadGame(id);
  const snapshot = state ? snapshotOf(state) : null;
  return snapshot ? NextResponse.json(snapshot) : missing();
}

/** 모양 · 전술 · 킥오프 · 정지점 읽음 · 되돌리기 — 게임과 같은 잠금 안에서 읽고 고치고 쓴다 */
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
    if (action.kind === "seen") {
      markEventsSeen(state);
      saveGame(state);
      return NextResponse.json({ lab: labView(state) });
    }
    const result =
      action.kind === "formation"
        ? applyLabFormation(state, action.side, action.formation)
        : action.kind === "tactics"
          ? applyLabTactics(state, action.side, action.tactics)
          : action.kind === "kickoff"
            ? kickoffLab(state, { familiarity: action.familiarity })
            : rewindLab(state);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
    saveGame(state);
    return NextResponse.json(snapshotOf(state));
  }).catch(busyResponse);
});
