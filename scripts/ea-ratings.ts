/**
 * 시드 세부 능력치 채움 — EA SPORTS FC 공식 레이팅에서 (docs/core/sources.md §4.2).
 *
 *   pnpm ea-ratings            리포트만 낸다 (기본값 — 아무것도 쓰지 않는다)
 *   pnpm ea-ratings --write    `players/catalog/ea-ratings.ts`를 다시 쓴다
 *   pnpm ea-ratings --refetch  받아 둔 페이지를 버리고 다시 받는다
 *
 * 원본은 ea.com 레이팅 페이지가 읽는 공개 API다. 남자 선수 전원을 100명씩 받아
 * 임시 디렉터리에 두고(다시 돌릴 때 같은 페이지를 또 받지 않는다), 시드와
 * **(이름 + 생년월일)**로 잇는다 — 대표 수치 6개를 잇던 fcratings 조인과 같은 키다.
 *
 * ⚠️ **이 스크립트만이 `ea-ratings.ts`를 쓴다.** 손으로 고치면 다음 실행이 되돌린다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SQUAD_SEEDS } from "../packages/engine/src/players/catalog/squad-seeds";
import {
  EA_FACE_OF,
  EA_STAT_KEYS,
  type EaRating,
  type EaStat,
} from "../packages/engine/src/players/catalog/ea-stats";
import { weightSlotOf, type WeightSlot } from "../packages/domain/src/players/player";

const REPO = path.resolve(fileURLToPath(import.meta.url), "../..");
const OUT = path.join(REPO, "packages/engine/src/players/catalog/ea-ratings.ts");
const CACHE = path.join(os.tmpdir(), "gaffer-ea-ratings");
const API = "https://drop-api.ea.com/rating/ea-sports-fc";
const PAGE = 100;
/** 남자 축구 — 여자 선수는 같은 API의 `gender=1`이다 */
const GENDER_MEN = 0;

// ── 응답 좁히기 ─────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw new Error(`EA 응답의 ${what}가 객체가 아니다`);
  return v;
}
function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`EA 응답의 ${what}가 숫자가 아니다`);
  return v;
}
function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`EA 응답의 ${what}가 문자열이 아니다`);
  return v;
}
function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`EA 응답의 ${what}가 배열이 아니다`);
  return v;
}
/** 없는 목록을 `null`로 보내는 칸(보조 포지션·플레이스타일)이 있다 — 빈 목록이다 */
function list0(v: unknown, what: string): unknown[] {
  return v === null || v === undefined ? [] : arr(v, what);
}

interface EaPlayer {
  rating: EaRating;
  firstName: string;
  lastName: string;
  commonName: string | null;
  /** YYYY-MM-DD */
  birthdate: string;
}

/** "6/15/1992 12:00:00 AM" → "1992-06-15" */
function isoDate(raw: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw);
  if (!m) throw new Error(`EA 생년월일을 못 읽었다: ${raw}`);
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

function playerOf(raw: unknown): EaPlayer {
  const it = obj(raw, "선수");
  const stats = obj(it.stats, "stats");
  const s = EA_STAT_KEYS.map((key) => num(obj(stats[key], key).value, key));
  const styles = list0(it.playerAbilities, "playerAbilities").map((a) => obj(a, "ability"));
  const styleOf = (kind: string) =>
    styles
      .filter((a) => obj(a.type, "ability.type").id === kind)
      .map((a) => str(a.label, "ability.label").replace(/\+$/u, "").trim());
  const position = obj(it.position, "position");
  const foot = num(it.preferredFoot, "preferredFoot");
  return {
    firstName: str(it.firstName, "firstName"),
    lastName: str(it.lastName, "lastName"),
    commonName: it.commonName === null ? null : str(it.commonName, "commonName"),
    birthdate: isoDate(str(it.birthdate, "birthdate")),
    rating: {
      id: num(it.id, "id"),
      ovr: num(it.overallRating, "overallRating"),
      pos: str(position.shortLabel, "position.shortLabel"),
      alt: list0(it.alternatePositions, "alternatePositions").map((p) =>
        str(obj(p, "alternatePosition").shortLabel, "alternatePosition.shortLabel"),
      ),
      // EA는 1이 오른발, 2가 왼발이다
      foot: foot === 2 ? "L" : "R",
      wf: num(it.weakFootAbility, "weakFootAbility"),
      sm: num(it.skillMoves, "skillMoves"),
      h: num(it.height, "height"),
      w: num(it.weight, "weight"),
      s,
      ps: styleOf("playStyle"),
      pp: styleOf("playStylePlus"),
    },
  };
}

