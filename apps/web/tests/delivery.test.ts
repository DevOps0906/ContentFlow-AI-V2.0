import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DeliveryError,
  FAILURE_TYPES,
  formatDuration,
  trackDelivery,
  workTimeMs,
  type DeliveryLog,
  type StateEvent,
} from "../src/lib/delivery";
import { remoteSlug, sendDraft } from "../src/lib/wordpress";
import type { Article } from "../src/lib/content";

const article: Article = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "포트 오류 해결",
  keyword: "포트",
  templateId: "T02",
  platform: "wordpress",
  body: "## 해결\n포트 사용을 확인합니다.",
  sourceUrl: "https://example.com/source",
  status: "export_ready",
  updatedAt: "2026-11-06T00:00:00Z",
};
const cfg = { baseUrl: "https://blog.example.com", username: "u", appPassword: "p w" };
const wpRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Minimal WordPress: stores posts, answers slug lookups, and can lose the response of a create. */
function fakeWp(opts: { loseCreateResponses?: number } = {}) {
  const posts: { id: number; slug: string; status: string; title: string }[] = [];
  let lose = opts.loseCreateResponses ?? 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const match = u.pathname.match(/\/posts\/(\d+)$/);
    if (!match && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const id = posts.length + 1;
      posts.push({ id, slug: body.slug, status: body.status, title: body.title });
      if (lose-- > 0) throw new DOMException("too slow", "TimeoutError");
      return wpRes({ id, link: `https://blog.example.com/?p=${id}`, status: "draft" }, 201);
    }
    if (!match) return wpRes(posts.filter((p) => p.slug === u.searchParams.get("slug")));
    const post = posts.find((p) => p.id === Number(match[1]));
    assert.ok(post);
    if (init?.method === "POST") post.title = JSON.parse(String(init.body)).title;
    return wpRes({ ...post, link: `https://blog.example.com/?p=${post.id}` });
  };
  return { posts, fetchImpl };
}

function storage(fail?: "error" | "throw") {
  const rows: Record<string, unknown>[] = [];
  const log: DeliveryLog = {
    workspaceId: "ws",
    userId: "u",
    client: {
      from: (table) => {
        assert.equal(table, "delivery_attempts");
        return {
          insert: async (row) => {
            if (fail === "throw") throw new Error("network down");
            rows.push(row);
            return { error: fail === "error" ? { code: "42501", message: "denied" } : null };
          },
        };
      },
    },
  };
  return { rows, log };
}

afterEach(() => mock.restoreAll());

test("a new draft carries the article's slug", async () => {
  const wp = fakeWp();
  const r = await sendDraft(cfg, article, undefined, wp.fetchImpl);
  assert.equal(r.created, true);
  assert.equal(wp.posts[0].slug, remoteSlug(article.id));
  assert.equal(wp.posts[0].status, "draft");
});

test("a retry after a timed-out create updates that draft instead of creating a second one", async () => {
  const wp = fakeWp({ loseCreateResponses: 1 });
  await assert.rejects(sendDraft(cfg, article, undefined, wp.fetchImpl), (e: DeliveryError) => e.failureType === "timeout");
  assert.equal(wp.posts.length, 1);
  const retry = await sendDraft(cfg, { ...article, title: "재시도" }, undefined, wp.fetchImpl);
  assert.deepEqual(retry, { postId: 1, url: "https://blog.example.com/?p=1", created: false });
  assert.equal(wp.posts.length, 1);
  assert.equal(wp.posts[0].title, "재시도");
});

test("a retry after the database lost the post id finds the same draft", async () => {
  const wp = fakeWp();
  await sendDraft(cfg, article, undefined, wp.fetchImpl);
  // The state save failed, so the next send still has no remote post id.
  const retry = await sendDraft(cfg, article, undefined, wp.fetchImpl);
  assert.equal(retry.created, false);
  assert.equal(wp.posts.length, 1);
});

test("a post that is no longer a draft is neither overwritten nor duplicated", async () => {
  const wp = fakeWp();
  await sendDraft(cfg, article, undefined, wp.fetchImpl);
  wp.posts[0].status = "publish";
  await assert.rejects(
    sendDraft(cfg, { ...article, title: "덮어쓰기" }, undefined, wp.fetchImpl),
    (e: DeliveryError) => e.failureType === "remote_state",
  );
  assert.equal(wp.posts.length, 1);
  assert.equal(wp.posts[0].title, article.title);
});

test("when the slug lookup can not answer nothing is created", async () => {
  for (const [lookup, type] of [
    [wpRes({ code: "rest_forbidden" }, 403), "auth"],
    [wpRes({ not: "a list" }), "invalid_response"],
    [new Response("<html>", { status: 200 }), "invalid_response"],
  ] as const) {
    let creates = 0;
    await assert.rejects(
      sendDraft(cfg, article, undefined, async (_url, init) => {
        if (init?.method) creates++;
        return lookup;
      }),
      (e: DeliveryError) => e.failureType === type,
    );
    assert.equal(creates, 0, type);
  }
});

