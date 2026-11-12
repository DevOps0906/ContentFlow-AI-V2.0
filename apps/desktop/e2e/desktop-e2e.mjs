// Desktop (Tauri) runtime e2e against the BUILT exe (no install). Windows only.
//   node apps/desktop/e2e/desktop-e2e.mjs [1..7]      (default: all)
// Drives the WebView2 via CDP (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS). Needs port 34110 free
// and no running ContentFlow app. Touches %LOCALAPPDATA%\ContentFlow\sidecar.pid (restored/removed)
// and the app's real WebView storage (the test article it creates is removed again).
// Scenario 2 really opens the system browser (tabs pointing at 127.0.0.1:9 / github).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REL = resolve(here, "../src-tauri/target/release");
const EXE = resolve(REL, "contentflow-desktop.exe");
const NODE = resolve(REL, "resources/node/node.exe");
const PIDFILE = resolve(process.env.LOCALAPPDATA, "ContentFlow/sidecar.pid");
const PORT = 34110;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const note = (id, status, detail) => {
  results.push({ id, status, detail });
  console.log(`${status} ${id} :: ${detail}`);
};

// ---- helpers -------------------------------------------------------------------------------
function procs() {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  try {
    const j = JSON.parse(r.stdout);
    return Array.isArray(j) ? j : [j];
  } catch {
    return [];
  }
}
const norm = (p) => (p ?? "").toLowerCase().replace(/\//g, "\\");
const ourNode = () => procs().filter((p) => norm(p.ExecutablePath) === norm(NODE));
const appProcs = () => procs().filter((p) => norm(p.ExecutablePath) === norm(EXE));
const alive = (pid) => procs().some((p) => p.ProcessId === pid);
function listening(port) {
  const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
  return r.stdout.split(/\r?\n/).filter((l) => l.includes("LISTENING") && l.includes(`:${port} `));
}
function killAll() {
  for (const p of appProcs()) spawnSync("taskkill", ["/F", "/PID", String(p.ProcessId)]);
  for (const p of ourNode()) spawnSync("taskkill", ["/F", "/PID", String(p.ProcessId)]);
  rmSync(PIDFILE, { force: true });
}
async function quitApp() {
  for (const p of appProcs()) spawnSync("taskkill", ["/PID", String(p.ProcessId)]); // WM_CLOSE
  for (let i = 0; i < 40 && appProcs().length; i++) await sleep(250);
  if (appProcs().length) killAll();
  for (let i = 0; i < 40 && ourNode().length; i++) await sleep(250);
}

let cdpPort = 9400;
function launch() {
  const port = ++cdpPort;
  const child = spawn(EXE, [], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  });
  child.unref();
  return { port, pid: child.pid };
}
async function targets(port) {
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === "page");
  } catch {
    return [];
  }
}
const pageUrl = async (port) => (await targets(port))[0]?.url ?? null;
async function waitUrl(port, pred, timeout = 40000) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    last = await pageUrl(port);
    if (last && pred(last)) return last;
    await sleep(300);
  }
  throw new Error(`timeout waiting for url (last: ${last})`);
}
/** One-shot Runtime.evaluate on the first page target. */
async function ev(port, expr) {
  const t = (await targets(port))[0];
  if (!t) throw new Error("no page target");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  const out = await new Promise((res, rej) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === 1) msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
  return out.result.value;
}
async function waitEv(port, expr, timeout = 30000, what = expr) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await ev(port, expr);
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(250);
  }
  throw new Error(`timeout: ${what} (${String(last).slice(0, 100)})`);
}
const hydrated = (port) =>
  waitEv(
    port,
    `document.readyState==="complete" && [...document.querySelectorAll("button,input,a")].some(e=>Object.keys(e).some(k=>k.startsWith("__reactProps")))`,
    60000,
    "hydration",
  );
const setVal = (sel, v) =>
  `(()=>{const el=document.querySelector(${JSON.stringify(sel)});const p=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,"value").set.call(el,${JSON.stringify(v)});el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return el.value})()`;
const clickText = (t) =>
  `(()=>{const b=[...document.querySelectorAll("button,a")].find(e=>(e.innerText||"").includes(${JSON.stringify(t)})&&!e.disabled);if(!b)return false;b.click();return true})()`;
const ARTICLES = `JSON.parse(localStorage.getItem("contentflow.articles.v2")||"[]")`;

