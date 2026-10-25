# Claude 구현 교차 검토 — 초대 베타 배포 구현

**검토 범위**: 커밋 전 working tree. `apps/api`, `apps/web/shared/api.ts`·`main.tsx`·`vite.config.ts`, `packages/llm/src/http-meter.ts`, `infra/`(Dockerfile·Terraform·migrations·Cloudflare), `.github/workflows/deploy.yml`, `scripts/sim-build.ts`를 [최종 설계](final-design.md)와 대조했다.
**시점**: 2026-10-16 16:30–17:10 KST. Codex가 같은 파일을 동시에 고치고 있었으므로 **줄 번호는 17:05 전후의 파일 기준**이다. 보고 직전에 재현 프로브를 최신 파일로 다시 돌렸다(16:56).
**방법**: 정적 검토, 스크래치 디렉터리의 PGlite로 실제 `Jobs`/`Backup`/`Usage` 클래스를 호출한 재현 프로브, 로컬 계측(Apple M2 Max, `LLM_MODE=mock`), `pnpm test apps/api/test/service.test.ts`, `vite build`(스크래치 출력), `prettier --check`·`eslint`·`tsc --noEmit`(부분).
**하지 않은 것**: Docker 이미지 빌드(로컬에 docker 없음), 실제 Supabase/R2/Cloud Run/Cloud Tasks 연결, Terraform plan, 유료 LLM 호출, 전체 `pnpm test`·`pnpm e2e`. 구현 파일은 수정하지 않았다.

---

## 결론 — 출시 판정: **NO-GO (2명 초대도 보류)**

저장·작업 계약의 핵심(멱등 제출, lease/fence, 낡은 attempt 차단, 삭제 후 부활 방지, RLS)은 의도대로 동작한다. 해당 테스트 6건도 통과한다. 그러나 아래 **P0 6건**은 정상 운영 안에서 서비스가 스스로 잠기거나, 기동이 안 되거나, 설계가 금지한 상태(평문 DB, 조용한 mock, 막힌 배포)로 운영되는 결함이다. 모두 고친 뒤 §5의 스테이징 게이트를 통과해야 2명 초대가 가능하다. P1은 5명·10명으로 늘리기 전에 고쳐야 한다.

| ID     | 등급 | 영역      | 요약                                                                                                                                | 위치                                                                    |
| ------ | ---- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| B1     | P0   | 복구      | 백업이 한 번 실패하면 `gc_pin`이 남아 이후 모든 백업 실패 → 48시간 뒤 모든 변경 요청 503                                            | `apps/api/src/backup.ts:63`, `service.ts:354`                           |
| B2     | P0   | 복구·비용 | 일일 백업이 지금까지의 모든 job 결과 객체를 매번 전부 복사 → 수 주 안에 600초 한도 초과                                             | `backup.ts:78-79`, `maintenance.ts:48`                                  |
| B3     | P0   | 보안·기동 | DB 연결에 TLS 검증 설정이 없고 Pool `error` 리스너도 없음 → 평문 연결, 기동 실패, 프로세스 크래시 중 하나                           | `database.ts:44-49`, `release.ts:7`, `ops.ts:13`                        |
| B4     | P0   | 배포      | `match_build` 고정 때문에 경기를 끝내지 않은 사용자가 하나라도 있으면 배포가 막히고 서비스가 점검 상태로 남거나, 그 경기가 영구 409 | `service.ts:311`, `jobs.ts:253`, `release.ts:24-31`, `deploy.yml:49-50` |
| B5     | P0   | 품질·비용 | 프로덕션 worker에 LLM 키가 없으면 조용히 mock으로 운영된다                                                                          | `config.ts:56`, `main.tf.json:52-54,113`, `packages/llm/src/config.ts`  |
| B6     | P0   | 비용·용량 | provider permit이 상한값으로만 집계됨(실사용의 5배). 429/오류 응답 예약액이 일 예산에 영구히 남음                                   | `usage.ts:93-101`, `http-meter.ts:72-73,132`                            |
| H1     | P1   | 용량      | 모든 역할이 1GiB(설계상 worker는 2GiB). 측정 결과 OOM 위험                                                                          | `main.tf.json:181`                                                      |
| H2     | P1   | 지연      | 조회 GET마다 Worker 스레드 생성, tsx 트랜스파일, 전체 세이브 읽기와 검증. 동시 2건을 넘으면 503                                     | `service.ts:336-337`, `runner.ts:24`                                    |
| H3     | P1   | 가용성    | 백업 게이트가 경기 checkpoint·라인업까지 막음(설계 범위는 신규 게임과 유료 작업)                                                    | `service.ts:350-356`                                                    |
| H4     | P1   | 정확성    | `/control` takeover가 진행 중인 유료 GM 턴까지 취소                                                                                 | `service.ts:285-306`, `main.tsx` toolbar                                |
| H5     | P1   | 정확성    | 클라이언트 영수증 키가 `path+body`이고 기한이 없음 → 남은 영수증이 다른 의도의 같은 본문 요청에 과거 결과를 돌려줌                  | `apps/web/shared/api.ts:50-57,79-100`                                   |
| H6     | P1   | 정확성    | lorebook 백그라운드: 사용자 턴과 유료 호출 슬롯을 다툼, 120초 폴링이 실행 슬롯 점유, dead 작업이 그 인물의 후속 갱신을 영구 차단    | `usage.ts:91`, `runner.ts:172-209`, `game/lorebook.ts:15-24`            |
| H7     | P1   | 인증      | Supabase refresh를 DB 트랜잭션·행 잠금 안에서 호출. 회전된 토큰이 롤백으로 유실될 수 있음                                           | `auth.ts:69-101`                                                        |
| H8     | P1   | 가용성    | heartbeat가 한 번만 실패해도 유료 턴 전체를 중단                                                                                    | `runner.ts:69`                                                          |
| H9     | P1   | 운영      | 실패 원인이 로그에 남지 않음, 알람 리소스 없음                                                                                      | `worker-entry.ts`, `runner.ts:246-253`, `maintenance.ts:63-64`          |
| H10    | P1   | 복구      | Auth 데이터가 백업에 없음 → 새 Supabase 프로젝트로 복구하면 전원 잠김                                                               | `backup.ts:6-23`, `migrations/002-auth-hook.sql`                        |
| H11    | P1   | 남용      | 활성 게임 수 한도·생성 속도 제한 없음(설계: 계정당 활성 게임 2)                                                                     | `jobs.ts:94-105`                                                        |
| H12    | P1   | 배포      | Terraform 드리프트, candidate smoke 없음, CI와 다른 이미지 재빌드, migration 단계 없음                                              | `deploy.yml:38-61`, `main.tf.json`                                      |
| L1–L11 | P2   | 기타      | §4 참고                                                                                                                             |                                                                         |

