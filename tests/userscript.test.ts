import { afterEach, describe, expect, it, vi } from "vitest";

import { HELPER_VERSION, PROTOCOL, type HelperRequest } from "../src/helper/protocol";
import { channelId, game, secondChannelId, videoId } from "./fixtures";

const origin = "http://localhost:5173";

interface BackgroundRequest {
  url: string;
  onload: (response: { status: number; responseText: string; finalUrl: string }) => void;
}

async function sandbox() {
  vi.resetModules();

  const listeners = new Map<string, (event: MessageEvent) => Promise<void>>();
  const page = {
    addEventListener: (name: string, listener: (event: MessageEvent) => Promise<void>) => {
      listeners.set(name, listener);
    },
    postMessage: vi.fn<(message: unknown, origin: string) => void>(),
  };
  const cookie = {
    list: vi.fn<
      (
        details: { url: string },
        callback: (cookies: { name: string; value: string }[]) => void,
      ) => void
    >(),
  };
  const config = {
    CHANNEL_ID: channelId,
    INNERTUBE_CONTEXT: { client: { clientName: "WEB_CREATOR" } },
  };
  const request = vi.fn<(details: BackgroundRequest) => void>((details) => {
    details.onload({
      status: 200,
      responseText: details.url.includes("/youtubei/")
        ? JSON.stringify({ gameTitles: [game] })
        : `ytcfg.set(${JSON.stringify(config)});`,
      finalUrl: details.url,
    });
  });

  cookie.list.mockImplementation((_details, callback) => {
    callback([{ name: "SAPISID", value: "test-session-stays-in-helper" }]);
  });

  vi.stubGlobal("__APP_ORIGIN__", origin);
  vi.stubGlobal("location", { origin });
  vi.stubGlobal("unsafeWindow", page);
  vi.stubGlobal("window", new Proxy(page, {}));
  vi.stubGlobal("GM_xmlhttpRequest", request);
  vi.stubGlobal("GM_cookie", cookie);
  vi.stubGlobal("GM_listValues", () => []);
  vi.stubGlobal("GM_getValue", () => undefined);
  vi.stubGlobal("GM_deleteValue", vi.fn());

  await import("../src/helper/userscript");

  const data: HelperRequest = {
    protocol: PROTOCOL,
    direction: "request",
    id: "sandbox-test",
    command: { kind: "status", channelId },
  };
  const send = (overrides = {}) =>
    listeners.get("message")!({
      source: page,
      origin,
      data,
      ...overrides,
    } as unknown as MessageEvent);

  return { page, request, cookie, send };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Tampermonkey runtime", () => {
  it("answers the real page when the sandbox window has a different identity", async () => {
    const { page, request, send } = await sandbox();

    await send();

    expect(request).toHaveBeenCalledTimes(2);
    expect(page.postMessage).toHaveBeenCalledWith(
      {
        protocol: PROTOCOL,
        direction: "response",
        id: "sandbox-test",
        result: { version: HELPER_VERSION, channelId, transport: "background" },
      },
      origin,
    );
    expect(JSON.stringify(page.postMessage.mock.calls)).not.toContain("test-session");
  });

  it("ignores messages from another window or origin", async () => {
    const { page, request, send } = await sandbox();

    await send({ source: {} });
    await send({ origin: "https://example.com" });

    expect(request).not.toHaveBeenCalled();
    expect(page.postMessage).not.toHaveBeenCalled();
  });

  it("returns a recovery response when cookie access never calls back", async () => {
    vi.useFakeTimers();

    const { page, cookie, send } = await sandbox();
    cookie.list.mockImplementation(() => undefined);

    const response = send();
    await vi.advanceTimersByTimeAsync(16_000);
    await response;

    expect(page.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "STUDIO_REQUIRED" }) }),
      origin,
    );
  });
});

