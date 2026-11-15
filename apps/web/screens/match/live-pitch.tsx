"use client";
import { useEffect, useRef, useState } from "react";
import { FIELD, kitInkIsLight, type LiveMatchFrame, matchKitsOf } from "@gaffer/domain";
import type { MatchView } from "@gaffer/engine";
import { Portrait } from "@/shared/portrait";

/** 공에서 이 거리(m) 안에 있고 공이 낮게 깔려 있으면 그 선수가 공을 가진 것으로 본다 */
const CARRY_REACH = 2.2;
const CARRY_HEIGHT = 1;
/** 골 카드가 판 위에 머무는 시간 (ms) */
const GOAL_CARD_MS = 4500;

const EVENT_LABEL: Record<string, string> = {
  goal: "골",
  shot: "슈팅",
  save: "선방",
  foul: "파울",
  injury: "부상",
  yellow_card: "경고",
  red_card: "퇴장",
  substitution: "교체",
  chance: "공격 무산",
  tactical_shift: "전술 변경",
  kickoff: "킥오프",
  half_time: "하프타임",
  extra_time_start: "연장 시작",
  extra_half_time: "연장 하프타임",
  full_time: "경기 종료",
};
/** 스코어보드에 서는 경기 시계 — 초 단위 시각과 지금 경기가 어떤 상태인지 */
export function liveClockOf(
  frame: LiveMatchFrame | null,
  match: MatchView,
  paused: boolean,
  blocked: boolean,
  error: string | null,
): { seconds: number; status: string; running: boolean } {
  const seconds = Math.floor(frame?.seconds ?? match.minute * 60);
  const status = error
    ? "연결 확인 필요"
    : frame?.finished
      ? "경기 종료"
      : frame?.interval
        ? "하프타임"
        : blocked || (frame && paused)
          ? "일시정지"
          : match.phase;
  return { seconds, status, running: Boolean(frame) && !paused && !blocked && !error };
}

