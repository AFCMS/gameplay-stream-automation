import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";

import { createBroadcastService } from "../src/services/broadcasts";
import type { GameHelper } from "../src/services/helper";
import { YouTubeError, type YouTubeClient } from "../src/services/youtube";
import { createLibraryStore } from "../src/storage/database";
import { channelId, draft, game, playlist, videoId } from "./fixtures";

function setup() {
  const store = createLibraryStore(crypto.randomUUID());
  const broadcast = {
    id: videoId,
    snippet: {
      channelId,
      title: draft().title,
      publishedAt: new Date().toISOString(),
      scheduledStartTime: new Date().toISOString(),
    },
    status: { privacyStatus: "public", lifeCycleStatus: "created" },
  };
  const api = {
    ownedPlaylist: vi
      .fn<YouTubeClient["ownedPlaylist"]>()
      .mockResolvedValue({ id: playlist().playlistId, snippet: { channelId, title: "Title" } }),
    createBroadcast: vi.fn<YouTubeClient["createBroadcast"]>().mockResolvedValue(broadcast),
    verifyPublicVideo: vi.fn<YouTubeClient["verifyPublicVideo"]>().mockResolvedValue({
      id: videoId,
      snippet: { channelId, title: "Title", categoryId: "20" },
      status: { privacyStatus: "public" },
    }),
    applyMetadata: vi.fn<YouTubeClient["applyMetadata"]>().mockResolvedValue(undefined),
    uploadThumbnail: vi.fn<YouTubeClient["uploadThumbnail"]>().mockResolvedValue(undefined),
    appendToPlaylist: vi.fn<YouTubeClient["appendToPlaylist"]>().mockResolvedValue(undefined),
    reconcileBroadcasts: vi
      .fn<YouTubeClient["reconcileBroadcasts"]>()
      .mockResolvedValue([broadcast]),
  };
  const helper = {
    status: vi
      .fn<GameHelper["status"]>()
      .mockResolvedValue({ version: "1.0.0", channelId, transport: "background" }),
    searchGames: vi.fn<GameHelper["searchGames"]>().mockResolvedValue([game]),
    getVideoGame: vi.fn<GameHelper["getVideoGame"]>().mockResolvedValue(game),
    setVideoGame: vi.fn<GameHelper["setVideoGame"]>().mockResolvedValue(game),
  };
  const service = createBroadcastService({ store, api, helper });

  return { store, api, helper, service };
}

