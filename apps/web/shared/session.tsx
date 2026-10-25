import { createContext, useContext } from "react";
export const SessionContext = createContext({ local: false });
export const useSession = () => useContext(SessionContext);
