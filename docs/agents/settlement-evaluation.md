# 경기 결산 평가 하네스

`packages/agents/harness/settlement-eval.ts`는 메모리 게임의 공간 경기를 종료까지
실행하고, 실제 출전 선수·사건·평점 앵커로 Jev 결산과 코어 반영을 확인한다.

```bash
pnpm exec tsx packages/agents/harness/settlement-eval.ts --out /tmp/settlement-eval-example
pnpm exec tsx packages/agents/harness/settlement-eval.ts --out /tmp/settlement-eval-live --live
```

기본 실행은 외부 호출 없이 경기와 요청을 조립한다. `--live`는
`config/llm.yml`의 `evaluators.finalize-match`와 `TYPESAFE_API_KEY`를 사용한다.
출력은 새 `/tmp` 디렉터리의 `report.json`·`summary.md`이며 사용자 저장 게임과
`.log`·`.data`를 읽거나 쓰지 않는다.

## 확인하는 경계

- 출전 선수만 결산하고 응답의 대상과 실제 반영 대상을 일치시킨다.
- 평점과 성장·적응 변화가 코어의 앵커·허용 범위 안에 있다.
- 능력치 변화와 성장 원장이 대응하며 같은 결산을 두 번 반영하지 않는다.
- 보고서에 실행 소스 지문·모델 설정·질문 수·사용량·실패를 남긴다.

지연은 타입 평가와 `settleMatchRating` 반영을 포함하고 경기 생성·진행·GM 서사·
사후 검사는 제외한다. 비용은 보고된 토큰과 설정 가격으로 계산한다.
가격이나 사용량이 없으면 미확정으로 읽는다.

이 하네스는 결산 경로를 검증한다. 생성 중계의 품질, 전체 GM 마감 턴의 지연,
장기 성장 밸런스는 각각 해당 평가·테스트·[밸런스 하네스](../balance-harness.md)의 범위다.
실행 결과는 보고서의 소스 지문과 모델 설정을 기준으로 해석한다.
