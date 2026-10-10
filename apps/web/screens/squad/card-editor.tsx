"use client";

import {
  CARD_STEP_MAX,
  CARD_WORDS,
  CARD_WORD_DEFS,
  PLACES,
  PLACE_KO,
  cardStep,
  cardTitle,
  cardWordsAt,
  normalizeCard,
  phaseOfWord,
  signedStep,
  type CardSteps,
  type CardWord,
  type Place,
  type RoleCard,
} from "@gaffer/domain";
import { Button } from "@/shared/button";

const PHASES = [
  { key: "ip", ko: "공 있을 때" },
  { key: "oop", ko: "공 없을 때" },
] as const;

/** 낱말 하나의 단계를 옮긴 카드 — 저장하는 꼴로 접는다(0인 낱말은 지운다) */
function withStep(card: RoleCard | null, word: CardWord, step: number): RoleCard | null {
  const base: RoleCard = card ?? { ip: {}, oop: {} };
  const next: RoleCard =
    phaseOfWord(word) === "ip"
      ? { ...base, ip: { ...base.ip, [word]: step } }
      : { ...base, oop: { ...base.oop, [word]: step } };
  return normalizeCard(next) ?? null;
}

/** 공 있을 때의 자리를 옮긴 카드 — 전술판의 자리로 돌아가면 그 칸을 지운다 */
function withPlace(card: RoleCard | null, place: Place | null): RoleCard | null {
  const base: RoleCard = card ?? { ip: {}, oop: {} };
  const ip = { ...base.ip };
  if (place) ip.place = place;
  else delete ip.place;
  return normalizeCard({ ...base, ip }) ?? null;
}

/**
 * **역할 카드** — 그 자리 위에 얹는 지시 (player.md §3).
 *
 * 낱말마다 단계(−3~+3)가 서고, 0이 그 자리의 기본 행동이다. 값은 글자로 눕히고 단계를
 * 옮기는 손잡이만 버튼의 생김새를 갖는다 — 읽는 값과 조작 대상이 모양으로 갈린다.
 * 대가(적응도)는 칸마다 적지 않는다 — 고르기 전에 대가를 말하면 카드가 가장 싼 쪽으로
 * 접힌다 (player.md §7.2). 명단의 적응 게이지가 지금 상태를 말한다.
 */
/** 버릇 한 칸 — `드리블 +1.2`. 카드 단계와 달리 소수가 선다 (player.md §3.4) */
const habitText = (word: CardWord, lean: number) =>
  `${CARD_WORD_DEFS[word].ko} ${lean > 0 ? "+" : "−"}${Math.abs(lean).toFixed(1)}`;

export function CardEditor({
  card,
  place,
  habit,
  onCard,
}: {
  /** 지금 판 위의 카드 — 아직 저장되지 않은 선택까지 포함한다. null이면 기본 행동 */
  card: RoleCard | null;
  /** 전술판의 자리 — 공 없을 때의 자리이고, 공 있을 때의 자리가 없으면 그때도 이 자리다 */
  place: Place;
  /** 이 자리에서 이 선수의 타고난 버릇 — 카드 위에 얹힌다 (읽기만 한다) */
  habit: CardSteps;
  /** 카드를 고치는 손잡이 — 없으면(배치 밖·경기 화면이 잠김) 읽기만 한다 */
  onCard?: ((card: RoleCard | null) => void) | undefined;
}) {
  const keeper = place === "GK";
  const words = cardWordsAt(keeper);
  const ipPlace = card?.ip.place ?? null;
  const set = (word: CardWord, step: number) => (e: React.MouseEvent) => {
    // 상세는 행 안에 있다 — 막지 않으면 행 토글로 새어 나가 접힌다
    e.stopPropagation();
    onCard?.(withStep(card, word, step));
  };
  return (
    <div className="pd-card" data-testid="role-card">
      <div className="pd-card-head">
        <span className="pd-axis-group-name">카드</span>
        <b className="pd-card-title">{cardTitle(card)}</b>
        {card && onCard && (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onCard(null);
            }}
          >
            기본으로
          </Button>
        )}
      </div>
      {/* 타고난 버릇 — 같은 쪽의 카드에는 더해지고 반대쪽이면 반만 남는다 (player.md §3.4) */}
      {CARD_WORDS.some((word) => (habit[word] ?? 0) !== 0) && (
        <div className="pd-card-habit">
          <span className="pd-card-phase-name">버릇</span>
          <span>
            {CARD_WORDS.flatMap((word) => {
              const lean = habit[word] ?? 0;
              return lean === 0 ? [] : [habitText(word, lean)];
            }).join(" · ")}
          </span>
        </div>
      )}
      {PHASES.map((phase) => {
        const inPhase = words.filter((word) => phaseOfWord(word) === phase.key);
        if (inPhase.length === 0) return null;
        return (
          <div className="pd-card-phase" key={phase.key}>
            <span className="pd-card-phase-name">{phase.ko}</span>
            <div className="pd-card-words">
              {/* 공 있을 때의 자리 — 인버티드 풀백처럼 공을 가지면 다른 자리에 선다
                  (player.md §3.3). 골키퍼는 갖지 않는다 */}
              {phase.key === "ip" &&
                !keeper &&
                (onCard ? (
                  <select
                    className="pd-card-place"
                    value={ipPlace ?? ""}
                    aria-label="공 있을 때의 자리"
                    data-testid="card-ip-place"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      onCard(withPlace(card, PLACES.find((p) => p === e.target.value) ?? null))
                    }
                  >
                    <option value="">{place} 그대로</option>
                    {PLACES.filter((p) => p !== "GK" && p !== place).map((p) => (
                      <option key={p} value={p}>
                        {p} {PLACE_KO[p]}
                      </option>
                    ))}
                  </select>
                ) : (
                  ipPlace && <span className="pd-card-word set">{ipPlace}에 선다</span>
                ))}
              {inPhase.map((word) => {
                const def = CARD_WORD_DEFS[word];
                const step = cardStep(card, word);
                return (
                  <span
                    className={`pd-card-word${step === 0 ? "" : " set"}`}
                    key={word}
                    data-word={word}
                  >
                    <span className="pd-card-word-name">{def.ko}</span>
                    <Button
                      variant="bare"
                      className="pd-card-step"
                      aria-label={`${def.ko} ${def.minus} 쪽으로`}
                      disabled={!onCard || step <= -CARD_STEP_MAX}
                      onClick={set(word, step - 1)}
                    >
                      −
                    </Button>
                    <span className="pd-card-step-value">
                      {step === 0 ? "0" : signedStep(step)}
                    </span>
                    <Button
                      variant="bare"
                      className="pd-card-step"
                      aria-label={`${def.ko} ${def.plus} 쪽으로`}
                      disabled={!onCard || step >= CARD_STEP_MAX}
                      onClick={set(word, step + 1)}
                    >
                      +
                    </Button>
                    <span className="pd-card-word-side">
                      {step < 0 ? def.minus : step > 0 ? def.plus : ""}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
