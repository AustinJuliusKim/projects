/**
 * Identity provider: stable anonId, captured display name, and the signed-in
 * user (null when anonymous or offline — refreshSession swallows failures so
 * guided mode never depends on the backend).
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { ensureAnonId, getUserName, setUserName as persistUserName } from "./identity.js";
import { getMe } from "../api/client.js";

const IdentityContext = createContext({
  anonId: null,
  userName: null,
  setUserName: () => null,
  user: null,
  refreshSession: async () => null,
});

export function IdentityProvider({ children }) {
  const [anonId] = useState(() => ensureAnonId());
  const [userName, setUserNameState] = useState(() => getUserName());
  const [user, setUser] = useState(null);

  const setUserName = useCallback((raw) => {
    const sanitized = persistUserName(raw);
    if (sanitized) setUserNameState(sanitized);
    return sanitized;
  }, []);

  const refreshSession = useCallback(async () => {
    const res = await getMe(); // null on 401/offline — silently anonymous
    const nextUser = res?.user ?? null;
    setUser(nextUser);
    return nextUser;
  }, []);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  return (
    <IdentityContext.Provider value={{ anonId, userName, setUserName, user, refreshSession }}>
      {children}
    </IdentityContext.Provider>
  );
}

export function useIdentity() {
  return useContext(IdentityContext);
}
