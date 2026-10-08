import type { BroadcastOperation, ManagedPlaylist } from "../domain/types";

const DATABASE_NAME = "gameplay-stream-automation";
const DATABASE_VERSION = 1;

export interface LibrarySyncChanges {
  playlists: { playlistId: string; name: string }[];
  removedPlaylistIds: string[];
  removedOperationIds: string[];
}

export interface LibraryStore {
  playlists(channelId?: string): Promise<ManagedPlaylist[]>;
  putPlaylist(playlist: ManagedPlaylist): Promise<void>;
  mergePlaylists(playlists: ManagedPlaylist[]): Promise<number>;
  operations(channelId: string): Promise<BroadcastOperation[]>;
  putOperation(operation: BroadcastOperation): Promise<void>;
  getOperation(id: string): Promise<BroadcastOperation | undefined>;
  applySync(channelId: string, changes: LibrarySyncChanges): Promise<void>;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Database transaction aborted."));
    transaction.onerror = () => reject(transaction.error);
  });
}

export function createLibraryStore(name = DATABASE_NAME): LibraryStore {
  let connection: Promise<IDBDatabase> | undefined;

  function open(): Promise<IDBDatabase> {
    connection ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        const playlists = db.createObjectStore("playlists", {
          keyPath: ["channelId", "playlistId"],
        });
        const operations = db.createObjectStore("operations", { keyPath: "id" });

        playlists.createIndex("channelId", "channelId");
        operations.createIndex("channelId", "channelId");
      };

      request.onsuccess = () => {
        const db = request.result;

        db.onversionchange = () => {
          db.close();
          connection = undefined;
        };

        resolve(db);
      };

      request.onerror = () => {
        connection = undefined;
        reject(new Error("Browser storage is unavailable. Enable site storage and reload."));
      };

      request.onblocked = () => {
        connection = undefined;
        reject(new Error("Close other app tabs so the local database can be updated."));
      };
    });

    return connection;
  }

  async function readAll<T>(storeName: string, channelId?: string): Promise<T[]> {
    const db = await open();
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = channelId ? store.index("channelId").getAll(channelId) : store.getAll();

    return requestResult(request);
  }

  async function put(storeName: string, value: unknown): Promise<void> {
    const db = await open();
    const transaction = db.transaction(storeName, "readwrite");
    const done = transactionDone(transaction);

    transaction.objectStore(storeName).put(value);
    await done;
  }

  return {
    playlists: (channelId) => readAll<ManagedPlaylist>("playlists", channelId),
    putPlaylist: (playlist) => put("playlists", playlist),
    operations: (channelId) => readAll<BroadcastOperation>("operations", channelId),
    putOperation: (operation) => put("operations", operation),

    async getOperation(id) {
      const db = await open();
      const store = db.transaction("operations", "readonly").objectStore("operations");

      return requestResult(store.get(id));
    },

    async mergePlaylists(playlists) {
      const db = await open();
      const transaction = db.transaction("playlists", "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore("playlists");
      let added = 0;

      // Queue reads inside one transaction so simultaneous imports cannot overwrite local records.
      for (const playlist of playlists) {
        const request = store.get([playlist.channelId, playlist.playlistId]);

        request.onsuccess = () => {
          if (!request.result) {
            store.put(playlist);
            added++;
          }
        };
      }

      await done;
      return added;
    },

    async applySync(channelId, changes) {
      const db = await open();
      const transaction = db.transaction(["playlists", "operations"], "readwrite");
      const done = transactionDone(transaction);
      const playlists = transaction.objectStore("playlists");
      const operations = transaction.objectStore("operations");
      const removedPlaylists = new Set(changes.removedPlaylistIds);
      const removedOperations = new Set(changes.removedOperationIds);

      for (const playlistId of removedPlaylists) {
        playlists.delete([channelId, playlistId]);
      }

      for (const update of changes.playlists) {
        const request = playlists.get([channelId, update.playlistId]);

        request.onsuccess = () => {
          const current = request.result as ManagedPlaylist | undefined;

          if (current && current.name !== update.name) {
            playlists.put({ ...current, name: update.name, updatedAt: new Date().toISOString() });
          }
        };
      }

      const cursor = operations.index("channelId").openCursor(channelId);

      cursor.onsuccess = () => {
        const current = cursor.result;

        if (!current) {
          return;
        }

        const operation = current.value as BroadcastOperation;

        if (removedPlaylists.has(operation.playlistId) || removedOperations.has(operation.id)) {
          current.delete();
        }

        current.continue();
      };

      await done;
    },
  };
}

export const libraryStore = createLibraryStore();
