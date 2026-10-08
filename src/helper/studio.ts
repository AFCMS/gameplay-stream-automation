import { isGame, type Game } from "../domain/types";
import { HelperError } from "./protocol";

export const STUDIO_ORIGIN = "https://studio.youtube.com";
export type JsonObject = Record<string, unknown>;

export interface StudioConfig {
  CHANNEL_ID?: string;
  SESSION_INDEX?: string | number;
  INNERTUBE_CONTEXT?: JsonObject;
  INNERTUBE_CONTEXT_CLIENT_VERSION?: string;
  INNERTUBE_CLIENT_VERSION?: string;
  INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT?: string;
  DELEGATION_CONTEXT?: JsonObject;
}

export type StudioTransport = (path: string, body: JsonObject) => Promise<JsonObject>;

function jsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const character = text[index];

    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === "{") {
      depth++;
    } else if (character === "}") {
      depth--;

      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return -1;
}

// Parse JSON only: never execute script text fetched from Studio.
export function parseStudioConfig(html: string): StudioConfig {
  const config: StudioConfig = {};
  const marker = /ytcfg\.set\s*\(\s*\{/g;

  for (const match of html.matchAll(marker)) {
    const start = match.index + match[0].lastIndexOf("{");
    const end = jsonObjectEnd(html, start);

    if (end < 0) {
      continue;
    }

    try {
      Object.assign(config, JSON.parse(html.slice(start, end)));
    } catch {
      // A non-JSON config call cannot supply authentication context.
    }
  }

  if (!config.CHANNEL_ID || !config.INNERTUBE_CONTEXT) {
    throw new HelperError(
      "STUDIO_REQUIRED",
      "Sign in to YouTube Studio, select the same channel, then retry.",
    );
  }

  return config;
}

export function verifyStudioChannel(config: StudioConfig, expected: string): void {
  if (config.CHANNEL_ID !== expected) {
    throw new HelperError(
      "CHANNEL_MISMATCH",
      "YouTube Studio is using a different channel. Switch Studio to the channel connected in this app, then retry.",
    );
  }
}

export function studioContext(config: StudioConfig): JsonObject {
  const context = JSON.parse(JSON.stringify(config.INNERTUBE_CONTEXT ?? {})) as JsonObject;
  const user = (context.user ?? {}) as JsonObject;

  if (config.INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT) {
    user.serializedDelegationContext = config.INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT;
  }

  if (config.DELEGATION_CONTEXT) {
    user.delegationContext = config.DELEGATION_CONTEXT;
  }

  return { ...context, user };
}

export function parseGames(response: JsonObject): Game[] {
  if (!Array.isArray(response.gameTitles) || !response.gameTitles.every(isGame)) {
    throw new HelperError(
      "STUDIO_CHANGED",
      "Studio’s game catalog response changed. Update the helper before continuing.",
    );
  }

  return response.gameTitles.map(({ mid, title, year }: Game) => ({
    mid,
    title,
    ...(year ? { year } : {}),
  }));
}

export interface CreatorVideo {
  videoId: string;
  channelId: string;
  gameTitle?: Game;
}

export function parseCreatorVideo(
  response: JsonObject,
  videoId: string,
  channelId: string,
): CreatorVideo {
  if (!Array.isArray(response.videos)) {
    throw new HelperError(
      "STUDIO_CHANGED",
      "Studio’s video response changed. Update the helper before continuing.",
    );
  }

  const video = response.videos.find((value: JsonObject) => value.videoId === videoId) as
    | CreatorVideo
    | undefined;

  if (!video || video.channelId !== channelId) {
    throw new HelperError(
      "CHANNEL_MISMATCH",
      "Studio could not verify that this video belongs to your connected channel.",
    );
  }

  return video;
}

export async function readVideo(
  api: StudioTransport,
  videoId: string,
  channelId: string,
): Promise<CreatorVideo> {
  const response = await api("creator/get_creator_videos", {
    videoIds: [videoId],
    mask: { videoId: true, channelId: true, gameTitle: { all: true } },
    failOnError: true,
  });

  return parseCreatorVideo(response, videoId, channelId);
}

export async function assignGame(
  api: StudioTransport,
  videoId: string,
  channelId: string,
  game: Game,
): Promise<Game> {
  const video = await readVideo(api, videoId, channelId);

  if (video.gameTitle?.mid === game.mid) {
    return game;
  }

  const body = {
    encryptedVideoId: videoId,
    gameTitle: { newKgEntityId: game.mid },
    videoReadMask: { videoId: true, channelId: true, gameTitle: { all: true } },
  };

  const response = await api("video_manager/metadata_update", body);
  const overallResult = response.overallResult as JsonObject | undefined;
  const gameTitle = response.gameTitle as JsonObject | undefined;

  if (overallResult?.resultCode !== "UPDATE_SUCCESS" || gameTitle?.success !== true) {
    throw new HelperError(
      "STUDIO_REQUIRED",
      "Studio did not confirm the game update. Retry with Studio open.",
    );
  }

  // Studio can acknowledge a write before its read endpoint exposes the new game.
  for (const milliseconds of [0, 250, 750, 1500]) {
    if (milliseconds > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    }

    const updated = await readVideo(api, videoId, channelId);

    if (updated.gameTitle?.mid === game.mid) {
      return game;
    }
  }

  throw new HelperError("STUDIO_REQUIRED", "Game update was not confirmed. Retry setup.");
}
