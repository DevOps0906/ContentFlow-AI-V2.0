import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clampCenter, ignoreScrollAfterOpen, lockScroll, nextOpenOnClick, opensOnPointer, placeTooltip, wrapFocusIndex } from "../src/lib/overlay";
import { InfoTip, Tooltip } from "../src/components/tooltip";

test("tooltip: described element points at a role=tooltip bubble that is closed on first render", () => {
  const html = renderToStaticMarkup(
    createElement(Tooltip, { text: "신규 고객 1명 획득 비용", children: createElement("button", { "aria-label": "삭제 버튼" }, "x") }),
  );
  const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert.ok(id, html);
  assert.match(html, new RegExp(`<span[^>]*id="${id}"[^>]*role="tooltip"|<span[^>]*role="tooltip"[^>]*id="${id}"`));
  assert.ok(!html.includes("is-open"));
  assert.ok(html.includes("신규 고객 1명 획득 비용"));
});

test("tooltip: a label identical to the text is not announced twice", () => {
  const html = renderToStaticMarkup(createElement(Tooltip, { text: "삭제", children: createElement("button", { "aria-label": "삭제" }, "x") }));
  assert.ok(!/<button[^>]*aria-describedby/.test(html), html);
});

test("tooltip: a disabled child makes the wrapper focusable and described", () => {
  const html = renderToStaticMarkup(
    createElement(Tooltip, { text: "AI가 연결되지 않았습니다.", children: createElement("button", { disabled: true }, "AI") }),
  );
  assert.match(html, /<span[^>]*tabindex="0"[^>]*aria-describedby=|<span[^>]*aria-describedby=[^>]*tabindex="0"/);
  assert.ok(!/<button[^>]*aria-describedby/.test(html), html);
});

test("info tip: a labelled button that is collapsed until tapped", () => {
  const html = renderToStaticMarkup(createElement(InfoTip, { label: "CAC 설명", text: "신규 고객 1명 획득 비용" }));
  assert.match(html, /aria-label="CAC 설명"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /role="tooltip"/);
});

test("hover opens for mouse and pen only; touch needs the info button", () => {
  assert.equal(opensOnPointer("mouse"), true);
  assert.equal(opensOnPointer("pen"), true);
  assert.equal(opensOnPointer("touch"), false);
});

test("tooltip stays inside the viewport", () => {
  assert.equal(clampCenter(5, 100, 400), 58);
  assert.equal(clampCenter(395, 100, 400), 342);
  assert.equal(clampCenter(200, 100, 400), 200);
});

test("drawer focus trap wraps Tab and Shift+Tab inside the panel", () => {
  assert.equal(wrapFocusIndex(2, 3, false), 0);
  assert.equal(wrapFocusIndex(0, 3, true), 2);
  assert.equal(wrapFocusIndex(1, 3, false), null);
  assert.equal(wrapFocusIndex(1, 3, true), null);
  // Focus outside the panel is pulled in; an empty panel is left alone.
  assert.equal(wrapFocusIndex(-1, 3, false), 0);
  assert.equal(wrapFocusIndex(-1, 3, true), 2);
  assert.equal(wrapFocusIndex(0, 0, false), null);
});

test("drawer scroll lock restores the previous overflow", () => {
  const body = { style: { overflow: "scroll" } };
  const unlock = lockScroll(body);
  assert.equal(body.style.overflow, "hidden");
  unlock();
  assert.equal(body.style.overflow, "scroll");
});

test("tooltip close is delayed so the pointer can reach the bubble", async () => {
  const { TOOLTIP_CLOSE_DELAY_MS } = await import("../src/lib/overlay");
  assert.ok(TOOLTIP_CLOSE_DELAY_MS >= 100 && TOOLTIP_CLOSE_DELAY_MS <= 300);
});

test("scroll right after opening is ignored, later scroll closes", () => {
  assert.equal(ignoreScrollAfterOpen(1000, 1050), true);
  assert.equal(ignoreScrollAfterOpen(1000, 1500), false);
});

test("info button: mouse click keeps it open, touch tap toggles", () => {
  assert.equal(nextOpenOnClick(true, "mouse"), true);
  assert.equal(nextOpenOnClick(false, "touch"), true);
  assert.equal(nextOpenOnClick(true, "touch"), false);
  assert.equal(nextOpenOnClick(true, ""), false); // keyboard Enter/Space toggles
});

test("placement: above, below when no room above, above again when below overflows, clamped", () => {
  const size = { width: 100, height: 30 };
  const vp = { width: 400, height: 600 };
  assert.deepEqual(placeTooltip({ top: 200, bottom: 220, left: 100, width: 20 }, size, vp), { left: 110, top: 194, below: false });
  assert.equal(placeTooltip({ top: 10, bottom: 30, left: 100, width: 20 }, size, vp).below, true);
  const tight = placeTooltip({ top: 10, bottom: 590, left: 100, width: 20 }, size, vp);
  assert.equal(tight.below, false);
  assert.ok(tight.top >= 38);
});

test("disabled child wrapper is a named, disabled button", () => {
  const html = renderToStaticMarkup(
    createElement(Tooltip, { text: "사유", label: "AI 초안 생성", children: createElement("button", { disabled: true }, "x") }),
  );
  assert.match(html, /role="button"/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /aria-label="AI 초안 생성"/);
});
