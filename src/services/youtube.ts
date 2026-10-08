import type { BroadcastDraft, BroadcastOperation } from "../domain/types";

const API_ROOT = "https://www.googleapis.com/youtube/v3/";

interface Page<T> {
  items?: T[];
  nextPageToken?: string;
}

export interface YouTubePlaylist {
  id: string;
  snippet: { title: string; channelId: string; publishedAt?: string };
  status?: { privacyStatus: string };
}

export interface PlaylistEntry {
  id: string;
  snippet: { position: number; resourceId: { videoId: string } };
  contentDetails?: { videoId: string };
}

export interface YouTubeVideo {
  id: string;
  snippet: {
    channelId: string;
    title: string;
    categoryId: string;
    description?: string;
    tags?: string[];
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  status?: { privacyStatus: string; uploadStatus?: string };
}

export interface YouTubeBroadcast {
  id: string;
  snippet: { channelId: string; title: string; publishedAt: string; scheduledStartTime: string };
  status?: { privacyStatus: string; lifeCycleStatus: string };
}

export class YouTubeError extends Error {
  status: number;
  reason?: string;

  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.name = "YouTubeError";
    this.status = status;
    this.reason = reason;
  }
}

export class YouTubeClient {
  private getToken: () => string | Promise<string>;
  private fetcher: typeof fetch;

  constructor(getToken: () => string | Promise<string>, fetcher: typeof fetch = fetch) {
    this.getToken = getToken;
    // Browser fetch requires Window as its receiver, even when stored on a client instance.
    this.fetcher = fetcher.bind(globalThis);
  }

