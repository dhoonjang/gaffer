import { type Negotiation, type SquadStatus } from "@story-fm/domain";
export function personalHolds(
  negotiation: Pick<Negotiation, "personal">,
  offer: { weeklyWage: number; contractYears?: number; squadStatus?: SquadStatus },
): boolean {
  const personal = negotiation.personal;
  if (!personal || personal.agreedOn === undefined) return false;
  if (offer.weeklyWage !== personal.weeklyWage) return false;
  if (offer.contractYears !== undefined && offer.contractYears !== personal.contractYears) {
    return false;
  }
  return (offer.squadStatus ?? undefined) === (personal.squadStatus ?? undefined);
}
