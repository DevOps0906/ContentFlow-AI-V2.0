// CF-24 publish queue e2e against the local Supabase stack (60321) and a local WordPress (E2E_WP_URL, default 8081).
// Self-contained: starts a WordPress proxy (to simulate a down / slow site without stopping the shared
// container) and `next dev` wired to it, then drives the API and the /publish screen with headless Chrome.
// Prerequisites: local Supabase with migrations through 0020, `docker compose -f docker-compose.wp-dev.yml up -d`,
// a WordPress credentials file (two lines: username, application password). No other next dev on apps/web.
//   node tests/e2e/publish-queue.mjs <wp-cred-file> [outDir]
import { execFileSync, spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { cpSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, sleep } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../..");
const root = resolve(web, "../..");
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3394);
const PROXY_PORT = Number(process.env.E2E_WP_PROXY_PORT ?? 8091);
const APP = `http://127.0.0.1:${APP_PORT}`;
const WP = (process.env.E2E_WP_URL ?? "http://127.0.0.1:8081").replace(/\/+$/, "");
const wpUrl = new URL(WP);
const FINAL = resolve(process.argv[3] ?? resolve(root, ".nomad/logs/publish-queue"));
const OUT = resolve(process.env.E2E_WORK ?? resolve(process.env.TEMP ?? "/tmp", "pq-run-" + Date.now().toString(36)));
const SHOTS = resolve(OUT, "shots");
for (const d of [OUT, SHOTS]) mkdirSync(d, { recursive: true });
const [wpUser, wpPass] = readFileSync(process.argv[2], "utf8").trim().split(/\r?\n/);
const wpAuth = "Basic " + Buffer.from(`${wpUser}:${wpPass}`).toString("base64");
const stamp = Date.now().toString(36);
const emailA = `pqa-${stamp}@example.test`;
const emailB = `pqb-${stamp}@example.test`;
const PW = "pq-Passw0rd-A!";

// ---- WordPress proxy: ok | refuse (site down) | delay (slow site) ---------------------------
const proxy = { mode: "ok", delayMs: 0, hits: 0 };
const proxyServer = createServer((req, res) => {
  proxy.hits++;
  if (proxy.mode === "refuse") {
    req.socket.destroy();
    return;
  }
  const forward = () => {
    const up = httpRequest(
      { host: wpUrl.hostname, port: Number(wpUrl.port || 80), method: req.method, path: req.url, headers: { ...req.headers, host: wpUrl.host } },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => req.socket.destroy());
    req.pipe(up);
  };
  if (proxy.mode === "delay") setTimeout(forward, proxy.delayMs);
  else forward();
});
proxyServer.listen(PROXY_PORT, "127.0.0.1");