---

## 1. P0 — 출시 차단

### B1. 백업 한 번 실패 → GC pin 영구 → 모든 백업 실패 → 48시간 뒤 쓰기 전면 중단

- **현상**: `Backup.create()`가 `gc_pin`을 `INSERT … ON CONFLICT DO NOTHING RETURNING`으로 잡는다(`backup.ts:63`). pin 해제는 성공 경로 끝(`backup.ts:105`)에만 있다. 주석도 "A failed backup leaves it pinned"라고 적고 있다. 다음 백업은 pin이 이미 있으므로 `GC is pinned by another backup or restore`로 즉시 실패한다. 실패한 pin을 닫는 코드가 reconcile·maintenance 어디에도 없다. 설계 §12-5("실패한 backup epoch는 reconciler가 실패로 닫고 … GC를 재개")와 어긋난다.
- **재현**(스크래치 PGlite, 실제 클래스 사용, 16:56 재실행):
  ```text
  P1 first backup: transient 503                       ← 복사 대상 put이 한 번 실패
  P1 retry after transient failure: GC is pinned by another backup or restore
  P1 gc_pin rows: [{"key":"gc_pin","value":{"backup":"backups/20261016…"}}]
  ```
- **영향**: R2·GCS의 일시 오류, 600초 초과(B2), 인스턴스 종료 중 하나만 일어나도 이후 백업은 전부 실패한다. `last_backup`이 48시간을 넘기면 `service.ts:354`의 게이트가 **모든 POST 변경**(생성·턴·라인업·경기 checkpoint)에 503을 반환한다. 운영자가 DB에서 pin을 직접 지우기 전에는 복구되지 않는다. GC도 그동안 멈춰 R2 사용량이 계속 늘어난다.
- **수정**: pin을 `{backup, started_at, owner}` 레코드로 만들고 `try/finally`에서 실패 시 해제한다. reconcile에서 `started_at`이 오래된(예: 15분) backup pin은 실패로 닫는다(복원 pin은 운영자만 해제). 백업 실패와 연속 실패 횟수는 `operations`에 남기고 알람한다(H9).

### B2. 일일 백업 비용과 시간이 누적 job 수에 비례 → 수 주 뒤 매일 실패(B1과 결합하면 서비스 잠김)

- **현상**: 백업은 모든 `jobs.result_key`와 `work_key`를 참조 객체로 모은다(`backup.ts:78-79`). 각 객체마다 live GET 1회, 사본 2곳에 각각 PUT과 검증 GET을 **순차로** 수행한다(`copy()`). 결과 객체는 게임이 삭제된 경우에만 해제된다(`maintenance.ts:48`). 따라서 턴 하나마다 매일 백업할 객체가 하나씩 영구히 늘어난다.
- **재현**: 게임 1개에서 커밋 6번을 한 뒤 백업하니 `objects: 8`(save 1, view 1, result 6)이었다. 새 게임의 결과 본문 원문은 423KB였다(측정, 아래 부록).
- **영향 산식**: 10 DAU × 20턴/일이면 한 달에 결과 객체 6,000개가 쌓인다. 객체당 순차 네트워크 호출이 5회이고 도쿄↔R2·us-west1 GCS 왕복을 0.3–0.5초로 잡으면, 30일째 백업 하나에 30–50분이 걸린다. 이는 Scheduler `attempt_deadline 600s`와 Cloud Run `660s`를 넘으므로 2–3주 안에 매일 실패하고, B1에 의해 잠긴다. R2 백업 bucket에는 lifecycle이 없어(Terraform 밖, GCS만 8일 삭제) 매일 전체 사본이 무기한 쌓인다. live 저장과 같은 10GB 무료량을 한 달 안팎에 소진할 수 있다.
- **수정**: (1) 설계 §6의 "오래된 receipt에는 작은 결과 요약"대로, terminal job의 `result_key`를 짧은 보관(예: 24시간) 뒤 DB의 작은 요약으로 바꾸고 해제한다. 백업에는 게임별 현재 snapshot·view와 활성 job만 넣는다. (2) 백업 객체 키를 checksum 기반(content-addressed)으로 만들어 날마다 다시 복사하지 않게 한다. (3) 동시성 한도를 둔 병렬 복사와 실행 시간 상한, 다음 실행에서 이어 하기를 둔다. (4) R2 백업 bucket lifecycle(7개 복구 지점)을 IaC나 운영 문서로 고정한다.

