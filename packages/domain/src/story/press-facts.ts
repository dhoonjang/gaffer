import type { ReactionAxis } from "../common/social-ledger";
import { z } from "zod";
import { DateString } from "../common/date-string";

import { josaOf } from "../common/josa";
import { formatMoney } from "../common/money";
import { associationName } from "../common/nationality";
import {
  ApproachChannelSchema,
  LEADER_ROLE_LABEL,
  LeaderRoleSchema,
  type ApproachChannel,
} from "../common/persona";
import { awardDetail, awardTitle } from "../common/player-awards";
import { boardExpectationText, type BoardExpectationCode } from "../common/manager-career";
import { INCIDENT_KIND_KO, type IncidentKind } from "./narrative";
import { PROMISE_KIND_KO, type PromiseKind } from "../common/player-promises";
import { milestonePhrase, type MilestoneCode } from "../common/player-statistics";
import { PLAYER_ISSUE_REASONS, type PlayerIssueReason } from "../common/player-issues";
import { SQUAD_STATUS_KO, type SquadStatus } from "../common/squad-rules";

/**
 * 기자회견 (PRESS_CONFERENCE) — 세계가 감독에게 **대답을 요구하는 자리**.
 *
 * 감독의 다른 손잡이(훈련·전술·명단)는 전부 감독이 먼저 손을 뻗는 것이지만,
 * 회견은 **세계가 먼저 부른다.** 그래서 게임에서 하는 일이 다르다: 감독이 아무것도
 * 하지 않아도 사건이 생기고, 답하지 않는 것조차 하나의 답이 된다.
 *
 * ## 왜 상태에 남기나
 *
 * 회견은 "열렸다 → 감독이 답했거나 거절했다"라는 **두 시점 사이에 걸쳐 있다.**
 * 채팅 한 턴 안에서 끝나지 않으므로(감독이 다음 날 답할 수도 있다) 세이브가
 * 들고 있어야 한다.
 */

/** 무엇이 이 회견을 불렀나 — 질문의 결이 여기서 갈린다 */
export const PressTriggerSchema = z.enum([
  /** 경기 뒤 — 매 경기 붙는다 (실제 리그의 의무 회견) */
  "match",
  /** 연패·부진 등 감독 자리가 흔들릴 때 */
  "pressure",
  /** 시즌 개막 전야 — 우리 첫 리그 경기 전날 */
  "opening",
  /** 더비 전야 — 더비 표의 대진 전날 */
  "derby",
  /** 마지막 홈경기 전야 — 은퇴 예고가 선 선수가 있을 때 (season.md §6) */
  "farewell",
  /**
   * **부임한 날** — 새 게임의 첫날 (career.md §1).
   */
  "appointment",
  /**
   * **그 시즌 우리 마지막 리그 경기 뒤** — 경기 뒤 회견이 갈린 것이다 (people.md §4).
   * 결과도 마일스톤도 평소처럼 서고, 그 위에 최종 순위와 보드 기대가 얹힌다.
   */
  "season-end",
]);
export type PressTrigger = z.infer<typeof PressTriggerSchema>;