async function startReady() {
  const app = launch();
  await waitUrl(app.port, (u) => u.startsWith(`http://127.0.0.1:${PORT}/`), 60000);
  await hydrated(app.port);
  return app;
}
const guard = async (id, fn) => {
  try {
    await fn();
  } catch (e) {
    note(id, "FAIL", String(e?.message ?? e).slice(0, 300));
  } finally {
    await quitApp();
    killAll();
  }
};

// ---- scenarios -----------------------------------------------------------------------------
const stamp = Date.now().toString(36);
const TITLE = `E2E 데스크톱 영속성 ${stamp}`;

async function t1() {
  let app = await startReady();
  await ev(app.port, `location.assign("/content/new")`);
  await waitEv(app.port, `!!document.querySelector("#title")`, 30000, "editor");
  await hydrated(app.port);
  await ev(app.port, setVal("#title", TITLE));
  await ev(app.port, setVal("#body", "데스크톱 재시작 후에도 남아야 하는 본문입니다."));
  await waitEv(app.port, clickText("임시 저장"), 10000, "save click");
  await waitEv(app.port, `${ARTICLES}.some(a=>a.title===${JSON.stringify(TITLE)})`, 15000, "saved to localStorage");
  const before = await ev(app.port, `${ARTICLES}.length`);
  await quitApp();
  if (appProcs().length || ourNode().length) throw new Error("app/node still running after quit");
  app = await startReady();
  await ev(app.port, `location.assign("/content")`);
  await waitEv(app.port, `document.body.innerText.includes(${JSON.stringify(TITLE)})`, 30000, "title visible in list after restart");
  const after = await ev(app.port, `${ARTICLES}.length`);
  // cleanup: remove only the test article
  await ev(app.port, `localStorage.setItem("contentflow.articles.v2", JSON.stringify(${ARTICLES}.filter(a=>a.title!==${JSON.stringify(TITLE)})))`);
  note("1 로컬 저장 영속성", "PASS", `저장 후 localStorage ${before}건 -> 앱 종료(프로세스 0) -> 재시작 후 ${after}건, 목록 화면에 제목 표시. 테스트 글 삭제함`);
}

async function t2() {
  const app = await startReady();
  const base = await pageUrl(app.port);
  const HOST = { a: "127.0.0.2", w: "127.0.0.3", n: "127.0.0.4" };
  const M = (k) => `http://${HOST[k]}:9/cf-e2e-${stamp}-${k}`;
  // poll the process table for a browser launch carrying our marker URL
  const hits = new Set();
  // Persistent PowerShell poller (a fresh Get-CimInstance per call is too slow to catch a short
  // launcher process): browser launch command lines carrying our markers, plus browser window titles.
  const ps = `$ErrorActionPreference='SilentlyContinue'; while($true){ Get-Process | ? { $_.Name -match 'chrome|msedge|firefox|brave|opera' -and $_.MainWindowTitle -match '127.0.0.[2-4]|DevOps0906' } | % { 'WIN|' + $_.Name + '|' + $_.MainWindowTitle }; Start-Sleep -Milliseconds 100 }`;
  const pollerProc = spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "pipe", "ignore"] });
  pollerProc.stdout.setEncoding("utf8");
  pollerProc.stdout.on("data", (d) => {
    for (const l of d.split(String.fromCharCode(10))) if (l.startsWith("WIN|")) hits.add(l.trim().slice(0, 120));
  });
  await sleep(2500);
  const poller = Promise.resolve();
  const fire = async (label, expr) => {
    await ev(app.port, expr);
    await sleep(3500);
    const now = await pageUrl(app.port);
    return { label, same: !!now && now.startsWith(`http://127.0.0.1:${PORT}/`), now };
  };
  const r = [];
  r.push(await fire("anchor target=_blank", `(()=>{const a=document.createElement("a");a.href=${JSON.stringify(M("a"))};a.target="_blank";document.body.appendChild(a);a.click();return 1})()`));
  r.push(await fire("window.open", `(()=>{window.open(${JSON.stringify(M("w"))},"_blank");return 1})()`));
  r.push(await fire("실제 사이드바 링크(프로젝트 가이드)", `(()=>{const a=[...document.querySelectorAll("a")].find(e=>e.target==="_blank"&&e.href.includes("github.com"));a.click();return a.href})()`));
  r.push(await fire("같은 창 location 이동", `(()=>{location.href=${JSON.stringify(M("n"))};return 1})()`));
  await sleep(1500);
  pollerProc.kill();
  const moved = r.filter((x) => !x.same);
  const hitList = [...hits];
  const detail = `창 이동 없음=${moved.length === 0} [${r.map((x) => x.label).join(", ")}]; 시스템 브라우저(Chrome) 창 제목 관측: ${hitList.join(" | ") || "없음"}`;
  const need = ["127.0.0.2", "127.0.0.3", "DevOps0906", "127.0.0.4"];
  const missing = need.filter((k) => !hitList.some((h) => h.includes(k)));
  if (moved.length) note("2 외부 링크", "FAIL", detail + ` / 이동한 창: ${moved.map((m) => m.now)}`);
  else if (missing.length) note("2 외부 링크", "FAIL", detail + ` / 브라우저 호출 미관측: ${missing}`);
  else note("2 외부 링크", "PASS", detail);
}

