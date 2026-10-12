import { TACTIC_OPS } from "../evaluators/tactic-orders";
import { TRAINING_OPS } from "../evaluators/training-orders";
import { FINANCE_OPS } from "../evaluators/finance-orders";
import { contractEndForYears, formatScore, narration, sceneMarker } from "@gaffer/domain";
import {
  addDays,
  buildMailView,
  clockOf,
  describeNextFixture,
  minutesOfClock,
  managedTeamId,
  nextMatchFor,
  teamName,
  type GameState,
} from "@gaffer/engine";
import type { ScriptedCall, ScriptedTurn } from "@gaffer/llm";
import type { OpsInput } from "../evaluators/orders-ops";
import { SUGGEST_REPLY_TAG } from "../shared/suggest-reply";

/**
 * mock 모드는 감독 원문과 정확히 일치하는 대본 항목만 실행한다.
 * 각 항목이 GM 도구 호출과 해석기의 ops를 함께 지정한다. 등록하지 않은 원문은 도구를 부르지 않는다.
 */

/** 표의 한 줄이 인자를 채울 때 읽는 것 */
interface ScriptContext {
  state: GameState;
  /** 감독이 부른 이름 — 이름 자리(`<선수>`)를 둔 줄만 값을 갖는다 */
  named: string;
}

/** 이름 한 자리 — 표의 키에서 이 토큰이 선 곳에 감독이 부른 이름이 들어간다 */
const NAME_SLOT = "<선수>";

interface ScriptLine {
  /** 감독의 말. `<선수>` 한 자리는 이름이 들어갈 곳이다 */
  say: string;
  /**
   * 며칠을 넘기는 말인가 — 시계는 **시점 헤더가** 민다(실모드와 같은 입구다).
   * `"next_match"`면 다음 유저 경기의 날짜를 적고, 코어가 그 앞에서 멈춰 세운다.
   */
  skip?: number | "next_match";
  /** GM이 부르는 도구 시퀀스 */
  gm?: (ctx: ScriptContext) => ScriptedCall[];
  /** 해석기가 채우는 명령 — GM이 해석기 도구를 불렀을 때만 선다 */
  ops?: (ctx: ScriptContext) => OpsInput;
}

/**
 * **감독의 다음 말 하나** — 실모드의 GM이 장면 마지막 줄에 태그로 내는 것을 대본도 매 턴
 * 낸다 (agents.md §8 · prompts.md §1). 글은 전부 표의 키다: Tab으로 받아 그대로 보내면 그
 * 줄이 걸리므로 e2e가 자동완성을 그 길로 잰다.
 */
const suggestLine = (text: string): string =>
  `<${SUGGEST_REPLY_TAG}>${text}</${SUGGEST_REPLY_TAG}>`;

/** 평시의 제안 — 경기일에 닿았거나 닿을 턴이면 킥오프로, 아니면 하루를 넘기는 말 */
function peaceSuggestion(state: GameState, line: ScriptLine | null): string {
  return state.phase === "matchday" || line?.skip === "next_match"
    ? "경기 시작하자"
    : "하루 넘기자";
}

/** 요일 반복 훈련 한 벌 — 달력에 걸릴 제목과 효과 축은 표가 고른다 */
const weekly = (dows: readonly number[], label: string, focus: readonly string[]): OpsInput => ({
  set_training: [{ repeatWeekly: dows.map((dow) => ({ dow, slot: "am", label, focus })) }],
});

const WEEKDAYS = [1, 2, 3, 4, 5] as const;

/**
 * **표** — 위에서 아래로 훑어 처음 걸린 줄이 그 턴의 대본이다.
 *
 * 글자까지 같은 줄이 먼저 걸리고, 이름 자리를 둔 줄은 그다음이다. e2e가 채팅에 치는
 * 말은 이 표의 키와 같게 맞춘다 (`e2e/*.spec.ts`).
 */
