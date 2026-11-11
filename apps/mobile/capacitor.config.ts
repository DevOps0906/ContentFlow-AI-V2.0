import type { CapacitorConfig } from "@capacitor/cli";

/**
 * One switch: CAP_ENV=dev. Only a dev build may carry server.url / cleartext / mixed content /
 * web debugging. A release config has none of them (pinned by tests/mobile.test.ts).
 */
const APP_ID = "com.devops0906.contentflow";

export function buildConfig(env: Record<string, string | undefined>): CapacitorConfig {
  const dev = env.CAP_ENV === "dev";
  return {
    // Changeable until the store listing is registered; confirm with the owner before then.
    appId: dev ? `${APP_ID}.dev` : APP_ID, // dev installs next to the release app, never over it
    appName: dev ? "ContentFlow (개발)" : "ContentFlow",
    webDir: "dist",
    android: {
      webContentsDebuggingEnabled: dev,
      allowMixedContent: dev,
    },
    server: {
      androidScheme: "https",
      ...(dev ? { cleartext: true, ...(env.CAP_SERVER_URL ? { url: env.CAP_SERVER_URL } : {}) } : {}),
    },
  };
}

export default buildConfig(process.env);
