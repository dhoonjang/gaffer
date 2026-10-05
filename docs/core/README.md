# core — 게임 상태와 세계의 기준 표

도메인이 아니라 모든 도메인이 딛는 바닥이다. 세이브 하나의 모양(`GameState`)과 그 위의 조회·기록
원시 연산 — 날짜와 시즌 달력, 시드 난수, 이름으로 사람·구단을 집는 해석, 명령 결과(`CommandResult`·
`brief`), 재정 장부의 기록(`recordFinance`·`payOnce`), 저널, 저장 잠금, 이력 창, 리그 소속·구단
체급, 경기의 종류·더비·대표팀 휴식기 같은 일정 사실 — 을 둔다. 규칙과 밸런스 수치는 갖지 않는다.

`core/catalog/`는 게임 상태가 직접 읽는 세계의 기준 표다 — 팀·리그·국내 컵·유럽 대항전·슈퍼컵·
징계 규정 카탈로그, 구단 프로필과 색, 더비 표, 이름 풀, 가명 매핑, 카탈로그 오버라이드 배관.
선수 카탈로그는 players, 인물 카탈로그는 people이 갖는다.

## 문서

- [데이터 모델](game-state.md)
- [시드 데이터와 출처](sources.md)

## 코드

- `packages/domain/src/core/` — 날짜 문자열·사건(`TickEvent`)·돈·조사·결정적 수학·카탈로그 입력
- `packages/engine/src/core/`
- `packages/engine/src/core/catalog/`

[문서 지도](../README.md) · [책임 구조](../architecture.md)
