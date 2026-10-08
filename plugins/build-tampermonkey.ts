import { resolve } from "node:path";

import { rolldown } from "rolldown";
import type { Plugin, ResolvedConfig } from "vite";

import { HELPER_VERSION } from "../src/helper/version.ts";

const fileName = "gameplay-helper.user.js";

function appOrigin(value: string): string {
  const origin = new URL(value).origin;

  if (
    !origin.startsWith("https://") &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    throw new Error("VITE_APP_ORIGIN must use HTTPS, except for local development.");
  }

  return origin;
}

function metadata(origin: string): string {
  return `// ==UserScript==
// @name         Gameplay Stream Automation helper
// @namespace    gameplay-stream-automation
// @version      ${HELPER_VERSION}
// @description  Select YouTube catalog games for your gameplay broadcasts.
// @match        ${origin}/*
// @match        https://studio.youtube.com/*
// @connect      studio.youtube.com
// @connect      youtube.com
// @connect      accounts.google.com
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==`;
}

async function bundleHelper(root: string, origin: string) {
  const bundle = await rolldown({
    input: resolve(root, "src/helper/userscript.ts"),
    platform: "browser",
    transform: {
      target: "es2023",
      define: { __APP_ORIGIN__: JSON.stringify(origin) },
    },
  });

  try {
    const { output } = await bundle.generate({
      format: "iife",
      minify: false,
      banner: metadata(origin),
    });
    const script = output[0];

    if (output.length !== 1 || script.type !== "chunk") {
      throw new Error("The Tampermonkey helper must be a single JavaScript file.");
    }

    return { code: script.code, files: await bundle.watchFiles };
  } finally {
    await bundle.close();
  }
}

export function buildTampermonkey(): Plugin {
  let config: ResolvedConfig;
  let origin: string;

  return {
    name: "vite-plugin-build-tampermonkey",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
      origin = appOrigin(config.env.VITE_APP_ORIGIN ?? "http://localhost:5173");
    },

    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split("?")[0];

        if (path !== `${config.base}${fileName}`) {
          next();
          return;
        }

        try {
          // Rebundle on request so installation always uses the current source.
          const { code } = await bundleHelper(config.root, origin);

          response.setHeader("Content-Type", "application/javascript; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(code);
        } catch (error) {
          next(error);
        }
      });
    },

    async generateBundle() {
      if (this.environment.name !== "client") {
        return;
      }

      const { code, files } = await bundleHelper(config.root, origin);

      for (const file of files) {
        this.addWatchFile(file);
      }

      this.emitFile({ type: "asset", fileName, source: code });
    },
  };
}
