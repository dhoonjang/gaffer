"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FAMILIARITY_BASELINE,
  FAMILIARITY_MAX,
  FORMATIONS,
  KEEPER_DISTRIBUTIONS,
  TACKLING_LEVELS,
  TACTIC_AXES,
  TRANSITION_MODES,
  tacticToggleOf,
  tacticToggleWord,
  type ClubColours,
  type ClubTier,
  type Formation,
  type MatchSide,
  type TacticToggleKey,
  type TacticsSpec,
} from "@gaffer/domain";
import type { LabSide, LabSideView, LabView } from "@gaffer/engine";
import { SquadView } from "@/screens/squad/squad-view";
import { TacticsPanel } from "@/screens/squad/tactics-panel";
import type { TacticsView } from "@/screens/squad/types";
import { createLineupSaver, type LineupSaver } from "@/screens/squad/lineup-saver";
import { useLiveMatch } from "@/screens/match/use-live-match";
import { LiveEvents, LivePitch, liveClockOf } from "@/screens/match/live-pitch";
import { MatchHeadline, MatchOpponent, MatchOverview } from "@/screens/match/match-view";
import { PlayerCardProvider } from "@/shared/player-card";
import { mergeMatchOrders, type MatchBoardOrder } from "@/shared/match-orders";
import { Crest } from "@/shared/crest";
import { Button, buttonClass } from "@/shared/button";
import { Loading } from "@/shared/loading";
import { IconArrowLeft, IconPause, IconPlay } from "@/shared/icons";
import { mergeSlice } from "./game-slice";
import type { GameSlice } from "./store";
import type { LabAction, LabCreate, LabSnapshot, LabTactics } from "./lab-protocol";

/**
 * ── 경기 실험실 — 두 구단을 골라 경기 하나만 (docs/match/live-match.md §8.6) ──
 *
 * 판은 진짜 세이브라 전술판(`SquadView`)과 실시간 실행기(`useLiveMatch`)를 게임과 같은
 * 라우트로 쓴다. 이 화면이 더하는 것은 조합 고르기, 두 팀의 프리셋 모양·전술, 적응도와
 * 배속, 그리고 킥오프 전으로 되돌리기다. 정지점을 중계할 턴이 없어 정지점은 읽음 처리만
 * 하고 흐른다.
 */

interface TeamEntry {
  id: string;
  name: string;
  shortName: string;
  leagueId: string;
  tier: ClubTier;
  colours?: ClubColours;
}

interface LeagueEntry {
  id: string;
  name: string;
}

interface Catalog {
  leagues: LeagueEntry[];
  teams: TeamEntry[];
}

/** 배속 — 벽시계와 경기 시계의 비율. x1은 90분이 90분이다 */
const SPEEDS = [1, 4, 8, 16, 32] as const;
const DEFAULT_SPEED = 8;

/** 킥오프의 적응도 — 두 팀을 한 값으로 맞추거나 판을 그대로 둔다 */
const FAMILIARITY_CHOICES = [
  { key: "baseline", label: "두 팀 기준", value: FAMILIARITY_BASELINE },
  { key: "max", label: "두 팀 완숙", value: FAMILIARITY_MAX },
  { key: "keep", label: "판 그대로", value: null },
] as const;
type FamiliarityKey = (typeof FAMILIARITY_CHOICES)[number]["key"];

const LIVE_TABS = [
  { key: "record", label: "기록" },
  { key: "ours", label: "우리 팀" },
  { key: "theirs", label: "상대 팀" },
] as const;
type LiveTab = (typeof LIVE_TABS)[number]["key"];

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 실험실 요청 하나 — 몸이 있으면 POST다. 닫힌 문(배포 서버)은 몸 없는 404로 답한다 */
async function call<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "실험실을 열 수 없습니다");
  return data;
}