/** 무엇에 대한 사실인가 — 기자가 그걸 어떻게 묻는지는 기자의 몫이다 */
export const PressFactKindSchema = z.enum([
  /** 방금 치른 경기의 결과 · 최근 폼 · 더비 전적 (`tags[0]`이 가른다) */
  "result",
  /** 최근 무승 */
  "winless",
  /** 폼이 바닥인 선수 */
  "slump",
  /** 라커룸에 불만이 쌓인 선수 */
  "unhappy",
  /** 출전 기회 — 시즌 출전 수와 선발 수 (다가옴 · people.md §8) */
  "minutes",
  /** 2군에 내려간 채 흐른 날 */
  "demoted",
  /** 라커룸의 온도 — 1군 평균 폼 */
  "morale",
  /** 리그에서 지금 서 있는 자리와 보드가 건 자리 */
  "standing",
  /** 전야 회견의 대진 — 상대와 날짜 (개막·더비) */
  "fixture",
  /** 언론 유출 — 방치된 불만이 신문에 실렸다 (people.md §8 계단 4) */
  "leak",
  /** 방금 끝난 경기가 세운 기록 — 데뷔·첫 골·구단 통산 문턱·해트트릭 (match.md §6) */
  "milestone",
  /**
   * **시즌 시상** — 지금 우리 선수단에 있는 사람이 **가장 최근에 매겨진 시즌**에 받은 상
   * (season.md §6 「상이 사실로 서는 자리」 · people.md §4). `tags[0]`이 상 코드,
   * `tags[1]`이 그 대회의 이름, `values`가 시즌과 근거 수치(`awardDetail`이 읽는 칸)다.
   *
   * 어느 셔츠로 받았는지는 묻지 않는다 — 지난 시즌 남의 리그 득점왕을 여름에 데려온
   * 것이야말로 개막 전야에 설 사실이다.
   */
  "award",
  /** 이번 시즌 뒤 은퇴 — 1월에 선 예고 (season.md §6) */
  "retirement",
  /**
   * **대표팀 소집** — 휴식기가 남긴 사실 (competition.md §5-1). `tags[0]`이 갈래를
   * 가른다: 소집(`named`) · A매치 데뷔(`debut`) · 낙마(`dropped`) · 복귀(`returned`).
   * `tags[1]`이 협회 코드, `returned`의 `tags[2]`가 돌아온 몸의 코드다.
   */
  "call-up",
  /** 그 시즌 마지막 홈경기 — 전야는 대진, 경기 뒤는 그가 뛰었는가 (season.md §6) */
  "farewell",
  /**
   * **상징 번호가 비었다** — 은퇴·계약 만료로 1·7·9·10·11 중 하나가 주인을 잃었고,
   * 원형이 그것을 원하는 선수가 있다 (player.md §1.1 · people.md §6·§7).
   * `about`이 원하는 선수, `name`이 앞서 그 번호를 달던 사람이다.
   */
  "number-open",
  /**
   * **번호를 물려받았다** — 계보가 있는 번호를 감독이 누군가에게 줬다.
   * `about`이 받은 선수, `name`이 앞서 달던 사람, `since`가 몇 시즌 만인가다.
   */
  "number-inherited",
  /**
   * **감독 통산의 문턱** — 경기·승이 눈금을 넘은 그 경기의 회견에 선다
   * (career.md §6). `tags[0]`이 `matches`인지 `wins`인지, `values.value`가 그 눈금이다.
   */
  "manager-milestone",
  /**
   * **감독 자신의 거취** — 계약 만료 90일 안의 회견마다 선다 (career.md §5.4).
   * `tags[0]`이 보드의 판정 코드, `values.days`가 만료까지 남은 일수다.
   */
  "manager-contract",
  /**
   * **감독이 말로 만든 공개된 사건** — 징계·공개 칭찬·공개 질책 (people.md §6
   * 「사건 기록」). `tags[0]`이 갈래(`IncidentKind`), `about`이 당사자, `values.intensity`가
   * 세기, `values.days`가 며칠 전인가다.
   */
  "incident",
  /**
   * **이 선수단의 중심** — 부임 회견이 짚는 1군 최고 자원 (people.md §4).
   * 감독이 처음 이름을 부를 수 있는 자리라 `about`이 걸린다.
   */
  "key-player",
  /**
   * **지난 시즌의 보드 평가** — 최종 순위·그 시즌의 기대와 갈래·달성 여부
   * (시즌 리뷰 면담 — career.md §5). `tags[0]`이 등급, `tags[1]`이 기대의 갈래다.
   */
  "season-verdict",
  "board",

  /**
   * **상대 감독의 말** — 이번 대진의 반대편 벤치가 마이크 앞에서 무슨 결로 말했나
   * (people.md §4). `tags[0]`이 결 코드(`RIVAL_VOICES`), `name`이 그 감독이자
   * 인물 사전의 `characterId`, `refId`가 상대 구단이다.
   *
   * 카드가 드는 것은 **이름과 결 하나뿐이다** — 대사를 코어에 박으면 그 사람이
   * 시즌 내내 같은 말을 한다 (overview.md §1 철칙 4).
   */
  "rival-quote",
]);
/**
 * 회견의 재료 — **사실 한 줄.** 질문이 아니다.
 *
 * ⚠️ 코어가 질문 문장을 박아 두면 세 가지를 잃는다: ① 시즌 내내 같은 말이 반복되고
 * ② 화자의 성격이 문장에 닿지 못하며 ③ 맥락(더비인가, 감독이 어제 뭐라 했나)이
 * 반영되지 않는다. 코어가 지켜야 할 것은 **사실**이지 문장이 아니다 —
 * 무엇이 사실인지는 코어가 정하고, 그것을 어떻게 묻는지는 기자가 정한다
 * (→ docs/story/people.md §1).
 *
 * `about`이 있으면 **그 선수에 대한 사실**이다 — 감독의 답이 그 선수의 사기에
 * 직접 닿는다. 공개적으로 감쌀 수도, 공개적으로 자를 수도 있는 자리다.
 */
/**
 * 사실 카드가 드는 **수치** — 갈래(`kind`)마다 채우는 칸이 다르다.
 *
 * 한 줄의 한국어는 이 카드를 읽는 쪽이 만든다. 문장을 세이브에 적어 두면 문구를
 * 고쳐도 지난 회견은 옛 말로 남고, 기자의 성격도 그날의 맥락도 그 문장에 닿지
 * 못한다 (→ docs/story/people.md §4).
 */
export const PressFactDataSchema = z.object({
  text: z.string().max(600).optional(),
  /** 이 사실이 함께 가리키는 대상 — 상대 팀·자리가 겹치는 선수 (id) */
  refId: z.string().min(1).optional(),
  /** 그때의 이름 — 카탈로그가 이름을 고쳐도 그 줄이 말한 상대는 그 사람이다 */
  name: z.string().min(1).optional(),
  /** 라벨 붙은 수치 — `{ for: 1, against: 3 }` · `{ days: 32 }` · `{ rank: 14, target: 7 }` */
  values: z.record(z.string(), z.number()).optional(),
  /**
   * 갈래 안의 갈래 — **`tags[0]`이 그 갈래의 하위 코드다.** 한 `kind`가 여러 모양의
   * 사실을 담는 자리(경기 결과와 최근 폼, 더비 전적)를 그것으로
   * 가른다. 나머지 칸은 그 하위 코드가 정한다: 승/무/패 · 홈/원정 · 불만 사유 ·
   * 포지션 코드 · 폼 라벨.
   */
  tags: z.array(z.string().min(1)).optional(),
  /** 그 사실이 가리키는 날 — 보드 요청의 기한처럼 수치가 아닌 날짜 */
  date: DateString.optional(),
});
export type PressFactData = z.infer<typeof PressFactDataSchema>;

