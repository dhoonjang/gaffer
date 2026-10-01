import {
  applyMatchReading,
  captureJournal,
  journal,
  roomNegotiationOf,
  syncLiveTactics,
  userSide,
  type GameState,
} from "@story-fm/engine";
import {
  TACTIC_AXES,
  POSITION_CODES,
  rolesFor,
  roleChoiceText,
  type Point,
  type SheetLine,
  type BoardMove,
} from "@story-fm/domain";
import {
  createGameEvaluator,
  resolveLlmMode,
  type InstructionAgentName,
  type GameEvaluator,
  type GameToolSpec,
  type JsonObjectSchema,
} from "@story-fm/llm";
import { recordCall, type GmToolCall } from "../../common/gm-types";
import { interpretInstructions } from "../../common/instruction-compiler";
import type { InstructionCandidate, InstructionCommand } from "../../common/instruction-contract";
import {
  applyOps,
  OPS_PER_COMMAND,
  parseOrdersReport,
  type OpsOrders,
} from "../../common/orders-ops";
import { TACTIC_OPS, TACTIC_CAPS, MATCH_OPS } from "../../match/tactic-orders";
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

import { liveInputOf } from "@story-fm/sim";
import { buildFactsBlock } from "./match/match-facts";
import { buildRecentFlowBlock } from "../../match/recent-flow";
import { interpretMatchInstructions } from "../../match/jev-match-reader";

export type InterpreterAgent = InstructionAgentName | "match-reader";
type Reading = { points: Point[]; sheet: SheetLine[] };

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
    "release_staff.name": state.personas
      .filter(
        (person) =>
          ["head_coach", "coach", "medic", "scout"].includes(person.role) &&
          person.employment !== undefined,
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
}

