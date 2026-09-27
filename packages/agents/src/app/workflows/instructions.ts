import {
  captureJournal,
  journal,
  roomNegotiationOf,
  syncLiveTactics,
  type GameState,
} from "@story-fm/engine";
import {
  TACTIC_AXES,
  POSITION_CODES,
  rolesFor,
  roleChoiceText,
  type BoardMove,
} from "@story-fm/domain";
import {
  createGameEvaluator,
  resolveLlmMode,
  type GameEvaluator,
  type GameToolSpec,
  type JsonObjectSchema,
} from "@story-fm/llm";
import type { GmToolCall } from "../../common/gm-types";
import { interpretInstructions } from "../../common/instruction-compiler";
import type { InstructionCandidate, InstructionCommand } from "../../common/instruction-contract";
import {
  applyOps,
  OPS_PER_COMMAND,
  parseOrdersReport,
  type OpsOrders,
} from "../../common/orders-ops";
import { TACTIC_OPS, TACTIC_CAPS } from "../../match/tactic-orders";
import { MATCH_OPS } from "../../match/match-reader";
import { TRAINING_OPS } from "../../story/training-orders";
import { MARKET_OPS } from "../../negotiation/market-orders";
import {
  TABLE_OPS,
  BY_NEGOTIATION,
  BY_PLAYER,
  buildTableOrdersContext,
} from "../../negotiation/table-orders";
import { buildToolSpecs } from "../gm-tools";
import { buildTrainingSchedule } from "../gm-input";
import { ordersScript } from "../mock-script";
import { buildPeaceContext } from "./match/tactic-orders";
import { buildTrainingContext } from "./story/training-orders";
import { buildMarketContext } from "./negotiation/market-orders";
import { buildBoardMovesBlock, buildLedgerNote } from "../../match/context";

/** Empty lists explicitly mean clear; absence must never select a destructive core default. */
const CLEAR_LISTS: Readonly<Record<string, string>> = {
  sign_youth: "playerIds",
  set_development_focus: "playerIds",
  set_mentor: "menteeIds",
};

export function instructionCommands(
  specs: ReadonlyMap<string, GameToolSpec>,
  names: readonly string[],
): InstructionCommand[] {
  return names.flatMap((name) => {
    const spec = specs.get(name);
    if (!spec) return [];
    let inputSchema: JsonObjectSchema = spec.instructionSchema ?? spec.inputSchema;
    const field = CLEAR_LISTS[name];
    const property = field ? inputSchema.properties?.[field] : undefined;
    if (field && property && typeof property === "object") {
      inputSchema = {
        ...inputSchema,
        properties: {
          ...inputSchema.properties,
          [field]: {
            ...property,
            minItems: 0,
            description:
              "지정 전체 목록. 명시적으로 모두 해제/방출할 때만 빈 배열. 불명확하거나 생략된 지시는 실행하지 않는다.",
          },
        },
        required: [...new Set([...(inputSchema.required ?? []), field])],
      };
    }
    if (name === "set_development_focus" || name === "set_mentor") {
      inputSchema = {
        ...inputSchema,
        properties: {
          ...inputSchema.properties,
          listMode: {
            type: "string",
            enum: ["replace", "add", "remove", "clear"],
            description:
              "목록 전체 지정/교체=replace, 기존 명단에 추가=add, 그 사람만 제외=remove, 전부 해제=clear. 말하지 않은 기존 지정은 add/remove에서 유지된다.",
          },
        },
        required: [...(inputSchema.required ?? []), "listMode"],
      };
    }
    if (name === "delegate_negotiation" || name === "revoke_mandate") {
      inputSchema = {
        ...inputSchema,
        properties: {
          ...inputSchema.properties,
          scope: {
            type: "string",
            enum: ["player", "kind", "all"],
            description:
              "명시한 한 선수=player, 명시한 협상 갈래=kind, 감독이 명시적으로 모든 협상을 맡기거나 거둔다고 했을 때만=all. 범위 불명확은 실행하지 않는다.",
          },
        },
        required: [...(inputSchema.required ?? []), "scope"],
      };
    }
    return [
      {
        name,
        description: spec.description,
        inputSchema,
        limit: TACTIC_CAPS[name] ?? OPS_PER_COMMAND,
      },
    ];
  });
}

