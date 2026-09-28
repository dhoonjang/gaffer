"use client";

import { useState } from "react";
import {
  AXIS_KO,
  attributeAxisOf,
  SCOUTING_DEPTH_LABELS,
  SCOUTING_FIT_LABELS,
  SCOUTING_TOPIC_LABELS,
  formatMoney,
  type ScoutingReport,
} from "@story-fm/domain";
import { humanDate, contractUntil } from "@/domains/common/lib/dateline";
import { GrowthOutlook } from "@/domains/common/ui/growth-outlook";
import { observationRange } from "@/domains/common/lib/scout-report-display";

/** Both the timeline and player archive render the saved evidence, never current player values. */
export function ScoutingReportView({
  report,
  playerId,
}: {
  report: ScoutingReport;
  playerId?: string;
}) {
  const [showOther, setShowOther] = useState(false);
  const candidates = playerId
    ? report.candidates.filter((candidate) => candidate.evidence.playerId === playerId)
    : report.candidates;
  const recommended = playerId
    ? candidates
    : candidates.filter(
        ({ assessment }) => assessment.fit === "recommended" || assessment.fit === "consider",
      );
  const other = playerId
    ? []
    : candidates.filter(
        ({ assessment }) => assessment.fit !== "recommended" && assessment.fit !== "consider",
      );
  return (
    <article className="scout-report" data-testid="scout-report">
      <header className="sr-head">
        <span className="sr-badge">스카우팅 보고서</span>
        <b className="sr-name">{report.question}</b>
        <span className="sr-meta">
          {humanDate(report.requestedOn, { weekday: false })} –{" "}
          {humanDate(report.completedOn, { weekday: false })}
          {" · 근거 기준 "}
          {humanDate(report.evidenceOn, { weekday: false })}
        </span>
      </header>
      <div className="sr-facts">
        <span>
          <em>조사 계획</em>
          <b>{SCOUTING_DEPTH_LABELS[report.plan.depth]}</b>
        </span>
        <span>
          <em>확인할 항목</em>
          <b>{report.plan.focus.map((topic) => SCOUTING_TOPIC_LABELS[topic]).join(" · ")}</b>
        </span>
        <span>
          <em>예상 정보 수준</em>
          <b>
            {report.plan.expectations
              .map(
                ({ topic, precision }) =>
                  `${SCOUTING_TOPIC_LABELS[topic]}: ${{ unknown: "판단 어려움", broad: "대략적 추정", supported: "근거 갖춘 평가" }[precision]}`,
              )
              .join(" · ")}
          </b>
        </span>
        {report.plan.limitations.length > 0 && (
          <span>
            <em>계획의 제약</em>
            <b>
              {report.plan.limitations.map((topic) => SCOUTING_TOPIC_LABELS[topic]).join(" · ")}
            </b>
          </span>
        )}
      </div>
      {candidates.length === 0 && <p className="mn-empty">이번 조사에서 보고할 후보가 없습니다.</p>}
      {recommended.map((candidate) => (
        <CandidateView key={candidate.evidence.playerId} candidate={candidate} />
      ))}
      {other.length > 0 && (
        <details onToggle={(event) => setShowOther(event.currentTarget.open)}>
          <summary>판단 보류·부적합 후보 {other.length}명</summary>
          {showOther &&
            other.map((candidate) => (
              <CandidateView key={candidate.evidence.playerId} candidate={candidate} />
            ))}
        </details>
      )}
    </article>
  );
}

function CandidateView({
  candidate: { evidence, assessment },
}: {
  candidate: ScoutingReport["candidates"][number];
}) {
  return (
    <section key={evidence.playerId} className="sr-candidate">
      <header className="sr-head">
        <b className="sr-name">{evidence.name}</b>
        <span className="sr-meta">
          {evidence.team} · {evidence.age}세 · {evidence.positions.join(" / ") || evidence.position}
        </span>
        <span className="sr-badge">{SCOUTING_FIT_LABELS[assessment.fit]}</span>
      </header>
      <div className="sr-facts">
        <span>
          <em>종합 추정</em>
          <b>{observationRange(assessment.overall)}</b>
        </span>
        <span>
          <em>성장 가능성</em>
          <b>
            <GrowthOutlook
              overall={
                assessment.overall ? (assessment.overall.low + assessment.overall.high) / 2 : null
              }
              potential={assessment.potential}
            />
          </b>
        </span>
        <span>
          <em>참고 이적료</em>
          <b>
            {evidence.marketEstimate === null ? "판단 보류" : formatMoney(evidence.marketEstimate)}
          </b>
        </span>
        {evidence.weeklyWage !== null && (
          <span>
            <em>확인된 현 주급</em>
            <b>{formatMoney(evidence.weeklyWage)}/주</b>
          </span>
        )}
        {evidence.contractUntil !== null && (
          <span>
            <em>당시 계약</em>
            <b>{contractUntil(evidence.contractUntil)}</b>
          </span>
        )}
        <span>
          <em>확인된 강점</em>
          <b>
            {assessment.strengths.map((topic) => SCOUTING_TOPIC_LABELS[topic]).join(" · ") ||
              "판단 보류"}
          </b>
        </span>
        <span>
          <em>남은 의문</em>
          <b>
            {assessment.concerns
              .map((topic) =>
                topic === "insufficient_evidence" ? "근거 부족" : SCOUTING_TOPIC_LABELS[topic],
              )
              .join(" · ") || "보고된 우려 없음"}
          </b>
        </span>
      </div>
      <details>
        <summary>실제 관측 범위와 근거</summary>
        <div className="sr-facts">
          {Object.entries(assessment.attributes).map(([key, range]) => (
            <span key={key}>
              <em>{attributeAxisOf(key) ? AXIS_KO[attributeAxisOf(key)!] : key}</em>
              <b>{observationRange(range)}</b>
            </span>
          ))}
          {Object.keys(assessment.attributes).length === 0 && <span>세부 능력은 판단 보류</span>}
        </div>
        <ul>
          {evidence.sources
            .filter((source) => assessment.evidenceRefs.includes(source.id))
            .map((source) => (
              <li key={source.id}>
                {humanDate(source.date, { weekday: false })} · {source.text}
              </li>
            ))}
        </ul>
      </details>
    </section>
  );
}
