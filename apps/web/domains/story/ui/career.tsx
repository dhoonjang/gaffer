"use client";

import type { OfficeViews } from "@story-fm/engine";
import { achievementTitle, awardTitle, formatMoney, formatRating } from "@story-fm/domain";
import { IconTrophy } from "@/domains/common/ui/icons";
import { contractUntil, humanDate } from "@/domains/common/lib/dateline";

type SeasonRow = OfficeViews["career"]["seasons"][number];
type AchievementRow = OfficeViews["career"]["achievements"][number];
type AwardRow = OfficeViews["career"]["awards"][number];

/**
 * **업적 한 줄을 쓰는 자리** — 코어는 코드와 근거 수치만 넘긴다
 * (docs/overview.md §1 철칙 4 · career.md §6). 지난 시즌의 업적도 여기서 문장을 얻으므로
 * 문구를 고치면 함께 고쳐진다.
 */
function achievementDetailOf(a: AchievementRow): string {
  if (a.competitionName) return `${a.competitionName} 우승`;
  if (a.playerName && a.goals !== undefined) return `${a.playerName} 시즌 ${a.goals}골`;
  if (a.matches !== undefined) return `${a.matches}경기 무패`;
  if (a.position !== undefined && a.leagueName) return `${a.leagueName} ${a.position}위`;
  return "";
}

/**
 * **시상 한 줄의 근거를 쓰는 자리** — 코어는 코드와 근거 수치만 넘긴다
 * (docs/overview.md §1 철칙 4 · career.md §6). 어느 칸이 그 상의 근거인가는
 * 상마다 다르다: 득점왕은 골, 도움왕은 도움, 올해의 선수는 평점, 영플레이어는
 * 나이와 평점. 출전은 넷 모두의 바탕이라 늘 뒤에 붙는다.
 */
function awardDetailOf(a: AwardRow): string {
  const rating = a.rating === undefined ? null : `평점 ${formatRating(a.rating, "season")}`;
  const grounds =
    a.code === "top-scorer"
      ? [`${a.goals}골`]
      : a.code === "top-assister"
        ? [`${a.assists}도움`]
        : a.code === "young-player"
          ? [a.age === undefined ? null : `${a.age}세`, rating]
          : [rating];
  return [...grounds, `${a.apps}경기`].filter((x): x is string => x !== null).join(" · ");
}

/** 전적 한 칸 — 코어는 셋을 세고, `20승 8무 10패`로 잇는 것은 화면이다 */
function recordText({ wins, draws, losses }: SeasonRow["record"]): string {
  return `${wins}승 ${draws}무 ${losses}패`;
}

type CareerView = OfficeViews["career"];

/**
 * **경질 한 줄을 쓰는 자리** — 코어는 등급·순위·기대만 넘긴다
 * (docs/overview.md §1 철칙 4 · career.md §5.1).
 *
 * 같은 17위도 우승을 노리라는 구단에서와 잔류가 기대인 구단에서 다른 사건이라,
 * 순위 혼자로는 왜 잘렸는지가 읽히지 않는다. 순위가 없으면(리그전 전) 지어내지 않는다.
 * 무직 카드와 시즌 표의 경질 이력 줄(career.md §6)이 같은 문장을 쓴다.
 */
function dismissalLineOf(d: {
  position: number | null;
  target: number;
  expectation: string;
}): string {
  if (d.position === null) return "";
  return `${d.expectation} — 기대 ${d.target}위, 당시 ${d.position}위`;
}

type OfferRow = CareerView["offers"][number];

/**
 * **제안 한 장** — 무직에게 온 자리도, 지금 구단의 재계약도 같은 물건이다
 * (career.md §5.1 · §5.4). 코어가 넘기는 것은 조건과 기한이고 문장은 여기서 쓴다.
 *
 * **읽는 값이다** — 수락도 흥정도 감독이 말로 한다.
 */
