import { validatedAnswer, majorityChoice } from "../shared/evaluation-answers";
import type { ChoiceQuestion, EvaluationQuestion } from "@gaffer/llm";
import type {
  InstructionCommand,
  InstructionRequest,
  InstructionResult,
} from "./instruction-contract";
import { sourceBoundaries, sourceNumbers } from "./instruction-values";

// Resource bounds, not game rules. Overflow is reported instead of dropping instructions.
const MAX_CHOICES = 255;
const MAX_QUESTIONS = 512;
const MAX_ROUNDS = 8;
const MAX_ARRAY_ITEMS = 32;
const MAX_SOURCE_LENGTH = 8_000;
const ABSENT = "absent";
const UNCLEAR = "unclear";
const OVERFLOW = "overflow";
/** A choice is adopted only above this probability (agents.md §1). */
const MAJORITY = 0.5;
// 반려 사유는 GM이 되물을 자리를 고르는 근거라 명령·인자 단위로 남긴다
const SPLIT = "해석이 갈려 정하지 못함";
const UNREADABLE = "원문으로 정할 수 없거나 여러 뜻으로 읽힘";
const MALFORMED = "값이 규칙에 맞지 않음";
/** Fields that name a target rather than a change — they must come from state candidates. */
const IDENTIFIER = /(?:Id|Ids)$/;

class UnresolvedInstruction extends Error {}

type Schema = Record<string, unknown>;
type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
interface Occurrence {
  command: InstructionCommand;
  index: number;
  input: Record<string, Value>;
  problems: string[];
}
interface Node {
  schema: Schema;
  property: string;
  path: string;
  required: boolean;
  occurrence: Occurrence;
  assign: (value: Value) => void;
}
interface Query {
  question: ChoiceQuestion;
  /** `split` — no candidate won a majority; the choice arrives as `unclear`. */
  read: (choice: string, split: boolean) => void;
  /** Reads the whole distribution instead of a majority choice (grouped candidates). */
  readDistribution?: (probabilities: Readonly<Record<string, number>>) => void;
}

function object(value: unknown): Schema | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

/**
 * A command that can carry changes but received only its target changes nothing — the core
 * rejects it, and a rejection rolls back the whole batch. It is held here instead.
 */
function changesNothing(occurrence: Occurrence): boolean {
  const props = Object.keys(object(occurrence.command.inputSchema.properties) ?? {});
  const changes = (key: string) => !IDENTIFIER.test(key);
  return props.some(changes) && !Object.keys(occurrence.input).some(changes);
}

function invalid(occurrence: Occurrence): boolean {
  return occurrence.problems.length > 0;
}

function label(occurrence: Occurrence): string {
  return `${occurrence.command.label ?? occurrence.command.description} ${occurrence.index + 1}번째`;
}

function fail(node: Node, reason: string = MALFORMED): void {
  const argument = node.path.replace(/^\$\.?/, "");
  node.occurrence.problems.push(
    `${label(node.occurrence)}${argument ? ` · ${argument}` : ""} — ${reason}`,
  );
}

function unreadable(split: boolean): string {
  return split ? SPLIT : UNREADABLE;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function allowedPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || finite(value) || typeof value === "boolean";
}

function nullable(schema: Schema): boolean {
  return Array.isArray(schema.type) && schema.type.includes("null");
}

function typeOf(schema: Schema): unknown {
  if (!Array.isArray(schema.type)) return schema.type;
  const nonNull = schema.type.filter((type) => type !== "null");
  return nonNull.length === 1 ? nonNull[0] : undefined;
}

