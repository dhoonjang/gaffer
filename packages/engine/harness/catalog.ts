import { HISTORY_CHAR_KEEP } from "../src/common/core/history-window";
import { defineHarness, type Harness } from "./harness";

/**
 * 하네스 서술자 — **밴드 숫자가 사는 유일한 자리** (→ `docs/common/balance-harness.md`).
 *
 * `why`는 그 구간이 왜 그 자리인지의 한 줄이고, 긴 근거는 `doc`이 가리키는 문서 절이
 * 쥔다. 여기에 없는 숫자를 하네스 본체가 직접 적으면 기댓값이 다시 두 곳으로 갈린다.
 */

const MATCH = "docs/match/match.md §7";
const FINANCE = "docs/negotiation/finance.md §10";
const HISTORY = "docs/common/llm/agents.md §5-1";
const PROMPTS = "docs/common/llm/prompts.md §7";
const TOOL_CONTRACT = "docs/common/llm/prompts.md §2";

export const WORLD_SEASON = defineHarness({
  id: "world-season",
  what: "전체 세계 EPL 한 시즌 — 득점·슈팅 분포 · 승점 곡선 · 카드",
  doc: MATCH,
  cost: "시드당 40초쯤 × 6시드",
  // prettier-ignore
  bands: [
    { metric: "리그 평균 슈팅/경기", role: "reference", min: 24, max: 26, why: "실제 1부의 양 팀 합" },
    { metric: "리그 평균 기회 xG/경기", role: "measure", why: "최종 득점과 같은 눈금이어야 한다" },
    { metric: "결정력 반영 기대 득점/경기", role: "measure", why: "기회 xG와 같은 눈금이어야 한다" },
    { metric: "리그 평균 득점/경기", role: "reference", min: 2.75, max: 3.05, why: "실제 1부 최근 다섯 시즌 2.7~3.3, 평균 2.9" },
    { metric: "총득점 분산", role: "measure", why: "실제는 분산 ≈ 평균 — 평균만으로는 닮았는지 알 수 없다" },
    { metric: "홈 득점/경기", role: "reference", min: 1.5, max: 1.7, why: "실제 1부 — 총득점의 55% 안팎이 홈에서 난다. **지금은 벗어나 있다** — 홈 이점이 슈팅 노출 한 줄뿐이라 (match.md §9)" },
    { metric: "원정 득점/경기", role: "reference", min: 1.2, max: 1.4, why: "실제 1부 — 홈의 0.78~0.82배. 위와 같은 이유로 지금은 위끝에 선다" },
    { metric: "홈승 비율", role: "reference", min: 0.41, max: 0.48, unit: "ratio", why: "실제 1부 최근 네 시즌 41~48%" },
    { metric: "무승부 비율", role: "reference", min: 0.2, max: 0.26, unit: "ratio", why: "실제 1부 최근 네 시즌 20~25%" },
    { metric: "원정승 비율", role: "reference", min: 0.29, max: 0.36, unit: "ratio", why: "실제 1부 최근 네 시즌 30~36% — 홈승을 넘지 않는다" },
    { metric: "클린시트 비율", role: "reference", min: 0.25, max: 0.32, unit: "ratio", why: "팀-경기 단위 — 경기 단위로 세면 두 배가 된다" },
    { metric: "총득점 0골 비율", role: "reference", min: 0.05, max: 0.085, unit: "ratio", why: "실제 1부(경기당 2.9골)의 스코어 분포 — 푸아송에 과산포 1.1~1.15가 얹힌 모양. 한 시즌 380경기라 시드마다 ±2%p는 잡음이다" },
    { metric: "총득점 1골 비율", role: "reference", min: 0.14, max: 0.19, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 2골 비율", role: "reference", min: 0.2, max: 0.24, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 3골 비율", role: "reference", min: 0.19, max: 0.23, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 4골 비율", role: "reference", min: 0.14, max: 0.17, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 5골 비율", role: "reference", min: 0.07, max: 0.11, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 6골 비율", role: "reference", min: 0.03, max: 0.055, unit: "ratio", why: "같은 분포" },
    { metric: "총득점 7골+ 비율", role: "reference", min: 0.025, max: 0.045, unit: "ratio", why: "꼬리 — 실제 3~5%. 리드를 쥔 팀이 내려서지 않으면 여기가 먼저 부푼다 (`LEAD_SHOT_LOG_RATE`)" },
    { metric: "팀득점 0골 비율", role: "reference", min: 0.24, max: 0.29, unit: "ratio", why: "실제 1부의 팀별 득점 분포 (팀당 1.45골)" },
    { metric: "팀득점 1골 비율", role: "reference", min: 0.3, max: 0.35, unit: "ratio", why: "같은 분포" },
    { metric: "팀득점 2골 비율", role: "reference", min: 0.21, max: 0.25, unit: "ratio", why: "같은 분포" },
    { metric: "팀득점 3골 비율", role: "reference", min: 0.09, max: 0.13, unit: "ratio", why: "같은 분포" },
    { metric: "팀득점 4골+ 비율", role: "reference", min: 0.04, max: 0.075, unit: "ratio", why: "실제 5~6% — 앞선 팀이 내려서는 몫이 여기를 잡는다 (`LEAD_SHOT_LOG_RATE`)" },
    { metric: "세트피스 득점 비율", role: "reference", min: 0.22, max: 0.32, unit: "ratio", why: "실제 1부가 25~30%(페널티 포함) — 손잡이는 `SET_PIECE_SHOT_SHARE`·`CORNER_XG_BASE`·`PENALTY_PER_MATCH`다. 시드 편차를 양쪽으로 2%p 열어 둔다" },
    { metric: "코너·프리킥 득점/경기", role: "measure", why: "실제 1부가 0.55~0.6 — 위 비율의 큰 몫" },
    { metric: "페널티 득점/경기", role: "reference", min: 0.13, max: 0.24, why: "경기당 페널티 `PENALTY_PER_MATCH`(0.25) × 성공률(0.62~0.80) = 0.16~0.2. 시즌 380경기라 잡음이 15%다" },
    { metric: "팀당 슈팅/경기", role: "measure", why: "위 양 팀 합의 절반 — 분산과 함께 읽는다" },
    { metric: "팀당 슈팅 분산", role: "measure", why: "슈팅이 몇몇 경기에 몰리는지" },
    { metric: "승점 1위", role: "measure", unit: "score", why: "**판정은 `league-spread`가 한다** — 한 리그 한 시즌의 순위별 승점은 시드마다 ±10점이 흔들려 밴드로 걸면 같은 빌드가 빨갛거나 초록이다. 여기서는 그 시즌의 모양을 읽기만 한다" },
    { metric: "승점 4위", role: "measure", unit: "score", why: "같은 이유" },
    { metric: "승점 10위", role: "measure", unit: "score", why: "같은 이유" },
    { metric: "승점 17위", role: "measure", unit: "score", why: "같은 이유" },
    { metric: "승점 최하위", role: "measure", unit: "score", why: "같은 이유" },
    { metric: "리그 승점 표준편차", role: "measure", why: "스무 팀을 다 읽는 눈금 — 두 팀만 읽는 위 다섯보다 훨씬 조용하다. 판정은 `league-spread`" },
    { metric: "옐로/경기", role: "reference", min: 3.7, max: 4.5, why: "실제 1부 — 2023년 판정 지침 뒤 4.1~4.2 (2022-23은 3.6)" },
    { metric: "레드/경기", role: "reference", min: 0.12, max: 0.25, why: "실제 1부 시즌 45~60장" },
    { metric: "옐로/경기 (감독 경기 · 실시간 경기)", role: "measure", why: "리그 38경기 · 카드 130장이라 상대 잡음 9% — 아래 비와 함께 읽는다" },
    { metric: "옐로/경기 (타 팀 경기 · 간이 시뮬)", role: "measure", why: "리그 342경기 — 위 `옐로/경기`를 사실상 이쪽이 정한다" },
    { metric: "옐로 — 감독/타 팀", role: "measure", unit: "ratio", why: "두 시뮬의 눈금이 갈리면 벌어지는 자리. **판정은 `injury-rate`가 한다** — 38경기로는 10~20%의 어긋남이 잡음에 묻힌다" },
    { metric: "레드/경기 (감독 경기 · 실시간 경기)", role: "measure", why: "시즌당 예닐곱 장 — 갈래를 찍기만 한다" },
    { metric: "레드/경기 (타 팀 경기 · 간이 시뮬)", role: "measure", why: "같은 갈래의 반대편" },
    { metric: "감독 팀 순위", role: "measure", unit: "score", why: "지시하지 않는 감독의 성적 — 목표값을 두지 않는다" },
    { metric: "감독 팀 승점", role: "measure", unit: "score", why: "지시하지 않는 감독의 성적 — 목표값을 두지 않는다" },
    { metric: "리그 경기 수", role: "measure", unit: "count", why: "시즌을 끝까지 돌았는지 — 380이어야 한다" },
  ],
});

export const AI_ROTATION = defineHarness({
  id: "ai-rotation",
  what: "AI 스쿼드의 체력 분포와 로테이션 문턱 발동률",
  doc: MATCH,
  cost: "world-season과 같은 시즌을 나눠 쓴다",
  // prettier-ignore
  bands: [
    { metric: "표본 (팀 × 경기일)", role: "measure", unit: "count", why: "감독 경기가 시작되는 순간의 리그를 그대로 읽은 횟수" },
    { metric: "선발 평균 체력", role: "measure", why: "그날 서는 열한 명의 체력" },
    { metric: "1군 체력 ~39 비율", role: "measure", unit: "ratio", why: "탈진 문턱 아래" },
    { metric: "1군 체력 40~59 비율", role: "measure", unit: "ratio", why: "탈진 문턱 위, 피로 문턱 아래" },
    { metric: "1군 체력 60~79 비율", role: "measure", unit: "ratio", why: "피로 문턱이 걸리기 시작하는 구간" },
    { metric: "1군 체력 80~99 비율", role: "measure", unit: "ratio", why: "쉬고 돌아온 몫" },
    { metric: "1군 체력 100 비율", role: "measure", unit: "ratio", why: "한 번도 뛰지 않은 몫" },
    { metric: "피로 문턱↑ 가용 선발 (팀·경기일당)", role: "measure", why: "로테이션이 판단할 기회가 생긴 횟수 — 부상·정지는 뺀다" },
    { metric: "그중 로테이션된 비율", role: "measure", unit: "ratio", why: "문턱 셋이 동시에 걸려야 해서 깊이가 얕은 팀은 통째로 불발한다" },
    { metric: "로테이션 중 탈진 문턱 위 비율", role: "measure", unit: "ratio", why: "문턱 셋 갈래가 확실히 걸린 몫 — 아래는 두 갈래를 밖에서 가를 수 없다" },
  ],
});

/**
 * **승점 곡선을 재는 자리** — `world-season`이 한 시즌을 굴려 세우는 순위별 승점은
 * 시드마다 ±10점씩 흔들려, 세 시즌으로는 잡음이 신호보다 크다. 그래서 판정을 여기로
 * 옮긴다: 같은 시즌들에서 **20팀 38경기 상위 리그 셋**의 순위표를 모아 평균과
 * 표준편차로 읽는다 (`injury-rate`가 카드 판정을 넘겨받은 것과 같은 규칙).
 *
 * 리그를 셋으로 늘리는 데 시즌을 더 돌지 않는다 — 한 세계가 이미 다섯 리그를 굴리고
 * 있고, 그중 20팀 38경기인 셋은 승점이 같은 눈금 위에 선다.
 */
export const LEAGUE_SPREAD = defineHarness({
  id: "league-spread",
  what: "20팀 38경기 상위 리그 셋의 승점 곡선 — 시드 × 리그를 모아 평균과 표준편차로",
  doc: MATCH,
  cost: "world-season과 같은 시즌을 나눠 쓴다",
  // prettier-ignore
  bands: [
    { metric: "표본 (시드 × 리그)", role: "guard", min: 12, unit: "count", why: "**아래로는 판정이 잡음에 묻힌다.** 우승 승점의 리그-시즌 표준편차가 8점쯤이라 표본 12에서 평균의 표준오차가 2.3이고, 아래 밴드의 폭(±5)이 그제야 신호가 된다. 하네스가 도는 시드 수가 아니라 **읽을 수 있는 최소 표본**이다" },
    { metric: "리그당 경기 수 (최소)", role: "guard", min: 380, unit: "count", why: "20팀 더블 라운드로빈 = 380. 한 리그라도 덜 끝났으면 그 순위표는 승점 곡선이 아니다" },
    { metric: "리그 승점 표준편차 (평균)", role: "reference", min: 16, max: 21, why: "**리그가 얼마나 벌어져 있는가 — 이 하네스의 본론.** 스무 팀 승점의 표준편차이고, 실제 1부가 19~20이다(2023-24 EPL 20.1 · 2022-23 19.0). 1위와 10위 둘만 읽는 눈금보다 표본이 열 배라 훨씬 조용하다" },
    { metric: "리그 승점 표준편차 (리그-시즌 σ)", role: "measure", why: "위 평균이 얼마나 흔들리는가 — 실제는 시즌마다 1~2점이다" },
    { metric: "승점 1위 평균", role: "reference", min: 84, max: 94, unit: "score", why: "실제 상위 1부 최근 열 시즌의 우승 승점 평균이 89(EPL 91 · 라리가 89 · 세리에 A 89)다. 한 시즌 값은 81~100까지 흔들리므로 밴드는 **평균에** 건다" },
    { metric: "승점 1위 리그-시즌 σ", role: "measure", unit: "score", why: "실제가 6~7 — 이 값이 더 크면 우승 승점이 리그의 모양이 아니라 굴림에 걸려 있다" },
    { metric: "승점 4위 평균", role: "reference", min: 66, max: 76, unit: "score", why: "실제 최근 다섯 시즌 66~75" },
    { metric: "승점 10위 평균", role: "reference", min: 46, max: 56, unit: "score", why: "실제 최근 다섯 시즌 47~55 — 중위권이 두터워 한 시즌은 크게 흔들린다" },
    { metric: "승점 17위 평균", role: "reference", min: 32, max: 42, unit: "score", why: "실제 최근 다섯 시즌 32~40" },
    { metric: "승점 최하위 평균", role: "reference", min: 14, max: 28, unit: "score", why: "실제 최근 다섯 시즌 16~26, 역대 최저 11" },
    { metric: "승점 최하위 리그-시즌 σ", role: "measure", unit: "score", why: "꼬리가 시즌마다 얼마나 흔들리는가" },
    { metric: "승점 1위 − 10위 평균", role: "measure", unit: "score", why: "이슈가 읽던 폭 — 두 팀만 읽으므로 **위 표준편차와 함께** 읽는다" },
  ],
});

export const ASSIST_RATE = defineHarness({
  id: "assist-rate",
  what: "골에 도움이 붙는 비율",
  doc: MATCH,
  cost: "축소 세계 6시드 · 수 초",
  // prettier-ignore
  bands: [
    { metric: "골", role: "measure", unit: "count", why: "골이 없으면 시험이 성립하지 않는다" },
    { metric: "도움", role: "measure", unit: "count", why: "빈 칸이 아닌 도움만 센다" },
    { metric: "골 대비 도움 비율", role: "guard", min: 0.35, unit: "ratio", why: "설계값 68%(`ASSIST_RATE`)가 만드는 분포. 표본이 작아 하한만 넉넉히 잡는다 — 도움이 사라지는 회귀는 `ratings.test.ts`가 0이 아님으로 못 박는다" },
  ],
});

export const LIVE_MATCH_STATS = defineHarness({
  id: "live-match-stats",
  what: "실시간 경기의 팀 통계 — 득점 분포·슈팅·xG·패스·점유·수비·규율·거리의 평균·중간값·sd",
  doc: "docs/match/football-reference.md",
  cost: "시드 세계 셋 × 리그 12경기 = 36경기 · 10분",
  // prettier-ignore
  bands: [
    { metric: "팀-경기 표본", role: "measure", unit: "count", why: "아래 밴드의 폭은 이 표본(72)의 잡음을 넣어 잡았다 — 팀 득점 평균의 표준오차가 0.15다" },
    { metric: "팀 득점 평균", role: "guard", min: 1.1, max: 1.75, why: "[FD] 1.41 — 표준오차 0.15의 두 배를 연다" },
    { metric: "팀 득점 sd", role: "reference", min: 0.95, max: 1.55, why: "[FD] 1.25 — 분산 ≈ 평균(푸아송)의 꼴" },
    { metric: "팀 득점 0골", role: "reference", min: 0.16, max: 0.36, unit: "ratio", why: "[FD] 25.8%" },
    { metric: "팀 득점 1골", role: "reference", min: 0.24, max: 0.44, unit: "ratio", why: "[FD] 34.0%" },
    { metric: "팀 득점 2골", role: "reference", min: 0.14, max: 0.32, unit: "ratio", why: "[FD] 23.1%" },
    { metric: "팀 득점 3골", role: "reference", min: 0.04, max: 0.18, unit: "ratio", why: "[FD] 10.6%" },
    { metric: "팀 득점 4골+", role: "guard", max: 0.14, unit: "ratio", why: "[FD] 6.5% — 꼬리가 부풀면 수비가 무너진 것이다" },
    { metric: "홈 득점 − 원정 득점", role: "measure", why: "[FD] 0.28 — 36경기로는 잡음(±0.4)이 커서 판정은 `sim-parity`의 몫이다" },
    { metric: "슈팅 평균", role: "guard", min: 10, max: 15.5, why: "[FD] 12.6 — sd 5.2의 표준오차 0.6에 팀 편차를 얹는다" },
    { metric: "슈팅 중간값", role: "reference", min: 9, max: 15, why: "[FD] 12" },
    { metric: "슈팅 sd", role: "reference", min: 3.5, max: 7, why: "[FD] 5.24 — p10 6 · p90 19" },
    { metric: "유효슈팅 비율", role: "reference", min: 0.28, max: 0.43, unit: "ratio", why: "[FD] 35.1%" },
    { metric: "골/유효슈팅", role: "reference", min: 0.24, max: 0.4, unit: "ratio", why: "[FD] 32% — 골키퍼의 선방 눈금" },
    { metric: "xG 평균", role: "guard", min: 1.15, max: 1.85, why: "[US] 1.49 (페널티 포함)" },
    { metric: "xG sd", role: "reference", min: 0.6, max: 1.25, why: "[US] 0.92" },
    { metric: "슈팅당 xG", role: "reference", min: 0.09, max: 0.15, why: "[US] 0.12 — 슈팅 자리의 분포가 실측과 닮았는가" },
    { metric: "득점/xG", role: "guard", min: 0.75, max: 1.25, unit: "ratio", why: "xG가 기록이 되려면 골과 같은 눈금이어야 한다 — 골은 공의 경로가 정한다 (live-match.md §5.4)" },
    { metric: "패스 시도 평균", role: "reference", min: 380, max: 580, why: "[SB]·[FM] 467~471" },
    { metric: "패스 시도 sd", role: "reference", min: 60, max: 160, why: "[SB] 120 — 점유형과 내려앉는 팀의 폭" },
    { metric: "패스 성공률", role: "reference", min: 0.78, max: 0.88, unit: "ratio", why: "[FM] Opta 눈금 82.9%" },
    { metric: "패스 성공률 sd", role: "reference", min: 0.04, max: 0.08, unit: "ratio", why: "[FM] 팀 간 sd 4.9%p (72.3~90.5%) — 팀-경기의 퍼짐은 그 위에 경기의 흔들림이 얹힌다. 평균만 맞고 퍼짐이 좁으면 패서의 능력이 공을 움직이지 못하는 것이다" },
    { metric: "점유율 sd", role: "guard", min: 0.05, max: 0.16, unit: "ratio", why: "[SB] 11%p — 0에 붙으면 전력·전술이 공을 움직이지 못하는 것이다" },
    { metric: "태클 시도", role: "reference", min: 12, max: 24, why: "[SB] 19.7 · Opta 16~18" },
    { metric: "태클 성공률", role: "reference", min: 0.5, max: 0.7, unit: "ratio", why: "[SB] 61% · Opta 팀별 56~62%" },
    { metric: "인터셉트", role: "reference", min: 5, max: 14, why: "[FM] Opta 8.3 · [SB] 12.0" },
    { metric: "드리블 시도", role: "reference", min: 10, max: 26, why: "[SB] 17.6" },
    { metric: "파울", role: "reference", min: 8, max: 16, why: "[FD] 11.95" },
    { metric: "경고", role: "reference", min: 1.3, max: 2.8, why: "[FD] 2.07" },
    { metric: "퇴장", role: "reference", max: 0.25, why: "[FD] 0.10 — 36경기면 일곱 장쯤" },
    { metric: "코너", role: "reference", min: 3.3, max: 6.5, why: "[FD] 4.86" },
    { metric: "크로스", role: "reference", min: 7, max: 17, why: "[SB] 12.0" },
    { metric: "오프사이드", role: "reference", min: 0.8, max: 4, why: "[SB] 2.3" },
    { metric: "팀 총 거리 (km)", role: "guard", min: 104, max: 122, why: "football-reference §7 팀 합계 110~117 km — 교체 선수 몫이 얹힌다" },
    { metric: "팀 스프린트 거리 (km)", role: "reference", min: 1.8, max: 4.2, why: "§7-B 포지션별 스프린트 거리의 합 (>25.2 km/h)" },
    { metric: "경기 길이 (분)", role: "reference", min: 95, max: 103, why: "EPL 추가시간 포함 96~101분" },
    { metric: "볼 인플레이 몫", role: "reference", min: 0.5, max: 0.66, unit: "ratio", why: "EPL 55~59% — 재시작의 멈춤이 경기의 리듬을 정한다" },
    { metric: "슈팅 순간 골 쪽 수비 수", role: "reference", min: 3.2, why: "히트맵 이전의 실시간 경기 2.8 — 슛 길목·존 커버가 골 앞을 채우면 는다 (live-match.md §5.2)" },
    { metric: "슈팅 순간 골 쪽 수비 수 sd", role: "measure", why: "슛마다의 퍼짐 — 역습의 빈 골문과 내려앉은 블록이 함께 있어야 한다" },
    { metric: "풀백 깊이 폭 (p10~p90, m)", role: "reference", min: 37, why: "히트맵 이전 35.2m — 풀백의 분포는 자기 박스 근처부터 상대 진영까지다 (live-match.md §3.3)" },
    { metric: "풀백 깊이 폭 sd (m)", role: "measure", why: "풀백마다의 퍼짐 — 윙백과 노-넌센스 풀백이 갈려야 역할이 공간에 선다" },
    { metric: "풀백 앞 끝 (p90 깊이, m)", role: "reference", min: 55, why: "히트맵 이전 52.2m — 공이 전진하면 가담 성분이 무거워진다" },
    { metric: "풀백 오버래핑·침투 (회/90분)", role: "measure", why: "공을 가졌을 때 풀백이 달리기를 시작한 수 — 히트맵 이전 오버래핑은 판단당 확률 분기였다" },
    { metric: "풀백 오버래핑·침투 sd", role: "measure", why: "풀백마다의 퍼짐 — 윙백은 자주, 노-넌센스 풀백은 드물게" },
  ],
});

export const LIVE_PLAYER_LOAD = defineHarness({
  id: "live-player-load",
  what: "풀타임 선수의 포지션별 총 거리·고속·스프린트 — 실측과 기대 부하표에 서는가",
  doc: "docs/match/football-reference.md §7",
  cost: "시드 세계 둘 × 리그 8경기 = 16경기 · 5분",
  // prettier-ignore
  bands: [
    { metric: "풀타임 표본", role: "measure", unit: "count", why: "교체·퇴장·부상으로 나간 선수는 뺀다 — 90분을 다 뛴 몸만 잰다" },
    { metric: "골키퍼 거리 (km)", role: "reference", min: 4.3, max: 6.5, why: "§7-B 5.3 (추정)" },
    { metric: "센터백 거리 (km)", role: "guard", min: 9.2, max: 11.4, why: "§7-A 10.21 ± 0.64 — 가장 덜 뛰는 필드 자리" },
    { metric: "풀백 거리 (km)", role: "reference", min: 9.8, max: 12, why: "§7-A 10.75 ± 0.56" },
    { metric: "중앙 미드 거리 (km)", role: "guard", min: 10.5, max: 12.9, why: "§7-A 11.66 ± 0.92 — 가장 많이 뛰는 자리. 센터백보다 1km 넘게 더 뛰어야 포지션이 몸에 선다" },
    { metric: "측면 거리 (km)", role: "reference", min: 10, max: 12.2, why: "§7-A 11.07 ± 0.73" },
    { metric: "공격수 거리 (km)", role: "reference", min: 9.6, max: 12, why: "§7-A 10.86 ± 0.80" },
    { metric: "센터백 고속 (m)", role: "reference", min: 400, max: 800, why: "§7-B 550~650 (19.8~25.2 km/h)" },
    { metric: "풀백 고속 (m)", role: "reference", min: 600, max: 1100, why: "§7-B 800~900" },
    { metric: "중앙 미드 고속 (m)", role: "reference", min: 550, max: 1050, why: "§7-B 750~850" },
    { metric: "측면 고속 (m)", role: "reference", min: 650, max: 1200, why: "§7-B 850~950" },
    { metric: "공격수 고속 (m)", role: "reference", min: 450, max: 950, why: "§7-B 650~750" },
    { metric: "센터백 스프린트 (m)", role: "reference", min: 60, max: 260, why: "§7-B 120~180 (>25.2 km/h) — 오른쪽으로 치우친 분포" },
    { metric: "측면 스프린트 (m)", role: "reference", min: 220, max: 600, why: "§7-B 350~450 — 센터백의 두 배를 넘어야 한다" },
    { metric: "실측/기대 부하표 — 거리", role: "guard", min: 0.88, max: 1.12, unit: "ratio", why: "간이 시뮬과 정산이 읽는 `EXPECTED_LOAD`가 실시간 경기가 실제로 뛴 것과 같은 눈금인가 — 갈리면 감독의 선수만 다른 몸으로 시즌을 난다" },
  ],
});

export const LIVE_TACTICS = defineHarness({
  id: "live-tactics",
  what: "홈 팀 전술 하나만 바꿔 굴렸을 때 슈팅·xG·점유·거리가 예상한 방향으로 움직이는가",
  doc: "docs/match/live-match.md §6",
  cost: "시드 둘 × 리그 12경기 × 팔 다섯 = 120경기 · 30분",
  // prettier-ignore
  bands: [
    { metric: "기준 — 우리 슈팅", role: "measure", why: "아래 변화들의 눈금 — 전술을 건드리지 않은 판" },
    { metric: "기준 — 우리 xG", role: "measure", why: "같은 판" },
    { metric: "멘탈리티 5 — 우리 슈팅 변화", role: "guard", min: 0.5, why: "공격 가담·위험 감수·슈팅 문턱이 함께 움직인다 — 슈팅이 늘지 않으면 멘탈리티는 장식이다" },
    { metric: "멘탈리티 5 — 우리 xG 변화", role: "reference", min: 0, why: "슈팅만이 아니라 기회의 질까지 올라야 한다" },
    { metric: "멘탈리티 5 — 상대 xG 변화", role: "measure", why: "대가 — 올라선 뒤가 빈다. 0 위면 대가가 선 것이다" },
    { metric: "압박 5 — 우리 거리 변화 (km)", role: "guard", min: 1, why: "압박은 뛰는 것이다 — 팀 합이 1km도 늘지 않으면 압박 지시가 말에 닿지 않는다" },
    { metric: "압박 5 — 상대 패스 변화", role: "reference", max: 0, why: "공을 돌릴 시간을 뺏는다" },
    { metric: "압박 5 — 우리 점유 변화", role: "measure", unit: "ratio", why: "높은 곳에서 되찾으면 오르고, 뒤를 뚫리면 내린다 — 방향을 걸지 않는다" },
    { metric: "수비 라인 1 — 상대 점유 변화", role: "reference", min: 0, unit: "ratio", why: "내려앉으면 공을 내준다" },
    { metric: "수비 라인 1 — 상대 xG 변화", role: "measure", why: "내려앉은 블록이 기회를 줄이는지는 상대의 몫이다" },
    { metric: "템포 5 — 우리 패스 변화", role: "measure", why: "판단 간격이 짧아진다 — 패스가 늘거나, 직접성이 올라 줄 수도 있다" },
    { metric: "템포 5 — 우리 슈팅 변화", role: "measure", why: "같은 팔의 결과" },
  ],
});

export const SIM_PARITY = defineHarness({
  id: "sim-parity",
  what: "같은 대진을 실시간 경기와 간이 시뮬로 굴렸을 때 득점·xG·슈팅·홈 이점·전력 기울기가 같은 눈금인가",
  doc: "docs/match/match.md §8.5",
  cost: "시드 세계 셋 × 리그 24경기 = 72경기 + 간이 1440판 · 20분",
  // prettier-ignore
  bands: [
    { metric: "대진", role: "measure", unit: "count", why: "실시간 한 판씩 — 아래 비의 잡음은 이 수가 정한다" },
    { metric: "팀 득점 — 실시간", role: "measure", why: "같은 대진의 팀-경기 평균" },
    { metric: "팀 득점 — 간이", role: "measure", why: "같은 대진을 간이 시뮬로 굴린 평균" },
    { metric: "팀 득점 — 실시간/간이", role: "guard", min: 0.75, max: 1.33, unit: "ratio", why: "감독의 경기만 다른 리그가 되지 않게 — 표본의 잡음(72경기 ±9%)에 실제 어긋남을 얹은 폭" },
    { metric: "팀 xG — 실시간", role: "measure", why: "같은 대진" },
    { metric: "팀 xG — 간이", role: "measure", why: "같은 대진" },
    { metric: "팀 xG — 실시간/간이", role: "guard", min: 0.75, max: 1.33, unit: "ratio", why: "득점보다 조용한 연속값 — 두 시뮬의 기회 총량이 같은가" },
    { metric: "팀 슈팅 — 실시간/간이", role: "reference", min: 0.7, max: 1.4, unit: "ratio", why: "간이 시뮬의 슈팅은 실측 12.6에 서 있다" },
    { metric: "홈 xG 우위 — 실시간", role: "measure", why: "원정 체력 감점만이 홈 이점이다 (live-match.md §7)" },
    { metric: "홈 xG 우위 — 간이", role: "measure", why: "`QUICK_HOME_FACTOR` — 실측 홈/원정 xG 1.67/1.32" },
    { metric: "전력 기울기 (xG 차/능력치 1) — 실시간", role: "measure", why: "선발 평균 종합 능력치 1의 차가 xG 차를 얼마나 벌리는가" },
    { metric: "전력 기울기 (xG 차/능력치 1) — 간이", role: "measure", why: "같은 기울기 — 간이 시뮬의 `QUICK_RATING_SLOPE`가 정한다" },
    { metric: "전력 기울기 표준오차 — 실시간", role: "measure", why: "기울기 추정의 잡음 — 이것이 기울기 자체의 절반을 넘으면 아래 비는 읽을 수 없다" },
    { metric: "전력 기울기 — 실시간/간이", role: "reference", min: 0.5, max: 2, unit: "ratio", why: "능력 차가 결과로 옮겨지는 정도가 두 시뮬에서 같은 크기인가 — 간이 시뮬의 기울기는 리그 팀 간 xG sd 0.40에 서 있다(match.md §8.2). 대진 24개로는 같은 설정에서 20~80%로 흔들려 72개로 잰다" },
  ],
});

export const INJURY_RATE = defineHarness({
  id: "injury-rate",
  what: "간이 시뮬의 경기당 부상·카드 — 기대한 눈금에 서는가 · 성향이 빈도에 닿는 폭 · 위험 등급별 실제 부상률 · 누적 피로가 굴림에 닿는 폭",
  doc: MATCH,
  cost: "간이 시뮬 72,000판 · 2~3분",
  // prettier-ignore
  bands: [
    { metric: "경기 강도 (양 팀 평균)", role: "measure", why: "`matchIntensity` — 카드·부상 기대치가 이 배수를 탄다" },
    { metric: "경기당 부상 건수 (간이)", role: "measure", why: "양 팀 합" },
    { metric: "부상 기대 대비 배율 (간이)", role: "guard", min: 0.85, max: 1.15, why: "기대 = `teamInjuryRate`(강도·성향 포함)의 양 팀 합. 손잡이에서 유도하므로 눈금을 옮겨도 따라온다" },
    { metric: "경기당 카드 (간이)", role: "measure", why: "양 팀 합 — 경고 + 퇴장 줄 수" },
    { metric: "카드 기대 대비 배율 (간이)", role: "guard", min: 1, max: 1.1, why: "기대 = `teamCardRate`(카드 **사건** 수)의 양 팀 합. 실측은 장부의 **줄** 수라 두 번째 경고가 두 줄(경고+퇴장)로 세어져 4% 위에 선다 — `STRAIGHT_RED_CHANCE`·`BOOKED_AGAIN_WEIGHT`를 만지면 여기가 먼저 움직인다" },
    { metric: "유리몸 팀 배율", role: "guard", min: 1.3, why: "선발 전원 성향 2.2일 때 건강한 팀 대비 — 성향이 빈도에 닿는지" },
    { metric: "유리몸 한 명의 부상 점유율", role: "guard", min: 0.08, unit: "ratio", why: "뛴 선수(선발 11 + 교체 최대 5) 중 한 명이면 균등은 6~7% — 성향 2.2가 그 위로 띄운다" },
    { metric: "위험 낮음 인원", role: "guard", min: 1, unit: "count", why: "등급을 갈라 심은 선발 열한(4·4·3) 중 실제로 그 등급에 선 인원. **경계가 분포에서 떨어지면 여기가 먼저 빨개진다** — 셋 중 하나라도 0이면 아래 비는 잴 대상이 없다" },
    { metric: "위험 보통 인원", role: "guard", min: 1, unit: "count", why: "같은 이유 — 가운데 등급이 비면 세 칸이 두 칸이 된다" },
    { metric: "위험 높음 인원", role: "guard", min: 1, unit: "count", why: "같은 이유" },
    { metric: "1인당 부상률 — 위험 낮음", role: "measure", unit: "ratio", why: "선수 하나가 한 경기에 다칠 확률 — 세 등급을 나란히 읽는다" },
    { metric: "1인당 부상률 — 위험 보통", role: "measure", unit: "ratio", why: "같은 눈금" },
    { metric: "1인당 부상률 — 위험 높음", role: "measure", unit: "ratio", why: "같은 눈금" },
    { metric: "부상률 — 보통/낮음", role: "guard", min: 1.25, unit: "ratio", why: "등급이 **실제 부상률과 같은 순서로 서는가** (player.md §5.3). 추첨이 저울에 비례하므로 기대는 1.6배쯤이고, 낮음 쪽 표본이 팔당 140건이라 잡음이 10%다 — 밴드는 그 아래에 둔다" },
    { metric: "부상률 — 높음/낮음", role: "guard", min: 2.4, unit: "ratio", why: "같은 판정의 본론. 저울의 비가 3.2배쯤이라 **순서만 서면 넉넉히 넘는다** — 여기가 무너졌다면 경계가 분포에서 떨어져 나갔거나 저울의 항이 움직인 것이다" },
    { metric: "1인당 부상률 — 잔고 0", role: "measure", unit: "ratio", why: "체력·몸싸움·성향을 눕히고 **누적 피로만** 갈라 세운 팔의 기준선 (player.md §5.5)" },
    { metric: "1인당 부상률 — 잔고 70", role: "measure", unit: "ratio", why: "같은 팔의 반대편 — 시즌을 갈려 나간 몸" },
    { metric: "부상률 — 잔고 70/0", role: "guard", min: 1.2, unit: "ratio", why: "**시즌의 잔고가 굴림에 닿는가.** 저울의 비가 (40+21+8.7)/(40+8.7) ≈ 1.43이고, 다섯·여섯 명씩의 팔이라 잡음이 10%다 — 밴드는 그 아래에 둔다. 여기가 1에 붙으면 `INJURY_LOAD_WEIGHT`가 굴림에 못 닿고 있다는 뜻이고, 그러면 시즌 내내 뛴 열한 명과 로테이션 자원의 부상 위험이 같다" },
  ],
});

export const FINANCE_TIER1 = defineHarness({
  id: "finance-tier1",
  what: "tier1 유저 구단의 한 시즌 살림 — 장부 손익 · 현금 · 급여 비중 · 수입",
  doc: `${FINANCE}.1`,
  cost: "전체 세계 한 시즌 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "시즌 1 보고서 수", role: "guard", min: 10, unit: "count", why: "한 시즌을 다 돌지 못하면 나머지가 전부 헛값이다" },
    { metric: "연 장부 손익", role: "reference", min: -30_000_000, max: 70_000_000, unit: "money", why: "**밴드의 기준 축.** PSR 위반선(시즌 평균 −£35M) 바로 위부터, 흑자만으로 이적 예산이 무한히 불어나지 않는 선까지. 상단은 한 시즌이 12개월이 되며 +£40M에서 옮겼다 — 마지막 달이 시즌 안에서 마감되고(finance.md §7.1) 그 달이 순위·컵 상금을 진다" },
    { metric: "연 현금 순증", role: "guard", min: 85_000_000, max: 260_000_000, unit: "money", why: "이적 활동이 지배하는 축이라 밸런스를 판정하지 않는다 — 시즌이 제대로 돌았는지의 난간. 상단은 11개월 시절 천장까지의 여유(31%)를 12개월에 그대로 옮긴 값이다" },
    { metric: "연 수입", role: "guard", min: 300_000_000, unit: "money", why: "실제 상위 구단 £400–700M의 6–7할" },
    { metric: "연 지출", role: "measure", unit: "money", why: "수입과 함께 읽는다 — 손익의 분해" },
    { metric: "연 상각", role: "measure", unit: "money", why: "실제 구단은 비용의 3할 안팎" },
    { metric: "경기 달 수", role: "guard", min: 9, unit: "count", why: "프리시즌 달은 매치데이가 없어 급여 비중 대상에서 뺀다" },
    { metric: "경기 달 급여 비중 (최저)", role: "guard", min: 0.2, unit: "ratio", why: "실제 EPL 평균 ~70%의 아래쪽 폭" },
    { metric: "경기 달 급여 비중 (최고)", role: "guard", max: 0.95, unit: "ratio", why: "실제 EPL 평균 ~70%의 위쪽 폭" },
  ],
});