export const PressFactSchema = z.object({
  kind: PressFactKindSchema,
  /** 그 갈래의 수치 — 문장은 읽는 쪽이 만든다 (`pressFactText`) */
  data: PressFactDataSchema,
  /** 이 사실이 걸린 선수 (`GAME_PLAYER.id`) — 없으면 팀·감독에 대한 사실 */
  about: z.string().nullable(),
  /** 날 선 자리인가 — 답변의 파장(한도)을 키운다 */
  sharp: z.boolean(),
});
export type PressFact = z.infer<typeof PressFactSchema>;

/**
 * 자리의 끝 — 답했나(`answered`), 거절·방치했나(`declined`), 아니면 **자리 자체가
 * 사라졌나**(`expired`). 만료는 감독의 선택이 아니라 세계의 사정이라 대가가 없다
 * (people.md §4).
 */
export const PressStatusSchema = z.enum(["pending", "answered", "declined", "expired"]);

export const PressConferenceSchema = z.object({
  id: z.string().min(1),
  /** 열린 날 */
  date: z.string(),
  trigger: PressTriggerSchema,
  /** 한 줄 배경 — "3연패 뒤" 같은 맥락. 사실을 읽는 데 필요한 최소한만 */
  context: z.string(),
  /** 기자가 물을 수 있는 것의 **전부** — 이 밖의 사실은 세계에 없다 */
  facts: z.array(PressFactSchema).min(1),
  /**
   * 이 자리를 여는 기자 (`Persona.characterId`).
   *
   * **세계가 먼저 여는 자리는 키워드를 기다리지 않는다.** 회견은 감독이 기자
   * 이름을 말해서 열리는 게 아니라 세계가 부르는 것이므로, 그 기자의 인물지가
   * 실릴 근거도 감독의 말이 아니라 **코어가 지목한 사실**이어야 한다
   * (overview.md §1 철칙 4 — 코어는 사실만 낸다).
   */
  reporterId: z.string().min(1),
  status: PressStatusSchema,
  /**
   * 이 자리가 얼마나 큰가 (1~3). 실제로 파장이 다르다 — 평범한 주중 경기 뒤
   * 회견과 더비 참패 뒤 회견에 같은 무게를 주면 둘 다 의미를 잃는다.
   * 효과 한도가 이 값에 비례한다.
   */
  weight: z.number().int().min(1).max(3),
});
export type PressConference = z.infer<typeof PressConferenceSchema>;

/**
 * 무엇 때문에 오는가 — **선수 채널의 주제는 라커룸 불만의 사유 코드 그대로다**
 * (`PLAYER_ISSUE_REASONS`). 사유가 하나 늘면 다가옴의 주제도 함께 는다: 같은 사실을
 * 두 개의 이름으로 부르면 어느 쪽이 진짜인지 코드가 매번 다시 정해야 한다.
 */
export const APPROACH_TOPICS = [
  ...PLAYER_ISSUE_REASONS,
  /** 라커룸이 식었다 — 주장이 대신 온다 */
  "morale",
  /**
   * **시즌이 끝났다** — 구단주가 지난 시즌의 평가를 들고 마주 앉는다 (career.md §5
   * 「시즌 리뷰 면담」). 압력이 아니라 **달력이 여는** 유일한 주제라 눈금도 계단도
   * 타지 않는다 (people.md §8).
   */
  "season-review",
] as const;
export const ApproachTopicSchema = z.enum(APPROACH_TOPICS);
export type ApproachTopic = z.infer<typeof ApproachTopicSchema>;

/**
 * 열린 자리가 답을 기다리는 날 — 이 뒤엔 감독이 지나친 것으로 닫힌다 (people.md §8).
 *
 * 압력이 여는 자리(`story/world/approach.ts`)가 읽는 값이다.
 */
export const APPROACH_PATIENCE_DAYS = 3;

/**
 * 불만 사유 그대로인 주제인가 — **유출 계단이 서는 자격이다.**
 *
 * 유출은 「방치된 불만」이 있어야 서는 사건이라, 불만이 없는 주제(`morale`)는
 * 거기까지 오를 것이 없다 (people.md §8).
 */
export function isIssueTopic(topic: ApproachTopic): topic is PlayerIssueReason {
  return (PLAYER_ISSUE_REASONS as readonly string[]).includes(topic);
}

/**
 * 다가옴의 **한 줄 배경** — 코드와 수치. 문장은 읽는 쪽이 만든다
 * (→ docs/story/people.md §8).
 */
