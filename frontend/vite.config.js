import { defineConfig, loadEnv } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** PMO vision calls can exceed default ~120s proxy timeouts. */
const PROXY_TIMEOUT_MS = 600_000;

function apiProxyOptions(target) {
  return {
    target,
    changeOrigin: true,
    timeout: PROXY_TIMEOUT_MS,
    proxyTimeout: PROXY_TIMEOUT_MS,
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8000";
  const apiProxy = apiProxyOptions(apiProxyTarget);

  return {
    appType: "mpa",
    base: "/",
    server: {
      host: true,
      proxy: {
        "/api": apiProxy,
      },
    },
    preview: {
      host: true,
      proxy: {
        "/api": apiProxy,
      },
    },
    build: {
      outDir: "dist",
      rollupOptions: {
        input: {
          main: resolve(__dirname, "index.html"),
          aiAnalysis: resolve(__dirname, "dashboard/ai-analysis/index.html"),
          imageAnalysis: resolve(__dirname, "dashboard/image-analysis/index.html"),
          live: resolve(__dirname, "dashboard/live/index.html"),
          remoteCamera: resolve(__dirname, "dashboard/live/remote/index.html"),
        },
      },
    },
  };
});
