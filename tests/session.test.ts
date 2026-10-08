import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import { createAuthSession } from "../src/services/auth";
import { authStateAtom, initialAuthState } from "../src/state/auth";
import { channelId, secondChannelId } from "./fixtures";

function channels(ids = [channelId]) {
  return Response.json({ items: ids.map((id) => ({ id, snippet: { title: id } })) });
}
function token() {
  return Response.json({ accessToken: "restored-token", expiresAt: Date.now() + 3600_000 });
}
function inputPath(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : input.toString();
}

describe("persistent browser session", () => {
  it("restores a channel and token from the cookie endpoint, deduplicating startup requests", async () => {
    const store = createStore();
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      inputPath(input) === "/auth/token" ? token() : channels(),
    );
    const session = createAuthSession(store, fetcher);
    await Promise.all([session.restore(), session.restore()]);
    expect(store.get(authStateAtom)).toMatchObject({
      status: "authenticated",
      accessToken: "restored-token",
      channel: { id: channelId },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "X-GSA-Request": "1" },
      cache: "no-store",
    });
    await session.restore();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shows a disconnected state when no persistent session exists", async () => {
    const store = createStore();
    const session = createAuthSession(store, async () =>
      Response.json({ message: "Connect" }, { status: 401 }),
    );
    await expect(session.restore()).rejects.toThrow("Connect");
    expect(store.get(authStateAtom)).toEqual(initialAuthState);
  });

  it("refreshes before a request after a sleeping tab wakes and deduplicates concurrent requests", async () => {
    const store = createStore();
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      inputPath(input) === "/auth/token" ? token() : channels(),
    );
    const session = createAuthSession(store, fetcher);
    await session.restore();
    store.set(authStateAtom, (state) => ({ ...state, expiresAt: Date.now() - 1 }));
    await expect(
      Promise.all([session.accessToken(channelId), session.accessToken(channelId)]),
    ).resolves.toEqual(["restored-token", "restored-token"]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("retains the selected channel on renewal and blocks writes when the cookie changes accounts", async () => {
    const store = createStore();
    let currentChannels = [channelId, secondChannelId];
    const session = createAuthSession(store, async (input) =>
      inputPath(input) === "/auth/token" ? token() : channels(currentChannels),
    );
    await session.restore();
    store.set(authStateAtom, (state) => ({ ...state, channel: state.channels[1], expiresAt: 1 }));
    await expect(session.accessToken(secondChannelId)).resolves.toBe("restored-token");
    expect(store.get(authStateAtom).channel?.id).toBe(secondChannelId);
    currentChannels = [channelId];
    store.set(authStateAtom, (state) => ({ ...state, expiresAt: 1 }));
    await expect(session.accessToken(secondChannelId)).rejects.toThrow("channel changed");
  });

  it("prevents an in-flight refresh from reconnecting after disconnect", async () => {
    const store = createStore();
    let resolveToken!: (response: Response) => void;
    const session = createAuthSession(store, async (input) => {
      const path = inputPath(input);
      if (path === "/auth/token")
        return new Promise<Response>((resolve) => {
          resolveToken = resolve;
        });
      if (path === "/auth/logout") return new Response(null, { status: 204 });
      return channels();
    });
    const restoring = session.restore();
    await session.disconnect();
    resolveToken(token());
    await restoring;
    expect(store.get(authStateAtom)).toEqual(initialAuthState);
  });

  it("keeps a usable access token during a transient proactive-refresh failure", async () => {
    const store = createStore();
    let fail = false;
    const session = createAuthSession(store, async (input) => {
      if (inputPath(input) !== "/auth/token") return channels();
      return fail ? Response.json({ message: "Temporary failure" }, { status: 502 }) : token();
    });
    await session.restore();
    store.set(authStateAtom, (state) => ({ ...state, expiresAt: Date.now() + 45_000 }));
    fail = true;
    await expect(session.renewIfNeeded()).rejects.toThrow("Temporary failure");
    expect(store.get(authStateAtom)).toMatchObject({
      status: "authenticated",
      accessToken: "restored-token",
    });
  });

  it("stops automatic renewal and blocks writes after Google revokes authorization", async () => {
    const store = createStore();
    let fail = false;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (inputPath(input) !== "/auth/token") return channels();
      return fail ? Response.json({ message: "Revoked" }, { status: 401 }) : token();
    });
    const session = createAuthSession(store, fetcher);
    await session.restore();
    fail = true;
    store.set(authStateAtom, (state) => ({ ...state, expiresAt: 1 }));
    await expect(session.accessToken(channelId)).rejects.toThrow("Revoked");
    expect(store.get(authStateAtom)).toMatchObject({ status: "expired", accessToken: null });
    await session.renewIfNeeded();
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(session.accessToken(channelId)).rejects.toThrow("Reconnect");
  });
});
