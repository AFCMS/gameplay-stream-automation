import { isGame, type Game } from "../domain/types";
import { HELPER_VERSION } from "./version";

export const PROTOCOL = "gameplay-stream-helper/v1";
export { HELPER_VERSION } from "./version";

export type HelperCommand =
  | { kind: "status"; channelId: string }
  | { kind: "searchGames"; channelId: string; query: string }
  | { kind: "getVideoGame"; channelId: string; videoId: string }
  | { kind: "setVideoGame"; channelId: string; videoId: string; game: Game };

export interface HelperRequest {
  protocol: typeof PROTOCOL;
  direction: "request";
  id: string;
  command: HelperCommand;
}

export interface HelperStatus {
  version: string;
  channelId: string;
  transport: "background" | "studio";
}

export interface HelperResponse {
  protocol: typeof PROTOCOL;
  direction: "response";
  id: string;
  result?: HelperStatus | Game[] | Game | null;
  error?: { code: string; message: string };
}

export class HelperError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HelperError";
    this.code = code;
  }
}

export function isCommand(value: unknown): value is HelperCommand {
  if (!value || typeof value !== "object") {
    return false;
  }

  const command = value as Record<string, unknown>;

  if (typeof command.channelId !== "string" || !/^UC[A-Za-z0-9_-]{22}$/.test(command.channelId)) {
    return false;
  }

  if (command.kind === "status") {
    return true;
  }

  if (command.kind === "searchGames") {
    return (
      typeof command.query === "string" &&
      command.query.trim().length > 0 &&
      command.query.length <= 200
    );
  }

  if (typeof command.videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(command.videoId)) {
    return false;
  }

  return (
    command.kind === "getVideoGame" || (command.kind === "setVideoGame" && isGame(command.game))
  );
}

export function isRequest(value: unknown): value is HelperRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const request = value as Partial<HelperRequest>;

  return (
    request.protocol === PROTOCOL &&
    request.direction === "request" &&
    typeof request.id === "string" &&
    /^[a-zA-Z0-9-]{1,80}$/.test(request.id) &&
    isCommand(request.command)
  );
}

export function validResult(command: HelperCommand, result: unknown): boolean {
  if (command.kind === "searchGames") {
    return Array.isArray(result) && result.every(isGame);
  }

  if (command.kind === "status") {
    const status = result as Partial<HelperStatus> | null;

    return (
      !!status &&
      status.version === HELPER_VERSION &&
      status.channelId === command.channelId &&
      (status.transport === "background" || status.transport === "studio")
    );
  }

  if (command.kind === "getVideoGame" && result === null) {
    return true;
  }

  return isGame(result) && (command.kind !== "setVideoGame" || result.mid === command.game.mid);
}
