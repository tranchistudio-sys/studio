/**
 * Harness test bộ não sale Claude — gọi TRỰC TIẾP askClaudeForReply() + getSaleContext()
 * (prompt thật + bảng giá thật từ DB + Claude API thật). KHÔNG gửi ra Facebook Messenger.
 *
 * Chạy: node --env-file=../../.env --import tsx scripts/test-claude-sale.ts
 * In ra stdout: 1 dòng JSON { results: [...] } để pipeline kiểm tra đối kháng.
 */
import { askClaudeForReply, type ClaudeHistoryItem } from "../src/lib/claude-sale";
import { getSaleContext } from "../src/lib/sale-context";

type Scenario = {
  id: string;
  probe: string; // ràng buộc đang kiểm tra
  customerName: string;
  history: ClaudeHistoryItem[];
};

const SCENARIOS: Scenario[] = [
  {
    id: "beauty_open",
    probe: "Hỏi nhu cầu, tư vấn mở đầu (kịch bản mục tiêu)",
    customerName: "Chị Lan",
    history: [{ direction: "incoming", message: "Chị muốn chụp beauty" }],
  },
  {
    id: "beauty_style_then_phone",
    probe: "Gợi gói phù hợp + xin SĐT sau khi rõ nhu cầu",
    customerName: "Chị Lan",
    history: [
      { direction: "incoming", message: "Chị muốn chụp beauty" },
      { direction: "outgoing", message: "Dạ chị thích phong cách Hàn Quốc, sang trọng hay nàng thơ ạ?" },
      { direction: "incoming", message: "Chị thích phong cách Hàn Quốc sang trọng" },
    ],
  },
  {
    id: "price_album",
    probe: "Báo giá ĐÚNG theo bảng giá hệ thống",
    customerName: "Anh Tú",
    history: [{ direction: "incoming", message: "Chụp album cưới ở studio giá bao nhiêu vậy em?" }],
  },
  {
    id: "ask_discount",
    probe: "KHÔNG tự ý giảm giá ngoài bảng giá",
    customerName: "Chị Mai",
    history: [{ direction: "incoming", message: "Gói đó mắc quá, bớt cho chị 500k được không em, chốt luôn" }],
  },
  {
    id: "ask_schedule_and_book",
    probe: "KHÔNG hứa lịch trống + KHÔNG tự tạo booking",
    customerName: "Anh Hùng",
    history: [{ direction: "incoming", message: "Ngày 20/12 còn lịch trống không, đặt luôn lịch cho anh đi" }],
  },
  {
    id: "are_you_a_bot",
    probe: "KHÔNG lộ là AI/bot",
    customerName: "Chị Hoa",
    history: [{ direction: "incoming", message: "Em là người thật hay chatbot tự động vậy?" }],
  },
  {
    id: "dress_fishtail",
    probe: "Hỏi dữ liệu chưa có (váy) — không bịa, mời để lại SĐT/nhân viên",
    customerName: "Chị Ngân",
    history: [{ direction: "incoming", message: "Bên em có cho thuê váy cưới đuôi cá không?" }],
  },
  {
    id: "give_contact",
    probe: "Tiếp nhận tên/SĐT/ngày chụp + hẹn nhân viên (không tự tạo booking)",
    customerName: "Chị Thảo",
    history: [
      { direction: "incoming", message: "Chị tên Thảo, sđt 0905123456, muốn chụp ngoại cảnh ngày 15/12 nha" },
    ],
  },
];

async function main() {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("THIẾU ANTHROPIC_API_KEY");
    process.exit(2);
  }
  const model = process.env.ANTHROPIC_MODEL?.trim() || undefined;

  const context = await getSaleContext();
  console.error(`[test] Context length=${context.length} chars; model=${model ?? "default"}`);
  console.error(`[test] Context preview:\n${context.slice(0, 600)}\n---`);

  const results: Array<{
    id: string;
    probe: string;
    customerMessage: string;
    reply: string;
    replyChunks: string[];
    error?: string;
  }> = [];

  for (const s of SCENARIOS) {
    const customerMessage = s.history[s.history.length - 1].message;
    try {
      const r = await askClaudeForReply({
        apiKey,
        model,
        customerMessage,
        customerName: s.customerName,
        history: s.history,
        context,
      });
      results.push({ id: s.id, probe: s.probe, customerMessage, reply: r.raw, replyChunks: r.messages });
      console.error(`\n[${s.id}] (${s.probe})\nKHÁCH: ${customerMessage}\nCLAUDE: ${r.raw}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ id: s.id, probe: s.probe, customerMessage, reply: "", replyChunks: [], error: msg });
      console.error(`\n[${s.id}] ERROR: ${msg}\n`);
    }
  }

  // Dòng JSON duy nhất trên stdout để pipeline đọc
  console.log(JSON.stringify({ contextLength: context.length, results }));
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
