# 전술과 실시간 경기

경기 GM은 감독의 자유로운 지시를 해석한다. 공간 코어가 선수의 움직임과 승패를 결정하고, 서버가 체크포인트를 검증한다.

소유하는 책임: 선발·포지션·역할·전술, 공간 시뮬레이션·교체·개입, 경기 결산·징계·대회 일정·순위.

선수 능력·체력·폼은 common 정보를 사용한다. 계약이나 서사가 결과를 덮어쓰지 않는다. 훈련·협상의 결과가 명단과 전술을 통해 경기에 닿는다.

코드는 `packages/domain/src/match`, `packages/engine/src/match`,
`packages/agents/src/match`, `apps/web/domains/match`에서 찾는다.
경기 공간 코어는 `packages/sim`에 있다. 여러 경험을 연결하는 실행 흐름은 engine·agents의 `app/workflows/match`에 있다.

[전체 문서 지도](../README.md) · [아키텍처](../architecture.md)
