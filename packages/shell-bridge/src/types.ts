export type Platform = "web" | "android" | "ios";

/** Key/value store for secrets (tokens). Never Preferences or localStorage. */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The only door from screen code to native features. Screens never import @capacitor/*. */
export interface NativeBridge {
  platform: Platform;
  /** Opens an http(s) URL in the system browser. Other schemes are rejected. */
  openExternal(url: string): Promise<void>;
  secureStore: SecureStore;
  /** Subscribes to app deep links. Returns an unsubscribe function. */
  onAppUrlOpen(listener: (url: string) => void): () => void;
}

export function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("올바르지 않은 주소입니다.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("http(s) 주소만 열 수 있습니다.");
  }
}
