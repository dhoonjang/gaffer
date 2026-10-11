"use client";

import { useCallback, useEffect, useState } from "react";
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
import type { LabSideView, LabView } from "@gaffer/engine";
import { TacticsPanel } from "@/screens/squad/tactics-panel";
import type { TacticsView } from "@/screens/squad/types";
import { Crest } from "@/shared/crest";
import { Button, buttonClass } from "@/shared/button";
import { Loading } from "@/shared/loading";
import { IconArrowLeft, IconMatch } from "@/shared/icons";
import type { LabAction, LabCreate, LabTactics } from "./lab-protocol";

/**
 * ── 경기 실험실 — 두 구단을 골라 경기 하나만 (docs/match/live-match.md §8.6) ──
 *
 * 이 화면은 게임에 없는 것만 짠다: 조합, 상대의 모양·전술, 두 팀의 적응도. 판은 진짜
 * 세이브라 우리 판과 경기는 게임 화면(`/game/<id>`)이 게임과 똑같이 다룬다 — 말로 하는
 * 지시, 전술판, 입장, 정지점의 중계까지. 다시 치르기는 같은 조합의 새 판을 짓는다.
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

/** 경기 판을 세울 때의 적응도 — 두 팀을 한 값으로 맞추거나 판을 그대로 둔다 */
const FAMILIARITY_CHOICES = [
  { key: "baseline", label: "두 팀 기준", value: FAMILIARITY_BASELINE },
  { key: "max", label: "두 팀 완숙", value: FAMILIARITY_MAX },
  { key: "keep", label: "판 그대로", value: null },
] as const;
type FamiliarityKey = (typeof FAMILIARITY_CHOICES)[number]["key"];

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