export const FINANCE_LEAGUES = defineHarness({
  id: "finance-leagues",
  what: "한 시즌 뒤 리그별 잔고 — 어느 리그도 구조적 적자가 아니다",
  doc: `${FINANCE}.3`,
  cost: "finance-tier1과 같은 시즌을 나눠 쓴다",
  // prettier-ignore
  bands: [
    { metric: "리그별 중간 잔고의 최소", role: "guard", min: 0, unit: "money", why: "약체 리그가 구조적 적자면 이적 시장이 왜곡된다 (불변식 1)" },
    { metric: "리그별 최저 잔고의 최소", role: "guard", min: -30_000_000, unit: "money", why: "한 구단이 파산 수준으로 가라앉지 않는 선" },
  ],
});

export const FINANCE_MULTI_SEASON = defineHarness({
  id: "finance-multi-season",
  what: "세 시즌을 굴려도 가라앉는 리그도, 돈만 쌓는 리그도 없다",
  doc: `${FINANCE}.3`,
  cost: "전체 세계 세 시즌 · 십수 분",
  // prettier-ignore
  bands: [
    { metric: "도달한 시즌", role: "guard", min: 4, unit: "count", why: "세 시즌은 리그가 가라앉는지 보이는 가장 짧은 창이다" },
    { metric: "리그별 중간 잔고의 최소", role: "guard", min: 0, unit: "money", why: "한 시즌은 발산을 감추기에 충분히 짧다 (불변식 1). 자유계약·시장 전용 리그는 클럽이 아니라 대상 밖" },
    { metric: "1부 중간 잔고 ÷ 중간 연 매출의 최대", role: "guard", max: 1, unit: "ratio", why: "불변식 2의 천장 — 바닥만 재던 자리다. 한 해 버는 것보다 많은 현금을 들고 앉은 리그는 잉여가 이적 시장으로 돌아오지 않는다는 뜻이고, 그러면 PSR도 예산도 죽은 코드가 된다. **1부로 좁혀 판정하는 것은 중간값이 스무 구단 £100M대라 시드에 흔들리지 않기 때문**이다 — 두 시드 실측 0.91·0.86 (finance.md §10.3)" },
    { metric: "전 리그 중간 잔고 ÷ 중간 연 매출의 최대", role: "reference", max: 1, unit: "ratio", why: "같은 불변식을 하위 리그까지 넓힌 값. 판정하지 않는 것은 리그 2·세군다의 중간값이 £10M대라 이적 두어 건에 수십 %씩 흔들려, 가드로 세우면 재정 모델이 아니라 그해 시장 운을 재기 때문이다 — 두 시드 실측 0.99·1.28" },
    { metric: "천장에 가장 가까운 리그의 중간 잔고", role: "measure", unit: "money", why: "위 두 비율이 어느 규모에서 나온 값인가 — 작은 리그의 얇은 매출은 같은 비율도 다른 뜻이다" },
  ],
});

