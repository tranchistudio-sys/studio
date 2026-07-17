/**
 * customer-rename.ts — quyết định patch khách hàng khi form booking TÌM LẠI khách
 * theo SĐT (nhánh refind trong resolveCustomerForSave của calendar.tsx).
 *
 * BUG production DH0267 (17/07): admin sửa TÊN khách trong form sửa booking →
 * ô tên tự gỡ liên kết (customerId=null) → lúc lưu code tìm lại khách theo SĐT,
 * ra ĐÚNG khách cũ nhưng bỏ qua tên vừa gõ → tên cũ hiện lại khắp nơi (lịch,
 * chi tiết, search) kể cả sau refresh, vì tên khách chỉ có MỘT nguồn sự thật là
 * customers.name mà nguồn đó không hề được ghi.
 *
 * Quy tắc (tách thuần để unit test không cần render):
 * - ĐANG SỬA booking và khách tìm lại chính là khách GỐC của booking đó
 *   → người dùng đang ĐỔI TÊN khách: patch.name = tên vừa gõ.
 *   (Không sinh khách trùng, không đổi customerId — cả gia đình cha/con dùng
 *   chung khách nên lịch/chi tiết/hợp đồng chưa ký/search tự ra tên mới.)
 * - TẠO MỚI (hoặc refind ra khách KHÁC — ví dụ đổi cả SĐT sang khách khác):
 *   KHÔNG tự đổi tên khách đó — tên mình gõ có thể chỉ là cách viết khác của
 *   người dùng chung SĐT; đổi tên ở đây sẽ phá hồ sơ khách khác một cách lặng lẽ.
 * - Avatar: chỉ bổ sung khi khách chưa có (giữ hành vi cũ).
 */
export type RefindPatchInput = {
  /** Form đang SỬA booking có sẵn (isEdit) hay tạo mới. */
  isEdit: boolean;
  /** customerId GỐC của booking đang sửa (null nếu tạo mới/booking chưa gắn khách). */
  originalCustomerId: number | null;
  /** Khách tìm lại được theo SĐT. */
  existing: { id: number; name: string | null; avatar: string | null };
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
    typed.length > 0 &&
    typed !== (input.existing.name ?? "").trim();
  if (renameIntent) patch.name = typed;
  if (input.avatar && !input.existing.avatar) patch.avatar = input.avatar;
  return patch;
}
