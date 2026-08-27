import { pool } from "@workspace/db";

export type CommonSaleScriptRow = {
  step: number;
  question: string | null;
  answer: string | null;
};

export function formatCommonSaleScript(rows: CommonSaleScriptRow[]): string | null {
  const sections = rows
    .filter((row) => row.step >= 1 && row.step <= 3)
    .map((row) => {
      const question = row.question?.trim();
      const answer = row.answer?.trim();
      if (!question && !answer) return null;
      return [
        `BƯỚC CHUNG B${row.step}`,
        question ? `Tình huống/câu hỏi: ${question}` : null,
        answer ? `Cách tư vấn đã duyệt: ${answer}` : null,
      ].filter(Boolean).join("\n");
    })
    .filter((section): section is string => Boolean(section));

  if (sections.length === 0) return null;

  return `KỊCH BẢN CHUNG B1–B3 CỦA STUDIO (ưu tiên khi khách chưa rõ nhu cầu):
${sections.join("\n\n")}

QUY TẮC ÁP DỤNG:
- Khách mới/chưa nói rõ dịch vụ: dùng kịch bản chung để chào và hỏi nhu cầu.
- Khi đã xác định dịch vụ: chuyển sang đúng kịch bản riêng, không chào lại và không hỏi lại điều khách vừa nói.
- Nếu khách đổi nhu cầu: chuyển sang nhóm mới, giữ lại thông tin đã biết.
- Kịch bản chung chỉ định hướng hội thoại; không được dùng để tự tạo giá, ưu đãi hoặc quyền lợi.`;
}

export async function getCommonSaleScript(): Promise<string | null> {
  try {
    const result = await pool.query(
      `SELECT step, question, answer
       FROM ai_script_qa_rows
       WHERE script_id IS NULL
         AND step BETWEEN 1 AND 3
         AND (
           NULLIF(BTRIM(COALESCE(question, '')), '') IS NOT NULL
           OR NULLIF(BTRIM(COALESCE(answer, '')), '') IS NOT NULL
         )
       ORDER BY step ASC, sort_order ASC, id ASC`,
    );
    return formatCommonSaleScript(result.rows as CommonSaleScriptRow[]);
  } catch (error) {
    console.error("[Lulu] Không đọc được kịch bản chung B1–B3, tiếp tục bằng luật mặc định:", error);
    return null;
  }
}
