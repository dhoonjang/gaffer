"use client";

import type {
  Exhibit,
  FinanceExhibit,
  NegotiationExhibit,
  NegotiationExhibitTerms,
  PlayerExhibit,
  PlayerExhibitEntry,
} from "@gaffer/engine";
import { Fragment, type ReactNode } from "react";
import {
  AXIS_KO,
  SQUAD_STATUS_KO,
  formatMoney,
  formatRating,
  injuryHistoryBrief,
  physiqueLabel,
  type ExhibitTag,
  type PlayerCardType,
} from "@gaffer/domain";
import { PlayerName } from "@/shared/player-card";
import { GrowthOutlook } from "@/shared/growth-outlook";
import { AxisGrid } from "@/shared/player-facts";
import { contractLeft, contractSpan, humanDate, humanMonthYear } from "@/shared/dateline";

/**
 * ── 자료 카드 — 모델이 고른 자리에 코어가 채운 표 (prompts.md §1 「자료 카드」) ──
 *
 * 값은 그 턴에 저장된 장부다(`ChatTurn.exhibits`) — 지금 장부를 다시 읽지 않는다.
 * 읽는 값이라 누를 것은 선수 이름 손잡이뿐이고, 동의·서명 같은 조작은 확인 카드가 한다.
 * 몸은 「보여 준 자료」의 한 장이다 — 머리줄이 무엇의 자료인지 말한다 (shared/marks.css).
 */

/** 갈래의 이름 — 머리줄에 종류 다음으로 선다 */
const VIEW_KO: Record<PlayerCardType, string> = {
  overview: "개요",
  fitness: "몸 상태",
  stats: "이번 시즌 기록",
  contract: "계약",
  ability: "능력",
};

/** 스트리밍 중 아직 값이 없는 카드가 서는 자리 — 무엇이 올지만 말한다 */
const EXHIBIT_KO: Record<ExhibitTag, string> = {
  player_card: "선수",
  negotiation_card: "협상",
  finance_card: "재정",
};

/** 부호 있는 금액 — 음수 부호는 U+2212다 (tokens.css 「숫자와 표기」) */
const signedMoney = (amount: number) => `${amount < 0 ? "−" : "+"}${formatMoney(Math.abs(amount))}`;

/**
 * **정확도 꼬리표** — 이 카드의 능력 숫자를 얼마나 믿을지 (player.md §9.5).
 * 축마다 `±`를 세우지 않고 종합의 오차폭 하나로 말한다.
 */
function accuracyOf(p: PlayerExhibitEntry): { label: string; tone: "exact" | "seen" | "rumour" } {
  if (p.knowledge === "own") return { label: "정확", tone: "exact" };
  const margin = p.overallMargin > 0 ? ` ±${p.overallMargin}` : "";
  return p.knowledge === "seen"
    ? { label: `관측${margin}`, tone: "seen" }
    : { label: `평판${margin}`, tone: "rumour" };
}

function Accuracy({ player }: { player: PlayerExhibitEntry }) {
  const { label, tone } = accuracyOf(player);
  return (
    <span className="ex-acc" data-tone={tone}>
      {label}
    </span>
  );
}

function seasonLine(p: PlayerExhibitEntry): string | null {
  const s = p.season;
  if (s.apps === 0) return null;
  return [
    `${s.apps}경기`,
    ...(s.goals > 0 ? [`${s.goals}골`] : []),
    ...(s.assists > 0 ? [`${s.assists}도움`] : []),
    ...(s.rating !== null ? [`평점 ${formatRating(s.rating, "season")}`] : []),
  ].join(" · ");
}

function nowOut(p: PlayerExhibitEntry): string | null {
  if (p.injury)
    return `${p.injury.bodyPart} ${p.injury.severity} · ${humanDate(p.injury.expectedReturn, { weekday: false })} 복귀`;
  return p.suspended > 0 ? `출장 정지 ${p.suspended}경기` : null;
}

