// One lint configuration for the web app, the API server and the end-to-end tests.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/", "server/dist/", "**/node_modules/", "server/data/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // Allow intentionally unused names when prefixed with "_" (e.g. Express's 4-argument error handler).
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
  {
    // Test scripts run in Node and send code into the browser with page.evaluate().
    files: ["tests/**/*.mjs"],
    rules: { "no-undef": "off" },
  },
);
