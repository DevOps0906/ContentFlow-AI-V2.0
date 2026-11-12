"use client";
import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 767px)";
/** True up to 767px (mobile range). Server and first render are false. */
export function useNarrow() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(QUERY);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