  private async request<T>(
    path: string,
    params: Record<string, string>,
    init: RequestInit = {},
  ): Promise<T> {
    const url = new URL(path, API_ROOT);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.getToken()}`);

    if (typeof init.body === "string") {
      headers.set("Content-Type", "application/json");
    }

    const response = await this.fetcher(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const reason = data.error?.errors?.[0]?.reason as string | undefined;
      const message =
        response.status === 401
          ? "Your Google connection expired. Reconnect to continue."
          : (data.error?.message ?? `YouTube request failed (${response.status}).`);

      throw new YouTubeError(response.status, message, reason);
    }

    return response.json() as Promise<T>;
  }

  private async allPages<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;

    do {
      const page: Page<T> = await this.request(path, {
        ...params,
        maxResults: "50",
        ...(pageToken ? { pageToken } : {}),
      });

      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken;

      if (pageToken && seen.has(pageToken)) {
        throw new Error("YouTube returned a repeated page. Refresh and retry.");
      }

      if (pageToken) {
        seen.add(pageToken);
      }
    } while (pageToken);

    return items;
  }

  async channels(): Promise<{ id: string; title: string; thumbnailUrl: string | null }[]> {
    const response = await this.request<
      Page<{
        id: string;
        snippet: { title: string; thumbnails?: { default?: { url: string } } };
      }>
    >("channels", { part: "snippet", mine: "true" });

    return (response.items ?? []).map((channel) => ({
      id: channel.id,
      title: channel.snippet.title,
      thumbnailUrl: channel.snippet.thumbnails?.default?.url ?? null,
    }));
  }

  async ownedPlaylists(channelId: string): Promise<YouTubePlaylist[]> {
    const playlists = await this.allPages<YouTubePlaylist>("playlists", {
      part: "snippet,status",
      mine: "true",
    });

    return playlists.filter((playlist) => playlist.snippet.channelId === channelId);
  }

  async ownedPlaylist(id: string, channelId: string): Promise<YouTubePlaylist> {
    const response = await this.request<Page<YouTubePlaylist>>("playlists", {
      part: "snippet,status",
      id,
    });
    const playlist = response.items?.[0];

    if (!playlist || playlist.snippet.channelId !== channelId) {
      throw new Error("This playlist is unavailable or belongs to a different channel.");
    }

    return playlist;
  }

  async createPlaylist(title: string): Promise<YouTubePlaylist> {
    return this.request(
      "playlists",
      { part: "snippet,status" },
      {
        method: "POST",
        body: JSON.stringify({ snippet: { title }, status: { privacyStatus: "public" } }),
      },
    );
  }

  playlistEntries(playlistId: string): Promise<PlaylistEntry[]> {
    return this.allPages("playlistItems", { part: "snippet,contentDetails", playlistId });
  }

  async videos(ids: string[]): Promise<YouTubeVideo[]> {
    const unique = [...new Set(ids)];
    const result: YouTubeVideo[] = [];

    for (let offset = 0; offset < unique.length; offset += 50) {
      const response = await this.request<Page<YouTubeVideo>>("videos", {
        part: "snippet,status",
        id: unique.slice(offset, offset + 50).join(","),
      });

      result.push(...(response.items ?? []));
    }

    return result;
  }

  async availableCount(playlistId: string): Promise<number> {
    const entries = await this.playlistEntries(playlistId);
    const ids = entries.map((entry) => entry.snippet.resourceId.videoId);
    const videos = await this.videos(ids);
    const available = new Set(
      videos.filter((video) => video.status?.uploadStatus !== "deleted").map((video) => video.id),
    );

    return ids.filter((id) => available.has(id)).length;
  }

  async createBroadcast(draft: BroadcastDraft): Promise<YouTubeBroadcast> {
    return this.request(
      "liveBroadcasts",
      { part: "snippet,status,contentDetails" },
      {
        method: "POST",
        body: JSON.stringify({
          snippet: {
            title: draft.title.trim(),
            scheduledStartTime: new Date(Date.now() + 60_000).toISOString(),
          },
          status: {
            privacyStatus: "public",
            selfDeclaredMadeForKids: draft.madeForKids,
          },
          contentDetails: {
            enableAutoStart: true,
            enableAutoStop: true,
            monitorStream: { enableMonitorStream: false },
          },
        }),
      },
    );
  }

  async reconcileBroadcasts(operation: BroadcastOperation): Promise<YouTubeBroadcast[]> {
    const broadcasts = await this.allPages<YouTubeBroadcast>("liveBroadcasts", {
      part: "snippet,status",
      broadcastStatus: "all",
      broadcastType: "all",
    });

    const createdAt = Date.parse(operation.createdAt);

    return broadcasts.filter(
      (broadcast) =>
        broadcast.snippet.channelId === operation.channelId &&
        broadcast.snippet.title === operation.draft.title.trim() &&
        Math.abs(Date.parse(broadcast.snippet.publishedAt) - createdAt) < 10 * 60_000,
    );
  }

  async verifyPublicVideo(videoId: string, channelId: string): Promise<YouTubeVideo> {
    const video = (await this.videos([videoId]))[0];

    if (!video || video.id !== videoId || video.snippet.channelId !== channelId) {
      throw new Error(
        "The broadcast is not available on this channel yet. Wait a moment and retry setup.",
      );
    }

    if (video.status?.privacyStatus !== "public") {
      throw new Error(
        "YouTube did not make this broadcast public. Review its visibility in Studio before retrying.",
      );
    }

    return video;
  }

  async applyMetadata(videoId: string, channelId: string, draft: BroadcastDraft): Promise<void> {
    const video = await this.verifyPublicVideo(videoId, channelId);
    const { title, description, tags, defaultLanguage } = video.snippet;

    await this.request(
      "videos",
      { part: "snippet" },
      {
        method: "PUT",
        body: JSON.stringify({
          id: videoId,
          snippet: {
            title,
            description,
            tags,
            defaultLanguage,
            categoryId: "20",
            defaultAudioLanguage: draft.audioLanguage,
          },
        }),
      },
    );
  }

  async uploadThumbnail(videoId: string, thumbnail: Blob): Promise<void> {
    await this.request(
      "https://www.googleapis.com/upload/youtube/v3/thumbnails/set",
      {
        videoId,
        uploadType: "media",
      },
      {
        method: "POST",
        headers: { "Content-Type": thumbnail.type },
        body: thumbnail,
      },
    );
  }

  async appendToPlaylist(
    playlistId: string,
    channelId: string,
    videoId: string,
    options: { preserveAutomaticOrder?: boolean } = {},
  ): Promise<void> {
    await this.ownedPlaylist(playlistId, channelId);
    const entries = await this.playlistEntries(playlistId);

    if (entries.some((entry) => entry.snippet.resourceId.videoId === videoId)) {
      return;
    }

    const insert = (position?: number) =>
      this.request(
        "playlistItems",
        { part: "snippet" },
        {
          method: "POST",
          body: JSON.stringify({
            snippet: {
              playlistId,
              position,
              resourceId: { kind: "youtube#video", videoId },
            },
          }),
        },
      );

    try {
      await insert(entries.length);
    } catch (error) {
      if (
        !(error instanceof YouTubeError) ||
        error.reason !== "manualSortRequired" ||
        !options.preserveAutomaticOrder
      ) {
        throw error;
      }

      // Imported playlists keep their own ordering rule; do not change their sort settings.
      await insert();
    }
  }
}
