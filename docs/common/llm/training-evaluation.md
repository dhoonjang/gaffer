# 훈련 평가 하네스

`packages/agents/harness/training-eval.ts`는 고정 시드의 메모리 게임에서 훈련 명령과
하루 시간 진행으로 브리프를 만든다. 소규모 선수군과 전체 선수단을 대상으로
Jev 출력부터 훈련 결산 반영까지 확인한다.

```bash
pnpm exec tsx packages/agents/harness/training-eval.ts --out /tmp/training-eval-example
pnpm exec tsx packages/agents/harness/training-eval.ts --out /tmp/training-eval-live --live
```

`--case small` 또는 `--case full-squad`로 대상을 고른다. 기본 실행은 입력과 질문만
조립한다. 실호출은 `TYPESAFE_API_KEY`와 `config/llm.yml`의 `training-rater` 평가
설정을 사용한다. 결과는 새 `/tmp` 디렉터리의 `report.json`·`summary.md`에 저장하며,
사용자 `.log`·`.data`나 저장 게임을 열지 않는다.

## 확인하는 경계

- 응답 대상·카드 스키마·실제 훈련 대상의 일치.
- 선수 값의 범위, 성장 기록과 결과 카드의 일치.
- 결산 표식과 중복 반영 방지.
- 실행 소스 지문·모델 설정·요청과 재시도·보고 사용량의 기록.

지연은 `evaluateTraining`과 `applyTrainingOutcomes`를 포함하고 게임 생성·사후
검사·GM 서사는 제외한다. 비용은 보고된 사용량과 설정 가격으로 계산한다.
하루짜리 합성 사례는 응답과 반영 경계를 확인하며, 다일 훈련의 판단 품질이나
장기 성장 밸런스를 대표하지 않는다. 성장 곡선과 상한은 코어 테스트,
분포는 [밸런스 하네스](../balance-harness.md)에서 확인한다.
