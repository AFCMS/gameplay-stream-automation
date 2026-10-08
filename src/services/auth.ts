import type { createStore } from "jotai";

import { errorMessage } from "../domain/types";
import { accessTokenForChannel, authStateAtom, initialAuthState } from "../state/auth";
import { YouTubeClient, YouTubeError } from "./youtube";

type Store = ReturnType<typeof createStore>;

export class SessionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createAuthSession(store: Store, fetcher: typeof fetch = fetch) {
  let generation = 0;
  let active = true;
  let initialized = false;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;

  async function post(path: string, signal?: AbortSignal): Promise<Response> {
    const response = await fetcher(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-GSA-Request": "1" },
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new SessionError(
        response.status,
        data?.message ?? "Google connection failed. Please try again.",
      );
    }
    return response;
  }

  function refresh(): Promise<void> {
    if (pending) return pending;
    if (!active)
      return Promise.reject(new SessionError(401, "Reconnect Google before continuing."));
    const attempt = generation;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    if (!store.get(authStateAtom).channel) {
      store.set(authStateAtom, (previous) => ({
        ...previous,
        status: "loading",
        errorMessage: null,
      }));
    }
    const operation = (async () => {
      try {
        const response = await post("/auth/token", signal);
        const token = (await response.json()) as { accessToken?: unknown; expiresAt?: unknown };
        if (
          typeof token.accessToken !== "string" ||
          !token.accessToken ||
          typeof token.expiresAt !== "number" ||
          token.expiresAt - Date.now() < 30_000
        ) {
          throw new Error("The authorization server returned an invalid token.");
        }
        const accessToken = token.accessToken;
        if (attempt !== generation) return;
        const channels = await new YouTubeClient(() => accessToken, fetcher).channels();
        if (attempt !== generation) return;
        if (!channels.length)
          throw new Error("Google did not return a YouTube channel for this account.");
        const previous = store.get(authStateAtom);
        store.set(authStateAtom, {
          status: "authenticated",
          accessToken,
          expiresAt: token.expiresAt,
          channels,
          channel: channels.find((channel) => channel.id === previous.channel?.id) ?? channels[0],
          errorMessage: null,
        });
      } catch (error) {
        if (attempt !== generation) return;
        const previous = store.get(authStateAtom);
        const unauthorized =
          (error instanceof SessionError || error instanceof YouTubeError) && error.status === 401;
        if (unauthorized) active = false;
        if (unauthorized && !previous.channel) {
          store.set(authStateAtom, initialAuthState);
        } else {
          const valid =
            !unauthorized && !!previous.expiresAt && previous.expiresAt - Date.now() > 30_000;
          store.set(authStateAtom, {
            ...previous,
            status: valid ? "authenticated" : previous.channel ? "expired" : "error",
            accessToken: valid ? previous.accessToken : null,
            errorMessage: errorMessage(error),
          });
        }
        throw error;
      }
    })();
    pending = operation;
    void operation
      .finally(() => {
        if (pending === operation) {
          pending = undefined;
          controller = undefined;
        }
      })
      .catch(() => {});
    return operation;
  }

  return {
    restore(): Promise<void> {
      if (initialized) return pending ?? Promise.resolve();
      initialized = true;
      return refresh();
    },
    async renewIfNeeded(): Promise<void> {
      const state = store.get(authStateAtom);
      if (active && state.channel && (!state.expiresAt || state.expiresAt - Date.now() < 60_000))
        await refresh();
    },
    async accessToken(channelId: string): Promise<string> {
      const state = store.get(authStateAtom);
      if (state.channel?.id !== channelId) return accessTokenForChannel(state, channelId);
      if (!state.accessToken || !state.expiresAt || state.expiresAt - Date.now() < 30_000)
        await refresh();
      // Recheck after renewal: another tab may have switched the cookie's Google account.
      return accessTokenForChannel(store.get(authStateAtom), channelId);
    },
    async disconnect(): Promise<void> {
      generation++;
      controller?.abort();
      pending = undefined;
      active = false;
      store.set(authStateAtom, (previous) => ({
        ...previous,
        status: "loading",
        accessToken: null,
      }));
      try {
        await post("/auth/logout");
        store.set(authStateAtom, initialAuthState);
      } catch (error) {
        store.set(authStateAtom, (previous) => ({
          ...previous,
          status: "error",
          errorMessage: errorMessage(error),
        }));
        throw error;
      }
    },
  };
}

const sessions = new WeakMap<Store, ReturnType<typeof createAuthSession>>();

export function authSessionFor(store: Store) {
  let session = sessions.get(store);
  if (!session) {
    session = createAuthSession(store);
    sessions.set(store, session);
  }
  return session;
}

export function consumeLoginError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("auth_error");
  if (!code) return null;
  url.searchParams.delete("auth_error");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  const messages: Record<string, string> = {
    cancelled: "Google authorization was cancelled.",
    state: "Google sign-in expired. Please try again.",
    offline_access: "Google did not grant offline access. Reconnect and approve access.",
    permissions: "Grant YouTube access when reconnecting Google.",
    configuration: "Google authorization is unavailable. Check the Worker's configuration.",
  };
  return messages[code] ?? "Google connection failed. Please try again.";
}
