import { defineConfig, loadEnv } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");

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
  const env = {
    ...loadEnv(mode, repoRoot, ""),
    ...loadEnv(mode, __dirname, ""),
  };
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8010";
  const apiProxy = apiProxyOptions(apiProxyTarget);

  return {
    envDir: repoRoot,
    optimizeDeps: {
      include: ["heic2any"],
    },
    appType: "mpa",
    base: "/",
    server: {
      host: true,
      port: 5173,
      strictPort: false,
      allowedHosts: [
        "localhost",
        "127.0.0.1",
        ".ngrok-free.app",
        ".ngrok.app",
      ],
      proxy: {
        "/api": apiProxy,
        "/uploads": apiProxy,
      },
    },
    preview: {
      host: true,
      port: 5173,
      strictPort: false,
      allowedHosts: [
        "localhost",
        "127.0.0.1",
        ".ngrok-free.app",
        ".ngrok.app",
      ],
      proxy: {
        "/api": apiProxy,
        "/uploads": apiProxy,
      },
    },
    build: {
      outDir: "dist",
      rollupOptions: {
        input: {
          main: resolve(__dirname, "index.html"),
          login: resolve(__dirname, "login/index.html"),
          register: resolve(__dirname, "register/index.html"),
          adminDashboard: resolve(__dirname, "admin/index.html"),
          adminLogin: resolve(__dirname, "admin/login/index.html"),
          aiAnalysis: resolve(__dirname, "dashboard/ai-analysis/index.html"),
          imageAnalysis: resolve(__dirname, "dashboard/image-analysis/index.html"),
          live: resolve(__dirname, "dashboard/live/index.html"),
          remoteCamera: resolve(__dirname, "dashboard/live/remote/index.html"),
        },
      },
    },
  };
});
