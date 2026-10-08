import type { Game } from "../domain/types";
import {
  HelperError,
  PROTOCOL,
  validResult,
  type HelperCommand,
  type HelperRequest,
  type HelperResponse,
  type HelperStatus,
} from "../helper/protocol";

function request<T>(command: HelperCommand): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as Partial<HelperResponse> | null;

      if (!data || data.protocol !== PROTOCOL || data.direction !== "response" || data.id !== id) {
        return;
      }

      cleanup();

      if (data.error && typeof data.error.message === "string") {
        reject(new HelperError(data.error.code, data.error.message));
      } else if (!validResult(command, data.result)) {
        reject(
          new HelperError(
            "PROTOCOL",
            "The helper returned an unexpected response. Update the helper and retry.",
          ),
        );
      } else {
        resolve(data.result as T);
      }
    };

    const timer = setTimeout(
      () => {
        cleanup();
        reject(
          new HelperError("UNAVAILABLE", "Helper unavailable. Enable it and reload this page."),
        );
      },
      command.kind === "setVideoGame" ? 160_000 : 60_000,
    );

    window.addEventListener("message", onMessage);
    window.postMessage(
      { protocol: PROTOCOL, direction: "request", id, command } satisfies HelperRequest,
      window.location.origin,
    );
  });
}

export interface GameHelper {
  status(channelId: string): Promise<HelperStatus>;
  searchGames(channelId: string, query: string): Promise<Game[]>;
  getVideoGame(channelId: string, videoId: string): Promise<Game | null>;
  setVideoGame(channelId: string, videoId: string, game: Game): Promise<Game>;
}

export const gameHelper: GameHelper = {
  status: (channelId) => request({ kind: "status", channelId }),
  searchGames: (channelId, query) => request({ kind: "searchGames", channelId, query }),
  getVideoGame: (channelId, videoId) => request({ kind: "getVideoGame", channelId, videoId }),
  setVideoGame: (channelId, videoId, game) =>
    request({ kind: "setVideoGame", channelId, videoId, game }),
};
