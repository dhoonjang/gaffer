/** Recorded generative baseline and shared match command/schema definitions. Production uses jev-match-reader. */
import { POINTS_MAX, type GameState, playerById } from "@story-fm/engine";
import {
  SHEET_SHAPES,
  SHEET_SHAPE_KO,
  roleVocabularyText,
  type Point,
  type SheetLine,
  PointSchema,
  SheetLineSchema,
  type AttributeAxis,
  ATTRIBUTE_AXES,
  AXIS_KO,
} from "@story-fm/domain";
import { type OpsInput } from "../common/orders-ops";
import { type JsonObjectSchema } from "@story-fm/llm";
import { toToolSchema } from "../common/tool-schema";
import { z } from "zod";

/**
 * 판독기 — **경기의 위층을 쓰는 하나의 저자** (agents.md §3 · live-match.md §6.2).
 *
 * 말의 규칙이 역할·능력치·전술에서 경기를 결정적으로 굴리고, 그 위에서 이 경기가
 * 지금 어떻게 읽히는가를 문장으로 든 것이 전술 포인트, 그 판독의 수치 독해가 시트다.
 * 이 호출은 그 둘을 매번 전체로 다시 쓰고, 감독이 말한 턴이면 그 말을 판독 위에서
 * 읽어 명령의 인자까지 함께 낸다.
 *
 * 산출은 도구가 아니라 **이 호출의 출력 스키마** 하나다 (models.md §3-2). 값을 매기는
 * 것은 코어다 — 실재 확인·한도·예산·소화율은 말의 규칙이 시트를 접을 때 걸리고,
 * 여기서 고르는 것은 누구를·어느 레인을·어느 쪽으로·얼마나까지다.
 */

/**
 * 판독기가 채우는 **경기의 명령** — `TACTIC_OPS`의 부분집합이고 **적용 순서**다.
 * 교체를 먼저 넣고 그 위의 자리·역할이 온다. 대화는 판이 다 선 뒤에 남긴다.
 */
export const MATCH_OPS: readonly string[] = [
  "substitute",
  "set_tactics",
  "set_player_tactic",
  "set_set_piece_takers",
  "set_set_piece_routine",
  "set_shootout_order",
];

/** 한 포인트가 데리고 갈 수 있는 시트 줄 — 넘겨 와도 코어의 한도가 먼저 자른다 */
const SHEET_LINES_PER_POINT = 3;

/** 시트 줄의 상한 — 포인트 상한 × 포인트당 줄 */
export const SHEET_MAX = POINTS_MAX * SHEET_LINES_PER_POINT;

/** 모양의 부호가 무엇을 올리는가 — 낱말도 뜻도 `SHEET_SHAPES` 한 벌에서 온다 */
const SHEET_SIGN_KO: Record<(typeof SHEET_SHAPES)[number], string> = {
  behavior: "그 선수에게 개인 지시가 걸린다",
  edge: "그 선수가 이 경기에서 더 잘한다",
  focus: "공격이 그 레인으로 더 기운다",
  temper: "카드·파울이 늘어난다",
  legs: "다리가 빨리 죽는다",
  cohesion: "지시가 잘 스민다",
};

const SHEET_SHAPE_LINES = SHEET_SHAPES.map(
  (shape) => `${shape}(${SHEET_SHAPE_KO[shape]}) — +면 ${SHEET_SIGN_KO[shape]}, −면 그 반대`,
).join("\n- ");

const SHEET_STRENGTH_INSTRUCTION =
  "step은 0~3의 연속 강도다. 약한 영향과 불확실성은 소수로 반영한다. 0은 효과 없음이다.";

