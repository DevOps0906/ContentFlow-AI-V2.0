import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFeedbackStore, insertAt, isUndoShortcut, restoreRemoved, MIN_RESUME_MS, SNACKBAR_MS, TOAST_MS } from "../src/lib/feedback";
import { FeedbackRegion } from "../src/components/feedback";
import { RowMenu } from "../src/components/row-menu";

const timers = () => mock.timers.enable({ apis: ["setTimeout", "Date"] });

test("toast disappears by itself after ~4s", () => {
  timers();
  try {
    const s = createFeedbackStore();
    s.toast("링크를 복사했어요");
    assert.equal(s.getState()?.kind, "toast");
    mock.timers.tick(TOAST_MS - 1);
    assert.ok(s.getState());
    mock.timers.tick(1);
    assert.equal(s.getState(), null);
  } finally {
    mock.timers.reset();
  }
});

test("a new notice replaces the current one and restarts the timer", () => {
  timers();
  try {
    const s = createFeedbackStore();
    s.toast("첫 번째");
    mock.timers.tick(3000);
    s.snackbar("두 번째", { label: "실행 취소", onAction: () => {} });
    assert.equal(s.getState()?.message, "두 번째");
    mock.timers.tick(TOAST_MS); // the first toast timer must not close the snackbar
    assert.equal(s.getState()?.message, "두 번째");
    mock.timers.tick(SNACKBAR_MS - TOAST_MS);
    assert.equal(s.getState(), null);
  } finally {
    mock.timers.reset();
  }
});

test("snackbar lasts at least 8s, stops while hovered/focused and resumes", () => {
  timers();
  try {
    const s = createFeedbackStore();
    s.snackbar("키워드를 삭제했어요.", { label: "실행 취소", onAction: () => {} });
    assert.ok(SNACKBAR_MS >= 8000);
    mock.timers.tick(7000);
    s.hold("hover", true);
    mock.timers.tick(60_000);
    assert.ok(s.getState(), "paused notice must stay");
    s.hold("hover", false);
    mock.timers.tick(MIN_RESUME_MS - 1);
    assert.ok(s.getState());
    mock.timers.tick(1);
    assert.equal(s.getState(), null);
  } finally {
    mock.timers.reset();
  }
});

test("focus inside keeps the notice even after the mouse leaves", () => {
  timers();
  try {
    const s = createFeedbackStore();
    s.snackbar("삭제했어요", { label: "실행 취소", onAction: () => {} });
    s.hold("hover", true);
    s.hold("focus", true);
    s.hold("hover", false);
    mock.timers.tick(60_000);
    assert.ok(s.getState());
    s.hold("focus", false);
    mock.timers.tick(SNACKBAR_MS);
    assert.equal(s.getState(), null);
  } finally {
    mock.timers.reset();
  }
});

test("Ctrl+Z is an undo shortcut except while typing", () => {
  const base = { key: "z", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
  assert.equal(isUndoShortcut({ ...base, target: { tagName: "BODY" } }), true);
  assert.equal(isUndoShortcut({ ...base, key: "Z", ctrlKey: false, metaKey: true, target: { tagName: "BUTTON" } }), true);
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) assert.equal(isUndoShortcut({ ...base, target: { tagName } }), false);
  assert.equal(isUndoShortcut({ ...base, target: { tagName: "DIV", isContentEditable: true } }), false);
  assert.equal(isUndoShortcut({ ...base, shiftKey: true, target: { tagName: "BODY" } }), false);
  assert.equal(isUndoShortcut({ ...base, ctrlKey: false, target: { tagName: "BODY" } }), false);
});

test("several removals are restored to their original order", () => {
  const list = ["a", "b", "c", "d", "e"];
  const removed: { item: string; index: number }[] = [];
  let cur = [...list];
  for (const x of ["d", "b", "e"]) {
    removed.push({ item: x, index: cur.indexOf(x) });
    cur = cur.filter((y) => y !== x);
  }
  assert.deepEqual(restoreRemoved(cur, removed), list);
});

test("undo action runs once, then closes the snackbar", () => {
  timers();
  try {
    const s = createFeedbackStore();
    let calls = 0;
    s.snackbar("삭제했어요", { label: "실행 취소", onAction: () => calls++ });
    s.runAction();
    s.runAction();
    assert.equal(calls, 1);
    assert.equal(s.getState(), null);
  } finally {
    mock.timers.reset();
  }
});

test("insertAt restores the same item at the same position", () => {
  const list = ["a", "b", "c", "d"];
  const removed = list[2];
  const after = list.filter((x) => x !== removed);
  assert.deepEqual(insertAt(after, removed, 2), list);
  assert.deepEqual(insertAt(after, removed, 99), ["a", "b", "d", "c"]);
  assert.deepEqual(insertAt(after, removed, -1), ["c", "a", "b", "d"]);
});

test("live region is always rendered and announces politely", () => {
  const s = createFeedbackStore();
  const empty = renderToStaticMarkup(createElement(FeedbackRegion, { store: s }));
  assert.match(empty, /role="status"/);
  assert.match(empty, /aria-live="polite"/);
  assert.doesNotMatch(empty, /feedback-notice/);
  s.snackbar("곡을 제거했어요", { label: "실행 취소", onAction: () => {} });
  const html = renderToStaticMarkup(createElement(FeedbackRegion, { store: s }));
  assert.match(html, /곡을 제거했어요/);
  assert.match(html, /실행 취소/);
  assert.match(html, /aria-label="알림 닫기"/);
  assert.match(html, /Ctrl\+Z/);
  // buttons are outside the live region
  const live = html.match(/<div[^>]*role="status"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
  assert.match(live, /곡을 제거했어요/);
  assert.doesNotMatch(live, /<button/);
  s.dismiss();
});

test("toast has no action or close button", () => {
  const s = createFeedbackStore();
  s.toast("링크를 복사했어요");
  const html = renderToStaticMarkup(createElement(FeedbackRegion, { store: s }));
  assert.doesNotMatch(html, /<button/);
  s.dismiss();
});

test("row menu trigger is a labelled menu button, closed by default", () => {
  // No window on the server: the narrow-screen hook falls back to the desktop menu.
  (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  try {
    const html = renderToStaticMarkup(
      createElement(RowMenu, { label: "글 작업 더보기", items: [{ label: "삭제", onSelect() {} }] }),
    );
    assert.match(html, /aria-label="글 작업 더보기"/);
    assert.match(html, /aria-haspopup="menu"/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /role="menu"/);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