export const FINANCE_SECOND_TIER = defineHarness({
  id: "finance-second-tier",
  what: "리그전을 굴리지 않는 2부의 한 시즌 수지",
  doc: "docs/negotiation/finance.md §9.5",
  cost: "전체 세계 한 시즌 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "2부 구단 수", role: "guard", min: 10, unit: "count", why: "표본이 없으면 중간값이 뜻을 잃는다" },
    { metric: "2부 한 시즌 수지 중간값", role: "guard", min: -8_000_000, unit: "money", why: "균형이 아니라 **수입원의 존재**를 지킨다 — 이 선이 깨지면 매치데이 보정이 사라졌다는 뜻이다" },
  ],
});

export const AI_FITNESS = defineHarness({
  id: "ai-fitness",
  what: "한 시즌을 돈 뒤의 AI 스쿼드 체력·출전 분포",
  doc: MATCH,
  cost: "전체 세계 한 시즌 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "상대 상위 14명 체력 (최저 팀)", role: "guard", min: 70, why: "라인업에 설 14명이 어느 시점에도 쓸 만해야 한다" },
    { metric: "우리와 상대의 체력 격차", role: "guard", max: 10, why: "하루 회복이 우리 팀에만 있던 시절 이 차이가 20을 넘었다" },
    { metric: "한 시즌 출전 인원 (맨시티)", role: "guard", min: 18, unit: "count", why: "열한 명이 다 뛰면 로테이션이 없는 것이다" },
    { metric: "개막 잔고 — 친선 3경기 이상", role: "measure", unit: "score", why: "친선 넷을 다 치른 몸이 개막 아침에 지고 있는 누적 피로 (player.md §5.5)" },
    { metric: "개막 잔고 — 친선 0경기", role: "measure", unit: "score", why: "한 경기도 안 뛴 몸이 어디에 서는가 — 본훈련 세션만 쌓은 자리라 「가뿐」(28) 안쪽이어야 정상이다" },
    { metric: "개막 잔고 차 (친선 3+ vs 0)", role: "guard", min: 10, unit: "score", why: "이 값이 0이면 프리시즌이 몸에 관해 아무것도 결정하지 않는 것이다 — 이 축이 존재하는 이유 자체의 단일 지표 (#539). ⚠️ 그 질문을 지던 「경기 감각」은 걷힌 축이다 — 지금 친선이 몸에 남기는 것은 누적 피로이고(player.md §5.5), 적응도 쪽은 친선을 뛰었는지가 아니라 여름을 클럽 밖에서 보냈는지가 가른다(§7.4)" },
    { metric: "개막의 두 무리를 잰 인원", role: "measure", unit: "count", why: "두 무리가 비어 있으면 위 세 값이 뜻을 잃는다" },
    { metric: "개막 적응도 (상위 14명)", role: "measure", unit: "score", why: "새 게임의 개막 아침은 전원이 기준선에서 출발해 프리시즌의 하루하루가 얹은 자리다 — 여름 휴가가 이 축을 끌고 가는 것은 시즌 2부터라(player.md §7.4) 시즌 하나를 도는 이 하네스는 판정하지 않는다" },
    { metric: "시즌 말 적응도 (상위 14명)", role: "guard", min: 70, unit: "score", why: "시즌을 돈 주전은 개막보다 판을 잘 알아야 한다 — 아래로 새면 결장 감쇠(player.md §7.4)가 적립을 이기고 있다" },
    { metric: "우리와 상대의 적응도 격차", role: "guard", max: 10, unit: "score", why: "체력 격차와 같은 이유 — 이 축이 감독 팀에만 걸리면 리그 절반이 다른 규칙으로 무뎌진다. ⚠️ 감독 팀의 적응도를 올리는 것은 결산 판정(LLM)뿐이라, 판정이 없는 이 하네스는 리그가 쓰는 그 규칙으로 대역을 세운다 (balance-harness.md §4)" },
    { metric: "시즌 말 누적 피로 — 우리 상위 11", role: "measure", unit: "score", why: "마지막 경기에서 며칠 지난 자리라 이미 빠지는 중이다 — 판정하지 않고 봉우리와 나란히 읽는다" },
    { metric: "시즌 말 누적 피로 — 상대 상위 11", role: "measure", unit: "score", why: "로테이션하는 팀이 어디에 서는가 — 우리 값과 나란히 읽는다" },
    { metric: "우리와 상대의 피로 격차", role: "guard", max: 30, unit: "score", why: "체력·적응도 격차와 같은 이유이되 폭이 넓다 — AI는 「지침」(50)에서 자리를 내주고 하네스의 감독 팀은 내주지 않으므로 **차이가 나는 것이 정상**이다. 이 가드가 잡는 것은 AI가 아예 쌓지 않는 경우(그때 격차는 우리 잔고 전부다)" },
    { metric: "과부하 인원 (상대 최다 팀)", role: "measure", unit: "count", why: "AI 로테이션이 「지침」에서 자리를 내주므로 대개 0에 가깝다 — 여기가 두 자리로 뜨면 로테이션이 잔고를 못 읽고 있다" },
    { metric: "시즌 중 잔고 봉우리 — 우리 상위 11", role: "guard", min: 50, max: 90, unit: "score", why: "**이 축의 본론.** 시즌 말 스냅숏은 마지막 경기 며칠 뒤라 이미 회복돼 있어 연전 구간이 안 보인다. 같은 XI로 한 시즌을 버틴 팀은 연전이 겹치는 구간에서 「지침」(50)을 넘어야 하고, 천장에 박히면(90+) 감독이 손쓸 여지가 없다" },
    { metric: "시즌 중 잔고 봉우리 — 상대 상위 11", role: "measure", unit: "score", why: "로테이션하는 팀의 봉우리 — 우리보다 낮아야 로테이션이 값을 한 것이다" },
    { metric: "시즌 중 과부하 인원 (우리 최다)", role: "measure", unit: "count", why: "한날 「과부하」에 함께 선 인원의 최댓값 — 스쿼드가 통째로 그 등급이면 불만이 라커룸 전체에 걸린다" },
    { metric: "시즌 중 체력 바닥 — 상대 상위 14 (최저일)", role: "guard", min: 70, why: "**잔고가 회복을 늦추므로 이 축이 세면 12월에 선수단이 통째로 눕는다** (match.md §3.1). 첫 가드가 묻는 「어느 시점에도 쓸 만한가」의 **그 어느 시점**이고, 시즌 말 스냅숏은 그 자리가 아니다. 감독 팀에 대지 않는 것은 이 하네스가 시즌 내내 같은 XI를 세워 나머지 열넷이 늘 신선하기 때문이다" },
  ],
});

