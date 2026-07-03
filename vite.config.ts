import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// The renderer's source of truth lives in the sibling joty-web clone; this
// project only contains the desktop shell under src/. See README.
const sharedSrc = path.resolve(__dirname, "../joty-web/src");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": sharedSrc,
    },
    // Keep singleton libraries resolving to this project's copy even when
    // imported from files inside ../joty-web/src.
    dedupe: [
      "react",
      "react-dom",
      "react-router",
      "@tanstack/react-query",
      "@workos-inc/authkit-react",
    ],
  },
  build: {
    outDir: "dist/renderer",
  },
  server: {
    host: "127.0.0.1",
    port: 39173,
    strictPort: true,
    fs: {
      allow: [__dirname, path.resolve(__dirname, "../joty-web")],
    },
  },
});
