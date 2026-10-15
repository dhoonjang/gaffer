import type { InclinationAxis, OverallAxis, WeightSlot } from "./player";

/**
 * 자리 묶음마다 그 자리 선수의 **평균 축** — 카드 기준점의 기준 선수다 (player.md §3).
 * 평균적인 선수가 어느 카드에서도 기본 카드와 같은 값을 내도록 `cardFit`이 평행 이동한다.
 *
 * ⚠️ `pnpm slot-reference --write`가 쓰는 생성 파일이다 — 손으로 고치면 다음 실행이 되돌린다.
 */
export const SLOT_REFERENCE: Readonly<Record<WeightSlot, Readonly<Record<OverallAxis, number>>>> = {
  GK: { finishing: 8.8, longShots: 20.5, heading: 12.4, dribbling: 14.1, firstTouch: 21.6, passing: 30.4, crossing: 10.9, technique: 12.4, tackling: 12.6, marking: 12.6, freeKicks: 11.3, penalties: 15.2, anticipation: 65.8, vision: 41.2, decisions: 67.2, composure: 45.2, offTheBall: 8, positioning: 68.1, concentration: 67.2, acceleration: 38.2, pace: 38.1, agility: 69.2, balance: 37.9, jumpingReach: 61.6, strength: 60.5, stamina: 29.2, reflexes: 70.3, handling: 67.1, oneOnOnes: 69.2, aerialReach: 60.5, kicking: 65.9 },
  CB: { finishing: 28.2, longShots: 36, heading: 66.2, dribbling: 51.5, firstTouch: 58.8, passing: 60.8, crossing: 39.7, technique: 41.6, tackling: 67.4, marking: 66.9, freeKicks: 30.8, penalties: 36, anticipation: 64.6, vision: 46, decisions: 62.5, composure: 59.8, offTheBall: 34.6, positioning: 66.6, concentration: 63.7, acceleration: 57, pace: 61.9, agility: 49.7, balance: 49.8, jumpingReach: 74.6, strength: 71.8, stamina: 62.8, reflexes: 6.8, handling: 7.1, oneOnOnes: 6.9, aerialReach: 7.1, kicking: 7 },
  FB: { finishing: 43.3, longShots: 49.6, heading: 56.8, dribbling: 65, firstTouch: 65.9, passing: 63.1, crossing: 64.3, technique: 53.9, tackling: 65.5, marking: 63.3, freeKicks: 44.6, penalties: 41.2, anticipation: 64.4, vision: 57, decisions: 63, composure: 61.2, offTheBall: 58.7, positioning: 63.6, concentration: 63.3, acceleration: 69.7, pace: 70.4, agility: 65.3, balance: 65.1, jumpingReach: 66.8, strength: 60.9, stamina: 68.7, reflexes: 7.2, handling: 6.8, oneOnOnes: 7, aerialReach: 6.8, kicking: 6.8 },
  DM: { finishing: 48.9, longShots: 58, heading: 57.2, dribbling: 64.9, firstTouch: 68, passing: 69.6, crossing: 54.7, technique: 57.1, tackling: 66.6, marking: 65, freeKicks: 48.9, penalties: 47.8, anticipation: 66.1, vision: 65.3, decisions: 66.2, composure: 65.9, offTheBall: 56.3, positioning: 65.8, concentration: 65.9, acceleration: 59.4, pace: 59.2, agility: 62.1, balance: 64.5, jumpingReach: 64.1, strength: 64.4, stamina: 69.7, reflexes: 7.1, handling: 7.3, oneOnOnes: 7.2, aerialReach: 7.3, kicking: 7.1 },
  CM: { finishing: 55.8, longShots: 61, heading: 52.9, dribbling: 67.2, firstTouch: 69.1, passing: 68.9, crossing: 57.5, technique: 60.2, tackling: 62.3, marking: 59.7, freeKicks: 53, penalties: 49.5, anticipation: 66.3, vision: 67.2, decisions: 66.3, composure: 65.8, offTheBall: 62.5, positioning: 61.1, concentration: 64.9, acceleration: 63.3, pace: 61.8, agility: 65.1, balance: 65, jumpingReach: 62.7, strength: 60.8, stamina: 69, reflexes: 7, handling: 6.6, oneOnOnes: 6.9, aerialReach: 6.6, kicking: 6.9 },
  AM: { finishing: 60.9, longShots: 62.3, heading: 47.8, dribbling: 68.3, firstTouch: 67.9, passing: 64.2, crossing: 58.6, technique: 60.8, tackling: 39.9, marking: 39.1, freeKicks: 55.6, penalties: 54.8, anticipation: 64.1, vision: 64.3, decisions: 64.1, composure: 63.7, offTheBall: 64, positioning: 39.3, concentration: 59, acceleration: 65.7, pace: 63.5, agility: 68.7, balance: 67.3, jumpingReach: 57.7, strength: 54, stamina: 62.4, reflexes: 6.4, handling: 6.5, oneOnOnes: 6.4, aerialReach: 6.5, kicking: 6.6 },
  W: { finishing: 59.1, longShots: 59.8, heading: 43.7, dribbling: 67.8, firstTouch: 66.1, passing: 59.6, crossing: 60.2, technique: 57.7, tackling: 29.5, marking: 29.6, freeKicks: 50.3, penalties: 51.9, anticipation: 61.7, vision: 60.6, decisions: 61.5, composure: 60.9, offTheBall: 62, positioning: 29.1, concentration: 55.1, acceleration: 73.1, pace: 71.8, agility: 71.8, balance: 68.9, jumpingReach: 57.7, strength: 50.8, stamina: 61, reflexes: 5.9, handling: 5.9, oneOnOnes: 5.8, aerialReach: 5.9, kicking: 5.9 },
  CF: { finishing: 69.9, longShots: 67, heading: 69.3, dribbling: 68.8, firstTouch: 70, passing: 61.7, crossing: 53.1, technique: 60.7, tackling: 27, marking: 28.2, freeKicks: 50.9, penalties: 65.5, anticipation: 68.4, vision: 61.1, decisions: 67.8, composure: 66.7, offTheBall: 71.2, positioning: 27.5, concentration: 59.9, acceleration: 69.4, pace: 71.3, agility: 66.2, balance: 63, jumpingReach: 78.6, strength: 71.3, stamina: 65.4, reflexes: 8.5, handling: 8.2, oneOnOnes: 8.3, aerialReach: 8.2, kicking: 8.5 },
  ST: { finishing: 69.9, longShots: 67, heading: 69.3, dribbling: 68.8, firstTouch: 70, passing: 61.7, crossing: 53.1, technique: 60.7, tackling: 27, marking: 28.2, freeKicks: 50.9, penalties: 65.5, anticipation: 68.4, vision: 61.1, decisions: 67.8, composure: 66.7, offTheBall: 71.2, positioning: 27.5, concentration: 59.9, acceleration: 69.4, pace: 71.3, agility: 66.2, balance: 63, jumpingReach: 78.6, strength: 71.3, stamina: 65.4, reflexes: 8.5, handling: 8.2, oneOnOnes: 8.3, aerialReach: 8.2, kicking: 8.5 },
};

