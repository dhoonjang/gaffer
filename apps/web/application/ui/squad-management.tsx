"use client";
import { useId, useState, type ComponentProps } from "react";
import { SquadView } from "@/domains/match/ui/squad/squad-view";
import { PlayerSearch } from "@/domains/common/ui/player-search";
import { PlayerName } from "@/domains/common/ui/player-card";
import { humanDate } from "@/domains/common/lib/dateline";
const money = (n: number) => `£${n.toLocaleString("en-GB")}`;
export function SquadManagement(props: ComponentProps<typeof SquadView>) {
  const [tab, setTab] = useState("squad");
  const id = useId();
  const { game } = props;
  const tabs = [
    { id: "squad", label: "선수단" },
    { id: "search", label: "선수 찾기" },
    { id: "contracts", label: "계약 만료" },
    { id: "transfers", label: "이적 명단" },
  ];
  if (game.phase === "match") return <SquadView {...props} />;
  const choose = (next: string) => {
    setTab(next);
    if (next !== "squad" && props.boardOpen) props.onToggleBoard?.();
  };
  return (
    <div className="squad-management">
      <div className="agent-center-tabs" role="tablist" aria-label="선수단 관리">
        {tabs.map((entry, index) => (
          <button
            key={entry.id}
            id={`${id}-${entry.id}`}
            data-testid={`squad-management-tab-${entry.id}`}
            role="tab"
            aria-selected={tab === entry.id}
            aria-controls={`${id}-panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            onClick={() => choose(entry.id)}
            onKeyDown={(e) => {
              const target =
                e.key === "ArrowRight"
                  ? (index + 1) % 4
                  : e.key === "ArrowLeft"
                    ? (index + 3) % 4
                    : e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? 3
                        : null;
              if (target !== null) {
                e.preventDefault();
                choose(tabs[target]!.id);
                const buttons =
                  e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  );
                buttons?.item(target).focus();
              }
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-squad`}
        aria-labelledby={`${id}-squad`}
        hidden={tab !== "squad"}
      >
        <SquadView {...props} />
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-search`}
        aria-labelledby={`${id}-search`}
        hidden={tab !== "search"}
      >
        <PlayerSearch
          gameId={game.id}
          refreshKey={JSON.stringify(game.views.negotiation.cases.map((n) => [n.id, n.revision]))}
          disabled={false}
          active={tab === "search"}
        />
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-contracts`}
        aria-labelledby={`${id}-contracts`}
        hidden={tab !== "contracts"}
      >
        <div className="agent-table-scroll">
          <table className="agent-player-table" aria-label="계약 만료 예정">
            <thead>
              <tr>
                <th>선수</th>
                <th>나이</th>
                <th>만료일</th>
                <th>남은 기간</th>
                <th>주급</th>
              </tr>
            </thead>
            <tbody>
              {game.views.finance.expiringContracts.map((p) => (
                <tr key={p.playerId} data-testid="agent-expiring-contract">
                  <td>
                    <PlayerName id={p.playerId} name={p.name} />
                  </td>
                  <td>{p.age}</td>
                  <td>{humanDate(p.until, { year: true, weekday: false })}</td>
                  <td>{p.daysLeft}일</td>
                  <td>{money(p.weeklyWage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!game.views.finance.expiringContracts.length && (
            <p className="muted">1년 안에 만료되는 계약이 없습니다.</p>
          )}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-transfers`}
        aria-labelledby={`${id}-transfers`}
        hidden={tab !== "transfers"}
      >
        <div className="agent-table-scroll">
          <table className="agent-player-table" aria-label="이적 명단">
            <thead>
              <tr>
                <th>선수</th>
                <th>나이</th>
                <th>포지션</th>
                <th>희망 이적료</th>
                <th>등록일</th>
              </tr>
            </thead>
            <tbody>
              {game.views.negotiation.transferList.map((p) => (
                <tr key={p.playerId} data-testid="agent-transfer-listing">
                  <td>
                    <PlayerName id={p.playerId} name={p.name} />
                  </td>
                  <td>{p.age}</td>
                  <td>{p.positions.join(" / ")}</td>
                  <td>{p.askingPrice === undefined ? "가격 협의" : money(p.askingPrice)}</td>
                  <td>{humanDate(p.listedOn, { weekday: false })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!game.views.negotiation.transferList.length && (
            <p className="muted">메인 대화에서 매각할 선수를 지정하세요.</p>
          )}
        </div>
      </div>
    </div>
  );
}
