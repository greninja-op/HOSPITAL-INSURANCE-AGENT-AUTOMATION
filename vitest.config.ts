import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    include: ["lib/**/*.{test,property.test}.{ts,tsx}", "app/**/*.{test,property.test}.{ts,tsx}"],
    exclude: ["node_modules/**", "whatsapp-integration/**", "i18n/**", ".next/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