### B3. DB TLS 미검증 또는 기동 실패, Pool 오류로 프로세스 크래시

- **현상**: `new pg.Pool({ connectionString, max: 4, … })`(`database.ts:44-49`)에 `ssl` 옵션이 없고, 이미지에도 CA 파일이 없다. 설치된 `pg@8.23.1`과 `pg-connection-string@2.14.1`은 `sslmode=require`를 **`verify-full`의 별칭**으로 다룬다(`index.js:145-151`, 경고 문구 222행). Node 기본 신뢰 저장소로 검증한다는 뜻이다. Supabase는 직접 연결의 `verify-full`에 대시보드에서 내려받는 프로젝트 CA 인증서를 쓰라고 안내한다. 따라서 다음 셋 중 하나가 된다.
  1. `sslmode=require`나 `verify-full`이면 인증서 검증 실패로 **모든 역할 기동 실패**.
  2. `sslmode`가 없으면 pg 기본값 `ssl=false`로 **평문**(자격 증명과 게임 메타데이터가 인터넷 구간에 노출, 설계 §8 위반).
  3. `no-verify`면 MITM이 가능하다.

  `release.ts:7`(GitHub 러너에서 실행)과 `ops.ts:13`도 같다.

- **현상 2**: `pool.on('error')` 리스너가 없다(`grep` 결과 0건). node-postgres는 idle 클라이언트의 백엔드 연결이 끊기면(Supavisor 재시작, 무료 DB 휴면, 네트워크 단절) Pool에서 `error`를 발생시키고, 리스너가 없으면 throw되어 **프로세스가 종료**된다. 또 `catch`의 `ROLLBACK`이 깨진 연결에서 다시 throw하면 원래 오류가 가려지고, `client.release()`에 오류를 넘기지 않아 깨진 클라이언트가 Pool로 돌아간다(`database.ts:73-76,91-94`).
- **영향**: 기동 불가이거나 평문 운영이다. 크래시가 나면 같은 인스턴스의 동시 작업 2개가 모두 lease 만료까지 멈추고, 재시도로 LLM 비용이 다시 든다.
- **수정**: CA를 Secret Manager나 이미지로 전달하고 `ssl: { ca, rejectUnauthorized: true }`를 쓴다. production에서는 검증 TLS가 아니면 기동을 거부한다. `pool.on('error', log)`를 추가하고 `client.release(error)`로 깨진 연결을 폐기한다. 스테이징에서 Supavisor transaction pooler(6543)로 실제 연결을 검증한다.

### B4. `match_build` 고정 → 배포 교착 또는 경기 영구 잠김

- **현상**: 경기가 시작된 커밋에서 `games.match_build`에 `simBuildId()`를 고정하고, 경기가 끝날 때까지 바꾸지 않는다(`jobs.ts:240,253`). 경기 POST는 `game.match_build !== SIM_BUILD`이면 항상 409를 반환한다(`service.ts:311`, "새로고침 후 다시 시도" 문구와 달리 **새로고침해도 고정값은 그대로**다). `match/close`도 `/match/` 경로라 같이 막힌다. `simBuildId()`는 `packages/domain/src` 전체와 `packages/sim/src`, `packages/engine/src/match`를 해시한다(`scripts/sim-build.ts:6`). 도메인 스키마가 바뀌는 거의 모든 기능 PR이 이 값을 바꾼다는 뜻이다.
- **배포 경로**: `deploy.yml:49-50`의 `release.ts pause`는 먼저 `maintenance=true`를 켜고, 해시가 다른 미완료 경기가 있으면 throw한다(`release.ts:24-31`). 실패 단계 메시지대로 admission이 **멈춘 채 남는다**. 경기 도중 이탈한 사용자 한 명(며칠 방치도 흔하다)만 있어도 배포가 실패하고 서비스 전체가 "점검 중" 503이 된다. 반대로 pause를 우회해 배포하면 그 경기는 끝낼 수 없게 된다.
- **수정**: 서버가 확정 상태의 원본이고 checkpoint는 서버가 현재 코드로 다시 굴리므로, **클라이언트 빌드 == 서버 빌드**만 요구하면 충분하다. 빌드가 바뀌면 클라이언트가 새로 고쳐 서버 확정 tick부터 재개하게 하고, 게임별 고정은 없앤다. 저장 모양 비호환이 실제로 생기면 설계 §11의 구 cohort 이미지 유지를 구현한다. `pause`는 거부할 때 maintenance를 되돌려 놓고, 미완료 경기는 경고로만 보고한다.

### B5. 프로덕션에서 조용한 mock 운영 가능

