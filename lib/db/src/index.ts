import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// BẮT BUỘC phải có listener 'error': khi một connection ĐANG RỖI trong pool bị
// phía server đóng (Neon/Postgres hết hạn idle, mạng chớp, hoặc admin ngắt phiên),
// node-postgres phát sự kiện 'error' trên Pool. KHÔNG có listener → Node coi là
// unhandled error event → GIẾT CẢ TIẾN TRÌNH, API sập dù chẳng có request nào lỗi.
// Ghi log rồi thôi: pool tự bỏ connection hỏng và mở cái mới ở request kế tiếp.
pool.on("error", (err) => {
  console.error("[db] Connection rỗi bị đóng phía server (pool tự phục hồi):", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";

export * from "./additional-services";
