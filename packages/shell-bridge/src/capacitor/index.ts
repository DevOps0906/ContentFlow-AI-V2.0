import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { assertHttpUrl, type NativeBridge, type Platform } from "../types.ts";
import { createCapacitorSecureStore } from "./secure-store.ts";

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export function createCapacitorBridge(): NativeBridge {
  const platform = Capacitor.getPlatform() as Platform;
  return {
    platform,
    async openExternal(url) {
      assertHttpUrl(url);
      await Browser.open({ url });
    },
    secureStore: createCapacitorSecureStore(),
    onAppUrlOpen(listener) {
      const pending = App.addListener("appUrlOpen", (event) => listener(event.url));
      return () => {
        void pending.then((handle) => handle.remove());
      };
    },
  };
}
