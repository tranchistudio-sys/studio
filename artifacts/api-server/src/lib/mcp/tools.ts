/**
 * tools.ts — Đăng ký 3 MCP tool READ-ONLY Phase 1. Mỗi tool:
 *  - kiểm ROLE (tài chính/công nợ = admin; lịch = staff/admin) — từ access token đã verify;
 *  - gọi ENGINE SẴN CÓ (không viết lại logic);
 *  - trả JSON WHITELIST field (không spread raw DB row, không dump nội bộ);
 *  - ghi AUDIT LOG (không log token/secret).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildBusinessSnapshot } from "../business-snapshot.js";
import { getTopDebtors } from "../finance/top-debtors.js";
import { listShoots } from "./shoots.js";
import { auditToolCall } from "./audit.js";

type ToolExtra = { authInfo?: { extra?: Record<string, unknown> } };

function roleOf(extra: ToolExtra): "admin" | "staff" | null {
  const r = extra?.authInfo?.extra?.role;
  return r === "admin" || r === "staff" ? r : null;
}
function staffIdOf(extra: ToolExtra): number | null {
  const id = extra?.authInfo?.extra?.staffId;
  return typeof id === "number" ? id : null;
}

function textResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}
function forbidden(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}
function errorResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

export function registerReadTools(server: McpServer): void {
  // ── 1. Tình hình kinh doanh tháng (ADMIN) ────────────────────────────────────
  server.registerTool(
    "get_business_snapshot",
    {
      title: "Tình hình kinh doanh tháng",
      description:
        "Trả về bức tranh kinh doanh tháng hiện tại của studio (đã tính chính xác bởi engine): doanh thu hợp đồng, thực thu, chi phí, lợi nhuận thực, công nợ, số booking, và các chỉ số dẫn xuất (biên lợi nhuận, trung bình/booking, % tăng giảm so tháng trước). Chỉ quản trị viên. Dữ liệu để PHÂN TÍCH, KHÔNG tự tính lại số.",
      inputSchema: {},
      annotations: { readOnlyHint: true, title: "Tình hình kinh doanh tháng" },
    },
    async (_args, extra: ToolExtra) => {
      const t0 = Date.now();
      const role = roleOf(extra);
      const staffId = staffIdOf(extra);
      if (role !== "admin") {
        auditToolCall({ tool: "get_business_snapshot", staffId, role, args: {}, resultCount: 0, outcome: "forbidden", ms: Date.now() - t0 });
        return forbidden("Từ chối: 'Tình hình kinh doanh' chỉ dành cho quản trị viên.");
      }
      try {
        const snap = await buildBusinessSnapshot();
        auditToolCall({ tool: "get_business_snapshot", staffId, role, args: {}, resultCount: 1, outcome: "ok", ms: Date.now() - t0 });
        return textResult(snap);
      } catch (e) {
        auditToolCall({ tool: "get_business_snapshot", staffId, role, args: {}, resultCount: 0, outcome: "error", ms: Date.now() - t0 });
        return errorResult(`Lỗi đọc dữ liệu kinh doanh: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ── 2. Top khách còn nợ (ADMIN) ──────────────────────────────────────────────
  server.registerTool(
    "get_top_debtors",
    {
      title: "Top khách còn nợ",
      description:
        "Danh sách khách còn nợ nhiều nhất + tổng công nợ toàn hệ thống (đã tính bởi engine công nợ). Tham số limit (1–50, mặc định 10). Chỉ quản trị viên.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true, title: "Top khách còn nợ" },
    },
    async (args: { limit?: number }, extra: ToolExtra) => {
      const t0 = Date.now();
      const role = roleOf(extra);
      const staffId = staffIdOf(extra);
      const limit = args?.limit ?? 10;
      if (role !== "admin") {
        auditToolCall({ tool: "get_top_debtors", staffId, role, args: { limit }, resultCount: 0, outcome: "forbidden", ms: Date.now() - t0 });
        return forbidden("Từ chối: dữ liệu công nợ chỉ dành cho quản trị viên.");
      }
      try {
        const res = await getTopDebtors(limit);
        auditToolCall({ tool: "get_top_debtors", staffId, role, args: { limit }, resultCount: res.debtors.length, outcome: "ok", ms: Date.now() - t0 });
        return textResult({ asOf: new Date().toISOString().slice(0, 10), currency: "VND", ...res });
      } catch (e) {
        auditToolCall({ tool: "get_top_debtors", staffId, role, args: { limit }, resultCount: 0, outcome: "error", ms: Date.now() - t0 });
        return errorResult(`Lỗi đọc công nợ: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // ── 3. Lịch chụp theo khoảng ngày (STAFF/ADMIN) ──────────────────────────────
  server.registerTool(
    "list_shoots",
    {
      title: "Lịch chụp",
      description:
        "Danh sách lịch chụp trong khoảng ngày [from, to] (YYYY-MM-DD, tối đa 92 ngày): ngày chính + ngày phụ, kèm khách, giờ, địa điểm, dịch vụ, trạng thái. Cho phép nhân viên và quản trị viên.",
      inputSchema: {
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
      },
      annotations: { readOnlyHint: true, title: "Lịch chụp" },
    },
    async (args: { from: string; to: string }, extra: ToolExtra) => {
      const t0 = Date.now();
      const role = roleOf(extra);
      const staffId = staffIdOf(extra);
      if (role !== "admin" && role !== "staff") {
        auditToolCall({ tool: "list_shoots", staffId, role, args: { from: args?.from, to: args?.to }, resultCount: 0, outcome: "forbidden", ms: Date.now() - t0 });
        return forbidden("Từ chối: cần đăng nhập nhân viên/quản trị.");
      }
      try {
        const res = await listShoots(args.from, args.to);
        auditToolCall({ tool: "list_shoots", staffId, role, args: { from: args.from, to: args.to }, resultCount: res.count, outcome: "ok", ms: Date.now() - t0 });
        return textResult(res);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        auditToolCall({ tool: "list_shoots", staffId, role, args: { from: args?.from, to: args?.to }, resultCount: 0, outcome: "error", ms: Date.now() - t0 });
        return errorResult(msg.startsWith("bad_request") ? msg.replace("bad_request: ", "Tham số sai: ") : `Lỗi đọc lịch: ${msg}`);
      }
    },
  );
}
