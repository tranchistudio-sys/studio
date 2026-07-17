/**
 * customer-rename.ts — quyết định patch khách hàng khi form booking lưu mà liên kết
 * khách đã bị gỡ (resolveCustomerForSave của calendar.tsx).
 *
 * BUG production DH0267 (17/07): admin sửa TÊN khách trong form sửa booking →
 * ô tên tự gỡ liên kết (customerId=null) → lúc lưu code tìm lại khách theo SĐT,
 * ra ĐÚNG khách cũ nhưng bỏ qua tên vừa gõ → tên cũ hiện lại khắp nơi (lịch,
 * chi tiết, search) kể cả sau refresh, vì tên khách chỉ có MỘT nguồn sự thật là
 * customers.name mà nguồn đó không hề được ghi.
 *
 * PHÂN BIỆT 2 Ý ĐỊNH (qua matchedName — tên khớp lúc mở form/chọn khách):
 * - GÕ SỬA TÊN: ô tên tự gỡ liên kết nhưng matchedName vẫn giữ TÊN GỐC (khác rỗng)
 *   → là ý định ĐỔI TÊN khách gốc.
 * - Bấm nút "Xoá liên kết" chủ động: matchedName bị xóa RỖNG → là ý định THAY
 *   KHÁCH KHÁC cho booking — TUYỆT ĐỐI không rename khách gốc (đổi tên ở đây sẽ
 *   phá hồ sơ + mọi booking cũ của người ta một cách lặng lẽ).
 *
 * Quy tắc (tách thuần để unit test không cần render):
 * - refindCustomerPatch: ĐANG SỬA booking + khách tìm lại theo SĐT chính là khách
 *   GỐC + matchedName còn tên gốc → patch.name = tên vừa gõ. Không sinh khách
 *   trùng, không đổi customerId — cả gia đình cha/con dùng chung khách nên lịch/
 *   chi tiết/hợp đồng chưa ký/search tự ra tên mới. Avatar chỉ bổ sung khi khách
 *   chưa có (giữ hành vi cũ). Refind ra khách KHÁC / tạo mới → không đổi tên ai.
 * - noPhoneSavePlan: form KHÔNG có SĐT hợp lệ khi lưu. Nếu là ý định đổi tên
 *   (đang sửa + có khách gốc + matchedName còn tên gốc) → rename tại chỗ (kèm
 *   avatar/facebook/zalo vừa nhập như nhánh còn-liên-kết); ngược lại (tạo mới,
 *   hoặc đã bấm Xoá liên kết) → tạo khách mới như hành vi cũ.
 */
export type RefindPatchInput = {
  /** Form đang SỬA booking có sẵn (isEdit) hay tạo mới. */
  isEdit: boolean;
  /** customerId GỐC của booking đang sửa (null nếu tạo mới/booking chưa gắn khách). */
  originalCustomerId: number | null;
  /** Khách tìm lại được theo SĐT. */
  existing: { id: number; name: string | null; avatar: string | null };
  /** Tên khớp lúc mở form/chọn khách — nút "Xoá liên kết" chủ động xóa rỗng. */
  matchedName: string;
  /** Tên đang có trong ô nhập lúc bấm lưu. */
  typedName: string;
  /** Avatar đang chọn trong form (nếu có). */
  avatar: string | null;
};

export function refindCustomerPatch(input: RefindPatchInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const typed = input.typedName.trim();
  const renameIntent =
    input.isEdit &&
    input.originalCustomerId != null &&
    input.originalCustomerId === input.existing.id &&
    input.matchedName.trim() !== "" &&
    typed.length > 0 &&
    typed !== (input.existing.name ?? "").trim();
  if (renameIntent) patch.name = typed;
  if (input.avatar && !input.existing.avatar) patch.avatar = input.avatar;
  return patch;
}

export type NoPhoneSaveInput = {
  isEdit: boolean;
  originalCustomerId: number | null;
  /** Tên khớp lúc mở form/chọn khách — nút "Xoá liên kết" chủ động xóa rỗng. */
  matchedName: string;
  typedName: string;
  avatar: string | null;
  facebook: string | null;
  zalo: string | null;
};

export type NoPhoneSavePlan =
  | { mode: "rename-in-place"; customerId: number; patch: Record<string, unknown> | null }
  | { mode: "create-new" };

export function noPhoneSavePlan(i: NoPhoneSaveInput): NoPhoneSavePlan {
  const typed = i.typedName.trim();
  const renameIntent =
    i.isEdit &&
    i.originalCustomerId != null &&
    typed.length > 0 &&
    i.matchedName.trim() !== ""; // rỗng = đã bấm Xoá liên kết → THAY khách, không rename
  if (!renameIntent) return { mode: "create-new" };
  const patch: Record<string, unknown> = {};
  if (typed !== i.matchedName.trim()) patch.name = typed;
  if (i.avatar) patch.avatar = i.avatar;
  if (i.facebook) patch.facebook = i.facebook;
  if (i.zalo) patch.zalo = i.zalo;
  return {
    mode: "rename-in-place",
    customerId: i.originalCustomerId as number,
    patch: Object.keys(patch).length > 0 ? patch : null,
  };
}
