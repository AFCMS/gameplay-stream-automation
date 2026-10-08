import { describe, expect, it, vi } from "vitest";

import { YouTubeClient } from "../src/services/youtube";
import { channelId, draft, videoId } from "./fixtures";

function response(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("YouTube API", () => {
  it("preserves the browser receiver when calling fetch from the client", async () => {
    const fetcher = vi.fn<typeof fetch>(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }

      return response({ items: [{ id: channelId, snippet: { title: "Test channel" } }] });
    });
    const api = new YouTubeClient(() => "test-token", fetcher);

    await expect(api.channels()).resolves.toEqual([
      { id: channelId, title: "Test channel", thumbnailUrl: null },
    ]);
  });

  it("counts available entries across pages, including repeats, live and private videos", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());

      if (url.pathname.endsWith("playlistItems")) {
        return response(
          url.searchParams.has("pageToken")
            ? {
                items: ["private", "missing"].map((videoId) => ({
                  snippet: { resourceId: { videoId } },
                })),
              }
            : {
                nextPageToken: "page2",
                items: ["live", "public", "public"].map((videoId) => ({
                  snippet: { resourceId: { videoId } },
                })),
              },
        );
      }

      return response({ items: ["live", "public", "private"].map((id) => ({ id })) });
    });
    const api = new YouTubeClient(() => "test-token", fetcher);

    expect(await api.availableCount("PL1234567890")).toBe(4);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("discovers owned playlists without filtering names", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      response({
        items: [
          { id: "PL1", snippet: { title: "A manually named series", channelId } },
          { id: "PL2", snippet: { title: "Other owner", channelId: "other" } },
        ],
      }),
    );
    const api = new YouTubeClient(() => "test-token", fetcher);

    expect((await api.ownedPlaylists(channelId)).map((item) => item.id)).toEqual(["PL1"]);
  });

  it("preserves metadata while setting Gaming and audio language", async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) =>
      init?.method === "PUT"
        ? response({})
        : response({
            items: [
              {
                id: videoId,
                snippet: {
                  channelId,
                  title: "Existing title",
                  description: "Keep me",
                  tags: ["tag"],
                  defaultLanguage: "fr",
                  categoryId: "22",
                },
                status: { privacyStatus: "public" },
              },
            ],
          }),
    );
    const api = new YouTubeClient(() => "test-token", fetcher);

    await api.applyMetadata(videoId, channelId, draft());
    const update = JSON.parse(fetcher.mock.calls[1][1]?.body as string);

    expect(update.snippet).toEqual({
      title: "Existing title",
      description: "Keep me",
      tags: ["tag"],
      defaultLanguage: "fr",
      categoryId: "20",
      defaultAudioLanguage: "en",
    });
  });

  it("appends without reordering, and avoids duplicate insertion", async () => {
    const entries = ["older", "newer"].map((id, position) => ({
      id,
      snippet: { position, resourceId: { videoId: id } },
    }));
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      if (init?.method === "POST") {
        return response({ id: "inserted" });
      }

      return response({
        items: (input instanceof Request ? input.url : input.toString()).includes("/playlists?")
          ? [{ id: "PL1234567890", snippet: { channelId, title: "Playlist" } }]
          : entries,
      });
    });
    const api = new YouTubeClient(() => "test-token", fetcher);

    await api.appendToPlaylist("PL1234567890", channelId, videoId);
    expect(JSON.parse(fetcher.mock.calls[2][1]?.body as string).snippet.position).toBe(2);

    fetcher.mockClear();
    await api.appendToPlaylist("PL1234567890", channelId, "older");
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it.each([true, false])(
    "preserves automatic sorting only when permitted for an imported playlist (%s)",
    async (preserveAutomaticOrder) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(() =>
          response({
            items: [{ id: "PL1234567890", snippet: { channelId, title: "Playlist" } }],
          }),
        )
        .mockImplementationOnce(() => response({ items: [] }))
        .mockImplementationOnce(() =>
          response(
            {
              error: {
                message: "Manual sorting required",
                errors: [{ reason: "manualSortRequired" }],
              },
            },
            400,
          ),
        )
        .mockImplementationOnce(() => response({ id: "inserted" }));
      const api = new YouTubeClient(() => "test-token", fetcher);

      const result = await api
        .appendToPlaylist("PL1234567890", channelId, videoId, {
          preserveAutomaticOrder,
        })
        .then(
          () => "inserted",
          () => "rejected",
        );

      expect(result).toBe(preserveAutomaticOrder ? "inserted" : "rejected");
      expect(fetcher).toHaveBeenCalledTimes(preserveAutomaticOrder ? 4 : 3);
      expect(
        fetcher.mock.calls.slice(3).map(([, init]) => JSON.parse(init?.body as string)),
      ).toEqual(
        preserveAutomaticOrder
          ? [
              {
                snippet: {
                  playlistId: "PL1234567890",
                  resourceId: { kind: "youtube#video", videoId },
                },
              },
            ]
          : [],
      );
    },
  );

  it("creates an unbound public event with immediate OBS start and automatic stop", async () => {
    const now = Date.now();
    const fetcher = vi.fn<typeof fetch>(() => response({ id: videoId }));
    const api = new YouTubeClient(() => "test-token", fetcher);

    await api.createBroadcast(draft());
    const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string);

    expect(body.status).toEqual({ privacyStatus: "public", selfDeclaredMadeForKids: false });
    expect(body.contentDetails).toEqual({
      enableAutoStart: true,
      enableAutoStop: true,
      monitorStream: { enableMonitorStream: false },
    });
    expect(Date.parse(body.snippet.scheduledStartTime) - now).toBeGreaterThanOrEqual(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops on an account mismatch before modifying metadata", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      response({ items: [{ id: videoId, snippet: { channelId: "other" } }] }),
    );
    const api = new YouTubeClient(() => "test-token", fetcher);

    await expect(api.applyMetadata(videoId, channelId, draft())).rejects.toThrow("channel");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
