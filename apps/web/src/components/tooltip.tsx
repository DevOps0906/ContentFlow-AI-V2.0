"use client";
import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import { ignoreScrollAfterOpen, nextOpenOnClick, opensOnPointer, placeTooltip, TOOLTIP_CLOSE_DELAY_MS } from "@/lib/overlay";

/** State shared by Tooltip and InfoTip: hover (mouse), keyboard focus, Esc to close, optional tap toggle. */
function useTooltip() {
  const [open, setOpen] = useState(false);
  const openedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const hideSoon = () => {
    cancelClose();
    timer.current = setTimeout(() => setOpen(false), TOOLTIP_CLOSE_DELAY_MS);
  };
  useEffect(() => cancelClose, []);
  const wrap = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  // Fixed positioning so a scrolling table wrapper can not clip the bubble.
  useLayoutEffect(() => {
    if (!open || !wrap.current || !bubble.current) return setPos(null);
    const r = wrap.current.getBoundingClientRect();
    openedAt.current = Date.now();
    setPos(
      placeTooltip(
        r,
        { width: bubble.current.offsetWidth, height: bubble.current.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onScroll = () => {
      if (!ignoreScrollAfterOpen(openedAt.current, Date.now())) close();
    };
    // Esc dismisses the tooltip wherever focus is (hover-opened too) and does not reach a dialog or menu behind it.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const handlers = {
    onPointerEnter: (e: PointerEvent) => opensOnPointer(e.pointerType) && show(),
    onPointerLeave: (e: PointerEvent) => opensOnPointer(e.pointerType) && hideSoon(),
    onFocus: (e: FocusEvent) => {
      // Only keyboard focus opens it; a tap or click also focuses but must not flash a tooltip.
      let visible = false;
      try {
        visible = (e.target as HTMLElement).matches(":focus-visible");
      } catch {
        visible = true;
      }
      if (visible) show();
    },
    onBlur: (e: FocusEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
    },
  };
  // The bubble is hoverable: entering it cancels the pending close, leaving it closes again.
  const bubbleHandlers = { onPointerEnter: cancelClose, onPointerLeave: hideSoon };
  return { open, setOpen, wrap, bubble, pos, handlers, bubbleHandlers };
}

function Bubble({ id, text, state }: { id: string; text: string; state: ReturnType<typeof useTooltip> }) {
  const { open, bubble, pos, bubbleHandlers } = state;
  const node = (
    <span
      ref={bubble}
      id={id}
      role="tooltip"
      className={`tooltip${open ? " is-open" : ""}${pos?.below ? " below" : ""}`}
      style={open && pos ? { left: pos.left, top: pos.top } : undefined}
      {...bubbleHandlers}
    >
      {text}
    </span>
  );
  // Open: portal to <body> so a transformed ancestor (the mobile drawer) can not skew position:fixed.
  // Closed: stays inline so aria-describedby always has a target.
  return open && typeof document !== "undefined" ? createPortal(node, document.body) : node;
}

/**
 * Short explanation for an icon button or a term. Wrap one element. Opens on mouse hover and keyboard focus,
 * closes on Esc or leaving. Touch has no hover: use `InfoTip` (a tap-to-toggle info button) there.
 * A disabled child can not take focus, so the wrapper itself becomes the focusable, described element.
 */
export function Tooltip({ text, label, children }: { text: string; label?: string; children: ReactElement<Record<string, unknown>> }) {
  const id = useId();
  const state = useTooltip();
  const disabled = children.props.disabled === true;
  const sameAsLabel = children.props["aria-label"] === text;
  const describedBy = sameAsLabel ? undefined : id;
  return (
    <span ref={state.wrap} className={`tooltip-wrap${disabled ? " is-disabled" : ""}`} {...state.handlers}
      tabIndex={disabled ? 0 : undefined}
      role={disabled ? "button" : undefined}
      aria-disabled={disabled ? true : undefined}
      aria-label={disabled ? (label ?? (children.props["aria-label"] as string | undefined)) : undefined}
      aria-describedby={disabled ? describedBy : undefined}
    >
      {cloneElement(children, disabled || !describedBy ? {} : { "aria-describedby": describedBy })}
      <Bubble id={id} text={text} state={state} />
    </span>
  );
}

/** Info button for terms: hover or keyboard focus shows the text; a tap toggles it (touch). */
export function InfoTip({ label, text }: { label: string; text: string }) {
  const id = useId();
  const state = useTooltip();
  const { open, setOpen, wrap } = state;
  const pointer = useRef("");
  useEffect(() => {
    if (!open) return;
    const outside = (e: globalThis.PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, setOpen, wrap]);
  return (
    <span ref={wrap} className="tooltip-wrap" {...state.handlers}>
      <button
        type="button"
        className="info-tip"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onPointerDown={(e) => (pointer.current = e.pointerType)}
        onClick={() => {
          setOpen(nextOpenOnClick(open, pointer.current));
          pointer.current = "";
        }}
      >
        <CircleHelp size={14} />
      </button>
      <Bubble id={id} text={text} state={state} />
    </span>
  );
}