export const AI_BENCH = defineHarness({
  id: "ai-bench",
  what: "감독의 경기에서 상대 벤치가 쓰는 교체 수·시점·갈래",
  doc: "docs/match/match.md §2",
  cost: "시드당 수십 초 × 2시드",
  // prettier-ignore
  bands: [
    { metric: "AI 교체/경기", role: "guard", min: 3.5, max: 5, unit: "count", why: "실제 1부는 5인 교체제에서 4.3 — 정지점을 창으로 세는 정책(SUB_WINDOW_MAX·SUB_CHANCE·SUB_FATIGUE)이 그 부근에 세운다. 한도(5)는 장부가 막는다" },
    { metric: "승부수 교체/경기", role: "measure", unit: "count", why: "스코어를 읽은 갈래가 실제로 얼마나 쓰이는가" },
    { metric: "굳히기 교체/경기", role: "measure", unit: "count", why: "리드를 지키는 갈래 — 승부수보다 드물어야 정상이다" },
    { metric: "체력 교체/경기", role: "measure", unit: "count", why: "예전부터 있던 갈래 — 스코어 갈래가 이걸 밀어내지 않았는지" },
    { metric: "부상 교체/경기", role: "measure", unit: "count", why: "INJURY_PER_MATCH의 파생 — 다치면 언제나 뺀다" },
    { metric: "끝까지 뒤진 경기에서 승부수를 던진 비율", role: "guard", min: 0.5, unit: "ratio", why: "0이면 이 기능이 죽은 것이다 — 벤치가 스코어를 읽는가의 단일 지표" },
    { metric: "끝까지 앞선 경기에서 굳힌 비율", role: "measure", unit: "ratio", why: "굳히기는 75′이고 교체 카드를 먼저 쓴 팀은 못 쓴다" },
    { metric: "AI 교체의 60′ 이후 비율", role: "reference", min: 0.5, max: 0.95, unit: "ratio", why: "실제 교체는 후반에 몰린다 — 전부 후반이면 하프타임 갈래가 죽은 것이다" },
    { metric: "AI 교체 중앙 분", role: "measure", unit: "score", why: "실제 1부는 60분대 — 우리는 정지점(골·조용한 25분)이 후반에 몰려 그보다 뒤다" },
    { metric: "판의 모양을 바꾼 경기 비율", role: "measure", unit: "ratio", why: "경기당 한 번 — 스코어가 벌어진 경기에서만 선다" },
    { metric: "잰 경기 수", role: "measure", unit: "count", why: "표본이 있는가" },
  ],
});

