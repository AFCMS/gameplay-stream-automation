import {
  errorMessage,
  setupSteps,
  validateDraft,
  type BroadcastDraft,
  type BroadcastOperation,
  type ManagedPlaylist,
  type SetupStep,
} from "../domain/types";
import type { LibraryStore } from "../storage/database";
import type { GameHelper } from "./helper";
import { YouTubeError, type YouTubeClient } from "./youtube";

type BroadcastApi = Pick<
  YouTubeClient,
  | "createBroadcast"
  | "applyMetadata"
  | "uploadThumbnail"
  | "appendToPlaylist"
  | "ownedPlaylist"
  | "verifyPublicVideo"
  | "reconcileBroadcasts"
>;

export interface BroadcastDependencies {
  api: BroadcastApi;
  helper: GameHelper;
  store: LibraryStore;
  onProgress?: (operation: BroadcastOperation) => void;
}

export const isUnfinished = (operation: BroadcastOperation) =>
  operation.status !== "complete" && operation.status !== "cancelled";

// Chromium's Web Locks serialize writes across tabs, not just repeated clicks in one component.
export async function withChannelLock<T>(channelId: string, action: () => Promise<T>): Promise<T> {
  return navigator.locks.request(`gsa:write:${channelId}`, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      throw new Error("Another app tab is updating this channel. Wait for it to finish.");
    }

    return action();
  });
}

export function createBroadcastService({ api, helper, store, onProgress }: BroadcastDependencies) {
  async function persist(operation: BroadcastOperation): Promise<void> {
    onProgress?.({ ...operation });
    await store.putOperation(operation);
  }

  async function preflight(channelId: string, playlistId: string): Promise<void> {
    await Promise.all([api.ownedPlaylist(playlistId, channelId), helper.status(channelId)]);
  }

  async function runSetup(operation: BroadcastOperation): Promise<BroadcastOperation> {
    const broadcastId = operation.broadcastId;

    if (!broadcastId) {
      throw new Error("Reconcile this broadcast before retrying setup.");
    }

    operation = { ...operation, status: "setting-up", error: undefined };
    await persist(operation);

    try {
      await preflight(operation.channelId, operation.playlistId);
      await api.verifyPublicVideo(broadcastId, operation.channelId);

      const actions: Record<SetupStep, () => Promise<unknown>> = {
        metadata: () => api.applyMetadata(broadcastId, operation.channelId, operation.draft),
        thumbnail: () =>
          operation.draft.thumbnail
            ? api.uploadThumbnail(broadcastId, operation.draft.thumbnail)
            : Promise.resolve(),
        game: () => helper.setVideoGame(operation.channelId, broadcastId, operation.draft.game),
        playlist: async () => {
          const playlists = await store.playlists(operation.channelId);
          const playlist = playlists.find((item) => item.playlistId === operation.playlistId);

          await api.appendToPlaylist(operation.playlistId, operation.channelId, broadcastId, {
            preserveAutomaticOrder: playlist?.source === "imported",
          });
        },
      };

      for (const step of setupSteps) {
        if (operation.completedSteps.includes(step)) {
          continue;
        }

        await actions[step]();
        operation = { ...operation, completedSteps: [...operation.completedSteps, step] };
        await persist(operation);
      }

      operation = { ...operation, status: "complete", error: undefined };
    } catch (error) {
      operation = { ...operation, status: "failed", error: errorMessage(error) };
    }

    await persist(operation);
    return operation;
  }

  return {
    preflight,

    async create(playlist: ManagedPlaylist, draft: BroadcastDraft): Promise<BroadcastOperation> {
      validateDraft(draft);

      const existing = await store.operations(playlist.channelId);

      if (
        existing.some(
          (operation) => operation.playlistId === playlist.playlistId && isUnfinished(operation),
        )
      ) {
        throw new Error(
          "Finish or reconcile this playlist’s previous broadcast before creating another.",
        );
      }

      await preflight(playlist.channelId, playlist.playlistId);

      let operation: BroadcastOperation = {
        id: crypto.randomUUID(),
        channelId: playlist.channelId,
        playlistId: playlist.playlistId,
        playlistName: playlist.name,
        createdAt: new Date().toISOString(),
        draft,
        status: "creating",
        completedSteps: [],
      };

      await persist(operation);

      try {
        const broadcast = await api.createBroadcast(draft);

        if (!broadcast.id) {
          throw new Error(
            "YouTube did not return the broadcast ID. Reconcile before creating another.",
          );
        }

        operation = { ...operation, broadcastId: broadcast.id, status: "setting-up" };
        await persist(operation);
      } catch (error) {
        const rejected =
          error instanceof YouTubeError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408;

        operation = {
          ...operation,
          status: operation.broadcastId ? "failed" : rejected ? "cancelled" : "uncertain",
          error: errorMessage(error),
        };

        await persist(operation);
        return operation;
      }

      return runSetup(operation);
    },

    async resume(operationId: string): Promise<BroadcastOperation> {
      const operation = await store.getOperation(operationId);

      if (!operation) {
        throw new Error("This saved operation is no longer available.");
      }

      return runSetup(operation);
    },

    async reconcile(operation: BroadcastOperation) {
      return api.reconcileBroadcasts(operation);
    },

    async adopt(operation: BroadcastOperation, broadcastId: string): Promise<BroadcastOperation> {
      const candidates = await api.reconcileBroadcasts(operation);

      if (!candidates.some((candidate) => candidate.id === broadcastId)) {
        throw new Error("That broadcast no longer matches this operation. Reconcile again.");
      }

      const recovered = { ...operation, broadcastId, status: "setting-up" as const };
      await persist(recovered);

      return runSetup(recovered);
    },

    async confirmNotCreated(operation: BroadcastOperation): Promise<void> {
      const candidates = await api.reconcileBroadcasts(operation);

      if (candidates.length || Date.now() - Date.parse(operation.createdAt) < 120_000) {
        throw new Error(
          "A matching broadcast exists or YouTube may still be processing it. Wait two minutes and reconcile again.",
        );
      }

      await persist({
        ...operation,
        status: "cancelled",
        error: "Confirmed in Studio that no broadcast was created.",
      });
    },
  };
}
