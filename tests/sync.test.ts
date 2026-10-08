import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";

import type { BroadcastOperation } from "../src/domain/types";
import { syncLibrary } from "../src/services/sync";
import type { YouTubeClient } from "../src/services/youtube";
import { createLibraryStore } from "../src/storage/database";
import { channelId, secondChannelId, draft, playlist, videoId } from "./fixtures";

function operation(overrides: Partial<BroadcastOperation> = {}): BroadcastOperation {
  return {
    id: crypto.randomUUID(),
    channelId,
    playlistId: playlist().playlistId,
    playlistName: playlist().name,
    draft: draft(),
    createdAt: new Date().toISOString(),
    broadcastId: videoId,
    completedSteps: ["metadata", "thumbnail", "game", "playlist"],
    status: "complete",
    ...overrides,
  };
}

function setup() {
  const store = createLibraryStore(crypto.randomUUID());
  const api = {
    ownedPlaylists: vi
      .fn<YouTubeClient["ownedPlaylists"]>()
      .mockResolvedValue([
        { id: playlist().playlistId, snippet: { channelId, title: "Renamed on YouTube" } },
      ]),
    videos: vi.fn<YouTubeClient["videos"]>().mockResolvedValue([
      {
        id: videoId,
        snippet: { channelId, title: "Title", categoryId: "20" },
        status: { privacyStatus: "private" },
      },
    ]),
  };

  return { store, api };
}

describe("manual YouTube refresh", () => {
  it("removes deleted playlists and their operations without affecting other channels", async () => {
    const { store, api } = setup();
    const deleted = playlist({ playlistId: "PLdeleted123", thumbnail: new Blob(["image"]) });
    const removed = operation({ playlistId: deleted.playlistId });
    const other = operation({ channelId: secondChannelId, playlistId: deleted.playlistId });

    await store.putPlaylist(deleted);
    await store.putPlaylist(
      playlist({ channelId: secondChannelId, playlistId: deleted.playlistId }),
    );
    await store.putOperation(removed);
    await store.putOperation(other);

    await syncLibrary(channelId, api, store);

    expect(await store.playlists(channelId)).toEqual([]);
    expect(await store.operations(channelId)).toEqual([]);
    expect(await store.playlists(secondChannelId)).toHaveLength(1);
    expect(await store.getOperation(other.id)).toEqual(other);
  });

  it("removes known deleted videos, keeps private videos and unresolved creation attempts", async () => {
    const { store, api } = setup();
    const deleted = operation({ broadcastId: "missing0001", status: "failed" });
    const privateVideo = operation();
    const uncertain = operation({ broadcastId: undefined, status: "uncertain" });

    await store.putPlaylist(playlist());
    await Promise.all([deleted, privateVideo, uncertain].map((item) => store.putOperation(item)));

    await syncLibrary(channelId, api, store);

    expect(await store.getOperation(deleted.id)).toBeUndefined();
    expect(await store.getOperation(privateVideo.id)).toEqual(privateVideo);
    expect(await store.getOperation(uncertain.id)).toEqual(uncertain);
  });

  it("updates remote names while retaining playlist defaults and thumbnails", async () => {
    const { store, api } = setup();
    const local = playlist({
      seriesName: "My series",
      audioLanguage: "fr",
      thumbnail: new Blob(["image"]),
    });
    await store.putPlaylist(local);

    await syncLibrary(channelId, api, store);
    const saved = (await store.playlists(channelId))[0];

    expect(saved.name).toBe("Renamed on YouTube");
    expect(saved.seriesName).toBe(local.seriesName);
    expect(saved.audioLanguage).toBe(local.audioLanguage);
    expect(await saved.thumbnail?.text()).toBe("image");
    expect(saved.game).toEqual(local.game);
  });

  it.each(["ownedPlaylists", "videos"] as const)(
    "leaves every record intact if %s fails",
    async (method) => {
      const { store, api } = setup();
      const saved = operation();
      await store.putPlaylist(playlist());
      await store.putOperation(saved);
      api.ownedPlaylists.mockResolvedValue([]);
      api[method].mockRejectedValue(new Error("Connection expired"));

      await expect(syncLibrary(channelId, api, store)).rejects.toThrow("Connection expired");

      expect(await store.playlists(channelId)).toEqual([playlist()]);
      expect(await store.getOperation(saved.id)).toEqual(saved);
    },
  );

  it("keeps concurrent local edits when applying refreshed names", async () => {
    const { store, api } = setup();
    await store.putPlaylist(playlist());
    api.videos.mockImplementation(async () => {
      await store.putPlaylist(playlist({ seriesName: "Edited while refreshing" }));
      return [];
    });

    await syncLibrary(channelId, api, store);

    expect((await store.playlists(channelId))[0].seriesName).toBe("Edited while refreshing");
  });

  it("stops on a video ownership mismatch", async () => {
    const { store, api } = setup();
    await store.putPlaylist(playlist());
    await store.putOperation(operation());
    api.videos.mockResolvedValue([
      { id: videoId, snippet: { channelId: secondChannelId, title: "Other", categoryId: "20" } },
    ]);

    await expect(syncLibrary(channelId, api, store)).rejects.toThrow("another channel");
    expect(await store.playlists(channelId)).toEqual([playlist()]);
    expect(await store.operations(channelId)).toHaveLength(1);
  });
});