// ── 받기 (페이지는 임시 디렉터리에 남긴다) ─────────────────────

async function fetchPage(offset: number, refetch: boolean): Promise<unknown> {
  const file = path.join(CACHE, `men-${offset}.json`);
  if (!refetch && existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as unknown;
  const url = `${API}?locale=en&limit=${PAGE}&offset=${offset}&gender=${GENDER_MEN}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body: unknown = await res.json();
        writeFileSync(file, JSON.stringify(body));
        return body;
      }
    } catch {
      /* 일시적인 전송 오류는 다시 받는다 */
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  throw new Error(`EA 레이팅 ${offset}번째 페이지가 다섯 번 다 답하지 않았다`);
}

async function fetchAll(refetch: boolean): Promise<EaPlayer[]> {
  mkdirSync(CACHE, { recursive: true });
  const first = obj(await fetchPage(0, refetch), "페이지");
  const total = num(first.totalItems, "totalItems");
  const pages: unknown[] = [first];
  for (let offset = PAGE; offset < total; offset += PAGE)
    pages.push(await fetchPage(offset, refetch));
  const players = pages.flatMap((page) => arr(obj(page, "페이지").items, "items").map(playerOf));
  // 같은 사람이 두 장으로 오면(이벤트 카드) 높은 쪽이 아니라 먼저 온 쪽 — 기본 카드가 먼저다
  const seen = new Set<number>();
  return players.filter((p) => {
    if (seen.has(p.rating.id)) return false;
    seen.add(p.rating.id);
    return true;
  });
}

// ── 잇기 ─────────────────────────────────────────────────

const FOLD: Record<string, string> = { ø: "o", æ: "ae", ß: "ss", ł: "l", đ: "d", ı: "i", œ: "oe" };

/** 이름 → 견줄 낱말들 (악센트·기호를 지우고 소문자) */
function tokensOf(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[øæßłđıœ]/gu, (c) => FOLD[c] ?? c)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z]+/gu, " ")
    .split(" ")
    .filter((t) => t.length >= 2);
}

interface Seed {
  nameEn: string;
  birthdate: string;
  birthdateApprox: boolean;
  teamId: string;
  position: string;
  /** 대표 수치 — EA 카드의 여섯 숫자와 GK 종합 */
  face: Partial<Record<(typeof EA_FACE_OF)[EaStat], number>>;
}

/** EA 한 사람의 이름 낱말 — 이름·성·통용 이름을 다 넣는다 */
function eaTokens(p: EaPlayer): Set<string> {
  return new Set([
    ...tokensOf(p.firstName),
    ...tokensOf(p.lastName),
    ...(p.commonName ? tokensOf(p.commonName) : []),
  ]);
}

/**
 * 이름이 같은 사람을 가리키는가 — **성(시드 이름의 마지막 낱말)이 EA 쪽에 있거나,
 * 시드 이름 전체가 EA의 통용 이름과 같으면** 같다고 본다. "Rodri"·"Vinícius Júnior"처럼
 * EA가 통용 이름으로만 아는 선수가 둘째 길로 잇는다.
 */
function sameName(seed: Seed, p: EaPlayer): boolean {
  const mine = tokensOf(seed.nameEn);
  if (mine.length === 0) return false;
  const theirs = eaTokens(p);
  const common = p.commonName ? tokensOf(p.commonName).join(" ") : "";
  if (common !== "" && common === mine.join(" ")) return true;
  // 성이 둘 이상인 표기(Gonçalo Inácio Ramos)는 앞쪽 성이 EA의 성일 수 있다
  return (
    theirs.has(mine[mine.length - 1]!) ||
    (mine.length >= 3 && mine.slice(1).some((t) => theirs.has(t) && t.length >= 4))
  );
}

/**
 * 이름(first name)이 같은 사람을 가리키는가 — 애칭과 정식 이름(Ben·Benjamin, Andy·Andrew,
 * Vitalii·Vitaliy)은 앞 세 글자로 같다고 본다. 같은 날 태어난 같은 성이 둘일 때만 읽는다.
 */
function sameFirstName(seed: Seed, p: EaPlayer): boolean {
  const first = tokensOf(seed.nameEn)[0];
  if (first === undefined) return false;
  const theirs = [...eaTokens(p)];
  const stem = (t: string) => t.slice(0, 3);
  return theirs.some((t) => t === first || (first.length >= 3 && stem(t) === stem(first)));
}

/** 이름이 낱말까지 같은가 — 생년월일이 어긋난 조인을 받아 줄 만큼 강한 일치 */
function strongName(seed: Seed, p: EaPlayer): boolean {
  const mine = tokensOf(seed.nameEn).join(" ");
  const full = [...tokensOf(p.firstName), ...tokensOf(p.lastName)].join(" ");
  const common = p.commonName ? tokensOf(p.commonName).join(" ") : "";
  return mine === full || (common !== "" && mine === common);
}

type JoinKind = "exact" | "year";

function join(
  seeds: readonly Seed[],
  players: readonly EaPlayer[],
): { joined: Map<string, { seed: Seed; player: EaPlayer; kind: JoinKind }>; missed: Seed[] } {
  const byDate = new Map<string, EaPlayer[]>();
  for (const p of players) byDate.set(p.birthdate, [...(byDate.get(p.birthdate) ?? []), p]);
  const joined = new Map<string, { seed: Seed; player: EaPlayer; kind: JoinKind }>();
  const takenBy = new Map<number, string>();
  const missed: Seed[] = [];
  const keyOf = (s: Seed) => `${s.nameEn}|${s.birthdate}`;

  for (const seed of seeds) {
    // ① 같은 날 태어난 같은 이름 — 근사 생년월일은 조인 키가 아니다 (sources.md §4.1)
    const sameDay = seed.birthdateApprox
      ? []
      : (byDate.get(seed.birthdate) ?? []).filter((p) => sameName(seed, p));
    // 같은 날 같은 성이 둘이면 형제다(팀버·킨·세세뇽·머피 쌍둥이) — 이름으로 가른다
    const exact = sameDay.length > 1 ? sameDay.filter((p) => sameFirstName(seed, p)) : sameDay;
    // ② 낱말까지 같은 이름이고 태어난 해가 ±1 — EA가 생년월일을 틀린 자리
    const year = Number(seed.birthdate.slice(0, 4));
    const loose =
      exact.length > 0
        ? []
        : players.filter(
            (p) => strongName(seed, p) && Math.abs(Number(p.birthdate.slice(0, 4)) - year) <= 1,
          );
    const kind: JoinKind = exact.length > 0 ? "exact" : "year";
    const candidates = exact.length > 0 ? exact : loose;
    if (candidates.length !== 1) {
      missed.push(seed);
      continue;
    }
    const player = candidates[0]!;
    const prior = takenBy.get(player.rating.id);
    if (prior !== undefined) {
      // 한 EA 사람을 두 시드가 가리키면 생년월일까지 맞은 쪽만 남는다
      const other = joined.get(prior)!;
      if (other.kind === "exact" && kind !== "exact") {
        missed.push(seed);
        continue;
      }
      joined.delete(prior);
      missed.push(other.seed);
    }
    takenBy.set(player.rating.id, keyOf(seed));
    joined.set(keyOf(seed), { seed, player, kind });
  }
  return { joined, missed };
}

// ── 세부 능력치 편차 — EA에 없는 선수를 세우는 두 표 ─────────────────

type OffsetModel = Record<WeightSlot, Record<EaStat, [number, number]>>;

/**
 * 자리마다 **세부 능력치 − 기준값**의 가운데값과 흩어짐 (`players/catalog/attributes.ts`).
 * 기준값이 두 가지라 표도 둘이다.
 *
 * - **대표 수치**(`EA_FACE_MODEL`) — 그 세부 능력치를 묶는 PAC·SHO·…·GK 종합. 대표 수치만
 *   아는 실선수(아카데미 자원)를 세운다.
 * - **EA 종합**(`EA_LEVEL_MODEL`) — 그 선수의 OVR. 실력 하나만 정해 두고 태어나는 절차
 *   생성 선수(유스·2부 스쿼드)를 세운다. 대표 수치를 거치면 생성기가 지은 대표 수치의
 *   모양이 실선수의 모양과 달라(스트라이커의 수비 수치가 높다) 세부 능력치가 부푼다.
 *
 * 평균이 아니라 가운데값을 쓰는 이유: 시드의 대표 수치 중에는 실측이 아니라 같은 구단
 * 같은 자리의 기준치로 채운 줄이 섞여 있어(sources.md §4.1) 차이에 꼬리가 붙는다.
 * 흩어짐은 사분위 폭 ÷ 1.35 — 꼬리에 끌리지 않는 표준편차 추정이다.
 */
function offsetModel(
  joined: readonly { seed: Seed; player: EaPlayer }[],
  baseOf: (seed: Seed, player: EaPlayer, stat: EaStat) => number,
): OffsetModel {
  const diffs = new Map<string, number[]>();
  for (const { seed, player } of joined) {
    const slot = weightSlotOf(seed.position);
    EA_STAT_KEYS.forEach((stat, i) => {
      const key = `${slot}:${stat}`;
      diffs.set(key, [...(diffs.get(key) ?? []), player.rating.s[i]! - baseOf(seed, player, stat)]);
    });
  }
  const quantile = (xs: number[], q: number) =>
    xs[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const model: Partial<Record<WeightSlot, Record<EaStat, [number, number]>>> = {};
  for (const [key, xs] of diffs) {
    const [slot, stat] = key.split(":") as [WeightSlot, EaStat];
    const sorted = [...xs].sort((a, b) => a - b);
    const spread = (quantile(sorted, 0.75) - quantile(sorted, 0.25)) / 1.35;
    (model[slot] ??= {} as Record<EaStat, [number, number]>)[stat] = [
      round1(quantile(sorted, 0.5)),
      round1(spread),
    ];
  }
  // 시드는 아홉 자리를 다 가진다 — 빈 자리가 있으면 시드가 아니라 조인이 틀린 것이다
  return model as OffsetModel;
}

const faceBase = (seed: Seed, _player: EaPlayer, stat: EaStat) => seed.face[EA_FACE_OF[stat]] ?? 0;
const levelBase = (_seed: Seed, player: EaPlayer) => player.rating.ovr;

// ── 쓰기 ─────────────────────────────────────────────────

const list = (xs: readonly string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;

function lineOf(key: string, r: EaRating): string {
  return (
    `  ${JSON.stringify(key)}: { id: ${r.id}, ovr: ${r.ovr}, pos: ${JSON.stringify(r.pos)}, ` +
    `alt: ${list(r.alt)}, foot: ${JSON.stringify(r.foot)}, wf: ${r.wf}, sm: ${r.sm}, ` +
    `h: ${r.h}, w: ${r.w}, s: [${r.s.join(", ")}], ps: ${list(r.ps)}, pp: ${list(r.pp)} },`
  );
}

const modelLines = (model: OffsetModel) =>
  (Object.keys(model) as WeightSlot[])
    .sort()
    .map(
      (slot) =>
        `  ${slot}: { ${EA_STAT_KEYS.map((stat) => `${stat}: [${model[slot][stat].join(", ")}]`).join(", ")} },`,
    );

function render(
  rows: readonly [string, EaRating][],
  face: OffsetModel,
  level: OffsetModel,
  fetched: string,
): string {
  return [
    `import type { WeightSlot } from "@gaffer/domain";`,
    `import type { EaRating, EaStat } from "./ea-stats";`,
    ``,
    `/**`,
    ` * EA SPORTS FC 공식 레이팅의 세부 능력치 — **시드 선수 × EA 한 줄** (core/sources.md §4.2).`,
    ` *`,
    ` * ⚠️ 생성 파일이다. \`pnpm ea-ratings --write\`만 이 파일을 쓴다 — 손으로 고치면 다음`,
    ` * 실행이 되돌린다. 키는 시드의 \`이름|생년월일\`이고, 열 순서는 \`EA_STAT_KEYS\`다.`,
    ` *`,
    ` * ⚠️ 라이선스 부채 (sources.md §7): 능력치는 EA IP다. 시드의 대표 수치와 같은 부채다.`,
    ` */`,
    `export const EA_RATINGS_FETCHED = ${JSON.stringify(fetched)};`,
    ``,
    `export const EA_RATINGS: Readonly<Record<string, EaRating>> = {`,
    ...rows.map(([key, r]) => lineOf(key, r)),
    `};`,
    ``,
    `/**`,
    ` * 자리별 **세부 능력치 − 대표 수치**의 [가운데값, 흩어짐] — 대표 수치만 아는 실선수의 세부`,
    ` * 능력치를 세우는 표다. 위 표의 선수들에게서 잰다.`,
    ` */`,
    `export const EA_FACE_MODEL: Readonly<`,
    `  Record<WeightSlot, Readonly<Record<EaStat, readonly [number, number]>>>`,
    `> = {`,
    ...modelLines(face),
    `};`,
    ``,
    `/**`,
    ` * 자리별 **세부 능력치 − EA 종합**의 [가운데값, 흩어짐] — 실력 하나로 태어나는 절차 생성`,
    ` * 선수의 세부 능력치를 세우는 표다. 위 표의 선수들에게서 잰다.`,
    ` */`,
    `export const EA_LEVEL_MODEL: Readonly<`,
    `  Record<WeightSlot, Readonly<Record<EaStat, readonly [number, number]>>>`,
    `> = {`,
    ...modelLines(level),
    `};`,
    ``,
  ].join("\n");
}

// ── 실행 ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const refetch = process.argv.includes("--refetch");
  const players = await fetchAll(refetch);
  const seeds: Seed[] = Object.entries(SQUAD_SEEDS).flatMap(([teamId, squad]) =>
    squad.map((s) => ({
      nameEn: s.nameEn,
      birthdate: s.birthdate,
      birthdateApprox: s.birthdateApprox === true,
      teamId,
      position: s.position,
      face: {
        pace: s.pace,
        shooting: s.shooting,
        passing: s.passing,
        dribbling: s.dribbling,
        defending: s.defending,
        physical: s.physical,
        ...(s.goalkeeping === undefined ? {} : { goalkeeping: s.goalkeeping }),
      },
    })),
  );
  const { joined, missed } = join(seeds, players);
  const byKind = { exact: 0, year: 0 };
  for (const j of joined.values()) byKind[j.kind] += 1;

  console.log(`EA 남자 선수 ${players.length}명 · 시드 ${seeds.length}명`);
  console.log(
    `이음 ${joined.size}명 (생년월일까지 ${byKind.exact} · 해 ±1 ${byKind.year}) · 못 이음 ${missed.length}명`,
  );
  if (!write) {
    for (const j of joined.values())
      if (j.kind === "year")
        console.log(
          `  해 ±1 ${j.seed.teamId} ${j.seed.nameEn} ${j.seed.birthdate} ← EA ${j.player.firstName} ${j.player.lastName} ${j.player.birthdate}`,
        );
    for (const s of missed.slice(0, 40))
      console.log(`  못 이음 ${s.teamId} ${s.nameEn} ${s.birthdate}`);
    return;
  }
  const rows = [...joined.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, j]): [string, EaRating] => [key, j.player.rating]);
  const all = [...joined.values()];
  writeFileSync(
    OUT,
    render(
      rows,
      offsetModel(all, faceBase),
      offsetModel(all, levelBase),
      new Date().toISOString().slice(0, 10),
    ),
    "utf8",
  );
  console.log(`썼다 ${path.relative(REPO, OUT)} — ${rows.length}줄`);
}

await main();
