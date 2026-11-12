"use client";
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { X } from "lucide-react";
import { createFeedbackStore, isUndoShortcut, type FeedbackStore, type Notice, type NoticeAction } from "@/lib/feedback";

type Feedback = {
  /** Success only, disappears by itself. */
  toast: (message: string) => void;
  /** Result plus a follow-up action (undo, retry). Stays longer, pauses on hover/focus. Ctrl+Z runs the action. */
  snackbar: (message: string, action: NoticeAction) => void;
  /** The notice being shown right now (to merge repeated actions into one snackbar). */
  current: () => Notice | null;
};
const none: Feedback = { toast: () => {}, snackbar: () => {}, current: () => null };
const Ctx = createContext<Feedback>(none);
export const useFeedback = () => useContext(Ctx);

/** Mounted once in the root layout. The live region is always rendered so announcements are read. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [store] = useState<FeedbackStore>(createFeedbackStore);
  const [api] = useState<Feedback>(() => ({ toast: store.toast, snackbar: store.snackbar, current: store.getState }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!store.getState()?.action || !isUndoShortcut(e)) return;
      e.preventDefault();
      store.runAction();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <FeedbackRegion store={store} />
    </Ctx.Provider>
  );
}

export function FeedbackRegion({ store }: { store: FeedbackStore }) {
  const notice = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useEffect(() => () => store.dismiss(), [store]);
  return (
    <div className="feedback-region">
      {/* Only the message is announced; buttons stay outside the live region. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {notice?.message}
      </div>
      {notice && (
        <div
          key={notice.id}
          className={`feedback-notice ${notice.kind}`}
          data-kind={notice.kind}
          onMouseEnter={() => store.hold("hover", true)}
          onMouseLeave={() => store.hold("hover", false)}
          onFocus={() => store.hold("focus", true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) store.hold("focus", false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") store.dismiss();
          }}
        >
          <span className="feedback-message" aria-hidden="true">
            {notice.message}
          </span>
          {notice.action && (
            <button type="button" className="feedback-action" onClick={store.runAction}>
              {notice.action.label}
              <kbd className="feedback-key">Ctrl+Z</kbd>
            </button>
          )}
          {notice.kind === "snackbar" && (
            <button type="button" className="feedback-close" aria-label="알림 닫기" onClick={store.dismiss}>
              <X size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
