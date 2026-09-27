// @story-fm/engine 공개 API — 폴더가 도메인이다.

// core — 난수·경로·날짜·게임 상태·저장·시간 진행
export * from "./common/core/rng";
export * from "./common/core/paths";
export * from "./common/core/dates";
export * from "./common/core/name-match";
export * from "./common/core/state";
export * from "./common/core/history-window";
export * from "./common/core/turn-facts";
export * from "./common/core/journal";
export * from "./common/core/player-ref";
export * from "./common/core/team-ref";
export * from "./common/core/league-shape";
export * from "./common/core/club-tier";
export * from "./app/persistence";
export * from "./common/core/save-lock";
export * from "./app/tick";
export * from "./match/squad/simulation";

// data — 카탈로그·시드 (불변 초기치)
export * from "./common/data/names";
export * from "./common/data/team-catalog";
export * from "./common/data/coach-seeds";
export * from "./common/data/owner-seeds";
export * from "./common/data/league-catalog";
export * from "./common/data/cup-catalog";
export * from "./common/data/discipline-catalog";
export * from "./common/data/domestic-cup-catalog";
export * from "./common/data/super-cup-catalog";
export * from "./common/data/club-profile";
export * from "./common/data/pseudonym";
export * from "./common/data/league-economy";
export * from "./common/data/catalog-source";
export * from "./common/data/team-override";
export * from "./common/data/cup-override";

// world — 새 게임의 세계 구축 (능력치 파생·카탈로그 빌드·생성·주급·인물)
export * from "./common/world/attributes";
export * from "./common/world/player-id";
export * from "./common/world/catalog";
export * from "./common/people/persona";
export * from "./common/people/player-persona";
export * from "./story/people/people-directory";
export * from "./story/people/relations";
export * from "./common/world/generate";
export * from "./negotiation/economy/wages";
export * from "./story/people/onboarding";
export * from "./app/admin/admin";
export * from "./app/admin/admin-team";
export * from "./app/admin/admin-competition";
export * from "./app/catalog-invariants";
export * from "./common/world/scope";
export * from "./negotiation/players/player-pool";

// competition — 시즌 달력·리그·컵·유럽 대항전
export * from "./match/competition/calendar";
export * from "./match/competition/pairings";
export * from "./common/core/international-breaks";
export * from "./common/core/calendar";
export * from "./match/competition/fixtures";
export * from "./match/competition/friendly";
export * from "./common/core/match-kinds";
export * from "./match/competition/reserve";
export * from "./common/views/standings";
export * from "./app/season";
export * from "./common/players/career";
export * from "./common/views/board-expectation";
export * from "./match/competition/leaderboard";
export * from "./match/competition/records";
export * from "./common/views/manager-career";
export * from "./match/competition/europe";
export * from "./common/views/europe";
export * from "./match/competition/euro-knockout";
export * from "./app/workflows/match/competition/euro-knockout";
export * from "./app/workflows/match/competition/euro-prize";
export * from "./match/competition/shootout";
export * from "./match/competition/extra-time";
export * from "./app/workflows/match/competition/extra-time";
export * from "./match/competition/promotion";
export * from "./app/workflows/match/competition/promotion";
export * from "./common/core/league-membership";
export * from "./match/competition/prediction";
export * from "./common/views/prediction";
export * from "./match/competition/international";
export * from "./app/workflows/match/competition/international";
export * from "./common/players/international";
export * from "./match/competition/club-tier-recompute";
export * from "./match/competition/domestic-cup";
export * from "./app/workflows/match/competition/domestic-cup";
export * from "./common/views/cup-entrants";
export * from "./match/competition/super-cup";
export * from "./app/workflows/match/competition/super-cup";
export * from "./match/competition/draw-schedule";
export * from "./match/competition/reschedule";

