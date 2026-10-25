# 구현 상태 — 2026-10-17

로컬 코드·배포 설정을 구현했다. 실제 클라우드 리소스 생성이나 공개 배포는 하지 않았다.
외부 프로젝트·도메인·인증 및 결제 설정이 전달되지 않아 **공개 출시 판정은 아직 보류**다.
운영 명령과 현재 계약은 [배포 문서](../../docs/deployment/README.md)를 따른다.

## 구현

- React/Vite + React Router 화면, NestJS API와 api/worker/sim/maintenance 역할.
- 직접 Google OAuth/OIDC(state·nonce·PKCE·ID token 검증), Google `sub` 회원, 초대 또는 `ADMIN_EMAILS` 가입, 7일 opaque 세션, 소유권·Origin·SQL RLS.
- PGlite 로컬/pg 운영 DB, immutable gzip R2 snapshot/view, checksum, revision CAS.
- 영구 job·outbox·idempotency·lease·attempt fence·복구, 게임/계정 삭제 fence.
- 브라우저 job polling·attempt reset·재접속, revision 기반 영수증, 경기 epoch·sim hash.
- lorebook patch 저장·최신 version 적용·foreground 우선·슬롯 반환·보류 알람/운영 재시도.
- 실제 SDK HTTP 시도별 비용 예약/정산, 가격 version·agent·call ID·game version,
  thinking token, unknown 비용, provider RPM/TPM/동시성, UTC 개인/전체 일 예산.
- Google 로그인 진입 화면, 로그아웃, `dhoonjang@gmail.com` 메일 피드백 링크.
- 계정당 하루 $5 서버 제한. 사용자 화면에 비용·운영 안내·설정 패널을 표시하지 않는다.
- 운영 CLI, 퍼널·D1/D7·비용 JSON 보고서. 기존 피드백 기록은 CLI에서 조회한다.
- 선택 진단 암호화/상한/보관/감사, 보관 정리·로그인 식별자 삭제·PostHog 삭제 접수.
- DB와 독립된 R2 삭제 marker, 암호화 이중 백업/복원·삭제 재적용·복원 후 비용 대조 잠금.
- Cloud Run/Tasks/Scheduler/IAM/WIF/GCS/알림 Terraform, Pages 프록시, Dockerfile,
  성공 CI 이미지 기반 배포 workflow, SQL expand·drain·호환 검사·candidate health·롤백 절차.
- 기존 match-cli/시뮬레이션 전송 도구의 비동기 API 대응. 게임 규칙·SAVE_VERSION·모델 입력은 유지.

서버 공통 서비스와 역할별 실행 코드는 `apps/api/src`에 함께 두었다. 설계의 별도
`packages/server`, `apps/worker` 패키지는 만들지 않았다. 같은 코드/이미지를 재사용하며
서비스 배포 경계는 api/worker/sim/maintenance로 나뉜다.

## 실행한 검증

- TypeScript 네 프로젝트 검사, ESLint/stylelint/CSS 참조 검사, Prettier, Vite production build.
- 관련 서비스/HTTP 계측/턴 오류 테스트 69개 통과(서비스 14개, 계측·턴 오류 55개).
  RLS, 중복 100건, 만료 lease/fence와 생성 실패 자리 회수, 삭제 경합,
  lorebook CAS, 비용 unknown, stale permit 회수, 보관 집계, TLS 설정, 프록시 쿠키와 오류,
  실패 백업 재시도, 암호화 복원·독립 삭제 marker를 포함한다.
- 로컬 기본 인증 우회 차단, 세션 없는 API 접근 거부, 로그아웃 후 세션 폐기,
  $5 일 예산의 정확한 경계와 unknown 비용 누적을 검증했다.
- 격리된 mock 브라우저: 생성 → 채팅 → 피드백 → reload 복구. pageerror 0.
  1440×900에서 입력창 하단 879px로 화면 안에 유지.
- 별도 10계정 동시 mock 생성: 10/10 성공, 약 15.98초, health p95 9ms(139 표본).
  개발 머신의 결과이며 Cloud Run·실제 LLM 성능 증거는 아니다.
- Terraform 1.13.5 + Google provider 6.50.0의 init/validate 통과. apply는 하지 않았다.
- Docker와 같은 소스·운영 의존성만 복사한 임시 환경에서 `--prod --frozen-lockfile`
  설치, Nest 기동, health 응답, CLI의 비동기 mock 게임 생성(HTTP 200)을 확인했다.
  이 검증은 Docker/Linux 이미지 빌드를 대신하지 않는다.
- [Claude 구현 검토](claude-implementation-review.md)와
  [검토 반영 결과](implementation-review-results.md).

전체 `pnpm test`, `pnpm e2e`는 저장소 규약대로 로컬에서 실행하지 않았다.
커밋·push·CI 실행도 하지 않았다. Docker 실행기가 없어 로컬 컨테이너 빌드는 미검증이다.
CI에 Docker build 검증을 추가했다. Vite 주 번들의 500kB 경고는 남아 있다.

## 공개 전 필수 확인

1. 프로젝트·리전·도메인·Google OAuth 클라이언트와 redirect·DB 사용자/CA·비밀·실제 모델 단가/한도 설정.
2. CI 전체 gate와 실제 Docker 이미지 기동, 운영 worker의 키 누락 시 기동 실패.
3. Supabase transaction pool + RLS, 실제 Google 로그인(초대·운영자 이메일·차단), Pages 쿠키 전달 실제 왕복.
4. R2 conditional write/SDK checksum·이중 백업 lifecycle·GCS 권한·운영 알림 수신.
5. 실제 Cloud Tasks 중복/kill 복구와 예산 대조, 10세션 staging 부하, Cloud Run 메모리/냉간 지연.
6. 격리된 관리형 DB 복원 뒤 기존 Google 계정 재로그인, 삭제·외부 분석 삭제 완료 확인.
7. 실제 LLM 소규모 pilot과 예산 한도 조정. 이 작업에서는 유료 LLM 호출을 하지 않았다.

초기 운영 제약: SAVE_VERSION은 동결한다. 진행 경기와 호환되지 않는 sim 배포는 기존
서비스를 계속 제공하면서 거절한다. 여러 runtime cohort 운영은 아직 없다. 일부 상세 GET은
새 Worker에서 전체 세이브를 검증하므로 성능 목표는 staging에서 확인해야 한다.
운영 관리·보고서는 CLI이며 공개 관리자 대시보드나 자동 초대 이메일 발송은 제공하지 않는다.
