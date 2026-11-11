// Minimal Chrome DevTools Protocol driver for the W8 browser e2e (no new dependencies:
// Node 24 global WebSocket + a locally installed Chrome/Edge).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ port = 9333, userDataDir }) {
  const exe = CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error("Chrome/Edge not found");
  mkdirSync(userDataDir, { recursive: true });
  const proc = spawn(
    exe,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      "--lang=ko-KR",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let ws;
  for (let i = 0; i < 60 && !ws; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      ws = v.webSocketDebuggerUrl;
    } catch {
      await sleep(250);
    }
  }
  if (!ws) throw new Error("Chrome did not expose a DevTools endpoint");
  const browser = new Browser(ws, proc);
  await browser.open();
  return browser;
}

export class Browser {
  constructor(url, proc) {
    this.url = url;
    this.proc = proc;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (m) => {
        const msg = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, method } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
          else resolve(msg.result);
        } else if (msg.method) for (const l of this.listeners) l(msg);
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Isolated cookie/storage context (one per user). */
  async newPage({ width = 1280, height = 900, downloadPath } = {}) {
    const { browserContextId } = await this.send("Target.createBrowserContext", { disposeOnDetach: true });
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, sessionId, browserContextId);
    await page.init({ width, height, downloadPath });
    return page;
  }
  async close() {
    try {
      await this.send("Browser.close");
    } catch {}
    try {
      this.proc.kill();
    } catch {}
  }
}