// ---- next dev -------------------------------------------------------------------------------
const envFile = readFileSync(resolve(root, ".env"), "utf8");
const publishable = /^SUPABASE_PUBLISHABLE_KEY=(.+)$/m.exec(envFile)?.[1]?.trim();
const log = createWriteStream(resolve(OUT, "next-dev.log"));
const server = spawn(process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "dev", "-p", String(APP_PORT), "--hostname", "127.0.0.1"], {
  cwd: web,
  env: {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    SUPABASE_URL: "http://127.0.0.1:60321",
    SUPABASE_PUBLISHABLE_KEY: publishable,
    COOKIE_SECURE: "false",
    ALLOW_SIGNUP: "true",
    APP_URL: APP,
    WP_BASE_URL: `http://127.0.0.1:${PROXY_PORT}`,
    WP_USERNAME: wpUser,
    WP_APP_PASSWORD: wpPass,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(log);
server.stderr.pipe(log);

// ---- result collection ----------------------------------------------------------------------
const results = [];
const ctx = {};
async function step(flow, name, fn, { needs = [] } = {}) {
  const missing = needs.filter((k) => !ctx[k]);
  if (missing.length) {
    results.push({ flow, name, status: "SKIP", detail: `선행 실패: ${missing.join(", ")}` });
    console.log(`SKIP ${flow} | ${name}`);
    return;
  }
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ flow, name, status: "PASS", detail: detail ?? "", ms: Date.now() - t });
    console.log(`PASS ${flow} | ${name}`);
  } catch (e) {
    results.push({ flow, name, status: "FAIL", detail: String(e?.message ?? e).slice(0, 500), ms: Date.now() - t });
    console.log(`FAIL ${flow} | ${name} :: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---- helpers --------------------------------------------------------------------------------
function sql(q) {
  return execFileSync("docker", ["exec", "supabase_db_ContentFlow-AI-V2.0", "psql", "-U", "postgres", "-tAc", q], { encoding: "utf8" }).trim();
}
const sqlJson = (q) => JSON.parse(sql(`select coalesce(json_agg(t), '[]') from (${q}) t`) || "[]");
const jobsOf = (articleId) =>
  sqlJson(`select id, status, attempts, next_attempt_at, last_error, updated_at, (next_attempt_at > now()) as future from publish_jobs where article_id = '${articleId}' order by created_at`);
const stateOf = (articleId) => sql(`select state from articles where id = '${articleId}'`);
async function wpPosts(articleId) {
  const res = await fetch(`${WP}/wp-json/wp/v2/posts?slug=cf-${articleId}&status=any&context=edit`, { headers: { Authorization: wpAuth } });
  return (await res.json()) ?? [];
}
async function wpCreate(body) {
  const res = await fetch(`${WP}/wp-json/wp/v2/posts`, { method: "POST", headers: { Authorization: wpAuth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
function cleanBody(kw) {
  return [
    "## 핵심 답변",
    `${kw} 오류가 발생하는 상황을 정리했습니다. 공식 문서의 절차를 따라 재현했습니다.`,
    "## 대상과 적용 조건",
    "포트가 이미 다른 프로세스에서 사용 중일 때 발생합니다.",
    "## 단계별 안내",
    "사용 중인 프로세스를 종료하거나 다른 포트를 지정합니다.",
    "## 주의 사항",
    "서버를 다시 실행해 정상 응답을 확인합니다.",
    "## FAQ",
    "자주 묻는 질문은 공식 문서에서 확인할 수 있습니다.",
    "## 출처",
    "공식 문서를 참고했습니다.",
  ].join("\n");
}
/** New article driven through the API (same DB rules as the UI) to export_ready. */
async function exportReady(page, title) {
  const id = crypto.randomUUID();
  const kw = `발행 큐 ${stamp}`;
  let a = {
    id,
    title,
    keyword: kw,
    templateId: "T01",
    platform: "wordpress",
    body: cleanBody(kw),
    sourceUrl: "https://nextjs.org/docs",
    status: "idea",
    updatedAt: new Date().toISOString(),
    briefPurpose: "포트 충돌 오류를 스스로 해결하게 돕는다",
    briefAudience: "Windows 입문 개발자",
  };
  const put = async (status) => {
    const r = await page.api("PUT", `/api/articles/${id}`, { ...a, status, updatedAt: new Date().toISOString() });
    ok(r.status === 200, `PUT ${status}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    a = r.data.article;
  };
  await put("idea");
  for (const s of ["researching", "briefing", "drafting", "qa_pending", "approval_pending"]) await put(s);
  const rv = await page.api("PATCH", `/api/articles/${id}/review`, { evidenceStatus: "ok", rightsStatus: "ok" });
  ok(rv.status === 200, `review ${rv.status} ${JSON.stringify(rv.data).slice(0, 200)}`);
  a = rv.data.article;
  await put("approved");
  await put("export_ready");
  return a;
}
const draft = (page, id) => page.api("POST", "/api/wordpress/draft", { id });

// ---- wait for the dev server ------------------------------------------------------------------
{
  const end = Date.now() + 180000;
  let up = false;
  while (!up && Date.now() < end) {
    try {
      up = (await fetch(`${APP}/login`)).status === 200;
    } catch {}
    if (!up) await sleep(1000);
  }
  if (!up) {
    console.log(`next dev did not start; log: ${resolve(OUT, "next-dev.log")}`);
    server.kill();
    process.exit(2);
  }
}

