/**
 * 2026-27 시즌 수석코치 이름 시드. 없는 구단은 국적에 맞는 생성 이름을 사용한다.
 * 성격과 대사는 로어북 기반의 게임 서사이며, 진행 중 세이브의 인물은 시드 수정으로 바뀌지 않는다.
 * 출처는 각국 위키백과의 시즌 문서와 네덜란드어 구단 문서 Staf 표다.
 * 이탈리아: organigramma allenatore2, 프랑스: Encadrement technique, 스페인: Cuerpo técnico.
 */
export const HEAD_COACH_NAMES: Record<string, string> = {
  // ── 프리미어리그 (영어권 보도 — 클럽별 검색) ──
  // 아르테타의 오른팔 — 2019년부터 함께한다 (arseblog 2026-01 · arsenalinsider)
  arsenal: "알베르트 스투이벤베르흐",
  // 이라올라 감독과 함께 부임 (ESPN · rousingthekop 2026-05)
  liverpool: "이니고 페레스",
  // 클롭의 전 수석 — 과르디올라 코칭스태프로 합류 (fotmob)
  mancity: "펩 레인더르스",
  // 캐릭 감독 체제의 수석 (2026-27 맨유 시즌 문서)
  manutd: "스티브 홀랜드",
  // 사비 알론소 감독 체제의 수석 (2026-27 첼시 시즌 문서)
  chelsea: "캘럼 맥팔레인",
  // 데 제르비 감독과 함께 (ESPN · Training Ground Guru 2026)
  tottenham: "브루노 살토르",
  // 2026년 7월 합류 — 발렌시아·셰필드 U·오사수나 경력 (avfc.co.uk 2026-07-02)
  astonvilla: "호세 마리아 산스",
  // 아래 6팀은 nl.wikipedia 클럽 문서의 `Staf` 표에서 (영어 위키엔 이 절이 없다).
  // 표마다 "Laatste update"가 달라 **감독 교체가 확인된 팀은 넣지 않았다** —
  // 감독이 바뀌면 스태프도 바뀌므로 낡은 이름이 곧 틀린 이름이 된다.
  newcastle: "플로렌스 코흐", // Florens Koch — 2026 야이슬레와 함께 알아흘리에서
  fulham: "케빈 카르데이로", // Kevin Cardeiro — 2026-07 갱신, 레알 마드리드 출신
  everton: "레이턴 베인스", // Leighton Baines — 모예스 체제
  nottingham: "스티브 스톤", // Steve Stone — 계약 2027
  leeds: "크리스토퍼 욘", // Christopher John — 계약 2027
  brentford: "마틴 드루리", // Martin Drury

  // ── 분데스리가 ──
  // 콤파니 코칭스태프 (ran.de · spox)
  bayern: "르네 마리치",
  leipzig: "톰 치혼", // Tom Cichon — 계약 2027 (nl.wikipedia)

  // ── 라리가 (es.wikipedia `Anexo:Temporada 2026-27 …` — Cuerpo técnico) ──
  // 무리뉴가 페네르바흐체에서 데려온 segundo entrenador (okdiario · eldesmarque 2026-07)
  realmadrid: "주앙 트랄량",
  // 플리크의 오랜 수석 (Marcus Sorg)
  barcelona: "마르쿠스 조르크",

  // ── 세리에A (it.wikipedia 시즌 문서 — organigramma의 `allenatore2`) ──
  // 치부 체제의 vice allenatore — 인테르 선수 출신 (LaPresse · Sky Sport)
  inter: "알렉산다르 콜라로프",
  // 알레그리를 12년째 따라다니는 vice (ilmattino · napolinetwork 2026-05)
  napoli: "마르코 란두치",
  // 아모링 체제 (Carlos Fernandes)
  milan: "카를루스 페르난데스",
  // 스팔레티의 오랜 수석 (Marco Domenichini)
  juventus: "마르코 도메니키니",
  roma: "툴리오 그리티", // Tullio Gritti
  lazio: "루이지 리초", // Luigi Riccio
  fiorentina: "라파엘레 롱고", // Raffaele Longo
  bologna: "안드레아 타로치", // Andrea Tarozzi
  torino: "디에고 라이몬디", // Diego Raimondi
  udinese: "프셰미스와프 마웨츠키", // Przemysław Malecki (POL)
  como: "다니엘 긴도스", // Daniel Guindos López (ESP)
  genoa: "기예르모 자코마시", // Guillermo Giacomazzi (URY)
  parma: "후이 사 레모스", // Rui Sá Lemos (PRT)

  // ── 리그앙 (fr.wikipedia `Saison 2026-2027 …` — Encadrement technique) ──
  psg: "라펠 폴", // Rafel Pol — 루이스 엔리케의 오랜 수석
  marseille: "제레미 브레셰", // Jérémie Bréchet
  monaco: "이반 팔랑코", // Iván Palanco (ESP)
};

/** 이 팀은 실명 수석코치를 아는가 */
export function realCoachNameOf(teamId: string): string | null {
  return HEAD_COACH_NAMES[teamId] ?? null;
}