/**
 * 칸 하나 — 표에서는 열, 한 명짜리 카드에서는 사실 한 칸이다. 값이 없으면 null이고,
 * 표는 「—」로, 한 명짜리 카드는 그 칸을 세우지 않는다.
 */
interface Column {
  head: string;
  num?: boolean;
  /** 한 명짜리 카드에서는 머리줄이 이미 말한다 — 사실 줄에 다시 세우지 않는다 */
  inHead?: boolean;
  /** 한 명짜리 카드에만 선다 — 표의 폭을 넘기는 칸 */
  singleOnly?: boolean;
  tone?: (p: PlayerExhibitEntry) => "out" | undefined;
  /** `asOf` — 카드가 저장된 날. 남은 기간처럼 그날로부터 세는 칸이 읽는다 */
  cell: (p: PlayerExhibitEntry, asOf: string) => ReactNode | null;
}

const POSITION: Column = { head: "자리", inHead: true, cell: (p) => p.position };
const AGE: Column = { head: "나이", num: true, inHead: true, cell: (p) => p.age };
const OVERALL: Column = { head: "종합", num: true, inHead: true, cell: (p) => <b>{p.overall}</b> };
const ACCURACY: Column = { head: "정확도", inHead: true, cell: (p) => <Accuracy player={p} /> };
const WAGE: Column = {
  head: "주급",
  num: true,
  cell: (p) => (p.weeklyWage === null ? null : formatMoney(p.weeklyWage)),
};
const CONTRACT: Column = {
  head: "계약",
  cell: (p) => (p.contractUntil === null ? null : humanMonthYear(p.contractUntil)),
};
const GROWTH: Column = { head: "성장", cell: (p) => <GrowthOutlook growth={p.growth} /> };
const NOW: Column = { head: "지금", tone: (p) => (nowOut(p) ? "out" : undefined), cell: nowOut };

