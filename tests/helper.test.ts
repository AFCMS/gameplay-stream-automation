import { afterEach, describe, expect, it, vi } from "vitest";

import { HELPER_VERSION, PROTOCOL, isRequest, validResult } from "../src/helper/protocol";
import {
  assignGame,
  parseGames,
  parseStudioConfig,
  verifyStudioChannel,
  type StudioTransport,
} from "../src/helper/studio";
import { channelId, game, secondChannelId, videoId } from "./fixtures";

const command = { kind: "setVideoGame" as const, channelId, videoId, game };
const successfulUpdate = {
  overallResult: { resultCode: "UPDATE_SUCCESS" },
  gameTitle: { success: true },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("userscript boundary", () => {
  it("accepts only scoped typed operations", () => {
    const request = { protocol: PROTOCOL, direction: "request", id: "test-1", command };

    expect(isRequest(request)).toBe(true);
    expect(isRequest({ ...request, protocol: "other" })).toBe(false);
    expect(isRequest({ ...request, command: { kind: "fetch", url: "https://example.com" } })).toBe(
      false,
    );
    expect(isRequest({ ...request, command: { ...command, channelId: "other" } })).toBe(false);
    expect(isRequest({ ...request, command: { ...command, videoId: "../video" } })).toBe(false);
    expect(
      isRequest({
        ...request,
        command: { ...command, game: { mid: "javascript:bad", title: "bad" } },
      }),
    ).toBe(false);
  });

  it("rejects mismatched channels, versions and game IDs in responses", () => {
    const statusCommand = { kind: "status" as const, channelId };
    const status = { version: HELPER_VERSION, channelId, transport: "background" };

    expect(validResult(statusCommand, status)).toBe(true);
    expect(validResult(statusCommand, { ...status, channelId: secondChannelId })).toBe(false);
    expect(validResult(statusCommand, { ...status, version: "old" })).toBe(false);
    expect(validResult(command, game)).toBe(true);
    expect(validResult(command, { ...game, mid: "/m/other" })).toBe(false);
  });

  it("parses JSON bootstrap config without executing code, including braces in strings", () => {
    const config = {
      CHANNEL_ID: channelId,
      INNERTUBE_CONTEXT: { client: { clientName: "WEB_CREATOR", example: 'a } \\" value' } },
    };
    const parsed = parseStudioConfig(
      `<script>ytcfg.set({bad:doNotExecute()});ytcfg.set(${JSON.stringify(config)});</script>`,
    );

    expect(parsed).toEqual(config);
    expect(() => parseStudioConfig("<html>Sign in</html>")).toThrow("Sign in");
    expect(() => verifyStudioChannel(parsed, secondChannelId)).toThrow("different channel");
  });

  it("rejects unexpected Studio catalog responses", () => {
    expect(parseGames({ gameTitles: [game] })).toEqual([game]);
    expect(() => parseGames({ gameTitles: [{ title: "No catalog ID" }] })).toThrow("changed");
  });

  it("verifies video ownership before a game write", async () => {
    const transport = vi
      .fn<StudioTransport>()
      .mockResolvedValue({ videos: [{ videoId, channelId: secondChannelId }] });

    await expect(assignGame(transport, videoId, channelId, game)).rejects.toThrow("belongs");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("uses the exact catalog ID and requires successful read-back", async () => {
    const transport = vi
      .fn<StudioTransport>()
      .mockResolvedValueOnce({ videos: [{ videoId, channelId }] })
      .mockResolvedValueOnce(successfulUpdate)
      .mockResolvedValueOnce({ videos: [{ videoId, channelId, gameTitle: game }] });

    expect(await assignGame(transport, videoId, channelId, game)).toEqual(game);
    expect(transport.mock.calls[1]).toEqual([
      "video_manager/metadata_update",
      {
        encryptedVideoId: videoId,
        gameTitle: { newKgEntityId: game.mid },
        videoReadMask: { videoId: true, channelId: true, gameTitle: { all: true } },
      },
    ]);
  });

  it("rejects an HTTP success that does not acknowledge the game update", async () => {
    const transport = vi
      .fn<StudioTransport>()
      .mockResolvedValueOnce({ videos: [{ videoId, channelId }] })
      .mockResolvedValueOnce({ responseContext: {} });

    await expect(assignGame(transport, videoId, channelId, game)).rejects.toThrow(
      "did not confirm",
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "overall update",
      response: { overallResult: { resultCode: "UPDATE_FAILURE" }, gameTitle: { success: true } },
    },
    {
      name: "game field",
      response: { overallResult: { resultCode: "UPDATE_SUCCESS" }, gameTitle: { success: false } },
    },
  ])("rejects a failed $name despite HTTP success", async ({ response }) => {
    const transport = vi
      .fn<StudioTransport>()
      .mockResolvedValueOnce({ videos: [{ videoId, channelId }] })
      .mockResolvedValueOnce(response);

    await expect(assignGame(transport, videoId, channelId, game)).rejects.toThrow(
      "did not confirm",
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("waits for delayed read-back without repeating the game write", async () => {
    vi.useFakeTimers();

    const unchanged = { videos: [{ videoId, channelId }] };
    const transport = vi
      .fn<StudioTransport>()
      .mockResolvedValueOnce(unchanged)
      .mockResolvedValueOnce(successfulUpdate)
      .mockResolvedValueOnce(unchanged)
      .mockResolvedValueOnce(unchanged)
      .mockResolvedValueOnce({ videos: [{ videoId, channelId, gameTitle: game }] });
    const assignment = assignGame(transport, videoId, channelId, game);

    await vi.advanceTimersByTimeAsync(1000);

    expect(await assignment).toEqual(game);
    expect(transport).toHaveBeenCalledTimes(5);
    expect(
      transport.mock.calls.filter(([path]) => path === "video_manager/metadata_update"),
    ).toHaveLength(1);
  });

  it("stops after bounded read-back attempts when the game remains unchanged", async () => {
    vi.useFakeTimers();

    const transport = vi.fn<StudioTransport>(async (path) =>
      path === "video_manager/metadata_update"
        ? successfulUpdate
        : { videos: [{ videoId, channelId }] },
    );
    await Promise.all([
      expect(assignGame(transport, videoId, channelId, game)).rejects.toThrow("not confirmed"),
      vi.advanceTimersByTimeAsync(2500),
    ]);

    expect(transport).toHaveBeenCalledTimes(6);
    expect(
      transport.mock.calls.filter(([path]) => path === "video_manager/metadata_update"),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not repeat a game update that already succeeded", async () => {
    const transport = vi
      .fn<StudioTransport>()
      .mockResolvedValue({ videos: [{ videoId, channelId, gameTitle: game }] });

    expect(await assignGame(transport, videoId, channelId, game)).toEqual(game);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
