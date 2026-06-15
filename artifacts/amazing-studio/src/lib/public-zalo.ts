export function toZaloNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, "");
  return cleaned.startsWith("0") ? "84" + cleaned.slice(1) : cleaned;
}

function isMobileDevice(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (window.matchMedia?.("(pointer: coarse)").matches) return true;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

export function openZalo(phone: string): void {
  const zaloNum = toZaloNumber(phone);
  const webUrl = `https://zalo.me/${zaloNum}`;
  try {
    if (!isMobileDevice()) {
      window.open(webUrl, "_blank", "noopener,noreferrer");
      return;
    }
    let opened = false;
    const onHide = () => {
      opened = true;
      document.removeEventListener("visibilitychange", onHide);
    };
    document.addEventListener("visibilitychange", onHide);
    const fallback = () => {
      document.removeEventListener("visibilitychange", onHide);
      if (!opened) {
        try {
          window.location.href = webUrl;
        } catch {
          /* ignore */
        }
      }
    };
    setTimeout(fallback, 1200);
    try {
      window.location.href = `zalo://chat?phone=${zaloNum}`;
    } catch {
      try {
        window.location.href = webUrl;
      } catch {
        /* ignore */
      }
    }
  } catch {
    try {
      window.open(webUrl, "_blank", "noopener,noreferrer");
    } catch {
      /* ignore */
    }
  }
}
