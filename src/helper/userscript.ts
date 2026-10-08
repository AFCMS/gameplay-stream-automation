/// <reference types="tampermonkey" />

import { errorMessage } from "../domain/types";
import {
  HELPER_VERSION,
  HelperError,
  PROTOCOL,
  isRequest,
  type HelperCommand,
  type HelperRequest,
  type HelperResponse,
} from "./protocol";
import {
  STUDIO_ORIGIN,
  assignGame,
  parseGames,
  parseStudioConfig,
  readVideo,
  studioContext,
  verifyStudioChannel,
  type JsonObject,
  type StudioConfig,
  type StudioTransport,
} from "./studio";

declare const __APP_ORIGIN__: string;

const studioWindow = unsafeWindow as typeof unsafeWindow & {
  ytcfg?: { data_?: StudioConfig };
};

interface StudioApp extends Element {
  studioServicesCoordinator?: {
    videoMutationQueueManager?: {
      sendRequest(request: { request: JsonObject }): Promise<JsonObject>;
    };
  };
}

interface StudioWorker {
  id: string;
  channelId: string;
  seenAt: number;
}

interface QueuedRequest {
  request: HelperRequest;
  workerId: string;
  expiresAt: number;
}

const PREFIX = "gsa:v1:";
const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function gmRequest(url: string, headers?: Record<string, string>, body?: JsonObject) {
  return new Promise<{ status: number; text: string; finalUrl: string }>((resolve, reject) => {
    GM_xmlhttpRequest({
      method: body ? "POST" : "GET",
      url,
      headers,
      data: body ? JSON.stringify(body) : undefined,
      timeout: 15_000,
      cookiePartition: { topLevelSite: "https://youtube.com" },
      onload: (response) =>
        resolve({
          status: response.status,
          text: response.responseText,
          finalUrl: response.finalUrl,
        }),
      onerror: () =>
        reject(
          new HelperError(
            "STUDIO_REQUIRED",
            "Studio could not be reached in the background. Open Studio and retry.",
          ),
        ),
      ontimeout: () =>
        reject(
          new HelperError("STUDIO_REQUIRED", "Studio did not respond. Open Studio and retry."),
        ),
    });
  });
}

async function authenticationHeaders(
  config: StudioConfig,
  cookie: string,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const input = new TextEncoder().encode(`${timestamp} ${cookie} ${STUDIO_ORIGIN}`);
  const digest = await crypto.subtle.digest("SHA-1", input);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return {
    "Content-Type": "application/json",
    Authorization: `SAPISIDHASH ${timestamp}_${hash}`,
    "X-Origin": STUDIO_ORIGIN,
    "X-Goog-AuthUser": String(config.SESSION_INDEX ?? 0),
    "X-Youtube-Client-Name": "62",
    "X-Youtube-Client-Version":
      config.INNERTUBE_CONTEXT_CLIENT_VERSION ?? config.INNERTUBE_CLIENT_VERSION ?? "",
  };
}

function readableSessionCookie(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof GM_cookie === "undefined") {
      reject(
        new HelperError(
          "STUDIO_REQUIRED",
          "This Tampermonkey installation requires an open Studio page. Open Studio and retry.",
        ),
      );
      return;
    }

    const timer = setTimeout(() => {
      reject(
        new HelperError(
          "STUDIO_REQUIRED",
          "Background session access timed out. Open Studio and retry.",
        ),
      );
    }, 5000);

    GM_cookie.list({ url: STUDIO_ORIGIN }, (cookies, error) => {
      clearTimeout(timer);

      const cookie =
        cookies?.find((item) => item.name === "SAPISID") ??
        cookies?.find((item) => item.name === "__Secure-3PAPISID");

      if (error || !cookie) {
        reject(
          new HelperError(
            "STUDIO_REQUIRED",
            "Sign in to Studio in this Chrome profile, then retry.",
          ),
        );
        return;
      }

      resolve(cookie.value);
    });
  });
}

