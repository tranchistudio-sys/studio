import Anthropic from "@anthropic-ai/sdk";
import {
  type AiProviderName,
  getAiProviderConfig,
  resolveProviderChain,
  resolveApiKey,
  PROVIDER_LABEL,
} from "./ai-provider";

/**
 * TỔNG ĐÀI AI (provider fallback) — lõi dùng chung cho mọi chatbot/assistant.
 *
 * Gọi callChat({system, messages}) → tổng đài thử lần lượt theo chuỗi đã cấu hình
 * (vd Claude → OpenAI → …). Provider chính lỗi TẠM THỜI (timeout/quota/rate-limit/
 * 5xx/quá tải/JSON hỏng) → tự sang provider kế. Lỗi CẤU HÌNH (sai key/prompt/safety)
 * → DỪNG, báo admin (không fallback vô ích). Hết chuỗi → cần nhân viên thật.
 *
 * Tone đồng bộ: mọi provider nhận CÙNG `system` + `messages` đã build sẵn, nên
 * giọng Hoa (sale) / giọng Copilot (nội bộ) giữ nguyên dù chạy provider nào.
 *
 * BẢO MẬT: KHÔNG log API key (mọi message lỗi đều đi qua redact()).
 */

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ChatRequest = {
  /** System prompt (persona + dữ liệu + ràng buộc) — đã build sẵn bởi caller. */
  system: string;
  /** Hội thoại, role alternating; tin đầu phải là 'user'. */
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ép trả JSON hợp lệ (dùng cho Website advisor). */
  jsonMode?: boolean;
  /** Override model cho từng provider (hiếm dùng). */
  modelOverride?: Partial<Record<AiProviderName, string>>;
  /** Nhãn để log (vd "fb-messenger", "website-advisor", "copilot"). */
  label?: string;
};

export type ErrorClass =
  // → fallback được (lỗi tạm thời)
  | "timeout" | "rate_limit" | "quota" | "server_error" | "unavailable" | "invalid_response" | "network"
  // → KHÔNG fallback, báo admin
  | "auth_error" | "bad_request" | "safety"
  // → provider chưa cấu hình, bỏ qua xuống provider kế
  | "no_key";

const FALLBACKABLE: ErrorClass[] = [
  "timeout", "rate_limit", "quota", "server_error", "unavailable", "invalid_response", "network",
];
const STOP_NO_FALLBACK: ErrorClass[] = ["auth_error", "bad_request", "safety"];

export type AiAttempt = {
  provider: AiProviderName;
  ok: boolean;
  latencyMs: number;
  errorClass?: ErrorClass;
  errorMsg?: string;
};

export type AiChatResult =
  | {
      ok: true;
      text: string;
      providerUsed: AiProviderName;
      modelUsed: string;
      fallbackUsed: boolean;
      /** Vd "claude_timeout" — lý do đã phải fallback (null nếu provider chính chạy ngon). */
      fallbackReason: string | null;
      attempts: AiAttempt[];
      latencyMs: number;
    }
  | {
      ok: false;
      needsHuman: true;
      reason: "all_failed" | "config_error" | "safety";
      /** Mô tả ngắn để báo admin (KHÔNG chứa key). */
      adminAlert: string;
      attempts: AiAttempt[];
    };

class ProviderError extends Error {
  errorClass: ErrorClass;
  constructor(errorClass: ErrorClass, message: string) {
    super(message);
    this.errorClass = errorClass;
  }
}

function redact(s: string): string {
  return (s ?? "")
    .replace(/sk-[A-Za-z0-9_\-]{6,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***")
    .slice(0, 200);
}

function classifyStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) return "auth_error";
  if (status === 400 || status === 422) return "bad_request";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 529) return "unavailable";
  if (status >= 500) return "server_error";
  return "server_error";
}

// ─── Model mỗi provider ───────────────────────────────────────────────────────

const CLAUDE_DEFAULT_MODEL = "claude-sonnet-4-6";

function resolveModelFor(provider: AiProviderName, req: ChatRequest): string {
  const ov = req.modelOverride?.[provider];
  if (ov && ov.trim()) return ov.trim();
  if (provider === "claude") return process.env.ANTHROPIC_MODEL?.trim() || CLAUDE_DEFAULT_MODEL;
  if (provider === "openai") {
    if (process.env.OPENAI_FALLBACK_MODEL?.trim()) return process.env.OPENAI_FALLBACK_MODEL.trim();
    // Cổng riêng (AI_INTEGRATIONS_OPENAI_BASE_URL) đang phục vụ 'gpt-5.2'; OpenAI thật mặc định 'gpt-4o-mini'.
    return process.env.AI_INTEGRATIONS_OPENAI_BASE_URL?.trim() ? "gpt-5.2" : "gpt-4o-mini";
  }
  return process.env.GEMINI_MODEL?.trim() || "gemini-1.5-flash";
}

// ─── Adapter từng provider (cùng khuôn: nhận system+messages → text) ──────────

async function callClaude(apiKey: string, model: string, req: ChatRequest, timeoutMs: number): Promise<string> {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs });
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) throw new ProviderError("invalid_response", "Claude trả rỗng");
    return text;
  } catch (e) {
    throw classifyThrown("Claude", e);
  }
}

