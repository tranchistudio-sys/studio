/**
 * TEST-ONLY provider override (vd ShopAIKey) — tách riêng, KHÔNG import @workspace/db,
 * để unit-test được mà KHÔNG cần DATABASE_URL (giống ai-message-builders).
 *
 * CHỈ dùng cho route sân test/admin (Claude Sale Test, Lulu Brain Lab, sale-learning).
 * KHÔNG bao giờ áp cho production: fb-inbox.ts (Messenger) KHÔNG gọi hàm này.
 */

export type ClaudeProviderOverride = {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /** Nhãn để log/panel (vd "shopaikey"). */
  label?: string;
};

/**
 * Đọc override test-only từ env. Chỉ trả override khi cờ LULU_TEST_PROVIDER=shopaikey
 * VÀ có SHOPAIKEY_API_KEY. undefined = giữ nguyên provider production. KHÔNG log key.
 */
export function resolveTestProviderOverride(): ClaudeProviderOverride | undefined {
  if ((process.env.LULU_TEST_PROVIDER ?? "").trim().toLowerCase() !== "shopaikey") return undefined;
  const apiKey = (process.env.SHOPAIKEY_API_KEY ?? "").trim();
  if (!apiKey) return undefined;
  const baseURL = (process.env.SHOPAIKEY_BASE_URL ?? "").trim() || undefined;
  const model = (process.env.SHOPAIKEY_MODEL ?? "").trim() || undefined;
  return { apiKey, baseURL, model, label: "shopaikey" };
}

/** Dựng option cho `new Anthropic(...)`: ưu tiên override test-only (apiKey/baseURL). Thuần → test được. */
export function buildClaudeClientOptions(
  baseApiKey: string,
  override: ClaudeProviderOverride | undefined,
  timeoutMs: number,
): { apiKey: string; baseURL?: string; maxRetries: number; timeout: number } {
  return {
    apiKey: override?.apiKey ?? baseApiKey,
    ...(override?.baseURL ? { baseURL: override.baseURL } : {}),
    maxRetries: 0,
    timeout: timeoutMs,
  };
}