/** 우리 쪽과 상대 쪽 — 실험실 뷰는 홈·원정으로 오고 화면은 맡은 쪽으로 읽는다 */
function sidesOf(lab: LabView): { ours: LabSideView; theirs: LabSideView } {
  return lab.sides.home.ours
    ? { ours: lab.sides.home, theirs: lab.sides.away }
    : { ours: lab.sides.away, theirs: lab.sides.home };
}

/** 전술판 눈금이 고친 축만 — 전술 패널은 여섯 축 가운데 하나씩 보낸다 */
function axesPatch(patch: Partial<TacticsView>): LabTactics {
  const out: LabTactics = {};
  for (const axis of TACTIC_AXES) {
    const value = patch[axis.key];
    if (value !== undefined) out[axis.key] = value;
  }
  return out;
}

export function MatchLab({ labId: openedId }: { labId: string | null }) {
  const router = useRouter();
  const [labId, setLabId] = useState(openedId);
  const [snap, setSnap] = useState<LabSnapshot | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [picking, setPicking] = useState(openedId === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  const [familiarity, setFamiliarity] = useState<FamiliarityKey>("baseline");
  const [tab, setTab] = useState<LiveTab>("record");
  /** 경기 중 우리 팀 탭의 전술판 — 펼치면 곁 칸이 넓어진다(그동안 시계는 서 있다) */
  const [boardOpen, setBoardOpen] = useState(false);
  const [finished, setFinished] = useState(false);
  /** 정지점을 읽음 처리하는 왕복 — 그동안 실행기는 x1로 앞서 굴리고 확정하지 않는다 */
  const [stopping, setStopping] = useState(false);
  const saverRef = useRef<LineupSaver | null>(null);
  saverRef.current ??= createLineupSaver();
  const saver = saverRef.current;
  /** 경기 중 전술판 조작 — 다음 진행 앞에 서버로 나간다 */
  const ordersRef = useRef<MatchBoardOrder[]>([]);

  useEffect(() => {
    let cancelled = false;
    call<Catalog>("/api/games?catalog=1")
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(messageOf(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const adopt = useCallback((next: LabSnapshot) => {
    setSnap(next);
    setFinished(next.lab.finished);
  }, []);

  useEffect(() => {
    if (!labId) return;
    let cancelled = false;
    call<LabSnapshot>(`/api/lab/${labId}`)
      .then((next) => {
        if (!cancelled) adopt(next);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(messageOf(e));
        setPicking(true);
      });
    return () => {
      cancelled = true;
    };
  }, [labId, adopt]);

  const applySlice = useCallback((slice: GameSlice) => {
    setSnap((cur) => (cur ? { ...cur, game: mergeSlice(cur.game, slice) } : cur));
  }, []);

  const game = snap?.game ?? null;
  const lab = snap?.lab ?? null;
  const match = game?.views.match ?? null;
  const inMatch = match !== null && !match.beforeKickoff;

  const live = useLiveMatch({
    gameId: labId ?? "",
    matchId: inMatch ? match.matchId : null,
    blocked: tab === "ours" || finished,
    typing: false,
    turning: stopping,
    speed,
    onView: (view) =>
      setSnap((cur) =>
        cur && view && cur.game.views.match?.matchId === view.matchId
          ? { ...cur, game: { ...cur.game, views: { ...cur.game.views, match: view } } }
          : cur,
      ),
    prepare: async () => {
      const saved = await saver.flush();
      if (saved && !saved.ok) throw new Error(saved.error);
      return ordersRef.current;
    },
    applied: (orders) => {
      ordersRef.current = ordersRef.current.filter((order) => !orders.includes(order));
    },
    onSlice: applySlice,
    onStop: async () => {
      if (!labId) return;
      setStopping(true);
      try {
        const seen = await call<{ lab: LabView | null }>(`/api/lab/${labId}`, { kind: "seen" });
        if (seen.lab?.finished) setFinished(true);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setStopping(false);
      }
    },
  });

  /** 실험실 조작 하나 — 판에 남은 편집을 먼저 저장한다. 프리셋·킥오프는 저장된 판에서 출발한다 */
  const act = useCallback(
    async (action: LabAction): Promise<LabSnapshot | null> => {
      if (!labId) return null;
      setBusy(true);
      setError(null);
      try {
        const saved = await saver.flush();
        if (saved && !saved.ok) throw new Error(saved.error);
        const next = await call<LabSnapshot>(`/api/lab/${labId}`, action);
        adopt(next);
        return next;
      } catch (e) {
        setError(messageOf(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [labId, saver, adopt],
  );

  const familiarityValue = FAMILIARITY_CHOICES.find((c) => c.key === familiarity)?.value ?? null;

  const kickoff = async () => {
    ordersRef.current = [];
    setTab("record");
    await act({ kind: "kickoff", familiarity: familiarityValue });
  };

  /** 킥오프 전으로 — `again`이면 같은 판으로 곧바로 다시 찬다 */
  const rewind = async (again: boolean) => {
    if (inMatch && !finished) await live.pause().catch(() => undefined);
    const back = await act({ kind: "rewind" });
    if (back && again) await kickoff();
  };

  const open = async (setup: LabCreate) => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await call<{ id: string }>("/api/lab", setup);
      ordersRef.current = [];
      setTab("record");
      setSnap(null);
      setLabId(id);
      setPicking(false);
      router.replace(`/lab?id=${id}`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (picking || !labId) {
    const current: { home: string; away: string; managed: MatchSide } | null = lab
      ? {
          home: lab.sides.home.teamId,
          away: lab.sides.away.teamId,
          managed: lab.sides.home.ours ? "home" : "away",
        }
      : null;
    return (
      <div className="lab">
        <LabHead lab={null} busy={busy} onPick={null} />
        {error && <p className="error-text lab-error">{error}</p>}
        {catalog ? (
          <LabPicker
            catalog={catalog}
            current={current}
            busy={busy}
            onOpen={(setup) => void open(setup)}
            onCancel={snap ? () => setPicking(false) : null}
          />
        ) : (
          <div className="lab-loading">{!error && <Loading />}</div>
        )}
      </div>
    );
  }

  if (!game || !lab) {
    return (
      <div className="lab">
        <LabHead lab={null} busy={busy} onPick={null} />
        {error && <p className="error-text lab-error">{error}</p>}
        <div className="lab-loading">{!error && <Loading />}</div>
      </div>
    );
  }

  const clock = match
    ? liveClockOf(live.frame, match, live.paused, tab === "ours", live.error)
    : null;
  const running = clock?.running ?? false;
  /** 종료 휘슬 — 읽음 처리의 왕복을 기다리지 않는다. 그 사이 손잡이가 승부차기를 부르지 않게 */
  const over = finished || live.frame?.finished === true;

  return (
    <PlayerCardProvider
      gameId={labId}
      playerNames={game.playerNames}
      stamp={`${labId}/${lab.matchNo}`}
      inMatch={inMatch}
    >
      <div className="lab">
        <LabHead lab={lab} busy={busy} onPick={() => setPicking(true)} />
        {error && <p className="error-text lab-error">{error}</p>}
        {inMatch && clock ? (
          <>
            <MatchHeadline match={match} clock={clock} />
            <div className={`lab-live${tab === "ours" && boardOpen ? " side-open" : ""}`}>
              <div className="lab-pitch">
                <LivePitch frame={live.frame} match={match} running={running} error={live.error} />
              </div>
              <section className="lab-side" aria-label="경기 곁">
                <div className="side-tabs" role="tablist">
                  {LIVE_TABS.map((t) => (
                    <Button
                      variant="bare"
                      key={t.key}
                      role="tab"
                      aria-selected={tab === t.key}
                      className={`side-tab${tab === t.key ? " on" : ""}`}
                      onClick={() => setTab(t.key)}
                    >
                      {t.label}
                    </Button>
                  ))}
                </div>
                <div className="lab-side-body view-scroll ledger-body" key={tab}>
                  {tab === "record" && (
                    <div className="match-record">
                      <MatchOverview match={match} />
                      <LiveEvents frame={live.frame} match={match} names={game.playerNames} />
                    </div>
                  )}
                  {tab === "ours" && (
                    <SquadView
                      game={game}
                      onUpdate={applySlice}
                      onGoToChat={() => setTab("record")}
                      saver={saver}
                      boardOpen={boardOpen}
                      onToggleBoard={() => setBoardOpen((open) => !open)}
                      onOrder={(order) => {
                        ordersRef.current = mergeMatchOrders(ordersRef.current, [order]);
                      }}
                    />
                  )}
                  {tab === "theirs" && <MatchOpponent match={match} />}
                </div>
              </section>
            </div>
            <div className="lab-bar">
              {over ? (
                <span className="lab-final">경기 종료</span>
              ) : (
                <Button
                  onClick={live.toggle}
                  disabled={tab === "ours" || !live.ready}
                  title={
                    tab === "ours"
                      ? "우리 팀 탭을 닫으면 다시 흐릅니다"
                      : !live.ready
                        ? "경기를 받는 중입니다"
                        : undefined
                  }
                  data-testid="lab-clock"
                >
                  {running ? <IconPause size={16} /> : <IconPlay size={16} />}
                  {live.error
                    ? "다시 연결"
                    : live.frame?.interval
                      ? "후반 시작"
                      : running
                        ? "일시정지"
                        : "재개"}
                </Button>
              )}
              <Choice
                label="배속"
                options={SPEEDS}
                value={speed}
                word={(v) => `x${v}`}
                disabled={false}
                onPick={setSpeed}
              />
              <span className="lab-bar-gap" />
              <Button onClick={() => void rewind(false)} disabled={busy}>
                킥오프 전으로
              </Button>
              <Button
                variant={over ? "primary" : "secondary"}
                onClick={() => void rewind(true)}
                disabled={busy}
                data-testid="lab-again"
              >
                다시 치르기
              </Button>
            </div>
          </>
        ) : (
          <div className="lab-prep">
            <div className="lab-board view-scroll ledger-body wide">
              <SquadView
                game={game}
                onUpdate={applySlice}
                onGoToChat={() => setTab("record")}
                saver={saver}
              />
            </div>
            <LabControls
              lab={lab}
              busy={busy}
              familiarity={familiarity}
              speed={speed}
              onFormation={(side, formation) => void act({ kind: "formation", side, formation })}
              onTactics={(side, tactics) => void act({ kind: "tactics", side, tactics })}
              onFamiliarity={setFamiliarity}
              onSpeed={setSpeed}
              onKickoff={() => void kickoff()}
            />
          </div>
        )}
      </div>
    </PlayerCardProvider>
  );
}

function LabHead({
  lab,
  busy,
  onPick,
}: {
  lab: LabView | null;
  busy: boolean;
  onPick: (() => void) | null;
}) {
  return (
    <header className="lab-head">
      <Link href="/" className={buttonClass("ghost", "sm")}>
        <IconArrowLeft />홈
      </Link>
      <h1>경기 실험실</h1>
      {lab && (
        <span className="lab-matchup">
          <TeamTag side={lab.sides.home} />
          <span className="lab-vs">vs</span>
          <TeamTag side={lab.sides.away} />
          <span className="lab-meta">
            {lab.matchNo}번째 경기 · 시드 {lab.seed}
          </span>
        </span>
      )}
      {onPick && (
        <Button size="sm" onClick={onPick} disabled={busy} data-testid="lab-pick">
          조합 바꾸기
        </Button>
      )}
    </header>
  );
}

function TeamTag({ side }: { side: LabSideView }) {
  return (
    <span className={`lab-team${side.ours ? " ours" : ""}`}>
      <Crest
        id={side.teamId}
        shortName={side.shortName}
        colours={side.colours ?? undefined}
        size={20}
      />
      {side.name}
      {side.ours && <em>감독</em>}
    </span>
  );
}

function LabPicker({
  catalog,
  current,
  busy,
  onOpen,
  onCancel,
}: {
  catalog: Catalog;
  current: { home: string; away: string; managed: MatchSide } | null;
  busy: boolean;
  onOpen: (setup: LabCreate) => void;
  onCancel: (() => void) | null;
}) {
  const [home, setHome] = useState(current?.home ?? "");
  const [away, setAway] = useState(current?.away ?? "");
  const [managed, setManaged] = useState<MatchSide>(current?.managed ?? "home");
  const [seed, setSeed] = useState("");
  const nameOf = (id: string) => catalog.teams.find((t) => t.id === id)?.name ?? "";
  const seedValue = Number.parseInt(seed, 10);
  const ready = home !== "" && away !== "" && home !== away;
  return (
    <form
      className="lab-pick"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onOpen({
          homeTeamId: home,
          awayTeamId: away,
          managed,
          ...(seedValue > 0 ? { seed: seedValue } : {}),
        });
      }}
    >
      <TeamSelect label="홈" value={home} catalog={catalog} onChange={setHome} />
      <TeamSelect label="원정" value={away} catalog={catalog} onChange={setAway} />
      <Choice
        label="맡을 팀"
        options={["home", "away"] as const}
        value={managed}
        word={(side) => nameOf(side === "home" ? home : away) || (side === "home" ? "홈" : "원정")}
        disabled={false}
        onPick={setManaged}
      />
      <label className="lab-field">
        <span>시드</span>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          value={seed}
          placeholder="무작위"
          onChange={(e) => setSeed(e.target.value)}
        />
      </label>
      <div className="lab-pick-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={!ready || busy}
          title={
            home === "" || away === ""
              ? "두 구단을 고르면 열립니다"
              : home === away
                ? "같은 구단끼리는 붙일 수 없습니다"
                : undefined
          }
          data-testid="lab-open"
        >
          판 열기
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            돌아가기
          </Button>
        )}
      </div>
    </form>
  );
}

function TeamSelect({
  label,
  value,
  catalog,
  onChange,
}: {
  label: string;
  value: string;
  catalog: Catalog;
  onChange: (id: string) => void;
}) {
  return (
    <label className="lab-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={`lab-${label}`}>
        <option value="" disabled>
          구단
        </option>
        {catalog.leagues.map((league) => (
          <optgroup key={league.id} label={league.name}>
            {catalog.teams
              .filter((t) => t.leagueId === league.id)
              .sort((a, b) => a.tier - b.tier)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function LabControls({
  lab,
  busy,
  familiarity,
  speed,
  onFormation,
  onTactics,
  onFamiliarity,
  onSpeed,
  onKickoff,
}: {
  lab: LabView;
  busy: boolean;
  familiarity: FamiliarityKey;
  speed: number;
  onFormation: (side: LabSide, formation: Formation) => void;
  onTactics: (side: LabSide, tactics: LabTactics) => void;
  onFamiliarity: (key: FamiliarityKey) => void;
  onSpeed: (speed: number) => void;
  onKickoff: () => void;
}) {
  const { ours, theirs } = sidesOf(lab);
  return (
    <aside className="lab-controls" aria-label="실험 설정">
      <section className="lab-section">
        <h2>
          우리 판 <span>{ours.name}</span>
        </h2>
        <FormationChoice
          current={ours.tactics.formation}
          disabled={busy}
          onPick={(f) => onFormation("ours", f)}
        />
        <ToggleChoices
          spec={ours.tactics}
          disabled={busy}
          onChange={(patch) => onTactics("ours", patch)}
        />
      </section>
      <section className="lab-section">
        <h2>
          상대 판 <span>{theirs.name}</span>
        </h2>
        <FormationChoice
          current={theirs.tactics.formation}
          disabled={busy}
          onPick={(f) => onFormation("theirs", f)}
        />
        <TacticsPanel
          tactics={theirs.tactics}
          editing={!busy}
          onChange={(patch) => onTactics("theirs", axesPatch(patch))}
        />
        <ToggleChoices
          spec={theirs.tactics}
          disabled={busy}
          onChange={(patch) => onTactics("theirs", patch)}
        />
      </section>
      <section className="lab-section">
        <h2>킥오프</h2>
        <Choice
          label="적응도"
          options={FAMILIARITY_CHOICES.map((c) => c.key)}
          value={familiarity}
          word={(key) => FAMILIARITY_CHOICES.find((c) => c.key === key)?.label ?? key}
          disabled={busy}
          onPick={onFamiliarity}
        />
        <Choice
          label="배속"
          options={SPEEDS}
          value={speed}
          word={(v) => `x${v}`}
          disabled={false}
          onPick={onSpeed}
        />
        <Button variant="primary" onClick={onKickoff} disabled={busy} data-testid="lab-kickoff">
          킥오프
        </Button>
      </section>
    </aside>
  );
}

function FormationChoice({
  current,
  disabled,
  onPick,
}: {
  current: string;
  disabled: boolean;
  onPick: (formation: Formation) => void;
}) {
  return (
    <div className="lab-row">
      <span className="lab-row-label">
        모양 <b>{current}</b>
      </span>
      <div className="tactic-steps">
        {FORMATIONS.map((f) => (
          <Button
            variant="bare"
            key={f}
            className={`tactic-step wide${f === current ? " on" : ""}`}
            aria-pressed={f === current}
            disabled={disabled}
            onClick={() => onPick(f)}
          >
            {f}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** 갈래 넷 — 값마다 낱말은 도메인의 낱말표가 갖는다 (`TACTIC_TOGGLES`) */
function ToggleChoices({
  spec,
  disabled,
  onChange,
}: {
  spec: TacticsSpec;
  disabled: boolean;
  onChange: (patch: LabTactics) => void;
}) {
  const wordOf = (key: TacticToggleKey) => (value: string | boolean) => {
    const raw = String(value);
    return tacticToggleWord(key, raw === tacticToggleOf(key).neutralValue ? null : raw);
  };
  const labelOf = (key: TacticToggleKey) => tacticToggleOf(key).label;
  return (
    <>
      <Choice
        label={labelOf("transition")}
        options={TRANSITION_MODES}
        value={spec.transition ?? "none"}
        word={wordOf("transition")}
        disabled={disabled}
        onPick={(transition) => onChange({ transition })}
      />
      <Choice
        label={labelOf("offsideTrap")}
        options={[false, true] as const}
        value={spec.offsideTrap ?? false}
        word={wordOf("offsideTrap")}
        disabled={disabled}
        onPick={(offsideTrap) => onChange({ offsideTrap })}
      />
      <Choice
        label={labelOf("tackling")}
        options={TACKLING_LEVELS}
        value={spec.tackling ?? "normal"}
        word={wordOf("tackling")}
        disabled={disabled}
        onPick={(tackling) => onChange({ tackling })}
      />
      <Choice
        label={labelOf("keeperDistribution")}
        options={KEEPER_DISTRIBUTIONS}
        value={spec.keeperDistribution ?? "none"}
        word={wordOf("keeperDistribution")}
        disabled={disabled}
        onPick={(keeperDistribution) => onChange({ keeperDistribution })}
      />
    </>
  );
}

/** 여럿 중 하나 — 전술 패널의 눈금과 같은 생김새다 */
function Choice<T extends string | number | boolean>({
  label,
  options,
  value,
  word,
  disabled,
  onPick,
}: {
  label: string;
  options: readonly T[];
  value: T;
  word: (option: T) => string;
  disabled: boolean;
  onPick: (option: T) => void;
}) {
  return (
    <div className="lab-row">
      <span className="lab-row-label">{label}</span>
      <div className="tactic-steps" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <Button
            variant="bare"
            key={String(option)}
            role="radio"
            aria-checked={option === value}
            className={`tactic-step wide${option === value ? " on" : ""}`}
            disabled={disabled}
            onClick={() => onPick(option)}
          >
            {word(option)}
          </Button>
        ))}
      </div>
    </div>
  );
}