function parseResponse(status: number, text: string): JsonObject {
  if (status < 200 || status >= 300) {
    throw new HelperError(
      "STUDIO_REQUIRED",
      `Studio rejected the request (${status}). Reconnect Studio and retry.`,
    );
  }

  try {
    const response = JSON.parse(text) as JsonObject;

    if (!response || typeof response !== "object" || response.error) {
      throw new Error("Unsupported response");
    }

    return response;
  } catch {
    throw new HelperError(
      "STUDIO_CHANGED",
      "Studio returned an unsupported response. Reconnect or update the helper.",
    );
  }
}

async function backgroundApi(channelId: string): Promise<StudioTransport> {
  const response = await gmRequest(`${STUDIO_ORIGIN}/channel/${channelId}`);
  const config = parseStudioConfig(response.text);

  verifyStudioChannel(config, channelId);
  const cookie = await readableSessionCookie();

  return async (path, body) => {
    const headers = await authenticationHeaders(config, cookie);
    const result = await gmRequest(`${STUDIO_ORIGIN}/youtubei/v1/${path}?alt=json`, headers, {
      ...body,
      context: studioContext(config),
    });

    return parseResponse(result.status, result.text);
  };
}

async function pageApi(channelId: string): Promise<StudioTransport> {
  const config = studioWindow.ytcfg?.data_;

  if (!config?.INNERTUBE_CONTEXT) {
    throw new HelperError("STUDIO_REQUIRED", "Wait for Studio to finish loading, then retry.");
  }

  verifyStudioChannel(config, channelId);

  const cookies = unsafeWindow.document.cookie.split("; ");
  const entry =
    cookies.find((value) => value.startsWith("SAPISID=")) ??
    cookies.find((value) => value.startsWith("__Secure-3PAPISID="));
  const cookie = entry?.slice(entry.indexOf("=") + 1);

  if (!cookie) {
    throw new HelperError("STUDIO_REQUIRED", "Sign in to Studio before retrying.");
  }

  return async (path, body) => {
    verifyStudioChannel(studioWindow.ytcfg?.data_ ?? {}, channelId);

    if (path === "video_manager/metadata_update") {
      const app = unsafeWindow.document.querySelector<StudioApp>("ytcp-app");
      const manager = app?.studioServicesCoordinator?.videoMutationQueueManager;

      if (typeof manager?.sendRequest !== "function") {
        throw new HelperError(
          "STUDIO_CHANGED",
          "Studio’s game save service is unavailable. Reload Studio and retry.",
        );
      }

      // Studio's native save service adds security attestation; a plain fetch can silently do nothing.
      return manager.sendRequest({ request: body });
    }

    const response = await unsafeWindow.fetch(`${STUDIO_ORIGIN}/youtubei/v1/${path}?alt=json`, {
      method: "POST",
      headers: await authenticationHeaders(config, cookie),
      body: JSON.stringify({ ...body, context: studioContext(config) }),
      signal: AbortSignal.timeout(15_000),
    });

    return parseResponse(response.status, await response.text());
  };
}

async function execute(command: HelperCommand, transport: "background" | "studio") {
  const api =
    transport === "background"
      ? await backgroundApi(command.channelId)
      : await pageApi(command.channelId);

  switch (command.kind) {
    case "status":
      // An authenticated read verifies that the parsed bootstrap is usable.
      await api("gaming/game_title", { userInput: "Halo" });
      return { version: HELPER_VERSION, channelId: command.channelId, transport };

    case "searchGames":
      return parseGames(await api("gaming/game_title", { userInput: command.query }));

    case "getVideoGame":
      return (await readVideo(api, command.videoId, command.channelId)).gameTitle ?? null;

    case "setVideoGame":
      return assignGame(api, command.videoId, command.channelId, command.game);
  }
}

function failure(request: HelperRequest, error: unknown): HelperResponse {
  return {
    protocol: PROTOCOL,
    direction: "response",
    id: request.id,
    error: {
      code: error instanceof HelperError ? error.code : "STUDIO_REQUIRED",
      message:
        error instanceof HelperError
          ? error.message
          : "The Studio helper failed. Open Studio and retry setup.",
    },
  };
}

