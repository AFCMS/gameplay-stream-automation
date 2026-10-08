import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { exportLibrary, importLibrary } from "../src/storage/backup";
import { createLibraryStore } from "../src/storage/database";
import { channelId, playlist, secondChannelId } from "./fixtures";

const database = () => createLibraryStore(crypto.randomUUID());

function backup(records: unknown[]) {
  return JSON.stringify({ format: "gameplay-stream-library", version: 1, playlists: records });
}

describe("portable library", () => {
  it("round-trips binary thumbnails and metadata across browsers", async () => {
    const source = database();
    const destination = database();
    const thumbnail = new Blob([new Uint8Array([0, 255, 128, 1])], { type: "image/png" });

    await source.putPlaylist(playlist({ thumbnail }));
    expect(await importLibrary(destination, await exportLibrary(source))).toBe(1);

    const saved = (await destination.playlists(channelId))[0];
    expect(saved.seriesName).toBe("Halo 4");
    expect(saved.game.title).toBe("Halo: The Master Chief Collection");
    expect(saved.thumbnail?.type).toBe("image/png");
    expect(await saved.thumbnail?.arrayBuffer()).toEqual(await thumbnail.arrayBuffer());
  });

  it("keeps local metadata and segregates records by channel", async () => {
    const store = database();
    await store.putPlaylist(playlist({ seriesName: "Local name" }));

    const count = await importLibrary(
      store,
      backup([
        playlist({ seriesName: "Imported name" }),
        playlist({ channelId: secondChannelId, seriesName: "Other channel" }),
      ]),
    );

    expect(count).toBe(1);
    expect((await store.playlists(channelId))[0].seriesName).toBe("Local name");
    expect((await store.playlists(secondChannelId))[0].seriesName).toBe("Other channel");
  });

  it("imports duplicate records once and keeps the first file record", async () => {
    const store = database();

    expect(
      await importLibrary(store, backup([playlist(), playlist({ seriesName: "Duplicate" })])),
    ).toBe(1);
    expect((await store.playlists())[0].seriesName).toBe("Halo 4");
  });

  it("validates the whole file before changing the database", async () => {
    const store = database();

    await expect(
      importLibrary(
        store,
        backup([playlist(), { ...playlist(), game: { mid: "javascript:bad" } }]),
      ),
    ).rejects.toThrow("invalid");
    expect(await store.playlists()).toEqual([]);
    await expect(importLibrary(store, '{"version":2}')).rejects.toThrow("supported");
    await expect(
      importLibrary(
        store,
        backup([{ ...playlist(), thumbnail: { type: "text/html", base64: "eA==" } }]),
      ),
    ).rejects.toThrow("PNG");
  });

  it("excludes injected secrets and pending operations", async () => {
    const store = database();

    await importLibrary(
      store,
      backup([{ ...playlist(), accessToken: "secret", pendingOperation: { id: "bad" } }]),
    );
    const exported = await exportLibrary(store);

    expect(exported).not.toContain("secret");
    expect(exported).not.toContain("pendingOperation");
    expect(await store.operations(channelId)).toEqual([]);
  });

  it("keeps existing records when tabs import concurrently", async () => {
    const name = crypto.randomUUID();
    const first = createLibraryStore(name);
    const second = createLibraryStore(name);

    const counts = await Promise.all([
      importLibrary(first, backup([playlist({ seriesName: "First" })])),
      importLibrary(second, backup([playlist({ seriesName: "Second" })])),
    ]);

    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await first.playlists()).toHaveLength(1);
  });
});
