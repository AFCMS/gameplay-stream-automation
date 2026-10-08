export interface Game {
  mid: string;
  title: string;
  year?: string;
}

export interface ManagedPlaylist {
  channelId: string;
  playlistId: string;
  name: string;
  seriesName: string;
  game: Game;
  audioLanguage: string;
  thumbnail?: Blob;
  source: "created" | "imported";
  updatedAt: string;
}

export interface BroadcastDraft {
  title: string;
  episode: number;
  game: Game;
  audioLanguage: string;
  thumbnail?: Blob;
  madeForKids: boolean;
}

export const setupSteps = ["metadata", "thumbnail", "game", "playlist"] as const;
export type SetupStep = (typeof setupSteps)[number];

export interface BroadcastOperation {
  id: string;
  channelId: string;
  playlistId: string;
  playlistName: string;
  createdAt: string;
  draft: BroadcastDraft;
  broadcastId?: string;
  // An interrupted insert must be reconciled; never automatically repeat it.
  status:
    | "prepared"
    | "creating"
    | "uncertain"
    | "setting-up"
    | "failed"
    | "complete"
    | "cancelled";
  completedSteps: SetupStep[];
  error?: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export const broadcastTitle = (series: string, episode: number) => `${series} - #${episode}`;

export const publicUrl = (id: string) =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

export function studioUrl(id?: string): string {
  return id
    ? `https://studio.youtube.com/video/${encodeURIComponent(id)}/livestreaming`
    : "https://studio.youtube.com/";
}

export function parsePlaylistId(input: string): string {
  const value = input.trim();
  let id = value;

  if (value.includes("://")) {
    const url = new URL(value);

    if (!["www.youtube.com", "youtube.com", "m.youtube.com"].includes(url.hostname)) {
      throw new Error("Enter a YouTube playlist URL or playlist ID.");
    }
    id = url.searchParams.get("list") ?? "";
  }

  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) {
    throw new Error("Enter a valid playlist ID.");
  }

  return id;
}

export function validateThumbnail(blob: Blob): void {
  if (
    !["image/jpeg", "image/png"].includes(blob.type) ||
    !blob.size ||
    blob.size > 50 * 1024 * 1024
  ) {
    throw new Error("Choose a PNG or JPEG image up to 50 MB.");
  }
}

export function validateDraft(draft: BroadcastDraft): void {
  if (!draft.title.trim() || draft.title.length > 100 || /[<>]/.test(draft.title)) {
    throw new Error("Use a title of 1–100 characters without < or >.");
  }

  if (!Number.isSafeInteger(draft.episode) || draft.episode < 1) {
    throw new Error("Enter a positive episode number.");
  }

  if (!isGame(draft.game)) {
    throw new Error("Select a game from YouTube’s catalog.");
  }

  if (!isLanguage(draft.audioLanguage)) {
    throw new Error("Enter a valid audio language code, such as en or fr.");
  }

  if (draft.thumbnail) {
    validateThumbnail(draft.thumbnail);
  }
}

export function isGame(value: unknown): value is Game {
  if (!value || typeof value !== "object") {
    return false;
  }

  const game = value as Partial<Game>;

  return (
    typeof game.mid === "string" &&
    /^\/(?:m|g)\/[a-zA-Z0-9_-]{1,100}$/.test(game.mid) &&
    typeof game.title === "string" &&
    game.title.trim().length > 0 &&
    game.title.length <= 300 &&
    (game.year === undefined || (typeof game.year === "string" && /^\d{4}$/.test(game.year)))
  );
}

export function isLanguage(value: unknown): value is string {
  if (typeof value !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) {
    return false;
  }

  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}