export function LivePitch({
  frame,
  match,
  running,
  error,
}: {
  frame: LiveMatchFrame | null;
  match: MatchView;
  running: boolean;
  error: string | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const motion = useRef<{
    previous: LiveMatchFrame | null;
    current: LiveMatchFrame | null;
    at: number;
  }>({ previous: null, current: frame, at: 0 });
  const model = useRef(match);
  model.current = match;
  /**
   * 두 팀의 말 색 — 구단의 색이다 (`matchKitsOf`). 색을 모르는 구단이 끼면 토큰의 기본
   * 두 색으로 선다. 그리는 루프가 매 프레임 읽으므로 ref에 둔다.
   */
  const kits = useRef(matchKitsOf(match.home.colours, match.away.colours));
  kits.current = matchKitsOf(match.home.colours, match.away.colours);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    motion.current = { previous: motion.current.current, current: frame, at: performance.now() };
  }, [frame]);
  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    const style = getComputedStyle(element);
    const palette = Object.fromEntries(
      [
        "grass",
        "stripe",
        "line",
        "goal",
        "selection",
        "shadow",
        "ours",
        "theirs",
        "our-outline",
        "their-outline",
        "number",
        "ball",
        "ball-shadow",
        "ball-outline",
      ].map((key) => [key, style.getPropertyValue(`--live-${key}`).trim()]),
    ) as Record<string, string>;
    let request = 0;
    const draw = (now: number) => {
      const rect = element.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
      }
      ctx.setTransform(width / FIELD.length, 0, 0, height / FIELD.width, 0, 0);
      ctx.fillStyle = palette["grass"]!;
      ctx.fillRect(0, 0, 105, 68);
      for (let stripe = 0; stripe < 10; stripe++) {
        if (stripe % 2) {
          ctx.fillStyle = palette["stripe"]!;
          ctx.fillRect(stripe * 10.5, 0, 10.5, 68);
        }
      }
      ctx.strokeStyle = palette["line"]!;
      ctx.lineWidth = 0.18;
      ctx.strokeRect(0.6, 0.6, 103.8, 66.8);
      ctx.beginPath();
      ctx.moveTo(52.5, 0.6);
      ctx.lineTo(52.5, 67.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(52.5, 34, 9.15, 0, Math.PI * 2);
      ctx.stroke();
      for (const end of [0, 1]) {
        ctx.strokeRect(end ? 88.5 : 0.6, 13.84, 15.9, 40.32);
        ctx.strokeRect(end ? 99.5 : 0.6, 24.84, 4.9, 18.32);
        ctx.fillStyle = palette["goal"]!;
        ctx.fillRect(end ? 104.4 : 0, 30.34, 0.6, 7.32);
        ctx.beginPath();
        ctx.arc(end ? 94 : 11, 34, 0.25, 0, Math.PI * 2);
        ctx.fill();
      }
      const { previous, current, at } = motion.current;
      if (current) {
        const blend = window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 1
          : Math.min(1, Math.max(0, (now - at) / 100));
        const same = previous?.matchId === current.matchId && current.tick >= previous.tick;
        const interpolate = (from: number | undefined, to: number) =>
          from === undefined || !same ? to : from + (to - from) * blend;
        const all = [...model.current.onPitch.home, ...model.current.onPitch.away];
        for (const player of current.players) {
          const old = previous?.players.find((p) => p.id === player.id);
          const x = interpolate(old?.x, player.x),
            y = interpolate(old?.y, player.y);
          const info = all.find((p) => p.id === player.id);
          const ours = player.side === (model.current.home.ours ? "home" : "away");
          if (selectedRef.current === player.id) {
            ctx.strokeStyle = palette["selection"]!;
            ctx.lineWidth = 0.35;
            ctx.beginPath();
            ctx.arc(x, y, 2.5, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = palette["shadow"]!;
          ctx.beginPath();
          ctx.ellipse(x + 0.25, y + 0.6, 1.55, 0.9, 0, 0, Math.PI * 2);
          ctx.fill();
          const kit = kits.current?.[player.side];
          // 말 위의 잉크 — 구단 색 위에서는 그 색이 밝은지 어두운지가 정한다
          const light = kit !== undefined && kitInkIsLight(kit);
          ctx.fillStyle = kit ?? (ours ? palette["ours"]! : palette["theirs"]!);
          ctx.beginPath();
          ctx.arc(x, y, 1.65, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle =
            kit === undefined
              ? ours
                ? palette["our-outline"]!
                : palette["their-outline"]!
              : light
                ? palette["ball"]!
                : palette["number"]!;
          ctx.lineWidth = 0.22;
          ctx.stroke();
          const speed = Math.hypot(player.vx, player.vy);
          if (speed > 0.2) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + (player.vx / speed) * 2.25, y + (player.vy / speed) * 2.25);
            ctx.stroke();
          }
          ctx.fillStyle = light ? palette["ball"]! : palette["number"]!;
          ctx.font = "bold 1.65px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(info?.squadNumber ?? "·"), x, y + 0.1);
        }
        const x = interpolate(previous?.ball.x, current.ball.x),
          y = interpolate(previous?.ball.y, current.ball.y);
        ctx.fillStyle = palette["ball-shadow"]!;
        ctx.beginPath();
        ctx.ellipse(x + 0.3, y + 0.5, 0.7, 0.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = palette["ball"]!;
        ctx.strokeStyle = palette["ball-outline"]!;
        ctx.lineWidth = 0.18;
        ctx.beginPath();
        ctx.arc(x, y - current.ball.z * 0.7, 0.65, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      request = requestAnimationFrame(draw);
    };
    request = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(request);
  }, []);
  const seconds = Math.floor(frame?.seconds ?? match.minute * 60);

  const sideOf = (id: string) => frame?.players.find((p) => p.id === id)?.side;
  const infoOf = (id: string) =>
    match.onPitch.home.find((p) => p.id === id) ?? match.onPitch.away.find((p) => p.id === id);

  /**
   * 지금 공을 가진 선수 — 공 곁에 선 가장 가까운 한 명. 패스가 날아가는 동안은 아무도
   * 가깝지 않으므로 **마지막으로 가졌던 선수가 남는다**: 그때마다 지우면 이름표가 깜빡인다.
   */
  const carrier = useRef<string | null>(null);
  if (frame && frame.ball.z < CARRY_HEIGHT) {
    let best: string | null = null;
    let reach = CARRY_REACH;
    for (const p of frame.players) {
      const d = Math.hypot(p.x - frame.ball.x, p.y - frame.ball.y);
      if (d < reach) {
        reach = d;
        best = p.id;
      }
    }
    if (best !== null) carrier.current = best;
  }
  // 고른 선수가 있으면 그 사람이, 없으면 공을 가진 선수가 이름표에 선다
  const taggedId = selected ?? carrier.current;
  const tagged = taggedId ? infoOf(taggedId) : undefined;
  const taggedSide = taggedId ? sideOf(taggedId) : undefined;

  /**
   * 골 카드 — 골이 들어간 순간 판 위에 그 선수의 얼굴이 선다. 스코어는 적지 않는다 —
   * 스코어보드가 그 값을 갖고, 두 자리가 다른 순간에 바뀌면 같은 화면이 두 점수를 말한다. 사건 목록의 골 수가 늘어난
   * 때에만 켜지므로, 이미 골이 있는 경기를 다시 열었을 때는 서지 않는다.
   */
  const goals = (frame?.events ?? []).filter((e) => e.type === "goal");
  const goalCount = goals.length;
  const seenGoals = useRef<number | null>(null);
  const [goalCard, setGoalCard] = useState<number | null>(null);
  useEffect(() => {
    if (seenGoals.current === null) {
      seenGoals.current = goalCount;
      return;
    }
    if (goalCount <= seenGoals.current) {
      seenGoals.current = goalCount;
      return;
    }
    seenGoals.current = goalCount;
    setGoalCard(goalCount - 1);
    const timer = setTimeout(() => setGoalCard(null), GOAL_CARD_MS);
    return () => clearTimeout(timer);
  }, [goalCount]);
  const goal = goalCard === null ? undefined : goals[goalCard];
  const scorer = goal?.actors[0] ? infoOf(goal.actors[0]) : undefined;
  const scorerTeam = goal?.team ? match[goal.team] : undefined;

  return (
    <section
      className={`live-pitch${running ? "" : " stopped"}`}
      aria-label="실시간 경기"
      data-testid="live-pitch"
    >
      <div className="live-pitch-field">
        <div className="live-pitch-frame">
          <canvas
            ref={canvas}
            role="img"
            aria-label={`${match.home.short} 대 ${match.away.short}, ${match.score.home} 대 ${match.score.away}, ${Math.floor(seconds / 60)}분`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const x = ((e.clientX - r.left) / r.width) * 105,
                y = ((e.clientY - r.top) / r.height) * 68;
              const hit = frame?.players.find((p) => Math.hypot(p.x - x, p.y - y) < 3);
              setSelected(hit?.id ?? null);
            }}
          />
          {tagged && taggedSide && (
            <div className="live-tag" data-testid="live-tag">
              <Portrait
                playerId={tagged.id}
                name={tagged.name}
                squadNumber={tagged.squadNumber}
                teamId={match[taggedSide].id}
                colours={match[taggedSide].colours}
                size="s"
                opens
              />
              <b>{tagged.name}</b>
              <span>
                {tagged.squadNumber !== null && `${tagged.squadNumber} · `}
                {tagged.position}
              </span>
            </div>
          )}
          {goal && scorer && scorerTeam && (
            <div className="live-goal-card" role="status" data-testid="live-goal-card">
              <Portrait
                playerId={scorer.id}
                name={scorer.name}
                squadNumber={scorer.squadNumber}
                teamId={scorerTeam.id}
                colours={scorerTeam.colours}
                size="l"
              />
              <div className="live-goal-text">
                <span>
                  {goal.minute}′ 골 · {scorerTeam.short}
                </span>
                <b>{scorer.name}</b>
              </div>
            </div>
          )}
          <span className="live-goal-tag home" aria-hidden>
            {match.home.short}
          </span>
          <span className="live-goal-tag away" aria-hidden>
            {match.away.short}
          </span>
        </div>
      </div>
      {error && (
        <p className="live-pitch-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** 경기 사건 — 최근 것이 위. 경기 기록 탭에 선다 */
export function LiveEvents({
  frame,
  match,
  names,
}: {
  frame: LiveMatchFrame | null;
  match: MatchView;
  names: Record<string, string>;
}) {
  const players = [...match.onPitch.home, ...match.onPitch.away];
  const name = (id: string) => names[id] ?? players.find((p) => p.id === id)?.name ?? id;
  const events = (frame?.events ?? []).filter((e) => e.type !== "kickoff").reverse();
  if (events.length === 0) return null;
  return (
    <ol className="live-events" aria-label="경기 사건">
      {events.map((event, i) => {
        const lead = event.actors[0];
        const who = lead === undefined ? undefined : players.find((p) => p.id === lead);
        const team = event.team ? match[event.team] : undefined;
        return (
          <li key={`${event.minute}-${event.type}-${events.length - i}`}>
            <time>{event.minute}′</time>
            {/* 사건의 주인 — 팀 전체의 사건(전술 변경·휘슬)에는 얼굴이 없다 */}
            {who ? (
              <Portrait
                playerId={who.id}
                name={who.name}
                squadNumber={who.squadNumber}
                teamId={team?.id}
                colours={team?.colours}
                size="xs"
                opens
              />
            ) : (
              <span className="live-event-gap" aria-hidden />
            )}
            <b>{EVENT_LABEL[event.type] ?? event.type}</b>
            <span>{event.actors.map(name).filter(Boolean).join(" · ")}</span>
          </li>
        );
      })}
    </ol>
  );
}