async function callOpenAI(apiKey: string, model: string, req: ChatRequest, timeoutMs: number): Promise<string> {
  const baseUrl = (process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: req.system },
          ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        ...(req.temperature != null ? { temperature: req.temperature } : {}),
        ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new ProviderError(classifyStatus(r.status), `OpenAI ${r.status}: ${body.slice(0, 120)}`);
    }
    const data = (await r.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "content_filter") throw new ProviderError("safety", "OpenAI content_filter");
    const text = (choice?.message?.content ?? "").trim();
    if (!text) throw new ProviderError("invalid_response", "OpenAI trả rỗng");
    return text;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (ctrl.signal.aborted) throw new ProviderError("timeout", "OpenAI timeout");
    throw new ProviderError("network", `OpenAI network: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
}

function classifyThrown(providerLabel: string, e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const anyE = e as { status?: number; name?: string; message?: string } | null;
  const name = anyE?.name ?? "";
  if (/Timeout/i.test(name) || name === "AbortError") return new ProviderError("timeout", `${providerLabel} timeout`);
  if (/Connection/i.test(name)) return new ProviderError("network", `${providerLabel} network`);
  if (typeof anyE?.status === "number") return new ProviderError(classifyStatus(anyE.status), `${providerLabel} ${anyE.status}`);
  return new ProviderError("server_error", `${providerLabel}: ${String(anyE?.message ?? e).slice(0, 120)}`);
}

async function callOneProvider(
  provider: AiProviderName,
  apiKey: string,
  model: string,
  req: ChatRequest,
  timeoutMs: number,
): Promise<string> {
  if (provider === "claude") return callClaude(apiKey, model, req, timeoutMs);
  if (provider === "openai") return callOpenAI(apiKey, model, req, timeoutMs);
  // Gemini: kiến trúc chừa sẵn — chưa triển khai adapter (theo quyết định "bỏ Gemini bây giờ").
  // Có key cũng coi như chưa sẵn sàng → bỏ qua xuống provider kế.
  throw new ProviderError("no_key", "Gemini adapter chưa triển khai");
}

// ─── Vòng lặp fallback chính ──────────────────────────────────────────────────

export async function callChat(req: ChatRequest): Promise<AiChatResult> {
  const cfg = await getAiProviderConfig();
  const chain = resolveProviderChain(cfg);
  const attempts: AiAttempt[] = [];
  const startAll = Date.now();
  const lbl = req.label ? `[${req.label}] ` : "";

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    const apiKey = await resolveApiKey(provider);

    if (!apiKey) {
      attempts.push({ provider, ok: false, latencyMs: 0, errorClass: "no_key", errorMsg: `${provider} chưa cấu hình key` });
      console.warn(`[AI] ${lbl}${PROVIDER_LABEL[provider]} chưa có key → bỏ qua`);
      continue;
    }

    const model = resolveModelFor(provider, req);
    let lastErr: ProviderError | null = null;

    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      const t0 = Date.now();
      try {
        const text = await callOneProvider(provider, apiKey, model, req, cfg.timeoutMs);
        const latencyMs = Date.now() - t0;
        attempts.push({ provider, ok: true, latencyMs });

        const firstFail = attempts.find((a) => !a.ok && a.errorClass !== "no_key");
        const fallbackUsed = i > 0 || attempts.some((a) => !a.ok);
        const fallbackReason = fallbackUsed && firstFail ? `${firstFail.provider}_${firstFail.errorClass}` : null;

        console.log(
          `[AI] ${lbl}${PROVIDER_LABEL[provider]} OK (${latencyMs}ms)` +
            (fallbackUsed ? ` [fallback, lý do: ${fallbackReason ?? "n/a"}]` : ""),
        );
        return {
          ok: true,
          text,
          providerUsed: provider,
          modelUsed: model,
          fallbackUsed,
          fallbackReason,
          attempts,
          latencyMs: Date.now() - startAll,
        };
      } catch (e) {
        const pe = e instanceof ProviderError ? e : new ProviderError("server_error", String((e as Error)?.message ?? e));
        lastErr = pe;
        if (FALLBACKABLE.includes(pe.errorClass) && attempt < cfg.retries) {
          console.warn(`[AI] ${lbl}${PROVIDER_LABEL[provider]} lỗi ${pe.errorClass} → thử lại (${attempt + 1}/${cfg.retries})`);
          continue;
        }
        attempts.push({ provider, ok: false, latencyMs: Date.now() - t0, errorClass: pe.errorClass, errorMsg: redact(pe.message) });
        break;
      }
    }

    // Provider này đã fail hẳn. Lỗi cấu hình/prompt/safety → DỪNG, báo admin (không fallback).
    if (lastErr && STOP_NO_FALLBACK.includes(lastErr.errorClass)) {
      const reason = lastErr.errorClass === "safety" ? "safety" : "config_error";
      console.error(`[AI] ${lbl}${PROVIDER_LABEL[provider]} lỗi ${lastErr.errorClass} → DỪNG (báo admin cấu hình lại), KHÔNG fallback`);
      return {
        ok: false,
        needsHuman: true,
        reason,
        adminAlert: `${PROVIDER_LABEL[provider]}: ${lastErr.errorClass} — ${redact(lastErr.message)}`,
        attempts,
      };
    }

    if (i < chain.length - 1) {
      console.warn(`[AI] ${lbl}${PROVIDER_LABEL[provider]} lỗi ${lastErr?.errorClass ?? "?"} → fallback sang ${PROVIDER_LABEL[chain[i + 1]]}`);
    }
  }

  // Hết chuỗi provider → không im lặng, báo nhân viên thật.
  console.error(`[AI] ${lbl}TẤT CẢ provider đều lỗi → cần nhân viên thật`);
  return {
    ok: false,
    needsHuman: true,
    reason: "all_failed",
    adminAlert: `Tất cả provider lỗi: ${attempts.map((a) => `${a.provider}=${a.errorClass ?? (a.ok ? "ok" : "fail")}`).join(", ")}`,
    attempts,
  };
}