export const AI_MARKET = defineHarness({
  id: "ai-market",
  what: "한 시즌의 AI↔AI 시장 규모",
  doc: "docs/negotiation/transfer.md §10",
  cost: "전체 세계 한 시즌 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "총 이동", role: "measure", unit: "count", why: "이적 + 임대 — 팀당 값의 분모가 아니라 규모 그 자체" },
    { metric: "1부 팀당 이적", role: "guard", min: 1, max: 6, why: "실제 시장과 같은 자릿수" },
    { metric: "1부 팀당 임대", role: "guard", min: 0.5, max: 4, why: "실제 시장과 같은 자릿수" },
    { metric: "여름 비중", role: "guard", min: 0.5, unit: "ratio", why: "실제 시장의 여름:겨울은 7:3" },
  ],
});

export const SQUAD_LONGEVITY = defineHarness({
  id: "squad-longevity",
  what: "15시즌을 넘긴 뒤에도 구단이 선발 XI·계약을 세우는가 · 리그 체급의 드리프트",
  doc: "docs/common/season.md §6·§9",
  cost: "세계 하나 · 월간 성장 180번 + 전환 15번 · 약 30초",
  // prettier-ignore
  bands: [
    { metric: "클럽 수", role: "guard", min: 100, unit: "count", why: "표본이 없으면 아래 네 줄이 공허하게 통과한다 — 시드 세계의 클럽 수보다 넉넉히 아래" },
    { metric: "선발 XI가 11이 아닌 구단", role: "guard", max: 0, unit: "count", why: "열한 명을 못 세우는 구단이 하나라도 생기면 그 리그는 경기를 치를 수 없다" },
    { metric: "GK 없는 구단", role: "guard", max: 0, unit: "count", why: "골문은 대체할 자리가 없다 — 은퇴가 유스 콜업보다 빠를 때 가장 먼저 마르는 자리" },
    { metric: "보유하지 않은 선수를 가리키는 배치", role: "guard", max: 0, unit: "count", why: "은퇴·이적으로 떠난 선수가 배치에 남아 있으면 라인업이 유령을 세운다" },
    { metric: "활성 계약 없는 선수", role: "guard", max: 0, unit: "count", why: "소속과 계약은 한 쌍이다 — 갈라지면 주급도 이적료도 계산되지 않는다" },
    { metric: "구단당 평균 스쿼드 인원", role: "measure", why: "스쿼드가 말라가는지 — 지키려는 값이 아니라 재려는 값" },
    { metric: "가장 얕은 스쿼드 인원", role: "measure", unit: "count", why: "평균은 한 구단의 고갈을 감춘다" },
    { metric: "가장 얕은 GK 보유", role: "measure", unit: "count", why: "1이면 버틴 것이고 2면 숫자가 살아 있다" },
    { metric: "스쿼드 평균 나이", role: "measure", why: "은퇴와 콜업의 균형 — 해마다 오르면 언젠가 선발 XI가 깨진다" },
    { metric: "리그 1군 상위 15 종합 — 시작", role: "measure", unit: "score", why: "체급의 출발선 — 아래 두 줄을 읽을 자 (`overall-scale`이 이 분포의 원본을 잰다)" },
    { metric: "리그 1군 상위 15 종합 — 15시즌 뒤", role: "measure", unit: "score", why: "같은 자로 잰 도착선" },
    { metric: "시즌당 종합 드리프트", role: "measure", unit: "score", why: "성장과 노화의 수지 — 한 시즌에 리그 체급이 얼마나 움직이는가" },
    { metric: "리그 1군 상위 15 잠재력 — 시작", role: "measure", unit: "score", why: "체급의 천장 — 종합과 함께 읽어야 드리프트의 원인이 갈린다" },
    { metric: "리그 1군 상위 15 잠재력 — 15시즌 뒤", role: "measure", unit: "score", why: "같은 자로 잰 도착선" },
    { metric: "시즌당 잠재력 드리프트", role: "measure", unit: "score", why: "GM 은퇴 결정 없이 성장·노화·인테이크만 진행한 세계의 잠재력 변화" },
    { metric: "후보가 서지 않은 여름", role: "guard", max: 0, unit: "count", why: "인테이크는 후보가 서야 사건이다 (season.md §6) — 한 여름이라도 비면 그해 감독에게는 고를 것이 없고, 코어가 채우는 기본값마저 서지 않는다" },
    { metric: "우리 인테이크 후보 — 여름 평균", role: "measure", unit: "count", why: "감독 앞에 선 후보 수 — 코어가 채울 수 위에 체급·아카데미 활용도가 얹은 여지" },
    { metric: "우리 인테이크 계약 — 여름 평균", role: "measure", unit: "count", why: "그중 실제로 계약한 수. 이 하네스는 답하지 않는 감독이라 곧 **기본값**이고, 위 줄과의 차가 감독이 고를 수 있었던 폭이다" },
    { metric: "무소속 유스 명부 — 15시즌 뒤", role: "guard", max: 40, unit: "count", why: "`FREE_AGENT_YOUTH_CAP` — 계약을 받지 못한 아이가 서는 명부가 **여름마다 부풀지 않는가** (season.md §6). 상한과 「한 시즌」 규칙 둘 다 여기서만 보인다: 한 여름은 단위 테스트가 지키지만 열다섯 여름을 쌓아 자라는 것은 그 케이스에 보이지 않고, 자라면 세이브도 매일 도는 무소속 순회도 함께 무거워진다" },
    { metric: "무소속 유스 — 여름 평균", role: "measure", unit: "count", why: "여름마다 명부에 선 수 — 상한에 눌린 값인지 세계가 낸 값인지를 위 줄과 함께 읽는다" },
    { metric: "대역이 골문을 채운 여름", role: "measure", unit: "count", why: "감독 팀 1군에 골키퍼가 없어 감독 대역이 2군 골키퍼를 올린 여름 — 코어는 감독 팀의 골문을 대신 채우지 않으므로(team.md §5) 그 결정은 하네스가 감독의 명령으로 한다. AI 구단은 전환이 스스로 올린다(season.md §6)" },
  ],
});

/**
 * 유스 육성 — **2군 리그가 돌고, 감독의 선택이 유망주의 성장 속도를 가르는가**
 * (`docs/common/season.md` §2 2군 리그).
 */
