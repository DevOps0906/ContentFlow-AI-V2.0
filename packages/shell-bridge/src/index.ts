import { createCapacitorBridge, isNativePlatform } from "./capacitor/index.ts";
import type { NativeBridge } from "./types.ts";
import { createWebBridge } from "./web.ts";

export * from "./types.ts";
export * from "./session.ts";
export { createMemoryStore, createWebBridge } from "./web.ts";

export function createBridge(): NativeBridge {
  return isNativePlatform() ? createCapacitorBridge() : createWebBridge();
}
