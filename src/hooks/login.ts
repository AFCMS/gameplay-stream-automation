import { useAtomValue, useStore } from "jotai";
import { useEffect, useMemo } from "react";

import { authSessionFor, consumeLoginError } from "../services/auth";
import { authStateAtom } from "../state/auth";

export function useLogin() {
  const store = useStore();
  const authState = useAtomValue(authStateAtom);
  const session = useMemo(() => authSessionFor(store), [store]);

  useEffect(() => {
    const loginError = consumeLoginError();
    void session
      .restore()
      .catch(() => {})
      .then(() => {
        if (loginError)
          store.set(authStateAtom, (previous) => ({ ...previous, errorMessage: loginError }));
      });
    const renew = () => {
      void session.renewIfNeeded().catch(() => {});
    };
    const visible = () => {
      if (document.visibilityState === "visible") renew();
    };
    const timer = window.setInterval(renew, 30_000);
    window.addEventListener("pageshow", renew);
    window.addEventListener("focus", renew);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pageshow", renew);
      window.removeEventListener("focus", renew);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [session, store]);

  function login() {
    store.set(authStateAtom, (previous) => ({
      ...previous,
      status: "loading",
      errorMessage: null,
    }));
    window.location.assign("/auth/start");
  }

  function disconnect() {
    void session.disconnect().catch(() => {});
  }

  return { authState, login, disconnect };
}
