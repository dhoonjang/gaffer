# 화면

`apps/web`은 화면 단위로 나뉜다 — `game/`(게임 화면의 껍데기와 서버 배관: 턴 실행·저장·
스트림·실시간 경기 확정), `screens/<화면>`(채팅 · 메일함과 협상 확인 · 장부 뷰 `office`(일정·대회·재정·커리어) ·
선수단 · 경기), `shared/`(여러 화면이 쓰는 조각과 스타일), `dev/`(턴 원문 뷰어). 화면은 `shared/`만
부르고 서로를 부르지 않는다. Next 라우트(`app/`)는 URL과 API의 경계다.

## 문서

- [화면 규약](design-system.md)

## 코드

- `apps/web/`

[문서 지도](../README.md) · [책임 구조](../architecture.md)