const browser = await launchChrome({ port: 9334, userDataDir: resolve(OUT, "chrome-profile") });
let A, B;
try {
  A = await browser.newPage({ width: 1280 });
  B = await browser.newPage({ width: 1280 });

  await step("준비", "계정 A 가입 → 워크스페이스", async () => {
    await A.goto(`${APP}/login`);
    const r = await A.api("POST", "/api/auth/signup", { email: emailA, password: PW });
    ok(r.status === 200, `signup ${r.status} ${JSON.stringify(r.data)}`);
    const s = await A.api("GET", "/api/session");
    ok(s.data?.user?.role === "owner", JSON.stringify(s.data).slice(0, 200));
    ctx.wsA = sql(`select m.workspace_id from memberships m join auth.users u on u.id = m.user_id where u.email = '${emailA}' and m.role = 'owner' limit 1`);
    ok(ctx.wsA, "워크스페이스 없음");
    return ctx.wsA;
  });

  // ===== 정상 =====
  await step("정상", "승인 글 → POST /api/wordpress/draft 200 {article, created}, job draft_created, 원격 초안 1개", async () => {
    const a = await exportReady(A, `큐 정상 ${stamp}`);
    const r = await draft(A, a.id);
    ok(r.status === 200, `status ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    ok(r.data.article?.status === "draft_created" && r.data.created === true, JSON.stringify(r.data).slice(0, 300));
    ok(typeof r.data.article?.remote?.postId === "number", "remote.postId 없음");
    const jobs = jobsOf(a.id);
    ok(jobs.length === 1 && jobs[0].status === "draft_created" && jobs[0].attempts === 1, JSON.stringify(jobs));
    const posts = await wpPosts(a.id);
    ok(posts.length === 1 && posts[0].status === "draft" && posts[0].id === r.data.article.remote.postId, JSON.stringify(posts).slice(0, 200));
    ctx.a1 = a.id;
    return `post ${posts[0].id}`;
  }, { needs: ["wsA"] });

  // ===== 중복 =====
  await step("중복", "draft_created 글 재전송 → 409, 원격 초안 그대로 1개", async () => {
    const r = await draft(A, ctx.a1);
    ok(r.status === 409, `status ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    ok(jobsOf(ctx.a1).length === 1, "job이 늘어남");
    ok((await wpPosts(ctx.a1)).length === 1, "원격 초안 중복");
    return r.data.error;
  }, { needs: ["a1"] });
  await step("중복", "원격에 같은 slug 초안이 남아 있으면 재사용(created=false), 원격 1개", async () => {
    const a = await exportReady(A, `큐 slug 재사용 ${stamp}`);
    const pre = await wpCreate({ title: "이전 시도에서 남은 초안", slug: `cf-${a.id}`, status: "draft", content: "old" });
    ok(pre.status === 201, `wp pre ${pre.status}`);
    const r = await draft(A, a.id);
    ok(r.status === 200 && r.data.created === false, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    const posts = await wpPosts(a.id);
    ok(posts.length === 1 && posts[0].id === pre.data.id && posts[0].title.raw === `큐 slug 재사용 ${stamp}`, JSON.stringify(posts).slice(0, 200));
    return `post ${pre.data.id} 갱신`;
  }, { needs: ["wsA"] });
  await step("중복", "같은 글 접수 2회(POST /api/publish/jobs) → 202 같은 job, 행 1개", async () => {
    const a = await exportReady(A, `큐 중복 접수 ${stamp}`);
    const [r1, r2] = await Promise.all([
      A.api("POST", "/api/publish/jobs", { articleId: a.id }),
      A.api("POST", "/api/publish/jobs", { articleId: a.id }),
    ]);
    ok(r1.status === 202 && r2.status === 202, `${r1.status} ${r2.status} ${JSON.stringify(r2.data).slice(0, 200)}`);
    ok(r1.data.job.id === r2.data.job.id && r1.data.job.status === "queued", `${r1.data.job.id} ${r2.data.job.id}`);
    ok(jobsOf(a.id).length === 1, `jobs ${jobsOf(a.id).length}`);
    ctx.a3 = a.id;
    ctx.job3 = r1.data.job.id;
    return ctx.job3;
  }, { needs: ["wsA"] });

  // ===== GET 부작용 없음 =====
  await step("조회", "GET /api/publish/jobs 3회 → job·글·원격 변화 없음", async () => {
    const before = JSON.stringify(jobsOf(ctx.a3));
    const hits = proxy.hits;
    for (let i = 0; i < 3; i++) {
      const r = await A.api("GET", "/api/publish/jobs");
      ok(r.status === 200 && Array.isArray(r.data.jobs) && r.data.canEdit === true, `${r.status}`);
      ok(r.data.jobs.some((j) => j.id === ctx.job3 && j.status === "queued"), "접수 job 미표시");
    }
    await sleep(500);
    ok(JSON.stringify(jobsOf(ctx.a3)) === before, "job 변경됨");
    ok(stateOf(ctx.a3) === "export_ready", `글 ${stateOf(ctx.a3)}`);
    ok(proxy.hits === hits, `WordPress 호출 ${proxy.hits - hits}회`);
    return "변화 없음";
  }, { needs: ["job3"] });

  // ===== 취소 =====
  await step("취소", "queued 취소 → cancelled, 글 export_ready 유지 / 재취소 409", async () => {
    const r = await A.api("POST", `/api/publish/jobs/${ctx.job3}/cancel`, {});
    ok(r.status === 200 && r.data.job.status === "cancelled", `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    ok(stateOf(ctx.a3) === "export_ready", `글 ${stateOf(ctx.a3)}`);
    const again = await A.api("POST", `/api/publish/jobs/${ctx.job3}/cancel`, {});
    ok(again.status === 409, `재취소 ${again.status}`);
    ok((await wpPosts(ctx.a3)).length === 0, "원격 생성됨");
    return `재취소 ${again.status} ${again.data.code ?? ""}`;
  }, { needs: ["job3"] });

  // ===== WP 중지 → 재시도 예정 =====
  await step("실패", "WP 중지(연결 끊김) → 202 queued·next_attempt_at, 글 publish_failed", async () => {
    const a6 = await exportReady(A, `큐 재시도 ${stamp}`);
    const a7 = await exportReady(A, `큐 키보드 취소 ${stamp}`);
    proxy.mode = "refuse";
    try {
      for (const a of [a6, a7]) {
        const r = await draft(A, a.id);
        ok(r.status === 202 && r.data.job?.status === "queued", `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
        const [j] = jobsOf(a.id);
        ok(j.status === "queued" && j.attempts === 1 && j.future === true && /network/.test(j.last_error ?? ""), JSON.stringify(j));
        ok(stateOf(a.id) === "publish_failed", `글 ${stateOf(a.id)}`);
      }
    } finally {
      proxy.mode = "ok";
    }
    const da = sqlJson(`select failure_type from delivery_attempts where article_id = '${a6.id}'`);
    ok(da.some((d) => d.failure_type === "network"), `delivery_attempts ${JSON.stringify(da)}`);
    ctx.a6 = a6.id;
    ctx.a7 = a7.id;
    return `next_attempt_at ${jobsOf(a6.id)[0].next_attempt_at}`;
  }, { needs: ["wsA"] });
  await step("실패", "경계: 재시도 시각 전 drain → processed 0, job 그대로", async () => {
    const before = JSON.stringify(jobsOf(ctx.a6));
    const r = await A.api("POST", "/api/publish/drain", {});
    ok(r.status === 200 && r.data.processed === 0, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    ok(JSON.stringify(jobsOf(ctx.a6)) === before, "job 변경됨");
    return "processed 0";
  }, { needs: ["a6"] });

  // ===== 동시 접수 + 화면 drain =====
  await step("동시", "두 글 동시 전송(느린 WP) → 200 하나·202 queued 하나", async () => {
    const a4 = await exportReady(A, `큐 동시 1 ${stamp}`);
    const a5 = await exportReady(A, `큐 동시 2 ${stamp}`);
    proxy.mode = "delay";
    proxy.delayMs = 3000;
    let rs;
    try {
      rs = await Promise.all([draft(A, a4.id), draft(A, a5.id)]);
    } finally {
      proxy.mode = "ok";
    }
    const codes = rs.map((r) => r.status).sort();
    ok(codes[0] === 200 && codes[1] === 202, `codes ${codes} ${JSON.stringify(rs.map((r) => r.data)).slice(0, 300)}`);
    const waiting = rs.find((r) => r.status === 202);
    ok(waiting.data.job?.status === "queued", JSON.stringify(waiting.data).slice(0, 200));
    ctx.a4 = a4.id;
    ctx.a5 = a5.id;
    return `${codes.join(",")}`;
  }, { needs: ["wsA"] });
  await step("동시", "큐 화면 열기 → 5초 drain으로 둘 다 draft_created, 원격 각 1개", async () => {
    await A.goto(`${APP}/publish`, { settle: 1000 });
    await A.waitText("발행 큐", 30000);
    await A.waitFor(() => [ctx.a4, ctx.a5].every((id) => jobsOf(id)[0]?.status === "draft_created"), 45000, "both draft_created");
    for (const id of [ctx.a4, ctx.a5]) {
      ok(stateOf(id) === "draft_created", `글 ${stateOf(id)}`);
      const posts = await wpPosts(id);
      ok(posts.length === 1 && posts[0].status === "draft", `원격 ${posts.length}개`);
    }
    await A.waitFor(`[...document.querySelectorAll('.pq-row')].filter(r => r.innerText.includes('완료')).length >= 2`, 15000, "완료 rows");
    ctx.screen = true;
    return "both draft_created";
  }, { needs: ["a4"] });
  await step("화면", "재시도 예정 행 표시, 키보드(Tab→Enter)로 취소", async () => {
    const title = `큐 키보드 취소 ${stamp}`;
    await A.waitFor(`[...document.querySelectorAll('.pq-row')].some(r => r.innerText.includes(${JSON.stringify(title)}) && r.innerText.includes('재시도 예정'))`, 15000, "retry row");
    await A.eval(`[...document.querySelectorAll('.pq-row')].find(r => r.innerText.includes(${JSON.stringify(title)})).querySelector('a').focus()`);
    await A.key("Tab");
    const f = await A.focused();
    ok(/^BUTTON .*취소/.test(f), `focus=${f}`);
    await A.key("Enter");
    await A.waitFor(() => jobsOf(ctx.a7)[0]?.status === "cancelled", 15000, "cancelled");
    ok(stateOf(ctx.a7) === "publish_failed", `글 ${stateOf(ctx.a7)}`);
    await A.waitText("발행을 취소했어요");
    return "Enter로 취소";
  }, { needs: ["screen", "a7"] });

  // ===== 복구 재시도 =====
  await step("실패", "WP 복구 후 재시도 시각 도래 → drain draft_created, 원격 1개(attempts 2)", async () => {
    await A.goto(`${APP}/`, { settle: 500 }); // leave the queue screen so it does not drain in parallel
    sql(`update publish_jobs set next_attempt_at = now() - interval '1 second' where article_id = '${ctx.a6}' and status = 'queued'`);
    const r = await A.api("POST", "/api/publish/drain", {});
    ok(r.status === 200 && r.data.processed === 1 && r.data.job?.status === "succeeded", `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    const [j] = jobsOf(ctx.a6);
    ok(j.status === "draft_created" && j.attempts === 2, JSON.stringify(j));
    ok(stateOf(ctx.a6) === "draft_created", `글 ${stateOf(ctx.a6)}`);
    ok((await wpPosts(ctx.a6)).length === 1, "원격 중복");
    return "attempts 2";
  }, { needs: ["a6"] });

  // ===== viewer =====
  await step("권한", "viewer: drain·접수·취소 403, 조회 200(canEdit=false)", async () => {
    await B.goto(`${APP}/login`);
    const s = await B.api("POST", "/api/auth/signup", { email: emailB, password: PW });
    ok(s.status === 200, `signup ${s.status}`);
    await B.api("GET", "/api/session");
    const uid = sql(`select id from auth.users where email = '${emailB}'`);
    sql(`insert into memberships (workspace_id, user_id, role) values ('${ctx.wsA}', '${uid}', 'viewer')`);
    const sw = await B.api("POST", "/api/workspaces/active", { id: ctx.wsA });
    ok(sw.status === 200, `switch ${sw.status}`);
    ok((await B.api("GET", "/api/session")).data?.user?.role === "viewer", "role != viewer");
    const a = await exportReady(A, `큐 viewer ${stamp}`);
    const q = await A.api("POST", "/api/publish/jobs", { articleId: a.id });
    ok(q.status === 202, `A 접수 ${q.status}`);
    const drain = await B.api("POST", "/api/publish/drain", {});
    const enq = await B.api("POST", "/api/publish/jobs", { articleId: a.id });
    const cancel = await B.api("POST", `/api/publish/jobs/${q.data.job.id}/cancel`, {});
    const get = await B.api("GET", "/api/publish/jobs");
    ok(drain.status === 403 && enq.status === 403 && cancel.status === 403, `drain ${drain.status} enq ${enq.status} cancel ${cancel.status}`);
    ok(get.status === 200 && get.data.canEdit === false, `GET ${get.status} ${get.data?.canEdit}`);
    ok(jobsOf(a.id)[0].status === "queued" && jobsOf(a.id)[0].attempts === 0, JSON.stringify(jobsOf(a.id)));
    await B.goto(`${APP}/publish`, { settle: 1000 });
    await B.waitText("조회만 할 수 있어요", 30000);
    ok(!(await B.eval(`[...document.querySelectorAll('.pq-row button')].some(b => b.innerText.includes('취소'))`)), "viewer에 취소 버튼");
    // leave A's job for the owner's queue screen; cancel it so later steps stay deterministic
    await A.api("POST", `/api/publish/jobs/${q.data.job.id}/cancel`, {});
    return "403/403/403, GET 200";
  }, { needs: ["wsA"] });

  // ===== 3구간 =====
  for (const w of [500, 768, 1440]) {
    await step("반응형", `큐 화면 ${w}px 가로 넘침 0`, async () => {
      await A.viewport(w);
      await A.goto(`${APP}/publish`, { settle: 1200 });
      await A.waitFor(`document.querySelectorAll('.pq-row').length > 0`, 30000, "rows");
      const o = await A.overflow();
      await A.screenshot(resolve(SHOTS, `publish-${w}.png`));
      ok(!o.over && !o.scrollable, `over ${JSON.stringify(o)}`);
      return `${o.sw}/${o.w}`;
    }, { needs: ["screen"] });
  }

  ctx.consoleErrors = { A: A.errors.slice(0, 10), B: B.errors.slice(0, 10) };
} finally {
  await browser.close();
  server.kill();
  proxyServer.close();
}

// ---- report -----------------------------------------------------------------------------------
const count = (s) => results.filter((r) => r.status === s).length;
const lines = [
  `# 발행 큐 e2e 결과 (${new Date().toISOString()})`,
  "",
  `환경: next dev 127.0.0.1:${APP_PORT} · 로컬 Supabase(60321) · WordPress(${WP}, 프록시 ${PROXY_PORT}) · 헤드리스 Chrome(CDP)`,
  `사용자: A=${emailA}, B=${emailB} (테스트 전용)`,
  `합계: PASS ${count("PASS")} · FAIL ${count("FAIL")} · SKIP ${count("SKIP")}`,
  "",
  "| 흐름 | 시나리오 | 결과 | 근거/오류 |",
  "|---|---|---|---|",
  ...results.map((r) => `| ${r.flow} | ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300)} |`),
  "",
  `브라우저 예외: ${JSON.stringify(ctx.consoleErrors ?? {}).slice(0, 800)}`,
];
writeFileSync(resolve(OUT, "results.md"), lines.join("\n"));
writeFileSync(resolve(OUT, "results.json"), JSON.stringify({ results, ctx }, null, 2));
mkdirSync(FINAL, { recursive: true });
for (const d of ["shots", "results.md", "results.json", "next-dev.log"]) cpSync(resolve(OUT, d), resolve(FINAL, d), { recursive: true });
console.log(`\nPASS ${count("PASS")} FAIL ${count("FAIL")} SKIP ${count("SKIP")} -> ${resolve(FINAL, "results.md")}`);
process.exit(count("FAIL") ? 1 : 0);