export const MATCH_READER_SYSTEM = `당신은 경기를 읽는 판독기다. 이 경기가 지금 어떻게 돌아가는가를 전술 포인트로 쓰고, 그 판독의 수치 독해를 시트로 옮긴다. 감독의 직접 지시는 이미 코어를 지났다. 변경된 판 위에서 전술적 의미와 대가를 읽는다. 중계도 대사도 쓰지 않는다.

# 무엇을 내나
- points — 이 경기의 전술 포인트 **전체**. 매번 처음부터 다시 쓴다. ${POINTS_MAX}줄까지.
- sheet — 포인트마다의 시트 줄. 한 포인트에 많아야 ${SHEET_LINES_PER_POINT}줄, 모두 합쳐 ${SHEET_MAX}줄까지.

# 전술 포인트
사실 몇 개를 하나의 뜻으로 묶은 한 줄이다 — "발 빠른 래쉬포드를 맨마킹하는 반다이크", "거친 플레이에 흔들리는 마이누", "왼쪽으로 몰리는 상대의 공격".
- 어느 팀의 메모가 아니라 **양 팀에 걸친 경기의 판독**이다. 상대 벤치의 작은 수 — 상대 센터백이 우리 윙어를 따라붙는 것, 한쪽 측면을 비우고 반대편에 몰리는 것 — 도 여기서 난다.
- 이어지는 판독은 **같은 id로** 남기고, 사라진 판독은 빼고, 새로 읽은 것은 새 id로 더한다.
- about에는 그 판독이 겨눈 선수의 id와 편(home·away)을 적는다. importance 1~3 — 이 경기를 가르는 정도.
- 근거 없는 줄은 쓰지 않는다. <facts>와 <events>에 선 사실에서 읽는다.

# 시트
포인트 하나를 가리키는 줄이고, 코어가 읽는 것은 이것뿐이다. 고르는 것은 누구를·어느 레인을·어느 쪽으로·얼마나까지다.
- ${SHEET_SHAPE_LINES}
- target — behavior·edge·temper·legs는 선수 한 명(player). focus는 편(side)과 레인(lane). cohesion은 편(side).
- behavior에는 action이 붙는다 — press(공 또는 targetPlayer 압박) · mark(targetPlayer 추적) · cover(표적 뒤 공간) · support(공 주변 지원) · run(지역 침투) · hold(기본 자리 유지). when은 attack(우리 소유)·defend(상대 소유)·always. 지역은 lane(left·center·right)과 band(defense·midfield·attack)다. 표적 없는 mark는 보내지 않는다.
- ${SHEET_STRENGTH_INSTRUCTION}
- **이득만 있는 판독은 없다.** 마킹은 마커의 본업을 비우고, 오버랩은 뒤를 연다 — 이득 줄을 쓴 포인트에는 그 대가 줄도 쓴다.
- 포인트가 없으면 시트도 없다. 좌표나 성공 확률을 만들지 않는다.

# 감독의 말
- 감독의 말을 판독의 근거로 읽는다. 실행되지 않은 교체·자리·전술 변경을 이미 일어난 사실로 쓰지 않는다.
- 판독은 <facts>와 코어가 적용한 <standing>에 근거한다. 대화의 감정과 약속은 GM의 몫이다.

# 입력
- <ledger> 스코어·시각·온필드와 벤치·교체 횟수 · <standing> 우리가 걸어 둔 전술 · <match_state> 지금까지의 경기 통계 · <facts> 양 팀의 능력치와 선수별 경기 통계·체력·카드 · <points> 지금 서 있는 전술 포인트 · <match_log> 이 경기의 지난 턴 · <board_moves> 이번 턴 감독이 전술판에서 움직인 것.
- <events> 지난 판독 뒤 일어난 사건. <pre_match> 경기 전 감독이 한 말.
- @감독: 이번 턴 감독의 말. 없으면 판독만 다시 쓴다.

# 자리별 역할
${roleVocabularyText()}`;

/** The pilot replaces scalar generation; both paths share the remaining instructions. */
export function matchReaderSystem(probabilistic: boolean): string {
  return probabilistic
    ? MATCH_READER_SYSTEM.replace(
        SHEET_STRENGTH_INSTRUCTION,
        "시트에는 대상·모양·방향·동작만 적는다. 강도(step)는 쓰지 않는다.",
      )
    : MATCH_READER_SYSTEM;
}

