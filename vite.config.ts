import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react({ compiler: true }), tailwindcss()],
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