const SCRIPT: readonly ScriptLine[] = [
  {
    say: "테스트 이적 명단 등록",
    gm: ({ state }) => {
      const player = state.players.find(
        (p) =>
          p.teamId === managedTeamId(state) &&
          state.contracts.some((c) => c.gamePlayerId === p.id && c.status === "active"),
      );
      return player
        ? [
            {
              tool: "set_transfer_list",
              input: { playerId: player.id, listed: true, askingPrice: 10000000 },
            },
          ]
        : [];
    },
  },
  {
    say: "테스트 재계약 협상",
    gm: ({ state }) => {
      const player = state.players.find(
        (p) =>
          p.teamId === managedTeamId(state) &&
          state.contracts.some((c) => c.gamePlayerId === p.id && c.status === "active"),
      );
      return player
        ? [
            {
              tool: "start_negotiation",
              input: { playerId: player.id, kind: "renewal", background: "재계약 논의" },
            },
          ]
        : [];
    },
  },

  {
    say: "테스트 재계약 조건 제안",
    gm: ({ state }) => {
      const n = state.negotiations.find(
        (n) => n.kind === "renewal" && n.buyerId === managedTeamId(state) && n.status === "open",
      );
      if (!n) return [];
      return [
        {
          tool: "update_negotiation",
          input: {
            negotiationId: n.id,
            partyId: n.playerId,
            action: {
              kind: "send",
              terms: {
                scope: "player",
                fee: 0,
                installments: [],
                weeklyWage: Math.floor((n.bounds.minWeeklyWage + n.bounds.maxWeeklyWage) / 2),
                signingBonus: 0,
                since: state.date,
                until: contractEndForYears(state.date, 3),
                promises: [],
                expiresOn: addDays(state.date, 14),
              },
            },
          },
        },
        {
          tool: "request_negotiation_confirmation",
          input: { negotiationId: n.id, stage: "agreement" },
        },
      ];
    },
  },
  {
    say: "테스트 재계약 최종 확인",
    gm: ({ state }) => {
      const n = state.negotiations.find(
        (n) => n.kind === "renewal" && n.buyerId === managedTeamId(state) && n.status === "open",
      );
      return n
        ? [
            {
              tool: "request_negotiation_confirmation",
              input: { negotiationId: n.id, stage: "sign" },
            },
          ]
        : [];
    },
  },
  {
    say: "테스트 메일 첨부 확인",
    gm: ({ state }) => {
      const thread = buildMailView(state).threads[0];
      return thread ? [{ tool: "read_mail", input: { threadId: thread.id } }] : [];
    },
  },
  {
    say: "훈련 잡아줘",
    ops: () => weekly(WEEKDAYS, "빌드업", ["passing", "vision"]),
  },
  {
    say: "평일 오전은 세트피스 반복 훈련 잡아줘",
    ops: () => weekly(WEEKDAYS, "세트피스", ["freeKicks", "crossing"]),
  },
  {
    say: "월요일 오전은 세트피스 반복 훈련 잡아줘",
    ops: () => weekly([1], "세트피스", ["freeKicks", "crossing"]),
  },
  {
    say: "훈련 쉬자",
    ops: ({ state }) => ({ set_training: [{ clear: { from: state.date, rest: true } }] }),
  },
  {
    say: "4-4-2로 바꾸고 공격적으로 가자",
    ops: () => ({ set_tactics: [{ mentality: 4 }] }),
  },
  {
    say: "4-4-2로 수비적으로 가자",
    ops: () => ({ set_tactics: [{ mentality: 2 }] }),
  },
  {
    say: `${NAME_SLOT} 주장 시키자`,
    ops: ({ named }) => ({ set_captain: [{ playerId: named }] }),
  },
  {
    say: `${NAME_SLOT}에게 등번호 9번 줘`,
    gm: ({ named }) => [{ tool: "set_squad_number", input: { playerId: named, number: 9 } }],
  },
  { say: "다들 모여봐", gm: () => [] },
  { say: `${NAME_SLOT} 면담 좀 하자`, gm: () => [] },
  { say: "회견장 가자", gm: () => [] },
  { say: "경기 시작하자", gm: () => [{ tool: "start_match", input: {} }] },
  { say: "다음 경기로 가자", skip: "next_match" },
  { say: "하루 넘기자", skip: 1 },
];

/** 표에 걸린 줄과, 이름 자리에 들어온 이름 */
interface ScriptHit {
  line: ScriptLine;
  named: string;
}

/**
 * 감독의 말 하나 → 표의 한 줄. **글자까지 같은 줄이 먼저다.**
 *
 * 이름 자리를 둔 줄은 앞뒤 고정 문구가 그대로 맞고 그 사이가 비어 있지 않을 때만
 * 걸린다 — 뜻을 짐작하는 자리가 아니라 자리 하나를 받는 틀이다.
 */
function findLine(said: string): ScriptHit | null {
  const message = said.trim();
  for (const line of SCRIPT) {
    if (!line.say.includes(NAME_SLOT) && line.say === message) return { line, named: "" };
  }
  for (const line of SCRIPT) {
    const slot = line.say.indexOf(NAME_SLOT);
    if (slot < 0) continue;
    const head = line.say.slice(0, slot);
    const tail = line.say.slice(slot + NAME_SLOT.length);
    if (!message.startsWith(head) || !message.endsWith(tail)) continue;
    const named = message.slice(head.length, message.length - tail.length).trim();
    if (named.length > 0) return { line, named };
  }
  return null;
}

/** 장면 하나가 흘려보내는 시간 — 대본이 하루 안에서 시계를 미는 유일한 눈금 */
const SCENE_STEP_MINUTES = 30;
/** 하루의 끝 — 날짜를 넘기는 것은 넘기겠다고 한 말뿐이다 */
const LAST_CLOCK = "23:00";

function clockOfMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 대본이 여는 자리 — 감독의 하루는 여기서 시작한다. 실모드의 GM은 장면마다 장소를
 * 고르지만 대본에는 고를 사실이 없으므로 한 자리를 지킨다 (prompts.md §1).
 */
const SCRIPT_PLACE = "감독실";

/** 실모드와 같은 모양의 장면 표식 — 이것이 코어의 시계를 민다 (agents.md §2) */
function sceneHeader(date: string, clock: string, place = SCRIPT_PLACE): string {
  return sceneMarker({ date, time: clock, place });
}

