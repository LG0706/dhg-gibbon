import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  worker: {
    format: "es",
  },
  test: {
    environment: "node",
  },
});
