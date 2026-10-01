import { type GameState, playersOf } from "../../common/core/state";
import {
  type PersonaRelation,
  stanceOfTier,
  type RelationTier,
  relationTierDistance,
  relationTierStep,
  relationTierIntensity,
} from "@story-fm/domain";

/** 장부의 줄이 없으면 중립(cordial)이다. */
export function relationTierOf(state: GameState, a: string, b: string): RelationTier {
  if (a === b) return "cordial";
  const key = pairOf(a, b);
  const row = state.relations.find((r) => r.a === key.a && r.b === key.b);
  return row?.tier ?? "cordial";
}

/**
 * 이름 → 관계 장부의 열쇠. **이 문을 지나지 못하는 이름은 알려진 화자가 아니다.**
 *
 * 감독은 자기 이름으로 불리고 고정 열쇠 `@manager`에 앉는다. 저장 페르소나는
 * `characterId`가 곧 열쇠이고, 우리 선수는 이름으로 불려 id에 앉는다.
 */
function subjectOfCharacter(state: GameState, characterId: string): string | null {
  if (characterId === state.manager.name || characterId === MANAGER_SUBJECT) {
    return MANAGER_SUBJECT;
  }
  if (state.personas.some((p) => p.characterId === characterId)) return characterId;
  return playersOf(state, state.userTeamId).find((p) => p.name === characterId)?.id ?? null;
}

/**
 * 한 쌍의 등급을 앉힌다 — **장부에 줄이 생기는 유일한 자리다** (people.md §6).
 *
 * 검사는 둘이다. 모르는 이름은 **반려**하고(등록·기억과 같은 계약), 지금 등급에서 두 칸을
 * 넘는 제안은 **한 칸으로 자른다** — 방향은 모델의 것이고 폭은 코어의 것이다
 * (AGENTS.md §6.4). 자른 뒤 제자리면 줄을 만들지 않는다: 안 움직인 쌍으로 세이브를
 * 채우지 않는다.
 *
 * @returns 장부가 움직였으면 `true`
 */
export function setRelationTier(
  state: GameState,
  a: string,
  b: string,
  tier: RelationTier,
): boolean {
  const subjectA = subjectOfCharacter(state, a);
  const subjectB = subjectOfCharacter(state, b);
  if (subjectA === null || subjectB === null || subjectA === subjectB) return false;

  const key = pairOf(subjectA, subjectB);
  const now = relationTierOf(state, key.a, key.b);
  const next = relationTierDistance(now, tier) > 1 ? relationTierStep(now, tier) : tier;
  if (next === now) return false;

  const rows = state.relations;
  const row = rows.find((r) => r.a === key.a && r.b === key.b);
  if (row) row.tier = next;
  else rows.push({ ...key, tier: next });
  return true;
}

/**
 * 압축이 낸 등급을 한 벌 앉힌다 — 인물 기억·등록과 같은 계약이다 (agents.md §5-1).
 *
 * **한 쌍은 한 번만 받는다.** 같은 쌍이 두 줄로 오면 한 번의 압축이 두 칸을 옮기고,
 * 그러면 「한 번에 한 칸」이 줄 수를 늘리는 것만으로 뚫린다.
 *
 * @returns 실제로 움직인 쌍의 수
 */
export function applyRelationTiers(
  state: GameState,
  rows: readonly RelationTierProposal[],
): number {
  const seen = new Set<string>();
  let moved = 0;
  for (const row of rows) {
    const a = subjectOfCharacter(state, row.a);
    const b = subjectOfCharacter(state, row.b);
    if (a === null || b === null || a === b) continue;
    const key = pairKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    if (setRelationTier(state, row.a, row.b, row.tier)) moved += 1;
  }
  return moved;
}

