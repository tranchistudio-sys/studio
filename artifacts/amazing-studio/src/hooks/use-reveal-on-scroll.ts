import { useEffect, useRef, type RefObject } from "react";

// threshold 0: fire as soon as ANY pixel intersects. A positive threshold is
// unreachable for content taller than viewport/threshold (e.g. a 60-card grid
// ~9200px tall can never reach ratio 0.12), which would leave it stuck hidden.
const DEFAULT_OPTIONS: IntersectionObserverInit = {
  threshold: 0,
  rootMargin: "0px 0px -5% 0px",
};

/**
 * Adds `is-visible` when the element enters the viewport (CSS handles fade-up).
 * Fail-safe by design: content is NEVER left permanently hidden. The observer
 * alone is unreliable for deep-linked pages opened in a background tab
 * (IntersectionObserver callbacks aren't delivered until the tab is painted,
 * and getBoundingClientRect may read a stale/zero rect at mount), so we also
 * re-check on `visibilitychange` and fall back to a timed reveal for any
 * element already within the viewport.
 */
export function useRevealOnScroll<T extends HTMLElement>(
  options?: IntersectionObserverInit,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let revealed = false;
    const show = () => {
      if (revealed) return;
      revealed = true;
      el.classList.add("is-visible");
    };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      show();
      return;
    }

    // Matches the original eager-reveal zone (top within the upper 92% of the
    // viewport) so genuinely below-the-fold sections keep their scroll fade-up.
    const inViewport = () => {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      return rect.bottom > 0 && rect.top < vh * 0.92;
    };

    // Already on screen at mount → reveal immediately (first-screen content).
    if (inViewport()) {
      show();
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        show();
        observer.disconnect();
      }
    }, { ...DEFAULT_OPTIONS, ...options });
    observer.observe(el);

    // Background/deep-linked tabs don't deliver observer callbacks until painted,
    // and getBoundingClientRect can read a stale rect at mount. Re-check the
    // moment the tab/window is repainted (tab made visible, window refocused, or
    // resized) and reveal anything now genuinely in view. Off-screen content is
    // untouched, so it keeps its scroll-triggered fade-up.
    const recheck = () => {
      if (inViewport()) show();
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    window.addEventListener("resize", recheck);

    // Absolute safety net: never leave in-view content hidden (covers a missed
    // fast-path measurement on a foreground tab where none of the events fire).
    const failSafe = window.setTimeout(recheck, 1400);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
      window.removeEventListener("resize", recheck);
      window.clearTimeout(failSafe);
    };
  }, [options?.threshold, options?.rootMargin]);

  return ref;
}
