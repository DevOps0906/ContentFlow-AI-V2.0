// Overflow diagnosis (read-only): node tests/e2e/diag-overflow.mjs <email> <password>
import { launchChrome } from "./cdp.mjs";
import { writeFileSync } from "node:fs";
const APP = "http://127.0.0.1:3392";
const [email, pw] = process.argv.slice(2);
const b = await launchChrome({ port: 9444, userDataDir: process.env.TEMP + "/diag-chrome" });
const P = await b.newPage({ width: 500 });
await P.goto(`${APP}/login`);
await P.fill("#email", email); await P.fill("#password", pw); await P.click("button[type=submit]");
await P.waitFor(`location.pathname === "/"`, 30000, "login");
const probe = (sel) => `(() => {
  const css = (e) => { const c = getComputedStyle(e); return { disp: c.display, ox: c.overflowX, minw: c.minWidth, w: c.width, gtc: c.gridTemplateColumns.slice(0,60), flex: c.flex, pos: c.position }; };
  const row = (e) => ({ n: e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).join(".") : ""), cw: e.clientWidth, sw: e.scrollWidth, rw: Math.round(e.getBoundingClientRect().width), ...css(e) });
  const vw = document.documentElement.clientWidth;
  const t = document.querySelector(${JSON.stringify(sel)});
  const chain = []; for (let e = t; e; e = e.parentElement) chain.push(row(e));
  const clipped = (e) => { for (let p = e.parentElement; p; p = p.parentElement) if (p !== document.documentElement && p !== document.body && getComputedStyle(p).overflowX !== "visible") return true; return false; };
  const culprits = [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right + scrollX > vw + 1 && !clipped(e) && getComputedStyle(e).position !== "fixed"; }).slice(0, 8).map((e) => ({ ...row(e), right: Math.round(e.getBoundingClientRect().right) }));
  return { vw, docSw: document.documentElement.scrollWidth, bodySw: document.body.scrollWidth, chain, culprits };
})()`;
const cases = [["dashboard", "/", 500, "main table"], ["keywords", "/keywords", 500, "main table"], ["trends", "/trends", 768, "table.trend-table"], ["trends", "/trends", 1000, "table.trend-table"]];
const extra = (sel) => `(() => { const vw = document.documentElement.clientWidth; const t = document.querySelector(${JSON.stringify(sel)}); return [...document.querySelectorAll("body *")].filter((e) => { const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return r.right > vw + 1 && c.position !== "static" && c.display !== "none"; }).slice(0, 8).map((e) => ({ n: e.tagName.toLowerCase() + "." + String(e.className).split(" ")[0], pos: getComputedStyle(e).position, right: Math.round(e.getBoundingClientRect().right), cb: (e.offsetParent && e.offsetParent.tagName.toLowerCase() + "." + String(e.offsetParent.className).split(" ")[0]) })); })()`;
let md = "# Overflow 진단\n\n";
for (const [name, path, w, sel] of cases) {
  await P.viewport(w, 900); await P.goto(`${APP}${path}`, { settle: 2000 });
  const r = await P.eval(probe(sel));
  md += `## ${name} @${w}px — viewport ${r.vw}, html.scrollWidth ${r.docSw}, body.scrollWidth ${r.bodySw}\n\n### 표→html 조상 체인\n\n| 요소 | clientW | scrollW | rectW | display | overflow-x | min-width | width | grid-cols | flex |\n|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const c of r.chain) md += `| ${c.n} | ${c.cw} | ${c.sw} | ${c.rw} | ${c.disp} | ${c.ox} | ${c.minw} | ${c.w} | ${c.gtc} | ${c.flex} |\n`;
  md += `\n### 클립돼도 viewport 밖에 있는 positioned 요소(후보)\n\n` + JSON.stringify(await P.eval(extra(sel))) + "\n";
  md += `\n### html.scrollWidth를 키우는 요소(조상에 overflow 클립 없음)\n\n`;
  md += r.culprits.length ? "| 요소 | right | rectW | scrollW | display | min-width | width | grid-cols |\n|---|---|---|---|---|---|---|---|\n" + r.culprits.map((c) => `| ${c.n} | ${c.right} | ${c.rw} | ${c.sw} | ${c.disp} | ${c.minw} | ${c.w} | ${c.gtc} |`).join("\n") + "\n\n" : "없음\n\n";
}
writeFileSync("D:/WorkSpace/DEV/ContentFlow-AI-V2.0/.nomad/e2e/OVERFLOW_DIAG.md", md);
await b.close();