export class Page {
  constructor(browser, sessionId, contextId) {
    this.b = browser;
    this.s = sessionId;
    this.contextId = contextId;
    this.dialogs = [];
    this.errors = [];
    this.routes = [];
    this.downloads = [];
    this.loaded = 0;
  }
  send(method, params) {
    return this.b.send(method, params, this.s);
  }
  async init({ width, height, downloadPath }) {
    this.b.on((msg) => {
      if (msg.method === "Browser.downloadProgress" && msg.params.state === "completed") this.downloads.push(msg.params);
      if (msg.sessionId !== this.s) return;
      const p = msg.params;
      if (msg.method === "Page.loadEventFired") this.loaded++;
      if (msg.method === "Page.javascriptDialogOpening") {
        this.dialogs.push(p.message);
        this.send("Page.handleJavaScriptDialog", { accept: this.acceptDialogs !== false }).catch(() => {});
      }
      if (msg.method === "Runtime.exceptionThrown")
        this.errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text);
      if (msg.method === "Fetch.requestPaused") this.onPaused(p);
    });
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    // next dev: files written elsewhere in the workspace (other workers, logs) make Turbopack
    // push "reloadPage" to every open tab, which would restart the flow mid-test. Hydration
    // needs the HMR socket, so only the reload messages are dropped.
    await this.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { const W = window.WebSocket; window.WebSocket = new Proxy(W, { construct(t, a) { const ws = new t(...a); if (String(a[0]).includes("/_next/hmr")) ws.addEventListener("message", (e) => { if (typeof e.data === "string" && /reloadPage|"restart"/.test(e.data)) e.stopImmediatePropagation(); }); return ws; } }); })()`,
    });
    await this.viewport(width, height);
    if (downloadPath) {
      mkdirSync(downloadPath, { recursive: true });
      await this.b.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath,
        browserContextId: this.contextId,
        eventsEnabled: true,
      });
    }
  }
  async viewport(width, height = 900) {
    this.width = width;
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
  }
  async goto(url, { settle = 600 } = {}) {
    await this.send("Page.navigate", { url });
    await this.waitFor(
      `document.readyState === "complete" && location.href !== "about:blank"`,
      90000,
      `load ${url}`,
    );
    await this.hydrated();
    await sleep(settle);
  }
  /** React has attached to the DOM (event handlers work). */
  hydrated() {
    return this.waitFor(
      `!!document.body && [...document.querySelectorAll("button, input, a")].some((e) => Object.keys(e).some((k) => k.startsWith("__reactProps")))`,
      90000,
      "hydration",
    );
  }
  async reload() {
    await this.send("Page.reload", {});
    await sleep(300);
    await this.waitFor(`document.readyState === "complete"`, 90000, "reload");
    await this.hydrated();
    await sleep(600);
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  /** fn: node-side predicate or in-page expression string. */
  async waitFor(fn, timeout = 20000, what = "condition") {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = typeof fn === "string" ? await this.eval(fn) : await fn();
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(200);
    }
    throw new Error(`timeout waiting for ${what}${typeof last === "string" ? ` (${last.slice(0, 120)})` : ""}`);
  }
  waitText(text, timeout = 20000) {
    return this.waitFor(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`, timeout, `text "${text}"`);
  }
  hasText(text) {
    return this.eval(`document.body.innerText.includes(${JSON.stringify(text)})`);
  }
  text(selector) {
    return this.eval(`(document.querySelector(${JSON.stringify(selector)})||{}).innerText||""`);
  }
  /** Sets a React-controlled input/select/textarea value. */
  async fill(selector, value) {
    await this.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 20000, `element ${selector}`);
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
      if (!(el instanceof HTMLSelectElement)) el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    })()`);
  }
  /** Clicks the first visible enabled button/link whose text or aria-label contains `label`. */
  async clickText(label, { selector = "button, a, [role=button], summary", exact = false, timeout = 20000 } = {}) {
    const expr = `(() => {
      const want = ${JSON.stringify(label)};
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => {
        const t = (e.innerText || "").replace(/\\s+/g, " ").trim();
        const a = e.getAttribute("aria-label") || "";
        const ok = ${exact} ? (t === want || a === want) : (t.includes(want) || a.includes(want));
        return ok && !e.disabled && e.getAttribute("aria-disabled") !== "true" && e.getClientRects().length > 0;
      });
      if (!els.length) return false;
      els[0].scrollIntoView({ block: "center" });
      els[0].click();
      return true;
    })()`;
    await this.waitFor(expr, timeout, `clickable "${label}"`);
  }
  async click(selector) {
    await this.waitFor(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) return false; e.scrollIntoView({block:"center"}); e.click(); return true; })()`,
      20000,
      `click ${selector}`,
    );
  }
  async buttonState(label) {
    return this.eval(`(() => {
      const b = [...document.querySelectorAll("button")].find((e) => (e.innerText||"").includes(${JSON.stringify(label)}) || (e.getAttribute("aria-label")||"").includes(${JSON.stringify(label)}));
      return b ? (b.disabled ? "disabled" : "enabled") : "missing";
    })()`);
  }
  async key(key, { shift = false } = {}) {
    const map = {
      Tab: { code: "Tab", keyCode: 9 },
      Enter: { code: "Enter", keyCode: 13, text: "\r" },
      Escape: { code: "Escape", keyCode: 27 },
      " ": { code: "Space", keyCode: 32, text: " " },
      ArrowDown: { code: "ArrowDown", keyCode: 40 },
    };
    const k = map[key];
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: shift ? 8 : 0 };
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(80);
  }
  focused() {
    return this.eval(`(() => { const e = document.activeElement; if (!e || e === document.body) return "body"; return (e.tagName + " " + (e.getAttribute("aria-label") || e.innerText || e.id || e.getAttribute("href") || "")).replace(/\\s+/g," ").trim().slice(0,80); })()`);
  }
  async upload(selector, files) {
    const { root } = await this.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`file input ${selector} not found`);
    await this.send("DOM.setFileInputFiles", { nodeId, files });
  }
  async screenshot(path, { full = true } = {}) {
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return path;
  }
  /** Horizontal overflow check for the responsive breakpoints. */
  overflow() {
    return this.eval(`(() => {
      const w = document.documentElement.clientWidth;
      const sw = document.documentElement.scrollWidth;
      const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.split(" ")[0] : "");
      // Outermost elements sticking out past the viewport, widest first.
      const wide = [...document.querySelectorAll("body *")].filter((e) => {
        const r = e.getBoundingClientRect();
        if (!(r.width > 0 && r.right > w + 1)) return false;
        const p = e.parentElement; const pr = p && p.getBoundingClientRect();
        return !pr || pr.right <= w + 1;
      }).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
        .slice(0, 4).map((e) => name(e) + "@" + Math.round(e.getBoundingClientRect().right));
      window.scrollTo(200, window.scrollY);
      const scrollable = window.scrollX > 0;
      window.scrollTo(0, window.scrollY);
      return { w, sw, over: sw > w + 1, scrollable, wide };
    })()`);
  }
  /** Intercepts requests: handler(request) -> {status, body} | "fail" | undefined (continue). */
  async route(urlPattern, handler) {
    this.routes.push({ urlPattern, handler });
    await this.send("Fetch.enable", { patterns: this.routes.map((r) => ({ urlPattern: r.urlPattern, requestStage: "Request" })) });
    return async () => {
      this.routes = this.routes.filter((r) => r.handler !== handler);
      if (this.routes.length)
        await this.send("Fetch.enable", { patterns: this.routes.map((r) => ({ urlPattern: r.urlPattern, requestStage: "Request" })) });
      else await this.send("Fetch.disable");
    };
  }
  async onPaused(p) {
    const route = this.routes.find((r) => new RegExp(r.urlPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")).test(p.request.url));
    const res = route ? route.handler(p.request) : undefined;
    try {
      if (res === "fail") await this.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionRefused" });
      else if (res)
        await this.send("Fetch.fulfillRequest", {
          requestId: p.requestId,
          responseCode: res.status,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          body: Buffer.from(JSON.stringify(res.body ?? {})).toString("base64"),
        });
      else await this.send("Fetch.continueRequest", { requestId: p.requestId });
    } catch {}
  }
  /** Same-origin JSON call from inside the page (uses the page's session cookie). */
  api(method, url, body) {
    return this.eval(`fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json" }, ${
      body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`
    } }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))`);
  }
}

export { sleep };