export const YOUTH_DEVELOPMENT = defineHarness({
  id: "youth-development",
  what: "2군 경기 수 · 출전·집중 육성·임대가 가르는 성장 격차",
  doc: "docs/common/season.md §2",
  cost: "세계 하나 · 한 시즌 완주 · 수 분",
  // prettier-ignore
  bands: [
    { metric: "동일 곡선 축 빈도 최대비", role: "reference", max: 1.3, why: "8000시드에서 같은 노화 곡선 축의 선택 빈도" },
    { metric: "개인 결정력 훈련 선택비", role: "reference", min: 1.5, why: "3000시드 겨냥/기본 선택 횟수" },
    { metric: "개인 훈련 나머지 필드 선택비", role: "reference", max: 1, why: "겨냥한 만큼 나머지 축에서 걷는다" },
    { metric: "19세 축당 시즌 기대", role: "reference", min: 2, max: 3, why: "여유가 찬 유망주의 기본 성장 눈금" },
    { metric: "18세 집중육성 시즌 기대", role: "reference", min: 3.5, max: 5, why: "출전과 집중육성 최대 배율" },
    { metric: "기본 훈련 축 빈도비", role: "reference", max: 3, why: "시즌 달력의 훈련 축 최대/최소 빈도" },
    { metric: "비스페인 AI 바이아웃 비율", role: "reference", max: 0.5, why: "의무 조항이 아닌 리그의 계약 분포" },

    { metric: "2군 경기 수", role: "guard", min: 15, max: 23, unit: "count", why: "리그 상대 싱글 라운드로빈(20팀이면 19경기)이 실제로 편성돼 돈다" },
    { metric: "결과 없는 2군 경기", role: "guard", max: 0, unit: "count", why: "시즌 종료 판정은 2군 리그를 기다리지 않는다 — 일정이 늦으면 조용히 안 치러진 채 남는다" },
    { metric: "2군 평균 출전", role: "guard", min: 5, unit: "count", why: "출전이 쌓여야 '2군 선수의 시즌 기록에 경기가 쌓인다'가 성립한다" },
    { metric: "집중 육성 시즌 성장", role: "reference", min: 2.5, max: 6, unit: "score", why: "집중 육성 + 2군 출전을 다 받은 유망주의 종합 상승 — 실제 원더키드의 해마다 +3~5 (`AXIS_GROWTH_PER_SEASON` × 배율)" },
    { metric: "무지정 우리 2군 U21 성장", role: "measure", unit: "score", why: "출전 배율만 받은 유망주 — 손잡이 하나의 몫을 가른다" },
    { metric: "타 팀 2군 U21 성장", role: "reference", min: 1.2, max: 3.5, unit: "score", why: "배율이 없는 기준선 — 코어 월간 성장 그대로. 실제 U21의 해마다 +2 안팎, 여유가 작은 선수가 섞여 평균은 그 아래다" },
    { metric: "집중 육성 격차", role: "reference", min: 0.5, unit: "score", why: "집중 육성 − 타 팀 기준선. 0이면 손잡이가 아무것도 가르지 않은 것이다" },
    { metric: "임대 표본", role: "guard", min: 2, unit: "count", why: "같은 리그로 보내 시즌 끝까지 임대로 남은 U21 — 표본이 줄면 아래 세 줄이 격차가 아니라 잡음이다" },
    { metric: "임대 U21 성장", role: "measure", unit: "score", why: "임대처 1군 출전 × 수준 계수만 받은 유망주의 종합 상승 (season.md §2 임대)" },
    { metric: "임대처 평균 출전", role: "guard", min: 2, max: 25, unit: "count", why: "그 구단 1군 경기를 실제로 몇 번 뛰었나 — **성장 배율에 곱할 분(分)이 있는가.** 빌린 구단이 임대 자원에게 치르는 값(로테이션 우선권 · 연속 미출전 상한 `LOAN_REST_LIMIT`)이 닫히면 이 줄이 0 언저리로 내려간다(문이 없던 시절 0.20이었다). 표본이 다섯이고 그중 기량 창 밖으로 나간 아이는 0이라, 하한은 '문이 닫혔다'와 '한둘이 자리를 못 얻었다'를 가르는 자리에 둔다. 상한 25는 그 반대편 — 아카데미 유망주가 1부 클럽의 주전이 되면 그건 임대가 아니라 이적이고 AI 순위표가 임대로 흔들린다" },
    { metric: "기량 창 안의 임대", role: "guard", min: 2, unit: "count", why: "보낼 때 그 구단의 같은 포지션군 **가장 약한 선발**과의 차가 `LOAN_ROTATION_OVR_DROP`(10) 안이던 임대 — 감독이 「뛸 수 있는 곳」을 골라 보낸 아이다 (season.md §2 임대). 아래 줄의 분모라 둘 아래면 그 줄이 판정이 아니라 한 사람의 잡음이다. 우리 리그 안에서 그런 구단이 둘도 없다면 창이 닫힌 것이다" },
    { metric: "기량 창 밖의 임대", role: "measure", unit: "count", why: "창이 열린 구단이 없어 가장 약한 구단으로 보낸 아이 — 한 경기도 못 뛰어야 하고, 그때 켜지는 경보가 곧 리콜 판단이다. 재려는 값이지 지키려는 값이 아니다" },
    { metric: "창 안 임대 중 경보 전에 뛴 몫", role: "guard", min: 0.5, unit: "ratio", why: "창 안의 임대 중 그 구단 경기에서 **가장 긴 연속 미출전**이 `LOAN_BENCH_RUN_ALERT`(4) 미만인 몫 — 리콜 근거 `no-minutes`가 배경음인지 사건인지를 가른다. 연속 미출전 상한(`LOAN_REST_LIMIT` 3)이 경보 문턱보다 한 칸 앞이라 자리가 있는 임대는 경보가 켜지기 전에 뛴다. **1.0을 요구하지 않는다**: 부상·정지·로테이션으로 그 주의 가장 약한 선발이 창 밖으로 올라가면 자리가 잠시 닫히고 경보가 켜진다 — 그것은 사건이고 리포트가 그렇게 읽는다. 0이면 상한이 세계에 닿지 않은 것이다" },
    { metric: "임대 격차", role: "reference", unit: "score", why: "임대 − 타 팀 기준선. ⚠️ **밴드를 두지 않는다 — 눈금 아래의 값이다.** 한 시즌 U21의 종합 상승이 0.2인데 임대 배율이 1.2~1.3이라 격차의 참값은 0.05 안쪽이고, 종합은 정수라 한 사람의 잡음이 0.45다(표본 다섯이면 부호가 동전이다). 배율 자체가 사는지는 `growth-curve` 단위 테스트가 같은 시드·같은 난수열에서 지키고, **세계가 그 배율에 곱할 분을 주는가**는 위의 `임대처 평균 출전`이 지킨다" },
    { metric: "아카데미 활용도", role: "guard", min: 0.3, max: 1, unit: "ratio", why: "그 시즌 우리 2군 출전 중 21세 이하의 몫 (season.md §6) — 다음 여름 인테이크의 수와 여지가 여기서 나온다. 하한은 '2군이 유망주의 자리로 돌아가고 있다'를 가르는 자리다: 그 아래면 2군이 늙은 백업의 대기실이라는 뜻이고, 그러면 아래 두 줄이 재는 것이 감독의 선택이 아니라 그 사실 하나가 된다" },
    { metric: "다음 여름 유스 후보", role: "guard", min: 3, unit: "count", why: "감독 앞에 선 후보 수 — 고를 것이 한둘이면 인테이크는 결정이 아니라 통보다" },
    { metric: "유스 후보 천장 — 평균", role: "reference", min: 82, max: 92, unit: "score", why: "후보의 `potential` 평균 — **인테이크의 무게 중심이다** (season.md §6). 우리 팀은 1등급이라 체급 기준선 `TIER_BASE[1]`(84)에 활용도 항이 얹힌 자리에 서야 한다. 밴드가 그보다 넓은 것은 후보 열몇의 평균이라 천장의 흩어짐(`YOUTH_CEILING_SPREAD`)이 그만큼 흔들기 때문이고, 평균 자체와 기준선의 차이는 youth-intake-tail의 체급 코호트가 잰다" },
    { metric: "유스 후보 잠재력 여지 — 평균", role: "reference", min: 13, max: 23, unit: "score", why: "후보의 `potential − overall` 평균. 세계 생성과 같은 나이별 표에서 나오므로(`sampleGapFor`) 열일곱~열아홉의 표 평균 17.7 둘레에 선다 — 밴드를 벗어나면 인테이크가 그 표를 안 읽고 있는 것이다" },
    { metric: "유스 후보 잠재력 여지 — 최대", role: "measure", unit: "score", why: "그해 인테이크에서 가장 덜 자란 아이 — 여지가 큰 쪽이 그해 가장 먼 길을 갈 아이다" },
  ],
});

/**
 * 유스 인테이크의 **꼬리** — 한 여름 세계 전체가 낳은 잠재력·종합의 위 끝이
 * 시드 세계의 그것과 같은 자리에 서는가 (`docs/common/season.md` §6).
 *
 * `squad-longevity`가 재는 것은 **평균**이다 — 리그 체급이 세대마다 가라앉는가.
 * 평균은 멎어 있는데 위 끝만 부풀 수 있고, 그때 세계의 엘리트가 해마다 합성 유스로
 * 갈아치워진다. 꼬리를 재는 자는 따로 서야 한다.
 *
 * **견주는 자리가 시드의 열일곱~열아홉이 아니라 시드 세계 전부인 이유**는 잠재력이
 * 평생 바뀌지 않기 때문이다: 닫힌 세계에서 세월이 지나면 세계의 잠재력 분포는
 * 인테이크의 분포 그것으로 수렴한다. 그래서 「여름 환산」 줄은 시드 세계의 비율에
 * 한 여름 인원을 곱한 값이고, 인테이크 쪽 줄이 그 짝이다.
 */
export const YOUTH_INTAKE_TAIL = defineHarness({
  id: "youth-intake-tail",
  what: "한 여름 세계 전체 인테이크의 잠재력·종합 꼬리 — 시드 세계 분포와 나란히",
  doc: "docs/common/season.md §6",
  cost: "세계 넷 × 두 여름 · 약 20초",
  // prettier-ignore
  bands: [
    { metric: "체급 코호트 천장 평균 최대 편차", role: "reference", max: 1.5, unit: "score", why: "체급별 1500명 평균과 TIER_BASE의 가장 큰 절대 차이" },
    { metric: "체급 코호트 현재 실력 최대 편차", role: "reference", max: -12, unit: "score", why: "체급별 현재 실력 평균에서 TIER_BASE를 뺀 값 중 최댓값" },
    { metric: "아카데미 활용 천장 평균 이동", role: "reference", min: 2.5, max: 3.5, unit: "score", why: "같은 tier 3 코호트에 활용도 보너스 3을 준 차이" },

    { metric: "한 여름 인테이크 인원", role: "guard", min: 200, unit: "count", why: "표본이 없으면 아래 꼬리 줄이 전부 공허하게 통과한다 — 168 클럽이 은퇴·만료를 메우는 수보다 넉넉히 아래" },
    { metric: "잠재력 ≥95 — 여름당", role: "guard", max: 2, unit: "count", why: "**세계가 쥔 95+의 재고는 인테이크가 정한다.** 시드 세계의 95+는 열 몇이고 한 선수가 세계에 머무는 햇수는 평균 열다섯이므로(선수 수 ÷ 한 여름 인테이크), 재고를 그 자리에 두는 유입은 여름에 하나다. 일곱이던 동안 첫 여름에 세계의 95+가 절반 넘게 불었다" },
    { metric: "잠재력 ≥90 — 여름당", role: "guard", min: 6, max: 18, unit: "count", why: "같은 셈의 한 칸 아래 — 아래 「시드 세계 ≥90 — 여름 환산」이 그 자리다. 위끝이 그 환산보다 반쯤 두꺼운 것은 인테이크의 무게 중심이 시드 세계보다 한 칸 위에 서기 때문이고(§6 닫힌 세계), 그 한 칸이 폭으로 번지면 안 된다는 것이 상한이다. **하한도 가드다**: 꼬리를 더 좁히면 세계에 진짜 물건이 나지 않아 리그 상위권이 세대마다 얇아진다" },
    { metric: "잠재력 ≥85 — 여름당", role: "reference", min: 35, max: 65, unit: "count", why: "꼬리가 아니라 어깨 — 좁히기가 위 끝이 아니라 분포 전체를 깎았는지가 여기서 보인다" },
    { metric: "인테이크 잠재력 평균", role: "guard", min: 75, max: 79, unit: "score", why: "**무게 중심은 건드리지 않는다** — 체급 기준선 `TIER_BASE` 둘레에 서야 하고(§6), 여기가 내려가면 닫힌 세계가 세대마다 가라앉아 `squad-longevity`의 드리프트 가드가 먼저 빨개진다. 꼬리를 좁히는 변경이 실수로 평균을 끌고 내려가지 않았는지를 이 줄이 잡는다" },
    { metric: "인테이크 잠재력 p99", role: "guard", max: 94, unit: "score", why: "위 끝의 자리 — 아래 「시드 세계 잠재력 p99」와 한 칸 안에서 만나야 한다. 개수 줄이 시드에 묻힐 만큼 작아도 분위는 흔들리지 않는다" },
    { metric: "시드 세계 잠재력 평균", role: "measure", unit: "score", why: "견주는 쪽 — 밴드가 아니라 같은 표에 나란히 찍히는 값이다" },
    { metric: "시드 세계 잠재력 p99", role: "measure", unit: "score", why: "같은 자로 잰 시드의 위 끝" },
    { metric: "시드 세계 ≥95 — 여름 환산", role: "measure", unit: "count", why: "시드 세계의 95+ 비율 × 한 여름 인원 — 인테이크가 그 재고를 유지만 한다면 나와야 할 수" },
    { metric: "시드 세계 ≥90 — 여름 환산", role: "measure", unit: "count", why: "같은 환산의 한 칸 아래" },
    { metric: "시드 세계 ≥85 — 여름 환산", role: "measure", unit: "count", why: "같은 환산의 어깨" },
    { metric: "17~18세 종합 p99", role: "guard", max: 78, unit: "score", why: "**지금 실력 쪽 꼬리.** 종합은 나이와 함께 자라므로 견줄 자리가 세계 전체가 아니라 시드의 **같은 나이**다 — 아래 줄이 그 짝이다. 열여덟이 스쿼드 최고 종합과 나란히 서면 시장가가 그 위에 서서 0경기 유망주에게 £400M 오퍼가 나간다" },
    { metric: "시드 17~18세 종합 p99", role: "measure", unit: "score", why: "견주는 쪽 — 시드 클럽 명단의 열일곱~열여덟" },
    { metric: "17~18세 종합 최대", role: "measure", unit: "score", why: "그 여름 가장 완성돼 들어온 아이 — 분위가 가리는 한 사람" },
    { metric: "종합 ≥78 — 여름당", role: "guard", max: 7, unit: "count", why: "p99가 한 칸 눈금이라 놓치는 폭을 개수로 받는다 — 시드의 같은 나이는 열에 하나 비율(0.9%)이고, 인테이크가 그 두 배를 넘으면 그 여름 전체가 즉시 전력이 된다" },
  ],
});

/**
 * 종합 눈금 — **그 숫자가 굴리는 것들의 분포** (`docs/common/player.md` §4).
 *
 * 종합은 화면의 숫자 하나가 아니라 시장가·주급 서열·잠재력 간격·등급 색이 함께 읽는
 * 눈금이다. 눈금을 옮기면 그 넷이 전부 따라 움직이는데, 얼마나 움직이는지는 코드를
 * 읽어서는 알 수 없다 — 세계를 하나 세워 재는 자리가 여기다. 밴드를 두지 않는 이유도
 * 같다: 재려는 값이지 지키려는 값이 아니다.
 */
