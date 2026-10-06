# Gaffer 문서

Gaffer는 자연어로 감독이 되어 서사·협상·경기를 즐기는 게임이다.
[서비스 개요](overview.md)와 [책임 구조](architecture.md)부터 읽는다.

문서의 폴더는 코드의 폴더와 같다 — 도메인 하나가 폴더 하나다
([architecture.md](architecture.md) §1). 아래 표는 의존 방향의 아래에서 위 순서다.

| 폴더                         | 소유하는 일                                               | 문서                                                                                                               |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [core](core/README.md)       | 게임 상태와 기본 조회·기록, 세계의 기준 표 (도메인 아님)  | [데이터 모델](core/game-state.md) · [시드 데이터와 출처](core/sources.md)                                          |
| [players](players/README.md) | 선수 — 능력·몸 상태·관측·훈련·성장·유스·경력              | [능력치 모델](players/player.md) · [훈련](players/training.md)                                                     |
| [match](match/README.md)     | 경기 시뮬레이션                                           | [경기](match/match.md) · [실시간 경기](match/live-match.md) · [축구 규칙](match/football-reference.md)             |
| [season](season/README.md)   | 시즌 — 일정·대회·순위·상금·시상                           | [시즌](season/season.md) · [대회](season/competition.md)                                                           |
| [team](team/README.md)       | 팀 — 선수단·라인업·전술·이적·재정·이사회                  | [구단](team/team.md) · [재정](team/finance.md) · [보드와 고용](team/board.md) · [이적과 재계약](team/transfers.md) |
| [people](people/README.md)   | 인물 — 로어북·스태프·메일함·언론·감독 커리어              | [인물](people/people.md) · [로어북](people/lorebook.md) · [메일함](people/mail.md) · [커리어](people/career.md)    |
| [app](app/README.md)         | 도메인을 함께 움직이는 일 — 시간 진행·시즌 전환·저장·조회 | [시즌](season/season.md) §5·§6                                                                                     |

호출과 화면: [agents](agents/README.md) — [에이전트](agents/agents.md) · [파이프라인](agents/pipeline.md) ·
[프롬프트](agents/prompts.md) · [모델 설정](agents/models.md). 화면과 디자인 시스템은 코드가
갖는다 — [`apps/web/shared/tokens.css`](../apps/web/shared/tokens.css). 밸런스 관측은
[하네스](balance-harness.md)다.

문서는 현재 동작과 소유권을 설명한다.
