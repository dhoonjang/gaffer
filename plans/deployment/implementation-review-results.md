# 구현 교차 검토 반영

Claude가 [독립 검토](claude-implementation-review.md)를 수행한 뒤 Codex가 수정했다.
Claude 보고서는 검토 시점의 스냅샷이며, 아래 수정에 대한 Claude의 재승인을 뜻하지 않는다.
현재 출시 보류의 기준과 환경 검증은 [구현 상태](implementation-status.md)에 있다.

| 지적                   | 반영과 확인                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1 백업 pin 영구 잠김  | 실패 finally 해제, 실행 중 갱신, 중단 pin 15분 후 재취득. 실패→재시도 테스트 통과. 복원 pin은 유지                                                           |
| B2 결과 객체 무한 백업 | 완료 결과/patch 7일 정리, 일일 백업에서 과거 결과 제외, 현재 게임/view와 동의 진단만 4개씩 복사. GCS lifecycle과 R2 설치 명령. 실제 원격 처리 시간은 미측정  |
| B3 DB TLS/idle error   | 공통 verified TLS 설정, 선택 CA PEM, sslmode 우회 차단, Pool error listener. TLS 옵션 테스트. 실제 Supabase CA 왕복은 미검증                                 |
| B4 미완료 경기 배포    | sim/SAVE_VERSION 불일치 검사에서 실패하면 점검과 배포 lock을 해제해 기존 서비스 유지. 경기 완료 후 배포하는 초기 정책. 다중 cohort 자동 전환은 구현하지 않음 |
| B5 mock fallback       | 운영 real 강제, worker의 모든 설정된 provider 키와 모든 모델 가격을 기동 시 확인                                                                             |
| B6 permit/429 비용     | 성공 후 TPM 실제 token으로 교체, 명시적 생성 전 거절은 0 정산, network/5xx unknown은 유지. 429·thinking·실패 예약·stale attempt 회수 테스트 통과             |
| H1 메모리              | worker 2GiB, 부모 실행 수 제한. Cloud Run의 진행된 시즌 peak RSS는 staging 게이트                                                                            |
| H2 상세 GET 비용       | 카탈로그 재사용, 현재 게임 view와 기본 mail/negotiation 조회 재사용. 일부 상세 GET의 Worker/tsx 비용은 남으며 성능 목표 달성은 미확정                        |
| H3 백업 gate           | 신규 게임·LLM 턴만 차단. 최초 백업을 첫 초대 전 필수 단계로 명시                                                                                             |
| H4 takeover            | 일반 작업 진행 중이면 409, 경기 작업만 취소. lorebook은 취소하지 않음                                                                                        |
| H5 영수증              | 관측 revision별 key와 15분 TTL, 최종 job revision으로 갱신, 재접속 활성 작업 복구                                                                            |
| H6 lorebook            | foreground 우선 permit, 대기 시 15초 뒤 재전달하여 슬롯 반환, 실제 실패 횟수 분리, dead 편집 보류 알람과 retry-lore CLI. 후속 편집은 추월하지 않음           |
| H7 refresh             | 30초 claim 후 트랜잭션 밖에서 갱신, 회전 token을 검증 요청 전에 저장                                                                                         |
| H8 heartbeat           | 한 번의 네트워크 오류로 중단하지 않고 마지막 성공 이후 45초까지 재시도                                                                                       |
| H9 관측                | 오류 kind·phase, backlog/unknown/dead 메트릭, 로그 기반 알림, 선택 billing budget. 수신 채널·실제 비용 알림 확인 필요                                        |
| H10 Auth 복구          | private 백업과 Auth는 구분. 운영자가 검증된 새 Auth identity를 원래 이메일 hash와 대조해 연결하는 감사 CLI. 관리형 프로젝트 복원 훈련 필요                   |
| H11 생성 한도          | 계정당 활성 게임 2개, 실패 placeholder 정리                                                                                                                  |
| H12 배포               | image/traffic Terraform drift 제외, exact CI 이미지 재사용, SQL expand 단계, candidate health 후 전환, 버전 검증 전 실패 시 기존 서비스 유지                 |

개발 데이터는 별도 디렉터리에 보존했고 사용자 서버 3000/3311은 종료하지 않았다.
추가 보강: 계정 삭제 marker를 R2에 독립 저장하여 DB만 잃은 복원에서도 재삭제한다.
SDK 시도는 agent/call/game version과 연결한다. SQL RLS 및 공개 API의 타인 접근·Origin·개발
경로 차단을 검증했다. 실제 클라우드 설정·성능·복원 증거 없이 공개 승인을 선언하지 않는다.