export const ApproachContextSchema = z.object({
  code: z.enum([
    /** 방치된 불만 — `reason`이 그 사유, `days`가 그 기간 */
    "grievance",
    /** 라커룸의 온도 — 1군 평균 폼 */
    "dressing-room-form",
    /** 리그에서 서 있는 자리와 보드가 건 자리 */
    "standing",
    /**
     * 시즌 리뷰 면담 — `value`가 지난 시즌 최종 순위, `limit`이 그 시즌의 기대 순위다
     * (career.md §5). 시즌 번호는 사실 카드가 든다.
     */
    "season-review",
  ]),
  /** 불만의 사유 코드 (`PLAYER_ISSUE_REASONS`) — 있는 갈래에만 */
  reason: z.enum(PLAYER_ISSUE_REASONS).optional(),
  /** 그 코드가 가리키는 값 — 기간(일)·평균 폼·현재 순위 */
  value: z.number().optional(),
  /** 그 값이 견주는 자리 — 보드가 건 순위 */
  limit: z.number().optional(),
  /**
   * 이 자리를 연 사람이 라커룸에서 선 자리 — 같은 불만이라도 주장이 들고 온 것과
   * 후보 선수가 들고 온 것은 다른 자리다 (people.md §5-1). 리더 그룹 밖의 사람이면 없다.
   */
  leader: LeaderRoleSchema.optional(),
});
export type ApproachContext = z.infer<typeof ApproachContextSchema>;

export const ApproachSchema = z.object({
  id: z.string().min(1),
  /** 열린 날 */
  date: DateString,
  channel: ApproachChannelSchema,
  topic: ApproachTopicSchema,
  /**
   * 말을 거는 사람 (`Persona.characterId`). 선수·주장은 그 선수의 이름이고
   * 구단주는 구단주의 이름이다 — 회견의 `reporterId`와 같은 자리로 인물 사전에
   * 실린다(people.md §6). **세계가 먼저 여는 자리는 감독이 이름을 부르기를
   * 기다리지 않는다.**
   */
  speakerId: z.string().min(1),
  /** 이 자리가 걸린 선수 — 팀·구단에 대한 자리면 없다 */
  about: z.string().nullable(),
  /** 한 줄 배경의 카드 — 문장은 읽는 쪽이 만든다 (`approachContextText`) */
  contextCard: ApproachContextSchema,
  /** 그 사람이 아는 것의 **전부** — 이 밖의 사실은 이 자리에 없다 */
  facts: z.array(PressFactSchema).min(1),
  status: PressStatusSchema,
});
export type Approach = z.infer<typeof ApproachSchema>;

/**
 * 언론 유출 — **사다리 계단 4의 사건** (people.md §8). 방치된 불만이 신문에
 * 흘러나왔고, **다음 회견이 실어 갈 때까지만** 여기 남는다 — 회견은 두 시점에
 * 걸쳐 있어 세이브가 들지만, 유출은 소비되는 순간 카드가 되어 회견으로 옮겨
 * 간다.
 */
export const PressLeakSchema = z.object({
  /** 불만의 주인 (`GAME_PLAYER.id`) — 유출은 선수 주제에만 있다 */
  playerId: z.string().min(1),
  topic: ApproachTopicSchema,
  /** 흘러나온 날 */
  date: DateString,
});
export type PressLeak = z.infer<typeof PressLeakSchema>;

/**
 * 상대 감독이 마이크 앞에서 내는 **결** — 원형이 정하고(people.md §2 표) 카드의
 * `tags[0]`에 실린다. 문장이 아니라 코드다: 인용은 그 사람의 말투로 GM이 쓴다.
 */
export const RIVAL_VOICES = ["provoke", "respect", "analysis", "patience", "defensive"] as const;
export type RivalVoice = (typeof RIVAL_VOICES)[number];

/**
 * 그 결의 **한국어 이름** — 카드 한 줄이 되는 자리가 여기 하나다 (people.md §4).
 * 평가어도 물음표도 없다: 그가 무엇을 말했는가라는 사실이다.
 */
export const RIVAL_VOICE_KO: Record<RivalVoice, string> = {
  provoke: "우리를 찌르는 말을 했다",
  respect: "우리를 높이는 말을 했다",
  analysis: "경기를 뜯어 말했다",
  patience: "자기 팀의 긴 시야를 말했다",
  defensive: "지키는 축구를 말했다",
};

export const APPROACH_AXES: Record<ApproachChannel, readonly ReactionAxis[]> = {
  player: ["squad", "target", "team"],
  captain: ["squad", "team"],
  owner: ["board"],
};

// ── 카드에서 문장으로 ──────────────────────────────────────────

/**
 * 불만 사유의 **한국어 이름** — 문장이 아니라 이름이다 (people.md §5).
 *
 * 회견 카드·다가옴 배경·심경 사실이 같은 표를 읽는다. 사유를 자리마다 옮겨 적으면
 * 같은 불만이 화면에서 두 이름으로 선다.
 */
export const ISSUE_REASON_KO: Record<PlayerIssueReason, string> = {
  minutes: "출전 기회",
  "losing-run": "연패",
  "early-return": "휴가 반납 소집",
  demotion: "2군 강등",
  "out-of-position": "자리 밖 기용",
  promise: "어긴 약속",
  number: "등번호",
  overload: "과부하",
};

/** 사유 이름 — 수치가 이름을 대신하는 것은 넷뿐이다. 코드가 없으면 `null` */
export function issueReasonKo(
  reason: PlayerIssueReason | null | undefined,
  count?: number | null,
): string | null {
  if (!reason) return null;
  if (count != null) {
    if (reason === "losing-run") return `${count}연패`;
    if (reason === "out-of-position") return `${count}경기 자리 밖`;
    // 등번호 불만은 **어느 번호를 잃었나**가 곧 사유다 — "등번호 불만"으로는 그 자리가 서지 않는다
    if (reason === "number") return `${count}번을 잃었다`;
    // 과부하는 **며칠째인가**가 사유의 무게다 (player.md §5.5)
    if (reason === "overload") return `${count}일째 과부하`;
  }
  return ISSUE_REASON_KO[reason];
}

