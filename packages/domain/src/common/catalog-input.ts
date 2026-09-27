import { z } from "zod";
import { DateString } from "./date-string";
import { isAssociation } from "./nationality";
import { ATTRIBUTE_AXES, positionGroupOf, type AttributeAxis } from "./player";
import { ClubHonourSchema } from "./team";
import { FormationSchema } from "./team-tactics";

export const CATALOG_MAX_WAGE = 2_000_000;
export const CATALOG_MAX_CAPACITY = 200_000;
export const TACTICAL_STYLES = [
  "possession",
  "high-press",
  "transition",
  "direct",
  "low-block",
  "balanced",
] as const;
export type CatalogTacticalStyle = (typeof TACTICAL_STYLES)[number];
const name = (max: number) => z.string().trim().min(1, "이름이 필요합니다").max(max);
const rating = z.number().int().min(1).max(99);
const wage = z.number().int().min(0).max(CATALOG_MAX_WAGE);
const nationality = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isAssociation, "알 수 없는 협회 코드입니다");
const position = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => positionGroupOf(v) !== null, "알 수 없는 포지션입니다");
const positions = z
  .array(z.object({ position, proficiency: rating, isNatural: z.boolean() }))
  .min(1, "포지션이 최소 1개 필요합니다")
  .refine((xs) => xs.some((p) => p.isNatural), "주 포지션은 하나 이상이어야 합니다")
  .refine(
    (xs) => new Set(xs.map((p) => p.position)).size === xs.length,
    "같은 포지션이 두 번 들어 있습니다",
  );

/** Catalog field validation is shared by forms, HTTP and deterministic commands. */
export const CatalogPlayerInputSchema = z.object({
  nameKo: name(40),
  nameEn: name(60).optional(),
  birthdate: DateString,
  position,
  nationality: nationality.optional(),
  secondNationality: nationality.optional(),
  ...(Object.fromEntries(ATTRIBUTE_AXES.map((a) => [a, rating])) as Record<
    AttributeAxis,
    typeof rating
  >),
  potential: rating,
  weeklyWage: wage.optional(),
});
export const CatalogPlayerEditSchema = CatalogPlayerInputSchema.partial().extend({
  teamId: z.string().min(1).optional(),
  positions: positions.optional(),
  secondNationality: z.union([z.literal(""), nationality]).optional(),
  weeklyWage: wage.nullable().optional(),
});
export const CatalogPlayerCreateSchema = CatalogPlayerInputSchema.extend({
  teamId: z.string().min(1),
});
const grade = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const CatalogTeamInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "팀 id는 영소문자·숫자·하이픈만 쓸 수 있습니다"),
  name: name(60),
  shortName: name(10),
  leagueId: z.string().min(1),
  tier: grade,
  formation: FormationSchema.optional(),
  tacticalStyle: z.enum(TACTICAL_STYLES).optional(),
  stadium: name(60).optional(),
  capacity: z
    .number()
    .int()
    .min(1, "수용인원은 1 이상이어야 합니다")
    .max(CATALOG_MAX_CAPACITY)
    .optional(),
  commercialTier: grade.optional(),
  honours: z.array(ClubHonourSchema.extend({ count: z.number().int().min(1) })).optional(),
});
export const CatalogTeamEditSchema = CatalogTeamInputSchema.omit({ id: true })
  .partial()
  .extend({ formation: FormationSchema.nullable().optional() });
