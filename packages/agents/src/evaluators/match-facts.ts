import {
  type GameState,
  buildMatchView,
  managerTacticsOf,
  playerName,
  playerById,
} from "@gaffer/engine";
import { ATTRIBUTE_AXES, AXIS_KO } from "@gaffer/domain";

function attributeLine(state: GameState, id: string, position: string): string {
  const player = playerById(state, id);
  if (!player) return "";
  return ATTRIBUTE_AXES.filter((axis) => position === "GK" || axis !== "goalkeeping")
    .map((axis) => `${AXIS_KO[axis]}${player.attributes[axis]}`)
    .join(" ");
}

/**
 * `<facts>` — **판독기가 읽는 사실 전부.** 양 팀의 진짜 능력치와 지금 내는 전력, 선수별
 * 경기 통계(패스·태클·슛·뛴 거리)·체력·카드, 양 팀의 통계, 그리고 양 벤치의 등급.
 * 안개는 감독에게만 걸린다.
 *
 * 사실만 싣는다 — 무엇을 하라는 말은 시스템 프롬프트의 것이다.
 */
export function buildFactsBlock(state: GameState): string[] {
  const pending = state.pendingMatch;
  const view = buildMatchView(state);
  if (!pending || !view) return [];
  const live = pending.live;
  const ledger = live.ledger;
  const record = state.matches.find((m) => m.id === pending.matchId);
  const teamOf = (side: "home" | "away") => (side === "home" ? view.home.name : view.away.name);
  /** AI 벤치의 등급 — 그 벤치의 수가 얼마나 날카로운지의 근거다 */
  const bench = record
    ? [
        `벤치 등급: ${teamOf("home")} ${managerTacticsOf(state, record.homeTeamId)} · ` +
          `${teamOf("away")} ${managerTacticsOf(state, record.awayTeamId)}`,
      ]
    : [];
  const liveCondition = new Map(live.state.players.map((p) => [p.id, p.condition] as const));
  const lineup = (side: "home" | "away"): string[] =>
    live.slots[side].map((slot) => {
      const line = ledger.stats[slot.playerId];
      const yellows = ledger[side].yellows[slot.playerId] ?? 0;
      const condition = liveCondition.get(slot.playerId);
      const tail = [
        ...(condition !== undefined ? [`체력 ${Math.round(condition)}`] : []),
        ...(line
          ? [
              `패스 ${line.passesCompleted}/${line.passes}`,
              `태클 ${line.tacklesWon}/${line.tackles}`,
              `슛 ${line.shots}`,
              `파울 ${line.fouls}`,
              `${(line.distance / 1000).toFixed(1)}km`,
            ]
          : []),
        ...(yellows > 0 ? ["경고"] : []),
      ];
      const row = view.onPitch[side].find((p) => p.id === slot.playerId);
      return (
        `  ${slot.playerId}(${playerName(state, slot.playerId)} ${slot.position}${slot.roleId ? ` ${slot.roleId}` : ""}) ` +
        `전력 ${row?.effective ?? "-"} · ${attributeLine(state, slot.playerId, slot.position)}` +
        (tail.length > 0 ? ` · ${tail.join(" · ")}` : "")
      );
    });
  const benchNames = (side: "home" | "away"): string =>
    view.bench[side].map((p) => `${p.id}(${p.name} ${p.position})`).join(", ");
  const stats = (side: "home" | "away") => {
    const s = view.stats[side];
    return (
      `${teamOf(side)} — 점유 ${Math.round(s.possession * 100)}% · 슈팅 ${s.shots}(유효 ${s.shotsOnTarget}) · xG ${s.xg.toFixed(2)} · ` +
      `패스 ${s.passesCompleted}/${s.passes} · 태클 ${s.tacklesWon}/${s.tackles} · 파울 ${s.fouls} · 코너 ${s.corners} · ${s.distanceKm.toFixed(1)}km`
    );
  };
  return [
    `<facts>`,
    ...bench,
    stats("home"),
    stats("away"),
    `${teamOf("home")} 온필드:`,
    ...lineup("home"),
    `${teamOf("home")} 벤치: ${benchNames("home")}`,
    `${teamOf("away")} 온필드:`,
    ...lineup("away"),
    `${teamOf("away")} 벤치: ${benchNames("away")}`,
    `</facts>`,
  ];
}