const OUTCOME_KO: Record<string, string> = { win: "승", draw: "무", loss: "패" };
const SIDE_KO: Record<string, string> = { home: "홈", away: "원정" };

/** 감독이 그 구단을 떠난 갈래 — `Dismissal.kind` 그대로 (career.md §5.1) */
export const MANAGER_EXIT_KO: Record<string, string> = {
  sacked: "경질",
  expired: "계약 만료",
};

/**
 * 돌아온 몸 — `CallUpReturnState`의 한국어 이름 (competition.md §5-1). 장부가 드는
 * 것은 코드뿐이고, 「지쳐서 돌아왔다」는 이 표 하나에서만 문장이 된다.
 */
const CALL_UP_RETURN_KO: Record<string, string> = {
  fit: "몸에 이상 없다",
  tired: "지쳐서 돌아왔다",
  injured: "다쳐서 돌아왔다",
};

/**
 * 사실 카드 한 줄 — **화면·GM·테스트가 같은 함수를 부른다** (people.md §4).
 *
 * 코어가 세이브에 적는 것은 카드뿐이라, 문구를 고치면 지난 회견의 줄까지 함께
 * 고쳐진다.
 */
export function pressFactText(fact: PressFact): string {
  const d = fact.data;
  const v = d.values ?? {};
  const tags = d.tags ?? [];
  const sub = tags[0];
  const name = d.name ?? "";
  const reason = issueReasonKo((tags[1] ?? null) as PlayerIssueReason | null) ?? "사유 불명";
  switch (fact.kind) {
    case "result":
      // 더비 전적 — 이번 경기는 세지 않았다 (people.md §4). 첫 더비면 0승 0무 0패다
      if (sub === "derby") {
        return `${tags[1] ?? "더비"} — 그 전까지 ${v.won ?? 0}승 ${v.drawn ?? 0}무 ${v.lost ?? 0}패`;
      }
      return sub === "recent"
        ? `최근 ${v.matches ?? 0}경기 ${tags
            .slice(1)
            .map((t) => OUTCOME_KO[t] ?? t)
            .join("")}`
        : `${name}전 ${v.for ?? 0}-${v.against ?? 0} ${outcomeWord(tags[1])} (${SIDE_KO[tags[2] ?? "home"] ?? ""})`;
    case "winless":
      return `최근 ${v.matches ?? 0}경기 무승 (${tags.map((t) => OUTCOME_KO[t] ?? t).join("")})`;
    case "slump":
      return name ? `${name} 폼 ${sub ?? ""}` : `폼 ${sub ?? ""}`;
    case "incident":
      return (
        `${name ? `${name} ` : ""}${INCIDENT_KIND_KO[sub as IncidentKind] ?? sub ?? "사건"}` +
        ` · 세기 ${v.intensity ?? 2}` +
        (v.days === undefined ? "" : v.days === 0 ? " · 오늘" : ` · ${v.days}일 전`)
      );
    case "unhappy":
      if (sub === "count") return `라커룸 불만 ${v.count ?? 0}건`;
      if (sub === "grievance") {
        /**
         * 어긴 약속은 **감독 자신이 세운 원인**이라, 사유 이름만으로는 그 자리가
         * 서지 않는다 (people.md §5-2) — 무엇을 약속했고 그것이 며칠 전이었나까지가
         * 그 선수가 아는 사실이다. `tags[2]`가 갈래 코드, `promised`가 약속한 날부터
         * 오늘까지의 일수다. 다른 사유의 카드에는 둘 다 없다.
         */
        const kind = tags[2] as PromiseKind | undefined;
        return (
          `${reason} 불만 ${v.days ?? 0}일째` +
          (kind ? ` · ${PROMISE_KIND_KO[kind] ?? kind} 약속` : "") +
          (v.promised === undefined ? "" : ` · ${v.promised}일 전의 약속`)
        );
      }
      return `${name} 라커룸 불만 (${reason})`;
    case "minutes":
      /**
       * 지위와 창의 수치가 함께 선다 (people.md §5·§5-2). 이것이 없으면 "출전 기회
       * 불만"이 어느 기대에 대해 모자란 것인지가 서지 않아, 백업의 침묵과 핵심의
       * 불만을 읽는 쪽이 가르지 못한다.
       *
       * 창의 출전 수(`windowApps`)는 선발 수 **옆에** 선다 — 「선발 0 · 출전 1」과
       * 「선발 0 · 출전 0」은 읽는 쪽이 다른 말을 해야 하는 두 사실이다. 시즌
       * 누계(`apps`)와 이름이 갈리는 것도 그래서다.
       */
      return (
        `출전 기회 불만 ${v.days ?? 0}일째 · 시즌 출전 ${v.apps ?? 0}경기` +
        (sub ? ` · ${SQUAD_STATUS_KO[sub as SquadStatus] ?? sub} 지위` : "") +
        ` · 최근 ${v.played ?? 0}경기 선발 ${v.starts ?? 0}회 · 출전 ${v.windowApps ?? 0}회`
      );
    case "demoted":
      return `2군 ${v.days ?? 0}일째 · 불만 ${v.issueDays ?? 0}일째`;
    case "morale":
      // 리더 그룹의 폼은 있을 때만 — 라커룸이 통째로 식은 것과 리더들만 처진 것은
      // 감독이 손댈 자리가 다르다 (people.md §5-1)
      return `1군 평균 폼 ${sub ?? ""}` + (tags[1] ? ` · 리더 그룹 ${tags[1]}` : "");
    case "standing":
      if (sub === "board-target") {
        /**
         * 갈래가 바뀐 시즌에는 **옛 기대가 함께 선다** (career.md §5 「시즌 리뷰 면담」) —
         * 승격·강등으로 체급이 옮겨 간 것을 모르면 구단주가 그 변화를 말할 근거가 없다.
         * 안 바뀐 시즌의 카드에는 `tags[2]`도 `previous`도 없다.
         */
        const before =
          tags[2] === undefined
            ? ""
            : ` (지난 시즌 ${boardExpectationText(tags[2] as BoardExpectationCode, v.previous)})`;
        return (
          `보드 기대 ${v.rank ?? 0}위 (${boardExpectationText((tags[1] ?? "mid") as BoardExpectationCode)})` +
          before
        );
      }
      if (sub === "warnings") return `보드 경고 ${v.count ?? 0}/${v.limit ?? 3}`;
      /**
       * **언론이 매긴 예상** — 보드 기대와 같은 갈래의 카드다 (people.md §4-1).
       * 구단주가 거는 목표와 언론이 매기는 순위는 다른 사실이고, 둘이 갈릴 때가
       * 기자가 물을 자리다.
       */
      if (sub === "media-prediction") {
        return `언론 예상 ${v.rank ?? 0}위/${v.teams ?? 0}팀`;
      }
      if (sub === "versus") return `리그 ${v.rank ?? 0}위 · ${name} ${v.opponentRank ?? 0}위`;
      return `리그 ${v.rank ?? 0}위 · ${v.played ?? 0}경기`;
    case "fixture":
      return sub === "derby"
        ? `${tags[1] ?? "더비"} — ${name}전 (${SIDE_KO[tags[2] ?? "home"] ?? ""})`
        : `개막전 ${name} (${SIDE_KO[tags[1] ?? "home"] ?? ""})`;
    case "leak":
      return `${name}의 ${reasonOf(tags[0])} 불만이 언론에 보도됐다`;
    case "season-verdict":
      return `시즌 ${v.season ?? 0} 최종 ${v.rank ?? 0}위`;
    case "board":
      return d.text ?? "";
    case "milestone":
      return `${name} ${milestonePhrase((sub ?? "apps") as MilestoneCode, v.value ?? 1)}`;
    case "award": {
      /**
       * 근거 수치의 조각은 **시즌 다이제스트가 쓰는 그 하나**다(`awardDetail`) — 카드가
       * 제 문구를 쓰면 같은 상이 결산 화면과 회견에서 다른 말로 선다.
       *
       * 이름은 **있을 때만** 앞에 선다: 다가옴의 카드는 `about`이 이미 그 사람이라
       * 이름을 다시 부르면 한 줄에 같은 이름이 두 번 선다 (`call-up`과 같은 규약).
       */
      const who = name ? `${name} ` : "";
      const where = tags[1] ? `${tags[1]} ` : "";
      const detail = awardDetail({
        code: sub ?? "",
        apps: v.apps ?? 0,
        goals: v.goals ?? 0,
        assists: v.assists ?? 0,
        ...(v.rating === undefined ? {} : { rating: v.rating }),
        ...(v.age === undefined ? {} : { age: v.age }),
      });
      return `${who}시즌 ${v.season ?? 0} ${where}${awardTitle(sub ?? "")} — ${detail}`;
    }
    case "retirement":
      return (
        `${name} 이번 시즌 뒤 은퇴 — 만 ${v.age ?? 0}세` +
        ` · 우리 팀에서 ${v.apps ?? 0}경기 ${v.goals ?? 0}골` +
        (d.date ? ` · ${d.date} 예고` : "")
      );
    case "call-up": {
      /**
       * 코어가 아는 것은 **협회 코드와 그 창의 두 수, 돌아온 몸의 코드**뿐이다
       * (competition.md §5-1) — A매치를 굴리지 않으므로 장면도 상대도 없다.
       *
       * 이름은 **있을 때만** 앞에 선다: 근황 줄(people.md §7)은 선수 이름을 이미
       * 옆에 세우고 있어, 카드가 다시 부르면 같은 이름이 한 줄에 두 번 선다.
       */
      const who = name ? `${name} ` : "";
      const assoc = associationName(tags[1] ?? "");
      const caps = v.caps === undefined ? "" : ` — 통산 ${v.caps}캡`;
      const ours = v.count === undefined ? "" : ` · 이번 휴식기 우리 선수 ${v.count}명`;
      if (sub === "debut") return `${who}${assoc} A매치 데뷔${ours}`;
      if (sub === "dropped") return `${who}${assoc} 소집 제외${caps}${ours}`;
      if (sub === "returned") {
        // 팀의 줄은 인원이 주어이고(`count`), 한 사람의 줄은 그의 협회와 몸이 주어다
        if (v.count !== undefined) {
          return (
            `대표팀 복귀 ${v.count}명 — ${v.apps ?? 0}경기 ${v.goals ?? 0}골` +
            ` · 지쳐·다쳐 돌아온 선수 ${v.tired ?? 0}명`
          );
        }
        return (
          `${who}${assoc} 복귀 — ${v.apps ?? 0}경기 ${v.goals ?? 0}골` +
          ` · ${CALL_UP_RETURN_KO[tags[2] ?? "fit"] ?? ""}`
        );
      }
      return (
        `${who}${assoc} 소집${caps}` + (v.days === undefined ? "" : ` · 복귀 D-${v.days}`) + ours
      );
    }
    case "farewell":
      /**
       * 전야에는 날짜만, 경기 뒤에는 **그가 뛰었는가**가 선다 (people.md §4). 대진은
       * 회견의 국면 줄이 이미 말하므로 카드가 다시 들지 않는다. 세우고 안 세우고는
       * 감독의 결정이라, 코어가 적는 것은 그 결정의 결과뿐이다.
       */
      if (sub === "played" || sub === "unused") {
        return `${name} 마지막 홈경기 — ${sub === "played" ? "출전" : "출전 없음"}`;
      }
      return `${name} 마지막 홈경기${d.date ? ` — ${d.date}` : ""}`;
    case "number-open":
      /**
       * 계보가 없는 공석은 **번호만** 말한다 (player.md §1.1) — 앞서 아무도 달지
       * 않은 번호에 "앞서 아무도"를 적으면 읽는 쪽이 그 없음을 사실로 옮겨 적는다.
       */
      return `${v.number ?? 0}번 공석` + lineageTail(name, v.seasons, v.since);
    case "number-inherited":
      return `${v.number ?? 0}번을 물려받았다` + lineageTail(name, v.seasons, v.since);
    case "manager-milestone":
      // 눈금이 무엇을 세는가는 `tags[0]`이다 — 경기와 승은 같은 통산의 두 눈금이다
      return `감독 통산 ${v.value ?? 0}${sub === "wins" ? "승" : "경기"}`;
    case "manager-contract":
      /**
       * 부임의 줄은 **새로 선 계약**이고, 나머지는 **끝을 향해 남은 날**이다
       * (career.md §5.4). 보드의 판정은 만료 90일 전에 한 번뿐이라, 그 판정 전과
       * 후가 같은 카드에서 코드로만 갈린다.
       */
      if (sub === "signed") {
        return `감독 계약 ${v.years ?? 0}년 · 연봉 ${formatMoney(v.salary ?? 0)}`;
      }
      return (
        `감독 계약 만료 D-${v.days ?? 0}` +
        (sub === "renewal"
          ? " · 보드가 재계약했다"
          : sub === "no-renewal"
            ? " · 보드가 재계약하지 않기로 했다"
            : " · 보드는 아직 말이 없다")
      );
    case "key-player":
      return (
        `1군 핵심 ${name}${sub ? ` (${sub})` : ""} · 만 ${v.age ?? 0}세` +
        (v.contractDays === undefined ? "" : ` · 계약 만료 D-${v.contractDays}`)
      );
    case "rival-quote":
      // 이름과 결 하나 — 카드가 아는 것이 그 둘뿐이다 (people.md §4)
      return `상대 감독 ${name} — ${RIVAL_VOICE_KO[(sub ?? "") as RivalVoice] ?? "마이크 앞에 섰다"}`;
  }
}

