import { normalizeVi } from "./sale-text-normalize";

/**
 * ĐỊNH NGHĨA 7 BƯỚC SALE + TÌNH HUỐNG + slug nhóm — TÁCH RIÊNG, THUẦN (không DB)
 * để test/template/sync dùng chung mà không kéo @workspace/db.
 * sale-scenario-tree.ts re-export từ đây (giữ nguyên mọi import cũ).
 */

/** Slug ổn định từ tên nhóm giá → dùng làm serviceKey/nodeKey (không lộ id số). */
export function slugifyGroup(name: string): string {
  return normalizeVi(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "nhom";
}

export type StepTpl = { key: string; title: string; showPricing?: boolean; situations: Array<{ key: string; title: string }> };
const S = (key: string, title: string) => ({ key, title });

export const SERVICE_STEPS: StepTpl[] = [
  { key: "tim-hieu", title: "1. Tìm hiểu nhu cầu", situations: [
    S("chua-ro-nhu-cau", "Chưa rõ nhu cầu"), S("chup-dip-gi", "Chụp dịp gì"), S("so-nguoi-doi-tuong", "Số người / đối tượng"),
  ]},
  { key: "tu-van", title: "2. Tư vấn & Concept", situations: [
    S("xem-anh-mau", "Xem ảnh mẫu"), S("chua-biet-gu", "Chưa biết gu"), S("phong-cach-han", "Phong cách Hàn"),
    S("tu-nhien", "Tự nhiên"), S("sang-trong", "Sang trọng"), S("lo-khong-an-anh", "Lo không ăn ảnh"),
    S("chon-dia-diem", "Chọn địa điểm"), S("trang-phuc", "Trang phục"), S("makeup", "Makeup"),
  ]},
  { key: "bao-gia", title: "3. Báo giá", showPricing: true, situations: [
    S("hoi-gia", "Hỏi giá"), S("goi-gom-gi", "Gói gồm gì"), S("so-sanh-goi", "So sánh gói"), S("hoi-uu-dai", "Hỏi ưu đãi"),
  ]},
  { key: "xu-ly-phan-van", title: "4. Xử lý phân vân", situations: [
    S("gia-cao", "Giá cao"), S("xin-giam", "Xin giảm"), S("ben-khac-re-hon", "Bên khác rẻ hơn"),
    S("hoi-chong-gia-dinh", "Cần hỏi chồng / gia đình"), S("can-suy-nghi", "Cần suy nghĩ"),
    S("chua-du-ngan-sach", "Chưa đủ ngân sách"), S("lo-chup-khong-dep", "Lo chụp không đẹp"), S("muon-xem-them", "Muốn xem thêm"),
  ]},
  { key: "chot", title: "5. Chốt sale", situations: [
    S("chon-goi", "Chọn gói"), S("kiem-tra-lich", "Kiểm tra lịch"), S("giu-lich", "Giữ lịch"),
    S("coc", "Cọc"), S("thong-tin-lien-he", "Thông tin liên hệ"), S("chuyen-nhan-vien", "Chuyển nhân viên"),
  ]},
  { key: "khong-chot", title: "6. Không chốt", situations: [
    S("tu-choi", "Từ chối"), S("hen-lai", "Hẹn lại"), S("follow-up", "Follow-up"),
  ]},
  { key: "sau-chot", title: "7. Sau chốt / chuyển người", situations: [
    S("xac-nhan-lich", "Xác nhận lịch"), S("nhac-chuan-bi", "Nhắc chuẩn bị"), S("chuyen-nguoi-that", "Chuyển người thật"),
  ]},
];
export const SITUATIONS_PER_SERVICE = SERVICE_STEPS.reduce((n, s) => n + s.situations.length, 0);

export const GREETING_SITUATIONS: Array<{ key: string; title: string }> = [
  S("chao-hoi", "Chào hỏi"), S("chua-ro-dich-vu", "Chưa rõ khách cần gì"), S("hoi-studio-co-gi", "Hỏi studio có dịch vụ gì"),
  S("gap-nguoi-that", "Muốn gặp người thật"), S("khieu-nai", "Khiếu nại"),
];

/** node_key gốc của Chào hỏi chung (global, dùng chung toàn studio). */
export const GREETING_ROOT_KEY = "global-chao-hoi";

// Regex phát hiện SỐ TIỀN CỨNG trong câu mẫu (thuần — dùng cho cả FE/BE/test).
export const MONEY_IN_TEXT_RE = /(\d{1,3}([.,]\d{3}){1,3}\s*(đ|d|vnd|k|tr|triệu)|\d+\s*(triệu|tr\b)|\d{2,4}\s*k\b)/i;
export function scriptHasHardcodedPrice(text: string): boolean {
  return MONEY_IN_TEXT_RE.test(text ?? "");
}
