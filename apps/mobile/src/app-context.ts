import { createBridge, createSession } from "@contentflow/shell-bridge";

export const bridge = createBridge();
export const session = createSession({ apiBase: __API_BASE__, store: bridge.secureStore });
