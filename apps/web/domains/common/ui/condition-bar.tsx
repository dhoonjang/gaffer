"use client";

import type { CSSProperties } from "react";
import type { ConditionRead } from "@story-fm/engine";
import { conditionBand, FATIGUE_BAND_FLOOR } from "@story-fm/domain";

/** 두 색 토큰을 `share`(0~1)만큼 섞는다 — 0이면 `from`, 1이면 `to` */
function mix(from: string, to: string, share: number): string {
  return `color-mix(in oklab, var(${to}) ${Math.round(share * 100)}%, var(${from}))`;
}

/**
 * 누적 피로 → 막대 색. **끊김 없이 옮겨 간다** — 기준점은 코어의 등급 문턱이다:
 * 「쌓임」까지 키 컬러, 「지침」에서 `--warn`, 「과부하」에서 `--loss` (player.md §5.5).
 */
function fatigueTone(fatigue: number): string {
  const { building, heavy, overloaded } = FATIGUE_BAND_FLOOR;
  if (fatigue <= building) return "var(--accent)";
  if (fatigue < heavy) return mix("--accent", "--warn", (fatigue - building) / (heavy - building));
  if (fatigue < overloaded)
    return mix("--warn", "--loss", (fatigue - heavy) / (overloaded - heavy));
  return "var(--loss)";
}

/**
 * 체력 막대 — **값이 아니라 구간이다.**
 *
 * 경기 중 남은 다리는 아무도 실시간으로 재지 못한다(player.md §9.2). 흐린 숫자를
 * 또렷한 막대로 그리면 감독은 그걸 사실로 읽으므로, 확실한 만큼만 채우고 그 위로
 * **모르는 폭**을 흐리게 얹는다 — 막대의 끝이 어디인지 모른다는 사실이 모양으로
 * 드러난다. 안내 문구는 두지 않는다.
 *
 * 우리 선수의 꼬리는 짧고 상대는 길며, 둘 다 후반으로 갈수록 길어진다. 경기 밖에서는
 * 아침에 잰 값이라 꼬리가 아예 없다 — 폭 자체가 "지금 이걸 얼마나 믿을 수 있나"다.
 *
 * **명단·판세·상대 표가 이 하나를 쓴다.** 화면마다 따로 그리면 같은 선수가 두 모양,
 * 두 색으로 선다 — 색의 경계도 여기서 정하지 않고 코어가 정한다.
 *
 * **누적 피로를 알면 색은 피로다** (player.md §5.5) — 길이가 오늘 남은 다리,
 * 색이 시즌이 쌓은 잔고다. 피로를 모르는 막대(경기 판세·상대)는 체력 밴드로 칠한다.
 */
export function ConditionBar({ c, fatigue }: { c: ConditionRead; fatigue?: number }) {
  const known = c.low === c.high;
  const condition = `체력 ${known ? c.value : `${c.low}~${c.high}`}`;
  const style =
    fatigue === undefined ? undefined : ({ "--cond-tone": fatigueTone(fatigue) } as CSSProperties);
  return (
    <span
      className={
        fatigue === undefined ? `cond-bar ${conditionBand(c.value)}` : "cond-bar by-fatigue"
      }
      style={style}
      title={`${c.label} — ${condition}`}
    >
      <span className="cond-sure" style={{ width: `${c.low}%` }} />
      {!known && (
        <span className="cond-fog" style={{ left: `${c.low}%`, width: `${c.high - c.low}%` }} />
      )}
    </span>
  );
}
