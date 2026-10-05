# app — 도메인을 함께 움직이는 일

여러 도메인을 함께 움직이는 일을 소유한다 — 새 게임 생성, 하루의 진행(`tick`), 시즌 종료와
전환, 저장과 세이브 스키마, GM 조회 도구, 통합 화면 뷰, 도메인을 가로지르는 업무 흐름
(`workflows/`), 어드민. 수치 규칙과 원장은 소유 도메인에 두고 여기서는 호출 순서만 정한다.

## 문서

- [시즌 — 시간 진행 · 시즌 전환](../season/season.md) §5·§6

## 코드

- `packages/engine/src/app/` — `tick.ts` · `season.ts` · `create-game.ts` · `persistence.ts` · `save-schema.ts`
- `packages/engine/src/app/lookup/` — GM 조회 도구 하나가 파일 하나
- `packages/engine/src/app/views/` — 통합 화면 뷰
- `packages/engine/src/app/workflows/` — 도메인을 가로지르는 업무 흐름
- `packages/engine/src/app/admin/` — 카탈로그 어드민

[문서 지도](../README.md) · [책임 구조](../architecture.md)
