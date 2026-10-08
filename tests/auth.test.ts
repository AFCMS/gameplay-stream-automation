import { describe, expect, it } from "vitest";

import { accessTokenForChannel, initialAuthState } from "../src/state/auth";
import { channelId, secondChannelId } from "./fixtures";

describe("in-memory authorization", () => {
  const state = {
    ...initialAuthState,
    status: "authenticated" as const,
    accessToken: "test-token",
    expiresAt: Date.now() + 3600_000,
    channel: { id: channelId, title: "Test", thumbnailUrl: null },
  };

  it("checks expiry at request time, including after a sleeping tab wakes", () => {
    expect(accessTokenForChannel(state, channelId)).toBe("test-token");
    expect(() => accessTokenForChannel({ ...state, expiresAt: 0 }, channelId)).toThrow("Reconnect");
  });

  it("rejects a write after switching channels", () => {
    expect(() => accessTokenForChannel(state, secondChannelId)).toThrow("channel changed");
  });
});
