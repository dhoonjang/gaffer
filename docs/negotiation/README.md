# 협상과 구단 운영

협상 GM이 상대 구단·선수·에이전트를 연기한다. 설득의 의미는 GM이 판단하고, 계약·약속·지급은 검증된 원장으로 확정한다.

소유하는 책임: 영입·매각·재계약·임대, 감독·스태프 계약, 재정·예산 요청, 선수 약속·스카우팅.

선수·팀 정보는 common의 같은 ID를 사용한다. 협상 타결이 선수 소속과 계약을 바꾸며, story는 그 사실을 장면과 관계에 반영한다.

코드는 `packages/domain/src/negotiation`, `packages/engine/src/negotiation`,
`packages/agents/src/negotiation`, `apps/web/domains/negotiation`에서 찾는다.
여러 경험을 연결하는 실행 흐름은 engine·agents의 `app/workflows/negotiation`에 있다.

[전체 문서 지도](../README.md) · [아키텍처](../architecture.md)

협상에서 감독이 한 말은 자유로운 논거 문장으로 기록한다. 코어는 논거 종류나 선수
원형으로 진위·거짓 벌점·수락 여유를 계산하지 않는다. 이적료·주급·계약·예산·소유권의
앵커와 합법 범위는 코어가 지키고, 상대 GM이 인물과 사실을 읽어 그 범위 안에서 답한다.
확인된 계약 지위와 조건은 응답·개인 합의·최종 계약에 같은 값으로 전달한다.