/**
 * 계보 꼬리 — **누가 몇 시즌, 몇 시즌 만인가.** 공석과 물려받음이 같은 표를 읽는다:
 * 두 벌을 두면 같은 계보가 근황에서와 회견에서 다른 말로 선다.
 */
function lineageTail(name: string, seasons: number | undefined, since: number | undefined): string {
  if (!name) return "";
  return (
    ` — 앞서 ${name}${seasons === undefined ? "" : `${josaOf(name, "이/가")} ${seasons}시즌`}` +
    (since === undefined ? "" : ` · ${since}시즌 만에`)
  );
}

function outcomeWord(tag: string | undefined): string {
  return tag === "win" ? "승리" : tag === "draw" ? "무승부" : "패배";
}

/** `tags[0]`이 사유 코드인 갈래 — 유출 */
function reasonOf(tag: string | undefined): string {
  return issueReasonKo((tag ?? null) as PlayerIssueReason | null) ?? "사유 불명";
}

/**
 * 다가옴의 배경 한 줄 — 카드에서 만든다 (people.md §8).
 *
 * `labels`는 코어만 아는 이름이다: 자리의 주인(선수 이름)과 폼 라벨. 카드에 이름을
 * 적어 두면 카탈로그가 이름을 고쳐도 옛 자리가 옛 이름으로 남고, 폼 눈금은 엔진의
 * 자라 도메인이 알 수 없다.
 */