/** 카드 — 「경고 2 · 퇴장 1」. 받은 적이 없으면 서지 않는다 */
function bookingsOf(p: PlayerExhibitEntry): string | null {
  const parts = [
    ...(p.season.yellows > 0 ? [`경고 ${p.season.yellows}`] : []),
    ...(p.season.reds > 0 ? [`퇴장 ${p.season.reds}`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * **갈래마다의 칸** — 인물이 말하는 주제의 칸만 선다 (prompts.md §1 「자료 카드」).
 * 부상 이력을 말하는 자리에 주급 표가 서면 장면과 어긋난다.
 */
const COLUMNS: Record<PlayerCardType, Column[]> = {
  overview: [
    POSITION,
    AGE,
    OVERALL,
    ACCURACY,
    WAGE,
    CONTRACT,
    { head: "이번 시즌", cell: seasonLine },
    NOW,
  ],
  fitness: [
    POSITION,
    AGE,
    {
      head: "체력",
      num: true,
      cell: (p) =>
        p.condition && (
          <>
            {p.condition.value}
            {p.condition.margin > 0 && <i className="est">±{p.condition.margin}</i>}
          </>
        ),
    },
    { head: "누적 피로", num: true, cell: (p) => p.fatigue },
    { head: "부상 이력", cell: (p) => injuryHistoryBrief(p.injuryHistory) },
    NOW,
    {
      head: "체격",
      singleOnly: true,
      cell: (p) =>
        p.height !== null && p.weight !== null ? physiqueLabel(p.height, p.weight) : null,
    },
  ],
  stats: [
    POSITION,
    AGE,
    { head: "경기", num: true, cell: (p) => p.season.apps },
    { head: "출전 시간", num: true, cell: (p) => `${p.season.minutes}′` },
    { head: "골", num: true, cell: (p) => p.season.goals },
    { head: "도움", num: true, cell: (p) => p.season.assists },
    { head: "xG", num: true, cell: (p) => p.season.xg.toFixed(2) },
    {
      head: "평점",
      num: true,
      cell: (p) => (p.season.rating === null ? null : formatRating(p.season.rating, "season")),
    },
    { head: "폼", cell: (p) => p.form?.label ?? null },
    { head: "슈팅", singleOnly: true, cell: (p) => p.season.shots },
    { head: "카드", singleOnly: true, cell: bookingsOf },
    { head: "선방", singleOnly: true, cell: (p) => (p.goalkeeper ? p.season.saves : null) },
    {
      head: "무실점",
      singleOnly: true,
      cell: (p) => (p.goalkeeper ? p.season.cleanSheets : null),
    },
    {
      head: "최근 평점",
      singleOnly: true,
      cell: (p) =>
        p.recentRatings.length === 0
          ? null
          : p.recentRatings.map((r) => formatRating(r.value, "match")).join(" · "),
    },
  ],
  contract: [
    POSITION,
    AGE,
    WAGE,
    CONTRACT,
    {
      head: "남은 기간",
      cell: (p, asOf) => (p.contractUntil === null ? null : contractLeft(asOf, p.contractUntil)),
    },
    { head: "지위", cell: (p) => (p.squadStatus ? SQUAD_STATUS_KO[p.squadStatus] : null) },
  ],
  ability: [
    POSITION,
    AGE,
    OVERALL,
    ACCURACY,
    GROWTH,
    { head: "강점", cell: (p) => p.strengths.map((a) => AXIS_KO[a]).join(" · ") },
    {
      head: "다른 자리",
      cell: (p) =>
        p.otherPositions.length === 0
          ? null
          : p.otherPositions.map((o) => `${o.position} ${o.overall}`).join(" · "),
    },
  ],
};

/** 한 명짜리 카드에 16축이 서는 갈래 */
const AXES_SHOWN: ReadonlySet<PlayerCardType> = new Set(["overview", "ability"]);

/** 한 명 — 머리 · 그 갈래의 사실 줄 · (능력을 말하는 갈래면) 16축 */
function PlayerSingle({
  player: p,
  view,
  asOf,
}: {
  player: PlayerExhibitEntry;
  view: PlayerCardType;
  asOf: string;
}) {
  const columns = COLUMNS[view];
  const rated = columns.includes(OVERALL);
  const facts = columns
    .filter((c) => !c.inHead)
    .map((c) => ({ column: c, value: c.cell(p, asOf) }))
    .filter(({ value }) => value !== null && value !== "");
  return (
    <>
      <div className="sheet-title">
        <PlayerName id={p.id} name={p.name} className="sheet-name" />
        <span className="sheet-sub">
          {p.team} · {p.age}세 · {p.position}
        </span>
        {rated && (
          <span className="ex-ovr">
            <b className="fig">{p.overall}</b>
            <Accuracy player={p} />
          </span>
        )}
      </div>
      {facts.length > 0 && (
        <div className="ex-facts">
          {facts.map(({ column, value }) => (
            <span className={column.tone?.(p)} key={column.head}>
              <em>{column.head}</em>
              {value}
            </span>
          ))}
        </div>
      )}
      {AXES_SHOWN.has(view) && (
        <AxisGrid axes={Object.fromEntries(p.attributes.map((a) => [a.key, a.value]))} />
      )}
    </>
  );
}

/** 여럿 — 한 줄에 한 명. 이름 칸은 이름 아래에 소속을 두고, 숫자 칸은 오른쪽에 맞춘다 */
function PlayerTable({
  players,
  view,
  asOf,
}: {
  players: readonly PlayerExhibitEntry[];
  view: PlayerCardType;
  asOf: string;
}) {
  const columns = COLUMNS[view].filter((c) => !c.singleOnly);
  return (
    <div className="ex-scroll">
      <table className="ex-table">
        <thead>
          <tr>
            {/* 이름 칸의 머리는 비운다 — 머리줄이 이미 「선수」라고 말한다 */}
            <th />
            {columns.map((c) => (
              <th className={c.num ? "num" : undefined} key={c.head}>
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.id}>
              <td className="ex-who-cell">
                <PlayerName id={p.id} name={p.name} className="ex-name" />
                <span className="ex-team">{p.team}</span>
              </td>
              {columns.map((c) => {
                const value = c.cell(p, asOf);
                const classes = [c.num ? "num" : null, c.tone?.(p) ?? null].filter(Boolean);
                return (
                  <td className={classes.length > 0 ? classes.join(" ") : undefined} key={c.head}>
                    {value === null || value === "" ? "—" : value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlayerExhibitView({ exhibit }: { exhibit: PlayerExhibit }) {
  const [only] = exhibit.players;
  const many = exhibit.players.length;
  return (
    <div className="sheet" data-kind="player" data-view={exhibit.view} data-testid="exhibit-player">
      <header className="sheet-kicker">
        <b>선수</b>
        <span>{VIEW_KO[exhibit.view]}</span>
        {many > 1 && <span className="sheet-status">{many}명</span>}
      </header>
      {exhibit.players.length === 1 && only ? (
        <PlayerSingle player={only} view={exhibit.view} asOf={exhibit.asOf} />
      ) : (
        <PlayerTable players={exhibit.players} view={exhibit.view} asOf={exhibit.asOf} />
      )}
    </div>
  );
}

const NEGOTIATION_TYPE_KO: Record<NegotiationExhibit["type"], string> = {
  transfer: "이적",
  renewal: "재계약",
  free: "자유계약",
};

const NEGOTIATION_STATUS_KO: Record<NegotiationExhibit["status"], string> = {
  open: "진행 중",
  signed: "서명",
  completed: "완료",
  withdrawn: "철회",
};

/** 상태의 결 — 아직 움직이는 협상만 금빛이고, 끝난 것은 승의 초록, 접은 것은 흐리다 */
const NEGOTIATION_STATUS_TONE: Record<NegotiationExhibit["status"], string | undefined> = {
  open: "live",
  signed: "done",
  completed: "done",
  withdrawn: undefined,
};

const MANDATE_STAGE_KO: Record<string, string> = {
  pending: "위임 중",
  agreed: "위임 — 합의",
  ready: "위임 — 서명 대기",
  returned: "위임 반환",
  failed: "위임 결렬",
  revoked: "위임 회수",
};

/** 조건 한 갈래 — 낸 쪽과 날, 조건, 당사자별 동의 */
function Terms({ condition }: { condition: NegotiationExhibitTerms }) {
  const { terms } = condition;
  const title = condition.scope === "club" ? "구단 간 조건" : "선수 조건";
  return (
    <section className="sheet-section">
      <div className="sheet-section-head">
        <b>{title}</b>
        {condition.state === "proposal" && condition.from && condition.sentOn && (
          <span>
            {condition.from} 제안 · {humanDate(condition.sentOn, { weekday: false })}
            {terms && ` · ${humanDate(terms.expiresOn, { weekday: false })}까지`}
          </span>
        )}
        {condition.state === "draft" && <span>초안</span>}
      </div>
      {terms ? (
        <dl className="sheet-dl">
          {terms.scope === "club" ? (
            <>
              <dt>이적료</dt>
              <dd>{formatMoney(terms.fee)}</dd>
            </>
          ) : (
            <>
              <dt>기간</dt>
              <dd>{contractSpan(terms.since, terms.until)}</dd>
              <dt>주급</dt>
              <dd>{formatMoney(terms.weeklyWage)}</dd>
              {terms.signingBonus > 0 && (
                <>
                  <dt>계약금</dt>
                  <dd>{formatMoney(terms.signingBonus)}</dd>
                </>
              )}
            </>
          )}
          {terms.installments.length > 0 && (
            <>
              <dt>분할</dt>
              <dd>
                {terms.installments
                  // 분할은 해를 넘겨 서므로 연도까지 — 「7월 1일」이 오늘인지 내년인지 갈린다
                  .map(
                    (p) =>
                      `${humanDate(p.date, { weekday: false, year: true })} ${formatMoney(p.amount)}`,
                  )
                  .join(" · ")}
              </dd>
            </>
          )}
          {terms.promises.length > 0 && (
            <>
              <dt>약속</dt>
              <dd>{terms.promises.join(" · ")}</dd>
            </>
          )}
        </dl>
      ) : (
        <div className="sheet-sub">조건 없음</div>
      )}
      {condition.state === "proposal" && (
        <div className="sheet-parties">
          {condition.parties.map((party, i) => (
            <Fragment key={party.name}>
              {i > 0 && " · "}
              {party.agreed ? <b>{party.name} 동의</b> : `${party.name} 대기`}
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}

/** 지금 어디까지 왔나 — 메디컬 · 서명 · 등록 · 위임. 아직 오지 않은 단계는 서지 않는다 */
function stagesOf(n: NegotiationExhibit): string[] {
  const medical = n.medical
    ? n.medical.examinedOn
      ? `메디컬 완료${n.medical.injuries > 0 ? ` · 부상 ${n.medical.injuries}건` : ""}`
      : `메디컬 ${humanDate(n.medical.readyOn, { weekday: false })} 결과`
    : null;
  return [
    ...(medical ? [medical] : []),
    ...(n.signedOn ? [`${humanDate(n.signedOn, { weekday: false })} 서명`] : []),
    ...(n.registration === "pending" ? ["등록 대기"] : []),
    ...(n.registration === "registered" ? ["등록 완료"] : []),
    ...(n.mandate
      ? [
          `${MANDATE_STAGE_KO[n.mandate.stage] ?? n.mandate.stage} · ${humanDate(n.mandate.decideOn, { weekday: false })} 결론`,
          `위임 상한 이적료 ${formatMoney(n.mandate.maxFee)} · 주급 ${formatMoney(n.mandate.maxWeeklyWage)}`,
        ]
      : []),
  ];
}

function NegotiationExhibitView({ exhibit: n }: { exhibit: NegotiationExhibit }) {
  const stages = stagesOf(n);
  const room = n.room;
  return (
    <div className="sheet" data-kind="negotiation" data-testid="exhibit-negotiation">
      <header className="sheet-kicker">
        <b>협상</b>
        <span>{NEGOTIATION_TYPE_KO[n.type]}</span>
        <span className="sheet-status" data-tone={NEGOTIATION_STATUS_TONE[n.status]}>
          {NEGOTIATION_STATUS_KO[n.status]}
        </span>
      </header>
      <div className="sheet-title">
        <PlayerName id={n.playerId} name={n.player} className="sheet-name" />
        {n.type === "transfer" && (
          <span className="sheet-sub">{n.buying ? `${n.seller} 소속` : `${n.buyer} 영입`}</span>
        )}
      </div>
      <div className="sheet-terms">
        {n.conditions.map((c) => (
          <Terms condition={c} key={c.scope} />
        ))}
      </div>
      {n.closedReason && <div className="sheet-sub">{n.closedReason}</div>}
      {(stages.length > 0 || room) && (
        <div className="sheet-foot">
          {stages.map((stage) => (
            <span key={stage}>{stage}</span>
          ))}
          {room?.wageRoomAfter != null && (
            <span data-short={room.wageRoomAfter < 0}>
              <em>서명 뒤 주급 여유</em>
              {signedMoney(room.wageRoomAfter)}/주
            </span>
          )}
          {room?.fee != null && (
            <span data-short={room.fee > room.balance}>
              <em>이적료 / 잔고</em>
              {formatMoney(room.fee)} / {formatMoney(room.balance)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** 큰 항목부터 몇 줄 — 나머지는 재정 화면이 갖는다 */
const FINANCE_LINES = 3;

function FinanceExhibitView({ exhibit: f }: { exhibit: FinanceExhibit }) {
  const { month } = f;
  const top = (lines: typeof month.income) =>
    [...lines].sort((a, b) => b.amount - a.amount).slice(0, FINANCE_LINES);
  return (
    <div className="sheet" data-kind="finance" data-testid="exhibit-finance">
      <header className="sheet-kicker">
        <b>재정</b>
        <span>{humanMonthYear(month.month)}</span>
        <span className="sheet-status" data-tone={month.closed ? undefined : "live"}>
          {month.closed ? "결산" : "진행 중"}
        </span>
      </header>
      <div className="ex-kpis">
        <span>
          <em>잔고</em>
          <b>{formatMoney(f.balance)}</b>
        </span>
        <span>
          <em>주급 총액 / 예산</em>
          <b>
            {formatMoney(f.weeklyWages)} / {formatMoney(f.wageBudget)}
          </b>
        </span>
        <span data-tone={f.wageTone}>
          <em>급여 비중</em>
          <b>{Math.round(f.wageRatio * 100)}%</b>
        </span>
      </div>
      <div className="ex-ledger">
        <div>
          <div className="ex-ledger-head">
            <em>수입</em>
            <b>{formatMoney(month.incomeTotal)}</b>
          </div>
          {top(month.income).map((l) => (
            <div className="ex-ledger-line" key={l.category}>
              <span>{l.label}</span>
              <span>{formatMoney(l.amount)}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="ex-ledger-head">
            <em>지출</em>
            <b>{formatMoney(month.expenseTotal)}</b>
          </div>
          {top(month.expense).map((l) => (
            <div className="ex-ledger-line" key={l.category}>
              <span>{l.label}</span>
              <span>{formatMoney(l.amount)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="sheet-foot">
        <span data-short={month.cashNet < 0}>
          <em>현금 순증</em>
          {signedMoney(month.cashNet)}
        </span>
        {f.debt && (
          <span>
            <em>부채</em>
            {formatMoney(f.debt.amount)}
          </span>
        )}
        {f.commitments.payable > 0 && (
          <span>
            <em>낼 분할금</em>
            {formatMoney(f.commitments.payable)}
          </span>
        )}
        {f.commitments.receivable > 0 && (
          <span>
            <em>받을 분할금</em>
            {formatMoney(f.commitments.receivable)}
          </span>
        )}
        {f.commitments.next && (
          <span>
            <em>다음 분할</em>
            {humanDate(f.commitments.next.dueOn, { weekday: false })}{" "}
            {f.commitments.next.direction === "payable" ? "지급" : "수령"}{" "}
            {formatMoney(f.commitments.next.amount)}
          </span>
        )}
        {f.expiringContracts > 0 && (
          <span>
            <em>1년 안 만료 계약</em>
            {f.expiringContracts}명
          </span>
        )}
        {f.boardRequest && (
          <span>
            <em>보드 요청</em>
            {f.boardRequest.label} {f.boardRequest.amount} ·{" "}
            {humanDate(f.boardRequest.respondOn, { weekday: false })} 답
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 카드 한 장 — 값이 아직 없으면(스트리밍 중) 무엇이 올지만 선다. 저장된 턴인데 값이
 * 없으면 코어가 풀지 못한 카드라 아무것도 세우지 않는다.
 */
export function ExhibitCard({
  tag,
  exhibit,
  streaming,
}: {
  tag: ExhibitTag;
  exhibit: Exhibit | undefined;
  streaming: boolean;
}) {
  if (!exhibit)
    return streaming ? (
      <div className="sheet pending" data-kind={tag.replace(/_card$/u, "")}>
        <header className="sheet-kicker">
          <b>{EXHIBIT_KO[tag]}</b>
        </header>
      </div>
    ) : null;
  if (exhibit.kind === "player") return <PlayerExhibitView exhibit={exhibit} />;
  if (exhibit.kind === "negotiation") return <NegotiationExhibitView exhibit={exhibit} />;
  return <FinanceExhibitView exhibit={exhibit} />;
}
