import { NextResponse } from "next/server";
import { CatalogTeamEditSchema } from "@gaffer/domain";
import {
  adminRemoveTeam,
  adminTeamCatalog,
  adminUpdateTeam,
  isTeamCatalogEdited,
} from "@gaffer/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";

function payload(message: string) {
  return {
    ok: true,
    message,
    teams: adminTeamCatalog(),
    edited: isTeamCatalogEdited(),
  };
}

/** 카탈로그 팀 편집 */
export const PATCH = adminWrite(async function (
  request: Request,
  context: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await context.params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = CatalogTeamEditSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? "입력 오류" },
      { status: 400 },
    );
  }
  const res = adminUpdateTeam(teamId, body.data);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json(payload(res.message));
});

/** 카탈로그에서 팀 삭제 — 그 팀의 선수도 함께 사라진다 */
export const DELETE = adminWrite(async function (
  _request: Request,
  context: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await context.params;
  const res = adminRemoveTeam(teamId);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json(payload(res.message));
});