- **현상**: `config.ts:56`은 `LLM_MODE === "mock"`만 거부한다. 모드 결정은 `resolveLlmMode()`(`packages/llm/src/config.ts:439-441`)가 하며, `LLM_MODE`가 없으면 **GM 제공자 키가 없을 때 mock**이다. Terraform은 `LLM_MODE`를 설정하지 않고, `llm_secret_ids`의 기본값은 `{}`이다(`main.tf.json:52-54`). 키는 worker에만 합쳐진다(`:113`). tfvars에서 키 매핑을 빠뜨리면 worker가 오류 없이 대본 응답을 실제 사용자 세이브에 커밋한다.
- **수정**: production worker는 기동 시 `LLM_MODE=real`, `config/llm.yml`에 쓰인 **모든 제공자**(google, typesafe)의 키, **모든 모델**의 가격 등록(`google/gemini-3.8-flash`, `google/gemini-3.5-flash-lite`, `typesafe/jev-1.13.0`)을 확인하고, 하나라도 없으면 기동을 거부한다. 지금은 가격이 빠지면 첫 호출에서 `Missing model price`가 나야 비로소 드러난다. Terraform에서는 `llm_secret_ids`의 기본값을 없애 필수 변수로 만든다.

### B6. provider permit 과대 집계, 실패 응답이 예산을 영구 점유

- **현상 1 (TPM)**: `usage.ts:93-101`은 최근 1분의 `sum(token_bound)`로 TPM을 판정한다. `token_bound`는 예약 시점의 `inputBound + outputBound`이다. `inputBound`는 **요청 바이트 수**(`http-meter.ts:72`, 한국어는 1글자당 약 3바이트)이고, `outputBound`는 `max_tokens`(GM 64,000)다. 정산(`settle`) 후에도 `token_bound`를 실제 값으로 바꾸지 않는다. 제공자 TPM이 출력 토큰을 세지 않는다면(Gemini 한도 정의는 AI Studio에서 확인 필요) 출력 상한까지 넣는 것은 이중 과대다.
- **재현** (tpm 1,000,000, GM 크기 호출 `inputBound 150,000 / outputBound 64,000`, 실제 40,000/2,000):
  ```text
  1–4 admitted at ms 4–11
  5 rejected at ms 60517 Job no longer owns its lease     ← 60초 대기 후 실패
  token_bound in window: {"bound":856000,"actual":168000}
  ```
  실사용 16.8%에서 창이 가득 찬다. 실제 worker에서는 heartbeat가 lease를 유지하므로 60초 대기 뒤 `rate_limit`으로 그 호출이 실패하고 턴이 실패한다. 10명이 동시에 쓰면 **전체 GM 호출이 분당 4회 정도로 제한**된다(같은 tpm 설정 기준).
- **현상 2 (실패 응답)**: 제공자가 429·4xx·5xx를 반환하면 본문에 usage가 없으므로 `settle(id, null)`이 호출되고(`http-meter.ts:132`), `Usage.settle`은 `unknown`으로 표시한다. 일 예산 합계는 `coalesce(actual, reserved)`이므로 **예약액 전액**(GM 1회 = 입력 바이트×단가 + 64,000×출력 단가)이 그날 예산에 남는다. SDK `max_retries: 2`면 실패한 호출 하나가 이 비용을 3번 잡는다.
  ```text
  [["reserve",{"provider":"google","model":"gemini-x","inputBound":3083,"outputBound":64000}],
   ["settle","r1",null],["status",429]]          ← 1,000자 한국어 = 3,083바이트
  ```
  provider 장애나 429가 몇 차례 이어지면 실제 지출 없이 사용자 일 예산(기본 $1)이 바닥난다.
- **수정**: 정산 시 `token_bound`(와 rate 창)를 실제 사용량으로 갱신한다. 입력 상한은 바이트 대신 보수적인 토큰 추정(바이트/2.5 등)이나 provider count 결과로 잡는다. TPM 정의에 맞춰 출력 포함 여부를 제공자별로 정한다. HTTP 상태를 받았는데 usage가 없는 4xx/429/5xx는 `failed_unbilled`(0원)로 정산하고, `unknown`은 전송 실패나 timeout처럼 과금 여부를 알 수 없는 경우에만 쓴다. 대기 상한(60초)과 lease·deadline의 관계를 명시하고, 대기 중인 호출을 공정하게 처리할 순서(FIFO)를 둔다.

---

## 2. P1 — 5명·10명 확대 전 필수

### H1. 메모리 1GiB — 측정상 OOM 여유 부족

`main.tf.json:181`은 모든 역할에 `1Gi`를 준다(설계 §8은 worker `2GiB`, concurrency 2). 측정(M2 Max, 새 게임 1개, Nest·pg 없이 bare node):

| 측정                            | 결과                                           |
| ------------------------------- | ---------------------------------------------- |
| `service.ts` import 직후        | RSS 306MB, heap 109MB                          |
| 생성 job(Worker 스레드)         | 2.3초, peak RSS 344MB                          |
| 세이브                          | raw 10.64MB, gzip 1.34MB, view·result 각 423KB |
| 전체 세이브 GET 1건 / 동시 2건  | peak 406MB / **641MB**                         |
| 로컬 API 기동 직후(PGlite 포함) | RSS 764MB, 기동 3.27초                         |

worker 2건 동시 처리 중에는 Worker 스레드의 상태, 메인 스레드로 돌아오는 snapshot 복제, `JSON.stringify`와 gzip, 검증 GET이 겹친다. 시즌이 진행된 세이브는 더 크다. OOM이 나면 두 작업이 모두 lease 만료까지 멈추고 재실행 비용이 든다. **수정**: worker는 설계대로 2GiB로 둔다. `Worker`에 `resourceLimits`를 지정한다. 진행된 세이브로 peak RSS를 측정해 capacity를 정한다. API 조회 경로는 H2로 메모리를 줄인다.

