import { z } from "zod";

/**
 * **자리 14개** — 포지션 적응도가 붙는 단위다 (player.md §8). FM의 포지션에서 SW를 뺀
 * 것이고, 전술판의 슬롯 코드(`POSITION_CODES`)는 전부 이 중 하나로 접힌다.
 *
 * 자리는 "어디를 아는가"이고 그 자리에서 무엇을 하는가는 역할이 가른다 — 그래서
 * 최전방의 CF·LF·RF는 따로 자리가 아니라 ST이고, 처진 스트라이커(SS)는 FM처럼 공격형
 * 미드필더 자리의 일이다.
 */
export const PLACES = [
  "GK",
  "LB",
  "CB",
  "RB",
  "LWB",
  "RWB",
  "DM",
  "LM",
  "CM",
  "RM",
  "LW",
  "AM",
  "RW",
  "ST",
] as const;
export type Place = (typeof PLACES)[number];
export const PlaceSchema = z.enum(PLACES);

export const PLACE_KO: Record<Place, string> = {
  GK: "골키퍼",
  LB: "왼쪽 풀백",
  CB: "센터백",
  RB: "오른쪽 풀백",
  LWB: "왼쪽 윙백",
  RWB: "오른쪽 윙백",
  DM: "수비형 미드필더",
  LM: "왼쪽 미드필더",
  CM: "중앙 미드필더",
  RM: "오른쪽 미드필더",
  LW: "왼쪽 윙어",
  AM: "공격형 미드필더",
  RW: "오른쪽 윙어",
  ST: "스트라이커",
};
