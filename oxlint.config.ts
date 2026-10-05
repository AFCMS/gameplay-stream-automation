import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: [
    "oxc",
    "typescript",
    "react",
    "react-perf",
    "import",
    "jsdoc",
    "jsx-a11y",
    "promise",
    "vitest",
  ],
  categories: {
    correctness: "error",
  },
  options: {
    typeAware: true,
  },
});
