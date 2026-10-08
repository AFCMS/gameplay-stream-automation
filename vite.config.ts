import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { buildTampermonkey } from "./plugins/build-tampermonkey.ts";

export default defineConfig({
  plugins: [react({ compiler: true }), tailwindcss(), buildTampermonkey()],
  build: {
    chunkImportMap: true,
  },
  css: {
    transformer: "lightningcss",
  },
  devtools: { enabled: false },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "unsafe-none",
    },
  },
});
