import { CALL_LABELS } from "@story-fm/domain";
import { MAX_INCIDENTS_PER_DAY } from "@story-fm/engine";
import { INCIDENT_KIND_KO, INCIDENT_KINDS } from "@story-fm/domain";

export type SkillGroup = "진행" | "전술·훈련" | "대화·서사" | "조회" | "이적" | "재정";

export interface SkillCatalogEntry {
  name: string;
  label: string;
  group: SkillGroup;
  readOnly: boolean;
  description: string;
}

/**
 * 모델에 제공하는 도구 설명의 코드 기본값과 어드민 표시 메타데이터.
 *
 * 한 도구의 사용법은 여기에만 산다 — 언제 부르고, 인자를 어떻게 채우고, 결과를
 * 장면에 어떻게 옮기는가. `GM_SYSTEM`은 도구와 무관한 규칙만 갖는다
 * (docs/common/llm/prompts.md §5). 경기 스킬은 match-gm의 별도 카탈로그에 산다.
 */
export const SKILL_CATALOG = [
  {
    name: "tactic_orders",
    label: CALL_LABELS.tactic_orders,
    group: "전술·훈련",
    readOnly: false,
    description:
      "감독이 판을 세우는 지시를 했을 때 — 라인업·1·2군 이동·팀 전술 6축과 갈래·선수의 자리·역할·개인 지시·세트피스 키커와 인원·지역 플랜·약점 공략·완장. " +
      "한 턴에 한 번 호출하고 적용·반려 결과를 따른다. " +
      "미반영 지시와 필요한 결정을 이번 장면에서 감독에게 알린다. " +
      '감독이 정하지 않고 맡긴 말("알아서 짜세요")에는 부르지 않는다 — 코치의 안을 장면으로 내놓고 감독이 못 박은 턴에 부른다. ' +
      "훈련·육성은 training_orders, 이적·재정은 market_orders다. 회견·대화는 각자의 도구가 있다.",
  },

  {
    name: "training_orders",
    label: CALL_LABELS.training_orders,
    group: "전술·훈련",
    readOnly: false,
    description:
      "감독이 훈련이나 육성을 지시했을 때 — 훈련 일정 등록·비우기·개인 훈련·집중 육성·멘토링·2군 훈련 방침·등번호·유스 첫 계약. " +
      "한 턴에 한 번 부른다. 결과로 무엇이 걸렸고 무엇이 반려됐는지가 온다. " +
      "라인업·전술은 tactic_orders다.",
  },

  {
    name: "market_orders",
    label: CALL_LABELS.market_orders,
    group: "이적",
    readOnly: false,
    description:
      "이적 리스트·이적 요청 답·임대 복귀·이적 예산·보드 요청·표값·스태프 고용·계약 해지·감독직 등 직접 관리 명령을 실행한다. 한 턴에 한 번 부른다. 상대에게 연락하거나 조건을 제안·협상하는 요청은 start_negotiation으로 넘기며 여기서 중복 실행하지 않는다.",
  },

  {
    name: "receive_market_contact",
    label: CALL_LABELS.receive_market_contact,
    group: "이적",
    readOnly: false,
    description:
      "세계 쪽에서 먼저 연락할 맥락이 있을 때 실제 이적 명단 등재(listing)나 계약 기록(contract)을 근거로 상대 구단의 문의를 연다. 감독이 접촉을 지시한 경우는 start_negotiation이다. 선수가 우리 계약이고 상대가 다른 구단인지 검증하며 같은 근거의 연락을 중복 생성하지 않는다. 금액·주급·연수·감독 승인을 만들지 않는다. 상대 판단은 협상 평가가 반환한 결과만 전한다.",
  },
  {
    name: "start_match",
    label: CALL_LABELS.start_match,
    group: "진행",
    readOnly: false,
    description:
      "경기일에 킥오프를 준비한다. 감독이 들어가자고 할 때, 또는 경기 전 점검(라인업·전술·팀토크)이 끝나 " +
      "그날 남은 일이 경기뿐일 때 되묻지 말고 부른다. " +
      "성공하면 이번 턴이 이 호출로 끝나고 장면을 쓰지 않는다. 같은 턴에 필요한 다른 호출은 먼저 부른다.",
  },
  {
    name: "start_negotiation",
    label: CALL_LABELS.start_negotiation,
    group: "진행",
    readOnly: false,
    description:
      "상대 구단·선수 측과의 접촉과 교섭을 연다. party=club은 구단 조건, agent는 개인 조건이다. method는 meeting·phone·proposal이며 같은 상대의 테이블을 이어 쓴다. mode=request는 감독이 맡긴 요청을 처리해 메인 대화로 결과를 돌려주고, continue는 감독이 직접 주고받는 협상 대화를 연다. continue가 성공하면 이번 턴이 이 호출로 끝나고 장면을 쓰지 않는다. 같은 턴에 필요한 다른 호출은 먼저 부른다. 열린 거래의 negotiationId 또는 대상 playerId·kind를 쓴다. 합의된 거래의 계약 확정도 그 거래를 continue로 연다 — 서명은 감독이 테이블의 계약서에서 한다. 감독이 말하지 않은 금액·계약 연수·발신 권한을 만들지 않는다. 결과가 대기·실패이면 합의한 것처럼 서술하지 않는다.",
  },
  {
    name: "team_talk",
    label: CALL_LABELS.team_talk,
    group: "대화·서사",
    readOnly: false,
    description:
      "감독이 선수단이나 이름을 부른 선수에게 한 발화의 결과를 기록한다. " +
      "판정은 의미 있는 대화가 마무리된 턴에 한 번 선다 — 감독이 자리를 뜨거나 화제가 닫히거나 장면이 넘어갈 때다. 대화 도중에는 부르지 않는다. " +
      "players에 이름을 적으면 그 사람들, 비우면 선수단 전체다. " +
      "reaction은 발화·기억·관계·처지에 근거해 target 또는 team에 -1~1의 반응을 적고 reason에 이유를 쓴다. " +
      "" +
      "불만은 이름을 부른 사람에게 사기가 오른 결과에서만 풀린다. " +
      "아직 겉도는 새 영입의 적응은 settling(무게)과 settlingNote(근거)에, 감독이 이번 턴에 못 박은 약속만 promise에 — 상대가 한 명일 때만 장부에 서고, 지난 턴의 약속과 자리를 빼는 말에는 싣지 않는다. " +
      "들은 선수 중 할 말이 생긴 이의 심경은 moods에.",
  },
  {
    name: "review_board",
    label: CALL_LABELS.review_board,
    group: "대화·서사",
    readOnly: false,
    description:
      "구단주와의 장면에서 전한 판단을 기록한다. expectations는 합의한 기대, assessment는 근거, confidence는 신뢰 변화(-1~1)다. 완료된 시즌 평가에는 season을 지정한다. decision은 continue(경고 해제), warning, dismiss다. 경질에는 이전 날짜의 경고가 필요하다. 계약 만료 전 90일에는 renewal로 재계약 제안 여부를 한 번 판정한다. 순위·원형 표로 판정하지 않는다.",
  },
  {
    name: "respond_to_media",
    label: CALL_LABELS.respond_to_media,
    group: "대화·서사",
    readOnly: false,
    description:
      "감독이 기자회견에 답한 결과를 기록한다 — 스냅샷에 <press>가 없으면 쓰지 마라. " +
      "그 자리를 장면으로 열고, 질문은 사실 카드를 기자의 말로 옮겨 써라 — 그대로 읽지 않는다. 감독이 아직 답하지 않은 턴에는 묻기만 하고 이 도구를 부르지 않는다. " +
      "상대 감독 카드가 서면 기자가 그 말을 인용해 묻고, 감독이 그를 겨누면 targetManager에 이름을 적는다. " +
      "감독의 실제 발화와 기자·선수의 맥락에서 reaction을 판단한다. reason에 근거, 축별 -1~1 연속값에 방향과 강도를 기록한다. 태도만으로 효과의 부호를 정하지 않는다. " +
      "회견을 거절하거나 자리를 피했으면 decline: true. 이름이 불린 선수의 심경은 mood에.",
  },
  {
    name: "respond_to_approach",
    label: CALL_LABELS.respond_to_approach,
    group: "대화·서사",
    readOnly: false,
    description:
      "먼저 열린 자리에 감독이 답한 결과를 기록한다(스냅샷의 <approach>가 없으면 쓰지 마라). " +
      "자리가 열려 있으면 지목된 화자로 장면을 열되 사실을 그대로 읽지 말고 그 사람의 말로 옮겨라. 감독이 아직 답하지 않은 턴에는 그 사람의 말까지만 쓰고 부르지 않는다. " +
      "감독의 답과 상대의 사정에서 reaction의 근거와 축별 -1~1 반응을 판단한다. 자리를 주지 않고 돌려보냈으면 decline: true. 찾아온 선수의 심경은 mood에. " +
      "보드의 기대와 평가는 review_board로 기록한다. " +
      "불만은 대화·승격·선발로 풀린다. " +
      "이적 요청이 선 선수의 자리에서 답하면 요청도 닫힌다 — 팔지·거부할지는 감독의 직접 지시로 정한다. " +
      "감독직 면접에서는 interview에 제안 여부(offer), 협상 성과(leverage 0~1), 근거(reason)를 판단한다. 0은 기본 조건, 1은 계약 상한이다.",
  },
  {
    name: "record_incident",
    label: CALL_LABELS.record_incident,
    group: "대화·서사",
    readOnly: false,
    description:
      "벌금·포상·휴가·병문안·공개 칭찬과 질책·사과·중재·라커룸 규칙·회식처럼 다른 도구가 없는 행동을 감독이 했을 때 세운다. " +
      `kind는 사건의 종류다: ${INCIDENT_KINDS.map((k) => `${k}(${INCIDENT_KIND_KO[k]})`).join(" · ")}. ` +
      "playerIds는 당사자의 이름, intensity는 기억의 중요도 1~3, summary는 무슨 일이었나 한 줄. reaction에는 근거와 target·team의 -1~1 반응을 판단한다. 종류만으로 효과를 정하지 않는다. 적응에 영향을 주었다면 settling에 -1~1 방향과 강도를 쓴다. " +
      `사기만 움직이고 능력치·컨디션은 그대로다. 하루 ${MAX_INCIDENTS_PER_DAY}건까지. 당사자의 심경은 moods에.`,
  },
  {
    name: "apply_finance_event",
    label: CALL_LABELS.apply_finance_event,
    group: "재정",
    readOnly: false,
    description:
      "서사에서 벌어진 매출·비용을 장부에 남긴다 — 스폰서가 보너스를 얹거나(commercial), 유니폼이 동나거나(merchandising), 관중이 몰리거나(matchday), 시설이 망가지거나(facility), 원정 의료비가 들거나(travel_medical), 선수단에 포상을 주는(bonus) 일. " +
      "경기 운영비는 matchday_opex. 중계권·주급·이적료·상각·상금은 코어가 계산하므로 이 도구로 건드릴 수 없다. " +
      "£10k 미만의 식사·회식·택시 같은 일상 비용은 기록하거나 금액을 올려 잡지 않는다. 원장에 들어가 월간 보고서와 PSR에 그대로 반영된다.",
  },
  {
    name: "resign",
    label: CALL_LABELS.resign,
    group: "진행",
    readOnly: false,
    description:
      "감독이 계약을 마치기 전에 떠난다 — 계약 잔여에 따른 위약금은 구단 장부와 커리어 기록에 남는다. " +
      "감독이 명확히 사임하겠다고 말했을 때만 부른다. 불만·이직 고민은 사임이 아니다. " +
      "부르면 무직이 되고 되돌릴 수 없다.",
  },
  {
    name: "search_players",
    label: CALL_LABELS.search_players,
    group: "조회",
    readOnly: true,
    description:
      '포지션·이름·나이·가용 상태에 계약 잔여·값·주급·리스트·홈그로운·잠재력·주발까지 걸어 찾는다. team="mine"은 우리 팀, 팀 id·이름은 특정 팀. ' +
      "team을 생략하면 풀이 5대 리그 1·2부 전체이므로, 우리 리그 안에서 비교할 때는 competition(epl 등)으로 좁힌다. " +
      'squadLevel="reserve"는 2군 유망주. 조건은 도구가 걸어라 — limit만큼 훑어 고르지 마라. ' +
      "sortBy는 age·fatigue·contract만 낮은 쪽이 앞이다. " +
      "우리 선수는 정확한 정보, 타 팀 선수는 지식 수준에 따른 평가와 값·계약 만료일을 준다. " +
      "playerId를 주면 능력치·컨디션·계약·배치에 부상 이력과 이번 시즌 경고 누적·이동 이력, 이번 시즌과 지난 시즌의 대회별 기록(리그·컵·대항전 각각 몇 경기 몇 골), 타 팀 선수라면 끝난 스카우트 보고서(도착 날짜·요구액·기대 주급)까지 붙은 상세 카드가 나온다 — 감독이 특정 선수를 두고 물으면 그 선수를 논하기 전에 먼저 호출한다.",
  },
  {
    name: "get_squad",
    label: CALL_LABELS.get_squad,
    group: "조회",
    readOnly: true,
    description:
      "우리 팀의 현재 배치를 본다 — 포메이션·팀 전술과 선발 11명·벤치·예비(배치 없음)를 자리 순서대로, " +
      "각자의 자리 적합도·포지션 적응도·전술 적응도·폼·체력과 부상·정지·경고 누적·불만 경고까지. " +
      'level="reserve"면 2군, role="starting"이면 선발만 본다. ' +
      "라인업·포지션·교체를 논하기 전에 호출한다. 타 팀 스쿼드는 볼 수 없다 — 상대 전력은 get_team으로.",
  },
  {
    name: "get_team",
    label: CALL_LABELS.get_team,
    group: "조회",
    readOnly: true,
    description:
      "팀의 순위·전적·전술·최근 경기·주요 선수를 조회한다. 다음 상대를 브리핑하거나 감독이 다른 팀을 물을 때 사용한다.",
  },
  {
    name: "get_league",
    label: CALL_LABELS.get_league,
    group: "조회",
    readOnly: true,
    description:
      'view="standings" 순위표(competition으로 다른 리그·대항전도) — 행마다 최근 5경기 폼이 붙고, split="home"·"away"면 홈·원정 소계로 다시 세운 표다. 국내 컵은 대진표가 온다. ' +
      'view="leaders" 그 대회의 개인 순위(득점·도움·평점·클린시트·징계 상위 10 · key로 한 축만)와 팀 열(득점·실점·무실점·슛·xG). 리그·국내 컵·대항전 모두 선다. ' +
      'view="fixtures" 일정 검색 — team(기준 팀, 생략하면 우리 팀, "all"이면 대회 전체), opponent(맞대결만 · 전적 요약), competition, when(past·upcoming·both), from·to, round, count. ' +
      'view="calendar" 감독의 달력 — 경기·훈련·이적창을 날짜순으로. 기본 오늘부터 14일이고 from·to·days로 범위를, type="training"으로 훈련만 본다. 새 훈련을 잡기 전에 이걸로 확인하라. from이 지난 날이면 그 사이 벌어진 일이 일지로 함께 온다.',
  },
  {
    name: "get_match_report",
    label: CALL_LABELS.get_match_report,
    group: "조회",
    readOnly: true,
    description:
      "끝난 경기 하나를 통째로 읽는다 — 타임라인(골의 원인 태그 포함)·팀 스탯(점유·슛·xG·기대 득점·패스·코너·파울·카드)·선수별 기록·평점과 그 한 줄 근거·MOTM. " +
      "감독이 지난 경기의 내용·패인·누가 잘했는지를 물으면 스코어만 들고 답하지 말고 이걸 부른다. " +
      "경기는 opponent(상대 팀 이름·약칭)·competition(epl·ucl·facup 등)·date(YYYY-MM-DD)로 고르고, 아무것도 주지 않으면 가장 최근에 끝난 우리 경기다. matchId를 알면 그것만 준다.",
  },
  {
    name: "get_opponent_report",
    label: CALL_LABELS.get_opponent_report,
    group: "조회",
    readOnly: true,
    description:
      "다음 경기 상대를 경기 전에 읽는다 — 예상 XI(상대의 직전 경기 선발에서 투영)·결장자(부상·정지)·상대 모양과 전술 6축·감독이 읽어 낸 지점(전술 상성과 미스매치). " +
      '감독이 경기 전에 상대를 묻거나("쟤네 어떻게 나와") 누굴 노릴지·누굴 세울지 상의하면 순위와 최근 5경기만 들고 답하지 말고 이걸 부른다. ' +
      "지점 줄의 +는 우리에게 이로운 것, -는 상대에게 이로운 것이다. " +
      "경기는 opponent(상대 팀 이름·약칭)·competition(epl·ucl·facup 등)·date(YYYY-MM-DD)로 고르고, 아무것도 주지 않으면 다음 우리 경기다. " +
      "⚠️ 예상 XI는 예상이다 — 상대가 로테이션을 돌리면 갈리므로 확정으로 말하지 않는다. 경기 중에는 부를 수 없다(판세 화면이 지금 판을 들고 있다).",
  },
  {
    name: "get_career",
    label: CALL_LABELS.get_career,
    group: "조회",
    readOnly: true,
    description:
      "감독의 커리어 — 이번 시즌 진행 상황, 지난 시즌들의 순위·전적·보드 평가, 트로피, 업적, 맡은 팀이 받은 시상. " +
      "지나간 시즌의 순위표·우승자·감독 팀의 경기는 get_history가 낸다.",
  },
  {
    name: "get_history",
    label: CALL_LABELS.get_history,
    group: "조회",
    readOnly: true,
    description:
      "지나간 시즌의 장부를 읽는다. season으로 그 시즌의 우승자와 우리 성적을, season+competition으로 그 시즌 그 대회의 최종 순위표(녹아웃은 우승·준우승)를 본다. " +
      'team이면 그 구단의 역대 — 우승 횟수·한 시즌 최다 승점·최다 득점·최고 순위·그 구단 소속의 시상. player면 그 선수의 통산·팀별·시즌별 기록과 받은 상(은퇴한 선수도 찾는다) — 시즌 줄이 대회별로 갈리므로 "작년 챔스에서 몇 골"이 여기서 답이 된다. ' +
      "competition만 주면 그 대회의 역대 우승이 시즌마다 한 줄로 온다. 아무것도 주지 않으면 지나간 시즌 목록이 최근부터 온다. " +
      "지난 시즌을 두고 순위·우승·구단 역사·역대 최다를 물으면 지어내지 말고 이걸 부른다. " +
      "장부에 남은 지난 시즌 경기는 감독 팀의 것뿐이다 — 남의 팀끼리의 지난 시즌 스코어는 없고, 없는 것은 없다고 답한다.",
  },
  {
    name: "get_finance",
    label: CALL_LABELS.get_finance,
    group: "조회",
    readOnly: true,
    description:
      '구단 재정을 조회한다 — 잔고·이적 예산·주급 총액·주급 여력·미지급 분할 회분·부채·1년 안에 끝나는 계약 전원, 월간 보고서(수입·지출, 현금 순증과 장부 손익, 급여 비중, PSR 여유), 이번 달 잠정 집계. month를 주면 그 달 보고서만 본다("2026-08"). 영입은 오퍼 전에 이것부터 읽어라 — 주급 여력이 음수면 못 산다.',
  },
  {
    name: "request_scouting",
    label: "스카우팅 의뢰",
    group: "조회",
    readOnly: false,
    description:
      "선수 조사·후보 탐색·비교·추가 질문을 의뢰하거나 변경·취소·재시도한다. 감독이 말한 대상·조건·질문·기한만 싣는다. 조사 범위와 기한은 평가된 계획이 정하며, 조건 변경이 필요한 요청은 보류한다. 완료 보고서는 보존되므로 지난 보고서를 묻는 말에 재의뢰하지 않는다. 의뢰 자체는 접촉·오퍼·영입을 승인하지 않는다.",
  },
  {
    name: "list_negotiations",
    label: CALL_LABELS.list_negotiations,
    group: "이적",
    readOnly: true,
    description:
      "진행 중인 협상을 요약한다. negotiationId를 주면 교류 이력·조건서·당사자별 승인과 후속 연락을 자세히 본다.",
  },
] as const satisfies readonly SkillCatalogEntry[];

export type SkillName = (typeof SKILL_CATALOG)[number]["name"];
export type SkillDescriptions = Record<SkillName, string>;

export const SKILL_NAMES = SKILL_CATALOG.map((skill) => skill.name);

export const DEFAULT_SKILL_DESCRIPTIONS = Object.fromEntries(
  SKILL_CATALOG.map((skill) => [skill.name, skill.description]),
) as SkillDescriptions;

/** 이번 LLM 턴에 실릴 도구 설명 — 코드가 유일한 원본이다 (prompts.md §2). */
export function skillDescriptions(): SkillDescriptions {
  return DEFAULT_SKILL_DESCRIPTIONS;
}