test("failures carry a type", async () => {
  const fails = async (status: number) => {
    const err = await sendDraft(cfg, article, 7, async () => wpRes({}, status)).catch((e) => e);
    assert.ok(err instanceof DeliveryError);
    return err.failureType;
  };
  assert.equal(await fails(401), "auth");
  assert.equal(await fails(403), "auth");
  assert.equal(await fails(404), "not_found");
  assert.equal(await fails(429), "rate_limited");
  assert.equal(await fails(503), "server");
  assert.equal(await fails(400), "rejected");
  const type = (p: Promise<unknown>) => p.catch((e: DeliveryError) => e.failureType);
  assert.equal(await type(sendDraft(cfg, { ...article, status: "drafting" })), "not_sendable");
  assert.equal(await type(sendDraft({ ...cfg, baseUrl: "http://a.example" }, article)), "config");
  assert.equal(await type(sendDraft({ ...cfg, baseUrl: "not a url" }, article)), "config");
  assert.equal(
    await type(sendDraft(cfg, article, undefined, async () => { throw new TypeError("fetch failed"); })),
    "network",
  );
});

test("a successful attempt is recorded once, with its URL and no attempt number from the app", async () => {
  const { rows, log } = storage();
  const r = await trackDelivery(log, "a1", async () => ({ url: "https://x/?p=1", postId: 1 }));
  assert.equal(r.postId, 1);
  assert.equal(rows.length, 1);
  const { duration_ms, ...rest } = rows[0];
  assert.equal(typeof duration_ms, "number");
  assert.deepEqual(rest, {
    workspace_id: "ws",
    article_id: "a1",
    created_by: "u",
    channel: "wordpress",
    failure_type: null,
    url: "https://x/?p=1",
  });
});

test("a failed attempt keeps its type, and unclassified errors are unknown", async () => {
  const { rows, log } = storage();
  const typed = new DeliveryError("timeout", "느림");
  await assert.rejects(trackDelivery(log, "a1", async () => { throw typed; }), (e) => e === typed);
  await assert.rejects(trackDelivery(log, "a1", async () => { throw new Error("x"); }));
  assert.deepEqual(rows.map((r) => [r.failure_type, r.url]), [["timeout", null], ["unknown", null]]);
});

test("a failure to store the log does not change the delivery result", async () => {
  for (const mode of ["error", "throw"] as const) {
    const warn = mock.method(console, "warn", () => {});
    const r = await trackDelivery(storage(mode).log, "a1", async () => ({ url: "https://x" }));
    assert.equal(r.url, "https://x", mode);
    assert.equal(warn.mock.callCount(), 1, mode);
    mock.restoreAll();
  }
});

const ev = (fromState: StateEvent["fromState"], toState: StateEvent["toState"], createdAt: string): StateEvent => ({
  fromState,
  toState,
  createdAt,
});

test("working time runs from the first transition to the latest approval", () => {
  const first = ev("drafting", "approval_pending", "2026-11-01T00:00:00Z");
  const approved = ev("approval_pending", "approved", "2026-11-01T01:00:00Z");
  const reopened = ev("approved", "drafting", "2026-11-01T02:00:00Z");
  const again = ev("approval_pending", "approved", "2026-11-01T03:00:00Z");
  const after = ev("approved", "export_ready", "2026-11-01T04:00:00Z");
  assert.equal(workTimeMs([first, approved]), 3_600_000);
  assert.equal(workTimeMs([first, approved, reopened, again, after]), 3 * 3_600_000);
});

test("working time is N/A without an approval or when history starts mid-review", () => {
  assert.equal(workTimeMs([]), null);
  assert.equal(workTimeMs([ev("drafting", "approval_pending", "2026-11-01T00:00:00Z")]), null);
  assert.equal(workTimeMs([ev("approval_pending", "approved", "2026-11-01T01:00:00Z")]), null);
  assert.equal(
    workTimeMs([
      ev("needs_revision", "drafting", "2026-11-01T00:00:00Z"),
      ev("approval_pending", "approved", "2026-11-01T01:00:00Z"),
    ]),
    null,
  );
});

test("durations read N/A when unknown", () => {
  assert.equal(formatDuration(null), "N/A");
  assert.equal(formatDuration(1500), "1.5초");
  assert.equal(formatDuration(5 * 60_000), "5분");
  assert.equal(formatDuration(125 * 60_000), "2시간 5분");
});

test("failure types match the database check", () => {
  const sql = readFileSync(
    new URL("../../../supabase/migrations/0008_state_events_and_delivery_attempts.sql", import.meta.url),
    "utf8",
  );
  const list = sql.match(/failure_type text check \(failure_type in \(([^)]*)\)/)?.[1];
  assert.ok(list);
  assert.deepEqual([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...FAILURE_TYPES]);
});
