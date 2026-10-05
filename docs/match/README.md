# match — 경기 시뮬레이션

경기 하나를 굴리는 일만 소유한다 — 라인업과 전술에서 시뮬레이터 입력을 조립하는 규칙
(`selection`·`simulation`), 실시간 경기의 흐름(킥오프·체크포인트·마무리), 간이 시뮬, 평점,
징계, 연장과 승부차기, 경기 전 상대 분석과 중계 뷰. 공간 시뮬레이터는 `packages/sim`에 있다.

감독이 짜는 판(라인업·전술·세트피스 지정)은 team이 소유한다.

## 문서

- [경기 시뮬레이션](match.md)
- [실시간 경기](live-match.md)
- [축구 규칙 참고](football-reference.md)

## 코드

- `packages/domain/src/match/`
- `packages/engine/src/match/`
- `packages/sim/`
- 경기 뒤 결산을 엮는 흐름은 `packages/engine/src/app/workflows/match-flow.ts`

[문서 지도](../README.md) · [책임 구조](../architecture.md)
