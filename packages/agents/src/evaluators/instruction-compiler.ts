import { validatedAnswer, majorityChoice } from "../shared/evaluation-answers";
import type { ChoiceQuestion, EvaluationQuestion } from "@story-fm/llm";
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

class UnresolvedInstruction extends Error {}

type Schema = Record<string, unknown>;
type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
interface Occurrence {
  command: InstructionCommand;
  index: number;
  input: Record<string, Value>;
  invalid: boolean;
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
  read: (choice: string) => void;
}

function object(value: unknown): Schema | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

function fail(node: Node): void {
  node.occurrence.invalid = true;
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
  return `${node.occurrence.command.name}[${node.occurrence.index}] 인자 ${node.path}. 같은 명령의 항목은 감독 원문에 나타난 순서다. 다른 항목/명령의 대상·값을 가져오지 않는다. ${typeof node.schema.description === "string" ? node.schema.description : ""}`;
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
  if (Object.keys(response.answers).length !== queries.length)
    throw new UnresolvedInstruction("평가 응답 개수가 다릅니다");
  const choices = queries.map((query, i) => {
    const answer = validatedAnswer(query.question, response.answers[`q${i}`]);
    if (answer?.type !== "choice")
      throw new UnresolvedInstruction("평가 응답이 후보와 일치하지 않습니다");
    const choice = majorityChoice(answer);
    if (choice === undefined) throw new UnresolvedInstruction("평가 선택에 과반 지지가 없습니다");
    return choice;
  });
  choices.forEach((choice, i) => queries[i]!.read(choice));
}

