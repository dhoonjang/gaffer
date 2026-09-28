"use client";

import { ScoutingReportView } from "@/domains/negotiation/ui/scouting-report";

import type { ComponentProps } from "react";
import { PlayerCardProvider } from "../../domains/common/ui/player-card";
import { useProposal } from "../../domains/negotiation/ui/proposal-form";

/** 공통 선수 카드와 협상 화면의 연결은 조립 계층이 소유한다. */
export function PlayerCardHost(props: ComponentProps<typeof PlayerCardProvider>) {
  const proposal = useProposal();
  return (
    <PlayerCardProvider
      {...props}
      onPropose={proposal?.open}
      renderReports={(card) =>
        card.scoutingReports.length > 0 ? (
          <details className="pc-reports">
            <summary>보관된 스카우팅 보고서 ({card.scoutingReports.length})</summary>
            {card.scoutingReports.map((report) => (
              <ScoutingReportView key={report.id} report={report} playerId={card.id} />
            ))}
          </details>
        ) : null
      }
    />
  );
}
