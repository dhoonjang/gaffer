# 에이전트 — 모델 호출

모델을 부르는 일을 소유한다. `packages/agents/src`의 폴더는 `config/llm.yml`의 갈래를 따른다.

- `evaluators` — Jev 평가 호출: 지시 해석기와 `tactic-orders`·`training-orders`·`finance-orders`,
  `match-reader`, `finalize-match`, `training-rater`
- `memory` — `lorebook-editor`, `history-compactor`
- `gm` — 장면을 쓰는 호출: 평시 `gm`(메일 회신 포함), `match-gm`, `onboarding-judge`
- `shared` — 모든 호출이 쓰는 재시도·도구 스키마·장면 문법·문맥 블록
- `app` — 턴 라우팅·시간 진행·mock·온보딩

## 문서

- [에이전트 — 누가 무엇을 하나](agents.md)
- [파이프라인](pipeline.md)
- [프롬프트 규약](prompts.md)
- [모델 설정과 추적](models.md)
- [직접 지시 평가](instruction-evaluation.md) · [경기 판독 평가](match-reader-evaluation.md) · [결산 평가](settlement-evaluation.md) · [훈련 평가](training-evaluation.md)

## 코드

- `packages/agents/src/`
- `packages/llm/` — 제공자 어댑터와 추적
- `config/llm.yml`

[문서 지도](../README.md) · [책임 구조](../architecture.md)
