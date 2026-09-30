import { type GameState, managedTeamId, teamNameIn } from "../../common/core/state";
import { leagueOfTeamIn } from "../../common/core/league-membership";
import { countsInStandings, computeStandings } from "../../common/views/standings";
import { addDays } from "../../common/core/dates";
import { type MediaFact, type MediaVerdict, mediaVerdictOf } from "@story-fm/domain";
import { predictedPlaceOf, predictionOf } from "../../common/views/prediction";
import { punditForRound } from "../../common/people/persona";

/**
 * 오늘이 그 평가가 실리는 날인가 — **다섯 번째 경기의 이튿날**이다 (people.md §4-1).
 *
 * 눈금을 세이브에 적지 않는 이유가 여기 있다: 「몇 번째 평가까지 냈나」는 우리 리그
 * 경기 수에서 그대로 파생하고, 그날을 **날짜로** 집으면 한 번만 걸린다. 경기 당일이
 * 아니라 이튿날인 것은 결과가 그날 저녁에 쓰이기 때문이다 — 그날의 tick은 이미 아침에
 * 지나갔다.
 */
function verdictDue(state: GameState): boolean {
  const leagueId = leagueOfTeamIn(state, state.userTeamId);
  const ours = state.matches
    .filter(
      (m) =>
        countsInStandings(m, state.season, leagueId) &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )
    .map((m) => m.date)
    .sort();
  if (ours.length === 0 || ours.length % PUNDIT_ROUND_MATCHES !== 0) return false;
  const last = ours[ours.length - 1];
  return last !== undefined && addDays(last, 1) === state.date;
}

/**
 * 그 라운드의 평가 한 장 — **예상 대비 등급과 그것을 말한 사람** (people.md §4-1).
 *
 * 서지 않는 경우가 셋이다: 그 시즌 예상표가 아직 없거나, 우리가 그 표에 없거나,
 * **명부에 해설이 한 사람도 없거나.** 코어는 화자를 지어내지 않는다.
 */
export function punditVerdict(state: GameState): MediaFact | null {
  // 감독이 없는 팀의 성적은 그 감독의 이야기가 아니다 (career.md §5.1)
  if (managedTeamId(state) === null || !verdictDue(state)) return null;
  const standings = computeStandings(state);
  const index = standings.findIndex((row) => row.ours);
  const row = standings[index];
  if (!row || row.played === 0) return null;
  const predicted = predictedPlaceOf(state, state.userTeamId);
  if (predicted === null) return null;
  const round = Math.floor(row.played / PUNDIT_ROUND_MATCHES);
  const pundit = punditForRound(state, state.season, round);
  if (!pundit) return null;
  const position = index + 1;
  const verdict: MediaVerdict = mediaVerdictOf(predicted - position);
  return {
    kind: "pundit-verdict",
    date: state.date,
    speakerId: pundit.characterId,
    data: {
      name: pundit.name,
      values: { predicted, position, played: row.played },
      tags: [verdict],
    },
  };
}

/**
 * 그 시즌의 예상표가 나왔다 — **우리 자리와 우승 후보 하나** (season.md §2).
 *
 * 표 전체는 기사가 아니라 대회 화면의 열이다. 스무 줄을 스냅샷에 부으면 그 층의
 * 절반을 남의 리그 순서가 먹는다.
 */
export function predictionReport(state: GameState): MediaFact | null {
  const leagueId = leagueOfTeamIn(state, state.userTeamId);
  const row = predictionOf(state, leagueId);
  if (!row) return null;
  const index = row.order.indexOf(state.userTeamId);
  if (index < 0) return null;
  const favourite = row.order[0];
  return {
    kind: "prediction",
    date: state.date,
    data: {
      refId: leagueId,
      ...(favourite === undefined ? {} : { name: teamNameIn(state, favourite) }),
      values: { rank: index + 1, teams: row.order.length },
    },
  };
}

/**
 * 언론 — **회견 밖에서 세계가 감독에 대해 쓰는 것**
 * (→ [../../../../docs/story/people.md](../../../../docs/story/people.md) §4-1).
 *
 * 회견은 세계가 감독에게 **묻는** 자리라 답이 장부를 옮기지만, 기사는 감독이 답하지
 * 않고 읽기만 하는 배경이다. 그래서 여기서 나가는 것은 사실 카드 하나뿐이고, 어떤
 * 평판도 사기도 이 파일에서 움직이지 않는다.
 *
 * 코어는 **사실만 남긴다** — 예상은 숫자, 평가는 등급 코드, 경질은 원인 코드다.
 * 문장은 GM이 쓴다 (overview.md §1 철칙 4).
 */

/** 펀딧의 평가가 서는 눈금 — 우리 리그 이만큼을 치를 때마다 한 장 */
export const PUNDIT_ROUND_MATCHES = 5;