function validScalar(schema: Schema, value: Value): boolean {
  if (value === null) return nullable(schema);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if ("const" in schema && schema.const !== value) return false;
  if (typeOf(schema) === "number" || typeOf(schema) === "integer") {
    return (
      finite(value) &&
      (typeOf(schema) !== "integer" || Number.isSafeInteger(value)) &&
      (!finite(schema.minimum) || value >= schema.minimum) &&
      (!finite(schema.maximum) || value <= schema.maximum)
    );
  }
  if (typeOf(schema) === "boolean") return typeof value === "boolean";
  if (typeOf(schema) === "string") {
    if (typeof value !== "string") return false;
    if (finite(schema.minLength) && value.length < schema.minLength) return false;
    if (finite(schema.maxLength) && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return false;
    return true;
  }
  return false;
}

function scope(node: Node): string {
  return `${node.occurrence.command.name}[${node.occurrence.index}] argument ${node.path}. Items of the same command follow the order they appear in the manager's original words. Do not take targets or values from other items or commands. ${typeof node.schema.description === "string" ? node.schema.description : ""}`;
}

function choose(
  queries: Query[],
  instructions: string,
  criteria: Record<string, string | null>,
  read: Query["read"],
): void {
  if (Object.keys(criteria).length > MAX_CHOICES)
    throw new UnresolvedInstruction("선택 후보가 한도를 넘었습니다");
  queries.push({ question: { type: "choice", instructions, criteria }, read });
  if (queries.length > MAX_QUESTIONS)
    throw new UnresolvedInstruction("지시 구조가 한도를 넘었습니다");
}

async function evaluate(
  request: InstructionRequest,
  state: string,
  queries: Query[],
): Promise<void> {
  if (queries.length === 0) return;
  const questions: Record<string, EvaluationQuestion> = {};
  queries.forEach((query, i) => {
    questions[`q${i}`] = query.question;
  });
  const response = await request.evaluator.evaluate({ state, questions });
  // A malformed or missing answer fails only its own question.
  const answers = queries.map((query, i) => {
    const answer = validatedAnswer(query.question, response.answers[`q${i}`]);
    return answer?.type === "choice" ? answer : undefined;
  });
  answers.forEach((answer, i) => {
    const query = queries[i]!;
    if (!answer) query.read(UNCLEAR, false);
    else if (query.readDistribution) query.readDistribution(answer.probabilities);
    else {
      const choice = majorityChoice(answer);
      query.read(choice ?? UNCLEAR, choice === undefined);
    }
  });
}

function properties(node: Node, target: Record<string, Value>, queue: Node[]): void {
  if (invalid(node.occurrence)) return;
  const originalProps = object(node.schema.properties);
  const schema =
    node.occurrence.command.refineObjectSchema?.(node.path, node.occurrence.input, {
      ...node.schema,
      type: "object",
    }) ?? node.schema;
  const props = object(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  const originalRequired = Array.isArray(node.schema.required) ? node.schema.required : [];
  if (
    !props ||
    !originalProps ||
    schema.type !== "object" ||
    Object.keys(props).some(
      (key) =>
        !Object.hasOwn(originalProps, key) ||
        JSON.stringify(props[key]) !== JSON.stringify(originalProps[key]),
    ) ||
    required.some((key) => typeof key !== "string" || !Object.hasOwn(props, key)) ||
    originalRequired.some((key) => !required.includes(key))
  ) {
    fail(node);
    return;
  }
  for (const [property, raw] of Object.entries(props)) {
    const schema = object(raw);
    if (!schema) {
      fail(node);
      continue;
    }
    queue.push({
      schema,
      property,
      path: `${node.path}.${property}`,
      required: required.includes(property),
      occurrence: node.occurrence,
      assign: (value) => {
        target[property] = value;
      },
    });
  }
}

function structural(
  node: Node,
  queries: Query[],
  next: Node[],
  afterAnswers: (() => void)[],
): boolean {
  if (typeOf(node.schema) === "object") {
    const make = () => {
      const value: Record<string, Value> = {};
      node.assign(value);
      // Sibling discriminants are resolved in this batch before child applicability is narrowed.
      afterAnswers.push(() => properties(node, value, next));
    };
    if (node.required) make();
    else
      choose(
        queries,
        `${scope(node)} Is there an explicit instruction for this object?`,
        {
          present: "instructed this object's arguments",
          absent: "did not instruct this object",
          unclear: "instructed but ambiguous",
        },
        (answer, split) => {
          if (answer === "present") make();
          else if (answer === UNCLEAR) fail(node, unreadable(split));
        },
      );
    return true;
  }
  if (typeOf(node.schema) !== "array") return false;
  const items = object(node.schema.items);
  if (!items) {
    fail(node);
    return true;
  }
  const cap = finite(node.schema.maxItems)
    ? Math.min(node.schema.maxItems, MAX_ARRAY_ITEMS)
    : MAX_ARRAY_ITEMS;
  const minimum = finite(node.schema.minItems) ? node.schema.minItems : 0;
  const criteria: Record<string, string> = {
    unclear: "cannot determine the array contents",
    overflow: `more than ${cap} items`,
  };
  if (!node.required)
    criteria.absent = "did not specify this array (not the same as an empty array)";
  for (let count = minimum; count <= cap; count++)
    criteria[`n${count}`] = node.occurrence.command.contextual
      ? `${count} existing effects to keep and new effects combined`
      : `${count} explicitly instructed items`;
  choose(
    queries,
    node.occurrence.command.contextual
      ? `${scope(node)} The number of items combining the tactical effects that carry out the manager's instruction, their necessary costs, and the active_effects not explicitly removed or replaced. Decide from the current facts and do not create unrelated effects.`
      : `${scope(node)} Count only the items the original words instruct; do not fill in the existing list from the context. 0 only when an empty array was explicitly instructed.`,
    criteria,
    (answer, split) => {
      if (answer === UNCLEAR || answer === OVERFLOW) {
        fail(node, answer === OVERFLOW ? `${cap}개를 넘음` : unreadable(split));
        return;
      }
      if (answer === ABSENT) return;
      const value: Value[] = [];
      node.assign(value);
      const count = Number(answer.slice(1));
      for (let i = 0; i < count; i++)
        next.push({
          schema: items,
          property: node.property,
          path: `${node.path}[${i}]`,
          required: true,
          occurrence: node.occurrence,
          assign: (item) => {
            value[i] = item;
          },
        });
    },
  );
  return true;
}

function scalar(node: Node, request: InstructionRequest, queries: Query[]): void {
  if (node.schema.anyOf !== undefined || node.schema.$ref !== undefined) {
    fail(node);
    return;
  }
  const choices: { label: string; value: Value }[] = [];
  if (Array.isArray(node.schema.enum)) {
    for (const value of node.schema.enum)
      if (allowedPrimitive(value)) choices.push({ label: String(value), value });
  } else if (allowedPrimitive(node.schema.const) && "const" in node.schema) {
    choices.push({ label: String(node.schema.const), value: node.schema.const });
  } else if (typeOf(node.schema) === "boolean") {
    choices.push(
      { label: "explicitly true/enabled", value: true },
      { label: "explicitly false/disabled", value: false },
    );
  } else {
    const supplied =
      request.candidates[`${node.occurrence.command.name}.${node.property}`] ??
      request.candidates[node.property];
    if (supplied) choices.push(...supplied);
    else if (typeOf(node.schema) === "number" || typeOf(node.schema) === "integer") {
      choices.push(
        ...sourceNumbers(request.said).map((number) => ({
          label: `source[${number.start}:${number.end}] ${number.text} = ${number.value}`,
          value: number.value,
        })),
      );
    } else if (typeOf(node.schema) === "string") {
      // Identifiers must come from state, not arbitrary words that happen to fit string().
      if (!IDENTIFIER.test(node.property)) {
        sourceString(node, request.said, queries);
        return;
      }
    } else {
      fail(node);
      return;
    }
  }
  if (nullable(node.schema) && !choices.some((choice) => choice.value === null)) {
    choices.push({ label: "explicitly cleared (null)", value: null });
  }
  const values = choices.filter((candidate) => validScalar(node.schema, candidate.value));
  const criteria: Record<string, string> = {
    unclear: node.occurrence.command.contextual
      ? "the needed effect cannot be determined from the instruction and current grounds"
      : "needed but cannot be determined from the original words, or has several readings",
  };
  if (!node.required)
    criteria.absent = node.occurrence.command.contextual
      ? "an argument this effect does not need"
      : "the manager did not specify this argument";
  values.forEach((candidate, i) => {
    criteria[`v${i}`] = candidate.label;
  });
  choose(
    queries,
    `${scope(node)} ${node.occurrence.command.contextual ? "Pick the value that implements the tactic the manager asked for, fitted to the recent flow and the player facts. Include the necessary costs and the active_effects to keep. Read the sign of a choice's number as the effect direction the schema defines." : "If there is no instruction for this field, absent (unclear if the field is required). Do not carry another field's instruction or the existing state into this field. Pick by matching the meaning of the original words to the candidate descriptions. Amounts and quantities only as the exact original value or a stated conversion candidate. Do not use a change or ratio as the final amount. If the needed calculation result is not among the candidates, unclear."}`,
    criteria,
    (answer, split) => {
      if (answer === UNCLEAR) {
        fail(node, unreadable(split));
        return;
      }
      if (answer !== ABSENT) node.assign(values[Number(answer.slice(1))]!.value);
    },
  );
}

function sourceString(node: Node, said: string, queries: Query[]): void {
  const { starts, ends } = sourceBoundaries(said);
  let start: number | undefined;
  let end: number | undefined;
  let omitted = false;
  let cleared = false;
  const finish = () => {
    if (omitted || start === undefined || end === undefined) return;
    const value = said.slice(start, end);
    if (end <= start || !validScalar(node.schema, value)) fail(node);
    else node.assign(value);
  };
  const prefix: Record<string, string> = {
    unclear: "the original words have no matching phrase, or its boundary is ambiguous",
  };
  if (!node.required) prefix.absent = "did not specify this argument";
  if (nullable(node.schema)) prefix.clear = "explicitly cleared (null)";
  const startCriteria = { ...prefix };
  const endCriteria = { ...prefix };
  starts.forEach((offset, i) => {
    startCriteria[`s${i}`] = `${offset}: ${said.slice(offset, Math.min(said.length, offset + 70))}`;
  });
  ends.forEach((offset, i) => {
    endCriteria[`e${i}`] = `${offset}: ${said.slice(Math.max(0, offset - 70), offset)}`;
  });
  choose(
    queries,
    `${scope(node)} Start boundary of the original phrase for this argument. Do not write new text. Points at the same phrase as the end boundary.`,
    startCriteria,
    (answer, split) => {
      if (answer === UNCLEAR) {
        fail(node, unreadable(split));
        return;
      }
      if (answer === ABSENT) {
        omitted = true;
        return;
      }
      if (answer === "clear") {
        cleared = true;
        return;
      }
      start = starts[Number(answer.slice(1))];
      finish();
    },
  );
  choose(
    queries,
    `${scope(node)} End boundary (exclusive) of the original phrase for this argument. Pick the same minimal phrase as the start boundary.`,
    endCriteria,
    (answer, split) => {
      if (answer === UNCLEAR) {
        fail(node, unreadable(split));
        return;
      }
      if (answer === ABSENT) {
        if (!omitted) fail(node);
        return;
      }
      if (answer === "clear") {
        if (cleared) node.assign(null);
        else fail(node);
        return;
      }
      if (omitted || cleared) {
        fail(node);
        return;
      }
      end = ends[Number(answer.slice(1))];
      finish();
    },
  );
}

/** Reject holes/duplicates and absent required fields before the core's authoritative Zod check. */
function validTree(schema: Schema, value: Value): boolean {
  if (typeOf(schema) === "object") {
    const props = object(schema.properties);
    const data = object(value);
    if (!props || !data) return false;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => typeof key !== "string" || !Object.hasOwn(data, key))) return false;
    return Object.entries(data).every(([key, child]) => {
      const childSchema = object(props[key]);
      return childSchema !== undefined && validTree(childSchema, child as Value);
    });
  }
  if (typeOf(schema) === "array") {
    const items = object(schema.items);
    if (!Array.isArray(value) || !items) return false;
    if (finite(schema.minItems) && value.length < schema.minItems) return false;
    if (finite(schema.maxItems) && value.length > schema.maxItems) return false;
    if (new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    for (let i = 0; i < value.length; i++)
      if (!(i in value) || !validTree(items, value[i]!)) return false;
    return true;
  }
  return validScalar(schema, value);
}

/**
 * Typed, source-grounded interpretation only. Execution and state validation belong to the app/core.
 * Occurrences that resolve are returned even when others do not; `unresolved` names the rest.
 */
export async function interpretInstructions(
  request: InstructionRequest,
): Promise<InstructionResult> {
  if (!request.said.trim()) return { ops: {} };
  const unresolved = (
    problems: readonly string[] = [],
    ops: InstructionResult["ops"] = {},
  ): InstructionResult => ({
    ops,
    unresolved:
      problems.length > 0
        ? [...new Set(problems)].join(" / ")
        : "지시의 대상·값·범위를 확인해야 합니다",
  });
  if (request.said.length > MAX_SOURCE_LENGTH || request.commands.length > MAX_QUESTIONS)
    return unresolved();
  const occurrences: Occurrence[] = [];
  const routeProblems: string[] = [];
  const state = JSON.stringify({
    instruction: request.said,
    reference: request.context,
    commands: request.commands.map((command) =>
      command.contextual ? { name: command.name, description: command.description } : command,
    ),
  });
  try {
    const route: Query[] = [];
    for (const command of request.commands) {
      if (
        !Number.isSafeInteger(command.limit) ||
        command.limit < 1 ||
        command.limit > MAX_ARRAY_ITEMS
      )
        return unresolved();
      const criteria: Record<string, string> = {
        n0: "No requested action of this kind; discussion, quotation, hypothetical or explicitly withheld execution.",
        unclear: "Cannot determine whether an action is requested.",
        overflow: `More than ${command.limit} distinct requested actions of this kind.`,
      };
      for (let n = 1; n <= command.limit; n++)
        criteria[`n${n}`] = `${n} requested action${n === 1 ? "" : "s"} of this kind.`;
      const settle = (answer: string, split: boolean) => {
        if (answer === UNCLEAR || answer === OVERFLOW) {
          routeProblems.push(
            `${command.label ?? command.description} — ${answer === OVERFLOW ? `한 번에 ${command.limit}개를 넘게 요청함` : split ? "요청인지 해석이 갈림" : "요청인지 정할 수 없음"}`,
          );
          return;
        }
        for (let i = 0; i < Number(answer.slice(1)); i++)
          occurrences.push({ command, index: i, input: {}, problems: [] });
      };
      choose(
        route,
        `How many distinct actions of "${command.description}" (${command.name}) does the manager request in state.instruction? Match the meaning of the request, not mentions of internal command names or numerical settings. Use state.reference only to identify the context, never as a source of new requests.`,
        criteria,
        settle,
      );
      // Whether an action is requested is decided on the summed counts, so mass spread over
      // n1..nk still counts as a request; the count is the likeliest among them.
      const counts = Object.keys(criteria).filter((key) => /^n[1-9]\d*$/.test(key));
      route.at(-1)!.readDistribution = (p) => {
        const mass = counts.reduce((sum, key) => sum + (p[key] ?? 0), 0);
        if ((p.n0 ?? 0) > MAJORITY) settle("n0", false);
        else if ((p[OVERFLOW] ?? 0) > MAJORITY) settle(OVERFLOW, false);
        else if (mass > MAJORITY)
          settle(
            counts.reduce((best, key) => ((p[key] ?? 0) > (p[best] ?? 0) ? key : best)),
            false,
          );
        else settle(UNCLEAR, (p[UNCLEAR] ?? 0) <= MAJORITY);
      };
    }
    await evaluate(request, state, route);
    if (occurrences.length === 0 && routeProblems.length > 0) return unresolved(routeProblems);
    const selected = new Map(occurrences.map(({ command }) => [command.name, command]));
    const argumentsState = {
      instruction: request.said,
      reference: request.context,
      commands: [...selected.values()],
    };
    let queue: Node[] = [];
    for (const occurrence of occurrences)
      properties(
        {
          schema: occurrence.command.inputSchema,
          property: "",
          path: "$",
          required: true,
          occurrence,
          assign: () => {},
        },
        occurrence.input,
        queue,
      );
    for (let round = 0; queue.length > 0 && round < MAX_ROUNDS; round++) {
      const queries: Query[] = [];
      const next: Node[] = [];
      const afterAnswers: (() => void)[] = [];
      for (const node of queue) {
        if (invalid(node.occurrence)) continue;
        const disposition =
          node.occurrence.command.fieldDisposition?.(node.path, node.occurrence.input) ?? "include";
        if (disposition === "defer") {
          next.push(node);
          continue;
        }
        if (disposition === "omit") {
          if (node.required) fail(node);
          continue;
        }
        if (!structural(node, queries, next, afterAnswers)) scalar(node, request, queries);
      }
      // Asked alongside the first argument round so it costs no extra call.
      if (round === 0 && queries.length > 0)
        choose(
          queries,
          "Besides what the commands in state.commands carry out, does state.instruction request another action? Ignore discussion, explanation, quotation and hypotheticals.",
          {
            no: "every requested action is carried out by these commands",
            yes: "a requested action is left that none of these commands carries out",
            unclear: "cannot tell",
          },
          (answer) => {
            if (answer === "yes") routeProblems.push("옮길 명령을 찾지 못한 요청이 남음");
          },
        );
      await evaluate(
        request,
        JSON.stringify({
          ...argumentsState,
          selected_arguments: occurrences.map(({ command, index, input }) => ({
            command: command.name,
            index,
            input,
          })),
        }),
        queries,
      );
      afterAnswers.forEach((resolve) => resolve());
      queue = next;
    }
    for (const node of queue)
      if (!invalid(node.occurrence))
        node.occurrence.problems.push(`${label(node.occurrence)} — 지시 구조가 너무 깊음`);
    const seen = new Set<string>();
    const ops: InstructionResult["ops"] = {};
    for (const occurrence of occurrences) {
      if (invalid(occurrence)) continue;
      if (!validTree(occurrence.command.inputSchema, occurrence.input)) {
        occurrence.problems.push(`${label(occurrence)} — 필요한 값이 빠졌거나 겹침`);
        continue;
      }
      if (changesNothing(occurrence)) {
        occurrence.problems.push(`${label(occurrence)} — 바꿀 값을 정하지 못함`);
        continue;
      }
      const identity = `${occurrence.command.name}:${JSON.stringify(occurrence.input)}`;
      if (seen.has(identity)) {
        occurrence.problems.push(`${label(occurrence)} — 같은 지시를 두 번 읽음`);
        continue;
      }
      seen.add(identity);
      (ops[occurrence.command.name] ??= []).push(occurrence.input);
    }
    const problems = [
      ...routeProblems,
      ...occurrences.flatMap((occurrence) => occurrence.problems),
    ];
    return problems.length > 0 ? unresolved(problems, ops) : { ops };
  } catch (error) {
    // Provider errors retain their metering and cancellation semantics at the caller.
    if (!(error instanceof UnresolvedInstruction)) throw error;
    return unresolved([error.message]);
  }
}