export const OVERALL_SCALE = defineHarness({
  id: "overall-scale",
  what: "종합이 굴리는 것들의 분포 — 자리별 평균 · 축 범위 밖 · 시장가 · 주급 · 잠재력 간격",
  doc: "docs/common/player.md §4",
  cost: "세계 하나 · 시드당 몇 초 × 2시드",
  // prettier-ignore
  bands: [
    { metric: "선수 수", role: "measure", unit: "count", why: "전 세계" },
    { metric: "EPL 인원", role: "measure", unit: "count", why: "돈은 EPL만 잰다 — 전 세계에 계약 조회를 걸면 몇 분이 된다" },
    { metric: "종합 평균", role: "measure", why: "" },
    { metric: "종합 p10", role: "measure", unit: "score", why: "" },
    { metric: "종합 p50", role: "measure", unit: "score", why: "" },
    { metric: "종합 p90", role: "measure", unit: "score", why: "" },
    { metric: "종합 p99", role: "measure", unit: "score", why: "" },
    { metric: "종합 최대", role: "measure", unit: "score", why: "" },
    { metric: "자리별 평균 GK", role: "measure", why: "자리 사이의 폭 — 가중 평균이 자리를 기울이는지" },
    { metric: "자리별 평균 CB", role: "measure", why: "" },
    { metric: "자리별 평균 FB", role: "measure", why: "" },
    { metric: "자리별 평균 DM", role: "measure", why: "" },
    { metric: "자리별 평균 CM", role: "measure", why: "" },
    { metric: "자리별 평균 AM", role: "measure", why: "" },
    { metric: "자리별 평균 W", role: "measure", why: "" },
    { metric: "자리별 평균 CF", role: "measure", why: "" },
    { metric: "자리별 평균 ST", role: "measure", why: "" },
    { metric: "축 범위 위로 벗어난 비율", role: "measure", unit: "ratio", why: "종합이 어느 축보다 높은 선수" },
    { metric: "축 범위 아래로 벗어난 비율", role: "measure", unit: "ratio", why: "종합이 어느 축보다 낮은 선수" },
    { metric: "등급 top(85+) 비율", role: "measure", unit: "ratio", why: "화면의 등급 색이 읽는 문턱" },
    { metric: "등급 strong(75+) 비율", role: "measure", unit: "ratio", why: "" },
    { metric: "등급 solid(65+) 비율", role: "measure", unit: "ratio", why: "" },
    { metric: "등급 low 비율", role: "measure", unit: "ratio", why: "" },
    { metric: "시장가 p50", role: "measure", unit: "money", why: "" },
    { metric: "시장가 p90", role: "measure", unit: "money", why: "" },
    { metric: "시장가 최대", role: "measure", unit: "money", why: "" },
    { metric: "시장가 총액", role: "measure", unit: "money", why: "EPL 전체" },
    { metric: "희망 주급 p50", role: "measure", unit: "wage", why: "" },
    { metric: "희망 주급 p90", role: "measure", unit: "wage", why: "" },
    { metric: "희망 주급 최대", role: "measure", unit: "wage", why: "" },
    { metric: "실제 주급 p50", role: "measure", unit: "wage", why: "" },
    { metric: "실제 주급 p90", role: "measure", unit: "wage", why: "" },
    { metric: "실제 주급 최대", role: "measure", unit: "wage", why: "" },
    { metric: "실제 주급 총액", role: "measure", unit: "money", why: "EPL 전체 · 주 단위" },
    { metric: "잠재력 간격 p50", role: "measure", unit: "score", why: "" },
    { metric: "잠재력 간격 p90", role: "measure", unit: "score", why: "" },
    { metric: "잠재력 간격 최대", role: "measure", unit: "score", why: "" },
    { metric: "잠재력 대역 상한 초과 비율", role: "measure", unit: "ratio", why: "`docs/common/player.md` §6.5의 나이별 참고 상한 — 시드의 성장 여지를 해석할 측정값이다" },
  ],
});

/**
 * 자체 산정 모델(`world/synthesis.ts`)이 낸 분포와 **지금 시드 분포의 간격**.
 *
 * 밴드가 절대값이 아니라 차에 걸리는 이유는 시드가 갱신되기 때문이다 — "합성 평균이
 * 72~74"는 시드가 움직이는 순간 낡지만 "합성과 시드의 차가 ±2"는 그대로 묻는다.
 * 폭은 실제로 재서 정했다: 종합 눈금은 ±1점 안에 앉으므로 ±2가 어긋남의 신호이고,
 * 자리·나이처럼 표본이 얇거나 표집이 흔들리는 값은 그보다 넓다.
 */