async function t3() {
  const blocker = createServer((s) => s.destroy());
  await new Promise((res, rej) => (blocker.once("error", rej), blocker.listen(PORT, "127.0.0.1", res)));
  try {
    const app = launch();
    const url = await waitUrl(app.port, (u) => u.includes("error.html"), 40000);
    await sleep(6000); // give a (wrong) fallback time to appear
    const msg = await waitEv(app.port, `document.getElementById("message")?.textContent`, 10000, "message");
    const still = await pageUrl(app.port);
    const nodes = ourNode();
    const lis = listening(PORT);
    const ok = url.includes("code=port_in_use") && msg.includes("34110") && nodes.length === 0 && lis.length === 1 && still === url;
    note("3 포트 점유", ok ? "PASS" : "FAIL", `url=${url}; 메시지="${msg}"; 내장 node 프로세스 ${nodes.length}개; 34110 LISTEN ${lis.length}개(점유자 1개); 6초 후 url 동일=${still === url}`);
  } finally {
    blocker.close();
  }
}

async function t4() {
  await startReady();
  const app = { port: cdpPort };
  const nodes = ourNode();
  if (nodes.length !== 1) throw new Error(`expected 1 sidecar node, got ${nodes.length}`);
  spawnSync("taskkill", ["/F", "/PID", String(nodes[0].ProcessId)]);
  const url = await waitUrl(app.port, (u) => u.includes("error.html"), 15000);
  const msg = await waitEv(app.port, `document.getElementById("message")?.textContent`, 10000, "message");
  await sleep(15000); // an auto reload/restart would show up here
  const later = await pageUrl(app.port);
  const respawned = ourNode().length;
  const lis = listening(PORT).length;
  const ok = url.includes("code=exited") && later === url && respawned === 0 && lis === 0;
  note("4 서버 강제 종료", ok ? "PASS" : "FAIL", `url=${url}; 메시지="${msg}"; 15초 후 url 동일=${later === url}; node 재생성 ${respawned}개; 34110 LISTEN ${lis}개`);
}

async function t5() {
  // sleeper = system node, a different executable path than the bundled node.exe
  const sysNode = process.execPath;
  const mk = (exe) => spawn(exe, ["-e", "setTimeout(()=>{},120000)"], { stdio: "ignore" });
  const run = async (label, lines) => {
    const sl = mk(sysNode);
    await sleep(500);
    mkdirSync(dirname(PIDFILE), { recursive: true });
    writeFileSync(PIDFILE, lines(sl.pid));
    let survived;
    try {
      await startReady();
      survived = alive(sl.pid);
    } finally {
      await quitApp();
      killAll();
      try {
        sl.kill();
      } catch {}
    }
    if (!survived) throw new Error(`${label}: unrelated process was killed`);
    return `${label}: 시작 성공, 무관한 node(pid ${sl.pid}) 생존=${survived}`;
  };
  const a = await run("A(pid 파일 경로=번들 node, pid=무관한 node)", (pid) => `${pid}\n${NODE}\n`);
  const b = await run("B(pid 파일 경로=무관한 exe)", (pid) => `${pid}\n${sysNode}\n`);
  // positive control: a process really running from the bundled node.exe IS cleaned
  const real = mk(NODE);
  await sleep(500);
  writeFileSync(PIDFILE, `${real.pid}\n${NODE}\n`);
  await startReady();
  const ctrlKilled = !alive(real.pid);
  await quitApp();
  killAll();
  try {
    real.kill();
  } catch {}
  note("5 stale sidecar.pid", ctrlKilled ? "PASS" : "FAIL", `${a}; ${b}; 대조군(실제 번들 node pid)은 정리됨=${ctrlKilled}`);
}


