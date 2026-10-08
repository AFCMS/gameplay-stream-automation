import { isGame, isLanguage, validateThumbnail, type ManagedPlaylist } from "../domain/types";
import type { LibraryStore } from "./database";

interface ExportedPlaylist extends Omit<ManagedPlaylist, "thumbnail"> {
  thumbnail?: { type: string; base64: string };
}

export interface LibraryBackup {
  format: "gameplay-stream-library";
  version: 1;
  playlists: ExportedPlaylist[];
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }

  return btoa(chunks.join(""));
}

function decodeThumbnail(value: unknown): Blob | undefined {
  if (value === undefined) {
    return undefined;
  }

  const thumbnail = value as { type?: unknown; base64?: unknown } | null;

  if (!thumbnail || typeof thumbnail.type !== "string" || typeof thumbnail.base64 !== "string") {
    throw new Error("The backup contains an invalid thumbnail.");
  }

  const binary = atob(thumbnail.base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: thumbnail.type });

  validateThumbnail(blob);
  return blob;
}

function cleanRecord(value: unknown): ManagedPlaylist {
  if (!value || typeof value !== "object") {
    throw new Error("The backup contains an invalid playlist.");
  }

  const record = value as Record<string, unknown>;
  const validText = (text: unknown, max: number): text is string =>
    typeof text === "string" && text.trim().length > 0 && text.length <= max;

  if (
    typeof record.channelId !== "string" ||
    !/^UC[A-Za-z0-9_-]{22}$/.test(record.channelId) ||
    typeof record.playlistId !== "string" ||
    !/^[A-Za-z0-9_-]{10,100}$/.test(record.playlistId) ||
    !validText(record.name, 150) ||
    !validText(record.seriesName, 100) ||
    !isGame(record.game) ||
    !isLanguage(record.audioLanguage) ||
    !["created", "imported"].includes(String(record.source)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    throw new Error("The backup contains invalid playlist metadata.");
  }

  // Pick known fields explicitly. Backup files cannot smuggle tokens or queued operations into storage.
  return {
    channelId: record.channelId,
    playlistId: record.playlistId,
    name: record.name,
    seriesName: record.seriesName,
    game: {
      mid: record.game.mid,
      title: record.game.title,
      ...(record.game.year ? { year: record.game.year } : {}),
    },
    audioLanguage: record.audioLanguage,
    thumbnail: decodeThumbnail(record.thumbnail),
    source: record.source as ManagedPlaylist["source"],
    updatedAt: record.updatedAt,
  };
}

export function parseBackup(text: string): ManagedPlaylist[] {
  const data = JSON.parse(text) as Partial<LibraryBackup> | null;

  if (
    !data ||
    data.format !== "gameplay-stream-library" ||
    data.version !== 1 ||
    !Array.isArray(data.playlists)
  ) {
    throw new Error("Choose a supported Gameplay Stream Automation backup (version 1).");
  }

  const unique = new Map<string, ManagedPlaylist>();

  for (const value of data.playlists) {
    const playlist = cleanRecord(value);
    const key = `${playlist.channelId}/${playlist.playlistId}`;

    if (!unique.has(key)) {
      unique.set(key, playlist);
    }
  }

  return [...unique.values()];
}

export async function exportLibrary(store: LibraryStore): Promise<string> {
  const playlists: ExportedPlaylist[] = [];

  for (const playlist of await store.playlists()) {
    const { thumbnail, ...metadata } = playlist;

    playlists.push({
      ...metadata,
      thumbnail: thumbnail
        ? { type: thumbnail.type, base64: encodeBase64(await thumbnail.arrayBuffer()) }
        : undefined,
    });
  }

  return JSON.stringify(
    { format: "gameplay-stream-library", version: 1, playlists } satisfies LibraryBackup,
    null,
    2,
  );
}

export async function importLibrary(store: LibraryStore, text: string): Promise<number> {
  return store.mergePlaylists(parseBackup(text));
}