function OfferCard({ offer: o }: { offer: OfferRow }) {
  return (
    <div className="offer">
      <div className="offer-head">
        <b>{o.teamName}</b>
        {/* 재직 중에 서는 자리는 갈래가 곧 사실이다 — 재계약인가, 손을 뻗은 것인가 */}
        <span className="tier">
          {o.via === "renewal"
            ? "재계약"
            : o.via === "poach"
              ? `접근 · ${o.tier}티어`
              : `${o.tier}티어`}
        </span>
        <span className="until">{humanDate(o.expiresOn)}까지</span>
      </div>
      <div className="offer-why">
        기대 {o.expectation} ({o.target}위)
        {o.position === null ? "" : ` · 현재 ${o.position}위`}
      </div>
      <div className="offer-why">
        연봉 {formatMoney(o.salary)} · {o.years}년 · 이적 예산 약속 {formatMoney(o.budgetPledge)}
        {o.counteredOn === null ? "" : " · 흥정 완료"}
      </div>
      {/* 보상금은 감독의 돈이 아니다 — 구단이 구단에 무는 돈이다 (career.md §5.1) */}
      {o.compensation !== null && (
        <div className="offer-why">보상금 {formatMoney(o.compensation)} — 지금 구단이 받는다</div>
      )}
    </div>
  );
}

type VacancyRow = CareerView["vacancies"][number];

/**
 * **공석 명부 — 제안이 아니라 문이다** (career.md §5.1). 제안 카드의 강조 테두리를
 * 물려받으면 답을 기다리는 것처럼 읽히므로 가라앉은 테두리로 가른다. 지원은 감독이
 * 말로 한다 — 화면은 어느 문이 열려 있는지만 세운다.
 */
