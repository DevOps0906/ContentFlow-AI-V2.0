"use client";
import { useEffect, useState } from "react";
import type { Article } from "@/lib/content";
import { parseVerdict, type DeliveryCheck } from "@/lib/delivery";

export type Integrations = {
  ai: { configured: boolean; model: string | null; provider?: "gemini" | "openai" | null };
  wordpress: { configured: boolean; host: string | null };
  supabase: {
    status: "not_configured" | "reachable" | "unreachable";
    target?: "none" | "local" | "cloud";
    label?: string;
    issues?: string[];
  };
};

/** Reads which server-side integrations are configured. `null` while loading/failed. */
export function useIntegrations() {
  const [state, setState] = useState<Integrations | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/integrations")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => !cancelled && setState(j))
      .catch(() => !cancelled && setState(null));
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error;
    throw new Error(msg || `요청에 실패했습니다(${res.status}).`);
  }
  return data as T;
}

/** Account mode: the article as stored right now. A failed request throws, so nothing is handed off. */
export async function fetchStoredArticle(id: string): Promise<Article> {
  const res = await fetch(`/api/articles/${id}`, { cache: "no-store" });
  const data = (await res.json().catch(() => null)) as { article?: Article; error?: string } | null;
  if (!res.ok || !data?.article) throw new Error(data?.error || `요청에 실패했습니다(${res.status}).`);
  return data.article;
}

/** Account mode: the server's verdict. A failed request throws, so nothing is handed off. */
export const accountDeliveryCheck: DeliveryCheck = async (id) =>
  parseVerdict(await postJson(`/api/articles/${id}/delivery-check`, {}));