### H2. 조회 GET 1건 = Worker 생성 + tsx 트랜스파일 + 전체 세이브 읽기와 검증

`mail`·`negotiation`·`player`·`match-report`·`match/live` GET과 `?catalog=1`은 `runner.read()`에서 요청마다 새 `Worker`를 띄운다. 그 Worker가 `tsx` 런타임 등록으로 엔진 그래프를 다시 불러온 뒤(`worker-bootstrap.mjs`), R2에서 1.34MB를 받아 gunzip과 `validateSave`를 수행한다. 측정: 카탈로그 GET 0.6–0.9초(tsx 캐시가 따뜻할 때), 1.1초(차가울 때), 세이브 포함 mail GET 0.76초 — 모두 M2 Max 기준이다. Cloud Run 1 vCPU(`startup_cpu_boost: false`, `cpu_idle`)에서는 수 초가 예상되며 설계 목표(warm 조회 p95 500ms)와 거리가 멀다. capacity 2를 넘으면 503 `Busy`다(`service.ts:336`). 선수 카드를 연달아 누르기만 해도 재현될 수 있다. **수정**: 배포 산출물을 미리 컴파일한다(esbuild/tsc, 런타임 tsx 제거). Worker 풀을 상주시킨다. `(game, revision)`으로 디코드한 상태를 바이트 상한 LRU에 두거나, 설계 §5처럼 화면별 view bundle을 커밋 때 R2에 만들어 둔다. 콜드 스타트 단축에는 `startup_cpu_boost`를 켠다.

### H3. 백업 게이트 범위가 너무 넓음

`service.ts:350-356`은 production의 모든 `mutationPath` POST에 `last_backup` 48시간 조건을 건다. 설계 §12 표는 "48시간 넘으면 **신규 게임·유료 변경 작업** 중단"이다. 지금은 경기 checkpoint, 라인업, 경기 마감까지 503이 되어 경기 중 저장이 불가능하다. 첫 배포 직후에는 백업이 없어 가입 직후 게임 생성도 막힌다. 배포 절차에 첫 백업 실행을 넣어야 한다. **수정**: 생성과 LLM job에만 게이트를 건다. 26시간 경보는 H9로 처리한다.

### H4. `/control` takeover가 유료 턴을 취소

`service.ts:294-302`는 `client_id`가 다르면 그 게임의 queued·running job(lorebook 제외)을 **전부** `cancelled`로 바꾼다. 처음으로 경기 POST를 보낼 때(`client_id IS NULL`)와 툴바의 "이 창에서 경기 진행" 버튼(`main.tsx`, 게임 화면이면 경기 중이 아니어도 표시)이 이 경로를 탄다. 진행 중인 GM 턴이 취소되면 늦은 커밋은 fence에 막히고 사용한 LLM 비용은 버려진다. **수정**: 취소 대상은 `/match/` job으로 한정하고, 비경기 job이 진행 중이면 takeover를 409로 거절한다. 버튼은 경기 단계에서만 보여 준다.

### H5. 클라이언트 영수증의 오인 재생

`apiFetch`는 `sha256(path + body)`를 localStorage 키로 써서 Idempotency-Key와 jobId를 기억한다(`api.ts:50-57,79-109`). 영수증은 완료나 비-202 응답에서 지우지만, 예외(연결 끊김·abort) 경로에서는 남고 **기한이 없다**. 이후 본문이 같은 요청은 **새 의도라도** 남은 jobId에 붙어 과거 결과를 받는다. 경기 `{"kind":"enter"}`·`{"kind":"resume"}`처럼 경기마다 본문이 같은 요청이나, 같은 문장의 채팅이 그렇다. 다른 경기의 LiveSnapshot이 화면에 적용될 수 있다. **수정**: 키에 `gameId`와 확정 revision(또는 epoch, 경기 tick)을 넣는다. 영수증에 생성 시각과 TTL(예: job deadline 15분)을 둔다. 끊긴 요청 재연결은 `/api/jobs` 재개 경로로만 하고, 새 입력은 항상 새 키를 쓴다.

### H6. lorebook 백그라운드 작업(진행 중 구현) — 세 가지 결함

1. **유료 호출 슬롯 경합**: `usage.ts:91`의 "One paid request per user"는 lorebook job의 호출도 같은 사용자의 in-flight로 센다. lorebook-editor 호출(`timeout_ms 60000`, SDK 재시도 2회)이 진행 중이면 사용자 턴의 GM 호출은 최대 60초 대기 후 `rate_limit`으로 실패한다. 설계 §6("사용자 턴과의 경합에서는 foreground를 우선")과 반대다. **수정**: 같은 사용자의 foreground job이 있으면 background는 다음 호출 전에 양보하고, foreground 몫의 permit을 따로 둔다.
2. **요청 안 폴링**: `runner.ts:172-209`는 `active_job`이 비기를 1.5초 간격으로 최대 120초 기다린다. 그동안 Cloud Run 요청과 runner 슬롯(전체 worker 4슬롯 중 하나)을 점유한다. 사용자 수만큼 lorebook이 쌓이면 foreground 전달이 `503 Busy` 재시도로 밀린다. **수정**: 즉시 슬롯을 놓고 `outbox.next_at`을 미뤄 다시 전달한다.
3. **dead 작업의 영구 차단**: SQL job이 `dead`가 되어도 GameState의 `lorebookJobs` 항목은 그대로다. `loreTasks()`(`game/lorebook.ts:15-24`)는 인물별 첫 항목만 고르고, request key `lore-<game>-<task>`가 같아 `ON CONFLICT DO NOTHING`이 된다. 따라서 **그 인물의 후속 갱신이 영구히 실행되지 않고** 운영자 신호도 없다. 설계는 보류할 때 운영자에게 알리라고 한다. **수정**: dead 전환 시 상태의 해당 job을 failed로 표시하는 작은 커밋과 알람을 남기고, 후속 처리 정책(보류·건너뜀)을 명시한다.

