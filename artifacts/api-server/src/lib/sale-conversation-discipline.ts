/**
 * KỶ LUẬT HỘI THOẠI cho Lulu Sale — chống "trôi" (conversation drift).
 *
 * Vấn đề: khi đã biết khách đang quan tâm dịch vụ nào (vd chụp cổng cưới), Lulu đôi khi
 * RESET hội thoại và hỏi lại câu chung chung ("anh cần chụp dịch vụ gì, chụp cưới, gia đình…")
 * hoặc tự nhảy sang dịch vụ khác. Module này:
 *   1. SUY RA "nhu cầu đang khóa" (knownIntent) từ lịch sử hội thoại (thuần keyword, không AI).
 *   2. Sinh 1 KHỐI LUẬT cố định, ưu tiên cao để chèn vào system prompt (claude-sale.ts):
 *      đã biết thì không hỏi lại, không reset, không đổi nhóm, mỗi lượt tiến 1 bước.
 *   3. detectServiceDrift(): phát hiện câu trả lời bị "trôi" (dùng cho test + có thể log).
 *
 * THUẦN (pure): KHÔNG đụng DB / AI / Facebook → test được mà không cần API key.
 * Chèn khối luật ở phần RÀNG BUỘC cố định (không version-hóa) nên áp dụng cho MỌI version
 * não Lulu Brain Lab — không phụ thuộc admin có re-tune brain hay không.
 */

/** Một lượt hội thoại (tương thích cấu trúc ClaudeHistoryItem). */
export type ConversationTurn = { direction: "incoming" | "outgoing"; message: string };

/** Nhóm nhu cầu Lulu có thể "khóa" để không trôi sang dịch vụ khác. */
export type KnownIntent =
  | "wedding_gate" // chụp cổng / cổng cưới
  | "wedding" // cưới chung: album / ngoại cảnh / tiệc cưới
  | "beauty" // beauty / cá nhân / nàng thơ / cool boy
  | "rental" // cho thuê trang phục (váy cưới / áo dài / vest)
  | "maternity" // chụp bầu
  | "family"; // chụp gia đình

/** Bỏ dấu tiếng Việt + lowercase để so khớp keyword bền vững (khách gõ có/không dấu đều bắt được). */
function normalizeVi(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
}

// Các nhóm dịch vụ TOP-LEVEL (để xác định "mơ hồ" = khách/menu nhắc ≥2 nhóm khác nhau).
// rental đặt TRƯỚC: "thuê váy cưới" là THUÊ ĐỒ, không phải chụp cưới.
type TopGroup = "rental" | "maternity" | "family" | "beauty" | "wedding";

// LƯU Ý keyword: so khớp theo RANH GIỚI TỪ (hasKeyword) chứ không phải substring, nên tránh được
// va chạm kiểu "cá nhân"(ca nhan) lọt vào "cả nhà"(ca nha). Vẫn KHÔNG để các token quá ngắn dễ
// trùng nghĩa khác: bỏ "co dau"/"chu re" trần (trùng "có đâu"/"chứ rẻ") — chỉ giữ "co dau chu re";
// bỏ "cong hoa" (trùng tên đường "Cộng Hòa"); "chup cong" có guard riêng cho "chụp công ty".
const INTENT_SIGNALS: Array<{ group: TopGroup; keywords: string[] }> = [
  { group: "rental", keywords: ["thue vay", "thue ao dai", "thue vest", "thue suit", "thue do", "thue trang phuc", "cho thue", "thue ao cuoi"] },
  { group: "maternity", keywords: ["chup bau", "anh bau", "me bau", "bung bau", "mang thai", "maternity"] },
  { group: "family", keywords: ["gia dinh", "ca nha", "family", "ba the he", "ba me con"] },
  { group: "beauty", keywords: ["beauty", "cool boy", "nang tho", "chup ca nhan", "chup chan dung", "profile ca nhan"] },
  { group: "wedding", keywords: ["chup cuoi", "anh cuoi", "album cuoi", "ngoai canh", "co dau chu re", "tiec cuoi", "phong su cuoi", "wedding", "chup cong", "cong cuoi", "pre wedding", "prewedding"] },
];

const WEDDING_GATE_KEYWORDS = ["chup cong", "cong cuoi"];

/**
 * So khớp keyword theo RANH GIỚI TỪ (\b), không phải substring — text đã normalizeVi (chữ thường,
 * không dấu) nên \b chạy đúng. Nhờ vậy "ca nhan" KHÔNG khớp keyword "ca nha", "team"/"test" không
 * khớp "te"… (chống dương tính giả khi bỏ dấu).
 */