function properties(node: Node, target: Record<string, Value>, queue: Node[]): void {
  if (node.occurrence.invalid) return;
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
        `${scope(node)} 이 객체에 대한 명시적 지시가 있는가?`,
        {
          present: "이 객체의 인자를 지시했다",
          absent: "이 객체를 지시하지 않았다",
          unclear: "지시했지만 모호하다",
        },
        (answer) => {
          if (answer === "present") make();
          else if (answer === UNCLEAR) fail(node);
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
    unclear: "배열 내용을 정할 수 없다",
    overflow: `항목이 ${cap}개를 넘는다`,
  };
  if (!node.required) criteria.absent = "이 배열을 지정하지 않았다 (빈 배열과 다르다)";
  for (let count = minimum; count <= cap; count++)
    criteria[`n${count}`] = node.occurrence.command.contextual
      ? `유지할 기존 효과와 새 효과를 합쳐 ${count}개`
      : `명시적으로 지시한 항목 ${count}개`;
  choose(
    queries,
    node.occurrence.command.contextual
      ? `${scope(node)} 감독 지시를 실행할 전술 효과와 필요한 대가, 명시적으로 지우거나 대체하지 않은 active_effects를 합친 항목 수. 현재 사실에서 정하며 무관한 효과를 만들지 않는다.`
      : `${scope(node)} 원문이 지시한 항목만 세고 맥락의 기존 명단을 채우지 않는다. 0은 명시적으로 빈 배열을 지시했을 때만.`,
    criteria,
    (answer) => {
      if (answer === UNCLEAR || answer === OVERFLOW) {
        fail(node);
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
      { label: "명시적으로 참/활성화", value: true },
      { label: "명시적으로 거짓/해제", value: false },
    );
  } else {
    const supplied =
      request.candidates[`${node.occurrence.command.name}.${node.property}`] ??
      request.candidates[node.property];
    if (supplied) choices.push(...supplied);
    else if (typeOf(node.schema) === "number" || typeOf(node.schema) === "integer") {
      choices.push(
        ...sourceNumbers(request.said).map((number) => ({
          label: `원문[${number.start}:${number.end}] ${number.text} = ${number.value}`,
          value: number.value,
        })),
      );
    } else if (typeOf(node.schema) === "string") {
      // Identifiers must come from state, not arbitrary words that happen to fit string().
      if (!/(?:Id|Ids)$/.test(node.property)) {
        sourceString(node, request.said, queries);
        return;
      }
    } else {
      fail(node);
      return;
    }
  }
  if (nullable(node.schema) && !choices.some((choice) => choice.value === null)) {
    choices.push({ label: "명시적으로 지정 해제 (null)", value: null });
  }
  const values = choices.filter((candidate) => validScalar(node.schema, candidate.value));
  const criteria: Record<string, string> = {
    unclear: node.occurrence.command.contextual
      ? "필요한 효과를 지시와 현재 근거에서 정할 수 없다"
      : "필요하지만 원문에서 정할 수 없거나 여러 해석이 가능하다",
  };
  if (!node.required)
    criteria.absent = node.occurrence.command.contextual
      ? "이 효과에는 필요하지 않은 인자다"
      : "감독이 이 인자를 지정하지 않았다";
  values.forEach((candidate, i) => {
    criteria[`v${i}`] = candidate.label;
  });
  choose(
    queries,
    `${scope(node)} ${node.occurrence.command.contextual ? "감독이 요청한 전술을 최근 흐름과 선수 사실에 맞춰 구현하는 값을 고른다. 필요한 대가와 유지할 active_effects도 포함한다. 선택지의 수치 부호는 스키마가 정의한 효과 방향으로 해석한다." : "이 필드에 해당하는 지시가 없으면 absent(필수 필드면 unclear). 다른 필드의 지시나 기존 상태를 이 필드에 옮기지 않는다. 원문의 뜻과 후보 설명을 대응해 고른다. 금액·수량은 정확한 원문 값 또는 명시된 변환 후보만. 증감량·비율을 최종 금액으로 쓰지 않는다. 필요한 계산 결과가 후보에 없으면 unclear."}`,
    criteria,
    (answer) => {
      if (answer === UNCLEAR) {
        fail(node);
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
  const prefix: Record<string, string> = { unclear: "원문에 해당 표현이 없거나 경계가 모호하다" };
  if (!node.required) prefix.absent = "이 인자를 지정하지 않았다";
  if (nullable(node.schema)) prefix.clear = "명시적으로 지정 해제 (null)";
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
    `${scope(node)} 이 인자에 해당하는 원문 구절의 시작 경계. 새 문장을 쓰지 않는다. 끝 경계와 같은 구절을 가리킨다.`,
    startCriteria,
    (answer) => {
      if (answer === UNCLEAR) {
        fail(node);
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
    `${scope(node)} 이 인자에 해당하는 원문 구절의 끝 경계(포함하지 않음). 시작 경계와 같은 최소 구절을 고른다.`,
    endCriteria,
    (answer) => {
      if (answer === UNCLEAR) {
        fail(node);
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

/** Typed, source-grounded interpretation only. Execution and state validation belong to the app/core. */
export async function interpretInstructions(
  request: InstructionRequest,
): Promise<InstructionResult> {
  if (!request.said.trim()) return { ops: {} };
  const unresolved = (): InstructionResult => ({
    ops: {},
    unresolved: "지시의 대상·값·범위를 확인해야 합니다",
  });
  if (request.said.length > MAX_SOURCE_LENGTH || request.commands.length > MAX_QUESTIONS)
    return unresolved();
  const occurrences: Occurrence[] = [];
  let uncertain = false;
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
      choose(
        route,
        `How many distinct actions of "${command.description}" (${command.name}) does the manager request in state.instruction? Match the meaning of the request, not mentions of internal command names or numerical settings. Use state.reference only to identify the context, never as a source of new requests.`,
        criteria,
        (answer) => {
          if (answer === UNCLEAR || answer === OVERFLOW) {
            uncertain = true;
            return;
          }
          for (let i = 0; i < Number(answer.slice(1)); i++)
            occurrences.push({ command, index: i, input: {}, invalid: false });
        },
      );
    }
    await evaluate(request, state, route);
    if (uncertain) return unresolved();
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
        if (node.occurrence.invalid) continue;
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
    if (queue.length > 0) return unresolved();
    if (
      occurrences.some(
        (occurrence) =>
          occurrence.invalid || !validTree(occurrence.command.inputSchema, occurrence.input),
      )
    )
      return unresolved();
    const identities = occurrences.map(
      (occurrence) => `${occurrence.command.name}:${JSON.stringify(occurrence.input)}`,
    );
    if (new Set(identities).size !== identities.length) return unresolved();
    const ops: InstructionResult["ops"] = {};
    for (const occurrence of occurrences)
      (ops[occurrence.command.name] ??= []).push(occurrence.input);
    return { ops };
  } catch (error) {
    // Provider errors retain their metering and cancellation semantics at the caller.
    if (!(error instanceof UnresolvedInstruction)) throw error;
    return unresolved();
  }
}