### H7. Supabase 세션 갱신이 트랜잭션 안 네트워크 호출

`auth.ts:69-101`은 세션 행을 `FOR UPDATE OF s`로 잠근 채 `refreshSession`과 `getUser`(각각 최대 10초)를 호출한다. 설계 §6 "호출 중 DB 트랜잭션을 점유하지 않는다"를 어기고, pool `max: 4`를 같은 사용자의 폴링이 차지한다. Supabase refresh token은 회전되므로, `refreshSession` 성공 뒤 `getUser`나 `COMMIT`이 실패해 롤백되면 DB에는 **이미 폐기된 옛 토큰**이 남는다. 재사용 허용 간격이 지나 다음 갱신이 오면 Supabase 재사용 탐지로 세션 계열이 폐기되어 사용자가 강제 로그아웃된다. **수정**: 새 토큰을 받으면 그 자리에서 짧은 트랜잭션으로 먼저 저장하고 검증은 그다음에 한다. 직렬화는 행 잠금 대신 `refreshing_until` 같은 짧은 claim으로 한다. 또는 10분마다 refresh하지 말고 access token JWT 검증과 membership 확인으로 대체한다.

### H8. heartbeat 단일 실패로 턴 중단

`runner.ts:69`: `heartbeat().catch(() => finish(new Error("Heartbeat failed")))`. Supavisor 순간 오류 한 번이 진행 중인 GM 턴을 중단하고, `fail()`이 터미널 실패로 만든다. **수정**: `lease_until - 여유`까지는 재시도하고, 실패가 이어질 때만 중단한다.

### H9. 실패 원인 기록과 알람 부재

production에서 Worker 스레드의 `console.*`는 `{event:"game_diagnostic", level}`로 대체되고(`worker-entry.ts`), 실패는 `error.name`(대부분 `"Error"`)만 남는다(`runner.ts:246-253`). 실패한 job 행에는 고정 문구 `작업 실행에 실패했습니다`만 남는다. `backup_overdue`는 로그 한 줄(`maintenance.ts:63-64`)뿐이며 Terraform에 log-based metric, 알림 정책, 예산 알림이 없다. 설계 §15의 알람(queue oldest age, 멈춘 lease, 반복 fence reject, unknown 비용, 백업 지연, OOM)이 하나도 없다. **수정**: job 행과 구조화 로그에 `llmErrorKind`, 라우트 상태, 단계(load·run·upload·commit) 코드를 남긴다(본문·프롬프트 제외). Terraform에 위 알람과 Cloud Billing 예산 알림을 추가한다.

### H10. Auth 데이터 미백업 → 새 Supabase 프로젝트로 복구 불가

백업 표 목록(`backup.ts:6-23`)은 `private` 스키마뿐이다. `members.id`는 Supabase user id이고 invites는 이미 accepted 상태다. Supabase 프로젝트를 잃고 새 프로젝트에 복원하면, 같은 Google 계정에 **새 user id**가 생긴다. before-user-created hook은 미수락 초대가 없어서 가입을 거부하고(`002-auth-hook.sql:10`), callback은 membership을 찾지 못해 초대를 요구한다. 결과적으로 모든 사용자가 자기 게임에서 잠긴다. 설계 §12-3은 "필요한 Auth 데이터"를 백업하도록 한다. **수정**: `auth.users`·`auth.identities`를 owner 권한으로 덤프·암호화해 포함한다. 또는 email_hash로 운영자가 재연결하는 절차와 스크립트를 만들고, 복원 훈련에 포함한다.

### H11. 활성 게임 한도와 생성 속도 제한 없음

`jobs.submit`의 생성 경로(`jobs.ts:103-105`)는 게임 수를 세지 않는다. 생성마다 온보딩 LLM 호출과 1.34MB snapshot이 생긴다. 생성이 실패하면 `snapshot_key IS NULL`인 placeholder 행이 정리되지 않는다. 설계 §8의 초깃값은 "활성 게임 2"다. **수정**: 같은 트랜잭션에서 `deleted_at IS NULL` 게임 수를 세고, 실패한 placeholder는 reconcile에서 정리한다.

### H12. 배포 workflow

- `gcloud run services update --image`(`deploy.yml:55`)로 Terraform이 관리하는 서비스의 이미지를 바꾼다. `main.tf.json`에는 `lifecycle.ignore_changes`가 없어 다음 `terraform apply`가 tfvars의 `image`로 **조용히 롤백**한다.
- `--tag candidate`로 띄운 revision에 smoke 요청 없이 곧바로 `--to-latest`로 전환한다(설계 §11 "smoke → traffic").
- CI가 빌드한 이미지가 아니라 deploy에서 다시 빌드한다. base image `node:26-bookworm-slim`은 digest로 고정되어 있지 않아 같은 커밋이라도 다른 산출물이 나올 수 있다.
- SQL migration(expand) 단계가 없다. `ops migrate`를 수동으로 해야 하는데 순서 보장이 없다.
- 실패하면 admission이 멈춘 채 남는 것은 의도된 동작이지만, B4 때문에 이런 실패가 일상적으로 생긴다.