describe("broadcast recovery", () => {
  it("persists intent before creation and saves the ID before setup", async () => {
    const { store, api, service } = setup();
    const create = api.createBroadcast.getMockImplementation()!;

    api.createBroadcast.mockImplementation(async (...args) => {
      expect((await store.operations(channelId))[0].status).toBe("creating");
      return create(...args);
    });
    api.applyMetadata.mockImplementation(async () => {
      expect((await store.operations(channelId))[0].broadcastId).toBe(videoId);
    });

    const operation = await service.create(playlist(), draft());

    expect(operation.status).toBe("complete");
    expect(operation.completedSteps).toEqual(["metadata", "thumbnail", "game", "playlist"]);
    expect(api.createBroadcast).toHaveBeenCalledTimes(1);
  });

  it.each(["metadata", "thumbnail", "game", "playlist"])(
    "resumes only unfinished steps after %s fails",
    async (step) => {
      const { api, helper, service } = setup();
      const steps = ["metadata", "thumbnail", "game", "playlist"];
      const action = {
        metadata: api.applyMetadata,
        thumbnail: api.uploadThumbnail,
        game: helper.setVideoGame,
        playlist: api.appendToPlaylist,
      }[step]!;
      action.mockRejectedValueOnce(new Error("Temporary failure"));

      const failed = await service.create(
        playlist(),
        draft({ thumbnail: new Blob(["image"], { type: "image/png" }) }),
      );
      expect(failed.status).toBe("failed");
      expect(failed.broadcastId).toBe(videoId);

      expect(failed.completedSteps).toEqual(steps.slice(0, steps.indexOf(step)));
      expect(api.appendToPlaylist).toHaveBeenCalledTimes(step === "playlist" ? 1 : 0);

      const complete = await service.resume(failed.id);
      expect(complete.status).toBe("complete");
      expect(complete.broadcastId).toBe(failed.broadcastId);
      expect(api.createBroadcast).toHaveBeenCalledTimes(1);
      expect(action).toHaveBeenCalledTimes(2);

      expect(api.applyMetadata).toHaveBeenCalledTimes(step === "metadata" ? 2 : 1);
      expect(api.uploadThumbnail).toHaveBeenCalledTimes(step === "thumbnail" ? 2 : 1);
      expect(helper.setVideoGame).toHaveBeenCalledTimes(step === "game" ? 2 : 1);
      expect(api.appendToPlaylist).toHaveBeenCalledTimes(step === "playlist" ? 2 : 1);
      expect(api.appendToPlaylist).toHaveBeenCalledWith(playlist().playlistId, channelId, videoId, {
        preserveAutomaticOrder: false,
      });
    },
  );

  it("does not create anything when helper readiness fails", async () => {
    const { api, helper, store, service } = setup();
    helper.status.mockRejectedValue(new Error("Wrong channel"));

    await expect(service.create(playlist(), draft())).rejects.toThrow("Wrong channel");
    expect(api.createBroadcast).not.toHaveBeenCalled();
    expect(await store.operations(channelId)).toEqual([]);
  });

  it("blocks another creation after a lost response and can adopt the matching event", async () => {
    const { api, service } = setup();
    api.createBroadcast.mockRejectedValueOnce(new TypeError("Network disconnected"));

    const operation = await service.create(playlist(), draft());
    expect(operation.status).toBe("uncertain");
    expect(operation.broadcastId).toBeUndefined();

    await expect(service.create(playlist(), draft())).rejects.toThrow("previous broadcast");
    await expect(service.resume(operation.id)).rejects.toThrow("Reconcile");

    const recovered = await service.adopt(operation, videoId);
    expect(recovered.status).toBe("complete");
    expect(api.createBroadcast).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh attempt after a definitive API rejection", async () => {
    const { api, service } = setup();
    api.createBroadcast.mockRejectedValueOnce(new YouTubeError(403, "Streaming is disabled"));

    expect((await service.create(playlist(), draft())).status).toBe("cancelled");
    expect((await service.create(playlist(), draft())).status).toBe("complete");
  });

  it("reconciles HTTP request timeouts before allowing another broadcast", async () => {
    const { api, service } = setup();
    api.createBroadcast.mockRejectedValueOnce(new YouTubeError(408, "Request timed out"));

    expect((await service.create(playlist(), draft())).status).toBe("uncertain");
    await expect(service.create(playlist(), draft())).rejects.toThrow("previous broadcast");
    expect(api.createBroadcast).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid drafts before any external call", async () => {
    const { api, service } = setup();

    await expect(service.create(playlist(), draft({ title: "", episode: 0 }))).rejects.toThrow(
      "title",
    );
    expect(api.createBroadcast).not.toHaveBeenCalled();
    expect(api.ownedPlaylist).not.toHaveBeenCalled();
  });

  it("keeps imported playlists’ automatic sorting during recovered setup", async () => {
    const { api, store, service } = setup();
    const imported = playlist({ source: "imported" });
    await store.putPlaylist(imported);
    api.appendToPlaylist.mockRejectedValueOnce(new Error("Temporary failure"));

    const failed = await service.create(imported, draft());
    const recovered = await service.resume(failed.id);

    expect(recovered.status).toBe("complete");
    expect(api.appendToPlaylist).toHaveBeenLastCalledWith(imported.playlistId, channelId, videoId, {
      preserveAutomaticOrder: true,
    });
    expect(api.createBroadcast).toHaveBeenCalledTimes(1);
  });
});
