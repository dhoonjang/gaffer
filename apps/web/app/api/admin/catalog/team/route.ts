import { NextResponse } from "next/server";
import { CatalogTeamInputSchema } from "@gaffer/domain";
import {
  adminAddTeam,
  adminResetTeamCatalog,
  adminTeamCatalog,
  isTeamCatalogEdited,
} from "@gaffer/engine";
import { adminWrite } from "@/app/api/admin/admin-guard";

/**
 * 팀 카탈로그 어드민 — 클럽의 정체성(이름·리그·체급·포메이션)과 살림을 편집한다.
 * 선수 카탈로그와 같은 규칙이다: 변경은 **이후 새로 시작하는 게임**에만 반영된다.
 *
 * API는 타입·범위만 본다 — 리그 정원·컵 규모 같은 세계의 성립 조건은 엔진의
 * 불변식 검사(`catalog-invariants.ts`)가 막고, 그 메시지를 그대로 전달한다.
 */

function payload(message: string) {
  return {
    ok: true,
    message,
    teams: adminTeamCatalog(),
    edited: isTeamCatalogEdited(),
  };
}

export function GET() {
  return NextResponse.json({
    teams: adminTeamCatalog(),
    edited: isTeamCatalogEdited(),
  });
}

/** 카탈로그에 새 팀 추가 — 스쿼드는 엔진이 함께 채운다 */
export const POST = adminWrite(async function (request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 본문입니다" }, { status: 400 });
  }
  const body = CatalogTeamInputSchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json(
      { error: body.error.issues[0]?.message ?? "입력 오류" },
      { status: 400 },
    );
  }
  const res = adminAddTeam(body.data);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json(payload(res.message));
});

/** 팀 카탈로그를 시드 기본값으로 되돌린다 (전술 성향·구단 프로필 포함) */
export const DELETE = adminWrite(async function () {
  const res = adminResetTeamCatalog();
  return NextResponse.json(payload(res.message));
});
