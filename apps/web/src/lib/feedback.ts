/** Toast / snackbar state: one notice at a time, auto-dismiss, pausable. No React, so it is unit-testable. */
export const TOAST_MS = 4000;
export const SNACKBAR_MS = 8000;
/** After a hover/focus pause the notice stays at least this long so the user can still reach it. */
export const MIN_RESUME_MS = 1500;

export type NoticeAction = { label: string; onAction: () => void };
export type Notice = {
  id: number;
  kind: "toast" | "snackbar";
  message: string;
  action?: NoticeAction;
};

export function createFeedbackStore() {
  let current: Notice | null = null;
  let nextId = 1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remaining = 0;
  let startedAt = 0;
  const holds = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  function dismiss() {
    clear();
    if (!current) return;
    current = null;
    emit();
  }
  function arm(ms: number) {
    clear();
    remaining = ms;
    startedAt = Date.now();
    timer = setTimeout(dismiss, ms);
  }
  function show(kind: Notice["kind"], message: string, action?: NoticeAction) {
    current = { id: nextId++, kind, message, action };
    holds.clear();
    arm(kind === "snackbar" ? SNACKBAR_MS : TOAST_MS);
    emit();
  }
  return {
    toast: (message: string) => show("toast", message),
    snackbar: (message: string, action: NoticeAction) => show("snackbar", message, action),
    dismiss,
    /**
     * Hover or keyboard focus inside the notice stops the countdown. It restarts only when
     * no source is holding it any more (leaving with the mouse does not resume while focused).
     */
    hold(source: "hover" | "focus", on: boolean) {
      if (on) holds.add(source);
      else holds.delete(source);
      if (holds.size > 0) {
        if (!timer) return;
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
        clear();
      } else if (current && !timer) {
        arm(Math.max(remaining, MIN_RESUME_MS));
      }
    },
    /** Runs the action once and closes the notice. */
    runAction() {
      const action = current?.action;
      dismiss();
      action?.onAction();
    },
    getState: () => current,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}
export type FeedbackStore = ReturnType<typeof createFeedbackStore>;

/** Puts `item` back at its original index (clamped), for undoing a removal. */
export function insertAt<T>(list: readonly T[], item: T, index: number): T[] {
  const i = Math.min(Math.max(index, 0), list.length);
  return [...list.slice(0, i), item, ...list.slice(i)];
}

/** Undoes several removals (recorded in deletion order) so every item returns to its original place. */
export function restoreRemoved<T>(list: readonly T[], removed: readonly { item: T; index: number }[]): T[] {
  let out = [...list];
  for (let i = removed.length - 1; i >= 0; i--) out = insertAt(out, removed[i].item, removed[i].index);
  return out;
}

/** Ctrl/Cmd+Z, unless the user is typing (the browser's own undo must keep working there). */
export function isUndoShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: unknown;
}): boolean {
  if (e.key.toLowerCase() !== "z" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = t?.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return false;
  return true;
}
