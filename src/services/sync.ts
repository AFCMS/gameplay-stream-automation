import type { LibraryStore } from "../storage/database";
import type { YouTubeClient } from "./youtube";

type SyncApi = Pick<YouTubeClient, "ownedPlaylists" | "videos">;

export async function syncLibrary(
  channelId: string,
  api: SyncApi,
  store: LibraryStore,
): Promise<void> {
  const [playlists, operations, remotePlaylists] = await Promise.all([
    store.playlists(channelId),
    store.operations(channelId),
    api.ownedPlaylists(channelId),
  ]);
  const owned = new Map(remotePlaylists.map((playlist) => [playlist.id, playlist]));
  const removedPlaylistIds = playlists
    .filter((playlist) => !owned.has(playlist.playlistId))
    .map((playlist) => playlist.playlistId);
  const broadcastIds = operations.flatMap((operation) =>
    operation.broadcastId ? [operation.broadcastId] : [],
  );
  const videos = await api.videos(broadcastIds);

  if (videos.some((video) => video.snippet.channelId !== channelId)) {
    throw new Error("YouTube returned a video from another channel. Refresh was cancelled.");
  }

  const available = new Set(
    videos.filter((video) => video.status?.uploadStatus !== "deleted").map((video) => video.id),
  );
  const removedOperationIds = operations
    .filter((operation) => operation.broadcastId && !available.has(operation.broadcastId))
    .map((operation) => operation.id);

  // Commit only after every remote read succeeds. Errors cannot masquerade as deletions.
  await store.applySync(channelId, {
    playlists: playlists.flatMap((playlist) => {
      const remote = owned.get(playlist.playlistId);

      return remote ? [{ playlistId: playlist.playlistId, name: remote.snippet.title }] : [];
    }),
    removedPlaylistIds,
    removedOperationIds,
  });
}
