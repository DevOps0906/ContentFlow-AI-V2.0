import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const PLACEHOLDER = "https://contentflow.example.invalid";

/** Release builds accept only an https API origin; CAP_ENV=dev also allows http. */
export function resolveApiBase(command: "serve" | "build", env: Record<string, string>, capEnv?: string): string {
  const raw = (env.VITE_API_BASE ?? "").trim().replace(/\/+$/, "");
  if (command === "serve") return raw; // dev server: "" = same origin through the /api proxy
  const dev = capEnv === "dev";
  if (!raw) {
    if (dev) return "http://10.0.2.2:3410";
    console.warn(`[mobile] VITE_API_BASE is not set: using placeholder ${PLACEHOLDER}. Set it before a release.`);
    return PLACEHOLDER;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`VITE_API_BASE is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(dev && url.protocol === "http:")) {
    throw new Error("VITE_API_BASE must be https for a release build (http only with CAP_ENV=dev).");
  }
  return url.origin;
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const apiBase = resolveApiBase(command, env, process.env.CAP_ENV);
  return {
    plugins: [
      react(),
      {
        // Lets check-release read the API address baked into the bundle.
        name: "build-info",
        generateBundle() {
          this.emitFile({ type: "asset", fileName: "build-info.json", source: JSON.stringify({ apiBase }) });
        },
      },
    ],
    define: { __API_BASE__: JSON.stringify(apiBase) },
    server: {
      port: 5173,
      proxy: { "/api": process.env.DEV_API_TARGET ?? "http://127.0.0.1:3410" },
    },
    build: { outDir: "dist", sourcemap: false },
  };
});
