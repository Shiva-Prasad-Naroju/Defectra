import { defineConfig } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  appType: "mpa",
  base: "/",
  server: {
    host: true,
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        imageAnalysis: resolve(__dirname, "dashboard/image-analysis/index.html"),
        live: resolve(__dirname, "dashboard/live/index.html"),
        remoteCamera: resolve(__dirname, "dashboard/live/remote/index.html"),
      },
    },
  },
});
