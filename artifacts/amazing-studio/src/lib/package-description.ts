// ─── Reflow "Nội dung gói" (package description) into clean logical lines ─────
//
// Một số gói trong DB bị chèn xuống dòng CỨNG giữa câu (wrap theo độ rộng cố
// định lúc nhập/import cũ), ví dụ description thật của gói SILVER:
//
//   "• THÊM 6 ÁO DÀI\nBƯNG QUẢ NAM\n500K"
//
// Nếu render mỗi "\n" thành 1 dòng (cách cũ: description.split("\n")) thì chữ bị
// "nhảy" và đọc sai nghĩa — "THÊM 6 ÁO DÀI" / "BƯNG QUẢ NAM" / "500K" trông như 3
// ý riêng. Hàm này nối lại các dòng "nối tiếp" (dòng KHÔNG bắt đầu bằng bullet,
// nằm ngay sau một dòng bullet) vào đúng gạch đầu dòng của nó, để đọc thành:
//
//   "• THÊM 6 ÁO DÀI BƯNG QUẢ NAM 500K"
//
// Quy tắc:
//  - Dòng bắt đầu bằng bullet (• · ‣ ▪ ● ○) mở một mục mới.
//  - Dòng trống "đóng" mục hiện tại (người dùng chủ động ngắt → tôn trọng).
//  - Dòng không-bullet, không-trống:
//      • đang trong 1 mục bullet  → nối vào mục đó (ghép bằng dấu cách);
//      • không có mục đang mở      → giữ thành dòng riêng (tiêu đề "GÓI SILVER",
//                                     ghi chú cuối như "6tr"...).
//  - Kết quả không có dòng trống (giống `.filter(Boolean)` cũ).
//
// An toàn: gói đã đúng định dạng (mỗi bullet 1 dòng, không wrap giữa câu) sẽ ra
// kết quả y như cũ. Đây là xử lý hiển thị thuần, KHÔNG sửa dữ liệu trong DB.

const BULLET_RE = /^\s*[•·‣▪●○]/;

export function reflowDescriptionLines(description?: string | null): string[] {
  if (!description) return [];
  const out: string[] = [];
  let current: string | null = null;

  const flush = () => {
    if (current !== null) {
      const t = current.trim();
      if (t) out.push(t);
      current = null;
    }
  };

  for (const raw of description.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flush();
    } else if (BULLET_RE.test(line)) {
      flush();
      current = line;
    } else if (current !== null) {
      current = `${current} ${line}`;
    } else {
      out.push(line);
    }
  }
  flush();
  return out;
}

/** First non-empty reflowed line (dùng cho preview 1 dòng). */
export function firstDescriptionLine(description?: string | null): string {
  return reflowDescriptionLines(description)[0] ?? "";
}

// ─── Parse description thành block có cấu trúc (hiển thị đẹp, KHÔNG đổi câu chữ) ──
//
// Nâng cấp từ reflowDescriptionLines: ngoài nối dòng gãy trong bullet, còn:
//  - Dòng kết thúc bằng ":" (BAO GỒM:, SẢN PHẨM:...) → block "heading" (in đậm).
//  - Các dòng thường LIÊN TIẾP (không bullet, không heading, không cách nhau
//    bằng dòng trống) → nối thành 1 đoạn văn liền mạch — hết cảnh câu bị bẻ
//    dòng cứng giữa chừng ("CAO CẤP / NHẤT, NƠI MỌI...").
//  - Bullet giữ nguyên cả ký tự đầu dòng.
// Thuần hiển thị — từng chữ giữ nguyên, chỉ khác cách xuống dòng/nhấn đậm.

export type DescriptionBlock = { type: "heading" | "bullet" | "text"; text: string };

export function parseDescriptionBlocks(description?: string | null): DescriptionBlock[] {
  if (!description) return [];
  const out: DescriptionBlock[] = [];
  let current: DescriptionBlock | null = null;

  const flush = () => {
    if (current) {
      const t = current.text.trim();
      if (t) out.push({ ...current, text: t });
      current = null;
    }
  };

  for (const raw of description.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flush();
    } else if (BULLET_RE.test(line)) {
      flush();
      current = { type: "bullet", text: line };
    } else if (line.endsWith(":")) {
      flush();
      out.push({ type: "heading", text: line });
    } else if (current) {
      current.text = `${current.text} ${line}`;
    } else {
      current = { type: "text", text: line };
    }
  }
  flush();
  return out;
}