---

## 3. 확인된 강점 (유지할 것)

- **fence와 멱등성**: `claim`의 attempt 증가, `commit`의 `attempt·status·lease·deadline·base_revision·client_epoch·active_job` 검증, 늦은 attempt의 event 차단, 삭제 뒤 커밋 거부가 테스트와 프로브에서 모두 동작했다(`apps/api/test/service.test.ts` 6/6 통과).
- **RLS와 역할**: `games`·`jobs`·`feedback`·`events`가 `FORCE RLS`이고, 기동 시 `current_user`가 전용 non-owner 역할인지 확인한다. API 역할에서 actor가 없는 조회는 빈 결과다.
- **내부 호출**: OIDC `verifyIdToken`으로 audience를 고정하고 서비스 계정 email을 대조한다. api 역할은 `/internal/*`에 404를 반환한다.
- **인증**: PKCE verifier를 AES-GCM으로 암호화한 10분 쿠키에 담는다. 세션 쿠키는 `HttpOnly; Secure; SameSite=Lax`이고 DB에는 해시만 둔다. 초대 토큰은 해시로 저장하고 URL fragment로 전달한다. before-user-created hook이 있다. 변경 요청은 Origin을 검사한다.
- **프록시**: Pages Function은 고정 origin으로만 보내고, host·forwarded 헤더를 제거하며, `Set-Cookie`를 보존하고 `no-store`를 붙인다. 오류 시 502 JSON을 돌려주고, `_routes.json`으로 함수 적용 범위를 `/api`로 한정했다.
- **meter**: Gemini SDK가 호출 시점에 전역 `fetch`를 해석하므로 Worker의 `meteredFetch` 교체가 적용된다. typesafe evaluator는 지연 생성이라 역시 계측된다. 조회 요청에서 LLM을 부르면 거부한다. Gemini 사고 토큰을 정산에 포함한다.
- **정적 산출물**: `vite build`가 성공하고(4.0MB, 주 번들 gzip 218KB), 번들에 키 패턴이 없다. CSP와 외부 자원 사용이 충돌하지 않는다.

---

## 4. P2 — 정리·저위험

| ID  | 내용                                                                                                                                                                                                                         | 위치                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| L1  | `pnpm dev`가 기본 `/tmp/gaffer-service`를 쓰므로 사용자의 기존 `apps/web/.data` 세이브가 로컬에서 보이지 않는다. `simulation` 스킬의 턴 스트림 가정(202 + polling으로 바뀜)도 깨진다. 전환 안내 또는 import 경로가 필요하다. | `scripts/dev.ts`, `config.ts:59`        |
| L2  | worker와 sim이 Cloud Tasks queue 하나를 공유한다(설계: workload별 queue).                                                                                                                                                    | `dispatch.ts`, `main.tf.json` queue     |
| L3  | 일 예산에 기본값($1/$10)이 있어 production이 명시적 설정 없이 기동한다(설계 §13: 값이 없으면 시작하지 않음).                                                                                                                 | `config.ts:26-27`, `main.tf.json`       |
| L4  | `CHECK(octet_length(payload::text) <= 262144)`는 jsonb 출력(공백 추가) 기준이고 express 한도는 compact JSON 256kb다. 경계 근처 요청이 413 대신 500이 된다.                                                                   | `001-service.sql:30`, `main.ts`         |
| L5  | `recover()`는 jobs→games 순으로, `commit()`은 games→jobs 순으로 잠근다. lease 만료 순간에 드물게 deadlock이 날 수 있다(PG가 한쪽을 중단).                                                                                    | `jobs.ts:308-329`, `:206-216`           |
| L6  | job deadline이 일률 15분이다. 크래시 복구에 lease 60초와 reconcile 최대 2주기(outbox `sent_at` 5분 조건)가 걸리면, 재시도가 deadline 직전에 시작되어 비용만 쓰고 끝날 수 있다.                                               | `001-service.sql:27`, `jobs.ts:312-314` |
| L7  | R2의 `PutObject IfNoneMatch:"*"`와 AWS SDK v3 기본 체크섬 헤더 호환을 실제 R2에서 검증하지 않았다. 미지원이면 모든 커밋이 실패한다. 스테이징 smoke 항목이다.                                                                 | `objects.ts:44-52`                      |
| L8  | GCS 백업 bucket에서 maintenance SA가 `objectUser`(삭제 포함) 권한을 가진다. 설계 §12-5는 정리 권한을 분리하라고 한다. retention policy나 생성 전용 역할을 검토할 것.                                                         | `main.tf.json` `backup_writer`          |
| L9  | 계정 삭제가 Supabase Auth 사용자(email)를 지우지 않는다. 진행 상태가 보이지 않는다(설계 §10).                                                                                                                                | `auth.ts` `deleteAccount`               |
| L10 | `game-screen.tsx`의 resync는 409에 `retry:true`가 있을 때만 다시 묻는데, 서비스의 409(`작업이 진행 중입니다`)에는 그 필드가 없어 즉시 포기한다.                                                                              | `game-screen.tsx:640-660`, `service.ts` |
| L11 | 같은 요청의 `Origin`·쿠키 검사는 맞다. 다만 로그인 전후에 `/api/*` 호출마다 maintenance 조회 1회와 세션 조회 1회가 더 든다. 폴링(1.2초)과 겹치면 Supabase Free 연결과 egress를 계측해 둘 것.                                 | `service.ts:107-116`                    |