/** 오늘의 한 걸음 뒤 — 장면 하나가 흘려보내는 시각 */
function steppedClock(state: GameState): string {
  const stepped = Math.min(
    minutesOfClock(clockOf(state)) + SCENE_STEP_MINUTES,
    minutesOfClock(LAST_CLOCK),
  );
  return clockOfMinutes(stepped);
}

/** 이 줄이 가리키는 시점 — 넘기는 말이면 그 날짜, 아니면 오늘의 한 걸음 뒤 */
function pointOf(state: GameState, line: ScriptLine | null): string {
  if (line?.skip === "next_match") {
    const next = nextMatchFor(state.matches, state.userTeamId, state.date);
    return sceneHeader(next?.date ?? addDays(state.date, 7), "09:00");
  }
  if (typeof line?.skip === "number") {
    return sceneHeader(addDays(state.date, line.skip), "09:00");
  }
  return sceneHeader(state.date, steppedClock(state));
}

/**
 * **평시 턴의 대본.**
 *
 * 본문은 비운다 — 도구가 남긴 기록으로 코어가 장면을 세우므로(gm.ts) 대본이 대사를
 * 지어낼 자리가 없다. **기록도 장면도 없는 턴만** 한 줄을 세운다: 장면이 통째로 비면
 * 턴이 취소되고, 그때 감독은 자기 말이 사라진 화면을 본다.
 */
export function peaceScript(
  state: GameState,
  said: string,
  /** 이 턴에 코어가 이미 남긴 기록이 있는가 — 손잡이의 시간 이동 */
  options: { recorded: boolean },
): ScriptedTurn {
  const hit = findLine(said);
  const line = hit?.line ?? null;
  const header = pointOf(state, line);
  const calls = hit?.line.gm?.({ state, named: hit.named }) ?? [];
  const ops = hit?.line.ops?.({ state, named: hit.named }) ?? {};
  for (const [tool, names] of [
    ["tactic_orders", TACTIC_OPS],
    ["training_orders", TRAINING_OPS],
    ["finance_orders", FINANCE_OPS],
  ] as const) {
    if (names.some((name) => (ops[name]?.length ?? 0) > 0)) calls.unshift({ tool, input: {} });
  }
  const stands = options.recorded || calls.length > 0 || line?.skip !== undefined;
  // 제안 줄은 장면이 아니다 — 코어가 꺼내 가고 위생이 걷으므로 장면이 서는지는 앞 줄들이 정한다
  const suggested = suggestLine(peaceSuggestion(state, line));
  return stands
    ? { calls, text: `${header}\n${suggested}` }
    : { text: `${header}\n${narration(describeNextFixture(state))}\n${suggested}` };
}

/** 해석기의 대본 — 같은 말이 같은 표의 같은 줄에서 명령의 인자를 받는다 */
export function ordersScript(state: GameState, said: string): ScriptedTurn {
  const hit = findLine(said);
  const ops = hit?.line.ops?.({ state, named: hit.named }) ?? {};
  // 실모드의 해석기와 같은 산출 — 도구가 아니라 `{ ops }` JSON 하나다 (models.md §3-2)
  return { output: { ops } };
}

/** 벤치의 다음 말 — 표에 없는 말이라 장면만 선다. 경기를 굴리는 것은 손잡이다 */
const MATCH_SUGGESTION = "계속 가자";

// ── 경기 ───────────────────────────────────────────────
//
// 매치 GM은 감독의 말에만 답한다 — 사건을 중계하지 않는다(agents.md §3). 대본도 장부의
// 분과 스코어를 짚는 한 줄로 답하고, 표의 지시면 해석기를 부른다.

/** 스코어 한 줄 — 자는 `formatScore` 하나다 (tokens.css 「숫자와 표기」) */
function scoreLine(state: GameState, score: { home: number; away: number }): string {
  const match = state.pendingMatch;
  if (!match) return "";
  const record = state.matches.find((m) => m.id === match.matchId);
  if (!record) return "";
  return `${teamName(record.homeTeamId)} ${formatScore(score.home, score.away)} ${teamName(record.awayTeamId)}`;
}

/** **경기 턴의 대본** — 감독의 말에 대한 한 줄. 시계는 실행기가, 마감은 코어가 맡는다 */
export function matchScript(state: GameState, options: { message?: string }): ScriptedTurn {
  const pending = state.pendingMatch;
  const now = pending?.live.ledger.score ?? { home: 0, away: 0 };
  const minute = pending?.live.ledger.minute ?? 0;
  const hit = options.message ? findLine(options.message) : null;
  const commands = hit?.line.ops?.({ state, named: hit.named }) ?? {};
  return {
    text: [
      narration(`${minute}′ ${scoreLine(state, now)} — 감독의 말이 벤치에 닿는다.`),
      suggestLine(MATCH_SUGGESTION),
    ].join("\n"),
    ...(Object.keys(commands).length > 0 ? { calls: [{ tool: "tactic_orders", input: {} }] } : {}),
  };
}