// match — 경기 진행·간이 시뮬·평점·징계
export * from "./match/flow/match-flow";
export * from "./app/workflows/match/flow/match-flow";
export * from "./match/flow/preview";
export * from "./match/flow/quick-sim";
export * from "./match/flow/ratings";

// squad — 선수단 상태(폼·심경·부상·정착)와 성장·훈련·스카우팅
export * from "./common/players/squad-depth";
export * from "./common/players/hierarchy";
export * from "./story/players/mentoring";
export * from "./common/players/mentoring";
export * from "./common/players/form";
export * from "./story/players/slump";
export * from "./match/squad/other-clubs";
export * from "./story/players/mood";
export * from "./app/workflows/story/players/mood";
export * from "./common/players/mood-notes";
export * from "./story/players/cues";
export * from "./story/players/coach-cues";
export * from "./app/workflows/story/players/coach-cues";
export * from "./common/players/settling";
export * from "./common/players/injury";
export * from "./story/players/development";
export * from "./common/players/registration";
export * from "./match/squad/demotion";
export * from "./common/players/contract-status";
export * from "./negotiation/players/promises";
export * from "./common/players/observation";
export * from "./negotiation/players/scouting";
export * from "./negotiation/players/scout-mission";
export * from "./story/players/training-plan";
export * from "./story/players/training-report";
export * from "./app/workflows/story/players/training-report";
export * from "./common/players/attribute-growth";
export * from "./common/players/numbers";
export * from "./story/players/career";

// market — 이적 시장·협상·메디컬·감독 시장
export * from "./negotiation/market/market";
export * from "./negotiation/market/agent-profile";
export * from "./negotiation/market/interest";
export * from "./negotiation/market/negotiation";
export * from "./app/workflows/negotiation/market/negotiation";
export * from "./negotiation/market/counter-bounds";
export * from "./negotiation/market/counterparty";
export * from "./negotiation/market/mandate";
export * from "./app/workflows/negotiation/market/mandate";
export * from "./negotiation/market/table";
export * from "./story/people/openings";
export * from "./negotiation/market/clauses";
export * from "./negotiation/market/ai-market";
export * from "./negotiation/market/medical";
export * from "./negotiation/market/departures";
export * from "./app/workflows/negotiation/market/departures";
export * from "./negotiation/market/manager-market";
export * from "./app/workflows/negotiation/market/manager-market";
export * from "./negotiation/market/staff-market";
export * from "./negotiation/market/persuasion";
export * from "./negotiation/market/terms";
export * from "./negotiation/market/buyout";
export * from "./negotiation/market/proposal";
export * from "./negotiation/economy/valuation";

// club — 구단 재정·기자회견
export * from "./negotiation/finance/finance";
export * from "./story/world/press";
export * from "./app/workflows/story/world/press";
export * from "./story/world/media";
export * from "./app/workflows/story/world/media";
export * from "./story/world/approach";
export * from "./app/workflows/story/world/approach";
export * from "./negotiation/finance/board-request";
export * from "./app/workflows/negotiation/finance/board-request";
export * from "./negotiation/finance/manager-wallet";
export * from "./app/workflows/story/world/board";

// commands — 감독 지시(도구·해석기)가 닿는 코어 명령의 실행부
export * from "./app/commands";

// views — 오피스 뷰·읽기 전용 조회
export * from "./app/calendar-view";
export * from "./negotiation/views/finance";
export * from "./match/views/live";
export * from "./app/views/squad";
export * from "./app/views/career";
export * from "./match/views/competition";
export * from "./app/views";
export * from "./negotiation/views/room";
export * from "./common/views/observation";
export * from "./common/views/colours";
export * from "./negotiation/views/scouting";
export * from "./match/views/report";
export * from "./app/player-card";
export * from "./app/lookup";
export * from "./negotiation/views/finance-outlook";

export * from "./app/create-game";
export * from "./match/squad/selection";

export * from "./story/world/social";

export * from "./app/workflows/match/health/injury";
