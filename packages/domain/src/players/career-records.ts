import { z } from "zod";
import { DateString } from "../core/date-string";
import { RetirementReasonSchema, GamePlayerSchema } from "./player";

// ── 은퇴 명부 ─────────────────────────────────────────
/**
 * 은퇴 명부 (RETIRED_PLAYER) — **그만둔 사람이 남기는 한 줄** (season.md §6).
 *
 * 은퇴하면 `state.players`에서 빠지므로 id로는 이름도 나이도 되찾지 못한다. 원장의
 * `TRANSFER.type = "retire"` 줄은 **누가**를 id로만 아는 줄이라, 그 줄만으로는
 * 오프시즌 블록도 인물 사전도 시상 기록도 그 사람을 부를 수 없다.
 *
 * ⚠️ **통산은 여기 적지 않는다.** `seasonStats`의 행은 은퇴로 지워지지 않아
 * `careerTotalsOf`가 같은 수를 그대로 낸다 — 한 값을 두 곳에 적으면 언젠가 갈린다
 * (game-state.md §3.4).
 *
 * ⚠️ **감독 팀에서 은퇴한 선수만 담는다** — `growthLog`·`milestones`와 같은 규약이다.
 * 세계 전체는 시즌마다 수백 명이 그만두고, 그 이름을 읽는 자리는 전부 우리 사람의
 * 자리다. 은퇴 자체는 소속과 무관하게 일어난다.
 */
export const RetiredPlayerSchema = z.object({
  /** 현역 시절 `GAME_PLAYER.id` 그대로 — 새 유스에게 다시 주지 않는 id다 */
  gamePlayerId: z.string().min(1),
  name: z.string().min(1),
  /**
   * 생일과 주 포지션 — **페르소나를 현역 때와 같은 채널에서 되짚는 열쇠다**
   * (people.md §6). 원형 뽑기가 (시드, 선수 id, 자리, 나이대)를 타므로, 이 둘이
   * 없으면 은퇴한 사람이 다른 목소리로 돌아온다.
   */
  birthdate: DateString,
  position: z.string().min(1),
  /** 마지막 셔츠 */
  teamId: z.string().min(1),
  /** 그만둔 날 — 전환이 집행하는 날(다음 시즌 프리시즌 첫날) */
  on: DateString,
  /** 마지막으로 뛴 시즌 */
  season: z.number().int().min(1),
  reason: RetirementReasonSchema,
});

export type RetiredPlayer = z.infer<typeof RetiredPlayerSchema>;

// ── 유스 인테이크 ─────────────────────────────────────
/**
 * **여름의 유스 후보** — 아직 계약하지 않은 아카데미 자원 한 줄 (season.md §6).
 *
 * 다른 기록 테이블과 결이 하나 다르다: **아직 세계에 없는 사람을 담는다.** 계약 전이라
 * `state.players`에 넣을 수 없고(주급·명단·경기가 전부 따라붙는다), 그렇다고 뽑기만
 * 남기고 필요할 때 다시 뽑으면 감독이 어제 본 아이가 오늘 다른 아이가 된다 — 그 사이에
 * id·이름의 선점 집합이 움직이기 때문이다. 그래서 사람을 통째로 들고 있다가, 계약이
 * 서는 자리에서 그대로 `state.players`로 옮긴다.
 *
 * ⚠️ **감독 팀의 후보만 담는다** — AI 구단은 전환이 그 자리에서 결정한다.
 */
export const YouthCandidateSchema = z.object({
  /** 계약하면 그대로 명단에 서는 사람 — 후보 줄이 곧 그 선수다 */
  player: GamePlayerSchema,
  teamId: z.string().min(1),
  /** 후보가 선 날 — 프리시즌 첫날(전환일) */
  on: DateString,
  /** 감독의 답을 기다리는 마지막 날 — 선수단 소집일 (`squadReturnOf`) */
  deadline: DateString,
  /**
   * 첫 프로 계약의 조건 — **카드가 보이는 값과 계약이 서는 값이 같아야 한다.**
   * 계약 시점에 다시 계산하면 그 사이 주급 총액이 움직인 만큼 감독이 본 숫자와 갈린다.
   */
  weeklyWage: z.number().min(0),
  years: z.number().int().min(1),
  /**
   * 감독이 답하지 않으면 코어가 데려가는 자리인가 (season.md §6 「답하지 않으면」).
   * 포지션군이 비는 자리가 앞에 서므로, 방치해도 골문이 마르지 않는다.
   */
  autoSign: z.boolean(),
});

export type YouthCandidate = z.infer<typeof YouthCandidateSchema>;