const occupy = async () => {
  const b = createServer((c) => c.destroy());
  await new Promise((res, rej) => (b.once("error", rej), b.listen(PORT, "127.0.0.1", res)));
  return b;
};
const release = (b) => new Promise((res) => b.close(() => res()));

async function t6() {
  // 6a: error screen -> release port -> click retry -> dashboard
  let b = await occupy();
  let app = launch();
  await waitUrl(app.port, (u) => u.includes("code=port_in_use"), 40000);
  await release(b);
  await waitEv(app.port, clickText("다시 시도"), 10000, "retry button");
  const url = await waitUrl(app.port, (u) => u.startsWith("http://127.0.0.1:" + PORT + "/"), 60000);
  await hydrated(app.port);
  const nodes = ourNode().length;
  const hasUi = await ev(app.port, "document.body.innerText.length > 50");
  note("6a 다시 시도 -> 대시보드", url.startsWith("http://127.0.0.1:" + PORT + "/") && nodes === 1 && hasUi ? "PASS" : "FAIL", "retry 클릭 후 url=" + url + "; 내장 node " + nodes + "개; 본문 렌더=" + hasUi);
  await quitApp();
  killAll();
  // 6b: error screen -> click quit -> app and node gone
  b = await occupy();
  try {
    app = launch();
    await waitUrl(app.port, (u) => u.includes("code=port_in_use"), 40000);
    await waitEv(app.port, clickText("종료"), 10000, "quit button");
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(500);
      gone = appProcs().length === 0;
    }
    const n = ourNode().length;
    note("6b 종료 버튼", gone && n === 0 ? "PASS" : "FAIL", "앱 프로세스 종료=" + gone + "; 내장 node " + n + "개");
  } finally {
    await release(b);
  }
}

async function t7() {
  const app = await startReady();
  const before = ourNode().map((p) => p.ProcessId);
  const url0 = await pageUrl(app.port);
  const call = (cmd) =>
    ev(app.port, "(async()=>{const i=window.__TAURI_INTERNALS__; if(!i||typeof i.invoke!=='function') return 'NO_BRIDGE'; try{await i.invoke('" + cmd + "'); return 'ALLOWED'}catch(e){return 'REJECTED: '+String(e).slice(0,120)}})()");
  const r1 = await call("retry");
  const r2 = await call("quit_app");
  await sleep(5000);
  const url1 = await pageUrl(app.port);
  const after = ourNode().map((p) => p.ProcessId);
  const appUp = appProcs().length > 0;
  const health = await ev(app.port, "fetch('/api/health').then(r=>r.status)").catch((e) => "ERR " + e.message);
  const denied = (r) => r.startsWith("REJECTED") || r === "NO_BRIDGE";
  const ok = denied(r1) && denied(r2) && appUp && url1 === url0 && after.length === 1 && after[0] === before[0];
  note("7 원격 출처 invoke 거부", ok ? "PASS" : "FAIL", "retry=" + r1 + "; quit_app=" + r2 + "; 앱 생존=" + appUp + "; url 동일=" + (url1 === url0) + "; node pid 동일=" + (after[0] === before[0]) + "; /api/health=" + health);
}

// ---- main ----------------------------------------------------------------------------------
if (!existsSync(EXE) || !existsSync(NODE)) {
  console.error("build first: scripts/desktop-build.ps1");
  process.exit(2);
}
if (listening(PORT).length || appProcs().length) {
  console.error("port 34110 busy or app already running; close it first");
  process.exit(2);
}
const pidBackup = existsSync(PIDFILE) ? readFileSync(PIDFILE) : null;
const want = process.argv.slice(2);
const all = { 1: t1, 2: t2, 3: t3, 4: t4, 5: t5, 6: t6, 7: t7 };
for (const [k, fn] of Object.entries(all)) {
  if (want.length && !want.includes(k)) continue;
  await guard(k, fn);
}
if (pidBackup) writeFileSync(PIDFILE, pidBackup);
console.log("\n=== SUMMARY ===");
for (const r of results) console.log(`${r.status} ${r.id}`);
process.exit(results.every((r) => r.status === "PASS") ? 0 : 1);
