import type { SecureStore } from "./types.ts";

const STORE_KEY = "cf.session";
const EARLY_REFRESH_SECONDS = 30;

type StoredSession = { accessToken: string; refreshToken: string; expiresAt: number; email: string };

export class SessionExpiredError extends Error {
  constructor() {
    super("세션이 만료되었습니다. 다시 로그인하세요.");
    this.name = "SessionExpiredError";
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type SessionOptions = {
  /** Origin of the ContentFlow server ("" = same origin, dev proxy). */
  apiBase: string;
  store: SecureStore;
  fetchImpl?: typeof fetch;
  /** Epoch seconds. */
  now?: () => number;
  /** Sent as X-Workspace-Id when set. */
  workspaceId?: () => string | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  user?: { email?: string };
};

/** Supabase gives epoch seconds; tolerate milliseconds. */
function toSeconds(value: number): number {
  return value > 1e12 ? Math.floor(value / 1000) : value;
}

export function createSession(options: SessionOptions) {
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args));
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let current: StoredSession | null = null;
  let loaded = false;
  let inflight: Promise<StoredSession> | null = null;
  /** Bumped by logout: a refresh that started before it must not revive the session. */
  let generation = 0;

  async function load(): Promise<StoredSession | null> {
    if (loaded) return current;
    const raw = await options.store.get(STORE_KEY);
    loaded = true;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as StoredSession;
        if (parsed.accessToken && parsed.refreshToken) current = parsed;
      } catch {
        current = null;
      }
    }
    return current;
  }

  async function save(session: StoredSession | null) {
    current = session;
    loaded = true;
    if (session) await options.store.set(STORE_KEY, JSON.stringify(session));
    else await options.store.remove(STORE_KEY);
  }

  function url(path: string) {
    return `${options.apiBase}${path}`;
  }

  async function post(path: string, body: unknown, bearer?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    return doFetch(url(path), { method: "POST", headers, body: JSON.stringify(body) });
  }

  async function readError(res: Response, fallback: string) {
    try {
      const data = (await res.json()) as { error?: string };
      return data.error ?? fallback;
    } catch {
      return fallback;
    }
  }

  function toSession(data: TokenResponse, previous: StoredSession | null): StoredSession {
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token ?? previous?.refreshToken;
    if (!accessToken || !refreshToken || typeof data.expires_at !== "number") {
      throw new ApiError(502, "서버 응답이 올바르지 않습니다.");
    }
    return {
      accessToken,
      refreshToken,
      expiresAt: toSeconds(data.expires_at),
      email: data.user?.email ?? previous?.email ?? "",
    };
  }

  /** Concurrent callers share one request: a refresh token is single-use. */
  function refresh(): Promise<StoredSession> {
    if (inflight) return inflight;
    inflight = (async () => {
      const startedAt = generation;
      const previous = await load();
      if (!previous) throw new SessionExpiredError();
      const res = await post("/api/auth/token/refresh", { refresh_token: previous.refreshToken });
      if (startedAt !== generation) throw new SessionExpiredError();
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        await save(null);
        throw new SessionExpiredError();
      }
      if (!res.ok) throw new ApiError(res.status, await readError(res, "토큰을 갱신하지 못했습니다."));
      const session = toSession((await res.json()) as TokenResponse, previous);
      if (startedAt !== generation) throw new SessionExpiredError();
      await save(session);
      return session;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function validAccessToken(): Promise<string> {
    const session = await load();
    if (!session) throw new SessionExpiredError();
    if (session.expiresAt - EARLY_REFRESH_SECONDS > now()) return session.accessToken;
    return (await refresh()).accessToken;
  }

  async function send(path: string, init: RequestInit | undefined, token: string) {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const workspaceId = options.workspaceId?.();
    if (workspaceId) headers.set("X-Workspace-Id", workspaceId);
    return doFetch(url(path), { ...init, headers });
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    let res = await send(path, init, await validAccessToken());
    if (res.status === 401) {
      res = await send(path, init, (await refresh()).accessToken);
    }
    return res;
  }

  return {
    /** Email of the restored session, or null when logged out. */
    async restore(): Promise<string | null> {
      return (await load())?.email ?? null;
    },
    async login(email: string, password: string): Promise<string> {
      const res = await post("/api/auth/token", { email, password });
      if (!res.ok) throw new ApiError(res.status, await readError(res, "로그인하지 못했습니다."));
      const session = toSession((await res.json()) as TokenResponse, null);
      await save(session);
      return session.email;
    },
    refresh,
    /** Authenticated request; one refresh + retry on 401. */
    request,
    async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
      const res = await request(path, init);
      if (!res.ok) throw new ApiError(res.status, await readError(res, "요청을 처리하지 못했습니다."));
      return (await res.json()) as T;
    },
    /** Best-effort server revoke, then always clear local tokens. */
    async logout(): Promise<void> {
      generation++;
      const session = await load();
      try {
        if (session) await post("/api/auth/token/revoke", {}, session.accessToken);
      } catch {
        // Offline: local tokens are still removed.
      }
      await save(null);
    },
  };
}

export type Session = ReturnType<typeof createSession>;
