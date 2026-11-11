import { assertHttpUrl, type NativeBridge, type SecureStore } from "./types.ts";

/** Memory only: a reload loses the tokens (re-login). Nothing touches localStorage. */
export function createMemoryStore(): SecureStore {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

export function createWebBridge(): NativeBridge {
  return {
    platform: "web",
    async openExternal(url) {
      assertHttpUrl(url);
      window.open(url, "_blank", "noopener,noreferrer");
    },
    secureStore: createMemoryStore(),
    onAppUrlOpen() {
      return () => {};
    },
  };
}
