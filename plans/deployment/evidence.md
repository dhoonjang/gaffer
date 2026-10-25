# Gaffer 배포 설계 확인 근거

기준 커밋 `0a69fac6`, 확인일 2026년 10월 16일. 이 문서는 설계 검토용이며 실행 중인 서비스의 성능 인증이 아니다.

## 합성 새 게임 크기

`GAFFER_DATA_DIR`와 `GAFFER_LOG_DIR`를 `/tmp/gaffer-deployment-design-*`로 격리하고, `LLM_MODE=mock`에서 `createGame`을 한 번 호출했다. seed 42, EPL 첫 카탈로그 팀, 합성 감독 이름/배경을 사용했다. `saveGame`이나 유료 모델 호출은 실행하지 않았다. 실제 사용자 세이브·로그를 읽거나 변경하지 않았다.

| 값                                   |       결과 |
| ------------------------------------ | ---------: |
| JSON UTF-8 bytes                     | 12,819,949 |
| gzip bytes                           |  1,340,901 |
| players JSON bytes                   |  6,506,613 |
| lorebook JSON bytes                  |  4,421,264 |
| contracts JSON bytes                 |    909,949 |
| matches JSON bytes                   |    431,375 |
| tactics JSON bytes                   |    342,720 |
| schedule JSON bytes                  |     94,379 |
| teams JSON bytes                     |     47,913 |
| trainingSessions JSON bytes          |     36,703 |
| 생성 시작부터 직렬화까지의 관측 시간 |    1,473ms |

단일 로컬 표본이며 시간은 생성과 JSON 직렬화가 합쳐진 값이다. 배포 머신의 CPU 시간, P95, 세이브 파싱 시간이나 메모리 heap 측정값이 아니다. gzip 결과는 위 표의 시간 구간 밖이다. 장기 진행·경기 중·시즌 전환 이후 크기는 별도 검증 대상이다.

player/contract 조각만 제외해도 lorebook 약 4.4MB가 본체에 남는다. 향후 chunk 최적화 시 lorebook도 대상이다. 초기 10명 무료안은 gzip 전체 snapshot을 R2에 두어 구현을 줄인다. 이 세이브를 raw JSON으로 300번 전송하면 약 3.846GB이므로 API는 화면용 뷰와 페이지를 반환해야 한다. 이를 현재 UI가 GameState 전체를 전송한다는 주장으로 해석하지 않는다. 현재도 `toPayload`라는 뷰 변환 경계가 있다.

## Claude가 추가 확인한 표본

[Claude 독립안](claude-design.md) §1.2의 측정이다. Codex가 동일 실험을 재실행한 값은 아니며 클라우드 머신 성능으로 환산하지 않는다.

- 새 게임 load 중앙값 133ms, 변경 없는 shard의 save 57ms, view 생성 약 53ms. Apple M2 Max의 합성 테스트다.
- `GameState` 하나의 heap 약 17.3MB, 전체 `toPayload` gzip 약 47KB. 장기 게임·동시 작업·런타임 전체 heap은 별도다.
- 3경기 CLI가 약 39.4 user CPU초를 사용했다. 초기화 등 harness 비용을 포함하므로 checkpoint의 정확한 CPU초를 대신하지 않는다.
- 기존 개발 로그에서 호출이 있는 채팅 턴 148개의 평균 시간 9.0초, p90 15.1초. 기간은 2026-09-13~~10-16이며 게임 버전 9.x~~21.x가 섞여 있다. 호출이 있는 표본의 실패 2개, 평균 호출 3개·입력 37.6k·출력 957 token이었다. 원문·개별 식별자를 출력하지 않고 metadata만 집계했다.
- 이 값은 개발자 한 명의 역사적 로그이며 현재 모델·신규 사용자·동시 10명의 성능/비용 약속이 아니다. 최종 비용표는 30/60초 민감도를 따로 사용한다.

