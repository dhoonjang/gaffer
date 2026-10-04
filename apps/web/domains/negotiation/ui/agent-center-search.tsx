"use client";
import { useEffect, useRef, useState } from "react";
import {
  ATTRIBUTE_AXES,
  AXIS_KO,
  POSITION_CODES,
  POSITION_GROUPS,
  attributeAxisOf,
  type AttributeAxis,
  type AgentCenterSearchResult,
} from "@story-fm/domain";
import { PlayerName } from "@/domains/common/ui/player-card";

export function AgentCenterSearch({
  gameId,
  refreshKey,
  disabled,
  active,
}: {
  gameId: string;
  refreshKey: string;
  disabled: boolean;
  active: boolean;
}) {
  const searchRef = useRef<HTMLElement>(null);
  const [name, setName] = useState("");
  const [club, setClub] = useState("");
  const [positions, setPositions] = useState<string[]>([]);
  const [minOverall, setMinOverall] = useState("");
  const [attributes, setAttributes] = useState<{ axis: AttributeAxis; min: number }[]>([]);
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<AgentCenterSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changePage = (next: number) => {
    setPage(next);
    searchRef.current?.scrollIntoView({ block: "start" });
  };
  const resetPage = () => setPage(1);
  const clear = () => {
    setName("");
    setClub("");
    setPositions([]);
    setMinOverall("");
    setAttributes([]);
    resetPage();
  };
  const togglePositions = (codes: string[]) => {
    const selected = codes.every((code) => positions.includes(code));
    setPositions(
      selected
        ? positions.filter((code) => !codes.includes(code))
        : [...new Set([...positions, ...codes])],
    );
    resetPage();
  };
  const filterKey = JSON.stringify({ name, club, positions, minOverall, attributes });
  useEffect(() => {
    setResults(null);
    setError(null);
    if (!active) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const filter = JSON.parse(filterKey) as {
        name: string;
        club: string;
        positions: string[];
        minOverall: string;
        attributes: { axis: AttributeAxis; min: number }[];
      };
      const query = new URLSearchParams({
        name: filter.name.trim(),
        club: filter.club.trim(),
        page: String(page),
        pageSize: "20",
      });
      if (filter.positions.length) query.set("positions", filter.positions.join(","));
      if (filter.minOverall !== "") query.set("minOverall", filter.minOverall);
      if (filter.attributes.length) query.set("attributes", JSON.stringify(filter.attributes));
      void fetch(`/api/games/${gameId}/agent-center/players?${query}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = (await response.json()) as AgentCenterSearchResult & { error?: string };
          if (!response.ok) throw new Error(body.error ?? "선수를 찾지 못했습니다.");
          if (!controller.signal.aborted) setResults(body);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            setError(reason instanceof Error ? reason.message : "검색 중 문제가 발생했습니다.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, gameId, refreshKey, filterKey, page]);
  return (
    <section ref={searchRef} className="agent-center-search">
      <div className="agent-search-toolbar">
        <label>
          선수
          <input
            data-testid="agent-search-name"
            value={name}
            maxLength={100}
            disabled={disabled}
            placeholder="이름"
            onChange={(e) => {
              setName(e.target.value);
              resetPage();
            }}
          />
        </label>
        <label>
          구단
          <input
            data-testid="agent-search-club"
            value={club}
            maxLength={100}
            disabled={disabled}
            placeholder="구단명"
            onChange={(e) => {
              setClub(e.target.value);
              resetPage();
            }}
          />
        </label>
        <label className="agent-overall-filter">
          종합 최소
          <input
            data-testid="agent-search-min-overall"
            aria-label="종합 능력 최소값"
            type="number"
            min={0}
            max={100}
            value={minOverall}
            disabled={disabled}
            onChange={(e) => {
              setMinOverall(
                e.target.value === ""
                  ? ""
                  : String(Math.max(0, Math.min(100, Number(e.target.value)))),
              );
              resetPage();
            }}
          />
        </label>
        <button data-testid="agent-search-reset" disabled={disabled} onClick={clear}>
          초기화
        </button>
      </div>
      <details className="agent-filter-details">
        <summary>포지션 {positions.length ? `· ${positions.length}개 선택` : "· 전체"}</summary>
        <div className="agent-position-chips" role="group" aria-label="포지션 그룹">
          {(["GK", "DF", "MF", "FW"] as const).map((group) => {
            const codes = POSITION_CODES.filter((code) => POSITION_GROUPS[code] === group);
            return (
              <button
                key={group}
                data-testid={`agent-search-position-group-${group}`}
                disabled={disabled}
                aria-pressed={codes.every((code) => positions.includes(code))}
                onClick={() => togglePositions(codes)}
              >
                {{ GK: "골키퍼", DF: "수비", MF: "미드필더", FW: "공격" }[group]}
              </button>
            );
          })}
        </div>
        <div className="agent-position-chips" role="group" aria-label="세부 포지션">
          {POSITION_CODES.map((code) => (
            <button
              key={code}
              data-testid={`agent-search-position-${code}`}
              disabled={disabled}
              aria-pressed={positions.includes(code)}
              onClick={() => togglePositions([code])}
            >
              {code}
            </button>
          ))}
        </div>
      </details>
      <details className="agent-filter-details">
        <summary>능력치 조건 {attributes.length ? `· ${attributes.length}개` : "추가"}</summary>
        <div className="agent-attribute-filters">
          {attributes.map((attribute, index) => (
            <div className="agent-attribute-filter" key={index}>
              <select
                data-testid={`agent-search-axis-${index}`}
                aria-label={`능력치 ${index + 1}`}
                disabled={disabled}
                value={attribute.axis}
                onChange={(e) => {
                  const axis = attributeAxisOf(e.target.value);
                  if (axis) {
                    setAttributes(attributes.map((a, i) => (i === index ? { ...a, axis } : a)));
                    resetPage();
                  }
                }}
              >
                {ATTRIBUTE_AXES.filter(
                  (axis) => axis === attribute.axis || !attributes.some((a) => a.axis === axis),
                ).map((axis) => (
                  <option key={axis} value={axis}>
                    {AXIS_KO[axis]}
                  </option>
                ))}
              </select>
              <input
                data-testid={`agent-search-axis-min-${index}`}
                aria-label={`능력치 ${index + 1} 최소값`}
                type="number"
                min={0}
                max={100}
                disabled={disabled}
                value={attribute.min}
                onChange={(e) => {
                  setAttributes(
                    attributes.map((a, i) =>
                      i === index
                        ? { ...a, min: Math.max(0, Math.min(100, Number(e.target.value))) }
                        : a,
                    ),
                  );
                  resetPage();
                }}
              />
              <button
                aria-label={`능력치 ${index + 1} 조건 삭제`}
                disabled={disabled}
                onClick={() => {
                  setAttributes(attributes.filter((_, i) => i !== index));
                  resetPage();
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            data-testid="agent-search-add-attribute"
            disabled={disabled || attributes.length === ATTRIBUTE_AXES.length}
            onClick={() => {
              const axis = ATTRIBUTE_AXES.find(
                (a) => !attributes.some((entry) => entry.axis === a),
              );
              if (axis) {
                setAttributes([...attributes, { axis, min: 60 }]);
                resetPage();
              }
            }}
          >
            조건 추가
          </button>
        </div>
      </details>
      <p className="agent-observation-note">현재 관측한 능력치 기준 · 0–100</p>
      <div aria-live="polite" className="agent-search-state">
        {loading
          ? "선수를 찾고 있습니다…"
          : (error ??
            (results ? `${results.total.toLocaleString()}명 · ${results.page}페이지` : ""))}
      </div>
      {results && !results.players.length && (
        <p className="negotiation-empty">조건에 맞는 선수가 없습니다.</p>
      )}
      <div className="agent-table-scroll">
        <table className="agent-player-table" aria-label="선수 검색 결과">
          <thead>
            <tr>
              <th>선수</th>
              <th>구단</th>
              <th>나이</th>
              <th>포지션</th>
              <th>종합</th>
              {attributes.map((a) => (
                <th key={a.axis}>{AXIS_KO[a.axis]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results?.players.map((player) => (
              <tr data-testid="agent-search-result" data-player-id={player.id} key={player.id}>
                <td>
                  <PlayerName id={player.id} name={player.name} />
                </td>
                <td>{player.teamName}</td>
                <td>{player.age}</td>
                <td>{player.positions.join(" / ")}</td>
                <td>
                  {player.overall.value}
                  {player.overall.margin > 0 && <small> ±{player.overall.margin}</small>}
                </td>
                {attributes.map((a) => {
                  const value = player.attributes.find((entry) => entry.axis === a.axis);
                  return (
                    <td key={a.axis}>
                      {value ? (
                        <>
                          {value.value}
                          {value.margin > 0 && <small> ±{value.margin}</small>}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {results && (
        <nav className="agent-search-pages" aria-label="검색 결과 페이지">
          <button disabled={loading || page === 1} onClick={() => changePage(page - 1)}>
            이전
          </button>
          <span>{page}</span>
          <button disabled={loading || !results.hasMore} onClick={() => changePage(page + 1)}>
            다음
          </button>
        </nav>
      )}
    </section>
  );
}