/** Every command in one utterance commits together, through existing Zod/core handlers. */
export function applyInstructionBatch(
  state: GameState,
  calls: GmToolCall[],
  orders: OpsOrders,
  names: readonly string[],
  options: { deferNegotiationIds?: ReadonlySet<string>; reading?: Reading; source?: string } = {},
): InstructionOutcome {
  if (orders.unresolved)
    return {
      notes: [`지시를 적용하지 않았습니다. 확인할 부분: ${orders.unresolved}`],
      rejected: true,
      applied: 0,
    };
  if (Object.keys(orders.ops).length === 0 && !options.reading)
    return { notes: [], rejected: false, applied: 0 };
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
  const transaction = captureJournal(() => {
    const applied = applyOps(specs, orders, names, notes);
    if (applied.rejected > 0) return applied;
    syncLiveTactics(draft);
    if (options.reading) {
      const stored = applyMatchReading(draft, options.reading);
      if (!stored || !draft.pendingMatch) return { ...applied, rejected: 1 };
      const folded = liveInputOf(draft.pendingMatch.live).sheet;
      if (stored.droppedPoints > 0 || folded.dropped.length > 0) {
        notes.push("전술 효과가 경기의 실재·대가·한도를 충족하지 못했습니다");
        return { ...applied, rejected: 1 };
      }
      const message = `경기 전술 효과 ${stored.sheet.length}개를 적용했습니다`;
      notes.push(message);
      recordCall(
        draftCalls,
        "tactic_orders",
        { ok: true, message },
        {
          silent: true,
          input: {
            source: options.source ?? options.reading.points.map((point) => point.text).join("\n"),
          },
        },
      );
      return { ...applied, applied: applied.applied + 1 };
    }
    return applied;
  });
  if (transaction.value.rejected > 0) {
    return {
      notes: ["지시 묶음을 적용하지 않았습니다. 함께 요청한 변경은 모두 그대로입니다.", ...notes],
      rejected: true,
      applied: 0,
    };
  }
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
    agent: InterpreterAgent;
    evaluator?: GameEvaluator;
    boardMoves?: readonly BoardMove[];
    deferNegotiationIds?: ReadonlySet<string>;
  },
): Promise<InstructionOutcome> {
  if (!said.trim()) return { notes: [], rejected: false, applied: 0 };
  const { agent } = options;
  const room = roomNegotiationOf(state);
  if (agent === "table-orders" && !room)
    return { notes: ["열린 협상 자리가 없습니다"], rejected: true, applied: 0 };
  if (agent === "match-reader" && !state.pendingMatch)
    return { notes: ["진행 중인 경기가 없습니다"], rejected: true, applied: 0 };
  const names =
    agent === "match-reader"
      ? MATCH_OPS
      : agent === "tactic-orders"
        ? TACTIC_OPS
        : agent === "training-orders"
          ? TRAINING_OPS
          : agent === "table-orders"
            ? TABLE_OPS
            : MARKET_OPS;
  const specs = new Map(buildToolSpecs(state, [], options).map((spec) => [spec.name, spec]));
  const live = state.pendingMatch?.live;
  const droppedEffects = new Set(
    live ? liveInputOf(live).sheet.dropped.map((drop) => drop.line) : [],
  );
  const activeEffects =
    live?.sheet.filter((line) => line.step > 0 && !droppedEffects.has(line)) ?? [];
  const context =
    agent === "match-reader"
      ? [
          buildLedgerNote(state, { withState: true }),
          ...buildFactsBlock(state),
          buildRecentFlowBlock(state),
          `<active_effects>${JSON.stringify(activeEffects)}</active_effects>`,
        ]
      : agent === "table-orders" && room
        ? buildTableOrdersContext(state, room)
        : agent === "training-orders"
          ? buildTrainingContext(state, buildTrainingSchedule(state))
          : agent === "market-orders"
            ? buildMarketContext(state)
            : buildPeaceContext(state);
  const rules =
    "전술판에서 이미 바꾼 값은 반복 적용하지 않는다. 서로 자리 교환은 양쪽을 지정하고 한 선수의 position과 move를 함께 지정하지 않는다. 상대 오퍼에 답하기와 우리 딜 확정은 구분한다. 감독이 명시하지 않은 위임·수락은 하지 않는다.";
  let orders: OpsOrders & { reading?: Reading };
  if (!options.evaluator && resolveLlmMode() === "mock") {
    orders = parseOrdersReport(ordersScript(state, said).output ?? {}, names, TACTIC_CAPS);
  } else {
    const request = {
      said,
      context: [rules, ...context, ...buildBoardMovesBlock(state, options.boardMoves ?? [])].join(
        "\n",
      ),
      commands: instructionCommands(specs, names),
      candidates: instructionCandidates(state, said),
      evaluator: options.evaluator ?? createGameEvaluator(agent),
    };
    if (agent === "match-reader" && state.pendingMatch) {
      const live = state.pendingMatch.live;
      // A combined substitution and instruction can target the incoming player. The
      // atomic application validates the completed lineup before applying any effect.
      const people = [
        ...new Set([
          ...live.ledger.home.onPitch,
          ...live.ledger.away.onPitch,
          ...live.ledger[userSide(state)].bench,
        ]),
      ].map((id) => ({
        label: `${state.players.find((p) => p.id === id)?.name ?? id} (${id})`,
        value: id,
      }));
      request.candidates["set_match_plan.player"] = people;
      request.candidates["set_match_plan.targetPlayer"] = people;
      orders = await interpretMatchInstructions({
        ...request,
        pointId: `order-${live.state.tick}`,
      });
    } else orders = await interpretInstructions(request);
  }
  journal({
    kind: "orders.intent",
    agent,
    raw: said,
    retried: false,
    ok: !orders.unresolved,
    ops: orders.ops,
    ...(orders.unresolved ? { unresolved: orders.unresolved } : {}),
  });
  return applyInstructionBatch(state, calls, orders, names, {
    ...options,
    source: said,
    ...(orders.reading ? { reading: orders.reading } : {}),
  });
}

/** One invocation per existing skill and turn; the model never rewrites the director's utterance. */
export function createInstructionTool(
  state: GameState,
  calls: GmToolCall[],
  options: {
    name: string;
    agent: InterpreterAgent;
    description: string;
    said?: string;
    boardMoves?: readonly BoardMove[];
    deferNegotiationIds?: ReadonlySet<string>;
    allowed?: () => { ok: boolean; message: string } | undefined;
  },
): GameToolSpec {
  let used = false;
  return {
    name: options.name,
    description: options.description,
    inputSchema: { type: "object", properties: {} },
    async handle() {
      if (!options.said?.trim())
        return { ok: false, message: "이번 턴에는 감독의 직접 지시가 없습니다" };
      if (used)
        return {
          ok: false,
          message: "이번 턴의 이 지시는 이미 해석했습니다 — 앞선 결과를 사용하세요",
        };
      const blocked = options.allowed?.();
      if (blocked) return blocked;
      used = true;
      const result = await runInstructions(state, calls, options.said, options);
      return {
        ok: !result.rejected && result.applied > 0,
        message:
          result.notes.join("\n") || "적용할 지시가 없습니다. 필요한 대상·값을 확인해 주세요",
      };
    },
  };
}
