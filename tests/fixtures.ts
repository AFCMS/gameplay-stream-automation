import type { BroadcastDraft, ManagedPlaylist } from "../src/domain/types";

export const channelId = `UC${"a".repeat(22)}`;
export const secondChannelId = `UC${"b".repeat(22)}`;
export const videoId = "video000001";
export const game = {
  mid: "/m/010xfc7q",
  title: "Halo: The Master Chief Collection",
  year: "2014",
};

export function playlist(overrides: Partial<ManagedPlaylist> = {}): ManagedPlaylist {
  return {
    channelId,
    playlistId: "PL1234567890",
    name: "Halo 4 - Gameplay",
    seriesName: "Halo 4",
    game,
    audioLanguage: "en",
    source: "created",
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

export function draft(overrides: Partial<BroadcastDraft> = {}): BroadcastDraft {
  return {
    title: "Halo 4 - #5",
    episode: 5,
    game,
    audioLanguage: "en",
    madeForKids: false,
    ...overrides,
  };
}
