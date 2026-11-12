"use client";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { useNarrow } from "./use-narrow";

export type RowMenuItem = { label: string; icon?: ReactNode; danger?: boolean; onSelect: () => void };

/** `⋯` row actions: action sheet up to 767px, anchored dropdown menu above. Same items in both. */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = (restore = true) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  const buttons = () => Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);

  useEffect(() => {
    if (!open) return;
    buttons()[0]?.focus({ preventScroll: true });
    if (narrow) return;
    const outside = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close(false);
    };
    const away = () => close(false);
    // Scrolling caused by focus inside the menu must not close it.
    const onScroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", away);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", away);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, narrow]);

  function openMenu() {
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  }
  /** Not enough room below the trigger: open upwards. */
  useLayoutEffect(() => {
    if (!open || narrow || !panel.current || !trigger.current) return;
    const h = panel.current.offsetHeight;
    const r = trigger.current.getBoundingClientRect();
    if (r.bottom + 4 + h > window.innerHeight - 8 && r.top - 4 - h >= 8)
      setPos({ bottom: window.innerHeight - r.top + 4, right: Math.max(8, window.innerWidth - r.right) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, narrow]);
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const els = buttons();
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Tab") {
      if (!narrow) return close(true);
      const last = els.length - 1;
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        els[last].focus();
      } else if (!e.shiftKey && i === last) {
        e.preventDefault();
        els[0].focus();
      }
      return;
    }
    const go = (n: number) => {
      e.preventDefault();
      els[(n + els.length) % els.length].focus({ preventScroll: true });
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(els.length - 1);
  }
  const choose = (item: RowMenuItem) => {
    close();
    item.onSelect();
  };
  const list = items.map((item) => (
    <button
      key={item.label}
      type="button"
      role={narrow ? undefined : "menuitem"}
      tabIndex={narrow ? 0 : -1}
      className={`row-menu-item${item.danger ? " danger" : ""}`}
      onClick={() => choose(item)}
    >
      {item.icon}
      {item.label}
    </button>
  ));

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-label={label}
        aria-haspopup={narrow ? "dialog" : "menu"}
        aria-expanded={open}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (!open && !narrow && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open &&
        (narrow ? (
          <div
            className="sheet-backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div ref={panel} role="dialog" aria-modal="true" aria-label={label} className="action-sheet" onKeyDown={onKeyDown}>
              <div className="action-sheet-list">{list}</div>
              <button type="button" className="row-menu-item cancel" onClick={() => close()}>
                취소
              </button>
            </div>
          </div>
        ) : (
          <div
            ref={panel}
            role="menu"
            aria-label={label}
            className="row-menu"
            style={pos ? { top: pos.top, right: pos.right } : undefined}
            onKeyDown={onKeyDown}
          >
            {list}
          </div>
        ))}
    </>
  );
}
