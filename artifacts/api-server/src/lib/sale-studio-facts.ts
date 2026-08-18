/**
 * THÔNG TIN CỐ ĐỊNH của Amazing Studio (fact) + nhận diện câu hỏi địa chỉ/vị trí.
 *
 * Vì sao tồn tại: trước đây địa chỉ KHÔNG nằm trong sale-context → Lulu trả lời
 * "em chưa có thông tin địa chỉ". Việc "dạy" địa chỉ qua Brain Lab không bền vì
 * matchResponseOverride chỉ khớp câu gần-y-hệt (câu địa chỉ suy intent = "unknown"
 * nên nhánh khớp theo intent không bắn). Giải pháp: đưa địa chỉ thành FACT CỐ ĐỊNH
 * trong context → mọi version não (nháp + live) đều thấy, không cần dạy.
 *
 * THUẦN (pure): không đụng DB / AI → test được mà không cần API key.
 */

// Địa chỉ chính thức (chốt theo chủ studio). Nguồn sự thật cho câu trả lời địa chỉ.
export const STUDIO_ADDRESS = "Số 80, Hẻm 71, Đường Cách Mạng Tháng 8, Hiệp Ninh, TP. Tây Ninh";

/** Bỏ dấu tiếng Việt + thường hoá để so khớp bền (khách gõ có/không dấu đều bắt được). */
function normVi(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
}

// Khớp theo RANH GIỚI TỪ để "o dau" KHÔNG dính "có đâu"/"vào đâu" (co dau / vao dau).
const LOCATION_RE = /\bdia chi\b|\bdia diem\b|\bo dau\b|\bchi duong\b|\btoa do\b|\bgoogle map\b/;

/**
 * Khách đang hỏi ĐỊA CHỈ / VỊ TRÍ studio? (địa chỉ tiệm ở đâu, em ở đâu, shop ở đâu,
 * studio ở đâu, cho xin địa chỉ, chỉ đường…). Dùng cho test + có thể dùng làm guard sau này.
 */
export function isStudioLocationQuestion(text: string): boolean {
  const t = normVi(text);
  return t ? LOCATION_RE.test(t) : false;
}

/**
 * Khối FACT địa chỉ + luật trả lời TRỰC TIẾP, để chèn vào sale-context (mọi version đều thấy).
 * Mặc định dùng STUDIO_ADDRESS; có thể truyền địa chỉ khác (vd lấy từ Settings) nếu cần.
 */
export function buildStudioContactBlock(address: string = STUDIO_ADDRESS): string {
  const addr = (address ?? "").trim() || STUDIO_ADDRESS;
  return `ĐỊA CHỈ & LIÊN HỆ STUDIO (THÔNG TIN CỐ ĐỊNH — LUÔN ĐÚNG, KHÔNG được nói "chưa có thông tin"):
- Địa chỉ tiệm: ${addr}
- Khi khách hỏi địa chỉ / "ở đâu" / "studio/tiệm/shop ở đâu" / "tiệm mình ở đâu" / "cho anh/xin địa chỉ" / "em ở đâu" / "chỉ đường" → em TRẢ LỜI TRỰC TIẾP địa chỉ trên ngay.
- TUYỆT ĐỐI KHÔNG nói "em chưa có thông tin địa chỉ", KHÔNG hỏi lại khách cần chụp dịch vụ gì, KHÔNG chuyển người thật chỉ vì khách hỏi địa chỉ.`;
}