function hasKeyword(normalizedText: string, keyword: string): boolean {
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`).test(normalizedText);
}

/**
 * Suy ra nhu cầu khách ĐANG quan tâm từ hội thoại. Lấy theo tin KHÁCH (incoming) — khách là
 * nguồn xác định nhu cầu, không lấy tin bot (tránh menu chào hỏi của bot làm khóa sai).
 * Quét tin MỚI NHẤT → cũ; bỏ qua tin "mơ hồ" (nhắc ≥2 nhóm dịch vụ khác nhau, vd menu so sánh).
 * Trả null nếu chưa rõ nhu cầu.
 */
export function inferKnownIntent(history: ConversationTurn[], currentMessage?: string): KnownIntent | null {
  const texts: string[] = [];
  if (currentMessage && currentMessage.trim()) texts.push(currentMessage);
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t?.direction === "incoming" && t.message && !t.message.startsWith("[image:")) texts.push(t.message);
  }

  for (const raw of texts) {
    const text = normalizeVi(raw);
    // "chụp công ty" (corporate) KHÔNG phải "chụp cổng" → vô hiệu hóa keyword "chup cong" lượt này.
    const isCorporate = hasKeyword(text, "cong ty");
    const matchKw = (k: string) => (k === "chup cong" && isCorporate ? false : hasKeyword(text, k));

    const groups = new Set<TopGroup>();
    for (const sig of INTENT_SIGNALS) {
      if (sig.keywords.some(matchKw)) groups.add(sig.group);
    }
    if (groups.size !== 1) continue; // 0 = không có tín hiệu; ≥2 = mơ hồ (menu/so sánh) → xét tin cũ hơn
    const only = [...groups][0];
    if (only === "wedding") {
      return WEDDING_GATE_KEYWORDS.some(matchKw) ? "wedding_gate" : "wedding";
    }
    return only;
  }
  return null;
}

// Nhãn nhu cầu + danh sách dịch vụ KHÁC cần tránh nhắc/đổi sang khi đã khóa nhu cầu này.
const INTENT_LOCK: Record<KnownIntent, { label: string; avoid: string }> = {
  wedding_gate: { label: "chụp cổng cưới (nhóm cưới)", avoid: "gia đình, beauty/cá nhân, chụp bầu, sản phẩm, ảnh doanh nhân, thuê đồ" },
  wedding: { label: "chụp cưới (cổng cưới / album / ngoại cảnh / tiệc cưới)", avoid: "gia đình, beauty/cá nhân, chụp bầu, sản phẩm, ảnh doanh nhân, thuê đồ" },
  beauty: { label: "beauty / chụp cá nhân / nàng thơ / cool boy", avoid: "cưới, gia đình, chụp bầu, thuê đồ, sản phẩm" },
  rental: { label: "cho thuê trang phục (váy cưới / áo dài / vest)", avoid: "concept chụp cưới, beauty, gia đình, chụp bầu" },
  maternity: { label: "chụp bầu (maternity)", avoid: "cưới, beauty, gia đình, thuê đồ, sản phẩm" },
  family: { label: "chụp gia đình", avoid: "cưới, beauty, chụp bầu, thuê đồ, sản phẩm" },
};

/**
 * Khối luật KỶ LUẬT HỘI THOẠI để chèn vào system prompt (ưu tiên cao, đặt ở phần RÀNG BUỘC cố định).
 * knownIntent != null → thêm 1 dòng KHÓA NHU CẦU theo đúng nhóm đang nói.
 */
export function buildAntiDriftRule(knownIntent: KnownIntent | null): string {
  const base = `KỶ LUẬT HỘI THOẠI (BẮT BUỘC — ưu tiên cao, không được phá kể cả khi luật/quy trình ở trên nói khác):
- ĐÃ BIẾT thì KHÔNG hỏi lại. Trước khi hỏi câu mới em PHẢI dựa vào những gì ĐÃ BIẾT trong hội thoại: dịch vụ/nhu cầu, kiểu chụp, concept/tone, NGÀY chụp, địa điểm, gói/ngân sách, số người, giới tính/vai cô dâu-chú rể, khách đã muốn xem mẫu chưa, khách đã hỏi giá chưa. Cái nào đã rõ thì TUYỆT ĐỐI KHÔNG hỏi lại (vd đã có ngày chụp thì đừng hỏi ngày nữa, chuyển sang gói/giữ lịch/cọc).
- KHÔNG RESET hội thoại. Khi đã rõ khách cần chụp gì thì TUYỆT ĐỐI KHÔNG hỏi lại kiểu "anh cần chụp dịch vụ gì", "anh đang muốn chụp loại nào", "chụp cưới hay gia đình"… và KHÔNG quay về bước chào hỏi/hỏi nhu cầu từ đầu.
- KHÔNG TỰ ĐỔI dịch vụ: chỉ tư vấn đúng dịch vụ khách đang quan tâm; KHÔNG tự chuyển sang dịch vụ khác (gia đình, beauty, bầu, sản phẩm, thuê đồ…) trừ khi CHÍNH KHÁCH chủ động hỏi.
- KHÔNG "đổ menu" dịch vụ trừ khi: (a) khách hoàn toàn mới & CHƯA rõ nhu cầu, (b) khách hỏi "studio có dịch vụ gì", hoặc (c) khách xin bảng giá tổng. Khi đã rõ nhu cầu, chỉ đưa lựa chọn TRONG nhóm đó.
- KHÁCH HỎI GIÁ ("bao nhiêu", "giá sao", "gói nào", "3tr9", "premium"…) khi đã rõ dịch vụ → trả lời giá ĐÚNG nhóm hiện tại; KHÔNG hỏi lại dịch vụ; KHÔNG báo giá dịch vụ khác. Nếu khách nhắc tên gói thì giải thích gói đó trước. Thiếu thông tin thì chỉ hỏi 1 ý còn thiếu (vd gu/tone), KHÔNG bung menu.
- KHÁCH HỎI TONE/PHONG CÁCH ("nhẹ nhàng trông ntn", "sang là sao", "cổ điển hơn", "Hàn Quốc", "tối giản"…) → giải thích/gửi concept ĐÚNG dịch vụ hiện tại; KHÔNG hỏi lại dịch vụ; KHÔNG đổi nhóm; rồi hỏi gu khách thích hoặc mời xem giá.
- SAU KHI GỬI ẢNH CONCEPT/MẪU: TUYỆT ĐỐI KHÔNG hỏi lại dịch vụ. Bước kế tiếp chỉ được là: giải thích concept vừa gửi / hỏi khách thích mẫu nào / gợi ý gói phù hợp / báo giá / hỏi ngày chụp / mời giữ lịch cọc.
- MỖI LƯỢT CHỈ HỎI 1 CÂU CHÍNH (ưu tiên: ngày chụp → gu/concept → gói/ngân sách → địa điểm → cọc/giữ lịch). KẾT mỗi lượt bằng 1 bước TIẾN tới chọn concept / báo giá / chốt ngày / đặt cọc — KHÔNG đứng yên, KHÔNG lùi về hỏi "anh cần chụp gì".`;

  if (!knownIntent) return base;
  const lock = INTENT_LOCK[knownIntent];
  return `${base}
- KHÓA NHU CẦU HIỆN TẠI: khách ĐANG quan tâm ${lock.label}. Hãy bám đúng nhóm này. TUYỆT ĐỐI KHÔNG hỏi lại khách cần chụp dịch vụ gì, KHÔNG gợi ý/đổi sang ${lock.avoid} trừ khi chính khách chủ động hỏi.`;
}

// Cụm từ "reset / hỏi lại dịch vụ" — KHÔNG được xuất hiện khi đã biết nhu cầu (đã bỏ dấu).
const RESET_PHRASES = [
  "can chup dich vu gi",
  "can chup gi",
  "muon chup dich vu gi",
  "muon chup gi",
  "muon chup loai nao",
  "chup loai nao",
  "chup cuoi hay gia dinh",
  "chup cuoi, gia dinh",
  "chup cuoi gia dinh",
];

// Từ khóa dịch vụ KHÁC — nếu xuất hiện khi đã khóa nhu cầu = trôi nhóm (heuristic, đã bỏ dấu).
const OFF_INTENT_WORDS: Record<KnownIntent, string[]> = {
  wedding_gate: ["beauty", "gia dinh", "bau", "san pham", "doanh nhan"],
  wedding: ["beauty", "gia dinh", "bau", "san pham", "doanh nhan"],
  beauty: ["chup cuoi", "co dau", "chu re", "gia dinh", "bau", "thue vay"],
  rental: ["beauty", "gia dinh", "bau", "chup cuoi", "san pham"],
  maternity: ["beauty", "chup cuoi", "gia dinh", "thue vay", "san pham"],
  family: ["beauty", "chup cuoi", "bau", "thue vay", "san pham"],
};

/**
 * Phát hiện câu trả lời bị "trôi" khỏi nhu cầu đang khóa. Trả về danh sách vi phạm:
 *   "reset:<cụm>"      = hỏi lại dịch vụ / reset hội thoại.
 *   "offintent:<từ>"   = nhắc dịch vụ khác trong khi đã khóa nhu cầu (knownIntent != null).
 * [] = không trôi. Heuristic dùng cho TEST + có thể log cảnh báo; KHÔNG dùng để chặn câu trả lời thật.
 */
export function detectServiceDrift(reply: string, knownIntent: KnownIntent | null): string[] {
  const t = normalizeVi(reply);
  const hits: string[] = [];
  for (const p of RESET_PHRASES) if (t.includes(p)) hits.push(`reset:${p}`);
  if (knownIntent) {
    for (const w of OFF_INTENT_WORDS[knownIntent]) if (t.includes(w)) hits.push(`offintent:${w}`);
  }
  return [...new Set(hits)];
}
