import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { build, createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTampermonkey } from "../plugins/build-tampermonkey";
import { HELPER_VERSION } from "../src/helper/version";

const roots: string[] = [];
const servers: ViteDevServer[] = [];
const origin = "https://streams.example.com";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gameplay-helper-build-"));
  roots.push(root);

  await mkdir(join(root, "src/helper"), { recursive: true });
  await writeFile(join(root, ".env.production"), `VITE_APP_ORIGIN=${origin}`);
  await writeFile(join(root, ".env.development"), `VITE_APP_ORIGIN=${origin}`);
  await writeFile(join(root, "index.html"), '<script type="module" src="/src/main.ts"></script>');
  await writeFile(join(root, "src/main.ts"), 'document.title = "Gameplay";');
  await writeFile(join(root, "src/helper/value.ts"), 'export const value: string = "first";');
  await writeFile(
    join(root, "src/helper/userscript.ts"),
    `import { value } from "./value";
declare const __APP_ORIGIN__: string;
globalThis.result = { origin: __APP_ORIGIN__, value };`,
  );

  return {
    configFile: false as const,
    root,
    base: "/tools/",
    logLevel: "silent" as const,
    plugins: [buildTampermonkey()],
  };
}

async function download(server: ViteDevServer, path: string) {
  const request = new IncomingMessage(new Socket());
  request.method = "GET";
  request.url = path;

  const response = new ServerResponse(request);
  const body = await new Promise<string>((resolve, reject) => {
    vi.spyOn(response, "end").mockImplementation((content: unknown) => {
      resolve(String(content));
      return response;
    });

    server.middlewares(request, response, (error: unknown) => {
      reject(error ?? new Error("The helper request was not handled."));
    });
  });

  return { body, headers: response.getHeaders() };
}

function execute(code: string) {
  const globals: { result?: { origin: string; value: string } } = {};
  runInNewContext(code, globals);
  return globals.result;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Tampermonkey Vite plugin", () => {
  it("emits a standalone userscript alongside the SPA with mode-specific metadata", async () => {
    vi.stubEnv("VITE_APP_ORIGIN", undefined);

    const config = await fixture();
    const result = await build({ ...config, build: { write: false, minify: false } });

    if (!("output" in result)) {
      throw new Error("Expected a single production output.");
    }

    const helper = result.output.find((file) => file.fileName === "gameplay-helper.user.js");
    expect(result.output.some((file) => file.fileName === "index.html")).toBe(true);

    if (!helper || helper.type !== "asset") {
      throw new Error("The userscript was not emitted.");
    }

    const code = String(helper.source);

    expect(code.startsWith("// ==UserScript==")).toBe(true);
    expect(code).toContain(`// @version      ${HELPER_VERSION}`);
    expect(code).toContain(`// @match        ${origin}/*`);
    expect(code).toContain("// @match        https://studio.youtube.com/*");
    expect(code).toContain("// @grant        GM_cookie");
    expect(code).not.toContain("__APP_ORIGIN__");
    expect(execute(code)).toEqual({ origin, value: "first" });
    await expect(
      readFile(join(config.root, "public/gameplay-helper.user.js")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serves current dependency edits through the development server under its base path", async () => {
    vi.stubEnv("VITE_APP_ORIGIN", undefined);

    const config = await fixture();
    const server = await createServer({
      ...config,
      server: { middlewareMode: true, hmr: false, watch: null },
    });
    servers.push(server);

    const first = await download(server, "/tools/gameplay-helper.user.js?install=1");

    expect(first.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(execute(first.body)).toEqual({ origin, value: "first" });

    await writeFile(join(config.root, "src/helper/value.ts"), 'export const value = "updated";');

    const second = await download(server, "/tools/gameplay-helper.user.js");
    expect(execute(second.body)).toEqual({ origin, value: "updated" });
  });

  it("rejects unsafe app origins before generating a userscript", async () => {
    vi.stubEnv("VITE_APP_ORIGIN", "http://streams.example.com");

    await expect(build(await fixture())).rejects.toThrow("VITE_APP_ORIGIN must use HTTPS");
  });
});
