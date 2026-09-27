/**
 * 장부 다섯 뷰의 배럴 — 뷰마다 파일 하나다.
 *
 * 한 경로는 한 사람이 갖는다 — 다섯 뷰가 한 파일에 있으면 서로 다른 뷰를 손보는
 * 작업끼리도 순서를 기다린다. 부르는 쪽(`game-screen.tsx`)은 여기만 보면 된다.
 */
export { SquadView } from "../../domains/match/ui/squad/squad-view";
export { CalendarView } from "./calendar";
export { FinanceView } from "../../domains/negotiation/ui/finance";
export { CompetitionsView } from "../../domains/match/ui/competitions";
export { CareerView } from "../../domains/story/ui/career";
