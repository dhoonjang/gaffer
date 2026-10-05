import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createGame,
  leagueTones,
  listGameSummaries,
  saveGame,
  teamCatalog,
  teamsOfLeague,
  topLeagues,
  turnDigestOf,
} from "@story-fm/engine";
import { runOnboarding } from "@story-fm/agents";
import { withGameUsage, bindTurnTrace, llmErrorKind, noteTurn, traceTurn } from "@story-fm/llm";
import { toPayload } from "@/game/store";
import { errorDetail, turnErrorMessage } from "@/game/turn-runner";

const CreateSchema = z.object({
  teamId: z.string().min(1),
  managerName: z.string().min(1).max(30),
  background: z.string().min(1).max(500),
  seed: z.number().int().optional(),
});

/** Saved games and the factual league/team catalog are separate responses. */
export function GET(request: Request) {
  if (new URL(request.url).searchParams.get("catalog") !== "1") {
    return NextResponse.json({ games: listGameSummaries() });
  }
  const leagues = topLeagues();
  const ids = new Set(leagues.map((l) => l.id));
  const sizeOf = new Map(leagues.map((l) => [l.id, teamsOfLeague(l.id).length]));
  // 리그 색은 다섯을 함께 봐야 나온다 (web/design-system.md §2-1) — 한 번 세어 행마다 싣는다
  const tones = leagueTones();
  return NextResponse.json({
    // 리그 행이 「20팀」을 세우는 그 수 — 화면이 팀 배열을 따로 세지 않는다
    leagues: leagues.map((l) => ({ ...l, size: sizeOf.get(l.id) ?? 0, tone: tones.get(l.id) })),
    teams: teamCatalog().filter((team) => ids.has(team.leagueId)),
  });
}

/** 새 게임 생성 — 배경 직접 입력 → 능력치 배분 (career.md §1) */
export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = CreateSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? "입력 오류" },
      { status: 400 },
    );
  }
  const { teamId, managerName, background, seed } = body.data;
  const team = teamCatalog().find((t) => t.id === teamId);
  if (!team || !topLeagues().some((l) => l.id === team.leagueId)) {
    return NextResponse.json({ error: `부임할 수 없는 팀: ${teamId}` }, { status: 400 });
  }

  const state = createGame({
    seed,
    userTeamId: teamId,
    managerName,
    background,
    // 부임 구단도 판정에 넣는다 — 빅클럽이 뽑았다는 사실이 이력에 대한 정보다
  });

  // 토큰 예산의 단위는 게임이다 — 새 게임의 장부는 첫 호출부터 센다 (models.md §4)

  // 첫 장면의 원문도 이 게임의 사이드카에 앉는다 — 묶는 것은 `traceTurn` 범위 안에서만 된다
  const opened = await withGameUsage(state.id, () =>
    traceTurn(state.id, async () => {
      noteTurn({
        input: { kind: "onboarding", teamId, seed, managerName, background, date: state.date },
        before: turnDigestOf(state),
      });
      try {
        const intro = await runOnboarding(state, background);
        state.chat.push({
          role: "model",
          text: intro.text,
          toolCalls: intro.toolCalls,
          at: state.date,
          ...(intro.suggestion ? { suggestion: intro.suggestion } : {}),
        });
        bindTurnTrace(state.id, state.chat.length - 1);
        const payload = toPayload(state);
        const after = turnDigestOf(state);
        saveGame(state);
        noteTurn({ outcome: { ok: true, saved: true }, after });
        return { ok: true as const, payload };
      } catch (error) {
        console.error("[games] 온보딩 실패 — 게임을 만들지 않는다:", error);
        noteTurn({
          outcome: {
            ok: false,
            saved: false,
            error: error instanceof Error ? error.message : String(error),
          },
          after: turnDigestOf(state),
        });
        return { ok: false as const, error };
      }
    }),
  );
  if (!opened.ok) {
    return NextResponse.json(
      { error: turnErrorMessage(llmErrorKind(opened.error)), ...errorDetail(opened.error) },
      { status: 502 },
    );
  }
  return NextResponse.json(opened.payload);
}
