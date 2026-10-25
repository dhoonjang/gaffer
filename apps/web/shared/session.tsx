import { createContext, useContext } from "react";

/** 로그인한 계정 — 셸이 `/api/auth/me`로 채우고 화면은 읽기만 한다 */
export interface Session {
  /** 로컬 인증(`GAFFER_AUTH_MODE=development`) — 로그아웃이 없고 DB·실험실이 열린다 */
  local: boolean;
  /** 로그인한 Google 이메일. 로컬 인증에는 없다 */
  email: string | null;
  logout: () => void;
}

export const SessionContext = createContext<Session>({
  local: false,
  email: null,
  logout: () => {},
});
export const useSession = () => useContext(SessionContext);