**비용 집계의 추가 한계:** [gemini-adapter.ts](../../packages/llm/src/gemini-adapter.ts)의 `addUsage`는 `outputTokens`에 `candidatesTokenCount`만 넣고 `thoughtsTokenCount`는 기록하지 않는다. Google은 사고 토큰을 출력 과금에 포함한다. 따라서 위 출력 토큰과 Claude의 약 $0.019/턴 계산을 전체 청구액으로 사용할 수 없다. 실제 호출별 계측을 보완하고 청구서와 대조하는 것이 출시 조건이다. 과거 누락 값을 추측해서 채우지 않는다. [Google thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking), [요금](https://ai.google.dev/gemini-api/docs/pricing)

실제 사용자 세이브는 읽지 않았다. 위 개발 로그 metadata 조회는 AGENTS의 허용 범위 안에서 Claude가 수행했으며 파일 변경·삭제와 새 유료 모델 호출은 하지 않았다.

## 코드에서 확인한 운영 경계

| 확인 대상                                         | 근거                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| 소유자 없는 게임 목록·생성                        | [`route.ts`](../../apps/web/app/api/games/route.ts)                      |
| 파일 JSON 및 조각 저장, 코드 SAVE_VERSION 29      | [`persistence.ts`](../../packages/engine/src/app/persistence.ts)         |
| 호스트/PID 기반 파일 잠금                         | [`save-lock.ts`](../../packages/engine/src/core/save-lock.ts)            |
| 메모리 큐와 턴 전체 잠금, 성공 시 저장            | [`turn-runner.ts`](../../apps/web/game/turn-runner.ts)                   |
| 요청 생명주기에서 NDJSON 실행                     | [`stream route`](../../apps/web/app/api/games/[id]/turn/stream/route.ts) |
| 프로세스 Map의 중복 명령과 동기 checkpoint 재실행 | [`live-match-server.ts`](../../apps/web/game/live-match-server.ts)       |
| 기억 편집 Map 및 별도 버전 검사                   | [`lorebook-jobs.ts`](../../apps/web/game/lorebook-jobs.ts)               |
| 메모리 사용량 장부                                | [`usage-meter.ts`](../../packages/llm/src/usage-meter.ts)                |
| production에서 상세 trace 비활성                  | [`turn-trace.ts`](../../packages/llm/src/turn-trace.ts)                  |
| 인증 없이 환경변수로 admin 쓰기 허용 판단         | [`admin-guard.ts`](../../apps/web/app/api/admin/admin-guard.ts)          |

## 문서와 코드가 다른 지점

[`live-match.md`](../../docs/match/live-match.md) §8.4는 단일 클라이언트 임대를 설명하지만, 현행 `live-match-server.ts`, live 라우트와 `use-live-match.ts`에는 서버의 client lease/epoch 검사가 없다. 문서만으로 멀티디바이스 배타성이 구현됐다고 판단하지 않는다. 같은 문서 하단의 SAVE_VERSION 18과 코드의 29도 다르다. 이번 작업에서는 기존 도메인 문서를 수정하지 않았으며, 구현 단계에서 해당 문서를 현재 코드와 새 계약에 맞춰 정리해야 한다.

## 외부 자료 확인

- [Next.js self hosting](https://nextjs.org/docs/app/guides/self-hosting): 스트림 버퍼링, 인스턴스별 캐시와 배포 버전 차이.
- [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html): SKIP LOCKED의 큐 사용과 일관된 일반 조회에 대한 한계.
- [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): 소유자·BYPASSRLS와 FORCE ROW LEVEL SECURITY.
- [Cognito authorize](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html): code + S256 PKCE.
- [ECS 종료](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html), [task protection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection.html): 종료 유예와 보호 범위.
- [ALB 속성](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html): 연결 idle timeout.
- [S3 일관성](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html): PUT 이후 읽기와 객체 버전 관리.
- [RDS 백업](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html): 시점 복구 보존 기간.
- [Fargate 요금](https://aws.amazon.com/fargate/pricing/), [RDS 요금](https://aws.amazon.com/rds/postgresql/pricing/): 리전·리소스·사용량에 따른 과금. 설계의 금액은 예산 범위이며 이 페이지에서 확정 견적을 받은 것이 아니다.
- [Railway 리전](https://docs.railway.com/deployments/regions), [Supabase 리전](https://supabase.com/docs/guides/platform/regions): 대안의 지역 선택.
- [PostHog 수집 제어](https://posthog.com/docs/privacy/data-collection): autocapture 및 opt-out. 공식 Markdown 응답을 읽었다.
- [Sentry 민감정보](https://docs.sentry.io/platforms/javascript/guides/nextjs/data-management/sensitive-data/): SDK 전송 필터, breadcrumb·URL·사용자 필드의 별도 처리. 공식 Markdown 응답을 읽었다.