export function instructionCandidates(
  state: GameState,
  said: string,
): Record<string, InstructionCandidate[]> {
  const room = roomNegotiationOf(state);
  const ids = new Set(state.negotiations.map((n) => n.gamePlayerId));
  const players = state.players.filter((p) =>
    room
      ? p.id === room.gamePlayerId
      : p.teamId === state.userTeamId ||
        ids.has(p.id) ||
        said.includes(p.name) ||
        said.includes(p.id) ||
        p.name.split(/\s+/).some((part) => part.length >= 2 && said.includes(part)),
  );
  const people = players.map((p) => ({
    label: `${p.name} (${p.id}, ${p.positions.map((x) => x.position).join("/")})`,
    value: p.id,
  }));
  const youth = state.youthCandidates
    .filter((c) => c.teamId === state.userTeamId)
    .map((c) => ({ label: c.player.name, value: c.player.id }));
  const dates = Array.from({ length: 91 }, (_, offset) => {
    const day = new Date(`${state.date}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offset);
    const value = day.toISOString().slice(0, 10);
    return {
      label: `${value}, 오늘부터 ${offset}일, ${["일", "월", "화", "수", "목", "금", "토"][day.getUTCDay()]}요일`,
      value,
    };
  });
  for (const match of said.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
    const value = match[0];
    const parsed = new Date(`${value}T00:00:00Z`);
    if (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value &&
      !dates.some((date) => date.value === value)
    )
      dates.push({ label: value, value });
  }
  const teams = state.teams.map((team) => ({
    label: `${team.name} (${team.shortName}, ${team.id})`,
    value: team.id,
  }));
  const teamChoices =
    teams.length <= 253
      ? teams
      : teams.filter((team) => {
          const entry = state.teams.find((candidate) => candidate.id === team.value)!;
          return [entry.id, entry.name, entry.shortName].some((name) => said.includes(name));
        });
  const candidates: Record<string, InstructionCandidate[]> = {
    ...Object.fromEntries(
      [
        "playerId",
        "playerIds",
        "players",
        "mentorId",
        "menteeIds",
        "in",
        "out",
        "vice",
        "corner",
        "freeKick",
        "penalty",
      ].map((key) => [key, people]),
    ),
    "sign_youth.playerIds": youth,
    negotiationId: state.negotiations
      .filter((n) => !room || n.id === room.id)
      .map((n) => ({
        label: `${n.id} (${state.players.find((p) => p.id === n.gamePlayerId)?.name ?? n.gamePlayerId}, ${n.kind}, ${n.status})`,
        value: n.id,
      })),
    date: dates,
    from: dates,
    to: dates,
    until: dates,
    teamId: teamChoices,
    "hire_staff.name": (state.staffPool ?? []).map((person) => ({
      label: `${person.name} (${person.title})`,
      value: person.name,
    })),
    "release_staff.name": state.personas
      .filter(
        (person) =>
          ["coach", "medic", "scout"].includes(person.role) && person.employment !== undefined,
      )
      .map((person) => ({ label: person.name, value: person.name })),
    offer: (state.managerOffers ?? [])
      .filter((offer) => offer.status === "open")
      .map((offer) => ({
        label: `${state.teams.find((team) => team.id === offer.teamId)?.name ?? offer.teamId} (${offer.id})`,
        value: offer.id,
      })),
    "apply_manager_job.team": teamChoices,
    "set_training.dow": ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"].map(
      (label, value) => ({ label, value }),
    ),
    position: POSITION_CODES.map((value) => ({ label: value, value })),
    "set_player_tactic.role": [
      ...new Map(
        POSITION_CODES.flatMap((position) =>
          rolesFor(position).map(
            (role) => [role.id, { label: roleChoiceText(role), value: role.id }] as const,
          ),
        ),
      ).values(),
    ],
    ...Object.fromEntries(
      TACTIC_AXES.map((axis) => [
        `set_tactics.${axis.key}`,
        axis.words.map((label, index) => ({
          label: `${axis.label} ${index + 1}: ${label}`,
          value: index + 1,
        })),
      ]),
    ),
  };
  return candidates;
}

export interface InstructionOutcome {
  notes: string[];
  rejected: boolean;
  applied: number;
  analysisRequested?: boolean;
}

/** Every command in one utterance commits together, through existing Zod/core handlers. */
export function applyInstructionBatch(
  state: GameState,
  calls: GmToolCall[],
  orders: OpsOrders,
  names: readonly string[],
  options: { deferNegotiationIds?: ReadonlySet<string> } = {},
): InstructionOutcome {
  if (orders.unresolved)
    return {
      notes: [`지시를 적용하지 않았습니다. 확인할 부분: ${orders.unresolved}`],
      rejected: true,
      applied: 0,
    };
  if (Object.keys(orders.ops).length === 0) return { notes: [], rejected: false, applied: 0 };
  const draft = structuredClone(state);
  const draftCalls: GmToolCall[] = [];
  const room = roomNegotiationOf(draft);
  const specs = new Map(
    buildToolSpecs(draft, draftCalls, options).map((spec) => [
      spec.name,
      {
        ...spec,
        handle(row: unknown) {
          if (typeof row !== "object" || row === null || Array.isArray(row))
            return spec.handle(row);
          const input: Record<string, unknown> = { ...row };
          if (spec.name === "delegate_negotiation" || spec.name === "revoke_mandate") {
            const valid =
              input.scope === "player"
                ? typeof input.playerId === "string"
                : input.scope === "kind"
                  ? typeof input.kind === "string" && input.playerId === undefined
                  : input.scope === "all" &&
                    input.playerId === undefined &&
                    input.kind === undefined;
            if (!valid)
              return { ok: false, message: "위임 또는 철회의 범위와 대상을 명시해 주세요" };
            delete input.scope;
          }
          const field = CLEAR_LISTS[spec.name];
          if (field && !Array.isArray(input[field])) {
            return { ok: false, message: "대상 목록 또는 명시적인 전체 해제가 필요합니다" };
          }
          if (field && (spec.name === "set_development_focus" || spec.name === "set_mentor")) {
            const selected = input[field];
            const mode = input.listMode;
            if (
              !Array.isArray(selected) ||
              typeof mode !== "string" ||
              !["replace", "add", "remove", "clear"].includes(mode) ||
              (mode === "clear" && selected.length !== 0) ||
              ((mode === "add" || mode === "remove") && selected.length === 0)
            ) {
              return { ok: false, message: "목록을 바꾸는 방식과 대상을 확인해 주세요" };
            }
            const current =
              spec.name === "set_development_focus"
                ? draft.developmentFocus
                : draft.mentoring
                    .filter((pair) => pair.mentorId === input.mentorId && pair.until === undefined)
                    .map((pair) => pair.menteeId);
            if (mode === "clear") input[field] = [];
            else if (mode === "add") input[field] = [...new Set([...current, ...selected])];
            else if (mode === "remove")
              input[field] = current.filter((id) => !selected.includes(id));
            delete input.listMode;
          }
          if (field && Array.isArray(input[field]) && input[field].length === 0)
            delete input[field];
          if (room) {
            if (BY_NEGOTIATION.has(spec.name)) input.negotiationId = room.id;
            if (BY_PLAYER.has(spec.name)) input.playerId = room.gamePlayerId;
            if (spec.name === "send_offer") input.kind = room.kind === "loan" ? "loan" : "buy";
          }
          return spec.handle(input);
        },
      },
    ]),
  );
  const notes: string[] = [];
  const transaction = captureJournal(() => applyOps(specs, orders, names, notes));
  if (transaction.value.rejected > 0) {
    return {
      notes: ["지시 묶음을 적용하지 않았습니다. 함께 요청한 변경은 모두 그대로입니다.", ...notes],
      rejected: true,
      applied: 0,
    };
  }
  syncLiveTactics(draft);
  for (const key of Object.keys(state)) {
    if (!Object.hasOwn(draft, key)) delete (state as unknown as Record<string, unknown>)[key];
  }
  Object.assign(state, draft);
  calls.push(...draftCalls);
  for (const entry of transaction.entries) journal(entry);
  return { notes, rejected: false, applied: transaction.value.applied };
}

export async function runInstructions(
  state: GameState,
  calls: GmToolCall[],
  said: string,
  options: {
    evaluator?: GameEvaluator;
    boardMoves?: readonly BoardMove[];
    deferNegotiationIds?: ReadonlySet<string>;
  } = {},
): Promise<InstructionOutcome> {
  if (!said.trim()) return { notes: [], rejected: false, applied: 0 };
  const room = roomNegotiationOf(state);
  const names =
    state.phase === "match"
      ? MATCH_OPS.filter((n) => n !== "team_talk")
      : room
        ? TABLE_OPS
        : [...TACTIC_OPS, ...TRAINING_OPS, ...MARKET_OPS];
  const specs = new Map(buildToolSpecs(state, [], options).map((spec) => [spec.name, spec]));
  const context =
    state.phase === "match"
      ? [buildLedgerNote(state, { withState: true })]
      : room
        ? buildTableOrdersContext(state, room)
        : [
            ...buildPeaceContext(state),
            ...buildTrainingContext(state, buildTrainingSchedule(state)),
            ...buildMarketContext(state),
          ];
  let orders: OpsOrders;
  if (!options.evaluator && resolveLlmMode() === "mock") {
    orders = parseOrdersReport(ordersScript(state, said).output ?? {}, names, TACTIC_CAPS);
  } else {
    orders = await interpretInstructions({
      said,
      context: [...context, ...buildBoardMovesBlock(state, options.boardMoves ?? [])].join("\n"),
      commands: [
        ...instructionCommands(specs, names),
        ...(state.phase === "match"
          ? [
              {
                name: "analyse_match",
                description:
                  "상대 약점 공략, 맨마킹, 공간을 덮기 등 전술판의 자리·역할·6축 밖의 구체적 경기 지시를 판독한다. 단순한 대화·질문·관전은 제외.",
                inputSchema: { type: "object" as const, properties: {} },
                limit: 1,
              },
            ]
          : []),
      ],
      candidates: instructionCandidates(state, said),
      evaluator: options.evaluator ?? createGameEvaluator("instructions"),
    });
  }
  journal({
    kind: "orders.intent",
    agent: "instructions",
    raw: said,
    retried: false,
    ok: !orders.unresolved,
    ...orders,
  });
  const analysisRequested = (orders.ops.analyse_match?.length ?? 0) > 0;
  const ops = { ...orders.ops };
  delete ops.analyse_match;
  const applied = applyInstructionBatch(state, calls, { ...orders, ops }, names, options);
  return {
    ...applied,
    analysisRequested: !applied.rejected && (analysisRequested || applied.applied > 0),
  };
}
