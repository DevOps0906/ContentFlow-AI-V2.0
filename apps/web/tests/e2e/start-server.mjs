// Starts the W8 test stack: a fake OpenAI-compatible server and `next dev` wired to the local
// Supabase stack and the throwaway WordPress container. No real keys, no external hosts.
//   node tests/e2e/start-server.mjs <wp-credentials-file>
// The WordPress file holds two lines: username, application password (local container only).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, createWriteStream, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../..");
const root = resolve(web, "../..");
export const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3392);
export const AI_PORT = Number(process.env.E2E_AI_PORT ?? 4791);

// ---- fake AI -------------------------------------------------------------------------------
const state = { mode: "ok", calls: [] };
function draftFrom(messages) {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const headings = (user.split("사용할 소제목:\n")[1] ?? "## 본문").split("\n").filter((l) => l.startsWith("## "));
  const kw = /핵심 키워드: (.+)/.exec(user)?.[1] ?? "키워드";
  return headings
    .map((h, i) => `${h}\n${kw}에 대한 ${i + 1}번째 단락입니다. 공식 문서 기준으로 확인한 절차를 정리했습니다. [확인 필요]`)
    .join("\n\n");
}
const ai = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url === "/__mode") {
      state.mode = JSON.parse(raw || "{}").mode ?? "ok";
      res.end(JSON.stringify({ mode: state.mode }));
      return;
    }
    if (req.url === "/__calls") {
      res.end(JSON.stringify(state.calls));
      return;
    }
    const body = JSON.parse(raw || "{}");
    const auth = req.headers.authorization ?? "";
    state.calls.push({ url: req.url, model: body.model, auth: auth === "Bearer fake-e2e-key" });
    if (state.mode === "fail") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fake upstream failure" } }));
      return;
    }
    const system = body.messages?.find((m) => m.role === "system")?.content ?? "";
    const review = /검수|JSON/.test(system) && !/초안 작성 보조자/.test(system);
    const content = review
      ? JSON.stringify([
          { severity: "high", kind: "missing-source", quote: "공식 문서 기준", message: "근거 문서 링크가 본문에 없습니다." },
          { severity: "low", kind: "tone", quote: "", message: "문장 길이를 줄이면 읽기 쉽습니다." },
        ])
      : draftFrom(body.messages ?? []);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "fake",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 340, total_tokens: 460 },
      }),
    );
  });
});
ai.listen(AI_PORT, "127.0.0.1");

// ---- next dev ------------------------------------------------------------------------------
const envFile = readFileSync(resolve(root, ".env"), "utf8");
const publishable = /^SUPABASE_PUBLISHABLE_KEY=(.+)$/m.exec(envFile)?.[1]?.trim();
const [wpUser, wpPass] = readFileSync(process.argv[2], "utf8").trim().split(/\r?\n/);
// Keep the log outside the watched project tree: writes inside it trigger dev recompiles/reloads.
const logPath = process.env.E2E_SERVER_LOG ?? resolve(process.env.TEMP ?? "/tmp", "w8-next-dev.log");
mkdirSync(dirname(logPath), { recursive: true });
const log = createWriteStream(logPath);
const child = spawn(process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "dev", "-p", String(APP_PORT), "--hostname", "127.0.0.1"], {
  cwd: web,
  env: {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    SUPABASE_URL: "http://127.0.0.1:60321",
    SUPABASE_PUBLISHABLE_KEY: publishable,
    COOKIE_SECURE: "false",
    ALLOW_SIGNUP: "true",
    APP_URL: `http://127.0.0.1:${APP_PORT}`,
    OPENAI_API_KEY: "fake-e2e-key",
    OPENAI_BASE_URL: `http://127.0.0.1:${AI_PORT}/v1`,
    OPENAI_MODEL: "fake-writer",
    QA_MODEL: "fake-reviewer",
    AI_PRICE_INPUT_PER_1M: "1",
    AI_PRICE_OUTPUT_PER_1M: "2",
    AI_PRICE_CURRENCY: "USD",
    WP_BASE_URL: "http://127.0.0.1:8081",
    WP_USERNAME: wpUser,
    WP_APP_PASSWORD: wpPass,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(log);
child.stderr.pipe(log);
const stop = () => {
  child.kill();
  ai.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (c) => {
  ai.close();
  process.exit(c ?? 0);
});