/**
 * 자리 묶음마다 그 자리 선수의 **평균 성향** — 버릇은 이 값에서 벗어난 만큼이다 (player.md §3.4).
 */
export const SLOT_INCLINATION: Readonly<
  Record<WeightSlot, Readonly<Record<InclinationAxis, number>>>
> = {
  GK: { aggression: 23, flair: 30, workRate: 27, commandOfArea: 47.3, rushingOut: 38.6 },
  CB: { aggression: 67.4, flair: 37.4, workRate: 65, commandOfArea: 7.1, rushingOut: 7 },
  FB: { aggression: 63.3, flair: 45.3, workRate: 66.8, commandOfArea: 6.8, rushingOut: 7 },
  DM: { aggression: 67.4, flair: 44.8, workRate: 69.6, commandOfArea: 7.3, rushingOut: 7.3 },
  CM: { aggression: 63.7, flair: 48.3, workRate: 67.7, commandOfArea: 6.6, rushingOut: 7 },
  AM: { aggression: 51, flair: 52, workRate: 58.3, commandOfArea: 6.5, rushingOut: 6.2 },
  W: { aggression: 46.7, flair: 51.8, workRate: 55.4, commandOfArea: 5.9, rushingOut: 5.8 },
  CF: { aggression: 59, flair: 49.9, workRate: 63.5, commandOfArea: 8.2, rushingOut: 8.2 },
  ST: { aggression: 59, flair: 49.9, workRate: 63.5, commandOfArea: 8.2, rushingOut: 8.2 },
};
