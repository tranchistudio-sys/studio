// Lưu/khôi phục vị trí cuộn của danh sách "Cho thuê đồ" (/cho-thue-do) khi khách
// bấm vào một sản phẩm rồi Back trở lại. Thuần frontend, chỉ đọc/ghi sessionStorage —
// KHÔNG đụng dữ liệu thuê đồ, API, hay logic category/filter/search/sort.

const KEY = "amazing:rental:list-scroll-state";
// Chỉ khôi phục nếu trạng thái còn mới (khách vừa xem trong ~30 phút). Quá cũ coi như
// một phiên duyệt khác → không restore để tránh nhảy vị trí sai ngữ cảnh.
const MAX_AGE_MS = 30 * 60 * 1000;

export interface RentalListScrollState {
  /** pathname + search đầy đủ của danh sách lúc bấm sản phẩm (đúng category/sort/q). */
  listUrl: string;
  /** window.scrollY lúc bấm — fallback khi không tìm thấy đúng card. */
  scrollY: number;
  /** id sản phẩm vừa bấm — để scrollIntoView đúng card. */
  productId: number;
  timestamp: number;
}

/** Gọi ngay trước khi điều hướng sang trang chi tiết sản phẩm. */
export function saveRentalListScroll(productId: number): void {
  try {
    const state: RentalListScrollState = {
      listUrl: window.location.pathname + window.location.search,
      scrollY: window.scrollY,
      productId,
      timestamp: Date.now(),
    };
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // sessionStorage không khả dụng (chế độ riêng tư / hết quota) → bỏ qua, chỉ mất tính năng khôi phục.
  }
}

/** Đọc trạng thái đã lưu; trả null nếu không có / hỏng / quá cũ. */
export function readRentalListScroll(): RentalListScrollState | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<RentalListScrollState> | null;
    if (
      !s ||
      typeof s.listUrl !== "string" ||
      typeof s.scrollY !== "number" ||
      typeof s.productId !== "number" ||
      typeof s.timestamp !== "number"
    ) {
      return null;
    }
    if (Date.now() - s.timestamp > MAX_AGE_MS) return null;
    return s as RentalListScrollState;
  } catch {
    return null;
  }
}

/** Xoá sau khi đã dùng (one-shot) để lần vào trang trực tiếp sau này vẫn lên đầu trang. */
export function clearRentalListScroll(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