export const ATTRIBUTE_MODEL = defineHarness({
  id: "attribute-model",
  what: "자체 산정 모델이 낸 분포와 지금 시드 분포의 간격 — 체급·낙차·자리·나이·잠재력",
  doc: "docs/common/player.md §13",
  cost: "세계를 세우지 않는다 — 시드 2,800명을 재고 같은 수를 합성한다, 수 초",
  // prettier-ignore
  bands: [
    { metric: "팀 수", role: "measure", unit: "count", why: "시드를 가진 클럽 — 합성 쪽도 같은 구성이다" },
    { metric: "선수 수", role: "measure", unit: "count", why: "같은 스쿼드 크기로 세우므로 두 쪽이 같다" },
    { metric: "종합 평균 차", role: "guard", min: -2, max: 2, why: "세계의 눈금 그 자체 — 여기가 벌어지면 시장가·주급·등급 색이 통째로 따라 움직인다" },
    { metric: "종합 p10 차", role: "reference", min: -3, max: 3, why: "아카데미 쪽 꼬리. 낙차 표의 끝 구간이 정한다" },
    { metric: "종합 p50 차", role: "guard", min: -2, max: 2, why: "평균과 함께 봐야 한쪽이 꼬리로 끌린 것인지 알 수 있다" },
    { metric: "종합 p90 차", role: "reference", min: -3, max: 3, why: "주전 상위. 꼭대기와 낙차의 앞 구간이 정한다" },
    { metric: "체급1 종합 p50 차", role: "reference", min: -3, max: 3, why: "체급이 스쿼드 전체를 옮기는지 — 넷을 함께 본다" },
    { metric: "체급2 종합 p50 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "체급3 종합 p50 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "체급4 종합 p50 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "체급1 꼭대기 평균 차", role: "reference", min: -2, max: 2, why: "`SQUAD_APEX`가 실제로 그 값을 내는가 — 모델의 ①이 서는 자리" },
    { metric: "체급2 꼭대기 평균 차", role: "reference", min: -2, max: 2, why: "" },
    { metric: "체급3 꼭대기 평균 차", role: "reference", min: -2, max: 2, why: "" },
    { metric: "체급4 꼭대기 평균 차", role: "reference", min: -2, max: 2, why: "표본이 22팀뿐이라 위 셋보다 흔들린다" },
    { metric: "낙차 순번0~4 차", role: "reference", min: -1.5, max: 1.5, why: "주전 구간 — 여기가 벌어지면 선발 XI의 폭이 달라진다" },
    { metric: "낙차 순번5~10 차", role: "reference", min: -1.5, max: 1.5, why: "로테이션 구간" },
    { metric: "낙차 순번11~17 차", role: "reference", min: -1.5, max: 1.5, why: "" },
    { metric: "낙차 순번18~24 차", role: "reference", min: -2, max: 2, why: "" },
    { metric: "낙차 순번25+ 차", role: "reference", min: -3, max: 3, why: "아카데미 구간 — 표 끝 너머를 기울기로 잇는 자리라 가장 넓다" },
    { metric: "자리 GK 평균 차", role: "reference", min: -3, max: 3, why: "자리별 평균 — 한 자리만 어긋나면 그 자리 선수만 다른 세계에 산다" },
    { metric: "자리 CB 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 FB 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 DM 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 CM 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 AM 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 W 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "자리 CF 평균 차", role: "reference", min: -3, max: 3, why: "표본 83명 — 위보다 흔들린다" },
    { metric: "자리 ST 평균 차", role: "reference", min: -3, max: 3, why: "" },
    { metric: "나이 평균 차", role: "reference", min: -1.5, max: 1.5, why: "나이는 종합이 아니라 잠재력 여유와 침착성·리더십을 정한다 (player.md §13.2)" },
    { metric: "나이 p10 차", role: "reference", min: -2, max: 2, why: "어린 쪽 꼬리 — 유스 유입과 이어지는 자리" },
    { metric: "나이 p90 차", role: "reference", min: -2, max: 2, why: "늙은 쪽 꼬리 — 재계약·은퇴가 읽는 자리" },
    { metric: "잠재력 여유 평균 차", role: "reference", min: -2, max: 2, why: "여유가 곧 성장 여지다 — 벌어지면 세계가 통째로 자라거나 멎는다" },
    { metric: "잠재력 여유 p90 차", role: "reference", min: -4, max: 4, why: "유망주 쪽 꼬리. 99 천장에 잘리는 자리라 평균보다 넓다" },
    { metric: "잠재력 대역 상한 초과 비율", role: "guard", max: 0, unit: "ratio", why: "player.md §6.5 나이별 상한 — 넘긴 선수는 영영 닿지 않는 천장을 갖는다" },
    { metric: "되맞춤 평균 반복", role: "measure", why: "상한은 `RETARGET_MAX_PASSES` — 평균이 거기 붙으면 되먹임이 수렴하지 않는 것이다" },
    { metric: "되맞춤 목표 미달 비율", role: "guard", max: 0.02, unit: "ratio", why: "목표에서 벗어난 몫 — 이 값이 크면 ①②가 정한 눈금을 모델이 안 지키는 것이다" },
  ],
});

export const HISTORY_WINDOW = defineHarness({
  id: "history-window",
  what: "평시 이력의 창 — 상한·잔량이 몇 턴인가 · 창이 미끄러지는 빈도 · 압축 뒤 잔량",
  doc: HISTORY,
  cost: "세계 하나 + 합성 이력 400턴 — 수 초",
  // prettier-ignore
  bands: [
    { metric: "이력 창 (턴)", role: "reference", min: 100, max: 220, unit: "count", why: "상한 ÷ 실측 턴당 글자 — 시즌을 가로지르는 이야기가 창 안에 남아야 한다" },
    { metric: "압축 뒤 이력 (턴)", role: "reference", min: 30, max: 80, unit: "count", why: "잔량 ÷ 실측 턴당 글자" },
    { metric: "압축 주기 (턴)", role: "measure", unit: "count", why: "(상한 − 잔량) ÷ 턴당 글자 — 요약 블록이 이만큼마다 한 번 무효가 된다" },
    { metric: "압축 뒤 이력 글자", role: "guard", max: HISTORY_CHAR_KEEP, unit: "count", why: "잔량 그것 — 넘으면 압축이 제 일을 하지 못한 것이다" },
    { metric: "창이 미끄러진 턴 비율", role: "guard", max: 0.2, unit: "ratio", why: "6턴 스텝이라 정상은 1/6 — 매 턴 미끄러지면 이력 캐시가 한 번도 적중하지 않는다" },
    { metric: "렌더 배율", role: "reference", min: 1, max: 1.3, unit: "ratio", why: "코어가 세는 turn.text와 프롬프트에 실리는 형태의 비 — 이보다 벌어지면 글자 상한이 뜻을 잃는다" },
    { metric: "압축 직후 프리픽스의 최소 캐시 프리픽스 배수", role: "guard", min: 1, unit: "ratio", why: "고정층 + 레퍼런스 + 요약 두 칸 상한 + 잔량의 토큰 ÷ GM 제공자의 최소 캐시 프리픽스 (pipeline.md §2-2 · models.md §3) — 1 아래면 압축 직후에는 캐시가 아예 안 걸린다. 잔량 하나로 재지 않는다: 프리픽스는 고정층에서 시작하고, 실호출의 캐시 읽기가 그 길이에 선다" },
    { metric: "요약 두 칸 상한 글자", role: "measure", unit: "count", why: "지난 일 + 열린 일의 상한 — 압축된 세이브가 이력 앞에 매 턴 싣는 최대치 (agents.md §5-1)" },
    { metric: "요약 두 칸의 잔량 대비 비율", role: "reference", max: 0.25, unit: "ratio", why: "요약이 잔량의 1/4을 넘으면 접은 뒤에도 프롬프트가 별로 줄지 않는다" },
  ],
});

export const PROMPT_REGRESSION = defineHarness({
  id: "prompt-regression",
  what: "프롬프트 층의 글자·프리픽스 안정성 · 모의 세션의 장면 문법과 도구 적중률 · 중계 위생",
  doc: PROMPTS,
  cost: "세계 셋 + 모의 GM 세션 + 모의 경기 한 판 — 수 초",
  // prettier-ignore
  bands: [
    { metric: "고정층 글자", role: "guard", max: 30500, unit: "count", why: "매 턴 캐시 프리픽스로 나가는 하한 — 프롬프트는 지우는 방향으로 고친다 (prompts.md §5). 여백은 거의 없다: 문구가 늘면 잡히고, 도구가 늘어 넘겼으면 그때만 다시 자른다" },
    { metric: "시스템 프롬프트 글자", role: "measure", unit: "count", why: "평시 턴마다 실려 나가는 `GM_SYSTEM` 전체 — 총량의 상한은 위 「고정층 글자」가 쥔다. 규칙이 늘었는지는 아래 「지침 글자」가 묻는다" },
    { metric: "시스템 프롬프트 지침 글자", role: "reference", min: 1500, max: 2500, unit: "count", why: "전체에서 입력 지도와 예시 한 장면을 뺀 나머지 — 곧 규칙이다. 프롬프트를 지우는 방향으로 고치게 하는 자리이므로(prompts.md §7) 여백은 규칙 서너 줄뿐이다. 도구 사용법이 새어 들어오면 늘어난다 — 그 줄은 그 도구의 description으로 내린다(§5 원칙 8)" },
    { metric: "입력 지도 글자", role: "measure", unit: "count", why: "`# 입력` 섹션 — 규칙이 아니라 규칙을 줄이는 장치다(prompts.md §5 원칙 2). 입력 블록이 늘면 함께 자라므로 위 밴드가 세지 않는다. 지도가 이름과 몫을 넘어 출력 규칙까지 말하기 시작하면 여기가 먼저 부푼다" },
    { metric: "도구 스펙 글자", role: "measure", unit: "count", why: "설명 + Zod에서 파생된 JSON 스키마 — 고정층의 대부분이다" },
    { metric: "도구 설명 총 글자", role: "measure", unit: "count", why: "상한은 skill-descriptions.test.ts가 쥔다 — 여기서는 그 안 어디쯤인지만 읽는다" },
    { metric: "가장 긴 도구 설명 글자", role: "measure", unit: "count", why: "한 도구가 설명 예산을 혼자 먹고 있는가" },
    { metric: "경기 고정층 글자", role: "reference", max: 12000, unit: "count", why: "매치 GM 프롬프트 + 경기 도구 둘 — 평시 고정층과 다른 눈금이고, 도구가 늘면 경기 턴마다 그만큼 캐시 뒤에 붙는다 (agents.md §3)" },
    { metric: "경기 마감 고정층 글자", role: "measure", unit: "count", why: "경기 결산 도구 하나(설명 + 스키마) — 경기당 한 번 마감 에이전트에 실린다 (agents.md §3)" },
    { metric: "훈련 브리프 글자", role: "measure", unit: "count", why: "한 주를 넘긴 구간의 훈련 결산 입력 — 대화·[장부] 줄·대상 표가 함께 간다 (agents.md §4)" },
    { metric: "레퍼런스층 글자", role: "reference", max: 600, unit: "count", why: "구단 이름과 감독 프로필뿐이다(<club>·<manager>) — 선수 이름·수치가 들어오면 캐시가 그것과 함께 깨진다" },
    { metric: "매 턴 층 글자", role: "reference", max: 3000, unit: "count", why: "캐시가 걸리지 않는 유일한 층 — 매 턴 정가로 나간다" },
    { metric: "고정층 비중", role: "measure", unit: "ratio", why: "고정 ÷ (고정 + 레퍼런스 + 매 턴) — 캐시가 덮는 몫" },
    { metric: "고정층 프리픽스 안정성", role: "guard", min: 1, max: 1, unit: "ratio", why: "다른 세계 둘에서 바이트까지 같아야 한다 — 날짜·id가 한 글자 섞이면 매 턴 뒤가 전부 정가로 읽힌다 (models.md §4)" },
    { metric: "레퍼런스층 프리픽스 안정성", role: "guard", min: 1, max: 1, unit: "ratio", why: "같은 세이브라면 날짜가 흘러도 같아야 한다 — 여기가 바뀌면 이 층과 그 뒤 이력이 통째로 무효가 된다" },
    { metric: "장면 문법 준수율", role: "guard", min: 1, unit: "ratio", why: "시점 헤더 한 줄 + `@` 줄로 여는 본문 — 그 뒤의 태그 없는 줄은 이어쓰기다 (prompts.md §1). 분모는 **본문이 선 장면**이다: 시간만 흐른 턴은 본문 없이 서고, 그 사실은 사건 카드가 이미 진다 (overview.md §2)" },
    { metric: "본문이 선 장면 비율", role: "guard", min: 0.5, unit: "ratio", why: "위 가드의 분모가 통째로 비면 장면을 다 잃은 세션이 문법을 100% 지킨 세션과 같은 값으로 선다 — 본문 없는 장면은 시간만 흐른 턴의 것이고, 코퍼스의 그런 말은 여덟 중 하나다 (prompts.md §7)" },
    { metric: "위생이 걷어낸 줄 비율", role: "guard", max: 0, unit: "ratio", why: "모의 장면은 이미 문법 안이다 — 위생이 무엇이든 걷었다면 문법이나 위생 한쪽이 움직인 것이다" },
    { metric: "중계 턴", role: "measure", unit: "count", why: "모의 경기 한 판이 낸 중계 턴 — 아래 두 비율의 분모다" },
    { metric: "중계 위생이 걷어낸 줄 비율", role: "guard", max: 0, unit: "ratio", why: "중계에 거는 것은 꺾쇠 규칙 하나뿐이다 — 모의 중계에서 무언가 걷혔다면 그 체가 장면까지 물고 있는 것이다 (prompts.md §1)" },
    { metric: "중계 시각 헤더 보존율", role: "guard", min: 1, unit: "ratio", why: "위생 전후로 첫 줄 헤더가 같아야 한다 — 구간마다 새로 찍는 시각 줄은 중계에서 소음이 아니고, 걷히면 화면의 시계가 멎는다" },
    { metric: "시점 헤더 파싱 성공률", role: "guard", min: 1, unit: "ratio", why: "헤더를 못 읽으면 그 턴의 시계가 멎는다 (prompts.md §1)" },
    { metric: "평균 장면 글자", role: "measure", unit: "count", why: "모의 GM의 장면 길이 — 실모드의 400~800 예산과는 다른 눈금이다" },
    { metric: "도구 적중률", role: "guard", min: 1, unit: "ratio", why: "코퍼스가 겨냥한 도구를 실제로 불렀는가 — 떨어지면 도구 표면이나 모의 GM이 갈린 것이다 (agents.md §8)" },
    { metric: "불린 도구 가짓수", role: "measure", unit: "count", why: "코퍼스가 훑는 표면의 폭" },
  ],
});

export const LIVE_SCHEMA = defineHarness({
  id: "live-schema",
  what: "출력 스키마로 나가는 산출 선언 열을 제공자가 실제로 받는가",
  doc: TOOL_CONTRACT,
  cost: "선언 열에 실호출 한 번씩 — 30초쯤 (키가 없으면 건너뛴다)",
  // prettier-ignore
  bands: [
    { metric: "제공자가 받은 비율", role: "guard", min: 1, unit: "ratio", why: "받음 ÷ (받음 + 거절) — 제공자가 받는 스키마 부분집합을 벗어난 선언 하나가 그 호출을 400으로 떨군다 (models.md §3-2). 돌지 못한 호출은 분모에서 빠진다 — 러너의 네트워크는 판정이 아니다" },
    { metric: "건 선언", role: "measure", unit: "count", why: "그 자리의 키가 있어 실제로 건 선언 수 — 아래 비율들의 분모다. 열보다 적으면 제공자 일부에 키가 없었거나 한도 밖이었다" },
    { metric: "돌지 못한 선언", role: "measure", unit: "count", why: "혼잡·한도·시한으로 두 번 다 실패한 선언 — 이탈이 아니지만 그만큼은 이번 실행이 아무것도 묻지 못한 것이다" },
    { metric: "한도 밖 선언", role: "measure", unit: "count", why: "그 제공자의 구조화 출력이 받는 선택 속성 한도(PROVIDER_TRAITS.outputOptionalLimit)를 넘어 걸지 않은 선언 — 해석기 넷은 Anthropic에 이렇게 선다. 설정이 그리로 옮겨지면 오프라인 테스트가 먼저 잡는다" },
    { metric: "산출이 돌아온 비율", role: "measure", unit: "ratio", why: "요청을 받은 뒤 본문이 JSON 객체로 읽혔는가 — 스키마는 지났는데 산문으로 답하거나 잘린 자리를 여기서 읽는다. 판정의 내용은 보지 않는다" },
    { metric: "가장 큰 선언 글자", role: "measure", unit: "count", why: "선언 열 중 가장 긴 것의 JSON 글자 — 구조화 출력도 스키마를 문법으로 펼치는 제공자가 있어 한도에 가장 먼저 닿는 값이다 (models.md §3-2)" },
  ],
});

/**
 * `pnpm balance --list`가 읽는 목록.
 *
 * **파일 하나가 여러 서술자를 실행할 수 있다** — 여기 없는 하네스는 돌면서도 리포트의 「몇 개가
 * 보고했다」 분모에서 빠지고, 여기만 있는 서술자는 목록에 서면서 돌지 않는다. 둘 다
 * 조용해서 오래 사니 `harness-catalog.test.ts`가 그 짝을 못 박는다.
 */
export const QUICK_OUTCOMES = defineHarness({
  id: "quick-outcomes",
  what: "간이 연장·퇴장 효과·상금 비중",
  doc: "docs/match/match.md",
  cost: "시드 3 · 연장 200 · 퇴장 대조 900 경기",
  bands: [
    { metric: "extraGoals", role: "reference", min: 0.3, max: 1.4, why: "연장 득점 빈도" },
    { metric: "extraCards", role: "reference", min: 0.5, why: "연장 카드 빈도" },
    { metric: "redConcededRatio", role: "reference", min: 1.1, why: "10명/11명 실점 비" },
    { metric: "redScoredRatio", role: "reference", max: 0.9, why: "10명/11명 득점 비" },
    {
      metric: "prizeIncomeRatio",
      role: "reference",
      min: 0.2,
      max: 0.4,
      why: "우승 경로 상금/1부 기준 수입",
    },
  ],
});

export const HARNESSES: readonly Harness[] = [
  QUICK_OUTCOMES,
  WORLD_SEASON,
  AI_ROTATION,
  LEAGUE_SPREAD,
  ASSIST_RATE,
  LIVE_MATCH_STATS,
  LIVE_PLAYER_LOAD,
  LIVE_TACTICS,
  SIM_PARITY,
  INJURY_RATE,
  FINANCE_TIER1,
  FINANCE_LEAGUES,
  FINANCE_SECOND_TIER,
  FINANCE_MULTI_SEASON,
  AI_FITNESS,
  AI_BENCH,
  AI_MARKET,
  SQUAD_LONGEVITY,
  YOUTH_DEVELOPMENT,
  YOUTH_INTAKE_TAIL,
  OVERALL_SCALE,
  ATTRIBUTE_MODEL,
  HISTORY_WINDOW,
  PROMPT_REGRESSION,
  LIVE_SCHEMA,
];
