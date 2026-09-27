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
import { PLAYER_POSITION_INSTRUCTION, TACTIC_CAPS } from "./tactic-orders";
import {
  type OpsInput,
  buildOpsSchema,
  unresolvedProperty,
  UnresolvedSchema,
} from "../common/orders-ops";
import { type GameToolSpec, type JsonObjectSchema } from "@story-fm/llm";
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
  "team_talk",
];

/** 한 포인트가 데리고 갈 수 있는 시트 줄 — 넘겨 와도 코어의 한도가 먼저 자른다 */
const SHEET_LINES_PER_POINT = 3;

/** 시트 줄의 상한 — 포인트 상한 × 포인트당 줄 */
const SHEET_MAX = POINTS_MAX * SHEET_LINES_PER_POINT;

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

export const MATCH_READER_SYSTEM = `당신은 경기를 읽는 판독기다. 이 경기가 지금 어떻게 돌아가는가를 전술 포인트로 쓰고, 그 판독의 수치 독해를 시트로 옮긴다. 감독이 말한 턴이면 그 말을 판독 위에서 읽어 명령의 인자도 함께 낸다. 중계도 대사도 쓰지 않는다.

# 무엇을 내나
- points — 이 경기의 전술 포인트 **전체**. 매번 처음부터 다시 쓴다. ${POINTS_MAX}줄까지.
- sheet — 포인트마다의 시트 줄. 한 포인트에 많아야 ${SHEET_LINES_PER_POINT}줄, 모두 합쳐 ${SHEET_MAX}줄까지.
- ops — 감독이 말한 턴에만. 부를 명령 이름 아래 그 인자를 배열로.
- unresolved — 어느 자리에도 담기지 않은 감독의 말.

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
- step은 0~3의 연속 강도다. 약한 영향과 불확실성은 소수로 반영한다. 0은 효과 없음이다.
- **이득만 있는 판독은 없다.** 마킹은 마커의 본업을 비우고, 오버랩은 뒤를 연다 — 이득 줄을 쓴 포인트에는 그 대가 줄도 쓴다.
- 포인트가 없으면 시트도 없다. 좌표나 성공 확률을 만들지 않는다.

# 감독의 말
- "붙어서 지워" · "그 뒤를 덮어" · "왼쪽으로 몰아"는 포인트·시트로 옮긴다.
- 자리·역할·교체·6축·키커·대화는 ops로 실행한다. 말하지 않은 축·역할은 보내지 않는다.
- 옮길 수 있는 것은 다 싣고 막힌 말만 unresolved에 남긴다. 감독이 정하지 않고 맡긴 말("알아서 하세요")에는 채울 것이 없다 — 지어내지 않고 unresolved에 남긴다.
- 훈련·육성·이적의 말은 여기서 옮기지 않고 unresolved에도 남기지 않는다.

# 판에서 이미 움직인 것
<board_moves>의 축·선수·자리를 가리키는 말은 그 줄의 앞 값에 대 본다.
판이 간 곳과 같으면 감독이 방금 판에서 한 일을 말로 설명한 것이다 — 그 명령을 싣지 않는다.
다른 곳을 가리키면(더 멀리·반대로) <standing>의 지금 값에서 움직여 싣는다.

# 대화 (team_talk)
감독이 그 사람에게 건넨 말이 있을 때만 싣고, 그 말이 어떻게 닿았는지를 라벨로 고른다.
- 판정은 의미 있는 대화가 마무리된 턴에 한 번이다 — 감독이 자리를 뜨거나 화제가 닫히거나 장면이 넘어갈 때. 대화 도중에는 싣지 않는다.
- 이름을 부르기만 한 말(“브루노 일루와봐”, “잠깐 와봐”)은 부름이지 대화가 아니다 — 비운다.
- players에 이름을 적으면 그 사람들, 비우면 선수단 전체다. 이름 없이 가리키면 <match_log>에서 가장 최근에 그 자리에 있던 사람이다. 지시가 앞 턴의 대화를 잇는 말이면 그 대화가 근거다.
- outcome은 감독 발화의 (a) 맥락 적합성 (b) 설득 근거 (c) 대상 수용성으로 판정한다. inspired는 드물다 — 말이 그 사람의 처지에 정확히 닿고 근거가 섰을 때만이고, 평범한 격려는 encouraged다.
- intensity 1~3 — 말의 세기. occasion은 킥오프 전 pre · 하프타임 half · 종료 후 post · 그 밖 daily · 굴러가던 중 정지점의 짧은 외침 shout(“정신 차려”, “머리 들어”).
- promise는 이번 턴에 감독이 그 사람에게 못 박은 약속(출전·이적 허용·재계약·주장·등번호)만. 지난 턴의 약속을 다시 싣지 않고, 이미 말해 뒀다는 말과 선발에서 빼는 말에는 약속이 없다.
- 그 사람의 심경이 한 줄로 남을 만하면 moods에 적는다.

# 판을 바꾸는 명령
- substitute — 교체 한 건. out/in은 <ledger>의 id. 여럿이면 배열에 여럿.
- set_tactics — 6축(1~5)과 갈래 중 감독이 말한 것만.
- set_player_tactic — 그라운드에 있는 한 선수의 자리와 역할.
  - ${PLAYER_POSITION_INSTRUCTION}
  - role은 그 자리의 역할이다 — 감독이 시키는 일이 「자리별 역할」의 한 종이면 그것을 적는다. 이름·id·약어 어느 표기든 걸린다. 표에 없는 말은 포인트와 시트로 옮긴다.
- set_set_piece_takers — 세트피스 키커. corner·freeKick·penalty 중 감독이 말한 자리만 싣고, 지정을 풀라는 말이면 그 자리에 null을 넣는다.
- set_set_piece_routine — 세트피스에 몇 명이 서는가. 감독이 말한 축만.
- set_shootout_order — 승부차기 키커 순서. 감독이 이름을 든 사람만.

# 입력
- <ledger> 스코어·시각·온필드와 벤치·교체 횟수 · <standing> 우리가 걸어 둔 전술 · <match_state> 지금까지의 경기 통계 · <facts> 양 팀의 능력치와 선수별 경기 통계·체력·카드 · <points> 지금 서 있는 전술 포인트 · <match_log> 이 경기의 지난 턴 · <board_moves> 이번 턴 감독이 전술판에서 움직인 것.
- <events> 지난 판독 뒤 일어난 사건. <pre_match> 경기 전 감독이 한 말.
- @감독: 이번 턴 감독의 말. 없으면 판독만 다시 쓴다.

# 자리별 역할 (set_player_tactic의 role)
${roleVocabularyText()}`;

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
export function matchReaderOutputSchema(
  specs: ReadonlyMap<string, GameToolSpec>,
): JsonObjectSchema {
  return {
    type: "object",
    properties: {
      ops: buildOpsSchema(specs, MATCH_OPS, "부를 명령과 그 인자 — 감독이 말한 것만", TACTIC_CAPS),
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
      unresolved: unresolvedProperty(
        "어느 명령에도, 어느 포인트에도 담기지 않은 감독의 말. 남은 말이 없으면 생략하거나 빈 문자열",
      ),
    },
  };
}

/** 이 호출의 한 벌 — 출력 스키마 선언 열(`outputAgents`)도 이것을 읽는다 */
export const MATCH_READER_SPEC = {
  agent: "match-reader",
  system: MATCH_READER_SYSTEM,
  schema: matchReaderOutputSchema,
} as const;

/** 모델이 낸 판독 — 포인트와 시트는 도메인의 Zod가 그대로 잰다 */
export const ReaderReportSchema = z.object({
  ops: z.record(z.unknown()).optional(),
  points: z.array(PointSchema).optional(),
  sheet: z.array(SheetLineSchema).optional(),
  unresolved: UnresolvedSchema.optional(),
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