async function studioWorker(owner = channelId, nativeAvailable = true) {
  vi.resetModules();

  const values = new Map<string, unknown>();
  const interval = vi.fn<(callback: () => void, milliseconds: number) => number>();
  let selectedGame: typeof game | undefined;
  const save = vi.fn<
    (mutation: { request: Record<string, unknown> }) => Promise<Record<string, unknown>>
  >(async (mutation) => {
    expect(mutation.request).toEqual({
      encryptedVideoId: videoId,
      gameTitle: { newKgEntityId: game.mid },
      videoReadMask: { videoId: true, channelId: true, gameTitle: { all: true } },
    });

    selectedGame = game;

    return {
      overallResult: { resultCode: "UPDATE_SUCCESS" },
      gameTitle: { success: true },
    };
  });
  const manager = { sendRequest: save };
  const app = { studioServicesCoordinator: { videoMutationQueueManager: manager } };
  const page = {
    ytcfg: {
      data_: {
        CHANNEL_ID: channelId,
        INNERTUBE_CONTEXT: { client: { clientName: "WEB_CREATOR" } },
      },
    },
    document: {
      cookie: "SAPISID=test-session",
      querySelector: vi.fn<(selector: string) => typeof app | null>((selector) => {
        expect(selector).toBe("ytcp-app");
        return nativeAvailable ? app : null;
      }),
    },
    addEventListener: vi.fn<(name: string, listener: () => void) => void>(),
    setInterval: interval,
    fetch: vi.fn<typeof fetch>(async (input, init) => {
      const body = JSON.parse(init?.body as string);
      const path = input instanceof Request ? input.url : input.toString();

      return new Response(
        JSON.stringify(
          path.includes("get_creator_videos")
            ? { videos: [{ videoId: body.videoIds[0], channelId: owner, gameTitle: selectedGame }] }
            : { responseContext: {} },
        ),
      );
    }),
  };

  vi.stubGlobal("__APP_ORIGIN__", origin);
  vi.stubGlobal("location", {
    origin: "https://studio.youtube.com",
    pathname: `/channel/${channelId}`,
  });
  vi.stubGlobal("unsafeWindow", page);
  vi.stubGlobal("window", new Proxy(page, {}));
  vi.stubGlobal("crypto", {
    randomUUID: () => "worker-test",
    subtle: { digest: async () => new ArrayBuffer(20) },
  });
  vi.stubGlobal("GM_listValues", () => [...values.keys()]);
  vi.stubGlobal("GM_getValue", (key: string) => values.get(key));
  vi.stubGlobal("GM_setValue", (key: string, value: unknown) => values.set(key, value));
  vi.stubGlobal("GM_deleteValue", (key: string) => values.delete(key));

  await import("../src/helper/userscript");

  const tick = interval.mock.calls[0][0];
  tick();
  values.set("gsa:v1:request:assignment", {
    workerId: "worker-test",
    expiresAt: Date.now() + 60_000,
    request: {
      protocol: PROTOCOL,
      direction: "request",
      id: "assignment",
      command: { kind: "setVideoGame", channelId, videoId, game },
    },
  });
  tick();

  await vi.waitFor(() => expect(values.has("gsa:v1:response:assignment")).toBe(true));

  return { page, save, manager, response: values.get("gsa:v1:response:assignment") };
}

describe("Studio page worker", () => {
  it("assigns and verifies a game from the channel dashboard without an editor", async () => {
    const { page, save, manager, response } = await studioWorker();

    expect(page.fetch).toHaveBeenCalledTimes(2);
    expect(
      page.fetch.mock.calls.every(([url]) => {
        const path = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
        return path.includes("get_creator_videos");
      }),
    ).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.contexts[0]).toBe(manager);
    expect(response).toEqual({
      protocol: PROTOCOL,
      direction: "response",
      id: "assignment",
      result: game,
    });
  });

  it("blocks a game write to a video owned by another channel", async () => {
    const { page, save, response } = await studioWorker(secondChannelId);

    expect(page.fetch).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(response).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "CHANNEL_MISMATCH" }) }),
    );
  });

  it("reports an unavailable native save service without trying an unattested write", async () => {
    const { page, save, response } = await studioWorker(channelId, false);

    expect(page.fetch).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(response).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "STUDIO_CHANGED",
          message: "Studio’s game save service is unavailable. Reload Studio and retry.",
        }),
      }),
    );
  });
});
