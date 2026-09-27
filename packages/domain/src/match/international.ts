import { z } from "zod";
import { DateString } from "../common/date-string";

// ── A매치 소집 ────────────────────────────────────────
/**
 * **복귀 상태** — 휴식기가 그 선수의 몸에 남긴 것
 * (→ docs/match/competition.md §5-1). 문장이 아니라 코드다: 「지쳐서 돌아왔다」를
 * 어떻게 말할지는 화면과 GM이 쓴다.
 */
export const CallUpReturnStateSchema = z.enum(["fit", "tired", "injured"]);

export type CallUpReturnState = z.infer<typeof CallUpReturnStateSchema>;

/**
 * **A매치 소집 한 건** — 한 선수의 한 휴식기 (→ docs/match/competition.md §5-1).
 *
 * A매치는 굴리지 않는다. 세계가 그 경기를 관측할 이유가 없어서다 — 남는 것은
 * 출전·골 두 수와 돌아온 몸이고, 그 둘은 `(시드, 선수, 휴식기)` 채널의 결정적
 * 추첨으로 충분하다.
 *
 * ⚠️ **통산 캡·골은 여기서 파생하지 않는다** — 이 표는 최근 두 시즌만 남으므로
 * 합치면 통산이 세 시즌 뒤에 사라진다. 통산은 `PlayerState.caps`가 갖는다.
 *
 * 정산이 끝나면 **감독 팀 행만 남는다** — 남의 선수의 캡·골은 이미 그 선수 위로
 * 접혀 들어갔고, 소집 중이 아닌 남의 행을 읽는 자리가 없다.
 */
export const CallUpSchema = z.object({
  gamePlayerId: z.string().min(1),
  /** 그를 데려간 협회 — FIFA 3자 코드 (`nationality.ts`) */
  country: z.string().min(1),
  /**
   * 휴식기 키 — `<시즌>:<MMDD>`. 날짜가 아니라 키인 이유는 **한 선수에 한 휴식기
   * 한 행**이라는 계약을 이 값 하나로 지키기 위해서다. 창의 날짜는 시즌에서
   * 파생하므로(`internationalBreaksOf`) 함께 적지 않는다.
   */
  breakKey: z.string().min(1),
  /** 그 창에서 뛴 A매치 수와 골 — 추첨의 결과이자 이 행이 남기는 사실 */
  apps: z.number().int().min(0),
  goals: z.number().int().min(0),
  /**
   * 정산이 끝난 날 — **`null`이면 아직 소집 중**이다(부상 행과 같은 규약).
   * 클럽이 그를 쓸 수 없는 기간이 곧 이 칸이 열려 있는 기간이다.
   */
  returnedOn: DateString.nullable(),
  /** 돌아온 몸 — 정산이 채운다 */
  returnState: CallUpReturnStateSchema.optional(),
  /** 이 소집이 그의 A매치 데뷔인가 — 소집 시점의 통산 캡이 0이었다 */
  debut: z.boolean().optional(),
});

export type CallUp = z.infer<typeof CallUpSchema>;