/** 판독기가 내는 것 — 명령의 인자와, 이 경기의 포인트·시트 */
export interface MatchReaderOutput {
  ops: OpsInput;
  /** 상한에 걸려 자른 수 — 명령 이름별. `applyOps`가 한 줄로 되돌린다 */
  truncated?: Readonly<Record<string, number>>;
  points: Point[];
  sheet: SheetLine[];
  unresolved?: string;
}

/**
 * 이 호출이 요청에 싣는 출력 스키마 — `{ ops, points, sheet, unresolved }`.
 * `ops`의 인자는 명령의 도구 정의에서 그대로 오고(`buildOpsSchema`), 포인트와 시트는
 * 도메인의 Zod에서 파생한다. 상한은 설명 문장으로 간다 — 지키는 것은 코어다.
 */
export function matchReaderOutputSchema(): JsonObjectSchema {
  return {
    type: "object",
    required: ["points", "sheet"],
    properties: {
      points: {
        type: "array",
        items: toToolSchema(PointSchema),
        description: `이 경기의 전술 포인트 전체 — 최대 ${POINTS_MAX}줄. 이어지는 판독은 같은 id로 남긴다`,
      },
      sheet: {
        type: "array",
        items: toToolSchema(SheetLineSchema),
        description: `포인트마다의 시트 줄 — 한 포인트에 ${SHEET_LINES_PER_POINT}줄까지, 모두 합쳐 ${SHEET_MAX}줄까지`,
      },
    },
  };
}

/** 이 호출의 한 벌 — 출력 스키마 선언 열(`outputAgents`)도 이것을 읽는다 */
export const MATCH_READER_SPEC = {
  agent: "reader-baseline",
  system: MATCH_READER_SYSTEM,
  schema: matchReaderOutputSchema,
} as const;

/** 모델이 낸 판독 — 포인트와 시트는 도메인의 Zod가 그대로 잰다 */
export const ReaderReportSchema = z.object({
  points: z.array(PointSchema).max(POINTS_MAX),
  sheet: z.array(SheetLineSchema).max(SHEET_MAX),
});

// ── 입력 블록 ─────────────────────────────────────────────

/** 16축 가운데 그 자리가 쓰는 것 — 골키핑은 골문에 선 사람의 축이다 */
function axesFor(position: string): readonly AttributeAxis[] {
  return position === "GK"
    ? ATTRIBUTE_AXES
    : ATTRIBUTE_AXES.filter((axis) => axis !== "goalkeeping");
}

/** 한 선수의 진짜 능력치 한 줄 — 판독기에는 안개가 없다 (agents.md §3) */
export function attributeLine(state: GameState, id: string, position: string): string {
  const player = playerById(state, id);
  if (!player) return "";
  return axesFor(position)
    .map((axis) => `${AXIS_KO[axis]}${player.attributes[axis]}`)
    .join(" ");
}

/**
 * `<points>` — **지금 서 있는 판독 전부.** 감독에게 가는 것과 달리 안개가 없다
 * (`pointsSeenBy`는 매치 GM의 블록이다).
 */
export function buildPointsBlock(state: GameState): string[] {
  const points = state.pendingMatch?.live.points ?? [];
  if (points.length === 0) return [];
  return [
    `<points>`,
    ...points.map(
      (p) =>
        `- ${p.id} [중요도 ${p.importance}${p.about.length > 0 ? ` · ${p.about.join(", ")}` : ""}] ${p.text}`,
    ),
    `</points>`,
  ];
}

/** `<pre_match>` 안쪽만 — 블록을 세우는 자리는 `tagged` 하나다 */
export function stripTag(block: string): string {
  return block
    .split("\n")
    .filter((line) => !line.startsWith("<"))
    .join("\n");
}

/** 판독이 오지 않은 자리의 한 줄 — 문구는 여기 하나다 */
export const FAILED_NOTE = "경기를 읽지 못했습니다 — 다시 말씀해 주세요";