async function forwardToStudio(request: HelperRequest): Promise<HelperResponse> {
  const deadline = Date.now() + (request.command.kind === "setVideoGame" ? 80_000 : 10_000);
  const requestKey = `${PREFIX}request:${request.id}`;
  const responseKey = `${PREFIX}response:${request.id}`;
  let dispatched = false;

  try {
    while (Date.now() < deadline) {
      if (!dispatched) {
        const workers = GM_listValues()
          .filter((key) => key.startsWith(`${PREFIX}worker:`))
          .map((key) => GM_getValue<StudioWorker>(key));

        const worker = workers.find(
          (candidate) =>
            candidate.channelId === request.command.channelId &&
            Date.now() - candidate.seenAt < 12_000,
        );

        if (worker) {
          GM_setValue(requestKey, {
            request,
            workerId: worker.id,
            expiresAt: deadline,
          } satisfies QueuedRequest);
          dispatched = true;
        }
      }

      const response = GM_getValue<HelperResponse | undefined>(responseKey);

      if (response) {
        return response;
      }

      await delay(500);
    }

    throw new HelperError("STUDIO_REQUIRED", "Open Studio on this channel, then retry.");
  } finally {
    GM_deleteValue(requestKey);
    GM_deleteValue(responseKey);
  }
}

function runAppBridge() {
  let busy = false;

  // Tampermonkey's sandbox window is a proxy; MessageEvent.source is the real page window.
  const page = unsafeWindow;

  page.addEventListener("message", async (event: MessageEvent) => {
    if (event.source !== page || event.origin !== __APP_ORIGIN__ || !isRequest(event.data)) {
      return;
    }

    const request = event.data;

    if (busy) {
      page.postMessage(
        failure(
          request,
          new HelperError("BUSY", "The helper is finishing another request. Try again shortly."),
        ),
        __APP_ORIGIN__,
      );
      return;
    }

    busy = true;
    let response: HelperResponse;

    try {
      try {
        const result = await execute(request.command, "background");
        response = { protocol: PROTOCOL, direction: "response", id: request.id, result };
      } catch (error) {
        if (error instanceof HelperError && error.code === "CHANNEL_MISMATCH") {
          throw error;
        }

        response = await forwardToStudio(request);
      }
    } catch (error) {
      response = failure(request, error);
    } finally {
      busy = false;
    }

    page.postMessage(response, __APP_ORIGIN__);
  });
}

function runStudioWorker() {
  const id = crypto.randomUUID();
  const workerKey = `${PREFIX}worker:${id}`;
  const active = new Set<string>();

  window.addEventListener("pagehide", () => GM_deleteValue(workerKey));

  window.setInterval(() => {
    const channelId = studioWindow.ytcfg?.data_?.CHANNEL_ID;

    if (!channelId) {
      return;
    }

    GM_setValue(workerKey, {
      id,
      channelId,
      seenAt: Date.now(),
    } satisfies StudioWorker);

    for (const key of GM_listValues().filter((value) => value.startsWith(`${PREFIX}request:`))) {
      const queued = GM_getValue<QueuedRequest>(key);

      if (
        !queued ||
        queued.workerId !== id ||
        active.has(key) ||
        queued.expiresAt < Date.now() ||
        !isRequest(queued.request)
      ) {
        continue;
      }

      active.add(key);

      void execute(queued.request.command, "studio")
        .then(
          (result) =>
            ({
              protocol: PROTOCOL,
              direction: "response",
              id: queued.request.id,
              result,
            }) satisfies HelperResponse,
        )
        .catch((error: unknown) => failure(queued.request, error))
        .then((response) => {
          if (queued.expiresAt > Date.now()) {
            GM_setValue(`${PREFIX}response:${queued.request.id}`, response);
          }

          GM_deleteValue(key);
          active.delete(key);
        });
    }
  }, 1000);
}

try {
  if (location.origin === __APP_ORIGIN__) {
    runAppBridge();
  } else if (location.origin === STUDIO_ORIGIN) {
    runStudioWorker();
  }
} catch (error) {
  // No session data or raw API responses are logged.
  console.warn("Gameplay helper could not start:", errorMessage(error));
}
