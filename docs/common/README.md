# 공유 정보와 기반

[선수 거래 명세](../negotiation/transfer.md)의 상대별 협상 테이블·거래·교환은 공통 선수·팀·인물 ID를
참조한다. common은 협상 원장을 복제하거나 후속 이벤트를 실행하지 않는다.
[저장 상태](game-state.md)는 기록의 연결을, [시즌](season.md)은 예정일 도달과 전달을 설명한다.

[스카우팅](../negotiation/scouting.md)의 의뢰·계획·보고서는 negotiation이 소유한다.
common은 실제 선수 상태와 공통 관측 표시 규약을 제공하며 조사 일수·정확도·후보 수를 정하지 않는다.

선수·팀·구단 카탈로그와 기본 상태는 하나만 존재한다. 세 도메인은 같은 식별자와 사실을 사용하며 각자의 파생값과 판단만 소유한다.

소유하는 책임: 선수·팀·능력·몸 상태·카탈로그, 날짜·난수·참조 해석, 공통 스키마와 표시 데이터. 선수의 출전·수상·성장·계약 조건, 팀 전술, 감독 계약·고용의 저장된 사실도 공유 원장이다.

새 게임·하루·시즌·저장·통합 화면은 app 조립 계층이 도메인들을 연결한다. common은 각 도메인의 판단이나 GM을 실행하지 않는다.

코드는 `packages/domain/src/common`, `packages/engine/src/common`,
`packages/agents/src/common`, `apps/web/domains/common`에서 찾는다.
모델 제공자 기반은 `packages/llm`에 있다.

[전체 문서 지도](../README.md) · [아키텍처](../architecture.md)