/** 상대 쪽 — 실험실 뷰는 홈·원정으로 오고 화면은 맡은 쪽으로 읽는다 */
function theirsOf(lab: LabView): LabSideView {
  return lab.sides.home.ours ? lab.sides.away : lab.sides.home;
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
  const [lab, setLab] = useState<LabView | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [picking, setPicking] = useState(openedId === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [familiarity, setFamiliarity] = useState<FamiliarityKey>("baseline");

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

  useEffect(() => {
    if (!labId) return;
    let cancelled = false;
    call<{ lab: LabView }>(`/api/lab/${labId}`)
      .then((next) => {
        if (!cancelled) setLab(next.lab);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(messageOf(e));
        setPicking(true);
      });
    return () => {
      cancelled = true;
    };
  }, [labId]);

  /** 판 하나로 옮겨 선다 — 새로 지은 판과 다시 치를 판이 같은 길을 지난다 */
  const moveTo = useCallback(
    (id: string) => {
      setLab(null);
      setLabId(id);
      setPicking(false);
      router.replace(`/lab?id=${id}`);
    },
    [router],
  );

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (e) {
      setError(messageOf(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const act = useCallback(
    async (action: Exclude<LabAction, { kind: "replay" }>) => {
      if (!labId) return null;
      const next = await run(() => call<{ lab: LabView }>(`/api/lab/${labId}`, action));
      if (next) setLab(next.lab);
      return next;
    },
    [labId, run],
  );

  const familiarityValue = FAMILIARITY_CHOICES.find((c) => c.key === familiarity)?.value ?? null;

  /** 경기 판을 세우고 게임 화면으로 — 입장부터는 게임이 치른다 */
  const enter = async () => {
    if (!labId) return;
    if (lab?.stage === "prep" && !(await act({ kind: "open", familiarity: familiarityValue })))
      return;
    router.push(`/game/${labId}`);
  };

  const replay = async () => {
    if (!labId) return;
    const made = await run(() => call<{ id: string }>(`/api/lab/${labId}`, { kind: "replay" }));
    if (made) moveTo(made.id);
  };

  const open = async (setup: LabCreate) => {
    const made = await run(() => call<{ id: string }>("/api/lab", setup));
    if (made) moveTo(made.id);
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
            onCancel={lab ? () => setPicking(false) : null}
          />
        ) : (
          <div className="lab-loading">{!error && <Loading />}</div>
        )}
      </div>
    );
  }

  if (!lab) {
    return (
      <div className="lab">
        <LabHead lab={null} busy={busy} onPick={null} />
        {error && <p className="error-text lab-error">{error}</p>}
        <div className="lab-loading">{!error && <Loading />}</div>
      </div>
    );
  }

  const theirs = theirsOf(lab);
  const prep = lab.stage === "prep";
  const locked = prep ? undefined : "경기 판이 이미 섰습니다";
  return (
    <div className="lab">
      <LabHead lab={lab} busy={busy} onPick={() => setPicking(true)} />
      {error && <p className="error-text lab-error">{error}</p>}
      <div className="lab-controls">
        <section className="lab-section">
          <h2>
            상대 판 <span>{theirs.name}</span>
          </h2>
          <FormationChoice
            current={theirs.tactics.formation}
            disabled={busy || !prep}
            reason={locked}
            onPick={(formation) => void act({ kind: "formation", formation })}
          />
          <TacticsPanel
            tactics={theirs.tactics}
            editing={!busy && prep}
            onChange={(patch) => void act({ kind: "tactics", tactics: axesPatch(patch) })}
          />
          <ToggleChoices
            spec={theirs.tactics}
            disabled={busy || !prep}
            reason={locked}
            onChange={(tactics) => void act({ kind: "tactics", tactics })}
          />
        </section>
        <section className="lab-section">
          <h2>
            경기
            {lab.result && (
              <span className="lab-final" data-testid="lab-result">
                {lab.result.homeGoals} : {lab.result.awayGoals}
              </span>
            )}
          </h2>
          <Choice
            label="적응도"
            options={FAMILIARITY_CHOICES.map((c) => c.key)}
            value={familiarity}
            word={(key) => FAMILIARITY_CHOICES.find((c) => c.key === key)?.label ?? key}
            disabled={busy || !prep}
            reason={locked}
            onPick={setFamiliarity}
          />
          <div className="lab-pick-actions">
            <Button
              variant={lab.stage === "played" ? "secondary" : "primary"}
              onClick={() => void enter()}
              disabled={busy}
              data-testid="lab-enter"
            >
              <IconMatch />
              {lab.stage === "played" ? "경기 기록" : "경기장으로"}
            </Button>
            {!prep && (
              <Button
                variant={lab.stage === "played" ? "primary" : "secondary"}
                onClick={() => void replay()}
                disabled={busy}
                data-testid="lab-again"
              >
                다시 치르기
              </Button>
            )}
          </div>
        </section>
      </div>
    </div>
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

function FormationChoice({
  current,
  disabled,
  reason,
  onPick,
}: {
  current: string;
  disabled: boolean;
  /** 막힌 까닭 — 막혔을 때 눈금에 단다 */
  reason?: string | undefined;
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
            title={disabled ? reason : undefined}
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
  reason,
  onChange,
}: {
  spec: TacticsSpec;
  disabled: boolean;
  reason?: string | undefined;
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
        reason={reason}
        onPick={(transition) => onChange({ transition })}
      />
      <Choice
        label={labelOf("offsideTrap")}
        options={[false, true] as const}
        value={spec.offsideTrap ?? false}
        word={wordOf("offsideTrap")}
        disabled={disabled}
        reason={reason}
        onPick={(offsideTrap) => onChange({ offsideTrap })}
      />
      <Choice
        label={labelOf("tackling")}
        options={TACKLING_LEVELS}
        value={spec.tackling ?? "normal"}
        word={wordOf("tackling")}
        disabled={disabled}
        reason={reason}
        onPick={(tackling) => onChange({ tackling })}
      />
      <Choice
        label={labelOf("keeperDistribution")}
        options={KEEPER_DISTRIBUTIONS}
        value={spec.keeperDistribution ?? "none"}
        word={wordOf("keeperDistribution")}
        disabled={disabled}
        reason={reason}
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
  reason,
  onPick,
}: {
  label: string;
  options: readonly T[];
  value: T;
  word: (option: T) => string;
  disabled: boolean;
  /** 막힌 까닭 — 막혔을 때 눈금에 단다 */
  reason?: string | undefined;
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
            title={disabled ? reason : undefined}
            onClick={() => onPick(option)}
          >
            {word(option)}
          </Button>
        ))}
      </div>
    </div>
  );
}