**CI 게이트 스냅샷(17:00 전후, 진행 중 작업 포함)**: `prettier --check` 경고 2건(`scripts/dev.ts`, `apps/web/vite.config.ts`). `eslint` 오류 4건(`main.ts:79` 미사용 `_next`, `ops.ts:15`, `release.ts:35`, `usage.ts:38`). `tsc -p apps/web` 오류 1건(`main.tsx:164` exactOptionalPropertyTypes). `tsc -p apps/api` 통과. Codex 작업이 끝난 뒤 다시 확인해야 한다.

---

## 5. 2명 초대 전 스테이징 게이트

P0 수정 후 다음을 **실제 무료 스테이징 리소스**에서 통과해야 한다(mock LLM 허용, 실모델은 소규모 파일럿으로 분리).

1. `docker build -f infra/Dockerfile`로 빌드한 이미지가 4개 역할 모두 기동한다. 콜드 스타트 시간과 RSS를 기록한다(로컬 docker가 없어 미검증).
2. Supavisor 6543에 **검증 TLS**로 연결하고, 네 역할의 `current_user`를 확인한다. idle 연결을 강제로 끊어도 프로세스가 살아남는다(B3).
3. R2 `IfNoneMatch` PUT, 검증 GET, 삭제가 동작하고 GC가 참조 없는 객체만 지운다(L7).
4. Cloud Tasks OIDC → worker·sim, API → sim 직접 OIDC, Scheduler → maintenance가 동작한다. 서명 없는 호출과 audience가 다른 토큰은 403이다.
5. 백업: 복사 대상 하나를 실패시켜도 다음 백업이 성공한다(B1). 결과 객체 1,000개 이상인 상태의 백업 시간을 측정한다(B2). 스테이징 복원 후 게임 열기, 세션 무효화, 삭제 재적용, Auth 연결을 확인한다(H10).
6. 미완료 경기가 있는 상태에서 sim·domain을 바꾼 배포를 하면, 배포가 끝나고 경기가 이어진다(B4).
7. worker 키를 일부러 빼면 기동이 실패한다(B5). 가격 표에 없는 모델이 있어도 기동이 실패한다.
8. 제공자 429를 주입해도 예산이 줄지 않는다. 10세션 동시 mock 턴과 실제 tpm 설정에서 permit 대기가 설계 목표(queue p95 10초) 안에 든다(B6).
9. 진행된 세이브(1시즌 이상)로 worker 2건 동시 실행과 api 조회 2건 동시 실행의 peak RSS를 측정한다(H1·H2).
10. 2기기 takeover 중 유료 턴이 보존되고(H4), 끊긴 요청 뒤 같은 본문의 새 요청이 새 job이 된다(H5).

---

## 부록 A. 재현 프로브

프로브는 저장소 밖 스크래치 디렉터리에서 실행했다. `GAFFER_MODE=local`, 별도 `GAFFER_DATA_DIR`·`GAFFER_LOG_DIR`, 실제 `apps/api/src` 클래스를 import했다. 실행: `cd apps/api && node --import tsx/esm <probe>.mts <빈 디렉터리>`.

```ts
// B1 — 첫 백업의 복사 대상 put을 한 번 실패시킨 뒤 재시도
const flaky: ObjectStore = { put: async (k, b) => { if (fail) throw new Error("transient 503"); return ok.put(k, b); }, get: ok.get, delete: ok.delete };
await new Backup(db, jobs.objects, [flaky], key).create();   // throws
fail = false;
await new Backup(db, jobs.objects, [flaky], key).create();   // → "GC is pinned by another backup or restore"

// B2 — 게임 1개에 lineup 커밋 5번 + 생성 1번 뒤 백업 → last_backup.value.objects === 8

// B6-1 — prices {"google/m": {inputMicrosPerToken:0.3, outputMicrosPerToken:2.5, rpm:1000, tpm:1_000_000, concurrency:10}}
for (i of 1..6) { id = await usage.reserve(run, {provider:"google", model:"m", inputBound:150_000, outputBound:64_000});
                  await usage.settle(id, {inputTokens:40_000, outputTokens:2_000}); }
// → 1–4 즉시 허가, 5번째 60.5초 대기 후 실패, 창 합계 bound 856,000 / actual 168,000

// B6-2 — 전역 fetch를 429 응답으로 바꾼 뒤 http-meter import, withHttpMeter 안에서 Gemini URL 호출
// → reserve(inputBound 3083, outputBound 64000) 후 settle(id, null)
```

## 부록 B. 계측

- **Worker 생성** (`worker-bootstrap.mjs`, `GET /api/games?catalog=1`): 3회 902/617/616ms. tsx 캐시가 비어 있을 때는 1,138/1,122/1,123ms.
- **생성 job(mock LLM)**: 2,309ms, peak RSS 344MB. 세이브 raw 10.64MB, gzip 1.34MB, result·view 각 423KB. `mail` GET 757ms(peak 406MB), 동시 2건 770ms(peak 641MB).
- **로컬 API 기동**(포트 3471, 스크래치 데이터): `/health`까지 3.27초, RSS 764MB(PGlite 포함). 측정 후 해당 프로세스만 종료했다.
- **환경**: Apple M2 Max, Node 26.5.0. Cloud Run 1 vCPU는 단일 스레드가 더 느리므로 위 값은 하한으로 읽는다.
