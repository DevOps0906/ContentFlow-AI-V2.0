import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import type { SecureStore } from "../types.ts";

/** Keystore/Keychain-backed store (@aparajita/capacitor-secure-storage). Real-device check pending. */
export function createCapacitorSecureStore(): SecureStore {
  return {
    get: (key) => SecureStorage.getItem(key) as Promise<string | null>,
    async set(key, value) {
      await SecureStorage.setItem(key, value);
    },
    async remove(key) {
      await SecureStorage.removeItem(key);
    },
  };
}