function Vacancies({ vacancies }: { vacancies: readonly VacancyRow[] }) {
  if (vacancies.length === 0) return null;
  return (
    <div className="offer-list" data-testid="manager-vacancies">
      {vacancies.map((v, i) => (
        <div className="offer vacant" key={i}>
          <div className="offer-head">
            <b>{v.teamName}</b>
            <span className="tier">{v.tier}티어</span>
            <span className="until">{humanDate(v.on)} 공석</span>
          </div>
          {v.position !== null && <div className="offer-why">현재 {v.position}위</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * **재직 중에도 거취는 서 있다** — 보드의 재계약(career.md §5.4)과 다른 구단의 이직
 * 제안, 그리고 지금 열려 있는 공석(§5.1 「재직 중 접근·노크」).
 *
 * 경질 카드가 서 있는 동안에는 이 자리가 무직 카드로 대체된다. 어느 쪽이든 **읽는
 * 값이다** — 수락도 지원도 감독이 말로 한다.
 */
function InPost({ career }: { career: CareerView }) {
  if (career.dismissal) return null;
  if (career.offers.length === 0 && career.vacancies.length === 0) return null;
  return (
    <div className="mgr-outofwork">
      {career.offers.length > 0 && (
        <div className="offer-list" data-testid="in-post-offers">
          {career.offers.map((o) => (
            <OfferCard offer={o} key={o.id} />
          ))}
        </div>
      )}
      <Vacancies vacancies={career.vacancies} />
    </div>
  );
}

/**
 * **무직 — 경질 카드와 지금 열린 감독직 제안.**
 *
 * 커리어 화면의 맨 위에 선다. 잘린 뒤 시계는 계속 흐르므로(career.md §5.1) 이
 * 화면이 "왜 맡은 팀이 없는가"와 "무엇이 걸려 있는가"를 한자리에서 말해야 한다.
 * 제안은 **읽는 값이다** — 수락은 감독이 말로 한다.
 */
/** 자리를 잃은 갈래의 이름 — 코드가 사실이고 문장은 화면이 만든다 (career.md §5.4) */
const LEAVE_KO = {
  expired: "계약 만료",
  resigned: "사임",
  sacked: "경질",
  moved: "이적",
} as const;

function OutOfWork({ career }: { career: CareerView }) {
  const d = career.dismissal;
  if (!d) return null;
  return (
    <div className="mgr-outofwork" data-testid="dismissal">
      <div className="dismissed">
        <div className="dismissed-head">
          <b>{d.teamName}</b>
          <span className="when">
            {humanDate(d.on)} {LEAVE_KO[d.kind]}
          </span>
        </div>
        <div className="dismissed-why">{dismissalLineOf(d)}</div>
        {d.severance !== null && (
          <div className="dismissed-why">
            위약금 {formatMoney(d.severance)}
            {/* 누가 물었는지는 갈래가 안다 (career.md §5.4 · §5.1) */}
            {d.kind === "resigned" ? " (감독 부담)" : d.kind === "moved" ? " (새 구단 부담)" : ""}
          </div>
        )}
      </div>
      <div className="offer-list" data-testid="manager-offers">
        {career.offers.length === 0 ? (
          <div className="empty">감독직 제안 0</div>
        ) : (
          career.offers.map((o) => <OfferCard offer={o} key={o.id} />)
        )}
      </div>
      <Vacancies vacancies={career.vacancies} />
    </div>
  );
}

// ── 커리어 ──────────────────────────────────────────────
type DismissalRow = CareerView["dismissals"][number];

export function CareerView({
  squad,
  career,
}: {
  squad: OfficeViews["squad"];
  career: OfficeViews["career"];
}) {
  /**
   * 시즌 기록과 경질 이력이 **한 표에 선다** (career.md §6) — 잘린 시즌은 시즌
   * 기록이 없으므로 경질 줄이 그 해를 채운다. 같은 시즌 안에서는 경질(시즌 중)이
   * 시즌 결산(시즌 끝)보다 앞이라, 결산 줄에는 끝의 날짜를 세워 정렬한다.
   */
  const seasonRows: Array<
    | { kind: "season"; season: number; at: string; s: SeasonRow }
    | { kind: "dismissal"; season: number; at: string; d: DismissalRow }
  > = [
    ...career.seasons.map((s) => ({ kind: "season" as const, season: s.season, at: "9999", s })),
    ...career.dismissals.map((d) => ({
      kind: "dismissal" as const,
      season: d.season,
      at: d.on,
      d,
    })),
  ].sort((a, b) => a.season - b.season || a.at.localeCompare(b.at));
  return (
    <div data-testid="view-career">
      {/**
       * 감독 — **상자에 담지 않는다.**
       *
       * 카드로 두면 이 화면에서 유일하게 배경을 가진 덩어리가 되어 "여기가 제일
       * 중요하다"고 말하는데, 커리어 화면의 주인은 트로피·업적·시즌 기록이다.
       * 게다가 카드는 폭을 다 쓰든 좁히든 어느 쪽이든 어색했다 — 넓히면 가운데가
       * 비고, 좁히면 아래 섹션과 왼쪽 끝이 어긋났다. 상자를 걷으면 그 문제가
       * 아예 없다: 이름·배경·평판은 그냥 페이지의 머리글이다.
       */}
      <div className="mgr-head">
        <div className="mgr-info">
          <h1 className="view-title">{squad.manager.name} 감독</h1>
          <div className="bg">{squad.manager.background}</div>
          {/**
           * 감독에게 딸린 값은 **두 갈래**고 생김새가 그것을 가른다 — 견주는 눈금
           * (평판)은 상자에 담고, 읽는 사실(계약)은 상자 없이 라벨과 값으로
           * 선다. 둘 다 이름·배경보다 아래 단이다.
           */}
          <div className="mgr-meters">
            <div className="mgr-gauges">
              <div className="mgr-rep">
                <div className="mgr-rep-title">평판</div>
                <div className="mgr-rep-items">
                  {(
                    [
                      ["보드", squad.manager.reputation.board],
                      ["언론", squad.manager.reputation.media],
                      ["선수단", squad.manager.reputation.squad],
                    ] as const
                  ).map(([label, value]) => (
                    <span className="rep-item" key={label}>
                      <span className="rep-label">{label}</span>
                      <span className="rep-bar">
                        <i style={{ width: `${value}%` }} />
                      </span>
                      <b>{value}</b>
                    </span>
                  ))}
                </div>
              </div>
            </div>
            {career.contract && (
              <dl className="mgr-facts">
                <div className="mgr-fact">
                  <dt>계약</dt>
                  <dd>
                    연봉 {formatMoney(career.contract.salary)} ·{" "}
                    {contractUntil(career.contract.until)} ({career.contract.daysLeft}일)
                    {career.contract.renewal === "declined" && (
                      <b className="mgr-nonrenewal"> 재계약 없음</b>
                    )}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </div>
      </div>

      <InPost career={career} />
      <OutOfWork career={career} />

      <h2 className="section-title">트로피 보관함</h2>
      <div className="trophy-list">
        {/* 빈 자리도 사실로 — 「없습니다」가 아니라 수 0과, 그 수가 왜 0인지(첫 시즌) */}
        {career.trophies.length === 0 && (
          <div className="empty">트로피 0{career.seasons.length === 0 && " · 첫 시즌"}</div>
        )}
        {career.trophies.map((t, i) => (
          <div className="trophy" key={i}>
            <IconTrophy size={16} />
            <span>
              {t.competition} — 시즌 {t.season} ({t.teamName})
            </span>
          </div>
        ))}
      </div>

      <h2 className="section-title">업적</h2>
      <div className="trophy-list">
        {career.achievements.length === 0 && <div className="empty">업적 0</div>}
        {career.achievements.map((a, i) => {
          const detail = achievementDetailOf(a);
          return (
            <div className="achv" key={i}>
              <div>{achievementTitle(a.code)}</div>
              <div className="desc">
                시즌 {a.season}
                {detail && ` — ${detail}`}
              </div>
            </div>
          );
        })}
      </div>

      {/**
       * 시상 — **감독의 상이 아니라 선수의 상이다** (career.md §6). 코어가 내려
       * 주는 것은 코드와 근거 수치뿐이라 상의 이름도 근거 문장도 여기서 쓴다.
       */}
      <h2 className="section-title">시상</h2>
      <div className="trophy-list">
        {career.awards.length === 0 && <div className="empty">시상 0</div>}
        {career.awards.map((a, i) => (
          <div className="achv" key={i}>
            <div>{awardTitle(a.code)}</div>
            <div className="desc">
              시즌 {a.season} · {a.competitionName} — {a.playerName} ({a.teamName}) ·{" "}
              {awardDetailOf(a)}
            </div>
          </div>
        ))}
      </div>

      <h2 className="section-title">시즌 기록</h2>
      {seasonRows.length === 0 ? (
        <div className="empty">첫 시즌 진행 중</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>시즌</th>
              <th>팀</th>
              <th>순위</th>
              <th>전적</th>
              <th>보드</th>
            </tr>
          </thead>
          <tbody>
            {seasonRows.map((r) =>
              r.kind === "season" ? (
                <tr key={`season-${r.s.season}`}>
                  <td>{r.s.season}</td>
                  <td>{r.s.teamName}</td>
                  <td>{r.s.position}위</td>
                  <td>{recordText(r.s.record)}</td>
                  {/* 순위와 전적이 말하지 않는 것 — 같은 4위가 어느 구단에서는 성공이고
                      어느 구단에서는 실패다. 코어는 등급과 기대 순위만 넘기고 문장은
                      여기서 쓴다 (docs/overview.md §1 철칙 4) */}
                  <td className="career-verdict">{r.s.board.join(" · ") || "평가 없음"}</td>
                </tr>
              ) : (
                <tr key={`dismissal-${r.d.on}`} data-testid="career-dismissal">
                  <td>{r.d.season}</td>
                  <td>{r.d.teamName}</td>
                  <td>—</td>
                  <td className={`career-sacked${r.d.kind === "moved" ? " career-moved" : ""}`}>
                    {humanDate(r.d.on)} {LEAVE_KO[r.d.kind]}
                  </td>
                  <td className="career-verdict">{dismissalLineOf(r.d)}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
