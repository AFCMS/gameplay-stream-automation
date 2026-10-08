import { useGoogleLogin } from "@react-oauth/google";
import { useAtom } from "jotai";
import { useEffect, useRef } from "react";

import { errorMessage } from "../domain/types";
import { YouTubeClient } from "../services/youtube";
import { authStateAtom, initialAuthState } from "../state/auth";

export function useLogin() {
  const [authState, setAuthState] = useAtom(authStateAtom);
  const generation = useRef(0);

  const googleLogin = useGoogleLogin({
    scope: "https://www.googleapis.com/auth/youtube",
    onSuccess: async (response) => {
      const attempt = ++generation.current;
      const expiresAt = Date.now() + response.expires_in * 1000;

      setAuthState((previous) => ({ ...previous, status: "loading", errorMessage: null }));

      try {
        const api = new YouTubeClient(() => response.access_token);
        const channels = await api.channels();

        if (attempt !== generation.current) {
          return;
        }

        if (!channels.length) {
          throw new Error("Google did not return a YouTube channel for this account.");
        }

        setAuthState({
          status: "authenticated",
          accessToken: response.access_token,
          expiresAt,
          channels,
          channel: channels[0],
          errorMessage: null,
        });
      } catch (error) {
        if (attempt === generation.current) {
          setAuthState((previous) => ({
            ...previous,
            status: "error",
            accessToken: null,
            errorMessage: errorMessage(error),
          }));
        }
      }
    },
    onError: () =>
      setAuthState((previous) => ({
        ...previous,
        status: "error",
        accessToken: null,
        errorMessage: "Google connection failed. Please try again.",
      })),
    onNonOAuthError: () =>
      setAuthState((previous) => ({
        ...previous,
        status: previous.accessToken ? "authenticated" : "idle",
        errorMessage: "The Google sign-in window was closed or blocked. Try connecting again.",
      })),
  });

  useEffect(() => {
    if (!authState.expiresAt || authState.status !== "authenticated") {
      return;
    }

    const timer = window.setTimeout(
      () => {
        setAuthState((previous) => ({
          ...previous,
          status: "expired",
          accessToken: null,
          errorMessage: "Your Google connection expired. Reconnect to continue.",
        }));
      },
      Math.max(0, authState.expiresAt - Date.now() - 30_000),
    );

    return () => window.clearTimeout(timer);
  }, [authState.expiresAt, authState.status, setAuthState]);

  function login() {
    setAuthState((previous) => ({ ...previous, status: "loading", errorMessage: null }));
    googleLogin();
  }

  function disconnect() {
    generation.current++;
    setAuthState(initialAuthState);
  }

  return { authState, login, disconnect };
}