export function relationTierBrief(state: GameState): RelationTierProposal[] {
  const nameOf = new Map<string, string>([[MANAGER_SUBJECT, state.manager.name]]);
  const counterparts: string[] = [];
  for (const persona of state.personas) {
    nameOf.set(persona.characterId, persona.name);
    counterparts.push(persona.characterId);
  }
  for (const player of playersOf(state, state.userTeamId)) {
    nameOf.set(player.id, player.name);
    counterparts.push(player.id);
  }

  const rows: RelationTierProposal[] = [];
  const seen = new Set<string>();
  for (const subject of counterparts) {
    const key = pairOf(MANAGER_SUBJECT, subject);
    seen.add(pairKey(key.a, key.b));
    rows.push({
      a: state.manager.name,
      b: nameOf.get(subject)!,
      tier: relationTierOf(state, MANAGER_SUBJECT, subject),
    });
  }
  // 장부에 선 나머지 쌍 — 선수끼리·페르소나끼리는 여기서만 표에 오른다
  for (const row of state.relations) {
    if (seen.has(pairKey(row.a, row.b))) continue;
    const a = nameOf.get(row.a);
    const b = nameOf.get(row.b);
    if (a === undefined || b === undefined) continue;
    rows.push({ a, b, tier: row.tier });
  }
  return rows;
}

function counterpartsOf(state: GameState): Counterpart[] {
  const rows: Counterpart[] = [
    { subject: MANAGER_SUBJECT, characterId: state.manager.name, name: state.manager.name },
  ];
  for (const persona of state.personas) {
    rows.push({
      subject: persona.characterId,
      characterId: persona.characterId,
      name: persona.name,
    });
  }
  for (const player of playersOf(state, state.userTeamId)) {
    rows.push({ subject: player.id, characterId: player.name, name: player.name });
  }
  return rows;
}

/**
 * 등급이 세운 관계 줄 — **감독과의 사이가 맨 앞이다** (people.md §6).
 *
 * 그 뒤는 가운데에서 먼 등급부터이고, 같으면 열쇠의 코드포인트 순이라 세이브를 다시
 * 열어도 같은 카드가 나온다. 결이 서지 않는 가운데 둘은 서지 않는다.
 */
export function tierRelations(state: GameState, characterId: string): PersonaRelation[] {
  const self = subjectOfCharacter(state, characterId);
  if (self === null) return [];

  const rows: { row: PersonaRelation; intensity: number; subject: string }[] = [];
  for (const other of counterpartsOf(state)) {
    if (other.subject === self) continue;
    const tier = relationTierOf(state, self, other.subject);
    const stance = stanceOfTier(tier);
    if (stance === null) continue;
    rows.push({
      row: { characterId: other.characterId, name: other.name, stance, tier },
      intensity: relationTierIntensity(tier),
      subject: other.subject,
    });
  }

  const manager = rows.find((r) => r.subject === MANAGER_SUBJECT);
  const rest = rows
    .filter((r) => r.subject !== MANAGER_SUBJECT)
    .sort(
      (x, y) =>
        y.intensity - x.intensity || (x.subject < y.subject ? -1 : x.subject > y.subject ? 1 : 0),
    );
  return [...(manager ? [manager] : []), ...rest].map((r) => r.row);
}

/** 감독의 고정 열쇠 — 선수 id도 `characterId`도 아닌 자리라 이름 하나가 필요하다 */
export const MANAGER_SUBJECT = "@manager";

export function pairKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}

/** Relationship keys are independent of the order in which people are named. */
function pairOf(a: string, b: string): { a: string; b: string } {
  return a < b ? { a, b } : { a: b, b: a };
}

// ── 압축이 등급을 매긴다 (people.md §6 · agents.md §5-1) ──────

/** 압축이 낸 관계 한 줄 — 이름은 사람 이름이고 열쇠로 옮기는 문은 하나다 */
export interface RelationTierProposal {
  a: string;
  b: string;
  tier: RelationTier;
}

// ── 카드에 서는 줄 (people.md §6) ─────────────────────────────

/**
 * 한 인물 카드에 서는 관계 줄의 상한 — 넷.
 *
 * 관계가 선수에게까지 서면서 후보가 스쿼드 전체로 늘었다. 자르지 않으면 인물지가
 * 관계 목록이 되고, 성격도 말투도 그 아래로 밀린다.
 */
export const RELATION_CARD_LIMIT = 4;

/** 이 카드에서 상대가 불리는 이름 — 카드의 열쇠는 선수의 경우 **이름**이다 */
export interface Counterpart {
  subject: string;
  characterId: string;
  name: string;
}