export function approachContextText(
  context: ApproachContext,
  labels: { subject?: string; form?: string } = {},
): string {
  const who = labels.subject ?? "";
  const reason = issueReasonKo(context.reason ?? null) ?? "불만";
  /** 라커룸에서 선 자리 — 리더가 아닌 선수에겐 붙지 않는다 (people.md §5-1) */
  const seat = context.leader ? ` · ${LEADER_ROLE_LABEL[context.leader]}` : "";
  switch (context.code) {
    case "grievance":
      return `${who} · ${reason}${seat}`;
    case "dressing-room-form":
      return `라커룸 · 1군 평균 폼 ${labels.form ?? ""}`.trimEnd();
    case "standing":
      return `리그 ${context.value ?? 0}위 · 기대 ${context.limit ?? 0}위`;
    case "season-review":
      return `시즌 결산 · 최종 ${context.value ?? 0}위 · 기대 ${context.limit ?? 0}위`;
  }
}

// ── 언론 — 회견 밖의 기사 (people.md §4-1) ─────────────

/**
 * 회견 밖에서 언론이 쓴 것 — **감독이 답하지 않고 읽기만 하는 사실** (people.md §4-1).
 *
 * 회견(`PressFact`)은 세계가 감독에게 **묻는** 자리라 답이 장부를 옮기지만, 기사는
 * 세계가 감독에 **대해 쓰는** 것이라 아무것도 옮기지 않는다. 대신 이야기의 기준선을
 * 세운다 — 「예상 12위가 4위」는 그 예상이 세계 어딘가에 적혀 있어야 나오는 문장이다.
 */
