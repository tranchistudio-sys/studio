/**
 * audit.ts — Ghi log mỗi lần ChatGPT gọi 1 MCP tool. Dùng logger pino sẵn có
 * (KHÔNG bảng mới → không DDL). TUYỆT ĐỐI không log token/secret/password; tham
 * số đã được sanitize (chỉ field an toàn), kết quả chỉ ghi SỐ LƯỢNG bản ghi.
 */
import { logger } from "../logger.js";

export type AuditEntry = {
  tool: string;
  staffId: number | null;
  role: string | null;
  /** Tham số đã lọc an toàn (không chứa dữ liệu nhạy cảm/secret). */
  args: Record<string, unknown>;
  /** Kết quả: số bản ghi trả về (không log nội dung). */
  resultCount: number;
  outcome: "ok" | "forbidden" | "error";
  ms: number;
};

export function auditToolCall(e: AuditEntry): void {
  logger.info(
    {
      mcp: true,
      tool: e.tool,
      staffId: e.staffId,
      role: e.role,
      args: e.args,
      resultCount: e.resultCount,
      outcome: e.outcome,
      ms: e.ms,
    },
    `[mcp] ${e.tool} ${e.outcome} (${e.resultCount} bản ghi, ${e.ms}ms)`,
  );
}
