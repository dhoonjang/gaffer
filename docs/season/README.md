# season — 시즌

시즌의 달력과 대회를 소유한다 — 일정 축과 시즌 편성, 일정 재편성, 리그·국내 컵·유럽 대항전·
슈퍼컵·2군 리그·프리시즌 친선, 대표팀 서열과 소집, 순위표와 리더보드, 상금, 시즌 시상, 구단 역사와
트로피, 언론의 예상 순위, 구단 체급 재산정. 상금은 `core`의 장부 연산으로만 기록한다.

하루의 진행과 시즌 전환은 이 규칙들을 `app`이 순서대로 부르는 일이다.

## 문서

- [시즌 — 달력 · 대회 · 시간 진행 · 시즌 전환](season.md)
- [대회](competition.md)

## 코드

- `packages/domain/src/season/`
- `packages/engine/src/season/`
- 승강과 낙하산은 `packages/engine/src/app/workflows/promotion.ts`

[문서 지도](../README.md) · [책임 구조](../architecture.md)