export const MEDIA_FACT_KINDS = [
  /** 그해 예상 순위표가 나왔다 — 소집일 (season.md §2) */
  "prediction",
  /** 해설 한 사람의 중간 평가 — 우리 리그 5경기마다 */
  "pundit-verdict",
] as const;
export const MediaFactKindSchema = z.enum(MEDIA_FACT_KINDS);
export type MediaFactKind = z.infer<typeof MediaFactKindSchema>;

/**
 * 예상과 지금의 거리 — **등급 코드다.** 문장이 아니라 코드인 이유는 회견 카드와 같다:
 * 저장된 산문은 문구를 고쳐도 옛 말로 남고, 화자의 성격이 닿지 못한다 (people.md §4-1).
 */
export const MEDIA_VERDICTS = [
  "overachieving",
  "above",
  "on-track",
  "below",
  "underachieving",
] as const;
export const MediaVerdictSchema = z.enum(MEDIA_VERDICTS);
export type MediaVerdict = z.infer<typeof MediaVerdictSchema>;

/** 등급의 한국어 이름 — 평가어 없이 사실만 (people.md §4-1) */
export const MEDIA_VERDICT_KO: Record<MediaVerdict, string> = {
  overachieving: "예상을 크게 웃돈다",
  above: "예상 위",
  "on-track": "예상대로",
  below: "예상 아래",
  underachieving: "예상을 크게 밑돈다",
};

/**
 * 등급이 갈리는 계단 — **한두 계단은 아직 아무 뜻도 아니다** (people.md §4-1).
 * 1위 차이로 등급이 갈리면 매 다섯 경기 등급이 흔들려 평가가 잡음이 된다.
 */
const VERDICT_BIG_GAP = 5;
const VERDICT_GAP = 2;

/**
 * 예상 대비 등급 — `diff = 예상 순위 − 지금 순위` (양수면 예상보다 위).
 *
 * 펀딧의 중간 평가와 시즌 리뷰의 「예상 → 최종」이 **같은 자를 쓴다**: 두 벌을 두면
 * 5경기마다의 등급과 시즌 끝의 등급이 언젠가 갈린다 (AGENTS.md §5).
 */
export function mediaVerdictOf(diff: number): MediaVerdict {
  if (diff >= VERDICT_BIG_GAP) return "overachieving";
  if (diff >= VERDICT_GAP) return "above";
  if (diff <= -VERDICT_BIG_GAP) return "underachieving";
  if (diff <= -VERDICT_GAP) return "below";
  return "on-track";
}

/**
 * 기사 한 장 — **사실 한 줄.** 문장은 GM이 쓴다 (people.md §4-1).
 *
 * `data`가 회견 카드와 같은 모양(`PressFactData`)인 것은 재는 것이 같아서다:
 * 수치와 코드와 「그때의 이름」. 한 줄의 한국어는 `mediaFactText` 하나가 만든다.
 */
export const MediaFactSchema = z.object({
  kind: MediaFactKindSchema,
  /** 실린 날 */
  date: DateString,
  /**
   * 이름이 걸린 사람 (`Persona.characterId`) — 없으면 지면 전체의 사실이다.
   * 화자가 있는 기사는 회견의 기자처럼 그 턴 인물 사전에 지목된다 (people.md §6).
   */
  speakerId: z.string().min(1).optional(),
  data: PressFactDataSchema,
});
export type MediaFact = z.infer<typeof MediaFactSchema>;

/**
 * 기사 한 줄 — **화면·스냅샷·테스트가 같은 함수를 부른다** (people.md §4-1).
 * 물음표도 평가어도 없다: 무엇이 실렸는가라는 사실이다.
 */
export function mediaFactText(fact: MediaFact): string {
  const v = fact.data.values ?? {};
  const tags = fact.data.tags ?? [];
  const name = fact.data.name ?? "";
  switch (fact.kind) {
    case "prediction":
      return (
        `언론 시즌 예상 — 우리 ${v.rank ?? 0}위/${v.teams ?? 0}팀` +
        (name ? ` · 우승 후보 ${name}` : "")
      );
    case "pundit-verdict":
      // 이름이 문장 안에 선다 — 읽는 쪽이 화자를 따로 붙이면 같은 이름이 두 번 실린다
      return (
        `${name ? `${name}: ` : ""}예상 ${v.predicted ?? 0}위 · ` +
        `${v.played ?? 0}경기 뒤 ${v.position ?? 0}위 — ` +
        `${MEDIA_VERDICT_KO[(tags[0] ?? "on-track") as MediaVerdict]}`
      );
  }
}
