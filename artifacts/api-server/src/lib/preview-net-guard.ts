/**
 * preview-net-guard.ts — LỚP PHÒNG THỦ THỨ HAI cho bản preview: chặn ở TẦNG MẠNG.
 *
 * Vì sao cần, dù `preview-guard.ts` đã dọn sạch env:
 *   - Token Facebook đọc từ bảng `settings` (key `fb_page_access_token`), env chỉ
 *     là fallback → DB preview (bản sao đã che dữ liệu) vẫn có thể còn token thật.
 *   - Key OpenAI cũng đọc từ `settings.openai_api_key` theo cùng kiểu.
 *   - Refresh token Google Drive / đăng ký web-push nằm trong DB.
 * `scripts/seed-preview-db.mjs` có xoá các secret đó, nhưng seed là việc CHẠY TAY
 * — không được phép là chốt chặn duy nhất. Lớp này chặn bằng code, luôn luôn bật.
 *
 * NGUYÊN TẮC: MẶC ĐỊNH CẤM (fail-closed). Preview KHÔNG được gọi HTTP/HTTPS ra
 * ngoài, trừ các host ghi tường minh trong `PREVIEW_NET_ALLOW`. Không xác định
 * được host → chặn.
 *
 * Không ảnh hưởng: kết nối Postgres (dùng TCP/TLS qua `net`/`tls`, không qua
 * http/https) và mọi request ĐI VÀO (health check của Fly, người dùng mở web).
 *
 * CHỈ chạy khi PREVIEW_MODE=1 — production không bao giờ đi qua file này.
 */
import http from "node:http";
import https from "node:https";
import { isPreviewMode, type EnvLike } from "./preview-guard";

/** Host nội bộ luôn được phép (chính container gọi chính nó). */
const ALWAYS_ALLOWED = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

let blockedCount = 0;
let installed = false;

export function getBlockedOutboundCount(): number {
  return blockedCount;
}

/** Reset — chỉ dùng cho test. */
export function __resetBlockedOutboundCount(): void {
  blockedCount = 0;
}

export function parseNetAllowlist(raw: string | undefined): Set<string> {
  const set = new Set<string>(ALWAYS_ALLOWED);
  if (!raw) return set;
  for (const item of raw.split(",")) {
    const host = item.trim().toLowerCase();
    if (host) set.add(host);
  }
  return set;
}

/** Chuẩn hoá host từ mọi kiểu tham số mà http.request/fetch chấp nhận. */
export function extractHost(target: unknown, options?: unknown): string | null {
  const fromString = (value: string): string | null => {
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return null;
    }
  };

  if (typeof target === "string") return fromString(target);
  if (target instanceof URL) return target.hostname.toLowerCase();

  // Request (fetch API) — có thuộc tính `url`.
  if (target && typeof target === "object" && typeof (target as { url?: unknown }).url === "string") {
    return fromString((target as { url: string }).url);
  }

  const opts = (target && typeof target === "object" ? target : options) as
    | { hostname?: unknown; host?: unknown }
    | undefined;
  if (opts) {
    const raw = typeof opts.hostname === "string" ? opts.hostname : typeof opts.host === "string" ? opts.host : null;
    if (raw) {
      // `host` có thể kèm cổng ("graph.facebook.com:443") → cắt bỏ.
      return raw.toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    }
  }
  return null;
}

export function isOutboundAllowed(host: string | null, allowlist: Set<string>): boolean {
  if (!host) return false; // fail-closed: không biết đi đâu → cấm.
  return allowlist.has(host);
}

function blockedError(host: string | null, api: string): Error {
  blockedCount += 1;
  const where = host ?? "(không xác định được host)";
  const err = new Error(
    `[preview-net-guard] CHẶN gọi ra ngoài tới '${where}' qua ${api}. ` +
      "Bản preview không được phép gửi dữ liệu/chi phí ra Internet (Facebook, Google Drive, web-push, AI). " +
      `Nếu thực sự cần host này cho việc review, thêm vào PREVIEW_NET_ALLOW.`,
  );
  err.name = "PreviewOutboundBlocked";
  console.error(err.message);
  return err;
}

/**
 * Cài chốt chặn. Gọi MỘT LẦN, càng sớm càng tốt trong vòng đời tiến trình.
 * No-op khi không phải preview hoặc khi đã cài rồi.
 */
export function installPreviewNetGuard(env: EnvLike = process.env): boolean {
  if (!isPreviewMode(env) || installed) return false;
  installed = true;

  const allowlist = parseNetAllowlist(env.PREVIEW_NET_ALLOW);

  // ── fetch (Anthropic SDK, OpenAI SDK, mọi lệnh gọi Graph API viết bằng fetch) ─
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      const host = extractHost(input);
      if (!isOutboundAllowed(host, allowlist)) {
        return Promise.reject(blockedError(host, "fetch"));
      }
      return (originalFetch as (...a: unknown[]) => Promise<Response>)(input, init);
    }) as typeof globalThis.fetch;
  }

  // ── http/https (web-push, googleapis/gaxios, @google-cloud/storage) ──────────
  for (const [mod, name] of [
    [http, "http"],
    [https, "https"],
  ] as const) {
    for (const method of ["request", "get"] as const) {
      const original = mod[method] as (...args: unknown[]) => unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mod as any)[method] = (...args: unknown[]) => {
        const host = extractHost(args[0], args[1]);
        if (!isOutboundAllowed(host, allowlist)) {
          throw blockedError(host, `${name}.${method}`);
        }
        return original(...args);
      };
    }
  }

  console.warn(
    `[preview-net-guard] Đã bật chặn gọi ra ngoài (mặc định CẤM). Host được phép: ${[...allowlist].join(", ")}`,
  );
  return true;
}
