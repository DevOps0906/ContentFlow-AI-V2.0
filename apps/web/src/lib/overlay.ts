/** Small pure helpers shared by the tooltip and the mobile drawer (kept free of React so they are unit-testable). */

/**
 * Focus trap for Tab: which index to focus when Tab/Shift+Tab would leave a group of `count` focusable
 * elements. `null` means the browser default is fine. An unknown focus (`index < 0`) is pulled inside.
 */
export function wrapFocusIndex(index: number, count: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (index < 0) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}

/** Hover opens a tooltip for a mouse or pen only. Touch uses the tap-to-toggle info button instead. */
export function opensOnPointer(pointerType: string): boolean {
  return pointerType === "mouse" || pointerType === "pen" || pointerType === "";
}

/** Delay before a hover tooltip closes, so the pointer can travel from the trigger onto the bubble (WCAG 1.4.13). */
export const TOOLTIP_CLOSE_DELAY_MS = 120;
/** Scrolling caused by opening (focus moving, layout shift) right after open must not close it. */
export const TOOLTIP_SCROLL_GRACE_MS = 200;
export const ignoreScrollAfterOpen = (openedAt: number, now: number) => now - openedAt < TOOLTIP_SCROLL_GRACE_MS;

/** Mouse clicks on an info button keep the tooltip open (hover already opened it); touch taps toggle it. */
export function nextOpenOnClick(open: boolean, pointerType: string): boolean {
  return opensOnPointer(pointerType) && pointerType !== "" ? true : !open;
}

/** Fixed placement: above the trigger, below when there is no room above, and always inside the viewport. */
export function placeTooltip(
  r: { top: number; bottom: number; left: number; width: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
  margin = 8,
): { left: number; top: number; below: boolean } {
  const left = clampCenter(r.left + r.width / 2, size.width, viewport.width, margin);
  const fitsAbove = r.top - gap - size.height >= margin;
  const fitsBelow = r.bottom + gap + size.height <= viewport.height - margin;
  if (fitsAbove || !fitsBelow) return { left, top: Math.max(r.top - gap, size.height + margin), below: false };
  return { left, top: r.bottom + gap, below: true };
}

/** Keeps a fixed tooltip inside the viewport horizontally: returns its centre x. */
export function clampCenter(center: number, width: number, viewport: number, margin = 8): number {
  const half = width / 2;
  return Math.min(Math.max(center, margin + half), Math.max(margin + half, viewport - margin - half));
}

/** Stops the page behind a drawer from scrolling. Returns the function that restores the previous value. */
export function lockScroll(body: { style: { overflow: string } }): () => void {
  const previous = body.style.overflow;
  body.style.overflow = "hidden";
  return () => {
    body.style.overflow = previous;
  };
}
