# Gaffer

자연어로 팀을 지휘하고, 매 시즌을 이야기로 만들어 가는 AI 풋볼 매니저 게임입니다.
선수와 세계의 상태는 코어가 결정적으로 관리하고, LLM은 감독의 지시를 해석해
경기와 인물의 반응을 서사로 전달합니다.

현재 온보딩부터 일상 지시, 경기, 시즌 전환, 멀티시즌까지 플레이할 수 있는
프로토타입 단계입니다.

## 핵심 원칙

- 언어가 핵심 인터페이스입니다.
- 경기 결과와 상태 변경은 시뮬레이션 코어가 결정합니다.
- LLM은 검증된 도구 호출을 통해서만 게임 상태에 영향을 줍니다.
- 결과보다 그 결과가 만들어 내는 납득 가능한 이야기를 중시합니다.

## 시작하기

[`.nvmrc`](.nvmrc)가 정하는 Node 26과 pnpm 9가 필요합니다.

```bash
pnpm install
pnpm dev
```

브라우저에서 [http://localhost:5173](http://localhost:5173)을 열고 Google로 로그인합니다.
인증 설정은 [배포 운영 문서](docs/deployment/README.md)의 로컬 실행을 따릅니다. API 키가 없으면
mock 모드로 실행되며, 실제 LLM을 사용하려면 [`config/llm.yml`](config/llm.yml)에
설정된 제공자의 API 키를 환경 변수로 지정합니다.

## 베타 배포

React/Vite와 NestJS는 `pnpm dev`에서 함께 실행됩니다. 로컬 기본 데이터는
`/tmp/gaffer-service`의 PGlite·객체 저장소에 있으며 기존 `.data`는 자동 이전하지 않습니다.
공개 운영 구성·인증·가격/예산·백업·배포 절차는 [배포 운영 문서](docs/deployment/README.md)를
따릅니다. 인증을 제외한 격리 테스트에는 `GAFFER_AUTH_MODE=development`를 명시합니다.
이 인증 우회 모드는 운영에서 사용할 수 없습니다.

## 개발 명령

```bash
pnpm test       # 단위 테스트
pnpm typecheck  # 타입 검사
pnpm lint       # 린트
pnpm e2e        # E2E 테스트
```

게임의 현재 동작은 [`docs/README.md`](docs/README.md), 비전과 개발 규약은
[`AGENTS.md`](AGENTS.md)를 참고하세요.
